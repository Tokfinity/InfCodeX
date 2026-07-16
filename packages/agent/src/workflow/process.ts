import type { WorkflowEvent } from './events.js';
import type { WorkflowArtifactRef } from './types.js';

export type WorkflowProcessStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowProcessItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type WorkflowProcessItemKind = 'phase' | 'agent' | 'step' | 'artifact';

/**
 * FEATURE_246 resume telemetry — how an agent item came to be in a resumed run.
 * `ran` = executed live this run; `replayed-from-cache` = returned instantly from
 * a prior run's content-addressed result cache (resumeFromRunId). Only populated
 * on resumed runs; absent on a fresh run (treat absent as `ran`).
 */
export type WorkflowProcessItemOrigin = 'ran' | 'replayed-from-cache';

export type WorkflowProcessSummaryStatus =
  | 'pending'
  | 'result'
  | 'notice'
  | 'unavailable';

export type WorkflowProcessSource =
  | 'command'
  | 'amaw'
  | 'review'
  | 'sdk'
  | 'capsule'
  | 'extension'
  | 'automation';

export interface WorkflowProcessItem {
  readonly id: string;
  readonly title: string;
  readonly kind: WorkflowProcessItemKind;
  readonly status: WorkflowProcessItemStatus;
  readonly phaseId?: string;
  readonly parentId?: string;
  readonly agentId?: string;
  readonly childAgentId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly summaryStatus?: WorkflowProcessSummaryStatus;
  readonly error?: string;
  /** FEATURE_246 resume telemetry — see {@link WorkflowProcessItemOrigin}. */
  readonly origin?: WorkflowProcessItemOrigin;
}

export interface WorkflowEventCorrelation {
  readonly workflowRunId: string;
  readonly childAgentId?: string;
  readonly phaseId?: string;
  readonly itemId?: string;
}

