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
    // Counter rendering moved to InkREPL.tsx's activityBar slot so the
    // spinner verb and counter share one line. This component renders
    // ONLY the ⎿ block + rows.
    const items = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/\d+\/\d+ completed/);
  });

  it("renders item rows with the right symbols", () => {
    const items = [
      makeItem("todo_1", "Locate test fixtures", "completed"),
      makeItem("todo_2", "Run migration tests", "in_progress"),
      makeItem("todo_3", "Update type definitions", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓"); // completed
    expect(frame).toContain("●"); // in_progress
    expect(frame).toContain("☐"); // pending
    expect(frame).toContain("Locate test fixtures");
    expect(frame).toContain("Run migration tests");
    expect(frame).toContain("Update type definitions");
  });

  it("Slice H (v0.7.38): renders ⎿ connector exactly once, positioned BEFORE the first row content", () => {
    // Pre-Slice H the gutter was per-row `▏` (vertical bar), which
    // looked like a small panel's left border. Slice H replaces it with
    // CC `MessageResponse`'s once-only `⎿` connector — flex-row layout
    // means subsequent rows in the right column align under the first
    // row's content position with no extra glyph.
    const items = [
      makeItem("todo_1", "FirstRowContent", "in_progress"),
      makeItem("todo_2", "B", "pending"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    const elbows = (frame.match(/⎿/g) ?? []).length;
    expect(elbows).toBe(1);
    // The old per-row `▏` gutter must NOT appear anywhere — Slice H
    // explicitly removed it to drop the "panel border" feel.
    expect(frame).not.toContain("▏");
    // Positional pin: `⎿` must appear BEFORE the first row content
    // (not after, which would mean the flex-row wrapper got reversed).
    const elbowIdx = frame.indexOf("⎿");
    const firstRowContentIdx = frame.indexOf("FirstRowContent");
    expect(elbowIdx).toBeGreaterThanOrEqual(0);
    expect(firstRowContentIdx).toBeGreaterThan(elbowIdx);
  });

  it("shows the failed-note suffix in failed-row text", () => {
    const items = [
      makeItem("todo_1", "Run migration", "failed", "Evaluator requested revision"),
      makeItem("todo_2", "Update types", "pending"),
      makeItem("todo_3", "Verify e2e", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("Run migration");
    expect(frame).toContain("Evaluator requested revision");
  });

  it("renders summary fold rows when the list is long", () => {
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoItem["status"] = "pending";
      if (i < 4) status = "completed";
      if (i === 5) status = "in_progress";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
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
});
