/**
 * Speculative Classify — FEATURE_158 Step 4 (v0.7.39).
 *
 * Races an in-flight classifier promise against a short "quiet window".
 * When the classifier returns within the window, callers can use the
 * decision immediately — no confirm dialog, no perceptible latency. When
 * the window expires first, the caller (the auto-mode guardrail) awaits the
 * SAME promise and adopts whatever verdict arrives — see Issue 143 (WS1).
 * The window therefore only controls "resolve instantly vs wait a little
 * longer"; it never decides "escalate vs not". An `allow` verdict never
 * surfaces a confirm dialog no matter how slow the classifier is.
 *
 * Design ref: ADR-025 + FEATURE_158 (docs/features/v0.7.39.md);
 * late-verdict adoption: Issue 143 (docs/KNOWN_ISSUES.md).
 *
 * **The promise is NOT aborted on window expiry.** The caller retains
 * ownership; they pass the same `Promise<T>` to `speculativeRace` and
 * then `await` it to adopt the late verdict. Cancelling mid-flight would
 * waste tokens already spent AND throw away the verdict the caller is
 * about to use.
 *
 * Callers may also force `windowMs = 0` to disable the race entirely when no
 * interactive surface is present (Issue 143 WS2 — the guardrail does this for
 * SDK / non-interactive / child-agent contexts, where there is no human to
 * spare from latency, so it just awaits the verdict directly).
 *
 * Env knob: `KODAX_AUTO_SPECULATIVE_WINDOW_MS`
 *   - default: 500 — the threshold past which a slow classify waits for its
 *     real verdict instead of resolving instantly. See WS4 micro-bench in
 *     docs/features/v0.7.39.md for the measured p50/p95 this is set against.
 *   - `0`     : disabled — `speculativeRace` waits for the promise
 *     (synchronous classify; identical verdict outcome to a non-zero window)
 *   - negative: treated as `0` (disabled)
 *   - non-numeric: ignored, default used
 */

export type SpeculativeResult<T> =
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'window-expired' };

export const DEFAULT_WINDOW_MS = 500;
export const ENV_VAR = 'KODAX_AUTO_SPECULATIVE_WINDOW_MS';

/**
 * Read the speculative window from `process.env[ENV_VAR]`. Returns
 * `undefined` when the env var is unset or malformed (caller falls back
 * to `DEFAULT_WINDOW_MS`). Returns `0` to mean "disabled — wait forever".
 */
export function readWindowFromEnv(): number | undefined {
  const raw = process.env[ENV_VAR];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * Race the given promise against the speculative window. Returns
 * `{kind: 'resolved', value}` when the promise wins (preferred fast path)
 * or `{kind: 'window-expired'}` when the timer wins.
 *
 * Caller responsibilities:
 *   - Hold the original `promise` reference. If the window expires, the
 *     caller can still `await promise` later — speculativeRace does NOT
 *     cancel it.
 *   - If the promise REJECTS within the window, this function rejects
 *     too (callers `try/catch` or attach `.catch` upstream). When the
 *     window expires before rejection, the rejection is silently
 *     absorbed here (we attach a no-op `.catch` to prevent
 *     UnhandledPromiseRejection) and the caller will surface it later
 *     when they await the original promise.
 *
 * windowMs precedence:
 *   1. Explicit argument
 *   2. `readWindowFromEnv()`
 *   3. `DEFAULT_WINDOW_MS`
 *
 * `windowMs === 0` disables the race — returns `{kind: 'resolved'}` once
 * the promise settles (equivalent to `await promise` wrapped in the
 * result shape).
 */
export async function speculativeRace<T>(
  promise: Promise<T>,
  windowMs?: number,
): Promise<SpeculativeResult<T>> {
  const window = windowMs ?? readWindowFromEnv() ?? DEFAULT_WINDOW_MS;

  // Disabled — wait for the promise forever. Caller still wraps the result.
  if (window <= 0) {
    const value = await promise;
    return { kind: 'resolved', value };
  }

  let timer: NodeJS.Timeout | undefined;
  const timerPromise = new Promise<SpeculativeResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'window-expired' }), window);
  });

  const wrappedPromise: Promise<SpeculativeResult<T>> = promise.then(
    (value) => ({ kind: 'resolved', value }) as const,
  );

  // Attach silent rejection handler so a late rejection (after window expiry)
  // doesn't trigger UnhandledPromiseRejection. Caller awaits original promise
  // separately to surface the error.
  promise.catch(() => {
    /* swallowed here; caller handles via original promise */
  });

  try {
    return await Promise.race([wrappedPromise, timerPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
