import stringWidth from "string-width";
import type { KodaXActivityEventMeta } from "@kodax-ai/coding";

export type ChildActivitySource = "workflow" | "normal";
export type ChildActivityStatus = "running" | "completed";
export type ChildActivityKind =
  | "assistant"
  | "thinking"
  | "tool"
  | "progress"
  | "prompt"
  | "stream";

export interface ChildActivityRecord {
  readonly id: string;
  readonly label: string;
  readonly source: ChildActivitySource;
  readonly status: ChildActivityStatus;
  readonly kind: ChildActivityKind;
  readonly detail: string;
  /** Wall-clock ms when this child's activity first appeared, so each row can
   *  show its own elapsed. Set once by the feeder and preserved across updates. */
  readonly startedAt?: number;
}

export type ChildActivityRowKind = "summary" | "activity";
export type ChildActivitySymbolColor = "cyan" | "green" | "dim";

export interface ChildActivityRow {
  readonly kind: ChildActivityRowKind;
  readonly id: string;
  readonly symbol: string;
  readonly symbolColor: ChildActivitySymbolColor;
  readonly text: string;
  readonly isActive: boolean;
}

export interface ChildActivityViewModel {
  readonly shouldRender: boolean;
  readonly activeCount: number;
  readonly rows: readonly ChildActivityRow[];
}

export const CHILD_ACTIVITY_LABEL_WIDTH = 9;
export const MAX_CHILD_ACTIVITY_ROWS = 3;
export const CHILD_ACTIVITY_DETAIL_MAX_CHARS = 160;

const emptyViewModel: ChildActivityViewModel = {
  shouldRender: false,
  activeCount: 0,
  rows: [],
};

export function padChildActivitySymbol(
  symbol: string,
  width: number = CHILD_ACTIVITY_LABEL_WIDTH,
): string {
  const visibleWidth = stringWidth(symbol);
  if (visibleWidth >= width) {
    return symbol;
  }
  return `${symbol}${" ".repeat(width - visibleWidth)}`;
}

export function truncateChildActivityDetail(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= CHILD_ACTIVITY_DETAIL_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, CHILD_ACTIVITY_DETAIL_MAX_CHARS - 3)}...`;
}

export function shouldRouteToChildActivity(
  meta: KodaXActivityEventMeta | undefined,
): meta is KodaXActivityEventMeta {
  return Boolean(meta?.liveOnly === true && (meta.workflowCorrelation || meta.childAgentId));
}

export function shouldRouteWorkflowLiveOnlyNotice(
  meta: KodaXActivityEventMeta | undefined,
  workflowRunId: string | undefined,
): meta is KodaXActivityEventMeta {
  return Boolean(
    meta?.liveOnly === true
    && meta.workflowCorrelation?.workflowRunId
    && workflowRunId
    && meta.workflowCorrelation.workflowRunId === workflowRunId,
  );
}

export function shouldShowChildActivitySurface(input: {
  readonly isTranscriptMode: boolean;
  readonly isLoading: boolean;
  readonly hasWorkflowLiveSurface: boolean;
  readonly childActivityVisible: boolean;
}): boolean {
  return (
    !input.isTranscriptMode &&
    input.childActivityVisible &&
    (input.isLoading || input.hasWorkflowLiveSurface)
  );
}

export function childActivityId(meta: KodaXActivityEventMeta): string {
  const childId = meta.childAgentId ?? meta.workflowCorrelation?.childAgentId ?? "child";
  const runId = meta.workflowCorrelation?.workflowRunId;
  return runId ? `${runId}:${childId}` : childId;
}

export function childActivityLabel(meta: KodaXActivityEventMeta): string {
  return meta.childAgentName
    ?? meta.childAgentId
    ?? meta.workflowCorrelation?.childAgentId
    ?? "child";
}

export function childActivitySource(meta: KodaXActivityEventMeta): ChildActivityRecord["source"] {
  return meta.workflowCorrelation ? "workflow" : "normal";
}

export function toolActivityDetail(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const hint = input?.path ?? input?.pattern ?? input?.command ?? input?.preview;
  const hintText = typeof hint === "string" && hint.trim().length > 0
    ? ` ${hint}`
    : "";
  return truncateChildActivityDetail(`${toolName}${hintText}`);
}

/**
 * Tool-action priority: a churny thinking/assistant/stream update must NOT
 * overwrite a child's last concrete tool action (Grep …/Read …). Returns true
 * when the incoming update should be dropped so the stable tool row stays until
 * the next tool call. Only before the first tool (no existing tool) does thinking
 * show. Zero extra cost — the tool detail already flowed through the stream.
 */
export function suppressesChurnOverToolAction(
  existingKind: ChildActivityKind | undefined,
  incomingKind: ChildActivityKind,
): boolean {
  const churny: readonly ChildActivityKind[] = ["thinking", "assistant", "stream"];
  return existingKind === "tool" && churny.includes(incomingKind);
}

/** Compact per-agent elapsed (e.g. "51s", "1m20s", "1h05m"). */
export function formatChildActivityElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function kindLabel(kind: ChildActivityKind): string {
  switch (kind) {
    case "assistant":
      return "Assistant";
    case "thinking":
      return "Thinking";
    case "tool":
      return "Tool";
    case "progress":
      return "Progress";
    case "prompt":
      return "Prompt";
    case "stream":
    default:
      return "Status";
  }
}

function rowText(record: ChildActivityRecord, now: number): string {
  const label = record.label.trim() || "child";
  const elapsed = record.startedAt !== undefined
    ? ` · ${formatChildActivityElapsed(now - record.startedAt)}`
    : "";
  const detail = record.detail.trim();
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  return `${label}${elapsed} - ${kindLabel(record.kind)}${suffix}`;
}

export function buildChildActivityViewModel(
  records: readonly ChildActivityRecord[],
  maxRows: number = MAX_CHILD_ACTIVITY_ROWS,
  now: number = Date.now(),
): ChildActivityViewModel {
  const active = records.filter((record) => record.status === "running");
  if (active.length === 0) {
    return emptyViewModel;
  }

  const safeMaxRows = Math.max(1, Math.floor(maxRows));
  const rows: ChildActivityRow[] = [];
  const activityBudget = active.length > safeMaxRows && safeMaxRows > 1
    ? safeMaxRows - 1
    : safeMaxRows;

  const visible = active.slice(0, activityBudget);
  for (const record of visible) {
    rows.push({
      kind: "activity",
      id: record.id,
      symbol: record.source === "workflow" ? "agent" : "child",
      symbolColor: "cyan",
      text: rowText(record, now),
      isActive: true,
    });
  }

  const hidden = active.length - visible.length;
  if (hidden > 0 && rows.length < safeMaxRows) {
    rows.push({
      kind: "summary",
      id: "children-more",
      symbol: "more",
      symbolColor: "dim",
      text: `${hidden} more active`,
      isActive: false,
    });
  }

  return {
    shouldRender: true,
    activeCount: active.length,
    rows: rows.slice(0, safeMaxRows),
  };
}
