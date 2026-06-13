/**
 * Todo Plan View-Model — FEATURE_097 (v0.7.34) + FEATURE_151 (v0.7.38).
 *
 * Pure transform from `TodoList` (the canonical store snapshot) to a
 * render-ready set of rows for `TodoListSurface.tsx`. All display
 * decisions live here so the component layer is a thin renderer.
 *
 * Design rules (per docs/features/v0.7.34.md §"View-Model" with
 * FEATURE_151 v0.7.38 visibility-parity revisions):
 *   - Max visible rows = 6 (hard cap, includes optional summary rows).
 *   - Anchor = first in_progress, else first pending, else last
 *     completed/terminal.
 *   - Window: anchor-1 prev, anchor, anchor+2 next (default).
 *   - Top fold: when there are unshown completed items above the
 *     window, insert a `✓ N done` summary row.
 *   - Bottom fold: when there are unshown pending items below the
 *     window, insert a `☐ +N more` summary row.
 *   - Failed-item priority: surface the most recent failed item even
 *     if it would fall outside the window (replaces the nearest
 *     pending slot inside the window).
 *   - shouldRender = totalCount >= MIN_ITEMS_TO_RENDER. FEATURE_151:
 *     MIN dropped from 2 to 1 to match Claude Code's `tasks.length === 0`
 *     UI gate (TaskListV2.tsx:89). The 5-second post-completion linger
 *     auto-hide is also removed in FEATURE_151 — the surface stays
 *     visible until the next AMA task's Scout init or the LLM's
 *     `todo_update op:'init'` triggers a `replace()`. The
 *     `lastAllCompletedAt` parameter is kept on `BuildTodoPlanOptions`
 *     for callers that still pass it (back-compat) but is no longer
 *     consulted; it will be removed in a future cleanup pass once all
 *     callers have migrated.
 */

import type { TodoItem } from "@kodax-ai/coding";

export const MAX_VISIBLE_ROWS = 6;
/**
 * @deprecated FEATURE_151 (v0.7.38) — the linger-based auto-hide was removed
 * to match Claude Code's persistent-visibility behavior. The constant is
 * retained for one release cycle so external `BuildTodoPlanOptions`
 * callers (`InkREPL.tsx`) keep type-checking, then will be deleted along
 * with `lastAllCompletedAt`.
 */
export const POST_COMPLETION_LINGER_MS = 5_000;
/**
 * Below this many items the surface never renders. FEATURE_151 (v0.7.38):
 * 2 → 1 to match Claude Code's `if (tasks.length === 0) return null;`
 * (TaskListV2.tsx:89). 1-item lists from LLM-driven `todo_update op:'init'`
 * (FEATURE_151 Slice B1) now render; 0-item store still hides the surface.
 */
export const MIN_ITEMS_TO_RENDER = 1;

export type TodoRowKind = "item" | "summary_done" | "summary_pending";
export type TodoSymbolColor =
  | "dim"
  | "cyan"
  | "green"
  | "red"
  | "gray";

export interface TodoRow {
  readonly kind: TodoRowKind;
  /** Present only when kind === "item". */
  readonly id?: string;
  readonly symbol: string;
  readonly symbolColor: TodoSymbolColor;
  /** Visible row text. For "item" rows, this is `content` plus optional note for failed. */
  readonly text: string;
  /** True only on the in_progress item. UI uses bold/cyan accent. */
  readonly isActive: boolean;
  /**
   * FEATURE_114 v0.7.36 Slice 4 — true when the row should render with
   * strikethrough styling. Currently only set for `cancelled` status
   * items so a Worker-driven mid-task drop is visually distinguishable
   * from a Planner `skipped` (the symbol `☒` already differs from `⊘`,
   * but strikethrough on the content text gives the user the same
   * "this won't happen" cue Claude Code's `cancelled` rendering does).
   */
  readonly isStrikethrough?: boolean;
  /**
   * FEATURE_114 v0.7.36 Slice 4 — bracketed badge for the deterministic
   * per-step evaluator hint (`[build]` / `[test]` / `[lint]`). Renders
   * dim, after the row text, only on item rows that carry an evaluator
   * hint. Undefined when the item has no hint or for summary rows.
   */
  readonly evaluatorBadge?: string;
}

