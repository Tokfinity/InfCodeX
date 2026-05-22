/**
 * Observer bridge — funnels per-role lifecycle events from the runner-
 * driven AMA loop into the user-facing `KodaXEvents.onManagedTaskStatus`
 * surface.
 *
 * Hosts:
 *   - `BUDGET_CAP_BY_HARNESS` + `BUDGET_EXTENSION_BY_HARNESS` —
 *     per-harness budget caps + extension increments (consumed by
 *     `wrapEmitterWithRecorder` in `verdict-recorder.ts`)
 *   - `ROLE_TO_TITLE` + `MAX_ROUNDS_BY_HARNESS` — display labels +
 *     role-chain length hints used by the status emit body
 *   - `RUNNER_HARNESS_ORDER` + `getRunnerHarnessRank` +
 *     `applyScoutDecisionToPlanRunner` — M4 parity helpers consumed by
 *     the emit-wrapper to fold Scout's confirmed harness back into the
 *     plan ref
 *   - `buildEvidenceEntryForRoleEmit` — per-role evidence record
 *   - `buildRunnerRoutingNote` — preflight routing label
 *   - `buildObserverBridge` — the actual bridge factory
 *   - `NULL_OBSERVER` — observer-shaped no-op used by test paths and as
 *     the agent-chain builder's default
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~872–1355 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXManagedTaskPhase,
  KodaXResult,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskStatus,
} from '../../../types.js';
import {
  buildAmaControllerDecision,
  buildPromptOverlay,
} from '../../../reasoning.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import { isHarnessV2Enabled } from '../../../agents/worker-role-prompt.js';
import {
  buildManagedStatusBudgetFields,
  type ManagedTaskBudgetController,
} from './budget.js';
import type { ObserverBridge, VerdictRecorder } from './types.js';

/**
 * Base budget cap per harness tier, in LLM-turn units. Scout/Planner/
 * Generator/Evaluator each consume one unit per emit; coding tools consume
 * one unit per invocation (via `incrementManagedBudgetUsage`).
 *
 * H0 default bumped from the legacy 50 → 100 because even a modest review
 * task easily burns 30 file reads + 15 grep scans + a few bash inspections
 * before Scout can commit a verdict. H1/H2 stay at 200 (the
 * `DEFAULT_MANAGED_WORK_BUDGET` baseline) — those tiers get the budget-extension
 * dialog at 90% utilization so a long task can top up as needed rather
 * than front-load a huge base cap.
 */
export const BUDGET_CAP_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 100,
  H1_EXECUTE_EVAL: 200,
  H2_PLAN_EXECUTE_EVAL: 200,
  // FEATURE_114 v0.7.36: PLANNED inherits H2's cap — same upper
  // bound for total tool-call budget, regardless of whether the
  // chain is split across roles or condensed into one Worker.
  PLANNED: 200,
};

/**
 * Extension size per harness tier. When the budget-extension dialog fires
 * at the 90% threshold and the user approves, the budget grows by this
 * many units. H0 gets a smaller +100 bump (short exploration tasks) while
 * H1/H2 get +200 (long multi-role runs).
 */
export const BUDGET_EXTENSION_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 100,
  H1_EXECUTE_EVAL: 200,
  H2_PLAN_EXECUTE_EVAL: 200,
  PLANNED: 200,
};

/**
 * Display-name mapping for each role. The REPL UI renders this as the
 * status-line label (e.g. "[Scout] Thinking..."). Keys are lowercase role
 * ids; values are the capitalised titles the legacy path used.
 */
const ROLE_TO_TITLE: Record<KodaXTaskRole, string> = {
  scout: 'Scout',
  planner: 'Planner',
  generator: 'Generator',
  evaluator: 'Evaluator',
  direct: 'Direct',
  // FEATURE_114 v0.7.36 — AMA Harness V2 single-loop role.
  worker: 'Worker',
};

/**
 * Max-rounds hint for progress reporting. The Runner.run inner loop caps
 * per-agent tool iterations at `MAX_TOOL_LOOP_ITERATIONS` (20); `maxRounds`
 * here reflects the *role-chain* length upper bound per harness tier.
 * Consumers use it purely for "round i of N" display — the actual cap is
 * enforced by the LLM loop + budget controller, not by this number.
 */
export const MAX_ROUNDS_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 1, // Scout direct answer
  H1_EXECUTE_EVAL: 6, // Scout + Gen + Eval (+ up to 3 revise cycles)
  H2_PLAN_EXECUTE_EVAL: 8, // Scout + Planner + Gen + Eval (+ up to 4 revise cycles)
  // FEATURE_114 v0.7.36: PLANNED is one Worker chain + Evaluator with
  // up to ~4 revise cycles, matching H2's overall envelope.
  PLANNED: 8,
};

