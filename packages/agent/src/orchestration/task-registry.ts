/**
 * Child task registry primitive — generic fan-out tracking.
 *
 * FEATURE_120 v0.7.39 Step 0 (package-attribution migration, ADR-021).
 * Lifted from `@kodax-ai/coding`'s `KodaXToolExecutionContext.childTaskRegistry`
 * field + inline cleanup chain in `tools/dispatch-child-tasks.ts`. The
 * coding side now consumes this primitive specialized to its
 * `KodaXChildExecutionResult` type; any other agent-flavor downstream
 * can specialize on its own child-result type without re-implementing
 * the cleanup contract.
 *
 * The shape is intentionally minimal: a Map plus a `register` helper
 * that bundles the v0.7.38 FEATURE_155 Bug A hotfix (`c1bdaf4e`)
 * cleanup chain into a single call site. The helper exists because
 * the cleanup is **not optional** — without it, every settled promise
 * stays in the registry forever, gets re-wrapped by the next
 * idle-yield `waitForWakeEvent` call, and fires spurious
 * `child-completed` wakes (production symptom: Evaluator gets
 * bombarded by duplicate `<task-completed>` notifications, consuming
 * an LLM turn each up to `IDLE_YIELD_MAX_ITERATIONS=64`).
 */

/**
 * Map of `task_id` → in-flight child-execution promise. Generic over
 * the child-result type so the agent layer doesn't depend on any
 * specific agent flavor's result shape.
 *
 * Mutation contract:
 *   - Owned by the runner's per-turn execution context. The dispatch
 *     tool writes via `registerChildTask`; the idle-yield outer loop
 *     reads via `Map.prototype.entries()` / `.size`.
 *   - **Never delete entries manually** — call `registerChildTask`
 *     and the cleanup chain it installs will run on settle.
 */
export type ChildTaskRegistry<T> = Map<string, Promise<T>>;

/**
 * Register an in-flight child-execution promise in the registry and
 * install the cleanup chain that removes the entry once the promise
 * settles (success or failure).
 *
 * The cleanup chain is two stages:
 *   1. `.finally(() => registry.delete(childId))` — runs on settle
 *      regardless of outcome, removing the entry before the next
 *      idle-yield outer-loop iteration observes the registry.
 *   2. `.catch(() => {})` — swallows the rejection on the cleanup
 *      chain so a child that crashes before any consumer awaits it
 *      doesn't surface as `unhandledRejection` on Node. Must come
 *      AFTER `.finally` because `.finally` returns a NEW promise
 *      that rejects with the same reason.
 *
 * The original `promise` argument is **not** returned — the helper's
 * value-add is the cleanup side-effect, not promise transformation.
 * Callers that need to await the result read from `registry.get(id)`
 * or hold their own reference.
 *
 * @throws Error when `childId` already exists in the registry. Caller
 *   should report this to the LLM as a tool-error (duplicate task_id);
 *   the helper does NOT swallow the conflict because that would
 *   silently overwrite an in-flight child's tracking entry.
 */
export function registerChildTask<T>(
  registry: ChildTaskRegistry<T>,
  childId: string,
  promise: Promise<T>,
): void {
  if (registry.has(childId)) {
    throw new Error(
      `registerChildTask: task_id "${childId}" is already in flight`,
    );
  }
  registry.set(childId, promise);
  promise
    .finally(() => {
      registry.delete(childId);
    })
    .catch(() => {});
}
