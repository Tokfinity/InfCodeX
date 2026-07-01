import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  measureWorkflowRunSurfaceRows,
  WorkflowRunSurface,
} from "./WorkflowRunSurface.js";
import { Box } from "../tui.js";
import { buildWorkflowLiveViewModel } from "../view-models/workflow-live.js";

function visibleRowCount(frame: string): number {
  const normalized = frame.replace(/\n$/u, "");
  return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

describe("WorkflowRunSurface", () => {
  it("renders a compact live workflow status block", () => {
    const vm = buildWorkflowLiveViewModel({
      runId: "run-mqc7av6y",
      workflow: "feature-217-ui-regression-audit",
      status: "running",
      phase: "fan-out-ui-audit",
      phaseIndex: 2,
      phaseTotal: 4,
      activeAgents: ["layout-auditor"],
      totalSpawned: 2,
      completedAgents: 1,
      failedAgents: 0,
      stoppedAgents: 0,
      message: "Use /workflow show run-mqc7av6y for status.",
    });

    const { lastFrame } = render(<WorkflowRunSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";

    expect(frame.trimStart().startsWith("workflow")).toBe(true);
    expect(frame).toContain("workflow feature-217-ui-regression-audit");
    expect(frame).toContain("phase    2/4 fan-out-ui-audit");
    // The running agent is now its own bullet row in the bounded tree.
    expect(frame).toContain("layout-auditor");
    expect(frame).toContain("progress 1/2 finished");
    expect(frame).toContain("/workflow show run-mqc7av6y");
  });

  it("does not ellipsize Chinese row labels at normal widths", () => {
    const vm = buildWorkflowLiveViewModel({
      runId: "run-mqgjmy9g",
      workflow: "探查Feature 217使用者掌控感反馈设计",
      status: "running",
      phase: "探查改动",
      phaseIndex: 1,
      phaseTotal: 3,
      activeAgents: ["diff-explorer"],
      totalSpawned: 1,
      plannedAgents: 5,
      agentCap: 11,
      completedAgents: 0,
      failedAgents: 0,
      stoppedAgents: 0,
      message: "agent spawned: diff-explorer",
      locale: "zh",
    });

    const { lastFrame } = render(
      <Box width={120}>
        <WorkflowRunSurface viewModel={vm} />
      </Box>,
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("工作流   探查Feature 217使用者掌控感反馈设计");
    expect(frame).toContain("阶段     1/3 探查改动");
    expect(frame).not.toContain("…");
  });

  it("returns null when hidden", () => {
    const vm = buildWorkflowLiveViewModel(null);
    const { lastFrame } = render(<WorkflowRunSurface viewModel={vm} />);
    expect(lastFrame()).toBe("");
  });

  it("keeps live footer rows single-line at narrow widths", () => {
    const vm = buildWorkflowLiveViewModel({
      runId: "run-mqc7av6y",
      workflow: "feature-217-workflow-footer-layout-regression-audit",
      status: "running",
      phase: "collecting-renderer-budget-and-completion-state-evidence",
      phaseIndex: 2,
      phaseTotal: 5,
      activeAgents: [
        "layout-auditor-with-long-running-workflow-name",
        "footer-budget-cross-checker",
      ],
      totalSpawned: 6,
      plannedAgents: 6,
      completedAgents: 3,
      failedAgents: 0,
      stoppedAgents: 0,
      message: "show: /workflow show run-mqc7av6y | stop: /workflow stop run-mqc7av6y",
    });

    const measuredRows = measureWorkflowRunSurfaceRows(vm);
    const { lastFrame } = render(
      <Box width={38}>
        <WorkflowRunSurface viewModel={vm} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    const renderedRows = visibleRowCount(frame);

    expect(frame).toContain("workflow ");
    expect(frame).toContain("progress ");
    expect(frame).not.toContain("workflo\n");
    expect(measuredRows).toBe(renderedRows);
    expect(measuredRows).toBe(vm.rows.length);
  });
});
