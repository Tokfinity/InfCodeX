/**
 * `KodaXManagedTask` payload construction — FEATURE_171 v0.7.41 split
 * extracted verbatim from `task-engine/runner-driven.ts` (Shard 6a). No
 * behavior change.
 *
 * Public surface:
 *   - `buildManagedTaskPayload(args)` — produces the full
 *     `KodaXManagedTask` payload from the recorder + role-sequence + run
 *     metadata. Fields are populated to the minimum necessary for
 *     round-boundary reshape, REPL consumers, and the subset of test
 *     assertions mapped in Shard 6a's inventory.
 *
 * Re-exported by `runner-driven.ts` so callers continue to reach
 * `buildManagedTaskPayload` from the original import path.
 */

import path from 'node:path';

import type {
  KodaXHarnessProfile,
  KodaXManagedTask,
  KodaXOptions,
  KodaXResult,
  KodaXTaskContract,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoleAssignment,
  KodaXTaskRoutingDecision,
  KodaXToolExecutionContext,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import type { ManagedTaskBudgetController } from './budget.js';
import type { VerdictRecorder } from './types.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './workspace.js';
import {
  buildManagedTaskArtifactRecords,
  mergeEvidenceArtifacts,
} from './artifacts.js';
import {
  createVerificationScorecard,
  type ScorecardVerdictDirective,
} from './scorecard.js';
import { buildCompletionContractStatus } from './role-prompts.js';

/**
 * Map the harness tier to the assignment-id convention legacy consumers
 * expect. H0 uses 'direct', H1/H2 use the role name.
 */
function harnessToBudget(harness: KodaXHarnessProfile): number {
  // Legacy per-harness global work budget constants (approximate; tests
  // only assert aggregate totals, not exact ceilings).
  if (harness === 'H0_DIRECT') return 50;
  if (harness === 'H1_EXECUTE_EVAL') return 400;
  return 600;
}

/**
 * Build the full `KodaXManagedTask` payload from the recorder, role
 * sequence, and run metadata. Fields are populated to the minimum
 * necessary for round-boundary reshape + REPL consumers + the subset of
 * test assertions mapped in Shard 6a's inventory.
 */
export function buildManagedTaskPayload(args: {
  readonly prompt: string;
  readonly options: KodaXOptions;
  readonly recorder: VerdictRecorder;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly baseCtx: KodaXToolExecutionContext;
  readonly signal: KodaXResult['signal'];
  readonly verdictStatus?: 'accept' | 'revise' | 'blocked';
  readonly userAnswer?: string;
  readonly budget?: ManagedTaskBudgetController;
  readonly plan?: ReasoningPlan;
  readonly entries?: readonly KodaXTaskEvidenceEntry[];
  readonly degradedContinue?: boolean;
  /**
   * Stable taskId for the run. Callers that need deterministic snapshot
   * paths (runManagedTaskViaRunnerInner, checkpoint writer, skill-artifact
   * persistence) must pass the same id for every invocation in a run; if
   * omitted a fresh id is generated (back-compat for legacy callers).
   */
  readonly taskId?: string;
  /**
   * v0.7.26 C4 parity — extra evidence artefact records (e.g. skill
   * artifacts) that the caller has already persisted to disk and wants
   * merged into `evidence.artifacts` alongside the built-in snapshot set.
   */
  readonly extraArtifacts?: readonly KodaXTaskEvidenceArtifact[];
  /**
   * F4 parity (v0.7.26) — pre-floor routing decision (before
   * `applyCurrentDiffReviewRoutingFloor` runs). Populates
   * `runtime.rawRoutingDecision`.
   */
  readonly rawRoutingDecision?: KodaXTaskRoutingDecision;
  /**
   * F4 parity — human-readable explanation when the routing floor or
   * Scout overrides the initial decision. Populates
   * `runtime.routingOverrideReason`.
   */
  readonly routingOverrideReason?: string;
  /**
   * F4 parity — tool-output truncation ledger captured from the
   * tool-result-truncation guardrail's `afterTool` hook. Populates
   * `runtime.toolOutputTruncated` + `runtime.toolOutputTruncationNotes`.
   */
  readonly toolOutputTruncated?: boolean;
  readonly toolOutputTruncationNotes?: readonly string[];
}): KodaXManagedTask {
  const {
    prompt,
    options,
    recorder,
    rolesEmitted,
    baseCtx,
    signal,
    verdictStatus,
    userAnswer,
    budget,
    plan,
    entries,
    degradedContinue,
    taskId: providedTaskId,
    extraArtifacts,
    rawRoutingDecision,
    routingOverrideReason,
    toolOutputTruncated,
    toolOutputTruncationNotes,
  } = args;

  // FEATURE_193 (v0.7.43): V1 `recorder.scout?.payload.scout?.confirmedHarness`
  // override removed (V1 scout slot deleted). Harness now sourced from the
  // routing plan directly, fallback to H0_DIRECT for plan-less test paths.
  // `recorder.contract?.payload.contract` was the V1 H2 contract slot —
  // also deleted; contract summary/criteria/evidence/constraints sourced
  // directly from `options.context?.taskVerification`.
  const harness: KodaXHarnessProfile =
    plan?.decision.harnessProfile ?? 'H0_DIRECT';

  const nowIso = new Date().toISOString();
  // v0.7.26 C4 parity — honour the caller-supplied taskId so every
  // `buildManagedTaskPayload` call within a single run reuses the same
  // workspaceDir. Prior behaviour generated a fresh id on every invocation,
  // so every observer snapshot wrote to a different folder and skill
  // artifacts could not be referenced by a stable path.
  const taskId = providedTaskId ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const surface = getManagedTaskSurface(options);
  // Resolve the per-task workspace directory (e.g. `<cwd>/.agent/
  // managed-tasks/<taskId>/`) so downstream snapshot files and
  // `evidence.artifacts` point at a stable, writable location — matches
  // legacy `task-engine.ts:2106` and is required for checkpoint/resume
  // parity.
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);

  const contractStatus =
    signal === 'BLOCKED' ? 'blocked' : verdictStatus === 'accept' ? 'completed' : 'running';

  // Shard 6d-L: honour the reasoning plan's routing decision when filling
  // `contract.*`. Legacy (`task-engine.ts:2160-2180`) populated every
  // contract field from `plan.decision`; the earlier Runner-driven payload
  // hard-coded `primaryTask:'conversation'` / `complexity:simple` /
  // `riskLevel:'low'` and broke every downstream branch that read these
  // values (agent.ts has ~10 `decision.primaryTask === 'review' | 'bugfix'
  // | ...` branches). When the plan is absent we still fall back to the
  // placeholders — keeps callers without a plan (test harness, direct
  // API use) working.
  const decision = plan?.decision;
  const contract: KodaXTaskContract = {
    taskId,
    surface,
    objective: prompt,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: contractStatus,
    primaryTask: decision?.primaryTask ?? 'conversation',
    workIntent: decision?.workIntent ?? 'new',
    complexity:
      decision?.complexity
        ?? (harness === 'H0_DIRECT' ? 'simple' : harness === 'H1_EXECUTE_EVAL' ? 'moderate' : 'complex'),
    riskLevel: decision?.riskLevel ?? 'low',
    harnessProfile: harness,
    recommendedMode: decision?.recommendedMode ?? 'conversation',
    requiresBrainstorm: decision?.requiresBrainstorm ?? false,
    reason: decision?.reason ?? 'Runner-driven AMA path',
    contractSummary: undefined,
    successCriteria: [],
    requiredEvidence: [],
    constraints: [],
    verification: options.context?.taskVerification,
  };

  // De-dup roles while preserving first-occurrence order. The assignment
  // list is a historical record of who participated, not a schedule.
  const roleOrder: KodaXTaskRole[] = [];
  for (const r of rolesEmitted) {
    if (!roleOrder.includes(r)) roleOrder.push(r);
  }
  // H0_DIRECT convention: use 'direct' as the role when Scout answers
  // without handoff. The legacy path emits a single 'direct' assignment.
  const assignmentRoles: KodaXTaskRole[] =
    harness === 'H0_DIRECT' && roleOrder.length <= 1 ? ['direct'] : roleOrder;
  const roleAssignments: KodaXTaskRoleAssignment[] = assignmentRoles.map((role) => ({
    id: role,
    role,
    title: role.charAt(0).toUpperCase() + role.slice(1),
    dependsOn: [],
    status: contractStatus,
  }));

  // FEATURE_193 (v0.7.43): `'generator'` fallback replaced with `'worker'`
  // — V1 Generator role retired (chain.generator agent deleted in commit
  // `dcac55ea`). On V2 the only execution agent that produces a managedTask
  // payload without a Sidecar Verifier verdictStatus is the Worker. H0_DIRECT
  // remains for the SA-fast-path pseudo-role.
  const decidedByAssignmentId =
    harness === 'H0_DIRECT' ? 'direct' : verdictStatus ? 'evaluator' : 'worker';
  // FEATURE_159 follow-up (v0.7.40): fallback to '' instead of `prompt`.
  // The legacy `?? prompt` fallback was a copy from SA fast-path days when
  // the Scout always provided a `userAnswer`, so `?? prompt` was a never-
  // reached safety net. Under V2 chain (FEATURE_114) Worker runs first and
  // a Worker round can legitimately end without `emit_verdict` (e.g. the
  // chain hands off to Generator on the next iteration, or the Sidecar
  // Verifier has not yet written to recorder.verdict). In that case
  // `userAnswer` and `verdict.reason` are both undefined, and
  // `?? prompt` populated `verdict.summary` with the user's raw query
  // verbatim.
  //
  // Downstream this surfaced as an end-user UX bug: when the Worker round
  // produced no plain-text assistant turn (e.g. only tool_use + thinking,
  // or only emit_handoff), `resolveCompletedAssistantText` (REPL
  // message-utils.ts) iterates candidates and skips empty ones — falling
  // through to `managedTask.verdict.summary` as the third candidate. With
  // the legacy fallback that candidate held the user's own query, so the
  // REPL rendered a prefix-less `Assistant: <Q verbatim>` item (the user
  // sees their own question echoed back as the assistant's reply).
  //
  // Empty-string fallback is safe for all consumers we verified:
  //   - REPL `resolveCompletedAssistantText`: empty candidate is skipped
  //     (sanitize-and-pick-first-truthy loop).
  //   - `runner-driven.ts` transcript dump: `if (task.verdict?.summary)`
  //     gate already filters falsy, the "Last verdict" block silently
  //     drops.
  //   - `scorecard.ts`: `directive?.reason ?? task.verdict.summary` —
  //     audit artefact, empty string is acceptable when no verdict ran.
  //   - `json-guards.ts`: only checks `typeof === 'string'`.
  const verdictSummary =
    userAnswer ?? recorder.verdict?.payload.verdict?.reason ?? '';

  const task: KodaXManagedTask = {
    contract,
    roleAssignments,
    workItems: [],
    evidence: {
      workspaceDir,
      // Every managed task advertises a fixed set of 10 snapshot files
      // the writeManagedTaskArtifacts
      // pass is expected to produce. Downstream consumers (`resumeManagedTask`,
      // harness observers, the REPL transcript dump) index evidence by
      // artifact path, so we surface the records here even when the actual
      // files are written asynchronously at terminal exit.
      //
      // v0.7.26 C4 parity — merge any caller-supplied artefact records
      // (e.g. skill-execution.md / skill-map.md persisted by
      // `writeManagedSkillArtifacts`) alongside the built-in snapshot set
      // so the REPL + resume flow can resolve them by path.
      artifacts: mergeEvidenceArtifacts(
        buildManagedTaskArtifactRecords(workspaceDir),
        extraArtifacts,
      ),
      // Shard 6d-R: surface the per-role turn ledger and routing notes.
      // Legacy `task-engine.ts` fed these fields from each role completion
      // + `plan.decision.routingNotes`. Without them, snapshot consumers
      // (`buildManagedTaskRoundHistory`, REPL transcript dump, resume)
      // see empty history + no routing context.
      entries: entries ? [...entries] : [],
      routingNotes: plan?.decision.routingNotes ? [...plan.decision.routingNotes] : [],
    },
    verdict: {
      // FEATURE_184 (v0.7.45) Phase C.1: verdict.status is owned by the
      // Evaluator / Sidecar Verifier verdict slot (verdictStatus). A
      // Generator-level blocked handoff surfaces via result.signal only,
      // leaving verdict.status='running' (no verifier ran). We intentionally
      // do NOT map signal='BLOCKED' → status='blocked' here because that
      // would conflate Generator-blocked (no verifier) with Evaluator/Sidecar-
      // blocked (verifier ran and said 'blocked').
      status:
        verdictStatus === 'blocked'
          ? 'blocked'
          : verdictStatus === 'accept'
            ? 'completed'
            : 'running',
      decidedByAssignmentId,
      summary: verdictSummary,
      signal,
    },
    runtime: {
      globalWorkBudget: budget?.totalBudget ?? harnessToBudget(harness),
      budgetUsage: budget?.spentBudget ?? rolesEmitted.length,
      // FEATURE_193 (v0.7.43): legacy V1 semantics — Scout would emit a
      // `confirmedHarness` upgrading from H0_DIRECT to H1/H2 and the Runner
      // synthesised a `harnessTransitions` record from that. With Scout
      // retired (chain.scout deleted, `emit_scout_verdict` deleted), there
      // is no transition source on V2; the Worker single-loop runs at the
      // routing-decided tier from turn 0. Always emit an empty array. The
      // field stays on `KodaXManagedTaskRuntimeState` for pre-1.0 SDK
      // consumer compat (see `@deprecated` markers in `types.ts`).
      harnessTransitions: [],
      // AMA-controller telemetry (amaProfile/amaTactics/amaControllerReason)
      // retired in ADR-043 — the advisory was write-only-unread after the
      // overlay was removed, so the runtime fields were dropped too.
      routingAttempts: plan?.decision.routingAttempts,
      routingSource: plan?.decision.routingSource,
      currentHarness: harness,
      upgradeCeiling: plan?.decision.upgradeCeiling ?? harness,
      qualityAssuranceMode: deriveQualityAssuranceMode(plan),
      // FEATURE_193 (v0.7.43) deep V1 cleanup: `scoutDecision` + `skillMap`
      // runtime fields physically removed from `KodaXManagedTaskRuntimeState`
      // (Scout role retired, no V2 source). The runtime literal omits them
      // entirely; downstream consumers read `ctx.skillInvocation` / the
      // routing-overlay system-prompt section (FEATURE_143) for skill context.
      // Shard 6d-U: propagate the degraded-continue signal. `true` when the
      // Evaluator requested an upgrade beyond `plan.decision.upgradeCeiling`
      // (rewritten back to Generator) or when budget-extension approval was
      // denied / skipped during revise. `undefined` when no degradation.
      degradedContinue: degradedContinue || undefined,
      // Shard 6d-S: derive per-criterion / per-runtime-check completion
      // status from the final verdict. Absent when no verification
      // contract was declared.
      completionContractStatus: buildCompletionContractStatus(
        options.context?.taskVerification,
        verdictStatus,
      ),
      // F4 parity (v0.7.26) — surface routing provenance + tool
      // truncation state. `rawRoutingDecision` is the pre-floor snapshot
      // (before `applyCurrentDiffReviewRoutingFloor`); `finalRoutingDecision`
      // mirrors the active plan.decision; `routingOverrideReason` carries
      // any human-readable override explanation. Truncation tracking
      // lets downstream review UIs highlight when tool output was
      // clipped.
      rawRoutingDecision,
      finalRoutingDecision: plan?.decision,
      routingOverrideReason,
      toolOutputTruncated: toolOutputTruncated || undefined,
      toolOutputTruncationNotes:
        toolOutputTruncationNotes && toolOutputTruncationNotes.length > 0
          ? [...toolOutputTruncationNotes]
          : undefined,
    },
  };

  // H2 parity (v0.7.26) — populate the verification scorecard after the
  // task shape is built, mirroring legacy `createVerificationScorecard`.
  // Without this, `task.runtime.scorecard` stayed undefined and
  // `scorecard.json` persisted as `null`, starving downstream consumers
  // (review-scale UI, session-storage replay, rubric-family branches).
  const verdictPayload = recorder.verdict?.payload.verdict;
  const scorecardDirective: ScorecardVerdictDirective | undefined = verdictPayload
    ? { status: verdictPayload.status, reason: verdictPayload.reason }
    : undefined;
  const scorecard = createVerificationScorecard(task, scorecardDirective);
  return scorecard && task.runtime
    ? { ...task, runtime: { ...task.runtime, scorecard } }
    : task;
}