export interface TodoPlanViewModel {
  /** False when the surface should stay hidden (too few items, post-linger, etc.). */
  readonly shouldRender: boolean;
  /** At most MAX_VISIBLE_ROWS rows, summary rows included. */
  readonly rows: readonly TodoRow[];
  /** Numerator of the "X / Y completed" indicator (counts terminal-success only). */
  readonly completedCount: number;
  /** Denominator of the indicator. */
  readonly totalCount: number;
}

export function formatTodoPlanViewModelForTranscript(
  viewModel: TodoPlanViewModel,
): readonly string[] {
  if (!viewModel.shouldRender || viewModel.rows.length === 0) {
    return [];
  }

  const lines = [
    `Plan ${viewModel.completedCount}/${viewModel.totalCount} completed`,
  ];

  for (const row of viewModel.rows) {
    const badge = row.evaluatorBadge ? ` ${row.evaluatorBadge}` : "";
    lines.push(`${row.symbol} ${row.text}${badge}`);
  }

  return lines;
}

export interface BuildTodoPlanOptions {
  /**
   * Current epoch ms. FEATURE_151 (v0.7.38): no longer consulted by the
   * view-model (the post-completion linger gate was removed for CC parity)
   * but still passed by `InkREPL.tsx` callers, so the field is retained
   * to avoid a coordinated cross-package signature change.
   */
  readonly now: number;
  /**
   * @deprecated FEATURE_151 (v0.7.38) — the 5-second post-completion
   * auto-hide was removed; surface stays visible until the next
   * `replace()` event. Callers may continue to pass this value (the
   * view-model ignores it). Will be deleted in a future cleanup pass.
   */
  readonly lastAllCompletedAt: number | null;
}

const SYMBOL_PENDING = "☐"; // ☐
const SYMBOL_IN_PROGRESS = "●"; // ●
const SYMBOL_COMPLETED = "✓"; // ✓
const SYMBOL_FAILED = "✗"; // ✗
const SYMBOL_SKIPPED = "⊘"; // ⊘
// FEATURE_114 v0.7.36 Slice 1 — `cancelled` is a Worker-driven mid-task
// drop (distinct from `skipped` which is Planner-merge). Use the
// "ballot box with X" glyph (different shape from skipped's `⊘` so the
// two terminal-but-not-completed status flavors are visually distinct).
// Slice 4 may extend the row renderer to add strikethrough on the row's
// content text; the symbol alone is sufficient for compact-only display.
const SYMBOL_CANCELLED = "☒"; // ☒

function symbolForStatus(status: TodoItem["status"]): {
  symbol: string;
  color: TodoSymbolColor;
} {
  switch (status) {
    case "in_progress":
      return { symbol: SYMBOL_IN_PROGRESS, color: "cyan" };
    case "completed":
      return { symbol: SYMBOL_COMPLETED, color: "green" };
    case "failed":
      return { symbol: SYMBOL_FAILED, color: "red" };
    case "skipped":
      return { symbol: SYMBOL_SKIPPED, color: "gray" };
    case "cancelled":
      return { symbol: SYMBOL_CANCELLED, color: "gray" };
    case "pending":
    default:
      return { symbol: SYMBOL_PENDING, color: "dim" };
  }
}

function isTerminal(status: TodoItem["status"]): boolean {
  // FEATURE_114 v0.7.36 Slice 1 — `cancelled` joins the terminal set:
  // a cancelled item is "done" from the linger / fully-closed perspective
  // exactly like skipped. Without this guard, a fully-cancelled plan would
  // never satisfy `isPlanFullyClosed` and the surface would never close.
  return (
    status === "completed"
    || status === "failed"
    || status === "skipped"
    || status === "cancelled"
  );
}

/** Item is "settled" when caller wants the linger timer to advance. */
function allItemsTerminal(items: readonly TodoItem[]): boolean {
  return items.length > 0 && items.every((it) => isTerminal(it.status));
}

function pickAnchorIndex(items: readonly TodoItem[]): number {
  // Priority 1: first in_progress.
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.status === "in_progress") return i;
  }
  // Priority 2: first pending.
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.status === "pending") return i;
  }
  // Priority 3: last completed (so the user sees the final state during linger).
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.status === "completed") return i;
  }
  // Fallback: 0.
  return 0;
}

