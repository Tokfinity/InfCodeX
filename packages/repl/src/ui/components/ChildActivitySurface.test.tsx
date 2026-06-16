import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  ChildActivitySurface,
  measureChildActivitySurfaceRows,
} from "./ChildActivitySurface.js";
import { Box } from "../tui.js";
import { buildChildActivityViewModel } from "../view-models/child-activity.js";

function visibleRowCount(frame: string): number {
  const normalized = frame.replace(/\n$/u, "");
  return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

describe("ChildActivitySurface", () => {
  it("renders bounded child activity rows", () => {
    const vm = buildChildActivityViewModel([
      {
        id: "child-1",
        label: "diff-explorer",
        source: "normal",
        status: "running",
        kind: "progress",
        detail: "grep docs/features",
      },
    ]);

    const { lastFrame } = render(<ChildActivitySurface viewModel={vm} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("child");
    expect(frame).toContain("diff-explorer - Progress: grep docs/features");
    expect(measureChildActivitySurfaceRows(vm)).toBe(1);
  });

  it("keeps measured rows equal to rendered rows at narrow widths", () => {
    const vm = buildChildActivityViewModel([
      {
        id: "child-1",
        label: "layout-auditor-with-long-name",
        source: "workflow",
        status: "running",
        kind: "tool",
        detail: "very long command that must truncate inside one row",
      },
      {
        id: "child-2",
        label: "ui-auditor",
        source: "workflow",
        status: "running",
        kind: "thinking",
        detail: "checking live panel",
      },
    ]);

    const { lastFrame } = render(
      <Box width={36}>
        <ChildActivitySurface viewModel={vm} />
      </Box>,
    );
    const frame = lastFrame() ?? "";

    expect(measureChildActivitySurfaceRows(vm)).toBe(visibleRowCount(frame));
    expect(measureChildActivitySurfaceRows(vm)).toBe(3);
  });
});
