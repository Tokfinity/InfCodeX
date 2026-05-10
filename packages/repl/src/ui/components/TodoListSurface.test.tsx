/**
 * Hermetic Ink render tests for TodoListSurface (FEATURE_097, v0.7.34;
 * embedded-spinner layout since FEATURE_151 v0.7.38 Slice H').
 * No LLM calls. Tests rendering behavior, hide-when-not-renderable,
 * symbol output, and the CC-style `⎿` connector that appears once on
 * the first row to signal "embedded under spinner".
 *
 * Slice H' (2026-05-09): the `"X/N completed"` counter moved out of
 * this component into `InkREPL.tsx`'s activityBar slot (rendered
 * right-aligned on the spinner row). These tests no longer assert on
 * counter content — that's the activityBar caller's responsibility.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { TodoItem } from "@kodax-ai/coding";

import { TodoListSurface } from "./TodoListSurface.js";
import {
  buildTodoPlanViewModel,
  POST_COMPLETION_LINGER_MS,
} from "../view-models/todo-plan.js";

function makeItem(
  id: string,
  content: string,
  status: TodoItem["status"] = "pending",
  note?: string,
): TodoItem {
  return { id, content, status, note };
}

const NOW = 1_700_000_000_000;

describe("TodoListSurface", () => {
  it("returns null when viewModel.shouldRender is false (empty store)", () => {
    // FEATURE_151 (v0.7.38): MIN dropped to 1, so the only "below threshold"
    // case is now an EMPTY store. A single item renders (see next test).
    const vm = buildTodoPlanViewModel([], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toBe("");
  });

  it("FEATURE_151 (v0.7.38) Slice A: renders a single-item list (MIN=1, CC TaskListV2 parity)", () => {
    // Slice A dropped MIN_ITEMS from 2 to 1 so even a single-item plan
    // mounts the surface (matching CC's `TaskListV2` no-floor behavior).
    const vm = buildTodoPlanViewModel([makeItem("todo_1", "Lone task")], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Lone task");
  });

  it("FEATURE_151 (v0.7.38): keeps rendering after the (formerly 5s) linger elapses", () => {
    // Pre-FEATURE_151 the surface auto-hid 5s after every item went terminal.
    // Post-FEATURE_151 the surface stays visible until the next `replace()`
    // event from a new Scout init or LLM op:'init', matching CC's
    // `expandedView==='tasks'` persistence semantics.
    const items = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "completed"),
    ];
    const vm = buildTodoPlanViewModel(items, {
      now: NOW,
      lastAllCompletedAt: NOW - POST_COMPLETION_LINGER_MS - 1,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toBe("");
    expect(frame).toContain("✓");
  });

  it("Slice H' (v0.7.38): counter is NOT rendered by this component (lives in activityBar)", () => {
    // Slice H' moved "X/N completed" out of TodoListSurface and onto
    // the spinner row in InkREPL.tsx. This test guards against a
    // regression where the counter accidentally gets re-introduced
    // into this component (would cause a double-render).
    const items = [
      makeItem("todo_1", "First", "in_progress"),
      makeItem("todo_2", "Second", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    // The counter ("0/2 completed", "X/Y completed") format MUST NOT
    // appear in this component's output.
    expect(frame).not.toMatch(/\d+\/\d+\s+completed/);
  });

  it("renders item rows under the embedded-prefix connector ⎿", () => {
    // The `⎿` glyph is the once-only left-column connector from
    // Claude Code's MessageResponse pattern (Slice H final layout).
    const items = [
      makeItem("todo_1", "First", "in_progress"),
      makeItem("todo_2", "Second", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⎿");
    // First row: ● (in_progress symbol) + content.
    expect(frame).toContain("First");
    // Second row: ☐ (pending symbol) + content.
    expect(frame).toContain("Second");
  });

  it("renders summary fold rows when the window omits items", () => {
    // 8 items with most completed → top fold should appear.
    const items = [
      makeItem("d1", "done1", "completed"),
      makeItem("d2", "done2", "completed"),
      makeItem("d3", "done3", "completed"),
      makeItem("d4", "done4", "completed"),
      makeItem("active", "Active step", "in_progress"),
      makeItem("p1", "pending1", "pending"),
      makeItem("p2", "pending2", "pending"),
      makeItem("p3", "pending3", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    // Top fold present.
    expect(frame).toMatch(/\d+ done/);
    // Bottom fold present.
    expect(frame).toMatch(/\+\d+ more/);
  });

  it("active row text matches the in_progress item content", () => {
    const items = [
      makeItem("todo_1", "First", "completed"),
      makeItem("todo_2", "Second", "in_progress"),
      makeItem("todo_3", "Third", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Second");
  });

  // FEATURE_114 v0.7.36 Slice 4 — cancelled strikethrough + evaluator
  // badge.
  //
  // Note on strikethrough verification: ink-testing-library's
  // `lastFrame()` strips ANSI escapes (verified empirically), so we
  // can't assert on the raw chalk SGR sequence directly. The
  // strikethrough wiring is verified at two layers instead:
  //   - View-model: `todo-plan.test.ts` asserts the row's
  //     `isStrikethrough: true` flag for cancelled rows.
  //   - Component: this file asserts both the cancelled symbol AND
  //     the row content text are present, so a regression that
  //     mis-routed or dropped the `<Text strikethrough>` element
  //     would surface as a missing-content failure.
  // Ink's own contract covers the chalk emission; that belongs to
  // its test suite, not ours.
  describe("FEATURE_114 Slice 4 — cancelled strikethrough + evaluator badge rendering", () => {
    it("cancelled-status row renders symbol + text content together (strikethrough wiring intact)", () => {
      const items: TodoItem[] = [
        makeItem("todo_1", "Active step", "in_progress"),
        makeItem("todo_2", "Dropped step", "cancelled"),
      ];
      const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
      const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
      const frame = lastFrame() ?? "";
      // Active row renders normally.
      expect(frame).toContain("Active step");
      // Cancelled row keeps both the ☒ symbol and the content text.
      // A regression that swapped the renderer for a
      // strikethrough-strip variant (early Slice 4 implementation
      // bug, real example) drops the content here and fails.
      expect(frame).toContain("☒");
      expect(frame).toContain("Dropped step");
    });

    it("renders the evaluator badge after the row text when item.evaluator is set", () => {
      const items: TodoItem[] = [
        { ...makeItem("todo_1", "Compile", "in_progress"), evaluator: "build" },
        makeItem("todo_2", "Plain step (no hint)", "pending"),
      ];
      const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
      const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
      const frame = lastFrame() ?? "";
      // Badge text is `[build]`; assert it appears AFTER the matching
      // row's content so the visual order is content-then-badge.
      const compileIdx = frame.indexOf("Compile");
      const buildBadgeIdx = frame.indexOf("[build]");
      expect(compileIdx).toBeGreaterThan(-1);
      expect(buildBadgeIdx).toBeGreaterThan(compileIdx);
      // Plain step has no hint, so no `[build]` badge attaches to it.
      // The single occurrence proves the badge is selectively
      // rendered (would fail if every row got the badge).
      const buildOccurrences = frame.split("[build]").length - 1;
      expect(buildOccurrences).toBe(1);
    });

    it("does NOT render any badge when no item carries an evaluator hint", () => {
      const items: TodoItem[] = [
        makeItem("todo_1", "First", "in_progress"),
        makeItem("todo_2", "Second", "pending"),
      ];
      const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
      const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
      const frame = lastFrame() ?? "";
      // No bracket-bracket badge formatting should appear at all.
      expect(frame).not.toMatch(/\[(?:build|test|lint)\]/);
    });
  });
});
