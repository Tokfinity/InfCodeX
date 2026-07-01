import type { WorkflowProcessSnapshot } from "@kodax-ai/agent";
import stringWidth from "string-width";

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
  /** Per-running-agent detail for the bounded live tree (name + when it started,
   *  so each agent shows its own elapsed). `id` is the unique per-spawn item id,
   *  used to key the row so a fan-out of same-named agents (e.g. five parallel
   *  'reviewer' agents) does not collide on React keys. When absent (e.g. the
   *  event-driven path) the tree falls back to `activeAgents` names without a
   *  per-agent duration. */
  readonly activeAgentRows?: readonly { readonly name: string; readonly startedAt?: number; readonly id?: string }[];
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

export const WORKFLOW_LIVE_LABEL_WIDTH = 9;

export function padWorkflowLiveSymbol(
  symbol: string,
  width: number = WORKFLOW_LIVE_LABEL_WIDTH,
): string {
  const visibleWidth = stringWidth(symbol);
  if (visibleWidth >= width) {
    return symbol;
  }

  return `${symbol}${" ".repeat(width - visibleWidth)}`;
}

export function workflowLiveSnapshotFromProcess(
  snapshot: WorkflowProcessSnapshot,
  options: {
    readonly locale?: WorkflowLiveLocale;
    readonly message?: string;
  } = {},
): WorkflowLiveSnapshot {
  const agentItems = snapshot.items.filter((item) => item.kind === "agent");
  const runningItems = agentItems.filter((item) => item.status === "running");
  const activeAgents = runningItems.map((item) => item.title);
  const activeAgentRows = runningItems.map((item) => {
    const startedAt = item.startedAt === undefined ? undefined : Date.parse(item.startedAt);
    return startedAt !== undefined && Number.isFinite(startedAt)
      ? { id: item.id, name: item.title, startedAt }
      : { id: item.id, name: item.title };
  });
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
    activeAgentRows,
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

  return viewModel.rows.map((row) => `${padWorkflowLiveSymbol(row.symbol)}${row.text}`);
}

/** Max running-agent rows shown in the live tree before collapsing the rest into
 *  a "+N more running" row. Keeps the surface height bounded even if a future
 *  config raises workflow concurrency (default 8) — the tree can never dominate
 *  the screen. */
const MAX_AGENT_ROWS = 5;

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
    moreRunning: (count: number): string => `+${count} more running`,
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
    moreRunning: (count: number): string => `另有 ${count} 个运行中`,
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
  // Active agents are listed as their own rows in the live tree, so the progress
  // summary no longer repeats the count here — it stays focused on finished work.
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

/**
 * Bounded live tree of the running agents. One row per running agent (name +
 * its own elapsed when known), capped at MAX_AGENT_ROWS with a "+N more running"
 * overflow row so a large fan-out never dominates the surface. Finished agents
 * are not listed — their counts stay in the progress summary row. Falls back to
 * `activeAgents` names when the richer `activeAgentRows` is absent.
 */
function appendActiveAgentRows(
  rows: WorkflowLiveRow[],
  snapshot: WorkflowLiveSnapshot,
  label: WorkflowLiveLabels,
  now: number,
): void {
  const agents: readonly { readonly name: string; readonly startedAt?: number; readonly id?: string }[] =
    snapshot.activeAgentRows ?? snapshot.activeAgents.map((name) => ({ name }));
  if (agents.length === 0) return;
  const shown = agents.slice(0, MAX_AGENT_ROWS);
  shown.forEach((agent, index) => {
    const { startedAt } = agent;
    const elapsed =
      startedAt !== undefined ? ` · ${formatElapsedMs(Math.max(0, now - startedAt), snapshot.locale)}` : "";
    // Key by the unique per-spawn id when available so a fan-out of same-named
    // agents does not collide on React keys; fall back to name+index (unique
    // within a render) on the event-driven path that has no id.
    const rowId = agent.id !== undefined ? `agent:${agent.id}` : `agent:${agent.name}:${index}`;
    rows.push({
      kind: "agent",
      id: rowId,
      symbol: "•",
      symbolColor: "cyan",
      text: `${agent.name}${elapsed}`,
      isActive: true,
    });
  });
  const overflow = agents.length - shown.length;
  if (overflow > 0) {
    rows.push({
      kind: "agent",
      id: "agent:more",
      symbol: "",
      symbolColor: "dim",
      text: label.moreRunning(overflow),
      isActive: false,
    });
  }
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
    // The running agents are listed as their own rows below, so the header no
    // longer carries the "N active agents" count — it stays a clean title line.
    text: `${snapshot.workflow} (${shortRunId(snapshot.runId)})${headerMetricText}`,
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

  appendActiveAgentRows(rows, snapshot, label, now);

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

  // No blanket row cap: the only unbounded row group is the running-agent list,
  // and appendActiveAgentRows already caps that at MAX_AGENT_ROWS + one overflow
  // row. Every other group contributes at most one row, so the surface height
  // stays bounded (header + phase + ≤6 agent rows + progress + waiting + hint).
  const visibleRows = rows;

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
