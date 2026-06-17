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
  readonly childActivityVisible: boolean;
}): boolean {
  return (
    !input.isTranscriptMode &&
    input.isLoading &&
    input.childActivityVisible
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

function rowText(record: ChildActivityRecord): string {
  const label = record.label.trim() || "child";
  const detail = record.detail.trim();
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  return `${label} - ${kindLabel(record.kind)}${suffix}`;
}

export function buildChildActivityViewModel(
  records: readonly ChildActivityRecord[],
  maxRows: number = MAX_CHILD_ACTIVITY_ROWS,
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
      text: rowText(record),
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
