/**
 * Generic concurrency-bounded fan-out — `runFanOut`.
 *
 * FEATURE_120 v0.7.39 Step 0d (Option D scope). Lifts the truly
 * agent-flavor-agnostic part of `@kodax-ai/coding`'s `executeChildAgents`
 * orchestrator: bounded-concurrency `Promise.allSettled` + abort-pre-
 * check + structured progress events + cancelled-bundles tracking.
 *
 * What stays at `@kodax-ai/coding`'s `executeChildAgents`:
 *   - `KodaXChildContextBundle` / `KodaXChildExecutionResult` shapes
 *   - read vs write child differentiation
 *   - `validateWriteBundles` role policy
 *   - worktree isolation + cleanup
 *   - briefing + `CHILD_AGENT_SYSTEM_PROMPT` injection
 *
 * What lives here:
 *   - Bounded concurrency via private semaphore
 *   - Pre-execution abort check (cancelled bundles collected)
 *   - Promise.allSettled-style rejection capture
 *   - Per-bundle structured progress events (`start` / `item-done` /
 *     `item-failed`) with stable bundle reference + completed/total
 *     counter via a second context argument
 *
 * The wrapper has zero inbound dependency on coding-flavor types —
 * `TBundle` and `TResult` are fully opaque to the module (ADR-021).
 */

/**
 * Module-private concurrency limiter. Acquire returns a release fn;
 * caller MUST invoke it (or throw out of the protected block) so the
 * waiting queue can advance. Single-threaded JavaScript means the
 * `current++` / `current--` updates are atomic at the statement level.
 */
function createSemaphore(maxConcurrent: number): {
  acquire: () => Promise<() => void>;
} {
  let current = 0;
  const waiting: Array<() => void> = [];

  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const tryAcquire = (): void => {
          if (current < maxConcurrent) {
            current++;
            resolve(() => {
              current--;
              const next = waiting.shift();
              if (next) queueMicrotask(next);
            });
          } else {
            waiting.push(tryAcquire);
          }
        };
        tryAcquire();
      });
    },
  };
}

/** Discriminated union for `onProgress` event payloads. */
export type FanOutProgressEvent<TBundle, TResult> =
  | {
      readonly kind: 'start';
      readonly bundle: TBundle;
      readonly bundleIndex: number;
    }
  | {
      readonly kind: 'item-done';
      readonly bundle: TBundle;
      readonly bundleIndex: number;
      readonly result: TResult;
    }
  | {
      readonly kind: 'item-failed';
      readonly bundle: TBundle;
      readonly bundleIndex: number;
      readonly error: Error;
    };

export interface RunFanOutOptions<TBundle, TResult> {
  /**
   * The bundles to execute. Order is preserved as the canonical
   * "bundle index" for progress events; result order is **completion
   * order**, not bundle order (mirror callers use the bundle reference
   * carried in each event or each result to attribute outcomes).
   */
  readonly bundles: readonly TBundle[];
  /**
   * Per-bundle executor. The wrapper invokes this after acquiring a
   * concurrency slot AND after passing the abort pre-check. If the
   * promise rejects, the rejection is captured in the result
   * `{status: 'rejected', bundle, reason}` and onProgress's
   * `item-failed` event fires; otherwise `{status: 'fulfilled', bundle,
   * value}` and `item-done` fires.
   */
  readonly runOne: (bundle: TBundle) => Promise<TResult>;
  /**
   * Maximum concurrent in-flight `runOne` invocations. Must be ≥ 1;
   * a value of 1 collapses the fan-out to strict serial execution.
   */
  readonly maxParallel: number;
  /**
   * Optional cancellation signal. Checked AFTER each semaphore acquire
   * but BEFORE invoking `runOne`. Bundles whose abort check fires are
   * added to `cancelled` and never see their `runOne` call. In-flight
   * `runOne` invocations are NOT interrupted — abort acts as a "stop
   * scheduling new work" signal.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Optional progress hook. The first argument is the event; the
   * second is a shared snapshot of `{completedCount, totalCount}`
   * captured at the moment the event fires (so callers don't need
   * to maintain their own counter).
   */
  readonly onProgress?: (
    event: FanOutProgressEvent<TBundle, TResult>,
    ctx: { readonly completedCount: number; readonly totalCount: number },
  ) => void;
}

