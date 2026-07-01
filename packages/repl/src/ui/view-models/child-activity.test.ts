import { describe, expect, it } from "vitest";

import {
  buildChildActivityViewModel,
  formatChildActivityElapsed,
  padChildActivitySymbol,
  shouldRouteToChildActivity,
  shouldRouteWorkflowLiveOnlyNotice,
  shouldShowChildActivitySurface,
  suppressesChurnOverToolAction,
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
    expect(vm.rows[0]?.text).toContain("a - Tool");
    expect(vm.rows[1]?.text).toContain("b - Tool");
    expect(vm.rows[2]?.text).toBe("2 more active");
  });

  it("keeps visible child slots stable when later children stream new updates", () => {
    const vm = buildChildActivityViewModel([
      record({ id: "child-1", label: "a" }),
      record({ id: "child-2", label: "b" }),
      record({ id: "child-3", label: "c", detail: "new streamed update" }),
    ]);

    expect(vm.rows.map((row) => row.id)).toEqual([
      "child-1",
      "child-2",
      "child-3",
    ]);
  });

  it("shows one live child row when only one row is available", () => {
    const vm = buildChildActivityViewModel([
      record({ id: "child-1", label: "a" }),
      record({ id: "child-2", label: "b" }),
    ], 1);

    expect(vm.rows).toEqual([
      {
        kind: "activity",
        id: "child-1",
        symbol: "child",
        symbolColor: "cyan",
        text: "a - Tool: grep docs/features",
        isActive: true,
      },
    ]);
  });

  it("shows each child's own elapsed after the name when startedAt is set (①)", () => {
    const vm = buildChildActivityViewModel(
      [record({ kind: "tool", detail: "Grep _truncated", startedAt: 1_000 })],
      3,
      81_000,
    );
    expect(vm.rows[0]?.text).toBe("diff-explorer · 1m20s - Tool: Grep _truncated");
  });

  it("omits elapsed when a record has no startedAt (back-compat)", () => {
    const vm = buildChildActivityViewModel([record({ kind: "thinking", detail: "x" })], 3, 99_000);
    expect(vm.rows[0]?.text).toBe("diff-explorer - Thinking: x");
  });

  it("formats elapsed compactly", () => {
    expect(formatChildActivityElapsed(0)).toBe("0s");
    expect(formatChildActivityElapsed(51_000)).toBe("51s");
    expect(formatChildActivityElapsed(80_000)).toBe("1m20s");
    expect(formatChildActivityElapsed(3_661_000)).toBe("1h01m");
  });

  it("tool-action priority: churny updates do not overwrite a live tool action (②)", () => {
    // A thinking/assistant/stream update on a child already showing a tool action
    // is dropped (keeps the stable tool row); a new tool update replaces it.
    expect(suppressesChurnOverToolAction("tool", "thinking")).toBe(true);
    expect(suppressesChurnOverToolAction("tool", "assistant")).toBe(true);
    expect(suppressesChurnOverToolAction("tool", "stream")).toBe(true);
    expect(suppressesChurnOverToolAction("tool", "tool")).toBe(false); // next tool wins
    expect(suppressesChurnOverToolAction("tool", "progress")).toBe(false); // progress is meaningful
    // Before the first tool, thinking shows normally.
    expect(suppressesChurnOverToolAction("thinking", "thinking")).toBe(false);
    expect(suppressesChurnOverToolAction(undefined, "thinking")).toBe(false);
  });

  it("routes child-tagged telemetry to the child live surface only", () => {
    expect(shouldRouteToChildActivity(undefined)).toBe(false);
    expect(shouldRouteToChildActivity({ liveOnly: true })).toBe(false);
    expect(shouldRouteToChildActivity({ childAgentId: "diff-explorer" })).toBe(false);
    expect(shouldRouteToChildActivity({ liveOnly: true, childAgentId: "diff-explorer" })).toBe(true);
    expect(shouldRouteToChildActivity({
      liveOnly: true,
      workflowCorrelation: {
        workflowRunId: "run-1",
        childAgentId: "diff-explorer",
        itemId: "item-1",
      },
    })).toBe(true);
    expect(shouldRouteToChildActivity({
      workflowCorrelation: {
        workflowRunId: "run-1",
        childAgentId: "diff-explorer",
        itemId: "item-1",
      },
    })).toBe(false);
  });

  it("identifies workflow live-only notices for stable workflow footer updates", () => {
    const meta = {
      liveOnly: true,
      workflowCorrelation: {
        workflowRunId: "run-1",
        childAgentId: "diff-explorer",
        itemId: "item-1",
      },
    };

    expect(shouldRouteWorkflowLiveOnlyNotice(meta, "run-1")).toBe(true);
    expect(shouldRouteWorkflowLiveOnlyNotice(meta, "run-2")).toBe(false);
    expect(shouldRouteWorkflowLiveOnlyNotice({ ...meta, liveOnly: false }, "run-1")).toBe(false);
    expect(shouldRouteWorkflowLiveOnlyNotice({ childAgentId: "diff-explorer" }, "run-1")).toBe(false);
  });

  it("shows child activity while loading or while a workflow live surface is active", () => {
    expect(shouldShowChildActivitySurface({
      isTranscriptMode: false,
      isLoading: true,
      hasWorkflowLiveSurface: false,
      childActivityVisible: true,
    })).toBe(true);
    expect(shouldShowChildActivitySurface({
      isTranscriptMode: true,
      isLoading: true,
      hasWorkflowLiveSurface: true,
      childActivityVisible: true,
    })).toBe(false);
    expect(shouldShowChildActivitySurface({
      isTranscriptMode: false,
      isLoading: false,
      hasWorkflowLiveSurface: false,
      childActivityVisible: true,
    })).toBe(false);
    expect(shouldShowChildActivitySurface({
      isTranscriptMode: false,
      isLoading: false,
      hasWorkflowLiveSurface: true,
      childActivityVisible: true,
    })).toBe(true);
  });

  it("pads labels by display width", () => {
    expect(padChildActivitySymbol("child", 9)).toBe("child    ");
    const cjkLabel = "\u667a\u80fd\u4f53";
    expect(padChildActivitySymbol(cjkLabel, 9)).toBe(`${cjkLabel}   `);
  });
});
