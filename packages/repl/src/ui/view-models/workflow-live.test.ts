import { describe, expect, it } from "vitest";

import {
  buildWorkflowLiveViewModel,
  formatWorkflowLiveViewModelForTranscript,
  workflowLiveSnapshotFromProcess,
  type WorkflowLiveSnapshot,
} from "./workflow-live.js";
import type { WorkflowProcessSnapshot } from "@kodax-ai/agent";

function runningSnapshot(
  overrides: Partial<WorkflowLiveSnapshot> = {},
): WorkflowLiveSnapshot {
  return {
    runId: "run-mqc7av6y",
    workflow: "feature-217-ui-regression-audit",
    status: "running",
    phase: "fan-out-ui-audit",
    phaseIndex: 2,
    phaseTotal: 4,
    activeAgents: [
      "layout-and-positioning-auditor",
      "styling-and-visual-auditor",
    ],
    totalSpawned: 3,
    agentCap: 8,
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
      "progress",
      "hint",
    ]);
    expect(vm.rows.map((row) => row.text)).toEqual([
      "feature-217-ui-regression-audit (run-mqc7av6y) - 2 active agents",
      "2/4 fan-out-ui-audit",
      "layout-and-positioning-auditor",
      "styling-and-visual-auditor",
      "1/3 finished (2 active agents, cap 8)",
      "Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });

  it("surfaces failed agents without hiding active work", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      failedAgents: 1,
      activeAgents: ["remaining-auditor"],
      totalSpawned: 4,
      completedAgents: 2,
    }));

    expect(vm.rows.map((row) => row.text)).toContain("3/4 finished (1 active agent, 1 failed, cap 8)");
    expect(vm.rows.map((row) => row.text)).toContain("remaining-auditor");
  });

  it("renders elapsed time and token usage when available", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      startedAt: 1_000,
      elapsedMs: 2_000,
      tokenBudgetSpent: 12_345,
      tokenBudgetTotal: 50_000,
    }), 66_000);

    expect(vm.rows[0]?.text).toBe(
      "feature-217-ui-regression-audit (run-mqc7av6y) - 2 active agents · 1m5s · spent 12.3k/50k tokens",
    );
  });

  it("labels an unused workflow token budget as a budget, not context usage", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      startedAt: 1_000,
      tokenBudgetSpent: 0,
      tokenBudgetTotal: 200_000,
    }), 3_000);

    expect(vm.rows[0]?.text).toBe(
      "feature-217-ui-regression-audit (run-mqc7av6y) - 2 active agents · 2s · budget 200k tokens",
    );
  });

  it("keeps progress and the show/stop hint visible when many agents are active", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["a1", "a2", "a3", "a4", "a5"],
      completedAgents: 0,
      failedAgents: 0,
      message: undefined,
    }));

    expect(vm.rows).toHaveLength(6);
    expect(vm.rows.map((row) => row.text)).toContain("4 more active agents");
    expect(vm.rows.map((row) => row.text)).toContain("0/3 finished (5 active agents, cap 8)");
    expect(vm.rows.at(-1)?.text).toBe("show: /workflow show run-mqc7av6y | stop: /workflow stop run-mqc7av6y");
  });

  it("serializes visible workflow rows into stable copy text", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot());

    expect(formatWorkflowLiveViewModelForTranscript(vm)).toEqual([
      "workflow feature-217-ui-regression-audit (run-mqc7av6y) - 2 active agents",
      "phase    2/4 fan-out-ui-audit",
      "agent    layout-and-positioning-auditor",
      "agent    styling-and-visual-auditor",
      "progress 1/3 finished (2 active agents, cap 8)",
      "hint     Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });

  it("localizes labels and progress text for Chinese workflow requests", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      locale: "zh",
      phase: "验证",
      phaseIndex: 1,
      phaseTotal: 3,
      activeAgents: ["布局审计"],
      totalSpawned: 2,
      completedAgents: 1,
      message: undefined,
    }));

    expect(vm.rows.map((row) => row.symbol)).toEqual([
      "工作流",
      "阶段",
      "智能体",
      "进度",
      "提示",
    ]);
    expect(vm.rows.map((row) => row.text)).toContain("1/3 验证");
    expect(vm.rows.map((row) => row.text)).toContain("1/2 完成（1 个智能体运行中，上限 8）");
    expect(vm.rows.at(-1)?.text).toBe("查看: /workflow show run-mqc7av6y | 停止: /workflow stop run-mqc7av6y");
    expect(vm.counterText).toBe("1/2 个智能体运行中");
  });

  it("uses planned agent count for user-facing progress when declared", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      locale: "zh",
      activeAgents: ["feature-217-diff-explorer"],
      totalSpawned: 1,
      plannedAgents: 7,
      agentCap: 14,
      completedAgents: 0,
      message: undefined,
    }));

    expect(vm.rows.map((row) => row.text)).toContain(
      "0/7 完成（1 个智能体运行中，已启动 1，上限 14）",
    );
    expect(vm.counterText).toBe("1/7 个智能体运行中");
  });

  it("keeps the progress denominator at least as large as actual spawned agents", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["extra-reviewer"],
      totalSpawned: 9,
      plannedAgents: 7,
      agentCap: 14,
      completedAgents: 8,
      failedAgents: 0,
      stoppedAgents: 0,
      message: undefined,
    }));

    expect(vm.rows.map((row) => row.text)).toContain(
      "8/9 finished (1 active agent, started 9, cap 14)",
    );
    expect(vm.counterText).toBe("1/9 active agent");
  });

  it("adapts workflow process snapshots into the existing live surface model", () => {
    const process: WorkflowProcessSnapshot = {
      runId: "run-process",
      workflowName: "process-workflow",
      displayName: "Process Workflow",
      status: "running",
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:01:00.000Z",
      elapsedMs: 60_000,
      activePhaseId: "phase:scan",
      activePhaseIndex: 1,
      phaseCount: 2,
      items: [
        {
          id: "phase:scan",
          title: "scan",
          kind: "phase",
          status: "running",
        },
        {
          id: "agent:a",
          title: "reader",
          kind: "agent",
          status: "running",
          childAgentId: "a",
        },
        {
          id: "agent:b",
          title: "auditor",
          kind: "agent",
          status: "completed",
          childAgentId: "b",
        },
        {
          id: "agent:c",
          title: "critic",
          kind: "agent",
          status: "failed",
          childAgentId: "c",
        },
      ],
      counts: {
        pending: 0,
        running: 2,
        completed: 1,
        failed: 1,
        cancelled: 0,
        skipped: 0,
      },
      progress: {
        spawnedAgents: 3,
        finishedAgents: 2,
        activeAgents: 1,
        failedAgents: 1,
        stoppedAgents: 0,
        plannedItems: 5,
        agentCap: 8,
      },
      tokens: { spent: 123, total: 1_000 },
      latestMessage: "agent failed: critic",
    };

    expect(workflowLiveSnapshotFromProcess(process, { locale: "en" })).toMatchObject({
      runId: "run-process",
      workflow: "Process Workflow",
      status: "running",
      phase: "scan",
      phaseIndex: 1,
      phaseTotal: 2,
      activeAgents: ["reader"],
      totalSpawned: 3,
      plannedAgents: 5,
      agentCap: 8,
      tokenBudgetSpent: 123,
      tokenBudgetTotal: 1_000,
      completedAgents: 1,
      failedAgents: 1,
      stoppedAgents: 0,
      message: "agent failed: critic",
      locale: "en",
    });
  });

  it("maps process cancellation to the user-facing stopped live status", () => {
    const process: WorkflowProcessSnapshot = {
      runId: "run-stopped",
      workflowName: "stop-workflow",
      status: "cancelled",
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:01.000Z",
      elapsedMs: 1_000,
      items: [
        {
          id: "agent:a",
          title: "worker",
          kind: "agent",
          status: "cancelled",
          childAgentId: "a",
        },
      ],
      counts: {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 1,
        skipped: 0,
      },
      progress: {
        spawnedAgents: 1,
        finishedAgents: 1,
        activeAgents: 0,
        failedAgents: 0,
        stoppedAgents: 1,
      },
    };

    expect(workflowLiveSnapshotFromProcess(process).status).toBe("stopped");
    expect(workflowLiveSnapshotFromProcess(process).stoppedAgents).toBe(1);
  });
});
