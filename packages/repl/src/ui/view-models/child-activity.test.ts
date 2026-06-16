import { describe, expect, it } from "vitest";

import {
  buildChildActivityViewModel,
  padChildActivitySymbol,
  shouldRouteToChildActivity,
  type ChildActivityRecord,
} from "./child-activity.js";

function record(overrides: Partial<ChildActivityRecord> = {}): ChildActivityRecord {
  return {
    id: "child-1",
    label: "diff-explorer",
    source: "normal",
    status: "running",
    kind: "tool",
    detail: "grep docs/features",
    ...overrides,
  };
}

describe("buildChildActivityViewModel", () => {
  it("hides when no child activity is running", () => {
    expect(buildChildActivityViewModel([]).shouldRender).toBe(false);
    expect(buildChildActivityViewModel([
      record({ status: "completed" }),
    ]).shouldRender).toBe(false);
  });

  it("renders one live row for a single child", () => {
    const vm = buildChildActivityViewModel([
      record({ kind: "thinking", detail: "checking workflow docs" }),
    ]);

    expect(vm.shouldRender).toBe(true);
    expect(vm.activeCount).toBe(1);
    expect(vm.rows).toEqual([
      {
        kind: "activity",
        id: "child-1",
        symbol: "child",
        symbolColor: "cyan",
        text: "diff-explorer - Thinking: checking workflow docs",
        isActive: true,
      },
    ]);
  });

  it("keeps multiple children bounded to three rows", () => {
    const vm = buildChildActivityViewModel([
      record({ id: "child-1", label: "a" }),
      record({ id: "child-2", label: "b" }),
      record({ id: "child-3", label: "c" }),
      record({ id: "child-4", label: "d" }),
    ]);

    expect(vm.rows).toHaveLength(3);
    expect(vm.rows[0]?.text).toBe("4 active child agents");
    expect(vm.rows[1]?.text).toContain("a - Tool");
    expect(vm.rows[2]?.text).toContain("b - Tool");
  });

  it("keeps visible child slots stable when later children stream new updates", () => {
    const vm = buildChildActivityViewModel([
      record({ id: "child-1", label: "a" }),
      record({ id: "child-2", label: "b" }),
      record({ id: "child-3", label: "c", detail: "new streamed update" }),
    ]);

    expect(vm.rows.map((row) => row.id)).toEqual([
      "children-summary",
      "child-1",
      "child-2",
    ]);
  });

  it("collapses to the active-count summary when only one row is available", () => {
    const vm = buildChildActivityViewModel([
      record({ id: "child-1", label: "a" }),
      record({ id: "child-2", label: "b" }),
    ], 1);

    expect(vm.rows).toEqual([
      {
        kind: "summary",
        id: "children-summary",
        symbol: "children",
        symbolColor: "dim",
        text: "2 active child agents",
        isActive: false,
      },
    ]);
  });

  it("routes child-tagged telemetry to the child live surface only", () => {
    expect(shouldRouteToChildActivity(undefined)).toBe(false);
    expect(shouldRouteToChildActivity({ liveOnly: true })).toBe(false);
    expect(shouldRouteToChildActivity({ childAgentId: "diff-explorer" })).toBe(true);
    expect(shouldRouteToChildActivity({
      workflowCorrelation: {
        workflowRunId: "run-1",
        childAgentId: "diff-explorer",
        itemId: "item-1",
      },
    })).toBe(true);
  });

  it("pads labels by display width", () => {
    expect(padChildActivitySymbol("child", 9)).toBe("child    ");
    const cjkLabel = "\u667a\u80fd\u4f53";
    expect(padChildActivitySymbol(cjkLabel, 9)).toBe(`${cjkLabel}   `);
  });
});
