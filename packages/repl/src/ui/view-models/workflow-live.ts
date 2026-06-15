import type { WorkflowProcessSnapshot } from "@kodax-ai/agent";

export type WorkflowLiveStatus = "running" | "completed" | "failed" | "stopped";
export type WorkflowLiveLocale = "en" | "zh";

export interface WorkflowLiveSnapshot {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowLiveStatus;
  readonly phase?: string;
  readonly phaseIndex?: number;
  readonly phaseTotal?: number;
  readonly startedAt?: number;
  readonly elapsedMs?: number;
  readonly activeAgents: readonly string[];
  readonly totalSpawned: number;
  readonly plannedAgents?: number;
  readonly agentCap?: number;
  readonly tokenBudgetSpent?: number;
  readonly tokenBudgetTotal?: number;
  readonly completedAgents: number;
  readonly failedAgents: number;
  readonly stoppedAgents: number;
  readonly message?: string;
  readonly locale?: WorkflowLiveLocale;
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
  readonly phaseIndex?: number;
  readonly phaseTotal?: number;
  readonly activeCount: number;
  readonly totalSpawned: number;
  readonly plannedAgents?: number;
  readonly completedAgents: number;
  readonly failedAgents: number;
  readonly stoppedAgents: number;
  readonly counterText?: string;
  readonly rows: readonly WorkflowLiveRow[];
}

export function workflowLiveSnapshotFromProcess(
  snapshot: WorkflowProcessSnapshot,
  options: {
    readonly locale?: WorkflowLiveLocale;
    readonly message?: string;
  } = {},
): WorkflowLiveSnapshot {
  const agentItems = snapshot.items.filter((item) => item.kind === "agent");
  const activeAgents = agentItems
    .filter((item) => item.status === "running")
    .map((item) => item.title);
  const completedAgents = agentItems.filter((item) => item.status === "completed").length;
  const failedAgents = agentItems.filter((item) => item.status === "failed").length;
  const stoppedAgents = agentItems.filter((item) => item.status === "cancelled").length;
  const status: WorkflowLiveStatus =
    snapshot.status === "completed"
      ? "completed"
      : snapshot.status === "failed"
        ? "failed"
        : snapshot.status === "cancelled"
          ? "stopped"
          : "running";
  const activePhaseTitle = snapshot.activePhaseId === undefined
    ? undefined
    : snapshot.items.find((item) => item.id === snapshot.activePhaseId)?.title;
  const startedAt = Date.parse(snapshot.startedAt);
  const message = options.message ?? snapshot.latestMessage;
  return {
    runId: snapshot.runId,
    workflow: snapshot.displayName ?? snapshot.workflowName,
    status,
    ...(activePhaseTitle !== undefined ? { phase: activePhaseTitle } : {}),
    ...(snapshot.activePhaseIndex !== undefined ? { phaseIndex: snapshot.activePhaseIndex } : {}),
    ...(snapshot.phaseCount !== undefined ? { phaseTotal: snapshot.phaseCount } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    elapsedMs: snapshot.elapsedMs,
    activeAgents,
    totalSpawned: snapshot.progress.spawnedAgents,
    ...(snapshot.progress.plannedItems !== undefined
      ? { plannedAgents: snapshot.progress.plannedItems }
      : {}),
    ...(snapshot.progress.agentCap !== undefined ? { agentCap: snapshot.progress.agentCap } : {}),
    ...(snapshot.tokens !== undefined ? { tokenBudgetSpent: snapshot.tokens.spent } : {}),
    ...(snapshot.tokens?.total !== undefined ? { tokenBudgetTotal: snapshot.tokens.total } : {}),
    completedAgents,
    failedAgents,
    stoppedAgents,
    ...(message !== undefined ? { message } : {}),
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
  };
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
const MAX_ACTIVE_AGENT_ROWS = 2;

const labels = {
  en: {
    workflow: "workflow",
    phase: "phase",
    agent: "agent",
    more: "more",
    progress: "progress",
    waiting: "waiting",
    hint: "hint",
    finished: "finished",
    failed: "failed",
    stopped: "stopped",
    started: "started",
    cap: "cap",
    budget: "budget",
    spent: "spent",
    waitingForFirstAgent: "waiting for first agent",
    showStopHint: (runId: string): string => `show: /workflow show ${runId} | stop: /workflow stop ${runId}`,
    activeAgents: (count: number): string => `${count} active agent${count === 1 ? "" : "s"}`,
    moreActive: (count: number): string => `${count} more active agent${count === 1 ? "" : "s"}`,
  },
  zh: {
    workflow: "工作流",
    phase: "阶段",
    agent: "智能体",
    more: "更多",
    progress: "进度",
    waiting: "等待",
    hint: "提示",
    finished: "完成",
    failed: "失败",
    stopped: "停止",
    started: "已启动",
    cap: "上限",
    budget: "预算",
    spent: "已用",
    waitingForFirstAgent: "等待第一个智能体启动",
    showStopHint: (runId: string): string => `查看: /workflow show ${runId} | 停止: /workflow stop ${runId}`,
    activeAgents: (count: number): string => `${count} 个智能体运行中`,
    moreActive: (count: number): string => `另有 ${count} 个运行中`,
  },
} as const;

type WorkflowLiveLabels = (typeof labels)[WorkflowLiveLocale];

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

function workflowLiveLabels(locale: WorkflowLiveLocale | undefined): WorkflowLiveLabels {
  return locale === "zh" ? labels.zh : labels.en;
}

function formatElapsedMs(ms: number, locale: WorkflowLiveLocale | undefined): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (locale === "zh") {
    if (hours > 0) return `${hours}小时${String(minutes).padStart(2, "0")}分`;
    if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
    return `${seconds}秒`;
  }
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.floor(tokens));
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(safe);
}