export interface WorkflowProcessCounts {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

export interface WorkflowProcessProgress {
  readonly spawnedAgents: number;
  readonly finishedAgents: number;
  readonly activeAgents: number;
  readonly failedAgents: number;
  readonly stoppedAgents: number;
  readonly agentCap?: number;
  readonly plannedItems?: number;
  /** FEATURE_246 resume telemetry — count of agents that replayed from a prior
   *  run's cache (origin `replayed-from-cache`). Present only when > 0, so a
   *  fresh run's progress is unchanged. */
  readonly replayedAgents?: number;
}

export interface WorkflowProcessTokenUsage {
  readonly spent: number;
  readonly total?: number;
}

export interface WorkflowProcessArtifact {
  readonly name: string;
  readonly path?: string;
  readonly description?: string;
}

export interface WorkflowProcessSnapshot {
  readonly runId: string;
  readonly workflowName: string;
  readonly displayName?: string;
  readonly status: WorkflowProcessStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs?: number;
  readonly goal?: string;
  readonly source?: WorkflowProcessSource;
  readonly savedWorkflowName?: string;
  readonly sourceRunId?: string;
  readonly sourceWorkflowName?: string;
  readonly revisionOf?: string;
  /** FEATURE_246 resume telemetry — the prior run this run resumed from
   *  (content-addressed replay). Absent on a fresh (non-resumed) run. */
  readonly resumedFromRunId?: string;
  readonly hostMetadata?: Record<string, string>;
  readonly activePhaseId?: string;
  readonly activePhaseIndex?: number;
  readonly phaseCount?: number;
  readonly items: readonly WorkflowProcessItem[];
  readonly counts: WorkflowProcessCounts;
  readonly progress: WorkflowProcessProgress;
  readonly tokens?: WorkflowProcessTokenUsage;
  readonly latestMessage?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly artifacts?: readonly WorkflowProcessArtifact[];
}

export type WorkflowProcessEvent =
  | { readonly type: 'workflow_started'; readonly snapshot: WorkflowProcessSnapshot }
  | {
      readonly type: 'workflow_updated';
      readonly snapshot: WorkflowProcessSnapshot;
      readonly message?: string;
    }
  | { readonly type: 'workflow_finished'; readonly snapshot: WorkflowProcessSnapshot };

export interface WorkflowProcessTrackerOptions {
  readonly runId: string;
  readonly workflowName: string;
  readonly displayName?: string;
  readonly goal?: string;
  readonly source?: WorkflowProcessSource;
  readonly savedWorkflowName?: string;
  readonly sourceRunId?: string;
  readonly sourceWorkflowName?: string;
  readonly revisionOf?: string;
  /** FEATURE_246 resume telemetry — the prior run this run resumed from. */
  readonly resumedFromRunId?: string;
  readonly hostMetadata?: Record<string, string>;
  readonly phases?: readonly string[];
  readonly maxAgents?: number;
  readonly plannedAgents?: number;
  readonly tokenBudget?: number;
  readonly resultSummary?: string;
  readonly artifacts?: readonly WorkflowArtifactRef[];
  readonly now?: () => string;
}

export interface WorkflowTaskSummaryUpdate {
  readonly summary?: string;
  readonly summaryStatus: WorkflowProcessSummaryStatus;
}

export interface WorkflowProcessTracker {
  applyEvent(event: WorkflowEvent): WorkflowProcessEvent;
  updateTaskSummary(taskId: string, update: WorkflowTaskSummaryUpdate): WorkflowProcessEvent | undefined;
  setStatus(status: WorkflowProcessStatus, message?: string): WorkflowProcessEvent;
  setResultSummary(resultSummary: string | undefined): WorkflowProcessEvent;
  getSnapshot(): WorkflowProcessSnapshot;
}

interface MutableWorkflowProcessItem {
  id: string;
  title: string;
  kind: WorkflowProcessItemKind;
  status: WorkflowProcessItemStatus;
  phaseId?: string;
  parentId?: string;
  agentId?: string;
  childAgentId?: string;
  provider?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  summaryStatus?: WorkflowProcessSummaryStatus;
  error?: string;
  origin?: WorkflowProcessItemOrigin;
}

export function isFinalWorkflowProcessStatus(status: WorkflowProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function defaultNow(): string {
  return new Date().toISOString();
}

const HOST_METADATA_MAX_KEYS = 16;
const HOST_METADATA_MAX_KEY_LENGTH = 64;
const HOST_METADATA_MAX_VALUE_LENGTH = 512;

export function normalizeHostMetadata(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const metadata: Record<string, string> = {};
  let retained = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') continue;
    // hostMetadata is an opaque host-owned string map; empty strings can be a
    // meaningful host marker, so the SDK preserves them instead of applying
    // readString-style non-empty semantics.
    metadata[key.slice(0, HOST_METADATA_MAX_KEY_LENGTH)] =
      item.slice(0, HOST_METADATA_MAX_VALUE_LENGTH);
    retained += 1;
    if (retained >= HOST_METADATA_MAX_KEYS) break;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveNumber(data: Record<string, unknown> | undefined, key: string): number {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readTokenUsage(data: Record<string, unknown> | undefined): number {
  const usage = data?.usage;
  if (typeof usage !== 'object' || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const total = readPositiveNumber(record, 'totalTokens');
  if (total > 0) return total;
  return readPositiveNumber(record, 'inputTokens') + readPositiveNumber(record, 'outputTokens');
}

function itemStatusFromTaskStatus(status: string | undefined): WorkflowProcessItemStatus {
  if (status === 'failed') return 'failed';
  if (status === 'stopped' || status === 'cancelled') return 'cancelled';
  return 'completed';
}

function summaryStatusFromKind(kind: string | undefined): WorkflowProcessSummaryStatus | undefined {
  if (kind === 'digest') return 'result';
  if (kind === 'digest-failed') return 'unavailable';
  if (kind === 'pending') return 'pending';
  if (kind === 'excerpt') return 'notice';
  return undefined;
}

function phaseIdForIndex(index: number): string {
  return `phase:${index + 1}`;
}

function agentItemId(taskId: string): string {
  return `agent:${taskId}`;
}

/**
 * FEATURE_246 — item id for a cache-replayed agent. Deliberately DISTINCT from
 * `agentItemId` so a replayed item (keyed by the PRIOR run's taskId, carried in
 * the cached result) can never collide with a live spawn in THIS run that reuses
 * the same taskId. The workflow backend mints taskIds from a per-run counter that
 * restarts at 1, so a resumed run's first live spawn and a replayed prior-run
 * agent can both be `wf-child-1`; without this namespace they would merge into
 * one item and corrupt origin + the ran/replayed counts.
 */
function replayedAgentItemId(taskId: string): string {
  return `agent:replayed:${taskId}`;
}

function artifactItemId(name: string, ordinal: number): string {
  return `artifact:${ordinal + 1}:${name}`;
}

function countItems(items: readonly MutableWorkflowProcessItem[]): WorkflowProcessCounts {
  const counts: Record<WorkflowProcessItemStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function immutableItem(item: MutableWorkflowProcessItem): WorkflowProcessItem {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    ...(item.phaseId !== undefined ? { phaseId: item.phaseId } : {}),
    ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
    ...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
    ...(item.childAgentId !== undefined ? { childAgentId: item.childAgentId } : {}),
    ...(item.provider !== undefined ? { provider: item.provider } : {}),
    ...(item.model !== undefined ? { model: item.model } : {}),
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.summaryStatus !== undefined ? { summaryStatus: item.summaryStatus } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
  };
}

function immutableArtifact(artifact: WorkflowProcessArtifact): WorkflowProcessArtifact {
  return {
    name: artifact.name,
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
  };
}

export function createWorkflowProcessTracker(
  options: WorkflowProcessTrackerOptions,
): WorkflowProcessTracker {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const hostMetadata = normalizeHostMetadata(options.hostMetadata);
  // FEATURE_246 resume telemetry — only a resumed run stamps `origin` on its
  // agent items (so a fresh run's snapshot stays byte-identical). On a resumed
  // run, live agents are `ran` and cache hits are `replayed-from-cache`.
  const isResumeRun = options.resumedFromRunId !== undefined;
  const ranOrigin: WorkflowProcessItemOrigin | undefined = isResumeRun ? 'ran' : undefined;
  let updatedAt = startedAt;
  let status: WorkflowProcessStatus = 'running';
  let activePhaseId: string | undefined;
  let latestMessage: string | undefined;
  let resultSummary = options.resultSummary;
  let error: string | undefined;
  let tokenSpent = 0;
  const items: MutableWorkflowProcessItem[] = [];
  const artifacts: WorkflowProcessArtifact[] = [];
  const phaseIdByName = new Map<string, string>();

  for (const [index, phase] of (options.phases ?? []).entries()) {
    const id = phaseIdForIndex(index);
    phaseIdByName.set(phase, id);
    items.push({
      id,
      title: phase,
      kind: 'phase',
      status: 'pending',
    });
  }

  for (const artifact of options.artifacts ?? []) {
    addArtifact(artifact.name, artifact.path);
  }

  function touch(): string {
    updatedAt = now();
    return updatedAt;
  }

  function findItem(id: string): MutableWorkflowProcessItem | undefined {
    return items.find((item) => item.id === id);
  }

  function phaseIdForName(name: string): string {
    const existing = phaseIdByName.get(name);
    if (existing) return existing;
    const id = phaseIdForIndex(phaseIdByName.size);
    phaseIdByName.set(name, id);
    items.push({
      id,
      title: name,
      kind: 'phase',
      status: 'pending',
    });
    return id;
  }

  function addArtifact(name: string, path: string | undefined): void {
    const artifact: WorkflowProcessArtifact =
      path === undefined ? { name } : { name, path };
    artifacts.push(artifact);
    items.push({
      id: artifactItemId(name, artifacts.length - 1),
      title: name,
      kind: 'artifact',
      status: 'completed',
      ...(path !== undefined ? { summary: path } : {}),
    });
  }

  function progress(): WorkflowProcessProgress {
    const allAgents = items.filter((item) => item.kind === 'agent');
    // FEATURE_246 — replayed agents are counted separately; the spawn/finish/
    // active counts stay about agents that actually ran this run (so a fresh run,
    // which never has replayed items, is unchanged).
    const replayedAgents = allAgents.filter((item) => item.origin === 'replayed-from-cache').length;
    const agents = replayedAgents > 0
      ? allAgents.filter((item) => item.origin !== 'replayed-from-cache')
      : allAgents;
    const finishedAgents = agents.filter((item) =>
      item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
    ).length;
    const activeAgents = agents.filter((item) => item.status === 'running').length;
    const failedAgents = agents.filter((item) => item.status === 'failed').length;
    const stoppedAgents = agents.filter((item) => item.status === 'cancelled').length;
    return {
      spawnedAgents: agents.length,
      finishedAgents,
      activeAgents,
      failedAgents,
      stoppedAgents,
      ...(options.maxAgents !== undefined ? { agentCap: options.maxAgents } : {}),
      ...(options.plannedAgents !== undefined ? { plannedItems: options.plannedAgents } : {}),
      ...(replayedAgents > 0 ? { replayedAgents } : {}),
    };
  }

  function snapshot(): WorkflowProcessSnapshot {
    const activeIndex = activePhaseId
      ? [...phaseIdByName.values()].indexOf(activePhaseId)
      : -1;
    const tokens: WorkflowProcessTokenUsage | undefined =
      tokenSpent > 0 || options.tokenBudget !== undefined
        ? {
            spent: tokenSpent,
            ...(options.tokenBudget !== undefined ? { total: options.tokenBudget } : {}),
          }
        : undefined;
    return {
      runId: options.runId,
      workflowName: options.workflowName,
      ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
      status,
      startedAt,
      updatedAt,
      elapsedMs: Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)),
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.savedWorkflowName !== undefined ? { savedWorkflowName: options.savedWorkflowName } : {}),
      ...(options.sourceRunId !== undefined ? { sourceRunId: options.sourceRunId } : {}),
      ...(options.sourceWorkflowName !== undefined
        ? { sourceWorkflowName: options.sourceWorkflowName }
        : {}),
      ...(options.revisionOf !== undefined ? { revisionOf: options.revisionOf } : {}),
      ...(options.resumedFromRunId !== undefined ? { resumedFromRunId: options.resumedFromRunId } : {}),
      ...(hostMetadata !== undefined ? { hostMetadata: { ...hostMetadata } } : {}),
      ...(activePhaseId !== undefined ? { activePhaseId } : {}),
      ...(activeIndex >= 0 ? { activePhaseIndex: activeIndex + 1 } : {}),
      ...(phaseIdByName.size > 0 ? { phaseCount: phaseIdByName.size } : {}),
      items: items.map(immutableItem),
      counts: countItems(items),
      progress: progress(),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(latestMessage !== undefined ? { latestMessage } : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(artifacts.length > 0 ? { artifacts: artifacts.map(immutableArtifact) } : {}),
    };
  }

  function processEvent(
    type: WorkflowProcessEvent['type'],
    message?: string,
  ): WorkflowProcessEvent {
    const current = snapshot();
    if (type === 'workflow_updated') {
      return message === undefined
        ? { type, snapshot: current }
        : { type, snapshot: current, message };
    }
    return { type, snapshot: current };
  }

  function applyPhaseStarted(data: Record<string, unknown> | undefined): void {
    const name = readString(data, 'name') ?? 'phase';
    const id = phaseIdForName(name);
    const item = findItem(id);
    if (!item) return;
    activePhaseId = id;
    item.status = 'running';
    item.startedAt ??= updatedAt;
    latestMessage = `phase started: ${name}`;
  }

  function applyPhaseFinished(data: Record<string, unknown> | undefined): void {
    const name = readString(data, 'name');
    const id = name === undefined ? activePhaseId : phaseIdByName.get(name);
    if (!id) return;
    const item = findItem(id);
    if (!item) return;
    item.status = item.status === 'failed' ? 'failed' : 'completed';
    item.endedAt = updatedAt;
    if (activePhaseId === id) {
      activePhaseId = undefined;
    }
    latestMessage = `phase completed: ${item.title}`;
  }

  function applyAgentSpawned(data: Record<string, unknown> | undefined): void {
    const taskId = readString(data, 'taskId') ?? readString(data, 'agentId');
    if (!taskId) return;
    const title = readString(data, 'name') ?? taskId;
    const id = agentItemId(taskId);
    // FEATURE_246 Part E: an explicit per-agent `phase` tag groups this agent
    // under that named phase (created on demand), independent of the
    // `wf.phase(...)` wrapper's active phase. No tag → the active phase, if any.
    const explicitPhase = readString(data, 'phase');
    const phaseId = explicitPhase !== undefined ? phaseIdForName(explicitPhase) : activePhaseId;
    if (explicitPhase !== undefined) {
      const phaseItem = findItem(phaseId!);
      if (phaseItem && phaseItem.status === 'pending') {
        phaseItem.status = 'running';
        phaseItem.startedAt ??= updatedAt;
      }
    }
    const existing = findItem(id);
    if (existing) {
      existing.status = 'running';
      if (phaseId !== undefined && existing.phaseId === undefined) existing.phaseId = phaseId;
      return;
    }
    items.push({
      id,
      title,
      kind: 'agent',
      status: 'running',
      ...(phaseId !== undefined ? { phaseId } : {}),
      childAgentId: taskId,
      startedAt: updatedAt,
      ...(readString(data, 'provider') !== undefined ? { provider: readString(data, 'provider') } : {}),
      ...(readString(data, 'model') !== undefined ? { model: readString(data, 'model') } : {}),
      ...(ranOrigin !== undefined ? { origin: ranOrigin } : {}),
    });
    latestMessage = `agent spawned: ${title}`;
  }

  function applyAgentCompleted(data: Record<string, unknown> | undefined): void {
    const taskId = readString(data, 'taskId') ?? readString(data, 'agentId');
    if (!taskId) return;
    const title = readString(data, 'name') ?? taskId;
    const id = agentItemId(taskId);
    const item = findItem(id);
    const statusValue = readString(data, 'status');
    const itemStatus = itemStatusFromTaskStatus(statusValue);
    const summary = readString(data, 'summary');
    const summaryStatus = summaryStatusFromKind(readString(data, 'summaryKind'));
    const target = item ?? {
      id,
      title,
      kind: 'agent' as const,
      status: 'running' as const,
      ...(activePhaseId !== undefined ? { phaseId: activePhaseId } : {}),
      childAgentId: taskId,
      startedAt: updatedAt,
      ...(ranOrigin !== undefined ? { origin: ranOrigin } : {}),
    };
    target.title = title;
    target.status = itemStatus;
    target.endedAt = updatedAt;
    const provider = readString(data, 'provider');
    const model = readString(data, 'model');
    if (provider !== undefined) target.provider = provider;
    if (model !== undefined) target.model = model;
    if (summary !== undefined) target.summary = summary;
    if (summaryStatus !== undefined) target.summaryStatus = summaryStatus;
    if (itemStatus === 'failed') target.error = readString(data, 'error') ?? 'workflow agent failed';
    if (!item) items.push(target);
    tokenSpent += readTokenUsage(data);
    latestMessage = itemStatus === 'failed'
      ? `agent failed: ${title}`
      : statusValue === 'completed_unverified'
        ? `agent completed without verification: ${title}`
        : `agent completed: ${title}`;
  }

  function applyAgentSummaryUpdated(data: Record<string, unknown> | undefined): void {
    const taskId = readString(data, 'taskId') ?? readString(data, 'agentId');
    if (!taskId) return;
    if (status === 'cancelled') return;
    const item = findItem(agentItemId(taskId));
    if (!item) return;
    const summary = readString(data, 'summary');
    const summaryStatus = summaryStatusFromKind(readString(data, 'summaryKind'));
    if (summary !== undefined) item.summary = summary;
    if (summaryStatus !== undefined) item.summaryStatus = summaryStatus;
    tokenSpent += readTokenUsage(data);
    latestMessage = `agent summary updated: ${item.title}`;
  }

  function applyAgentStopped(data: Record<string, unknown> | undefined): void {
    const taskId = readString(data, 'taskId') ?? readString(data, 'agentId');
    if (!taskId) return;
    const id = agentItemId(taskId);
    const item = findItem(id);
    const title = readString(data, 'name') ?? item?.title ?? taskId;
    const target = item ?? {
      id,
      title,
      kind: 'agent' as const,
      status: 'running' as const,
      ...(activePhaseId !== undefined ? { phaseId: activePhaseId } : {}),
      childAgentId: taskId,
      startedAt: updatedAt,
      ...(ranOrigin !== undefined ? { origin: ranOrigin } : {}),
    };
    target.status = 'cancelled';
    target.endedAt = updatedAt;
    const stopError = readString(data, 'error') ?? readString(data, 'stopError');
    if (stopError !== undefined) target.error = stopError;
    if (!item) items.push(target);
    latestMessage = `agent stopped: ${title}`;
  }

  function applyAgentReplayed(data: Record<string, unknown> | undefined): void {
    const taskId = readString(data, 'taskId') ?? readString(data, 'agentId');
    if (!taskId) return;
    const title = readString(data, 'name') ?? taskId;
    // Distinct id namespace — a replayed prior-run taskId must never collide with
    // a live spawn's item in this (resumed) run (see replayedAgentItemId).
    const id = replayedAgentItemId(taskId);
    const explicitPhase = readString(data, 'phase');
    const phaseId = explicitPhase !== undefined ? phaseIdForName(explicitPhase) : activePhaseId;
    // A cache replay is instantaneous — the item goes straight to completed and
    // never passes through `running`. `origin` marks it so a host can render
    // "N/M replayed from cache" and badge the row.
    const existing = findItem(id);
    if (existing) {
      existing.status = 'completed';
      existing.origin = 'replayed-from-cache';
      existing.endedAt = updatedAt;
      if (phaseId !== undefined && existing.phaseId === undefined) existing.phaseId = phaseId;
    } else {
      items.push({
        id,
        title,
        kind: 'agent',
        status: 'completed',
        ...(phaseId !== undefined ? { phaseId } : {}),
        childAgentId: taskId,
        startedAt: updatedAt,
        endedAt: updatedAt,
        origin: 'replayed-from-cache',
      });
    }
    latestMessage = `agent replayed from cache: ${title}`;
  }

  function finishOpenItems(finalStatus: WorkflowProcessItemStatus): void {
    for (const item of items) {
      if (item.status !== 'pending' && item.status !== 'running') continue;
      item.status = finalStatus;
      item.endedAt = updatedAt;
    }
  }

  function cancelOpenItems(): void {
    for (const item of items) {
      if (item.status !== 'pending' && item.status !== 'running') continue;
      item.status = item.status === 'running' ? 'cancelled' : 'skipped';
      item.endedAt = updatedAt;
    }
  }

  function clearActivePhase(): void {
    activePhaseId = undefined;
  }

  return {
    applyEvent: (event) => {
      touch();
      switch (event.type) {
        case 'workflow_started':
          status = 'running';
          latestMessage = 'workflow started';
          return processEvent('workflow_started');
        case 'phase_started':
          applyPhaseStarted(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'phase_finished':
          applyPhaseFinished(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_spawned':
          applyAgentSpawned(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_completed':
          applyAgentCompleted(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_unverified':
          applyAgentCompleted(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_failed':
          applyAgentCompleted(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_summary_updated':
          applyAgentSummaryUpdated(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_stopped':
          applyAgentStopped(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_replayed':
          applyAgentReplayed(event.data);
          return processEvent('workflow_updated', latestMessage);
        case 'agent_message_sent':
          latestMessage = 'agent message sent';
          return processEvent('workflow_updated', latestMessage);
        case 'workflow_log':
          latestMessage = readString(event.data, 'message') ?? 'workflow progress';
          return processEvent('workflow_updated', latestMessage);
        case 'artifact_written': {
          const name = readString(event.data, 'name') ?? 'artifact';
          addArtifact(name, readString(event.data, 'path'));
          latestMessage = `artifact written: ${name}`;
          return processEvent('workflow_updated', latestMessage);
        }
        case 'synthesis_completed':
          latestMessage = 'synthesis complete';
          return processEvent('workflow_updated', latestMessage);
        case 'workflow_completed':
          status = 'completed';
          resultSummary = readString(event.data, 'resultSummary') ?? resultSummary;
          finishOpenItems('skipped');
          clearActivePhase();
          latestMessage = 'workflow completed';
          return processEvent('workflow_finished');
        case 'workflow_failed':
          status = 'failed';
          error = readString(event.data, 'error') ?? 'workflow failed';
          finishOpenItems('skipped');
          clearActivePhase();
          latestMessage = error;
          return processEvent('workflow_finished');
        case 'workflow_stopped':
          status = 'cancelled';
          cancelOpenItems();
          clearActivePhase();
          latestMessage = 'workflow cancelled';
          return processEvent('workflow_finished');
        default:
          return processEvent('workflow_updated');
      }
    },
    updateTaskSummary: (taskId, update) => {
      const item = findItem(agentItemId(taskId));
      if (!item) return undefined;
      if (status === 'cancelled') return undefined;
      touch();
      if (update.summary !== undefined) item.summary = update.summary;
      item.summaryStatus = update.summaryStatus;
      latestMessage = `agent summary updated: ${item.title}`;
      return processEvent('workflow_updated', latestMessage);
    },
    setStatus: (nextStatus, message) => {
      touch();
      status = nextStatus;
      if (isFinalWorkflowProcessStatus(nextStatus)) {
        if (nextStatus === 'cancelled') {
          cancelOpenItems();
        } else {
          finishOpenItems('skipped');
        }
        clearActivePhase();
      }
      latestMessage = message ?? latestMessage;
      return processEvent(isFinalWorkflowProcessStatus(nextStatus) ? 'workflow_finished' : 'workflow_updated', message);
    },
    setResultSummary: (summary) => {
      touch();
      resultSummary = summary;
      return processEvent('workflow_updated');
    },
    getSnapshot: snapshot,
  };
}
