/**
 * Pre-run checkpoint flow + structural resume seed + per-role checkpoint
 * writer — FEATURE_171 v0.7.41 split extracted verbatim from
 * `task-engine/runner-driven.ts` (Shard 6c + H1 structural resume).
 * No behavior change.
 *
 * Public surface:
 *   - `handlePreRunCheckpoint(options)` — pre-run dialog driving the
 *     resume / restart / cancel decision. Returns `{ resumeFrom }` when
 *     the caller should seed the recorder; `undefined` otherwise.
 *   - `buildResumePreamble(checkpoint)` — reconstruct a human-readable
 *     preamble from a validated checkpoint so the resumed run sees prior
 *     Scout findings, contract, and last verdict in plain text.
 *   - `buildStructuralResumeSeed(validated)` — H1 structural resume seed
 *     (recorder slots + harness + roles emitted + entry agent).
 *   - `writeCurrentCheckpoint(args)` — crash-safe per-role checkpoint
 *     writer; best-effort, returns the workspaceDir or `undefined`.
 *
 * Re-exported by `runner-driven.ts` so callers continue to reach these
 * helpers from the original import path.
 */

import path from 'node:path';

import type {
  KodaXHarnessProfile,
  KodaXManagedProtocolPayload,
  KodaXManagedTask,
  KodaXOptions,
  KodaXTaskRole,
} from '../../../types.js';
import {
  resolveHandoffTarget,
  type ProtocolEmitterMetadata,
} from '../../../agents/protocol-emitters.js';
import type {
  ManagedTaskCheckpoint,
  ValidatedCheckpoint,
} from './checkpoint.js';
import {
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  writeCheckpoint,
} from './checkpoint.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './workspace.js';

/**
 * Shard 6c + H1 structural resume (v0.7.26).
 *
 * Legacy behaviour (task-engine.ts:~6644 + `resumeManagedTask`): ask the
 * user whether to continue or restart, then either replay the partial
 * state (seeded plan, scoutDecision, budget) or drop the checkpoint.
 *
 *   - "restart" → delete stale checkpoint, start fresh.
 *   - "resume" → keep the checkpoint, return `{ resumeFrom }` so the
 *     caller can seed the recorder via `buildStructuralResumeSeed` and
 *     (depending on what roles already completed) start Runner.run at
 *     planner / generator / evaluator instead of scout. The textual
 *     preamble (`buildResumePreamble`) is still prepended for readability
 *     and to give any resumed-scout retries the prior findings in plain
 *     text.
 *   - "cancel" → delete the checkpoint + throw — the user asked to abort.
 *   - no askUser callback → silently clean up; non-interactive contexts
 *     can't prompt for a decision.
 */
export async function handlePreRunCheckpoint(
  options: KodaXOptions,
): Promise<{ resumeFrom: ValidatedCheckpoint } | undefined> {
  let validated: ValidatedCheckpoint | undefined;
  try {
    validated = await findValidCheckpoint(options);
  } catch {
    return undefined;
  }
  if (!validated) return undefined;

  const deleteSafely = async (): Promise<void> => {
    try {
      await deleteCheckpoint(validated!.workspaceDir);
    } catch {
      // Delete failure is non-fatal; the next run will see the same
      // stale checkpoint and reach this branch again.
    }
  };

  if (!options.events?.askUser) {
    await deleteSafely();
    return undefined;
  }

  const useChinese = /[一-鿿]/.test(validated.managedTask.contract.objective ?? '');
  const answer = await options.events.askUser({
    question: useChinese ? '发现未完成的任务' : 'Found incomplete task',
    options: [
      {
        // H1 parity (v0.7.26) — text-level resume. The next run's prompt
        // receives a reconstructed preamble (Scout findings, contract,
        // last verdict) so the LLM can pick up where it left off
        // without re-investigating. Full structural replay of the
        // recorder state is deliberately out of scope for this MVP.
        label: useChinese ? '继续未完成的工作' : 'Resume',
        value: 'resume',
        description: useChinese
          ? '在先前 Scout/执行结果的基础上继续（上下文保留）'
          : 'Continue with preserved prior Scout / execution context',
      },
      {
        label: useChinese ? '重新开始' : 'Restart',
        value: 'restart',
        description: useChinese ? '丢弃之前的进度，重新开始' : 'Discard previous progress and start fresh',
      },
      {
        label: useChinese ? '取消' : 'Cancel',
        value: 'cancel',
        description: useChinese ? '中止当前请求' : 'Abort the current request',
      },
    ],
    default: 'resume',
  });
  if (answer === 'cancel') {
    await deleteSafely();
    throw new Error('Runner-driven path: user cancelled due to pre-existing checkpoint');
  }
  if (answer === 'resume') {
    // Keep the checkpoint in place — it gets rewritten fresh on the
    // next role emit. The caller builds a preamble from the validated
    // state and feeds it into the prompt.
    return { resumeFrom: validated };
  }
  await deleteSafely();
  return undefined;
}

