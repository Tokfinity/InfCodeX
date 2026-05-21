/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier → VerdictRecorder bridge.
 *
 * Phase D.2 plumbing. When the Sidecar Verifier emits a verdict via the
 * agent-layer `RunOptions.stopHook` callback, this helper writes a
 * synthetic `ProtocolEmitterMetadata` into `recorder.verdict` with the
 * same shape that the (now-retired) `wrapEmitterWithRecorder` verdict
 * slot used to produce when Evaluator called `emit_verdict`.
 *
 * **Why route through `recorder.verdict`**: every downstream consumer
 * (`deriveFinalStatus`, `buildManagedProtocolPayload`, TodoStore
 * auto-handle, budget-extension dialog, session-snapshot writer, REPL
 * status events) already reads from this slot. Reusing the same shape
 * means **zero downstream changes** — full behavioral parity is
 * structural, not by porting each consumer.
 *
 * **What this helper preserves from wrapEmitterWithRecorder verdict slot**:
 *   - recorder.verdict assignment
 *   - TodoStore.autoCompleteOnAccept() on accept
 *   - TodoStore.markInProgressFailed() + arm pendingFailedResetRef on revise
 *   - observer.onRoleEmit('evaluator', recorder) for downstream events
 *   - 90%-threshold budget-extension dialog
 *
 * **What this helper INTENTIONALLY DROPS** (replaced by stopHook layer):
 *   - H1 same-harness revise cap (replaced by stopHookReanimateBudget=2
 *     at the agent layer)
 *   - Upgrade ceiling guard (sidecar doesn't switch harness profiles)
 *   - V1→V2 handoffTarget rewrite (no handoffTarget at all in sidecar
 *     world; main agent terminates text-only)
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D.2
 * - verdict-recorder.ts:wrapEmitterWithRecorder verdict slot (lines
 *   202-528 in the legacy implementation) for the behavioral mapping
 *   this bridge mirrors
 */

import type { ProtocolEmitterMetadata } from '../../../agents/protocol-emitters.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXManagedVerdictPayload,
  KodaXTaskRole,
} from '../../../types.js';
import type {
  VerdictRecorder,
  ObserverBridge,
} from '../../../task-engine/_internal/managed-task/types.js';
import type { TodoStore } from '../../../task-engine/todo-store.js';
import {
  maybeRequestAdditionalWorkBudget,
  type ManagedTaskBudgetController,
} from '../../../task-engine/_internal/managed-task/budget.js';
import { BUDGET_EXTENSION_BY_HARNESS } from '../../../task-engine/_internal/managed-task/observer-bridge.js';
import type { BudgetExtensionContext } from '../../../task-engine/_internal/managed-task/verdict-recorder.js';
import type { SidecarVerifierVerdict } from './verifier.js';

/**
 * Build a `KodaXManagedVerdictPayload` from a `SidecarVerifierVerdict`.
 * Pure function — caller writes the result onto the recorder.
 *
 * The `source` field is set to `'sidecar'` (FEATURE_184 architectural
 * marker). `followups` is empty by default — sidecar's `suggestedFix`
 * surfaces as a single follow-up when present.
 */
export function buildSidecarVerdictPayload(
  verdict: SidecarVerifierVerdict,
): KodaXManagedVerdictPayload {
  const followups = verdict.suggestedFix ? [verdict.suggestedFix] : [];
  return {
    source: 'sidecar',
    status: verdict.verdict,
    reason: verdict.reason || undefined,
    followups,
    userFacingText: verdict.reason || '',
  };
}

/**
 * Build the synthetic `ProtocolEmitterMetadata` the bridge writes onto
 * `recorder.verdict`. `role` is `'evaluator'` for backward compat —
 * downstream code (status-derivation, observer-bridge, evidence
 * entries, REPL filter) keys on this string. Architecturally it now
 * means "this is a verdict slot", not "this came from an Evaluator
 * agent role". The new architectural source-of-truth is
 * `payload.verdict.source = 'sidecar'`.
 */
export function buildSidecarVerdictMetadata(
  verdict: SidecarVerifierVerdict,
): ProtocolEmitterMetadata {
  const verdictPayload = buildSidecarVerdictPayload(verdict);
  return {
    role: 'evaluator',
    payload: { verdict: verdictPayload },
    // No handoffTarget — sidecar verdict terminates the run (or
    // reanimates via stopHook string return, which writes a synthetic
    // user msg, not a handoff).
    handoffTarget: undefined,
    // isTerminal: true for accept + blocked. revise reanimates which is
    // also "terminal" for THIS sidecar invocation (next iteration will
    // produce its own verdict if model terminates text-only again).
    isTerminal: true,
  };
}

