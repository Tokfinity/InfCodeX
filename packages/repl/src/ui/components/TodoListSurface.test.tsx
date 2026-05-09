/**
 * Hermetic Ink render tests for TodoListSurface (FEATURE_097, v0.7.34).
 * No LLM calls. Tests rendering behavior, hide-when-not-renderable,
 * symbol output, and counter formatting.
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

  it("FEATURE_151 (v0.7.38): renders a single-item list (CC TaskListV2 parity)", () => {
    const vm = buildTodoPlanViewModel([makeItem("todo_1", "Lone task")], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Lone task");
    expect(frame).toContain("0/1 completed");
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
    expect(frame).toContain("3/3 completed");
  });

  it("renders the counter line in 'X/Y completed' format", () => {
    const items = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toContain("1/3 completed");
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

  it("renders the gutter prefix (▏) on every row", () => {
    const items = [
      makeItem("todo_1", "A", "in_progress"),
      makeItem("todo_2", "B", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    // Expect the gutter to appear once per row (2 rows here).
    const occurrences = (frame.match(/▏/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
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

  it("counter renders 0/N when no item has completed yet", () => {
    const items = [
      makeItem("todo_1", "A", "in_progress"),
      makeItem("todo_2", "B", "pending"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toContain("0/3 completed");
  });
});
