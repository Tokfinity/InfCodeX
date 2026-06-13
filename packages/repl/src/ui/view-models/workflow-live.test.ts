import { describe, expect, it } from "vitest";

import {
  buildWorkflowLiveViewModel,
  formatWorkflowLiveViewModelForTranscript,
  type WorkflowLiveSnapshot,
} from "./workflow-live.js";

function runningSnapshot(
  overrides: Partial<WorkflowLiveSnapshot> = {},
): WorkflowLiveSnapshot {
  return {
    runId: "run-mqc7av6y",
    workflow: "feature-217-ui-regression-audit",
    status: "running",
    phase: "fan-out-ui-audit",
    activeAgents: [
      "layout-and-positioning-auditor",
      "styling-and-visual-auditor",
    ],
    totalSpawned: 3,
    completedAgents: 1,
    failedAgents: 0,
    stoppedAgents: 0,
    message: "Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ...overrides,
  };
}

describe("buildWorkflowLiveViewModel", () => {
  it("hides when no workflow is running", () => {
    expect(buildWorkflowLiveViewModel(null).shouldRender).toBe(false);
    expect(buildWorkflowLiveViewModel(runningSnapshot({ status: "completed" })).shouldRender).toBe(false);
  });

  it("renders phase, active agents, counters, and control hint", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot());

    expect(vm.shouldRender).toBe(true);
    expect(vm.workflow).toBe("feature-217-ui-regression-audit");
    expect(vm.activeCount).toBe(2);
    expect(vm.completedAgents).toBe(1);
    expect(vm.rows.map((row) => row.symbol)).toEqual([
      "workflow",
      "phase",
      "agent",
      "agent",
      "done",
      "hint",
    ]);
    expect(vm.rows.map((row) => row.text)).toEqual([
      "feature-217-ui-regression-audit (run-mqc7av6y) - 2/3 active",
      "fan-out-ui-audit",
      "layout-and-positioning-auditor",
      "styling-and-visual-auditor",
      "1 done",
      "Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });

  it("surfaces failed agents without hiding active work", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      failedAgents: 1,
      activeAgents: ["remaining-auditor"],
      completedAgents: 2,
    }));

    expect(vm.rows.map((row) => row.text)).toContain("1 failed");
    expect(vm.rows.map((row) => row.text)).toContain("remaining-auditor");
    expect(vm.rows.map((row) => row.text)).toContain("2 done");
  });

  it("keeps the show/stop hint visible when many agents are active", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["a1", "a2", "a3", "a4", "a5"],
      completedAgents: 0,
      failedAgents: 0,
      message: undefined,
    }));

    expect(vm.rows).toHaveLength(6);
    expect(vm.rows.at(-1)?.text).toBe("show: /workflow show run-mqc7av6y | stop: /workflow stop run-mqc7av6y");
  });

  it("serializes visible workflow rows into stable copy text", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot());

    expect(formatWorkflowLiveViewModelForTranscript(vm)).toEqual([
      "workflow feature-217-ui-regression-audit (run-mqc7av6y) - 2/3 active",
      "phase    fan-out-ui-audit",
      "agent    layout-and-positioning-auditor",
      "agent    styling-and-visual-auditor",
      "done     1 done",
      "hint     Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });
});
