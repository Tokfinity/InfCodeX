import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { WorkflowRunSurface } from "./WorkflowRunSurface.js";
import { buildWorkflowLiveViewModel } from "../view-models/workflow-live.js";

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
    expect(frame).toContain("agent    layout-auditor");
    expect(frame).toContain("progress 1/2 finished (1 active agent)");
    expect(frame).toContain("/workflow show run-mqc7av6y");
  });

  it("returns null when hidden", () => {
    const vm = buildWorkflowLiveViewModel(null);
    const { lastFrame } = render(<WorkflowRunSurface viewModel={vm} />);
    expect(lastFrame()).toBe("");
  });
});
