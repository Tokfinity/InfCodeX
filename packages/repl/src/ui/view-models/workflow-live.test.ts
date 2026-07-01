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

  it("renders phase, one row per running agent, a finished summary, and the hint", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot());

    expect(vm.shouldRender).toBe(true);
    expect(vm.workflow).toBe("feature-217-ui-regression-audit");
    expect(vm.activeCount).toBe(2);
    expect(vm.completedAgents).toBe(1);
    // Header no longer carries the "N active agents" count — the tree lists them.
    expect(vm.rows.map((row) => row.symbol)).toEqual([
      "workflow",
      "phase",
      "•",
      "•",
      "progress",
      "hint",
    ]);
    expect(vm.rows.map((row) => row.text)).toEqual([
      "feature-217-ui-regression-audit (run-mqc7av6y)",
      "2/4 fan-out-ui-audit",
      "layout-and-positioning-auditor",
      "styling-and-visual-auditor",
      "1/3 finished (cap 8)",
      "Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });

  it("surfaces failed agents in the summary and still lists the running agent", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      failedAgents: 1,
      activeAgents: ["remaining-auditor"],
      totalSpawned: 4,
      completedAgents: 2,
    }));

    expect(vm.rows.map((row) => row.text)).toContain("3/4 finished (1 failed, cap 8)");
    // The running agent is now a named row, not folded into a count.
    expect(vm.rows.map((row) => row.text)).toContain("remaining-auditor");
  });

  it("caps running-agent rows at 5 and collapses the rest into a +N more row", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
      completedAgents: 0,
      totalSpawned: 7,
      message: undefined,
    }));
    const agentRows = vm.rows.filter((row) => row.kind === "agent");
    expect(agentRows).toHaveLength(6); // 5 named + 1 overflow
    expect(agentRows.slice(0, 5).map((row) => row.text)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(agentRows.at(-1)?.text).toBe("+2 more running");
  });

  it("shows each running agent's own elapsed when activeAgentRows carries startedAt", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["slow-auditor"],
      activeAgentRows: [{ name: "slow-auditor", startedAt: 1_000 }],
    }), 96_000);
    const agentRow = vm.rows.find((row) => row.kind === "agent");
    expect(agentRow?.text).toBe("slow-auditor · 1m35s");
  });

  it("keys same-named fan-out agents by their unique id so React rows do not collide", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["reviewer", "reviewer"],
      activeAgentRows: [
        { id: "agent:t1", name: "reviewer", startedAt: 1_000 },
        { id: "agent:t2", name: "reviewer", startedAt: 2_000 },
      ],
    }), 5_000);
    const agentRows = vm.rows.filter((row) => row.kind === "agent");
    expect(agentRows.map((row) => row.id)).toEqual(["agent:agent:t1", "agent:agent:t2"]);
    expect(new Set(agentRows.map((row) => row.id)).size).toBe(2); // distinct keys
    expect(agentRows.map((row) => row.text)).toEqual(["reviewer · 4s", "reviewer · 3s"]);
  });

  it("falls back to name+index keys for duplicate names on the id-less event path", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["reviewer", "reviewer"], // no activeAgentRows → fallback path
    }));
    const agentRows = vm.rows.filter((row) => row.kind === "agent");
    expect(agentRows.map((row) => row.id)).toEqual(["agent:reviewer:0", "agent:reviewer:1"]);
    expect(new Set(agentRows.map((row) => row.id)).size).toBe(2);
  });

  it("renders elapsed time and token usage when available", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      startedAt: 1_000,
      elapsedMs: 2_000,
      tokenBudgetSpent: 12_345,
      tokenBudgetTotal: 50_000,
    }), 66_000);

    expect(vm.rows[0]?.text).toBe(
      "feature-217-ui-regression-audit (run-mqc7av6y) · 1m5s · spent 12.3k/50k tokens",
    );
  });

  it("labels an unused workflow token budget as a budget, not context usage", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      startedAt: 1_000,
      tokenBudgetSpent: 0,
      tokenBudgetTotal: 200_000,
    }), 3_000);

    expect(vm.rows[0]?.text).toBe(
      "feature-217-ui-regression-audit (run-mqc7av6y) · 2s · budget 200k tokens",
    );
  });

  it("keeps workflow progress and the show/stop hint visible when many agents are active", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      activeAgents: ["a1", "a2", "a3", "a4", "a5"],
      completedAgents: 0,
      failedAgents: 0,
      message: undefined,
    }));

    // header + phase + 5 agent rows + progress + hint = 9 (no overflow at exactly 5)
    expect(vm.rows).toHaveLength(9);
    expect(vm.rows.map((row) => row.text)).toContain("0/3 finished (cap 8)");
    expect(vm.rows.at(-1)?.text).toBe("show: /workflow show run-mqc7av6y | stop: /workflow stop run-mqc7av6y");
  });

  it("serializes visible workflow rows into stable copy text", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot());

    expect(formatWorkflowLiveViewModelForTranscript(vm)).toEqual([
      "workflow feature-217-ui-regression-audit (run-mqc7av6y)",
      "phase    2/4 fan-out-ui-audit",
      "•        layout-and-positioning-auditor",
      "•        styling-and-visual-auditor",
      "progress 1/3 finished (cap 8)",
      "hint     Use /workflow show run-mqc7av6y for status or /workflow stop run-mqc7av6y to stop.",
    ]);
  });

  it("serializes Chinese workflow labels using terminal display width", () => {
    const vm = buildWorkflowLiveViewModel(runningSnapshot({
      locale: "zh",
      workflow: "探查Feature 217使用者掌控感反馈设计",
      phase: "探查改动",
      phaseIndex: 1,
      phaseTotal: 3,
      activeAgents: ["diff-explorer"],
      totalSpawned: 1,
      plannedAgents: 5,
      agentCap: 11,
      completedAgents: 0,
      message: "agent spawned: diff-explorer",
    }));

    const transcriptRows = formatWorkflowLiveViewModelForTranscript(vm);

    expect(transcriptRows[0]).toContain("工作流   探查Feature 217使用者掌控感反馈设计");
    expect(transcriptRows[1]).toBe("阶段     1/3 探查改动");
    expect(transcriptRows.join("\n")).not.toContain("…");
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
      "•",
      "进度",
      "提示",
    ]);
    expect(vm.rows.map((row) => row.text)).toContain("1/3 验证");
    expect(vm.rows.map((row) => row.text)).toContain("布局审计");
    expect(vm.rows.map((row) => row.text)).toContain("1/2 完成（上限 8）");
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
      "0/7 完成（已启动 1，上限 14）",
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
      "8/9 finished (started 9, cap 14)",
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

  it("derives activeAgentRows (id + parsed startedAt, invalid falls back to name only) from process items", () => {
    const process: WorkflowProcessSnapshot = {
      runId: "run-rows",
      workflowName: "rows-workflow",
      status: "running",
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:01:00.000Z",
      items: [
        {
          id: "agent:a",
          title: "reader",
          kind: "agent",
          status: "running",
          startedAt: "2026-06-15T00:00:30.000Z",
          childAgentId: "a",
        },
        {
          // Running agent with a missing startedAt → row carries id + name, no startedAt.
          id: "agent:b",
          title: "no-clock",
          kind: "agent",
          status: "running",
          childAgentId: "b",
        },
        {
          // Completed agents are not active rows.
          id: "agent:c",
          title: "done",
          kind: "agent",
          status: "completed",
          childAgentId: "c",
        },
      ],
      counts: { pending: 0, running: 2, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      progress: { spawnedAgents: 3, finishedAgents: 1, activeAgents: 2, failedAgents: 0, stoppedAgents: 0 },
    };

    const snap = workflowLiveSnapshotFromProcess(process);
    expect(snap.activeAgentRows).toEqual([
      { id: "agent:a", name: "reader", startedAt: Date.parse("2026-06-15T00:00:30.000Z") },
      { id: "agent:b", name: "no-clock" },
    ]);
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