/**
 * H1 parity (v0.7.26) — reconstruct a human-readable preamble from the
 * checkpoint's managedTask state. The next run pre-pends this onto the
 * user prompt so Scout / Generator / Evaluator see the prior
 * investigation + findings and can pick up the work instead of
 * rediscovering it. Text-level resume — not a full structural replay
 * of the recorder — but a meaningful quality-of-life improvement over
 * the prior "restart from scratch" behaviour.
 */
export function buildResumePreamble(checkpoint: ValidatedCheckpoint): string {
  const task = checkpoint.managedTask;
  const lines: string[] = [
    '=== RESUMING INCOMPLETE TASK ===',
    `Checkpoint from: ${checkpoint.checkpoint.createdAt}`,
    `Original objective: ${task.contract.objective}`,
    `Harness: ${task.contract.harnessProfile}`,
    `Roles already executed: ${checkpoint.checkpoint.completedWorkerIds.join(', ') || 'none'}`,
  ];
  const scout = task.runtime?.scoutDecision;
  if (scout) {
    lines.push('', '--- Scout findings (already complete) ---');
    if (scout.summary) lines.push(`Summary: ${scout.summary}`);
    if (scout.harnessRationale) lines.push(`Harness rationale: ${scout.harnessRationale}`);
    if (scout.scope && scout.scope.length > 0) {
      lines.push(`Scope: ${scout.scope.join(', ')}`);
    }
    if (scout.reviewFilesOrAreas && scout.reviewFilesOrAreas.length > 0) {
      lines.push(`Review files/areas: ${scout.reviewFilesOrAreas.join(', ')}`);
    }
    if (scout.executionObligations && scout.executionObligations.length > 0) {
      lines.push('Execution obligations:');
      for (const ob of scout.executionObligations) lines.push(`  - ${ob}`);
    }
  }
  const contract = task.contract.contractSummary;
  if (contract) {
    lines.push('', '--- Contract (already produced) ---');
    lines.push(contract);
    if (task.contract.successCriteria.length > 0) {
      lines.push('Success criteria:');
      for (const c of task.contract.successCriteria) lines.push(`  - ${c}`);
    }
  }
  if (task.verdict?.summary) {
    lines.push('', '--- Last verdict ---');
    lines.push(`Status: ${task.verdict.status}`);
    lines.push(`Summary: ${task.verdict.summary}`);
  }
  lines.push(
    '',
    'Use this preserved context to avoid redundant investigation. Continue the work from where it was interrupted.',
    '=== END RESUME CONTEXT ===',
    '',
  );
  return lines.join('\n');
}

/**
 * H1 structural resume seed (v0.7.26) — reconstruct recorder slots, harness
 * tier, budget, and the agent entry-point from a validated checkpoint.
 *
 * Legacy `resumeManagedTask` synthesised a `ManagedTaskScoutDirective`
 * from `managedTask.runtime.scoutDecision`, applied it to the plan, then
 * filtered out `completedWorkerIds` so the resumed round skipped
 * already-completed workers. The Runner-driven path equivalent:
 *
 *   1. If Scout completed, re-emit the captured Scout directive into the
 *      recorder so `rolePromptContextFactory` → `previousRoleSummaries`
 *      + `scoutScope` still reach downstream roles.
 *   2. If the saved harness is H2 and `contract.contractSummary` is set,
 *      also seed the contract slot so the Planner turn can be skipped.
 *   3. Pick the entry agent based on which slots are seeded:
 *        - no scout      → scout (plain restart with preamble context)
 *        - scout + H0    → scout (re-emit H0 with saved findings)
 *        - scout + H1    → generator
 *        - scout + H2, no contract → planner
 *        - scout + H2 + contract  → generator
 *   4. Carry forward the harness tier + budget so budget caps + role-
 *      specific tool allow-lists are correct from turn 1. Budget spent is
 *      reset — the LLM is starting a fresh turn even if logically
 *      resuming, so old spend shouldn't eat into the new run's envelope.
 *
 * Handoff and verdict slots are deliberately NOT seeded: the legacy
 * resume also didn't replay them (it re-ran the terminal round). This
 * keeps the semantics simple — resume picks up at the last *role* that
 * needs to run, not at a specific revise-cycle iteration inside the
 * Evaluator loop.
 */
