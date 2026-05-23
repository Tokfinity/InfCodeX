/**
 * Verdict-recorder emit wrapper for the runner-driven AMA path.
 *
 * Hosts:
 *   - `SLOT_TO_ROLE` — slot-id → role mapping (used by both the wrapper
 *     and downstream observability)
 *   - `BudgetExtensionContext` — the per-run plan/harness/round refs
 *     the emit wrapper needs to fire the 90%-threshold budget-extension
 *     dialog and to enforce the H1 same-harness revise cap (consumed by
 *     `wrapEmitterWithRecorder` and `buildRunnerAgentChain` in R3)
 *   - `H1_MAX_SAME_HARNESS_REVISES` + `HARNESS_TIER_ORDER` +
 *     `isUpgradeBeyondCeiling` — Risk-2 / Shard 6d-U policy constants
 *     and the upgrade-ceiling comparator
 *   - `wrapEmitterWithRecorder` — wraps a single protocol-emitter tool
 *     so every successful execution records its `ProtocolEmitterMetadata`
 *     into the recorder, fires the role-emit observer, runs the
 *     H1-cap / V2-routing / Scout-skillMap-todo seeding / Scout pre-handoff
 *     write warning / budget-extension dialog branches, and routes any
 *     V2-active handoffTarget=Generator back to Worker
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~398–870 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type { RunnableTool, RunnerToolResult } from '@kodax-ai/agent';
import {
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  WORKER_AGENT_NAME,
} from '../../../agents/task-engine-agents.js';
import type { ProtocolEmitterMetadata } from '../../../agents/protocol-emitters.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXTaskRole,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import {
  incrementManagedBudgetUsage,
  maybeRequestAdditionalWorkBudget,
  type ManagedTaskBudgetController,
} from './budget.js';
import { BUDGET_EXTENSION_BY_HARNESS } from './observer-bridge.js';
import type { TodoStore } from '../../todo-store.js';
import type { ObserverBridge, VerdictRecorder } from './types.js';

/**
 * Role-mapping for `onManagedTaskStatus` emissions. Each emit tool
 * corresponds to a role that has just finished its turn.
 *
 * FEATURE_184 (v0.7.45): `verdict: 'evaluator'` is a SLOT semantic, not
 * an agent-name reference. The in-chain Evaluator role was retired in C.1+C.2;
 * the Sidecar Verifier (verifier-recorder-bridge.ts) writes `recorder.verdict`
 * directly via `applySidecarVerdictToRecorder` and emits `'evaluator'` here
 * for backward compat (downstream consumers key on this string).
 */
export const SLOT_TO_ROLE: Record<'scout' | 'contract' | 'handoff' | 'verdict', KodaXTaskRole> = {
  scout: 'scout',
  contract: 'planner',
  handoff: 'generator',
  // 'evaluator' is a slot semantic — the Sidecar Verifier now owns this slot.
  verdict: 'evaluator',
};

/**
 * Context needed to fire the 90%-threshold budget-extension dialog on
 * Evaluator revise. Mirrors the legacy payload shape at task-engine.ts:
 * ~6000 (inside the revise branch of executeManagedTaskRound).
 */
export interface BudgetExtensionContext {
  readonly events: KodaXEvents | undefined;
  readonly originalTask: string;
  readonly roundRef: { current: number };
  readonly maxRoundsRef: { current: number };
  readonly budgetApprovalRef: { current: boolean };
  // Shard 6d-U: plan + degraded-continue + harness refs so the verdict
  // emitter wrapper can guard against H1→H2 upgrade attempts that exceed
  // `plan.decision.upgradeCeiling`. When denied, we redirect handoff
  // back to Generator (continue at current harness) and flip
  // `degradedContinueRef.current = true` so the runtime payload surfaces
  // the degraded continue state to REPL / CLI consumers.
  readonly planRef: { current: ReasoningPlan | undefined };
  readonly degradedContinueRef: { current: boolean };
  readonly harnessRef: { current: KodaXHarnessProfile };
  /**
   * v0.7.26 Risk-2 fix — per-harness Evaluator revise counter. Mirrors
   * legacy `h1CheckedDirectRevisesUsed`: H1 allows at most 1 same-harness
   * revise before the wrapper auto-converts a second revise into either
   * an H2 escalation (if `upgradeCeiling >= H2`) or an accept-with-
   * followup (if upgradeCeiling blocks further escalation). Without this
   * cap, the Runner-driven handoff topology allows Evaluator → Generator
   * → Evaluator → ... up to `MAX_ROUNDS_BY_HARNESS[H1] = 6` rounds,
   * which in the Scout-confusion loop the user reported keeps spinning
   * for 3-4 revise cycles before budget exhaustion.
   */
  readonly reviseCountByHarnessRef: {
    current: Map<KodaXHarnessProfile, number>;
  };
}

