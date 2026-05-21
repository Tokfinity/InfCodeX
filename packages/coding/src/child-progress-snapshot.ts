/**
 * Child progress snapshot — FEATURE_177 (v0.7.45) substrate for `task_output`.
 *
 * Per-child runtime snapshot a parent agent (Worker / Scout / Generator) can
 * query mid-flight via the `task_output(task_id)` tool. Bridges three pieces
 * that already exist independently in the dispatch pipeline:
 *
 *   1. `childTaskRegistry` — `Map<id, Promise<KodaXChildExecutionResult>>`.
 *      Tells us "is task X still in flight?" but only by Map membership;
 *      registry entries are deleted on settle, so a post-completion query
 *      against the registry alone returns "not found" and loses the result.
 *
 *   2. `buildChildEvents` — emits `onIterationStart` + `onToolUseStart` per
 *      child tool call. The snapshot subscribes via the optional
 *      `snapshotUpdater` param (see `child-executor.ts:buildChildEvents`)
 *      to populate the breadcrumb ring buffer + iteration counter.
 *
 *   3. `dispatch-child-tasks.ts` async branch — already computes the
 *      pre-guardrail `rawSummary` (the diagnostic envelope or the
 *      `<task-completed>` body) at the terminal moment of the child
 *      promise. Snapshot captures that string AS-IS so post-completion
 *      `task_output` reads do not re-run the guardrail / summarizer.
 *
 * The snapshot is in-memory only. No disk persistence (KodaX has no
 * per-child JSONL file; that's claudecode's `DiskTaskOutput` substrate).
 * Memory ceiling enforced by a hard cap on snapshot count (NOT a TTL —
 * a 4h Worker run can produce hundreds of children and a time-based
 * sweep would evict snapshots still being referenced by the LLM).
 *
 * Lifetime: same scope as `childTaskRegistry` / `childAbortControllers`
 * — one map per `buildToolExecutionContext` call. Snapshots survive the
 * child task's own promise settling (so post-completion peeks work) but
 * are garbage-collected when the parent runner exits and the ctx drops.
 */

/** Hard cap on simultaneous snapshots per parent runner. Older entries
 * (by `startedAt`) are pruned when this is exceeded. 200 mirrors
 * `DEFAULT_MAX_ITERATIONS_PER_CHILD`; the practical worst-case parent
 * dispatching 200 unique children in one run is the same order as the
 * built-in iteration cap, so memory stays bounded at ~400KB worst-case
 * (200 × ~2KB per snapshot with 20-entry breadcrumb ring). */
export const CHILD_PROGRESS_SNAPSHOT_CAP = 200;

/** Ring-buffer length for `recentToolCalls`. Bounded so a runaway child
 * can't grow the snapshot unbounded; older breadcrumbs drop off the
 * front. Calibrated against `DEFAULT_MAX_ITERATIONS_PER_CHILD = 200` —
 * 20 entries gives the parent agent enough trailing context to spot a
 * tight loop without holding the whole trace. */
export const RECENT_TOOL_CALLS_RING_CAP = 20;

/** One tool-call breadcrumb. Captures only the name + a 60-char input
 * hint so the snapshot stays compact under fan-out. Mirrors the
 * `inputHint` extraction in `buildChildEvents.onToolUseStart`. */
export interface ChildToolCallBreadcrumb {
  readonly iteration: number;
  readonly toolName: string;
  /** Truncated path/pattern/command, ≤60 chars. May be empty when the
   * tool input has no obvious key field. */
  readonly inputHint: string;
  /** Monotonic wall-clock ms at the time the tool call started. */
  readonly startedAt: number;
}

/** Snapshot status. `running` is the initial state on dispatch. The
 * three terminal states map from the child promise outcome:
 *   - `completed` — child returned success
 *   - `failed` — child returned non-success OR threw (non-AbortError)
 *   - `aborted` — child threw an AbortError (parent or task_stop fired)
 */
export type ChildProgressStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface ChildProgressSnapshot {
  readonly childId: string;
  /** Mutable in the writer (dispatch-child-tasks) — terminal status is
   * set once in the inner-IIFE `.finally` block. Readers
   * (task-output tool) treat it as authoritative. */
  status: ChildProgressStatus;
  /** Monotonic wall-clock ms at dispatch. */
  readonly startedAt: number;
  /** Monotonic wall-clock ms at terminal. Undefined while `status===
   * 'running'`. */
  endedAt?: number;
  /** Iterations consumed by the child agent. Updated by
   * `snapshotUpdater({kind:'iteration', iteration, max})` from
   * `buildChildEvents.onIterationStart`. */
  iterations: number;
  /** Iteration ceiling forwarded from `ChildExecutorOptions
   * .maxIterationsPerChild`. */
  maxIterations: number;
  /** Mutable ring buffer; writer must respect `RECENT_TOOL_CALLS_RING_CAP`
   * via `pushBreadcrumb`. */
  recentToolCalls: ChildToolCallBreadcrumb[];
  /** Populated at terminal (any of `completed` / `failed` / `aborted`)
   * with the same pre-guardrail `rawSummary` string that
   * `dispatch-child-tasks.ts` produces for the `<task-completed>` body.
   * For success-empty / failed-empty paths this is the diagnostic
   * envelope (mode= ... iterations=... etc.) so post-completion
   * `task_output` reads stay in lock-step with the banner the Worker
   * already saw. */
  finalText?: string;
  /** Optional dispatcher role (`scout` / `worker` / `generator`),
   * captured at init so a debug-style `task_output` peek can correlate
   * the child with the parent fan-out class. Not surfaced in the
   * envelope; reserved for future tracing. */
  readonly parentRole?: string;
  /** Read-only flag forwarded from the dispatch bundle. Same rationale
   * as `parentRole` — currently captured for future surfacing. */
  readonly readOnly?: boolean;
}

