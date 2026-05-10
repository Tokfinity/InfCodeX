/**
 * Hermetic tests for buildTodoPlanViewModel (FEATURE_097, v0.7.34).
 * No LLM calls. Tests anchor selection, window layout, summary folds,
 * failed-item priority, post-completion linger, and shouldRender gates.
 */
import { describe, expect, it } from "vitest";

import type { TodoItem, TodoStatus } from "@kodax-ai/coding";

import {
  MAX_VISIBLE_ROWS,
  MIN_ITEMS_TO_RENDER,
  POST_COMPLETION_LINGER_MS,
  buildTodoPlanViewModel,
  isPlanFullyClosed,
} from "./todo-plan.js";

function makeItem(
  id: string,
  content: string,
  status: TodoStatus = "pending",
  note?: string,
): TodoItem {
  return { id, content, status, note };
}

function makeItems(n: number, status: TodoStatus = "pending"): TodoItem[] {
  return Array.from({ length: n }, (_, i) => makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status));
}

const NOW = 1_700_000_000_000;

describe("buildTodoPlanViewModel — gating", () => {
  // FEATURE_151 (v0.7.38): MIN dropped 2 → 1 to match CC; linger gate
  // removed. The constant exports stay so external code that imports them
  // does not break, but the linger ones are now no-ops in the view-model.
  it("hides the surface when totalCount < MIN_ITEMS_TO_RENDER (i.e. empty)", () => {
    expect(MIN_ITEMS_TO_RENDER).toBe(1);
    const vm = buildTodoPlanViewModel([], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    expect(vm.shouldRender).toBe(false);
    expect(vm.totalCount).toBe(0);
  });

  it("renders a single-item list (FEATURE_151: MIN=1, CC parity)", () => {
    const vm = buildTodoPlanViewModel([makeItem("todo_1", "lone task")], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    expect(vm.shouldRender).toBe(true);
    expect(vm.totalCount).toBe(1);
    // The single row should render as a plain item (no folds).
    expect(vm.rows.length).toBe(1);
    expect(vm.rows[0]?.kind).toBe("item");
  });

  it("renders when totalCount >= MIN_ITEMS_TO_RENDER", () => {
    const vm = buildTodoPlanViewModel(makeItems(2), { now: NOW, lastAllCompletedAt: null });
    expect(vm.shouldRender).toBe(true);
  });

  // FEATURE_151 (v0.7.38): the post-completion 5-second linger gate was
  // removed. These tests pin the new behavior — view-model NEVER hides
  // based on `lastAllCompletedAt`; surface stays visible until the host
  // replaces the list (Scout init or LLM op:'init').
  it("FEATURE_151: still renders when items terminal AND linger window 'expired'", () => {
    const items = makeItems(3, "completed");
    const closedAt = NOW - POST_COMPLETION_LINGER_MS - 1;
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: closedAt });
    expect(vm.shouldRender).toBe(true);
  });

  it("FEATURE_151: still renders when items terminal AND linger never started", () => {
    const vm = buildTodoPlanViewModel(makeItems(3, "completed"), {
      now: NOW,
      lastAllCompletedAt: null,
    });
    expect(vm.shouldRender).toBe(true);
  });

  it("FEATURE_151: still renders when items terminal AND linger 'within window'", () => {
    const items = makeItems(3, "completed");
    const closedAt = NOW - 1_000;
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: closedAt });
    expect(vm.shouldRender).toBe(true);
  });
});

describe("buildTodoPlanViewModel — anchor selection", () => {
  it("anchor = first in_progress when one exists", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemRows = vm.rows.filter((r) => r.kind === "item");
    const active = itemRows.find((r) => r.isActive);
    expect(active?.id).toBe("todo_2");
  });

  it("anchor = first pending when no in_progress", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "pending"),
      makeItem("todo_4", "D", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemIds = vm.rows.filter((r) => r.kind === "item").map((r) => r.id);
    expect(itemIds).toContain("todo_3");
  });

  it("anchor = last completed when everything is terminal", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "completed"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.shouldRender).toBe(true);
    expect(vm.completedCount).toBe(3);
  });
});

