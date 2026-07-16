/**
 * Rate-limit double-render dedup (v0.7.58 follow-up).
 *
 * A single provider rate-limit/retry fires TWO REPL callbacks back-to-back
 * (see `packages/llm/src/providers/base.ts`): first the structured
 * `onRetryAfter` (richer — carries provider / source / reason / wait), then the
 * legacy flat `onRateLimit` → `onProviderRateLimit`. Both callbacks stay wired
 * (the legacy one still feeds SDK / extension rate-limit events), but the user
 * should see exactly ONE line — not "[Rate limited/Overloaded] …" immediately
 * followed by "[Rate Limit] …" for the same wait.
 *
 * The REPL renders the richer structured line and suppresses the legacy line
 * when it describes the same retry. The two callbacks are correlated by
 * (attempt, maxAttempts, wait-ms): base.ts passes the identical `attempt`,
 * `retries`, and `delay` to both, so an exact triple match is unambiguous.
 */

export interface RateLimitDedupKey {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly waitMs: number;
}

/**
 * True when the legacy rate-limit line describes the same retry the structured
 * `onRetryAfter` line just surfaced, so the legacy line should be suppressed.
 * `pendingStructured` is the most recent structured-line key (or null if none
 * was recorded — e.g. the structured callback isn't wired, in which case the
 * legacy line is the only one and must render).
 */
export function isDuplicateLegacyRateLimit(
  pendingStructured: RateLimitDedupKey | null,
  legacy: { readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number },
): boolean {
  return (
    pendingStructured !== null &&
    pendingStructured.attempt === legacy.attempt &&
    pendingStructured.maxAttempts === legacy.maxAttempts &&
    pendingStructured.waitMs === legacy.delayMs
  );
}
