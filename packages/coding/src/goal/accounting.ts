/**
 * FEATURE_192 v0.7.44 Phase B — Token + wall-time accounting for goals.
 *
 * Pure functions. The runtime middleware (`lifecycle.ts`) feeds these
 * deltas into the persisted `KodaXGoalState.tokensUsed` /
 * `timeUsedSeconds` counters.
 *
 * Codex parity: tokens charged against the goal exclude cached-input
 * reads (server-side cache hits that don't represent fresh computation)
 * to prevent token-budget exhaustion from cache thrashing. We DO charge
 * output tokens 1:1 — they always reflect new computation.
 *
 * Plan-mode exclusion: callers are responsible for skipping the
 * accounting call when `permissionMode === 'plan'`. We do not gate
 * inside this module so callers can decide per-turn (plan→non-plan
 * transitions mid-task should resume accounting cleanly).
 */

import type { KodaXTokenUsage } from '@kodax-ai/llm';

/**
 * Per-turn token delta charged against the active goal.
 *
 * Formula: `max(0, input - cachedRead) + max(0, output)`. Mirrors
 * Codex `codex-rs/ext/goal/src/accounting.rs` minus the
 * cache-creation token (we treat cache writes as input cost — they ARE
 * new input bytes; only cache READS are deductible).
 *
 * Returns 0 (not NaN) when usage is unset — callers can blindly add
 * the result to `tokensUsed`.
 */
export function goalTokenDelta(usage: KodaXTokenUsage | undefined): number {
  if (!usage) return 0;
  const inputNet = Math.max(
    0,
    (usage.inputTokens ?? 0) - (usage.cachedReadTokens ?? 0),
  );
  const output = Math.max(0, usage.outputTokens ?? 0);
  return inputNet + output;
}

/**
 * Wall-clock delta in whole seconds. The runtime caller pairs each
 * turn boundary with a `Date.now()` reading; this helper just
 * normalizes the unit + drops sub-second precision so the persisted
 * counter stays compact and human-readable.
 *
 * Returns 0 for negative input (clock skew or out-of-order timestamps)
 * so a buggy caller can't silently accumulate negative time.
 */
export function turnWallTimeDelta(
  turnStartMs: number,
  turnEndMs: number,
): number {
  const delta = turnEndMs - turnStartMs;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.floor(delta / 1000);
}

/**
 * Returns true when applying `tokensDelta` to `currentUsed` would
 * cross (or has already crossed) `tokenBudget`. Callers use this to
 * decide whether to flip the goal status to `budget_limited`. Returns
 * false when `tokenBudget === null` (no explicit budget set).
 */
export function shouldFlipBudgetLimited(
  currentUsed: number,
  tokensDelta: number,
  tokenBudget: number | null,
): boolean {
  if (tokenBudget === null) return false;
  return currentUsed + tokensDelta >= tokenBudget;
}
