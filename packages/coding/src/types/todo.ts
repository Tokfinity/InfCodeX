/**
 * FEATURE_200 Phase F (v0.7.45) — Todo domain types extracted from types.ts.
 * Self-contained (no other coding-type deps); re-exported from ../types.ts
 * so all `../types` importers are unaffected.
 */

/**
 * Status of a planned todo item. Lifecycle: pending → in_progress →
 * (completed | failed | skipped). Failed items are reset to pending
 * when the next iteration begins (Evaluator revise verdict). Skipped
 * is for Planner-side merging of two obligations into one.
 */
export type TodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  // FEATURE_114 v0.7.36: explicitly cancelled mid-task. Distinct from
  // `skipped` (Planner-side merge) — `cancelled` is a Worker-driven
  // mid-execution decision, surfaced with a strikethrough in the UI.
  | 'cancelled';

/**
 * FEATURE_114 v0.7.36: Per-step deterministic evaluator hint. When a
 * todo item carries an `evaluator`, the runner runs the corresponding
 * deterministic check (build / test / lint) at the moment its status
 * transitions to `completed`. Failure surfaces stderr in the next
 * tool result so the Worker can self-correct. No LLM-as-judge
 * variant — Phase 0.7 industry survey said 4/4 codebases reject
 * per-step LLM verification.
 */
export type TodoEvaluatorHint = 'build' | 'test' | 'lint';

/**
 * One row in the planner-produced todo list. Subject is the short
 * imperative title (shown in the UI row + throttle reminder); the
 * optional description carries fuller context for downstream consumers
 * that need the full work instruction. Sourced from Scout's existing
 * `executionObligations: string[]` payload (each string becomes the
 * `subject` of one seed item, no `description`). Status is advanced
 * via the `todo_update` tool by Scout (H0 path) / Worker / Generator /
 * Planner.
 *
 * v0.7.42 — `content` field renamed to `subject` to match claudecode V2
 * `TaskSchema` (TaskCreateTool's required `subject` + `description`
 * pair). KodaX makes `description` optional because trivial single-line
 * steps don't need it; weaker models reach the API more easily without
 * the forced second-string burden.
 *
 * `owner` partitions the list when child Actors run in parallel;
 * "main" is the parent thread.
 */
export interface TodoItem {
  readonly id: string;
  /** Brief imperative title — the row label users see in the plan list. */
  readonly subject: string;
  /**
   * Optional fuller description / context. Read by the executing role
   * when picking up an item (claudecode V2 `TaskGet`-style detail view).
   * Not rendered in the compact plan-list row.
   */
  readonly description?: string;
  readonly status: TodoStatus;
  readonly owner?: string;
  /** Index into the originating `executionObligations: string[]` array (0-based). */
  readonly sourceObligationIndex?: number;
  /** Optional note attached on a status transition (e.g. failure reason). */
  readonly note?: string;
  /**
   * FEATURE_114 v0.7.36: per-step deterministic evaluator hint. When
   * present, the runner runs the corresponding deterministic check on
   * `pending → completed` and surfaces stderr / exit code in the next
   * tool result on failure.
   */
  readonly evaluator?: TodoEvaluatorHint;
  /**
   * FEATURE_149 v0.7.38 (Slice C4) — present-continuous form of `content`,
   * used by the spinner status line while this item is `in_progress`.
   * Mirrors Claude Code's [`Spinner.tsx:169`](c:/Works/claudecode/src/components/Spinner.tsx#L169)
   * `currentTodo?.activeForm` lookup. Examples:
   *   content: "Run failing test"  → activeForm: "Running failing test"
   *   content: "Refactor auth"     → activeForm: "Refactoring auth"
   *   content: "Verify build"      → activeForm: "Verifying build"
   *
   * Optional. When absent, the spinner falls back to a generic verb (no
   * regression vs pre-FEATURE_149 behavior). When the LLM provides
   * activeForm via `todo_update`, the spinner picks it up live without
   * waiting for the round to end — that's the user-visible "working on X
   * now" feel CC achieves.
   */
  readonly activeForm?: string;
  /**
   * FEATURE_170 v0.7.41 — opaque per-task metadata bag carried alongside
   * the item. Surface for downstream consumers (extension hooks, eval
   * harnesses, future swarm features) to attach arbitrary structured
   * context without forcing a schema change. UI does NOT render this.
   * Empty / undefined when the LLM does not supply it.
   */
  readonly metadata?: Record<string, unknown>;
}

export type TodoList = readonly TodoItem[];