/**
 * Per-bundle outcome carried in the final result. Mirrors
 * `PromiseSettledResult` but adds the originating `bundle` for easy
 * mapping back to caller-owned state.
 */
export type FanOutOutcome<TBundle, TResult> =
  | {
      readonly status: 'fulfilled';
      readonly bundle: TBundle;
      readonly value: TResult;
    }
  | {
      readonly status: 'rejected';
      readonly bundle: TBundle;
      readonly reason: Error;
    };

export interface RunFanOutResult<TBundle, TResult> {
  /**
   * Per-bundle outcomes in **completion order** (NOT input bundle
   * order). Use the embedded `bundle` reference to map outcomes back
   * to caller state — index-based access is order-fragile.
   */
  readonly results: ReadonlyArray<FanOutOutcome<TBundle, TResult>>;
  /**
   * Bundles that were skipped due to abort firing before their
   * `runOne` call. Preserves input bundle reference so callers can
   * map back to their own per-bundle state.
   */
  readonly cancelled: readonly TBundle[];
}

/**
 * Run `runOne` over each bundle with bounded concurrency. Returns
 * after every bundle has either settled (`results`) or been skipped
 * due to abort (`cancelled`).
 *
 * Behavior:
 *   - Empty `bundles` → returns `{results: [], cancelled: []}`
 *     immediately without firing any events.
 *   - `maxParallel ≥ bundles.length` collapses to native
 *     `Promise.allSettled` semantics (no semaphore contention).
 *   - `maxParallel === 1` collapses to strict serial execution.
 *   - Each successful `runOne` fires `onProgress({kind: 'item-done',
 *     ..., result})` AFTER `completedCount` is incremented (so the
 *     `ctx.completedCount` in the event reflects "including this
 *     one").
 *   - Each failed `runOne` fires `onProgress({kind: 'item-failed',
 *     ..., error})` with `completedCount` updated the same way —
 *     the counter counts settled items regardless of success.
 *   - Abort firing AFTER a bundle has entered `runOne` does NOT
 *     cancel that bundle's promise — it completes normally and
 *     joins `results`. Only bundles still waiting for a semaphore
 *     slot (or those whose semaphore-acquired callback runs after
 *     abort) get marked cancelled.
 */
export async function runFanOut<TBundle, TResult>(
  opts: RunFanOutOptions<TBundle, TResult>,
): Promise<RunFanOutResult<TBundle, TResult>> {
  const { bundles, runOne, maxParallel, abortSignal, onProgress } = opts;

  if (bundles.length === 0) {
    return { results: [], cancelled: [] };
  }
  if (maxParallel < 1) {
    throw new Error(
      `runFanOut: maxParallel must be ≥ 1, got ${String(maxParallel)}`,
    );
  }

  const totalCount = bundles.length;
  const sem = createSemaphore(maxParallel);
  const results: Array<FanOutOutcome<TBundle, TResult>> = [];
  const cancelled: TBundle[] = [];
  let completedCount = 0;

  await Promise.all(
    bundles.map(async (bundle, bundleIndex) => {
      const release = await sem.acquire();
      try {
        if (abortSignal?.aborted) {
          cancelled.push(bundle);
          return;
        }

        onProgress?.(
          { kind: 'start', bundle, bundleIndex },
          { completedCount, totalCount },
        );

        try {
          const value = await runOne(bundle);
          completedCount++;
          results.push({ status: 'fulfilled', bundle, value });
          onProgress?.(
            { kind: 'item-done', bundle, bundleIndex, result: value },
            { completedCount, totalCount },
          );
        } catch (err) {
          completedCount++;
          const error = err instanceof Error ? err : new Error(String(err));
          results.push({ status: 'rejected', bundle, reason: error });
          onProgress?.(
            { kind: 'item-failed', bundle, bundleIndex, error },
            { completedCount, totalCount },
          );
        }
      } finally {
        release();
      }
    }),
  );

  return { results, cancelled };
}
