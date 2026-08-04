/**
 * Verdict-recorder emit wrapper for the runner-driven AMA path.
 *
 * Hosts:
 *   - `BudgetExtensionContext` — the per-run plan/harness/round refs
 *     the emit wrapper needs to fire the 90%-threshold budget-extension
 *     dialog (consumed by `wrapEmitterWithRecorder`)
 *   - `wrapEmitterWithRecorder` — wraps a single protocol-emitter tool
 *     so every successful execution records its `ProtocolEmitterMetadata`
 *     into the recorder, fires the role-emit observer, runs the
 *     budget-extension dialog, and rewrites legacy V1
 *     `handoffTarget=Generator` back to Worker
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~398–870 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. FEATURE_193 (v0.7.43) dropped the V1 scout/contract/handoff
 * slot branches; the harness-LLM-judgment refactor then dropped the
 * dead-on-V2 H1→H2 upgrade-ceiling gate + H1 same-harness revise cap
 * (the Sidecar Verifier never carries `nextHarness`, and the V2 Worker
 * runs at `H0_DIRECT`, never `H1_EXECUTE_EVAL`). Only the verdict-record +
 * budget-dialog logic remains.
 */

import type { RunnableTool, RunnerToolResult } from '@kodax-ai/agent';
import {
  GENERATOR_AGENT_NAME,
  WORKER_AGENT_NAME,
} from '../../../agents/task-engine-agents.js';
import type { ProtocolEmitterMetadata } from '../../../agents/protocol-emitters.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import {
  canRequestAdditionalWorkBudget,
  incrementManagedBudgetUsage,
  maybeRequestAdditionalWorkBudget,
  type ManagedTaskBudgetController,
} from './budget.js';
import { MANAGED_WORK_BUDGET_EXTENSION } from './observer-bridge.js';
import type { TodoStore } from '../../todo-store.js';
import type { ObserverBridge, VerdictRecorder } from './types.js';

// FEATURE_193 (v0.7.43): `SLOT_TO_ROLE` const removed — Commit 6 inlined
// the only reader (`observer.onRoleEmit('evaluator', recorder)`) and the
// scout/contract/handoff fields had no consumer after V1 chain retirement.
// `KodaXTaskRole` import dropped along with it.

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
  // (Removed in ADR-043: `reviseCountByHarnessRef` — a per-harness revise
  // counter that was created and passed but never read by the wrapper; the
  // H1→H2 revise-escalation it was meant to cap no longer exists.)
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
  //   - accept → preserve the Worker's explicit plan state
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
          if (status === 'revise') {
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
        // Budget approval is user-visible, so publish it only for a revise
        // verdict that can actually open the dialog. The shared eligibility
        // check keeps notification and prompting aligned on callback,
        // threshold/force, and per-tier de-duplication.
        const verdictPayload = recorder.verdict?.payload.verdict;
        const evaluatorBudgetRequest = verdictPayload?.budgetRequest;
        const forceBudgetRequest = Boolean(evaluatorBudgetRequest);
        if (
          verdictPayload?.status === 'revise'
          && budget
          && budgetExtension
          && canRequestAdditionalWorkBudget(
            budgetExtension.events,
            budget,
            forceBudgetRequest,
          )
        ) {
          observer.notifyBudgetApprovalRequest();
          // Risk-3: when Evaluator explicitly flags a budget request via
          // its verdict payload, bypass the 90% auto-threshold so the
          // user sees the dialog immediately (with Evaluator's reason
          // as the summary) rather than waiting for cumulative usage
          // to cross the default gate.
          const extensionSummary = evaluatorBudgetRequest
            ? `Evaluator requested more budget: ${evaluatorBudgetRequest}`
            : (verdictPayload.reason ?? 'Evaluator requested another pass');
          const decision = await maybeRequestAdditionalWorkBudget(
            budgetExtension.events,
            budget,
            {
              summary: extensionSummary,
              currentRound: budgetExtension.roundRef.current,
              maxRounds: budgetExtension.maxRoundsRef.current,
              originalTask: budgetExtension.originalTask,
              additionalUnits: MANAGED_WORK_BUDGET_EXTENSION,
              force: forceBudgetRequest,
            },
          );
          budgetExtension.budgetApprovalRef.current = false;
          if (decision === 'approved') {
            budgetExtension.maxRoundsRef.current += 1;
          } else if (decision === 'denied') {
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
