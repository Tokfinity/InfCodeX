export type WorkflowLiveStatus = "running" | "completed" | "failed" | "stopped";

export interface WorkflowLiveSnapshot {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowLiveStatus;
  readonly phase?: string;
  readonly activeAgents: readonly string[];
  readonly totalSpawned: number;
  readonly completedAgents: number;
  readonly failedAgents: number;
  readonly stoppedAgents: number;
  readonly message?: string;
}

export type WorkflowLiveRowKind = "header" | "phase" | "agent" | "summary" | "hint";
export type WorkflowLiveSymbolColor = "cyan" | "green" | "red" | "dim";

export interface WorkflowLiveRow {
  readonly kind: WorkflowLiveRowKind;
  readonly id?: string;
  readonly symbol: string;
  readonly symbolColor: WorkflowLiveSymbolColor;
  readonly text: string;
  readonly isActive: boolean;
}

export interface WorkflowLiveViewModel {
  readonly shouldRender: boolean;
  readonly workflow: string;
  readonly runId: string;
  readonly phase?: string;
  readonly activeCount: number;
  readonly totalSpawned: number;
  readonly completedAgents: number;
  readonly failedAgents: number;
  readonly stoppedAgents: number;
  readonly rows: readonly WorkflowLiveRow[];
}

export function formatWorkflowLiveViewModelForTranscript(
  viewModel: WorkflowLiveViewModel,
): readonly string[] {
  if (!viewModel.shouldRender || viewModel.rows.length === 0) {
    return [];
  }

  return viewModel.rows.map((row) => `${row.symbol.padEnd(9)}${row.text}`);
}

const MAX_VISIBLE_ROWS = 6;
const MAX_ACTIVE_AGENT_ROWS = 3;

const emptyViewModel: WorkflowLiveViewModel = {
  shouldRender: false,
  workflow: "",
  runId: "",
  activeCount: 0,
  totalSpawned: 0,
  completedAgents: 0,
  failedAgents: 0,
  stoppedAgents: 0,
  rows: [],
};

function shortRunId(runId: string): string {
  return runId.length > 14 ? `${runId.slice(0, 14)}...` : runId;
}

export function buildWorkflowLiveViewModel(
  snapshot: WorkflowLiveSnapshot | null | undefined,
): WorkflowLiveViewModel {
  if (!snapshot || snapshot.status !== "running") {
    return emptyViewModel;
  }

  const rows: WorkflowLiveRow[] = [];
  rows.push({
    kind: "header",
    id: "header",
    symbol: "workflow",
    symbolColor: snapshot.failedAgents > 0 ? "red" : "cyan",
    text: `${snapshot.workflow} (${shortRunId(snapshot.runId)}) - ${snapshot.activeAgents.length}/${snapshot.totalSpawned} active`,
    isActive: true,
  });

  if (snapshot.phase) {
    rows.push({
      kind: "phase",
      id: "phase",
      symbol: "phase",
      symbolColor: "cyan",
      text: snapshot.phase,
      isActive: true,
    });
  }

  const visibleAgents = snapshot.activeAgents.slice(0, MAX_ACTIVE_AGENT_ROWS);
  for (const [index, agent] of visibleAgents.entries()) {
    rows.push({
      kind: "agent",
      id: `active-${index}-${agent}`,
      symbol: "agent",
      symbolColor: "cyan",
      text: agent,
      isActive: true,
    });
  }

  const hiddenActive = snapshot.activeAgents.length - visibleAgents.length;
  if (hiddenActive > 0) {
    rows.push({
      kind: "summary",
      id: "more-active",
      symbol: "more",
      symbolColor: "dim",
      text: `${hiddenActive} more active`,
      isActive: false,
    });
  }

  if (snapshot.failedAgents > 0) {
    rows.push({
      kind: "summary",
      id: "failed",
      symbol: "failed",
      symbolColor: "red",
      text: `${snapshot.failedAgents} failed`,
      isActive: false,
    });
  }

  if (snapshot.completedAgents > 0 || snapshot.stoppedAgents > 0) {
    const parts: string[] = [];
    if (snapshot.completedAgents > 0) parts.push(`${snapshot.completedAgents} done`);
    if (snapshot.stoppedAgents > 0) parts.push(`${snapshot.stoppedAgents} stopped`);
    rows.push({
      kind: "summary",
      id: "closed",
      symbol: "done",
      symbolColor: snapshot.stoppedAgents > 0 ? "dim" : "green",
      text: parts.join(", "),
      isActive: false,
    });
  }

  if (snapshot.totalSpawned === 0 && snapshot.activeAgents.length === 0) {
    rows.push({
      kind: "summary",
      id: "waiting",
      symbol: "waiting",
      symbolColor: "dim",
      text: "waiting for first agent",
      isActive: false,
    });
  }

  rows.push({
    kind: "hint",
    id: "controls",
    symbol: "hint",
    symbolColor: "dim",
    text: snapshot.message ?? `show: /workflow show ${snapshot.runId} | stop: /workflow stop ${snapshot.runId}`,
    isActive: false,
  });

  const visibleRows = rows.length > MAX_VISIBLE_ROWS
    ? [...rows.slice(0, MAX_VISIBLE_ROWS - 1), rows[rows.length - 1]!]
    : rows;

  return {
    shouldRender: true,
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    ...(snapshot.phase !== undefined ? { phase: snapshot.phase } : {}),
    activeCount: snapshot.activeAgents.length,
    totalSpawned: snapshot.totalSpawned,
    completedAgents: snapshot.completedAgents,
    failedAgents: snapshot.failedAgents,
    stoppedAgents: snapshot.stoppedAgents,
    rows: visibleRows,
  };
}