function formatWorkflowTokenUsage(snapshot: WorkflowLiveSnapshot): string | undefined {
  if (snapshot.tokenBudgetSpent === undefined) return undefined;
  const label = workflowLiveLabels(snapshot.locale);
  const spent = formatTokenCount(snapshot.tokenBudgetSpent);
  if (snapshot.tokenBudgetTotal !== undefined && Number.isFinite(snapshot.tokenBudgetTotal)) {
    const total = formatTokenCount(snapshot.tokenBudgetTotal);
    if (snapshot.tokenBudgetSpent <= 0) {
      return `${label.budget} ${total} tokens`;
    }
    return `${label.spent} ${spent}/${total} tokens`;
  }
  if (snapshot.tokenBudgetSpent <= 0) return undefined;
  return `${label.spent} ${spent} tokens`;
}

function formatWorkflowHeaderMetrics(
  snapshot: WorkflowLiveSnapshot,
  now: number,
): readonly string[] {
  const metrics: string[] = [];
  const elapsedMs = snapshot.startedAt === undefined
    ? snapshot.elapsedMs
    : now - snapshot.startedAt;
  if (elapsedMs !== undefined) {
    metrics.push(formatElapsedMs(elapsedMs, snapshot.locale));
  }
  const tokenUsage = formatWorkflowTokenUsage(snapshot);
  if (tokenUsage !== undefined) {
    metrics.push(tokenUsage);
  }
  return metrics;
}

function formatWorkflowProgress(snapshot: WorkflowLiveSnapshot): string | undefined {
  const label = workflowLiveLabels(snapshot.locale);
  const finished = snapshot.completedAgents + snapshot.failedAgents + snapshot.stoppedAgents;
  if (snapshot.totalSpawned === 0 && finished === 0) {
    return undefined;
  }
  const denominator = workflowProgressDenominator(snapshot, finished);

  const details: string[] = [];
  if (snapshot.activeAgents.length > 0) details.push(label.activeAgents(snapshot.activeAgents.length));
  if (snapshot.plannedAgents !== undefined) details.push(`${label.started} ${snapshot.totalSpawned}`);
  if (snapshot.failedAgents > 0) details.push(`${snapshot.failedAgents} ${label.failed}`);
  if (snapshot.stoppedAgents > 0) details.push(`${snapshot.stoppedAgents} ${label.stopped}`);
  if (snapshot.agentCap !== undefined) details.push(`${label.cap} ${snapshot.agentCap}`);

  const suffix = details.length === 0
    ? ""
    : snapshot.locale === "zh"
      ? `（${details.join("，")}）`
      : ` (${details.join(", ")})`;
  return `${finished}/${denominator} ${label.finished}${suffix}`;
}

function formatWorkflowCounter(snapshot: WorkflowLiveSnapshot): string {
  const label = workflowLiveLabels(snapshot.locale);
  if (snapshot.totalSpawned === 0) return label.waiting;
  const active = snapshot.activeAgents.length;
  const denominator = workflowProgressDenominator(snapshot);
  const main = snapshot.locale === "zh"
    ? `${active}/${denominator} 个智能体运行中`
    : `${active}/${denominator} active agent${active === 1 ? "" : "s"}`;
  const details: string[] = [];
  if (snapshot.failedAgents > 0) details.push(`${snapshot.failedAgents} ${label.failed}`);
  if (snapshot.stoppedAgents > 0) details.push(`${snapshot.stoppedAgents} ${label.stopped}`);
  if (details.length === 0) return main;
  return snapshot.locale === "zh"
    ? `${main}，${details.join("，")}`
    : `${main}, ${details.join(", ")}`;
}

