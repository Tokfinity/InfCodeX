/**
 * FEATURE_192 v0.7.44 Phase C — Goal-tools execution context.
 *
 * The 3 goal tools (`get_goal`, `create_goal`, `update_goal`) read +
 * mutate persistent goal state. The coding layer does NOT own that
 * state — it lives in the REPL-side session lineage. Tools call into
 * this interface, which the runner-driven adapter wires at task start.
 *
 * Why an interface (not direct lineage access from the tool):
 *   1. Lineage mutations need to round-trip through session storage
 *      (persistence + UI events); the tool shouldn't know that pipe.
 *   2. The Sidecar Verifier call for `update_goal({complete})` needs
 *      runtime provider + transcript snapshot — wired at the boundary
 *      where verifier-provider-resolver runs, not inside the tool.
 *   3. The 3-turn blocker rule has process-lifetime state that lives
 *      with the goal runtime, not with the tool registration.
 *
 * All three methods are async — both reads (because they may touch
 * the session storage) and writes (because they persist).
 */

import type { KodaXGoalState } from '@kodax-ai/agent';

export interface GoalCompleteResult {
  readonly ok: boolean;
  /** Present iff `!ok` — explains why complete was rejected. */
  readonly reason?: string;
  /** Optional one-line how-to-fix from the verifier. */
  readonly suggestedFix?: string;
}

export interface GoalBlockedResult {
  readonly ok: boolean;
  /** Status message: success summary or rejection reason. Always set. */
  readonly statusMessage: string;
  /** Counter snapshot for transparency / debugging. */
  readonly counter: { readonly current: number; readonly required: number };
}

export interface GoalCreateInput {
  readonly objective: string;
  readonly tokenBudget?: number | null;
}

export interface GoalToolsContext {
  /** Read current goal state from the session lineage. */
  readonly readGoal: () => Promise<KodaXGoalState | null>;
  /** Create a new goal. Throws if an active goal already exists. */
  readonly createGoal: (input: GoalCreateInput) => Promise<KodaXGoalState>;
  /**
   * Request transition to `complete`. Implementation runs the Sidecar
   * Verifier and returns `{ok:false, reason}` on non-accept. On accept
   * the lineage gets a new goal entry with `status: 'complete'`.
   */
  readonly requestComplete: () => Promise<GoalCompleteResult>;
  /**
   * Request transition to `blocked`. Implementation applies the
   * 3-turn rule via `recordBlockerAttempt` and persists the updated
   * counter regardless of whether the transition was allowed.
   */
  readonly requestBlocked: (blockerKind: string) => Promise<GoalBlockedResult>;
}

/**
 * Module-scoped fallback: when the tool runs without a goal context
 * wired (e.g. dispatched from a non-REPL test harness), each method
 * returns a uniform "feature disabled" error so the model gets a
 * clear signal rather than a silent failure.
 */
export function makeDisabledGoalToolsContext(): GoalToolsContext {
  const disabled = '[Tool Error] /goal feature is not enabled in this session. Set KODAX_GOAL_ENABLED=1 to opt in.';
  return {
    readGoal: async () => null,
    createGoal: async () => {
      throw new Error(disabled);
    },
    requestComplete: async () => ({ ok: false, reason: disabled }),
    requestBlocked: async () => ({
      ok: false,
      statusMessage: disabled,
      counter: { current: 0, required: 3 },
    }),
  };
}