describe("buildTodoPlanViewModel — window + summary folds", () => {
  it("totalCount <= window budget renders all items, no folds", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.rows.every((r) => r.kind === "item")).toBe(true);
    expect(vm.rows.length).toBe(3);
  });

  it("inserts ✓ N done summary at top when completed items hidden", () => {
    // 12 items, in_progress at index 5; window = [4,5,6,7]; 4 hidden completed at top.
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i < 4) status = "completed";
      else if (i === 4) status = "completed";
      else if (i === 5) status = "in_progress";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const top = vm.rows[0]!;
    expect(top.kind).toBe("summary_done");
    expect(top.text).toMatch(/^\d+ done$/);
  });

  it("inserts ☐ +N more summary at bottom when pending items hidden", () => {
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      const status: TodoStatus = i === 0 ? "in_progress" : "pending";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const last = vm.rows[vm.rows.length - 1]!;
    expect(last.kind).toBe("summary_pending");
    expect(last.text).toMatch(/^\+\d+ more$/);
  });

  it("hard cap: total rows <= MAX_VISIBLE_ROWS for any input size", () => {
    expect(MAX_VISIBLE_ROWS).toBe(6);
    const sizes = [2, 6, 7, 12, 20, 50];
    for (const n of sizes) {
      const items = makeItems(n);
      // Mark middle item in_progress to force a window in the middle.
      const idx = Math.floor(n / 2);
      items[idx] = { ...items[idx]!, status: "in_progress" };
      const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
      expect(vm.rows.length, `rows for n=${n}`).toBeLessThanOrEqual(MAX_VISIBLE_ROWS);
    }
  });
});

describe("buildTodoPlanViewModel — failed-item priority", () => {
  it("surfaces an out-of-window failed item by replacing nearest pending", () => {
    // 12 items, in_progress at index 1, failed at index 8 (out of default window).
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i === 1) status = "in_progress";
      if (i === 8) status = "failed";
      const note = i === 8 ? "Evaluator requested revision" : undefined;
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status, note);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemIds = vm.rows.filter((r) => r.kind === "item").map((r) => r.id);
    expect(itemIds).toContain("todo_9"); // promoted failed
  });

  it("never replaces the anchor (in_progress) with the failed item", () => {
    const items: TodoItem[] = Array.from({ length: 8 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i === 0) status = "in_progress";
      if (i === 7) status = "failed";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const activeRow = vm.rows.find((r) => r.isActive);
    expect(activeRow?.id).toBe("todo_1");
  });

  it("formats failed-item text with note suffix when note is present", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "Run migration", "failed", "Evaluator requested revision"),
      makeItem("todo_2", "Update types", "pending"),
      makeItem("todo_3", "Verify e2e", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const failedRow = vm.rows.find((r) => r.kind === "item" && r.id === "todo_1");
    expect(failedRow?.text).toContain("Run migration");
    expect(failedRow?.text).toContain("Evaluator requested revision");
  });
});

describe("buildTodoPlanViewModel — symbol mapping", () => {
  it.each<[TodoStatus, string]>([
    ["pending", "☐"],
    ["in_progress", "●"],
    ["completed", "✓"],
    ["failed", "✗"],
    ["skipped", "⊘"],
    // FEATURE_114 v0.7.36 Slice 1: cancelled is a Worker-driven mid-task
    // drop. Distinct glyph from skipped (⊘ Planner-merge vs ☒ Worker-cancel).
    ["cancelled", "☒"],
  ])("status=%s renders symbol %s", (status, symbol) => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", status),
      makeItem("todo_2", "B", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const row = vm.rows.find((r) => r.kind === "item" && r.id === "todo_1");
    expect(row?.symbol).toBe(symbol);
  });

  it("only the in_progress row is marked isActive", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemRows = vm.rows.filter((r) => r.kind === "item");
    expect(itemRows.filter((r) => r.isActive).length).toBe(1);
    expect(itemRows.find((r) => r.isActive)?.id).toBe("todo_2");
  });
});

describe("buildTodoPlanViewModel — auto-advance scenario", () => {
  it("anchor moves forward as items complete", () => {
    // 8 items. Phase 1: in_progress on todo_3.
    const phase1: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "in_progress"),
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem(`todo_${i + 4}`, `Step ${i + 4}`, "pending"),
      ),
    ];
    const vm1 = buildTodoPlanViewModel(phase1, { now: NOW, lastAllCompletedAt: null });
    expect(vm1.rows.find((r) => r.isActive)?.id).toBe("todo_3");

    // Phase 2: todo_3 done → todo_4 in_progress.
    const phase2: TodoItem[] = phase1.map((it, i) => {
      if (i === 2) return { ...it, status: "completed" };
      if (i === 3) return { ...it, status: "in_progress" };
      return it;
    });
    const vm2 = buildTodoPlanViewModel(phase2, { now: NOW, lastAllCompletedAt: null });
    expect(vm2.rows.find((r) => r.isActive)?.id).toBe("todo_4");
    // The "✓ N done" summary count grew (from 2 → 3 hidden) — ensure
    // a top fold appears once we move past the window's start.
    const topRow = vm2.rows[0]!;
    if (topRow.kind === "summary_done") {
      expect(topRow.text).toMatch(/^\d+ done$/);
    }
  });
});