/**
 * Shard 6d-R: derive a per-role evidence entry at emit time. Legacy
 * `task-engine.ts` kept an append-only `evidence.entries[]` list so
 * downstream consumers (`buildManagedTaskRoundHistory`, resume flow,
 * REPL transcript dump) could reconstruct per-round role history.
 *
 * Status mapping:
 *   - scout / planner / direct → 'completed' (always terminal for their turn)
 *   - generator → derived from handoff.status (ready→completed,
 *                 incomplete→running, blocked→blocked)
 *   - evaluator → derived from verdict.status (accept→completed,
 *                 revise→running, blocked→blocked)
 *
 * Signal + reason are only populated on the final-emitter roles
 * (evaluator/direct) because those are the only turns that carry a
 * user-observable `COMPLETE | BLOCKED | DECIDE` signal.
 */
function buildEvidenceEntryForRoleEmit(args: {
  readonly role: KodaXTaskRole;
  readonly round: number;
  readonly recorder: VerdictRecorder;
  readonly sessionId: string | undefined;
}): KodaXTaskEvidenceEntry {
  const { role, round, recorder, sessionId } = args;
  let status: KodaXTaskStatus = 'completed';
  let summary: string | undefined;
  let signal: KodaXTaskEvidenceEntry['signal'];
  let signalReason: string | undefined;
  if (role === 'scout') {
    summary = recorder.scout?.payload.scout?.summary;
  } else if (role === 'planner') {
    summary = recorder.contract?.payload.contract?.summary;
  } else if (role === 'generator') {
    const handoff = recorder.handoff?.payload.handoff;
    summary = handoff?.summary;
    if (handoff?.status === 'blocked') status = 'blocked';
    else if (handoff?.status === 'incomplete') status = 'running';
  } else if (role === 'evaluator') {
    const verdict = recorder.verdict?.payload.verdict;
    summary = verdict?.reason;
    if (verdict?.status === 'blocked') {
      status = 'blocked';
      signal = 'BLOCKED';
      signalReason = verdict.reason;
    } else if (verdict?.status === 'revise') {
      status = 'running';
    } else if (verdict?.status === 'accept') {
      signal = 'COMPLETE';
      signalReason = verdict.reason;
    }
  } else if (role === 'direct') {
    // H0_DIRECT: Scout answered directly — treat as a completed direct turn.
    summary = recorder.scout?.payload.scout?.summary;
    signal = 'COMPLETE';
  }
  return {
    assignmentId: role,
    role,
    status,
    title: ROLE_TO_TITLE[role],
    round,
    summary,
    sessionId,
    signal,
    signalReason,
  };
}

/**
 * Emit `KodaXManagedTaskStatusEvent` with the full field set legacy
 * consumers (REPL UI, CLI JSON events, observability) depend on.
 *
 * Fields populated:
 *   - agentMode / harnessProfile — static for the run (harness updated on
 *     Scout emit)
 *   - phase / activeWorkerId / activeWorkerTitle — the canonical trio
 *   - currentRound / maxRounds — progress indicator
 *   - upgradeCeiling — same as harness (Runner path does not observe
 *     mid-run ceiling changes beyond Scout commitment)
 *   - globalWorkBudget / budgetUsage / budgetApprovalRequired — via
 *     `buildManagedStatusBudgetFields`
 *   - note / detailNote — short status label + optional long-form detail
 *     (detailNote comes from the recorder's most-recent payload summary
 *     when available)
 *   - persistToHistory — `true` for terminal events (completed / blocked)
 *     and `false` for transient progress ticks (REPL ledger contract)
 *   - events[] — inline live-event list, currently one entry per observer
 *     tick so the REPL ticker has something to render
 */
/**
 * M4 parity (v0.7.26) — 1:1 port of legacy
 * `task-engine.ts::applyScoutDecisionToPlan` (line 564). Updates the plan
 * in place once Scout emits its `confirmedHarness` so downstream role
 * prompts / tool-policy / budget controller see the post-Scout decision
 * instead of the stale pre-Scout snapshot. Without this, a plan=H2 but
 * Scout=H1 run leaks H2-only prompt guidance into the H1 workers.
 *
 * Critical nuance: Scout overriding the topology ceiling (its own
 * confirmed harness > `topologyCeiling`) is honoured without clamping —
 * Scout has strictly more information than the pre-Scout regex heuristic
 * (FEATURE_061). `upgradeCeiling` is lifted to match so the budget
 * controller + mid-run escalation see a consistent state.
 */