/**
 * Shard 6d-O: quality-assurance mode mirrors legacy
 * `resolveManagedTaskQualityAssuranceMode` (task-engine.ts:1108).
 * Runner simplification — legacy's branch depended on
 * `plan.decision.mutationSurface` / `assuranceIntent` /
 * `needsIndependentQA` / `riskLevel` / etc.; we reproduce the key
 * decisions:
 *   - H1 / H2 → 'required' (evaluator-mandatory).
 *   - H0 with explicit verification obligations or plan flags → 'required'.
 *   - Otherwise → 'optional'.
 */
function deriveQualityAssuranceMode(
  plan: ReasoningPlan | undefined,
): 'required' | 'optional' {
  // (Removed) the leading `harness !== 'H0_DIRECT' -> required` clause: with
  // decision.harnessProfile collapsed to a constant 'H0_DIRECT' it was always
  // false. The UI 'required'/'optional' label is now driven entirely by the
  // semantic decision fields below.
  const decision = plan?.decision;
  if (!decision) return 'optional';
  if (decision.assuranceIntent === 'explicit-check') return 'required';
  if (decision.needsIndependentQA === true) return 'required';
  if (decision.riskLevel === 'high') return 'required';
  if (decision.primaryTask === 'qa' || decision.primaryTask === 'plan') return 'required';
  if (decision.recommendedMode === 'pr-review' || decision.recommendedMode === 'strict-audit') return 'required';
  return 'optional';
}

// FEATURE_193 (v0.7.43): `buildScoutDecisionRuntime` + `buildSkillMapRuntime`
// helpers deleted — they read from the removed V1 `recorder.scout.payload.scout`
// slot, and both call sites now emit `undefined` directly.