export interface InitSnapshotInput {
  readonly childId: string;
  readonly startedAt: number;
  readonly maxIterations: number;
  readonly parentRole?: string;
  readonly readOnly?: boolean;
}

/**
 * Initialise a fresh snapshot for a just-dispatched child. Inserts into
 * `snapshots` immediately so a concurrent `task_output(childId)` query
 * during the dispatch tool's own yield phase sees `status:'running'`
 * (not `not_found`).
 *
 * Enforces `CHILD_PROGRESS_SNAPSHOT_CAP` by pruning the oldest
 * (`startedAt`) snapshots when the count would exceed the cap. Pruning
 * is FIFO by start time, not by status, because a long-completed
 * snapshot still belongs to a child the parent might re-query — until
 * the cap forces a choice, all completed snapshots survive.
 */
export function initChildSnapshot(
  snapshots: Map<string, ChildProgressSnapshot>,
  input: InitSnapshotInput,
): ChildProgressSnapshot {
  pruneToCapacity(snapshots, CHILD_PROGRESS_SNAPSHOT_CAP - 1);
  const snap: ChildProgressSnapshot = {
    childId: input.childId,
    status: 'running',
    startedAt: input.startedAt,
    iterations: 0,
    maxIterations: input.maxIterations,
    recentToolCalls: [],
    parentRole: input.parentRole,
    readOnly: input.readOnly,
  };
  snapshots.set(input.childId, snap);
  return snap;
}

export interface FinalizeSnapshotInput {
  readonly status: ChildProgressStatus;
  readonly finalText?: string;
  readonly endedAt: number;
}

/**
 * Terminal write. MUST be called from the inner-IIFE `.finally` block
 * (not the success/crash body) so a thrown handler does not strand the
 * snapshot in `running` forever. If the snapshot is missing (e.g.,
 * pruned by the cap before the child settled), this is a no-op — the
 * parent's task_output query will report `not_found` and the Worker
 * recovers via the regular `<task-completed>` banner path.
 */
export function finalizeChildSnapshot(
  snapshots: Map<string, ChildProgressSnapshot> | undefined,
  childId: string,
  input: FinalizeSnapshotInput,
): void {
  if (!snapshots) return;
  const snap = snapshots.get(childId);
  if (!snap) return;
  snap.status = input.status;
  snap.endedAt = input.endedAt;
  if (input.finalText !== undefined) {
    snap.finalText = input.finalText;
  }
}

/**
 * Event variants the per-child events bridge feeds back to the
 * snapshot. Kept as a discriminated union so future event kinds (e.g.,
 * a real assistant-text chunk hook if the agent runtime grows one) can
 * be added without breaking existing call sites.
 */
export type ChildSnapshotEvent =
  | { readonly kind: 'iteration'; readonly iteration: number; readonly maxIterations: number }
  | { readonly kind: 'tool-start'; readonly iteration: number; readonly toolName: string; readonly inputHint: string; readonly startedAt: number };

/**
 * Apply a streaming event from `buildChildEvents` to the snapshot.
 * Silently dropped when the snapshot is gone — same rationale as
 * `finalizeChildSnapshot`. Designed to be called from inside the
 * coding-package `buildChildEvents` closure; the agent-runtime hooks
 * stay unaware of this substrate.
 */
export function applyChildSnapshotEvent(
  snapshots: Map<string, ChildProgressSnapshot> | undefined,
  childId: string,
  event: ChildSnapshotEvent,
): void {
  if (!snapshots) return;
  const snap = snapshots.get(childId);
  if (!snap) return;
  if (event.kind === 'iteration') {
    snap.iterations = event.iteration;
    snap.maxIterations = event.maxIterations;
    return;
  }
  // tool-start: append breadcrumb + slice tail to enforce ring cap.
  // Immutable replacement of `recentToolCalls` (new array per event)
  // rather than in-place `push`/`shift` — keeps the field swap as the
  // single mutation per snapshot per event, in line with the project's
  // immutability convention (CLAUDE.md / coding-style). At a worst-case
  // ~6 tool calls/sec/child the allocation cost is negligible.
  const breadcrumb = {
    iteration: event.iteration,
    toolName: event.toolName,
    inputHint: event.inputHint,
    startedAt: event.startedAt,
  };
  snap.recentToolCalls = [...snap.recentToolCalls, breadcrumb].slice(
    -RECENT_TOOL_CALLS_RING_CAP,
  );
}

/**
 * FIFO prune to a target size. Exported for tests; in production only
 * `initChildSnapshot` calls this with `cap - 1` so the next insert lands
 * the count at exactly `CHILD_PROGRESS_SNAPSHOT_CAP`.
 *
 * Stable ordering by `startedAt` ASC. Ties broken arbitrarily by Map
 * iteration order (insertion order in practice — `Map` preserves it).
 */
export function pruneToCapacity(
  snapshots: Map<string, ChildProgressSnapshot>,
  targetSize: number,
): void {
  if (snapshots.size <= targetSize) return;
  const entries = [...snapshots.values()].sort((a, b) => a.startedAt - b.startedAt);
  const dropCount = snapshots.size - targetSize;
  for (let i = 0; i < dropCount; i++) {
    snapshots.delete(entries[i].childId);
  }
}
