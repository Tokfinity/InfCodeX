/**
 * FEATURE_192 v0.7.44 Phase C — Sidecar Verifier bind for goal complete.
 *
 * `update_goal({status:'complete'})` cannot trust the model's claim
 * alone — same problem domain as F184 Sidecar Verifier (text-only
 * termination that says "done!" with no actual progress). We reuse the
 * F184 public surface (`invokeSidecarVerifier`) and feed it a custom
 * context describing the goal's CURRENT objective + the recent
 * transcript window.
 *
 * Why a separate bind (not just wire F184's stop hook here):
 *   - F184 fires on EVERY text-only termination; we only need to fire
 *     on explicit complete claims.
 *   - F184's context is "did the agent do what the LAST user message
 *     asked for?" We need "did the agent achieve the GOAL OBJECTIVE?"
 *   - The verdict mapping differs: F184 maps accept→stop, revise→
 *     reanimate, blocked→halt. Goal-complete only cares about
 *     accept (transition allowed) vs anything-else (rejection with
 *     reason).
 *
 * **This module is the integration boundary; actual provider wiring
 * lives in Phase D (REPL adapter) where verifier-provider-resolver is
 * resolvable.** Phase C exposes the pure async function and an
 * adapter shape that the REPL can inject.
 */

import type {
  SidecarVerifierContextInputs,
  SidecarVerifierVerdict,
  SidecarVerifierInvokeOptions,
} from '../agent-runtime/middleware/sidecar-verifier/verifier.js';
import type { KodaXGoalState } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { GoalCompleteResult } from './tools-context.js';

/**
 * The Phase D REPL adapter supplies this function. It pairs the
 * resolved verifier provider with a freshly-built context snapshot
 * for the moment the tool fired.
 */
export type GoalCompletionVerifier = (
  options: SidecarVerifierInvokeOptions,
) => Promise<SidecarVerifierVerdict>;

export interface VerifyGoalCompletionOptions {
  readonly goal: KodaXGoalState;
  readonly recentTranscript: readonly KodaXMessage[];
  readonly lastAssistantText: string;
  readonly currentTurnUserQueries: readonly string[];
  readonly fileEditSummary: readonly { readonly path: string; readonly diffHint: string }[];
  /** The resolved provider — Phase D wires this from
   *  `verifier-provider-resolver.ts`. Same provider F184 uses. */
  readonly invokeVerifier: GoalCompletionVerifier;
  readonly providerInvocation: Omit<SidecarVerifierInvokeOptions, 'inputs'>;
}

/**
 * Verify the agent's claim of goal completion via the F184 Sidecar
 * Verifier. Returns `{ok:true}` only on `accept`; on `revise`,
 * `blocked`, or any internal error/timeout, returns `{ok:false}` with
 * the verifier's reason + optional suggestedFix.
 *
 * Custom context wrap: we prepend a synthetic "current turn user
 * query" describing the goal's objective. This is the key hack — the
 * F184 verifier expects to see a user query AND an assistant claim;
 * for goal-complete the implicit "user query" is "achieve <objective>".
 */
export async function verifyGoalCompletion(
  options: VerifyGoalCompletionOptions,
): Promise<GoalCompleteResult> {
  const objectiveQuery = `Pursue this goal until complete: ${options.goal.objective}`;
  const inputs: SidecarVerifierContextInputs = {
    currentTurnUserQueries: [objectiveQuery, ...options.currentTurnUserQueries],
    recentTranscript: options.recentTranscript,
    fileEditSummary: options.fileEditSummary,
    lastAssistantText: options.lastAssistantText,
  };
  const verdict = await options.invokeVerifier({
    ...options.providerInvocation,
    inputs,
  });
  if (verdict.verdict === 'accept') {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      verdict.reason ||
      `verifier returned ${verdict.verdict} without a stated reason (trace: ${verdict.trace})`,
    suggestedFix: verdict.suggestedFix,
  };
}