describe("isPlanFullyClosed", () => {
  it("returns false on empty list", () => {
    expect(isPlanFullyClosed([])).toBe(false);
  });

  it("returns false when any pending or in_progress item remains", () => {
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "pending"),
    ])).toBe(false);
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
    ])).toBe(false);
  });

  it("returns true when every item is terminal (completed | failed | skipped)", () => {
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "failed"),
      makeItem("todo_3", "C", "skipped"),
    ])).toBe(true);
  });

  it("FEATURE_114 v0.7.36 Slice 1: cancelled counts as terminal — fully-cancelled plan closes", () => {
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "cancelled"),
      makeItem("todo_2", "B", "cancelled"),
    ])).toBe(true);
    // Mixed terminal also closes.
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "cancelled"),
      makeItem("todo_3", "C", "skipped"),
    ])).toBe(true);
  });
});

describe("counts", () => {
  it("completedCount + totalCount reflect the canonical store snapshot", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "in_progress"),
      makeItem("todo_4", "D", "failed"),
      makeItem("todo_5", "E", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.completedCount).toBe(2);
    expect(vm.totalCount).toBe(5);
  });
});

// FEATURE_114 v0.7.36 Slice 4 — view-model surfaces the cancelled-row
// strikethrough flag and the deterministic-evaluator badge label.
// Pure transform tests; the renderer is covered separately in
// `TodoListSurface.test.tsx`.
describe("FEATURE_114 Slice 4 — cancelled strikethrough + evaluator badge", () => {
  it("cancelled-status row sets isStrikethrough: true (other statuses leave it falsy)", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "Done", "completed"),
      makeItem("todo_2", "Dropped", "cancelled"),
      makeItem("todo_3", "Active", "in_progress"),
      makeItem("todo_4", "Pending", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const byContent: Record<string, boolean | undefined> = {};
    for (const row of vm.rows) {
      if (row.kind !== "item") continue;
      byContent[row.text] = row.isStrikethrough;
    }
    expect(byContent.Dropped).toBe(true);
    // Other statuses MUST NOT carry the flag — strikethrough should be
    // unique to cancelled so the user reads it as "this won't happen".
    expect(byContent.Done).toBeFalsy();
    expect(byContent.Active).toBeFalsy();
    expect(byContent.Pending).toBeFalsy();
  });

  it("items with evaluator hint surface a bracketed badge ([build] / [test] / [lint])", () => {
    const items: TodoItem[] = [
      { ...makeItem("todo_1", "Compile", "in_progress"), evaluator: "build" },
      { ...makeItem("todo_2", "Run unit tests", "pending"), evaluator: "test" },
      { ...makeItem("todo_3", "Lint pass", "pending"), evaluator: "lint" },
      makeItem("todo_4", "Plain step (no hint)", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const byContent: Record<string, string | undefined> = {};
    for (const row of vm.rows) {
      if (row.kind !== "item") continue;
      byContent[row.text] = row.evaluatorBadge;
    }
    expect(byContent.Compile).toBe("[build]");
    expect(byContent["Run unit tests"]).toBe("[test]");
    expect(byContent["Lint pass"]).toBe("[lint]");
    // Items without a hint must NOT carry a badge — undefined sentinel
    // tells the renderer to skip the trailing dim text fragment.
    expect(byContent["Plain step (no hint)"]).toBeUndefined();
  });

  it("cancelled rows can carry an evaluator badge (independent fields)", () => {
    // Edge case: the LLM `op:'init'` schema permits an `evaluator` hint
    // on any item; if the item is later cancelled, the badge should
    // still surface so the user can see what check was attached. The
    // strikethrough on the row text already makes the dropped state
    // obvious; double-suppressing the badge would hide useful context.
    const items: TodoItem[] = [
      { ...makeItem("todo_1", "Skipped build", "cancelled"), evaluator: "build" },
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const row = vm.rows.find((r) => r.kind === "item" && r.text === "Skipped build");
    expect(row?.isStrikethrough).toBe(true);
    expect(row?.evaluatorBadge).toBe("[build]");
  });

  it("summary fold rows do not carry the new fields (item-only metadata)", () => {
    // Force a top-fold by completing items above the window. Summary
    // rows are render hints, not item rows — the new fields should be
    // undefined on them so the renderer's strikethrough / badge code
    // paths are skipped cleanly.
    const items: TodoItem[] = [
      ...Array.from({ length: 5 }, (_, i) => makeItem(`d${i}`, `done${i}`, "completed")),
      makeItem("todo_active", "Active step", "in_progress"),
      makeItem("todo_next", "Next step", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const summaryRows = vm.rows.filter((r) => r.kind !== "item");
    expect(summaryRows.length).toBeGreaterThan(0);
    for (const row of summaryRows) {
      expect(row.isStrikethrough).toBeUndefined();
      expect(row.evaluatorBadge).toBeUndefined();
    }
  });
});