const RUNNER_HARNESS_ORDER: readonly KodaXHarnessProfile[] = [
  'H0_DIRECT',
  'H1_EXECUTE_EVAL',
  'H2_PLAN_EXECUTE_EVAL',
];
function getRunnerHarnessRank(harness: KodaXHarnessProfile): number {
  return RUNNER_HARNESS_ORDER.indexOf(harness);
}

export function applyScoutDecisionToPlanRunner(
  plan: ReasoningPlan,
  scoutPayload:
    | {
        confirmedHarness?: KodaXHarnessProfile;
        harnessRationale?: string;
        summary?: string;
      }
    | undefined,
): ReasoningPlan {
  const confirmedHarness = scoutPayload?.confirmedHarness;
  if (!confirmedHarness) {
    return plan;
  }
  const topologyCeiling = plan.decision.topologyCeiling ?? plan.decision.upgradeCeiling;
  const scoutOverrodeCeiling = topologyCeiling
    ? getRunnerHarnessRank(confirmedHarness) > getRunnerHarnessRank(topologyCeiling)
    : false;
  const ceilingNote = scoutOverrodeCeiling
    ? `Scout overrode topology ceiling ${topologyCeiling} → ${confirmedHarness}: ${scoutPayload.harnessRationale ?? 'task complexity requires escalation'}.`
    : undefined;
  if (
    confirmedHarness === plan.decision.harnessProfile
    && !scoutPayload.summary
    && !ceilingNote
  ) {
    return plan;
  }
  const decision: KodaXTaskRoutingDecision = {
    ...plan.decision,
    harnessProfile: confirmedHarness,
    upgradeCeiling: scoutOverrodeCeiling
      ? confirmedHarness
      : plan.decision.upgradeCeiling,
    reason: scoutPayload.summary
      ? `${plan.decision.reason} Scout confirmed ${confirmedHarness}: ${scoutPayload.summary}`
      : plan.decision.reason,
    routingNotes: [
      ...(plan.decision.routingNotes ?? []),
      ...(scoutPayload.summary ? [`Scout decision: ${scoutPayload.summary}`] : []),
      ...(ceilingNote ? [ceilingNote] : []),
    ],
  };
  const amaControllerDecision = buildAmaControllerDecision(decision);
  return {
    ...plan,
    decision,
    amaControllerDecision,
    promptOverlay: buildPromptOverlay(
      decision,
      plan.providerPolicy?.routingNotes,
      plan.providerPolicy,
      amaControllerDecision,
    ),
  };
}

/**
 * H3 routing-note builder. Emitted once before Scout's preflight so the
 * REPL work-strip can label the task's routing context (review target,
 * review scale, routing override reason). The
 * Runner-driven path doesn't have `repoRoutingSignals` in plan (those
 * were computed by the legacy planner earlier); we fall back to the
 * decision fields plan surfaces directly.
 */
export function buildRunnerRoutingNote(plan: ReasoningPlan): string {
  const detailParts: string[] = [];
  const decision = plan.decision;
  const reviewScale = decision.reviewScale ? ` (${decision.reviewScale})` : '';
  if (decision.reviewTarget) {
    detailParts.push(`${decision.reviewTarget}${reviewScale}`);
  }
  if (decision.routingSource && decision.routingSource !== 'model') {
    detailParts.push(`routing=${decision.routingSource}`);
  }
  if (decision.routingAttempts && decision.routingAttempts > 1) {
    detailParts.push(`attempts=${decision.routingAttempts}`);
  }
  return detailParts.length > 0
    ? `AMA routing · ${detailParts.join(' · ')}`
    : 'AMA routing';
}

