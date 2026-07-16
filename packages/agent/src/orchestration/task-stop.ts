/**
 * Generic per-task abort primitive — `requestTaskStop`.
 *
 * FEATURE_120 v0.7.39 Phase 3a (ADR-021). Coordinator-style agents need
 * to request that a specific in-flight child task exit gracefully. The
 * @kodax-ai/agent layer owns the abort-controller registry shape and
 * the abort-dispatch decision; agent-flavor wrappers (e.g. the coding
 * `task_stop` tool, Phase 3b) layer in domain framing such as the
 * `<coordinator-stop-request>` message tag.
 *
 * What this primitive owns:
 *   - A `TaskAbortRegistry` type alias = `Map<string, AbortController>`.
 *     The map is owned + mutated by the caller; the primitive only
 *     reads it. Callers use `registry.set(id, controller)` /
 *     `registry.delete(id)` directly — the standard `Map` mutators
 *     are simple enough that wrapping them adds no value.
 *   - `requestTaskStop({taskId, registry, reason?})` — looks up the
 *     controller, decides whether to abort, calls `controller.abort`,
 *     returns a structured outcome.
 *
 * Abort semantics (matches the existing FEATURE_115 soft-pause
 * principle): aborting fires the signal but does NOT interrupt any
 * synchronous tool that's already executing. The child's next abort
 * check (`signal.throwIfAborted()` or an `signal.aborted` poll)
 * surfaces the abort. This matches Node's AbortController contract.
 *
 * What this primitive does NOT do (deliberate):
 *   - Enqueue a coordinator-stop-request message — that's a
 *     coding-flavor convenience and uses the existing
 *     `routeMessage` primitive at the tool layer.
 *   - Track abort lifecycle / auto-cleanup the registry — the
 *     controller's lifetime is tied to its owning task's Promise;
 *     the caller removes the registry entry when the task settles
 *     (typically in a `.finally` chain alongside the child-task
 *     registry cleanup).
 *   - Time-out enforcement / retry — orthogonal concerns owned at
 *     higher layers if needed.
 */

/**
 * Registry mapping task ids to their owning AbortController.
 * Lifetime: created per parent-run, populated at child dispatch,
 * cleared when the child Promise settles.
 */
export type TaskAbortRegistry = Map<string, AbortController>;

export interface RequestTaskStopOptions {
  /** Target task id. Must exist as a key in `registry`. */
  readonly taskId: string;
  /** Registry of in-flight task abort controllers. */
  readonly registry: ReadonlyMap<string, AbortController>;
  /**
   * Optional cause forwarded to `AbortController.abort(reason)`.
   *   - Error → passed through verbatim (preserves stack / custom
   *     subclasses).
   *   - string → wrapped in `new Error(reason)`.
   *   - undefined → a default Error mentioning the taskId is
   *     fabricated so the child receives a non-empty signal.reason.
   */
  readonly reason?: string | Error;
}

export type RequestTaskStopResult =
  | { readonly ok: true; readonly taskId: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown-target';
      readonly taskId: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'already-aborted';
      readonly taskId: string;
    };

/**
 * Look up `taskId` in `registry`. If found and not yet aborted, abort
 * the controller with the supplied reason. Returns a discriminated
 * outcome so callers can render success / error UX without string
 * matching.
 *
 * `already-aborted` is reported separately from success because the
 * first-abort `signal.reason` is preserved verbatim — debugging
 * chains depend on the original cause not being overwritten by
 * subsequent stop requests.
 *
 * Synchronous: `AbortController.abort` is synchronous; no async work
 * is performed by this primitive.
 */
export function requestTaskStop(
  opts: RequestTaskStopOptions,
): RequestTaskStopResult {
  const controller = opts.registry.get(opts.taskId);
  if (!controller) {
    return { ok: false, reason: 'unknown-target', taskId: opts.taskId };
  }
  if (controller.signal.aborted) {
    // Do NOT re-abort — Node's AbortController is a no-op on the
    // second call but `signal.reason` is sticky to the FIRST cause.
    // We surface the already-aborted state so the caller can
    // distinguish "I requested the abort that completed" from
    // "someone else aborted before me".
    return { ok: false, reason: 'already-aborted', taskId: opts.taskId };
  }

  const abortReason = coerceAbortReason(opts.reason, opts.taskId);
  controller.abort(abortReason);
  return { ok: true, taskId: opts.taskId };
}

function coerceAbortReason(
  reason: string | Error | undefined,
  taskId: string,
): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error(`Task "${taskId}" stopped by coordinator request`);
}