function workflowProgressDenominator(snapshot: WorkflowLiveSnapshot, finished?: number): number {
  const actualFinished = finished ?? snapshot.completedAgents + snapshot.failedAgents + snapshot.stoppedAgents;
  return Math.max(snapshot.plannedAgents ?? 0, snapshot.totalSpawned, actualFinished);
}

function formatWorkflowPhase(snapshot: WorkflowLiveSnapshot): string | undefined {
  if (!snapshot.phase) return undefined;
  if (
    snapshot.phaseIndex !== undefined
    && snapshot.phaseTotal !== undefined
    && snapshot.phaseIndex > 0
    && snapshot.phaseTotal > 0
  ) {
    return `${snapshot.phaseIndex}/${snapshot.phaseTotal} ${snapshot.phase}`;
  }
  return snapshot.phase;
}

export function buildWorkflowLiveViewModel(
  snapshot: WorkflowLiveSnapshot | null | undefined,
  now: number = Date.now(),
): WorkflowLiveViewModel {
  if (!snapshot || snapshot.status !== "running") {
    return emptyViewModel;
  }

  const rows: WorkflowLiveRow[] = [];
  const label = workflowLiveLabels(snapshot.locale);
  const headerMetrics = formatWorkflowHeaderMetrics(snapshot, now);
  const headerMetricText = headerMetrics.length === 0 ? "" : ` · ${headerMetrics.join(" · ")}`;
  rows.push({
    kind: "header",
    id: "header",
    symbol: label.workflow,
    symbolColor: snapshot.failedAgents > 0 ? "red" : "cyan",
    text: `${snapshot.workflow} (${shortRunId(snapshot.runId)}) - ${label.activeAgents(snapshot.activeAgents.length)}${headerMetricText}`,
    isActive: true,
  });

  const phase = formatWorkflowPhase(snapshot);
  if (phase) {
    rows.push({
      kind: "phase",
      id: "phase",
      symbol: label.phase,
      symbolColor: "cyan",
      text: phase,
      isActive: true,
    });
  }

  const maxAgentRows = snapshot.activeAgents.length > MAX_ACTIVE_AGENT_ROWS
    ? 1
    : MAX_ACTIVE_AGENT_ROWS;
  const visibleAgents = snapshot.activeAgents.slice(0, maxAgentRows);
  for (const [index, agent] of visibleAgents.entries()) {
    rows.push({
      kind: "agent",
      id: `active-${index}-${agent}`,
      symbol: label.agent,
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
      symbol: label.more,
      symbolColor: "dim",
      text: label.moreActive(hiddenActive),
      isActive: false,
    });
  }

  const progress = formatWorkflowProgress(snapshot);
  if (progress) {
    rows.push({
      kind: "summary",
      id: "progress",
      symbol: label.progress,
      symbolColor: snapshot.failedAgents > 0 ? "red" : "green",
      text: progress,
      isActive: false,
    });
  }

  if (snapshot.totalSpawned === 0 && snapshot.activeAgents.length === 0) {
    rows.push({
      kind: "summary",
      id: "waiting",
      symbol: label.waiting,
      symbolColor: "dim",
      text: label.waitingForFirstAgent,
      isActive: false,
    });
  }

  rows.push({
    kind: "hint",
    id: "controls",
    symbol: label.hint,
    symbolColor: "dim",
    text: snapshot.message ?? label.showStopHint(snapshot.runId),
    isActive: false,
  });

  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS);

  return {
    shouldRender: true,
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    ...(snapshot.phase !== undefined ? { phase: snapshot.phase } : {}),
    ...(snapshot.phaseIndex !== undefined ? { phaseIndex: snapshot.phaseIndex } : {}),
    ...(snapshot.phaseTotal !== undefined ? { phaseTotal: snapshot.phaseTotal } : {}),
    activeCount: snapshot.activeAgents.length,
    totalSpawned: snapshot.totalSpawned,
    ...(snapshot.plannedAgents !== undefined ? { plannedAgents: snapshot.plannedAgents } : {}),
    completedAgents: snapshot.completedAgents,
    failedAgents: snapshot.failedAgents,
    stoppedAgents: snapshot.stoppedAgents,
    counterText: formatWorkflowCounter(snapshot),
    rows: visibleRows,
  };
}