function buildItemRow(item: TodoItem): TodoRow {
  const { symbol, color } = symbolForStatus(item.status);
  // v0.7.42 — render the row label from `subject`. The optional
  // `description` carries fuller context for `todo_get` consumers and
  // is intentionally NOT rendered here (compact row stays compact).
  const text = item.status === "failed" && item.note
    ? `${item.subject} (${item.note})`
    : item.subject;
  // FEATURE_114 v0.7.36 Slice 4 — cancelled rows render strikethrough
  // so a Worker-driven mid-task drop is visually distinct from a
  // Planner-merge `skipped`. The symbol (`☒` vs `⊘`) already differs;
  // strikethrough on the row text reinforces the "this won't happen"
  // cue.
  const isStrikethrough = item.status === "cancelled";
  // FEATURE_114 v0.7.36 Slice 4 — evaluator hint badge. Items with
  // `evaluator: 'build' | 'test' | 'lint'` get a dim bracketed label
  // appended after the row text (e.g. `Run integration tests [test]`)
  // so the user can see which steps will trigger a deterministic
  // check at completion time. The badge is render-only metadata; the
  // actual check fires from the runner-driven `todo_update` wrapper
  // (Slice 3c).
  const evaluatorBadge = item.evaluator
    ? `[${item.evaluator}]`
    : undefined;
  return {
    kind: "item",
    id: item.id,
    symbol,
    symbolColor: color,
    text,
    isActive: item.status === "in_progress",
    isStrikethrough,
    evaluatorBadge,
  };
}

function buildDoneSummary(count: number): TodoRow {
  return {
    kind: "summary_done",
    symbol: SYMBOL_COMPLETED,
    symbolColor: "green",
    text: `${count} done`,
    isActive: false,
  };
}

function buildPendingSummary(count: number): TodoRow {
  return {
    kind: "summary_pending",
    symbol: SYMBOL_PENDING,
    symbolColor: "dim",
    text: `+${count} more`,
    isActive: false,
  };
}

/**
 * Pick the most recent failed item that is NOT already in the window.
 * "Most recent" is taken as highest index, since Scout's seed order
 * mirrors `executionObligations` order and later items are completed
 * later. Returns -1 when no out-of-window failed item exists.
 */
function pickFailedToPromote(
  items: readonly TodoItem[],
  inWindow: ReadonlySet<number>,
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.status === "failed" && !inWindow.has(i)) {
      return i;
    }
  }
  return -1;
}

interface WindowDecision {
  readonly visibleIdx: ReadonlyArray<number>;
  readonly hiddenCompletedCount: number;
  readonly hiddenPendingCount: number;
}

/**
 * Compute the indices of items to show in the visible window. Default
 * layout: 1 row before anchor, anchor itself, 2 rows after anchor.
 * Adjust at edges so we always emit up to 4 item rows.
 */
function decideWindow(
  items: readonly TodoItem[],
  anchorIdx: number,
): WindowDecision {
  const total = items.length;
  if (total === 0) {
    return { visibleIdx: [], hiddenCompletedCount: 0, hiddenPendingCount: 0 };
  }
  // Default window — 4 item rows leaves 2 row budget for summary folds.
  const ITEMS_BUDGET = 4;
  let start = Math.max(0, anchorIdx - 1);
  let end = Math.min(total, start + ITEMS_BUDGET); // exclusive
  // Anchor at end of list — pull start back so we still fit ITEMS_BUDGET.
  if (end - start < ITEMS_BUDGET && start > 0) {
    start = Math.max(0, end - ITEMS_BUDGET);
  }
  // Anchor at start — extend forward.
  if (end - start < ITEMS_BUDGET && end < total) {
    end = Math.min(total, start + ITEMS_BUDGET);
  }
  const visibleIdx: number[] = [];
  for (let i = start; i < end; i++) visibleIdx.push(i);
  // Count hidden splits.
  let hiddenCompleted = 0;
  let hiddenPending = 0;
  for (let i = 0; i < start; i++) {
    if (items[i]!.status === "completed") hiddenCompleted++;
  }
  for (let i = end; i < total; i++) {
    const status = items[i]!.status;
    if (status === "pending" || status === "in_progress") hiddenPending++;
  }
  return {
    visibleIdx,
    hiddenCompletedCount: hiddenCompleted,
    hiddenPendingCount: hiddenPending,
  };
}