export interface ApplySidecarVerdictOptions {
  readonly recorder: VerdictRecorder;
  readonly observer: ObserverBridge;
  readonly verdict: SidecarVerifierVerdict;
  readonly todoStore?: TodoStore;
  readonly pendingFailedResetRef?: { current: boolean };
  readonly budget?: ManagedTaskBudgetController;
  readonly budgetExtension?: BudgetExtensionContext;
}

/**
 * Apply a sidecar verifier verdict to the recorder + dependent
 * consumers. Mirrors the verdict-slot behaviour of
 * `wrapEmitterWithRecorder` minus the V1 H1-cap / upgrade-ceiling /
 * handoff-rewrite branches (architecturally replaced by sidecar
 * reanimate budget).
 *
 * Order of operations:
 *   1. Assemble synthetic ProtocolEmitterMetadata
 *   2. Write recorder.verdict
 *   3. Dispatch TodoStore action keyed on verdict status
 *   4. Fire observer.onRoleEmit('evaluator', recorder) so downstream
 *      observer chain (round counter, evidence entries, REPL status,
 *      checkpoint writer) keeps working
 *   5. Fire budget-extension dialog if 90% threshold crossed
 */
export async function applySidecarVerdictToRecorder(
  options: ApplySidecarVerdictOptions,
): Promise<void> {
  const {
    recorder,
    observer,
    verdict,
    todoStore,
    pendingFailedResetRef,
    budget,
    budgetExtension,
  } = options;

  const metadata = buildSidecarVerdictMetadata(verdict);
  recorder.verdict = metadata;

  if (todoStore) {
    const status = verdict.verdict;
    if (status === 'accept') {
      todoStore.autoCompleteOnAccept();
    } else if (status === 'revise') {
      todoStore.markInProgressFailed('Sidecar verifier requested revision');
      if (pendingFailedResetRef) {
        pendingFailedResetRef.current = true;
      }
    }
    // status === 'blocked' is terminal — leave the list as-is so
    // the final UI render reflects whatever state work reached.
  }

  // 'evaluator' label is legacy compat: downstream consumers key on this
  // string; the sidecar architecturally replaces the role but the verdict
  // slot semantics are preserved.
  const emittedRole: KodaXTaskRole = 'evaluator';
  observer.onRoleEmit(emittedRole, recorder);

  // 90%-threshold budget-extension dialog — preserved from the
  // wrapEmitterWithRecorder verdict slot. Fires when sidecar returns
  // revise + cumulative usage crossed 90%, so the user can extend
  // budget before the loop runs out of rounds.
  //
  // FEATURE_184 (v0.7.45) Phase C.1 inline fix: narrow try/catch around
  // maybeRequestAdditionalWorkBudget so dialog failures (e.g. events
  // surface error, provider timeout) cannot crash the bridge. The outer
  // .catch(() => undefined) in runner-driven.ts covers the full bridge
  // call; this inner guard additionally ensures budget side-effects
  // (budgetApprovalRef, maxRoundsRef, degradedContinueRef) are safely
  // skipped on error rather than left in a half-committed state.
  if (budget && budgetExtension) {
    observer.notifyBudgetApprovalRequest();
    const summary = verdict.reason
      ? `Sidecar verifier requested another pass: ${verdict.reason}`
      : 'Sidecar verifier requested another pass';
    try {
      const decision = await maybeRequestAdditionalWorkBudget(
        budgetExtension.events,
        budget,
        {
          summary,
          currentRound: budgetExtension.roundRef.current,
          maxRounds: budgetExtension.maxRoundsRef.current,
          originalTask: budgetExtension.originalTask,
          additionalUnits: BUDGET_EXTENSION_BY_HARNESS[budget.currentHarness],
        },
      );
      budgetExtension.budgetApprovalRef.current = false;
      if (decision === 'approved') {
        budgetExtension.maxRoundsRef.current += 1;
      } else if (decision === 'denied' && verdict.verdict === 'revise') {
        // User denied a budget extension on revise — flip degradedContinue
        // so caller renders the warning. Mirrors the legacy denied-revise
        // branch (Shard 6d-U).
        budgetExtension.degradedContinueRef.current = true;
      }
    } catch {
      // Best-effort: budget dialog failure must not crash the bridge.
      // Leave refs in their pre-call state; run continues without extension.
      budgetExtension.budgetApprovalRef.current = false;
    }
  }
}

// Re-export the events type for callers without forcing a deep import
// through types-imports.ts.
export type { KodaXEvents, KodaXHarnessProfile };