/**
 * Risk-2 policy constants. H1 allows 1 same-harness revise before the
 * wrapper escalates or converts — matches legacy
 * `h1CheckedDirectRevisesUsed` semantics.
 */
export const H1_MAX_SAME_HARNESS_REVISES = 1;

/**
 * Shard 6d-U: harness ordering from low to high. Used to compare a
 * requested next_harness against `upgradeCeiling`. Mirrors legacy
 * `HARNESS_TIER_ORDER` (task-engine.ts constant used by the routing
 * coordinator).
 */
const HARNESS_TIER_ORDER: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 0,
  H1_EXECUTE_EVAL: 1,
  H2_PLAN_EXECUTE_EVAL: 2,
  // FEATURE_114 v0.7.36: PLANNED sits at the top of the ladder — it
  // is the V2 single-loop profile that the upgrade path can't
  // overshoot from H0/H1/H2 mid-task (V2 is selected at routing
  // time via KODAX_HARNESS_V2, not via runtime escalation).
  PLANNED: 3,
};

function isUpgradeBeyondCeiling(
  requested: KodaXHarnessProfile,
  ceiling: KodaXHarnessProfile,
): boolean {
  return HARNESS_TIER_ORDER[requested] > HARNESS_TIER_ORDER[ceiling];
}

/**
 * Wrap a protocol emitter so every successful execution records its
 * `ProtocolEmitterMetadata` into the per-run recorder AND fires a
 * managed-task status observer event. The wrapped tool otherwise behaves
 * identically to the base tool.
 *
 * FEATURE_193 (v0.7.43): the slot parameter was narrowed to `'verdict'` —
 * scout/contract/handoff slots were retired with the V1 chain. The only
 * remaining production caller path is the Sidecar Verifier bridge; the
 * function itself is also exercised by the `__runnerDrivenTestables`
 * test-only export for the H1 revise-cap and budget-dialog regressions.
 *
 * On Evaluator `revise`, if the cumulative budget usage crosses 90% of the
 * current cap, fire `maybeRequestAdditionalWorkBudget` to ask the user
 * whether to extend. `approved` bumps the budget by
 * `GLOBAL_WORK_BUDGET_INCREMENT`; `denied` / `skipped` leave it unchanged
 * (the Runner keeps running since budget is advisory; the user has been
 * informed). Mirrors legacy task-engine.ts behaviour at ~line 6000.
 */