export function buildTodoPlanViewModel(
  items: readonly TodoItem[],
  opts: BuildTodoPlanOptions,
): TodoPlanViewModel {
  const totalCount = items.length;
  const completedCount = items.reduce(
    (acc, it) => (it.status === "completed" ? acc + 1 : acc),
    0,
  );
  const baseVm = (rows: readonly TodoRow[], render: boolean): TodoPlanViewModel => ({
    shouldRender: render,
    rows,
    completedCount,
    totalCount,
  });

  // Below threshold — surface stays hidden regardless of state.
  if (totalCount < MIN_ITEMS_TO_RENDER) {
    return baseVm([], false);
  }

  // FEATURE_151 (v0.7.38): the post-completion 5-second linger gate that
  // previously hid the surface after `lastAllCompletedAt + 5s` was removed
  // to match Claude Code's persistent visibility (TaskListV2 stays mounted
  // for the whole session via `expandedView==='tasks'`). Items remain
  // visible until the next `replace()` from a new Scout `init()` or an
  // LLM-driven `todo_update op:'init'`. The `opts.now` and
  // `opts.lastAllCompletedAt` parameters are intentionally not consulted
  // here — see the type-doc on `BuildTodoPlanOptions` for the back-compat
  // rationale. The unused-args lint is silenced via the void operator
  // below to keep the parameter shape stable for InkREPL callers.
  void opts.now;
  void opts.lastAllCompletedAt;

  const anchorIdx = pickAnchorIndex(items);
  const window = decideWindow(items, anchorIdx);
  const visibleSet = new Set(window.visibleIdx);

  // Failed-item priority: if the most-recent failed item isn't
  // already in the window, insert it at the back of the window
  // (replacing a pending slot, not the anchor).
  const promotedFailedIdx = pickFailedToPromote(items, visibleSet);
  let visibleIdx: number[] = [...window.visibleIdx];
  let hiddenCompletedCount = window.hiddenCompletedCount;
  let hiddenPendingCount = window.hiddenPendingCount;
  if (promotedFailedIdx >= 0) {
    // Find the last pending slot to swap out — never replace the anchor.
    let swapAt = -1;
    for (let i = visibleIdx.length - 1; i >= 0; i--) {
      const idx = visibleIdx[i]!;
      if (idx === anchorIdx) continue;
      if (items[idx]!.status === "pending") {
        swapAt = i;
        break;
      }
    }
    if (swapAt >= 0) {
      const evicted = visibleIdx[swapAt]!;
      visibleIdx[swapAt] = promotedFailedIdx;
      // Adjust hidden counts: the evicted pending now hides; the
      // promoted failed leaves the hidden side.
      hiddenPendingCount += 1;
      // Re-sort visibleIdx so summary fold logic stays straightforward.
      visibleIdx.sort((a, b) => a - b);
      // Recount hidden completed (might shift if promotedFailedIdx
      // sits earlier than the original window start).
      const earliestVisible = visibleIdx[0]!;
      let recountedCompleted = 0;
      for (let i = 0; i < earliestVisible; i++) {
        if (items[i]!.status === "completed") recountedCompleted++;
      }
      hiddenCompletedCount = recountedCompleted;
      // (Use the variable so the linter does not complain — value is
      // already implicit in `visibleIdx`.)
      void evicted;
    }
  }

  const rows: TodoRow[] = [];
  if (hiddenCompletedCount > 0) {
    rows.push(buildDoneSummary(hiddenCompletedCount));
  }
  for (const idx of visibleIdx) {
    rows.push(buildItemRow(items[idx]!));
  }
  if (hiddenPendingCount > 0) {
    rows.push(buildPendingSummary(hiddenPendingCount));
  }
  // Hard cap. Trim from the back of the item rows (keep folds for context).
  if (rows.length > MAX_VISIBLE_ROWS) {
    // Remove non-anchor item rows from the bottom until we fit.
    while (rows.length > MAX_VISIBLE_ROWS) {
      // Find last "item" row that is not active (the anchor) and pop it.
      let removed = false;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.kind === "item" && !r.isActive) {
          rows.splice(i, 1);
          // Increment the bottom summary count if present, else add one.
          const last = rows[rows.length - 1];
          if (last && last.kind === "summary_pending") {
            // Replace last summary with incremented count.
            const m = /\+(\d+) more/.exec(last.text);
            const n = m ? Number.parseInt(m[1]!, 10) + 1 : 1;
            rows[rows.length - 1] = buildPendingSummary(n);
          } else {
            rows.push(buildPendingSummary(1));
          }
          removed = true;
          break;
        }
      }
      if (!removed) break; // safety
    }
  }
  return baseVm(rows, true);
}

/**
 * Helper for the host component: returns true when every item is in a
 * terminal state. Caller uses this to decide when to start /reset the
 * 5 s linger timer.
 */
export function isPlanFullyClosed(items: readonly TodoItem[]): boolean {
  return allItemsTerminal(items);
}