export function buildObserverBridge(
  events: KodaXEvents | undefined,
  harnessRef: { current: KodaXHarnessProfile },
  rolesRef: { emitted: KodaXTaskRole[] },
  budget: ManagedTaskBudgetController,
  roundRef: { current: number },
  maxRoundsRef: { current: number },
  budgetApprovalRef: { current: boolean },
  entriesRef: { items: KodaXTaskEvidenceEntry[] },
  sessionIdRef: { current: string | undefined },
  checkpointWriter?: (role: KodaXTaskRole) => void,
): ObserverBridge {
  const emit = (partial: {
    phase: KodaXManagedTaskPhase;
    activeWorkerId?: string;
    activeWorkerTitle?: string;
    note?: string;
    detailNote?: string;
    persistToHistory?: boolean;
  }): void => {
    if (!events?.onManagedTaskStatus) return;
    const harness = harnessRef.current;
    events.onManagedTaskStatus({
      agentMode: 'ama',
      harnessProfile: harness,
      currentRound: roundRef.current,
      maxRounds: maxRoundsRef.current,
      upgradeCeiling: harness,
      ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      ...partial,
    });
  };
  return {
    preflight: () => {
      // FEATURE_114 v0.7.38 Slice 7 — when V2 is the entry path
      // (chain.worker, see ~line 5212), the preflight title MUST mirror
      // that. Otherwise `activeWorkerTitle: 'Scout'` persists into every
      // Worker tool call (REPL reads `managedTaskStatusRef.current
      // .activeWorkerTitle` as the per-tool prefix), so users see
      // `[Scout] read/bash/grep` for a path that's actually running
      // Worker — exactly the symptom that surfaced after the V2
      // default flip. V1 path keeps the literal Scout label.
      const v2Active = isHarnessV2Enabled();
      emit({
        phase: 'preflight',
        activeWorkerId: v2Active ? 'worker' : 'scout',
        activeWorkerTitle: v2Active ? ROLE_TO_TITLE.worker : ROLE_TO_TITLE.scout,
        note: v2Active
          ? 'Worker analyzing task'
          : 'Scout analyzing task complexity',
        persistToHistory: false,
      });
    },
    onRoleEmit: (role, recorder) => {
      // Once Scout has confirmed a harness tier, keep it as the reference.
      const scoutHarness = recorder.scout?.payload.scout?.confirmedHarness;
      if (scoutHarness) {
        harnessRef.current = scoutHarness;
        maxRoundsRef.current = Math.max(
          maxRoundsRef.current,
          MAX_ROUNDS_BY_HARNESS[scoutHarness],
        );
      }
      rolesRef.emitted.push(role);
      roundRef.current += 1;
      const detail =
        role === 'scout'
          ? recorder.scout?.payload.scout?.summary
          : role === 'planner'
            ? recorder.contract?.payload.contract?.summary
            : role === 'generator'
              ? recorder.handoff?.payload.handoff?.summary
              : recorder.verdict?.payload.verdict?.reason;
      // Shard 6d-R: accumulate `evidence.entries[]` per-turn. Mirrors legacy
      // `task-engine.ts` behaviour where each role completion appended a
      // `KodaXTaskEvidenceEntry` to the managed task's evidence bundle so
      // downstream consumers (`buildManagedTaskRoundHistory`, the REPL's
      // transcript dump, resume flow) could reconstruct per-round history.
      entriesRef.items.push(
        buildEvidenceEntryForRoleEmit({
          role,
          round: roundRef.current,
          recorder,
          sessionId: sessionIdRef.current,
        }),
      );
      emit({
        // Emit `worker` (not `round`) so the REPL's
        // `isForegroundManagedStreamingStatus` recognizes this as an
        // active worker turn and routes onProviderRecovery / onRetry into
        // the managed foreground layer (legacy task-engine.ts:~3752 also
        // emits `phase: 'worker'` per role activation). Without this,
        // `managedForegroundOwnerRef.current.workerId` is never set and
        // recovery / retry messages render below the user prompt instead
        // of inline with the worker output.
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: ROLE_TO_TITLE[role],
        note: `${ROLE_TO_TITLE[role]} completed a turn`,
        detailNote: detail,
        persistToHistory: false,
      });
      if (checkpointWriter) checkpointWriter(role);
    },
    completed: (signal: KodaXResult['signal'], reason?: string) =>
      emit({
        phase: 'completed',
        note: signal === 'BLOCKED' ? 'Task blocked' : 'Task completed',
        detailNote: reason,
        persistToHistory: true,
      }),
    notifyBudgetApprovalRequest: () => {
      budgetApprovalRef.current = true;
      emit({
        phase: 'round',
        note: 'Awaiting budget extension approval',
        persistToHistory: false,
      });
    },
    notifyChildFanout: (fanoutClass, count) => {
      if (!events?.onManagedTaskStatus) return;
      // v0.7.26 parity (C2): do NOT set activeWorkerId:'child' here.
      // FEATURE_067 already learned (types.ts:1170) that an activeWorkerId
      // transition to 'child' triggers a foreground worker switch in the
      // REPL, which clears all live tool calls for the actual worker that
      // dispatched the children. Keep the active worker unchanged; use
      // `childFanoutClass` + `childFanoutCount` purely as decoration.
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        childFanoutClass: fanoutClass,
        childFanoutCount: count ?? 1,
        note: `Dispatching ${fanoutClass} child task`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    idleWaiting: (role, pendingCount) => {
      if (!events?.onManagedTaskStatus) return;
      // FEATURE_156 — keep the activeWorker identity on whoever just
      // parked (today always Worker, but the wiring is agent-agnostic to
      // avoid hardcoding the V2-only invariant — see Step 0 of
      // FEATURE_120 docs for the future migration that could open this
      // path to additional roles). `idleWaiting=true` distinguishes the
      // alive-suspended sub-state from active execution; consumers
      // branch on that flag, not on a new phase value.
      //
      // `phase` is generic 'worker' (the existing "an agent is doing
      // work" phase used by every per-role emit at line ~1527, NOT the
      // V2-specific Worker role) — keeps the same fallback display
      // path other phases use. The role identity carries through
      // `activeWorkerId` / `activeWorkerTitle`, so any future role
      // arriving at this branch surfaces with the correct label
      // without a phase-enum change.
      const resolvedTitle = role ? ROLE_TO_TITLE[role] : undefined;
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: resolvedTitle,
        idleWaiting: true,
        idleWaitingPendingCount: pendingCount,
        note:
          pendingCount > 0
            ? `${resolvedTitle ?? 'Agent'} idle — waiting for ${pendingCount} child task${pendingCount === 1 ? '' : 's'}`
            : `${resolvedTitle ?? 'Agent'} idle — resuming`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    agentSwitched: (role) => {
      // FEATURE_166 (v0.7.41 follow-up) — emit a lightweight status
      // event so the REPL flips `activeWorkerTitle` ahead of the new
      // agent's first streaming output.
      //
      // Pure UI label flip. Compared to `onRoleEmit`:
      //   - NO recorder mutation (slot stays driven by the
      //     authoritative emit_* tool path)
      //   - NO budget-extension dialog (no slot-success boundary
      //     crossed here)
      //   - NO checkpoint write (handoff_taken invariant + lineage
      //     entries handled by the agent runtime's handoff path)
      //   - NO evidence entry (those are slot-emission anchored)
      //   - `persistToHistory: false` mirrors `idleWaiting` — this
      //     is transient REPL state, not a lineage milestone
      //
      // When `role` is undefined (unmapped agent name), skip rather
      // than overwrite the existing label with a fallback — the
      // ObserverBridge contract says the consumer leaves the label
      // untouched in that case.
      if (!events?.onManagedTaskStatus) return;
      if (!role) return;
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: ROLE_TO_TITLE[role],
        note: `${ROLE_TO_TITLE[role]} taking over`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    sidecarStarted: () => {
      // FEATURE_184 Phase D.3 — emit `phase: 'verifying'` so the REPL
      // spinner shows `[AMA Verifying]` while the sidecar verifier LLM
      // call is in flight (typically 3-10s on inherit-main provider).
      // Without this, the spinner would keep the prior Worker label
      // for the full window with no signal that the agent has stopped
      // and a verification call is running.
      if (!events?.onManagedTaskStatus) return;
      emit({
        phase: 'verifying',
        note: 'Verifying agent output',
        persistToHistory: false,
      });
    },
    sidecarFinished: (info) => {
      // Opt-in verifier observability — gated upstream by
      // `KODAX_VERIFIER_LOG=1`. Persists a one-line summary into the
      // session jsonl so users can confirm post-hoc that the sidecar
      // fired AND see which (provider, model) ran the verification.
      //
      // Phase: 'worker' (back to in-chain phase after the verifying
      // spinner) — avoids adding a new union value just for the log
      // line. The note format is the user-facing identifier.
      if (!events?.onManagedTaskStatus) return;
      const sourceTag = info.source === 'explicit-env' ? 'env' : 'inherit';
      const modelLabel = info.model ?? '(default)';
      emit({
        phase: 'worker',
        note: `[Sidecar Verifier] ${info.verdict} · ${info.providerName}/${modelLabel} (${sourceTag}) · ${info.elapsedMs}ms · ${info.trace}`,
        persistToHistory: true,
      });
    },
  };
}

/**
 * No-op observer used by test paths and the agent-chain builder's
 * default parameter. All eight methods are silent — no events, no side
 * effects.
 */
export const NULL_OBSERVER: ObserverBridge = {
  preflight: () => undefined,
  onRoleEmit: () => undefined,
  completed: () => undefined,
  notifyBudgetApprovalRequest: () => undefined,
  notifyChildFanout: () => undefined,
  idleWaiting: () => undefined,
  agentSwitched: () => undefined,
  sidecarStarted: () => undefined,
  sidecarFinished: () => undefined,
};