export function wrapEmitterWithRecorder(
  base: RunnableTool,
  slot: 'verdict',
  recorder: VerdictRecorder,
  observer: ObserverBridge,
  budget?: ManagedTaskBudgetController,
  budgetExtension?: BudgetExtensionContext,
  // FEATURE_097 (v0.7.34) — todo-store hooks. The store is created
  // once per `runManagedTaskViaRunnerInner` call, then woven through
  // `baseCtx.todoStore` (so the `todo_update` tool can mutate it) AND
  // through this wrapper. FEATURE_193 (v0.7.43): only the verdict-slot
  // dispatch remains — scout seeding and contract replan-seed branches
  // were retired with the V1 chain.
  //   - accept → autoCompleteOnAccept
  //   - revise (Worker retry) → markInProgressFailed + arm the
  //                             pending reset-failed flag
  //   - revise (replan, defensive) → reset
  //   - blocked → no-op (terminal; list state is moot)
  // `pendingFailedResetRef` is consumed at the next Worker turn's
  // `instructions` resolve so the user briefly sees ✗ before ☐.
  todoStore?: TodoStore,
  pendingFailedResetRef?: { current: boolean },
): RunnableTool {
  // `slot` is retained as a parameter for call-site clarity (the
  // surrounding test suite asserts on the verdict slot semantics) but
  // is no longer a discriminator — kept here to mark intent.
  void slot;
  return {
    ...base,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      let result = await base.execute(input, ctx);
      if (!result.isError && result.metadata) {
        // Shard 6d-U: guard against H1→H2 upgrade attempts that exceed
        // `plan.decision.upgradeCeiling`. When the Evaluator issues
        // `revise + next_harness=H2` but the plan only permits H1, we
        // rewrite the emitter's `handoffTarget` from Planner back to
        // Generator (continue at the current harness) and flip the
        // degraded-continue ref so the final managed-task runtime carries
        // `degradedContinue: true`. Mirrors legacy's
        // `denyHarnessUpgrade → degradedContinue` branch.
        // FEATURE_184 (v0.7.45) Phase C.3: this branch is no longer triggered in
        // production — Generator is now terminal and the Sidecar Verifier writes
        // `recorder.verdict` directly via `applySidecarVerdictToRecorder` (which
        // replicates the budget logic). Preserved here for the
        // `wrapEmitterWithRecorder` unit-test surface exposed through
        // `__runnerDrivenTestables`; removing it would break those tests without
        // equivalent coverage in the sidecar bridge.
        if (budgetExtension) {
          const emitterMeta = result.metadata as unknown as ProtocolEmitterMetadata;
          const verdictPayload = emitterMeta.payload?.verdict;
          const requested = verdictPayload?.nextHarness;
          const ceiling = budgetExtension.planRef.current?.decision.upgradeCeiling;
          if (
            verdictPayload?.status === 'revise'
            && requested
            && ceiling
            && isUpgradeBeyondCeiling(requested, ceiling)
          ) {
            budgetExtension.degradedContinueRef.current = true;
            // Rewrite handoff target back to Generator so the next turn
            // continues execution under the current harness rather than
            // pivoting to Planner. Both the recorder copy and the result
            // returned to the Runner must carry the redirected target.
            const redirectedMetadata: ProtocolEmitterMetadata = {
              ...emitterMeta,
              handoffTarget: GENERATOR_AGENT_NAME,
            };
            result = { ...result, metadata: redirectedMetadata as unknown as Record<string, unknown> };
          }

          // v0.7.26 Risk-2 fix — H1 same-harness revise cap. Without
          // this, Evaluator can emit `revise` repeatedly up to
          // `MAX_ROUNDS_BY_HARNESS[H1] = 6`, which manifested in user
          // reports as the Scout → Generator → Evaluator death loop.
          // Legacy capped H1 at 1 same-harness revise via
          // `h1CheckedDirectRevisesUsed`; we do the same here.
          //
          // Policy when cap is exceeded:
          //   - upgradeCeiling permits H2 → auto-rewrite the verdict
          //     into an H2 escalation (nextHarness=H2, handoffTarget
          //     restored to Planner). User sees a planner turn added
          //     rather than another revise cycle.
          //   - upgradeCeiling blocks upgrade → auto-convert to accept:
          //     status=accept, followups prepended with Evaluator's
          //     reason so the remaining concern is visible to the user.
          //     Flip degradedContinue so the runtime surfaces the
          //     "accepted under cap" state. The accept is NOT silent —
          //     the reason line is the first followup.
          const currentHarness = budgetExtension.harnessRef.current;
          const updatedEmitterMeta = result.metadata as unknown as ProtocolEmitterMetadata;
          const updatedVerdict = updatedEmitterMeta.payload?.verdict;
          if (
            updatedVerdict?.status === 'revise'
            && currentHarness === 'H1_EXECUTE_EVAL'
          ) {
            const revisesSoFar = budgetExtension.reviseCountByHarnessRef.current.get(currentHarness) ?? 0;
            if (revisesSoFar >= H1_MAX_SAME_HARNESS_REVISES) {
              const ceilingForUpgrade = budgetExtension.planRef.current?.decision.upgradeCeiling;
              const canEscalateToH2 =
                ceilingForUpgrade
                && !isUpgradeBeyondCeiling('H2_PLAN_EXECUTE_EVAL', ceilingForUpgrade);
              if (canEscalateToH2) {
                // Auto-escalate: rewrite the verdict to an H2 revise so
                // the Planner picks up the flow. The existing handoff
                // routing (verdict → Planner for replan) kicks in.
                const escalationReason = `Auto-escalated to H2 after H1 revise cap reached. Original reason: ${updatedVerdict.reason ?? '(none)'}`;
                const escalatedMetadata: ProtocolEmitterMetadata = {
                  ...updatedEmitterMeta,
                  payload: {
                    ...updatedEmitterMeta.payload,
                    verdict: {
                      ...updatedVerdict,
                      nextHarness: 'H2_PLAN_EXECUTE_EVAL',
                      reason: escalationReason,
                    },
                  },
                  handoffTarget: PLANNER_AGENT_NAME,
                };
                result = { ...result, metadata: escalatedMetadata as unknown as Record<string, unknown> };
              } else {
                // Convert to accept-with-followup. Preserve Evaluator's
                // reason as the leading followup line so the user sees
                // what the Evaluator still wanted fixed.
                const pendingConcern = updatedVerdict.reason
                  ? `Pending concern from Evaluator (accepted under H1 revise cap): ${updatedVerdict.reason}`
                  : 'Pending concern from Evaluator (accepted under H1 revise cap): revise reason not provided.';
                const followupsList = [pendingConcern, ...(updatedVerdict.followups ?? [])];
                const convertedMetadata: ProtocolEmitterMetadata = {
                  ...updatedEmitterMeta,
                  payload: {
                    ...updatedEmitterMeta.payload,
                    verdict: {
                      ...updatedVerdict,
                      status: 'accept',
                      followups: followupsList,
                      nextHarness: undefined,
                    },
                  },
                  isTerminal: true,
                  handoffTarget: undefined,
                };
                budgetExtension.degradedContinueRef.current = true;
                result = { ...result, metadata: convertedMetadata as unknown as Record<string, unknown> };
              }
            } else {
              // First same-harness revise — increment counter, pass
              // through unchanged. The increment happens AFTER the
              // comparison so the first revise is allowed.
              budgetExtension.reviseCountByHarnessRef.current.set(
                currentHarness,
                revisesSoFar + 1,
              );
            }
          }
        }
        // FEATURE_193 v0.7.43: V1 chain retired. Worker is the executor; any
        // legacy V1 verdict metadata that names GENERATOR_AGENT_NAME as the
        // handoff target gets rewritten to WORKER_AGENT_NAME.
        {
          const emitterMeta = result.metadata as unknown as ProtocolEmitterMetadata;
          if (emitterMeta.handoffTarget === GENERATOR_AGENT_NAME) {
            const rewrittenMetadata: ProtocolEmitterMetadata = {
              ...emitterMeta,
              handoffTarget: WORKER_AGENT_NAME,
            };
            result = { ...result, metadata: rewrittenMetadata as unknown as Record<string, unknown> };
          }
        }
        recorder.verdict = result.metadata as unknown as ProtocolEmitterMetadata;
        // FEATURE_097 (v0.7.34) — todo-store auto-handling on verdict.
        // FEATURE_193 v0.7.43: scout/contract seeding branches removed
        // (V1 chain retired; Scout/Planner no longer emit). Per design §5 ①,
        // the Runner dispatches from the verdict's status here. No-op when
        // `todoStore` was not threaded.
        if (todoStore) {
          const verdictPayload = recorder.verdict?.payload.verdict;
          const status = verdictPayload?.status;
          const nextHarness = verdictPayload?.nextHarness;
          if (status === 'accept') {
            todoStore.autoCompleteOnAccept();
          } else if (status === 'revise') {
            if (nextHarness === 'H2_PLAN_EXECUTE_EVAL') {
              // Replan disposition — drop the list. (Production V2 path
              // never sets nextHarness=H2 since Planner is retired, but
              // the Sidecar Verifier bridge can still synthesize it; keep
              // the branch as a defensive no-op-friendly reset.)
              todoStore.reset();
            } else {
              // Default revise route: Worker retries. Mark current
              // in_progress as failed; the next Worker turn's
              // `instructions` closure will reset failed → pending so
              // the user sees ● → ✗ → ☐ → ● across the retry boundary.
              todoStore.markInProgressFailed('Evaluator requested revision');
              if (pendingFailedResetRef) {
                pendingFailedResetRef.current = true;
              }
            }
          }
          // status === 'blocked' is terminal — leave the list as-is so
          // the final UI render reflects whatever state the work
          // actually reached.
        }
        // FEATURE_193 v0.7.43: scout pre-handoff write warning + scout
        // budget upgrade + scout-decision-to-plan propagation deleted
        // (V1 chain retired; Worker is now the only emitter and runs
        // at a fixed harness chosen at routing time).
        observer.onRoleEmit('evaluator', recorder);
        // 90%-threshold budget-extension dialog on Evaluator verdict. The
        // Runner-driven path (FEATURE_184) reaches this branch only via the
        // Sidecar Verifier bridge after V1 chain retirement (FEATURE_193) —
        // there are no more scout/contract/handoff emits ahead of the
        // verdict that could exhaust the cap silently. Still cheap to fire:
        // `maybeRequestAdditionalWorkBudget` is idempotent when already
        // above/under threshold (returns 'skipped'). The per-harness
        // `additionalUnits` parameter matches the user's tiered mechanism
        // (H0 → +100 small top-up, H1/H2 → +200 legacy-parity top-up).
        if (budget && budgetExtension) {
          observer.notifyBudgetApprovalRequest();
          // Risk-3: when Evaluator explicitly flags a budget request via
          // its verdict payload, bypass the 90% auto-threshold so the
          // user sees the dialog immediately (with Evaluator's reason
          // as the summary) rather than waiting for cumulative usage
          // to cross the default gate.
          const evaluatorBudgetRequest = recorder.verdict?.payload.verdict?.budgetRequest;
          const extensionSummary = evaluatorBudgetRequest
            ? `Evaluator requested more budget: ${evaluatorBudgetRequest}`
            : (recorder.verdict?.payload.verdict?.reason ?? 'Evaluator requested another pass');
          const decision = await maybeRequestAdditionalWorkBudget(
            budgetExtension.events,
            budget,
            {
              summary: extensionSummary,
              currentRound: budgetExtension.roundRef.current,
              maxRounds: budgetExtension.maxRoundsRef.current,
              originalTask: budgetExtension.originalTask,
              additionalUnits: BUDGET_EXTENSION_BY_HARNESS[budget.currentHarness],
              force: Boolean(evaluatorBudgetRequest),
            },
          );
          budgetExtension.budgetApprovalRef.current = false;
          if (decision === 'approved') {
            budgetExtension.maxRoundsRef.current += 1;
          } else if (decision === 'denied') {
            const verdictPayload = recorder.verdict?.payload.verdict;
            if (verdictPayload?.status === 'revise') {
              // Shard 6d-U: user explicitly denied a budget extension on
              // revise — continue at current budget cap but flag
              // `degradedContinue` so the caller can render the warning.
              // Note: `skipped` means "didn't need to ask" (no
              // callback / under 90% / already bumped at this tier) and
              // does NOT constitute degradation.
              budgetExtension.degradedContinueRef.current = true;
            }
          }
        }
      }
      return result;
    },
  };
}