export interface StructuralResumeSeed {
  readonly recorderSlots: {
    readonly scout?: ProtocolEmitterMetadata;
    readonly contract?: ProtocolEmitterMetadata;
  };
  readonly harness: KodaXHarnessProfile;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly startingRole: 'scout' | 'planner' | 'generator';
}

export function buildStructuralResumeSeed(validated: ValidatedCheckpoint): StructuralResumeSeed {
  const task = validated.managedTask;
  const checkpoint = validated.checkpoint;
  const scoutDecision = task.runtime?.scoutDecision;
  const harness: KodaXHarnessProfile = task.contract.harnessProfile ?? 'H0_DIRECT';

  const recorderSlots: { scout?: ProtocolEmitterMetadata; contract?: ProtocolEmitterMetadata } = {};
  const rolesEmitted: KodaXTaskRole[] = [];

  if (checkpoint.scoutCompleted && scoutDecision) {
    const scoutPayload: Partial<KodaXManagedProtocolPayload> = {
      scout: {
        summary: scoutDecision.summary,
        scope: scoutDecision.scope ?? [],
        requiredEvidence: scoutDecision.requiredEvidence ?? [],
        reviewFilesOrAreas: scoutDecision.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutDecision.evidenceAcquisitionMode,
        confirmedHarness: scoutDecision.recommendedHarness,
        harnessRationale: scoutDecision.harnessRationale,
        blockingEvidence: scoutDecision.blockingEvidence,
        directCompletionReady: scoutDecision.directCompletionReady,
        skillMap: scoutDecision.skillSummary
          ? {
            skillSummary: scoutDecision.skillSummary,
            executionObligations: scoutDecision.executionObligations ?? [],
            verificationObligations: scoutDecision.verificationObligations ?? [],
            ambiguities: scoutDecision.ambiguities ?? [],
            projectionConfidence: scoutDecision.projectionConfidence,
          }
          : undefined,
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('scout', scoutPayload);
    recorderSlots.scout = {
      role: 'scout',
      payload: scoutPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('scout');
  }

  const contractSummary = task.contract.contractSummary;
  if (
    harness === 'H2_PLAN_EXECUTE_EVAL'
    && contractSummary
    && contractSummary.trim().length > 0
  ) {
    const contractPayload: Partial<KodaXManagedProtocolPayload> = {
      contract: {
        summary: contractSummary,
        successCriteria: task.contract.successCriteria ?? [],
        requiredEvidence: task.contract.requiredEvidence ?? [],
        constraints: task.contract.constraints ?? [],
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('planner', contractPayload);
    recorderSlots.contract = {
      role: 'planner',
      payload: contractPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('planner');
  }

  let startingRole: 'scout' | 'planner' | 'generator' = 'scout';
  if (recorderSlots.scout) {
    if (harness === 'H0_DIRECT') {
      startingRole = 'scout';
    } else if (harness === 'H1_EXECUTE_EVAL') {
      startingRole = 'generator';
    } else {
      startingRole = recorderSlots.contract ? 'generator' : 'planner';
    }
  }

  return { recorderSlots, harness, rolesEmitted, startingRole };
}

/**
 * Shard 6c: write a crash-safe checkpoint after each role transition.
 * Allows legacy tools and future resume logic to inspect partial state.
 */
export async function writeCurrentCheckpoint(args: {
  readonly options: KodaXOptions;
  readonly managedTask: KodaXManagedTask;
  readonly currentRound: number;
  readonly completedWorkerIds: readonly string[];
  readonly scoutCompleted: boolean;
}): Promise<string | undefined> {
  const { options, managedTask, currentRound, completedWorkerIds, scoutCompleted } = args;
  try {
    const surface = getManagedTaskSurface(options);
    const workspaceRoot = getManagedTaskWorkspaceRoot(options, surface);
    const workspaceDir = path.join(workspaceRoot, managedTask.contract.taskId);
    const gitCommit = (await getGitHeadCommit(options.context?.gitRoot)) ?? 'unknown';
    const checkpoint: ManagedTaskCheckpoint = {
      version: 1,
      taskId: managedTask.contract.taskId,
      createdAt: managedTask.contract.createdAt,
      gitCommit,
      objective: managedTask.contract.objective,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound,
      completedWorkerIds: [...completedWorkerIds],
      scoutCompleted,
    };
    await writeCheckpoint(workspaceDir, checkpoint);
    return workspaceDir;
  } catch {
    // Checkpoint write is best-effort — failures should not abort the run.
    return undefined;
  }
}
