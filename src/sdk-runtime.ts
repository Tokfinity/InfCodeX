/**
 * SDK subpath entry - `@kodax-ai/kodax/runtime`.
 *
 * FEATURE_253 (v0.7.64): embedded runtime contract. This module composes the
 * existing coding run loop, REPL-backed session storage, and agent workflow
 * process manager without introducing a daemon or a fifth workspace package.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  generateSessionId,
  runManagedTask,
  startKodaX,
} from '@kodax-ai/coding';
import type {
  AskUserAnswer,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  KodaXActivityEventMeta,
  KodaXEvents,
  KodaXMessage,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionData,
  KodaXSessionRuntimeInfo,
  KodaXToolEventMeta,
  KodaXTurnCompletedEvent,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
  RunningSession,
} from '@kodax-ai/coding';
import {
  createSessionManager,
} from '@kodax-ai/repl';
import type {
  DeleteSessionResult,
  FullTranscriptSessionData,
  SessionManager,
  SessionSummary,
  SessionTranscriptEntry,
} from '@kodax-ai/repl';
import {
  getDefaultWorkflowRunManager,
} from '@kodax-ai/agent';
import type {
  ManagedWorkflowSnapshot,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
} from '@kodax-ai/agent';

export type KodaXRuntimeMode = 'embedded';

export interface RuntimeIdentity {
  readonly runtimeId: string;
  readonly mode: KodaXRuntimeMode;
  readonly profile: string;
  readonly startedAt: string;
  readonly version: string;
}

export interface CreateKodaXRuntimeOptions {
  readonly mode?: KodaXRuntimeMode;
  readonly homeDir?: string;
  readonly profile?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
}

export interface KodaXRuntime {
  readonly identity: RuntimeIdentity;
  readonly sessions: RuntimeSessionService;
  readonly runs: RuntimeRunService;
  readonly events: RuntimeEventService;
  readonly permissions: RuntimePermissionService;
  readonly workflows: RuntimeWorkflowService;
  readonly status: RuntimeStatusService;
  close(): Promise<void>;
}

export interface RuntimeCreateSessionInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly projectPath?: string;
  readonly gitRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly tag?: string;
}

export interface RuntimeSession {
  readonly id: string;
  readonly title: string;
  readonly gitRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly createdAt?: string;
}

export interface RuntimeSessionSummary extends RuntimeSession {
  readonly msgCount: number;
  readonly tag?: string;
  readonly projectKey?: string;
  readonly archived?: boolean;
}

export type RuntimeTranscript = FullTranscriptSessionData;

export interface RuntimeSessionFilter {
  readonly projectRoot?: string;
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly tag?: string;
}

export interface RuntimeForkSessionInput {
  readonly sessionId: string;
  readonly selector?: string;
  readonly newSessionId?: string;
  readonly title?: string;
}

export interface RuntimeSessionService {
  create(input?: RuntimeCreateSessionInput): Promise<RuntimeSession>;
  load(sessionId: string): Promise<RuntimeSession>;
  list(filter?: RuntimeSessionFilter): Promise<readonly RuntimeSessionSummary[]>;
  transcript(sessionId: string): Promise<RuntimeTranscript | null>;
  fork(input: RuntimeForkSessionInput): Promise<RuntimeSession | null>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type RuntimeRunPhase =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RuntimeRunMode = 'coding' | 'managed_task';

export interface RuntimeTextInput {
  readonly type: 'text';
  readonly text: string;
}

export interface RuntimeStartRunInput {
  readonly sessionId: string;
  readonly prompt?: string;
  readonly input?: RuntimeTextInput;
  readonly mode?: RuntimeRunMode;
  readonly options?: RuntimeKodaXOptions;
}

export type RuntimeKodaXOptions =
  Omit<KodaXOptions, 'provider' | 'session' | 'events'>
  & {
    readonly provider?: string;
    readonly session?: KodaXOptions['session'];
    readonly events?: KodaXEvents;
  };

export interface RuntimeRunStatus {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly phase: RuntimeRunPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly provider: string;
  readonly model?: string;
  readonly reasoning?: KodaXReasoningMode;
  readonly error?: string;
}

export interface RuntimeRunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: RuntimeRunPhase;
  readonly result?: KodaXResult;
  readonly error?: Error;
}

export interface RuntimeRunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly result: Promise<RuntimeRunResult>;
}

export interface RuntimeRunFilter {
  readonly sessionId?: string;
  readonly phase?: RuntimeRunPhase | readonly RuntimeRunPhase[];
}

export interface RuntimeRunService {
  start(input: RuntimeStartRunInput): Promise<RuntimeRunHandle>;
  get(runId: string): Promise<RuntimeRunStatus>;
  list(filter?: RuntimeRunFilter): Promise<readonly RuntimeRunStatus[]>;
  abort(runId: string): Promise<void>;
  setModel(runId: string, model: string | undefined): Promise<void>;
  setProvider(runId: string, provider: string): Promise<void>;
  setReasoning(runId: string, reasoning: KodaXReasoningMode | undefined): Promise<void>;
}

export type RuntimeEventType =
  | 'session.created'
  | 'session.loaded'
  | 'run.queued'
  | 'run.started'
  | 'turn.started'
  | 'assistant.delta'
  | 'thinking.delta'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.finished'
  | 'permission.requested'
  | 'permission.resolved'
  | 'workflow.started'
  | 'workflow.updated'
  | 'workflow.finished'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'artifact.created'
  | 'config.effective'
  | 'runtime.warning';

export interface RuntimeEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly seq: number;
  readonly time: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly type: RuntimeEventType;
  readonly payload: TPayload;
}

export type RuntimeEvent = RuntimeEventEnvelope;

export interface RuntimeEventFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly type?: RuntimeEventType | readonly RuntimeEventType[];
}

export interface RuntimeEventReplayFilter extends RuntimeEventFilter {
  readonly sinceSeq?: number;
  readonly limit?: number;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSubscription {
  close(): void;
}

export interface RuntimeEventService {
  subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener): RuntimeSubscription;
  replay(filter?: RuntimeEventReplayFilter): Promise<readonly RuntimeEvent[]>;
}

export type RuntimePermissionRisk = 'low' | 'medium' | 'high';

export interface RuntimePermissionScope {
  readonly toolName?: string;
  readonly sessionId?: string;
}

export interface RuntimePermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly risk?: RuntimePermissionRisk;
  readonly inputPreview?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RuntimePermissionRequestInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly risk?: RuntimePermissionRisk;
  readonly inputPreview?: string;
  readonly expiresAt?: string;
  readonly timeoutMs?: number;
}

export type RuntimePermissionDecision =
  | { readonly type: 'allow_once' }
  | { readonly type: 'allow_always'; readonly scope: RuntimePermissionScope }
  | { readonly type: 'reject'; readonly reason?: string };

export interface RuntimePermissionFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolName?: string;
}

export interface RuntimePermissionService {
  request(input: RuntimePermissionRequestInput): Promise<RuntimePermissionDecision>;
  listPending(filter?: RuntimePermissionFilter): Promise<readonly RuntimePermissionRequest[]>;
  respond(requestId: string, decision: RuntimePermissionDecision): Promise<boolean>;
}

type RuntimePermissionToolDecision = boolean | string;

export interface RuntimeWorkflowFilter {
  readonly runId?: string;
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export type RuntimeWorkflowSummary = ManagedWorkflowSnapshot;
export type RuntimeWorkflowSnapshot = WorkflowProcessSnapshot;
export type RuntimeWorkflowListener = (event: WorkflowProcessEvent) => void;

export interface RuntimeWorkflowService {
  list(filter?: RuntimeWorkflowFilter): Promise<readonly RuntimeWorkflowSummary[]>;
  get(runId: string): Promise<RuntimeWorkflowSnapshot | undefined>;
  subscribe(
    filter: RuntimeWorkflowFilter,
    listener: RuntimeWorkflowListener,
  ): RuntimeSubscription;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  stop(runId: string): Promise<boolean>;
}

export interface RuntimeStatusSnapshot {
  readonly runtimeId: string;
  readonly mode: KodaXRuntimeMode;
  readonly profile: string;
  readonly startedAt: string;
  readonly sessions: readonly RuntimeSessionSummary[];
  readonly runs: readonly RuntimeRunStatus[];
  readonly pendingPermissions: readonly RuntimePermissionRequest[];
  readonly workflows: readonly RuntimeWorkflowSummary[];
}

export interface RuntimeStatusService {
  snapshot(): Promise<RuntimeStatusSnapshot>;
}

interface RuntimeRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  turnId?: string;
  phase: RuntimeRunPhase;
  readonly startedAt: string;
  queuedAt?: string;
  endedAt?: string;
  provider: string;
  model?: string;
  reasoning?: KodaXReasoningMode;
  error?: string;
  running?: RunningSession;
  abortController?: AbortController;
  mode: RuntimeRunMode;
  start?: PendingRunStart;
  terminalEmitted: boolean;
}

interface PendingPermission {
  readonly request: RuntimePermissionRequest;
  readonly waiters: Array<(decision: RuntimePermissionDecision) => void>;
  readonly timer?: ReturnType<typeof setTimeout>;
}

type RuntimeEventBus = ReturnType<typeof createRuntimeEventBus>;
type RuntimePermissionRegistry = ReturnType<typeof createRuntimePermissionRegistry>;

interface PendingRunStart {
  readonly prompt: string;
  readonly options: RuntimeKodaXOptions;
  readonly resolve: (result: RuntimeRunResult) => void;
}

interface RuntimePersistence {
  readonly runtimeDir: string;
  appendEvent(event: RuntimeEvent): void;
  replay(filter?: RuntimeEventReplayFilter): readonly RuntimeEvent[];
  saveRunStatus(status: RuntimeRunStatus): void;
  loadRunStatuses(): readonly RuntimeRunStatus[];
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

export async function createKodaXRuntime(
  options: CreateKodaXRuntimeOptions = {},
): Promise<KodaXRuntime> {
  if (options.mode !== undefined && options.mode !== 'embedded') {
    throw new Error(`Unsupported KodaX runtime mode: ${options.mode}`);
  }

  const identity: RuntimeIdentity = {
    runtimeId: `rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    mode: 'embedded',
    profile: options.profile ?? 'default',
    startedAt: new Date().toISOString(),
    version: process.env.KODAX_VERSION ?? '0.0.0',
  };
  const sessionManager = createSessionManager(
    options.sessionsDir ? { sessionsDir: options.sessionsDir } : undefined,
  );
  const persistence = createRuntimePersistence(options);
  const bus = createRuntimeEventBus(persistence);
  const permissions = createRuntimePermissionRegistry(
    bus,
    options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  const runs = new Map<string, RuntimeRunRecord>();
  for (const status of persistence.loadRunStatuses()) {
    runs.set(status.runId, recordFromPersistedStatus(status));
  }
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error('KodaX runtime is closed');
    }
  };

  const runtime: KodaXRuntime = {
    identity,
    sessions: createRuntimeSessionService(sessionManager, bus, ensureOpen),
    runs: createRuntimeRunService({
      bus,
      defaultModel: options.defaultModel,
      defaultProvider: options.defaultProvider,
      ensureOpen,
      isClosed: () => closed,
      permissions,
      persistence,
      runs,
      sessionManager,
    }),
    events: bus.service,
    permissions: permissions.service,
    workflows: createRuntimeWorkflowService(),
    status: createRuntimeStatusService({
      identity,
      permissions,
      runs,
      sessionManager,
      workflows: createRuntimeWorkflowService(),
    }),
    async close() {
      if (closed) return;
      closed = true;
      for (const run of runs.values()) {
        if (run.phase === 'queued' || run.phase === 'running' || run.phase === 'waiting_permission') {
          run.running?.abort(new Error('runtime closed'));
          run.abortController?.abort(new Error('runtime closed'));
          markRunTerminal(bus, persistence, run, 'cancelled');
        }
      }
      bus.close();
    },
  };

  return runtime;
}

function createRuntimeSessionService(
  manager: SessionManager,
  bus: RuntimeEventBus,
  ensureOpen: () => void,
): RuntimeSessionService {
  const toRuntimeSession = (
    id: string,
    data: KodaXSessionData,
    createdAt?: string,
  ): RuntimeSession => ({
    id,
    title: data.title,
    ...(data.gitRoot ? { gitRoot: data.gitRoot } : {}),
    ...(data.runtimeInfo?.workspaceRoot ? { workspaceRoot: data.runtimeInfo.workspaceRoot } : {}),
    ...(data.runtimeInfo?.surface ? { surface: data.runtimeInfo.surface } : {}),
    ...(data.runtimeInfo?.profileId ? { profileId: data.runtimeInfo.profileId } : {}),
    ...(createdAt ? { createdAt } : {}),
  });

  return {
    async create(input = {}) {
      ensureOpen();
      const sessionId = input.sessionId ?? await generateSessionId();
      const projectPath = input.projectPath ? path.resolve(input.projectPath) : undefined;
      const gitRoot = input.gitRoot ? path.resolve(input.gitRoot) : projectPath;
      const runtimeInfo = buildSessionRuntimeInfo(input, projectPath, gitRoot);
      const data: KodaXSessionData = {
        messages: [],
        title: input.title ?? '',
        gitRoot: gitRoot ?? '',
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
        scope: 'user',
      };
      await manager.storage.save(sessionId, data);
      const session = toRuntimeSession(sessionId, data, new Date().toISOString());
      bus.emit('session.created', session, { sessionId, runId: sessionId });
      return session;
    },

    async load(sessionId) {
      ensureOpen();
      const data = await manager.loadSession(sessionId);
      if (!data) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const session = toRuntimeSession(sessionId, data);
      bus.emit('session.loaded', session, { sessionId, runId: sessionId });
      return session;
    },

    async list(filter) {
      ensureOpen();
      const summaries = await manager.listSessions(filter);
      return summaries.map(toRuntimeSessionSummary);
    },

    async transcript(sessionId) {
      ensureOpen();
      return manager.loadFullTranscript(sessionId);
    },

    async fork(input) {
      ensureOpen();
      const forked = await manager.forkSession(input.sessionId, {
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
        ...(input.newSessionId !== undefined ? { sessionId: input.newSessionId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      if (!forked) {
        const source = await manager.loadSession(input.sessionId);
        if (!source) return null;
        const sessionId = input.newSessionId ?? await generateSessionId();
        const data: KodaXSessionData = {
          ...source,
          title: input.title ?? source.title,
          messages: source.messages.map(cloneMessage),
        };
        await manager.storage.save(sessionId, data);
        const session = toRuntimeSession(sessionId, data);
        bus.emit('session.created', session, { sessionId, runId: sessionId });
        return session;
      }
      const session = toRuntimeSession(forked.sessionId, forked.data);
      bus.emit('session.created', session, { sessionId: forked.sessionId, runId: forked.sessionId });
      return session;
    },

    async archive(sessionId) {
      ensureOpen();
      const ok = await manager.archiveSession(sessionId);
      if (!ok) throw new Error(`Session not found or not archived: ${sessionId}`);
    },

    async unarchive(sessionId) {
      ensureOpen();
      const ok = await manager.unarchiveSession(sessionId);
      if (!ok) throw new Error(`Session not found or not unarchived: ${sessionId}`);
    },

    async delete(sessionId) {
      ensureOpen();
      const result = await manager.deleteSession(sessionId);
      assertDeleteSucceeded(sessionId, result);
    },
  };
}

function createRuntimeRunService(deps: {
  readonly bus: RuntimeEventBus;
  readonly defaultModel?: string;
  readonly defaultProvider?: string;
  readonly ensureOpen: () => void;
  readonly isClosed: () => boolean;
  readonly permissions: RuntimePermissionRegistry;
  readonly persistence: RuntimePersistence;
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
}): RuntimeRunService {
  const activeRunBySession = new Map<string, string>();
  const queueBySession = new Map<string, string[]>();

  const getRecord = (runId: string): RuntimeRunRecord => {
    const run = deps.runs.get(runId);
    if (!run) {
      throw new Error(`Runtime run not found: ${runId}`);
    }
    return run;
  };

  const startRecord = (record: RuntimeRunRecord): void => {
    if (!record.start || deps.isClosed()) {
      markRunTerminal(deps.bus, deps.persistence, record, 'cancelled');
      record.start?.resolve({
        runId: record.runId,
        sessionId: record.sessionId,
        phase: record.phase,
      });
      return;
    }
    record.phase = 'running';
    record.queuedAt = undefined;
    activeRunBySession.set(record.sessionId, record.runId);
    deps.bus.emit('run.started', statusFromRecord(record), {
      sessionId: record.sessionId,
      runId: record.runId,
    });

    const events = wrapKodaXEvents({
      bus: deps.bus,
      original: record.start.options.events,
      permissions: deps.permissions,
      record,
    });
    const runOptions = buildRunOptions({
      events,
      model: record.model,
      options: record.start.options,
      provider: record.provider,
      record,
      sessionManager: deps.sessionManager,
    });
    const finish = (result: RuntimeRunResult): RuntimeRunResult => {
      record.start?.resolve(result);
      record.start = undefined;
      activeRunBySession.delete(record.sessionId);
      drainNext(record.sessionId);
      return result;
    };

    if (record.mode === 'managed_task') {
      const abortController = new AbortController();
      record.abortController = abortController;
      const upstreamSignal = runOptions.abortSignal;
      if (upstreamSignal?.aborted) {
        abortController.abort(upstreamSignal.reason);
      } else {
        upstreamSignal?.addEventListener('abort', () => {
          abortController.abort(upstreamSignal.reason);
        }, { once: true });
      }
      void runManagedTask({
        ...runOptions,
        abortSignal: abortController.signal,
      }, record.start.prompt)
        .then((value): RuntimeRunResult => {
          const phase = record.terminalEmitted
            ? record.phase
            : value.interrupted ? 'interrupted' : value.success ? 'completed' : 'failed';
          markRunTerminal(deps.bus, deps.persistence, record, phase);
          return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, result: value };
        })
        .catch((error: unknown): RuntimeRunResult => {
          const normalized = normalizeError(error);
          const phase = record.terminalEmitted ? record.phase : 'failed';
          if (phase === 'failed') {
            record.error = normalized.message;
          }
          markRunTerminal(deps.bus, deps.persistence, record, phase);
          return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, error: normalized };
        })
        .then(finish);
      return;
    }

    const running = startKodaX(runOptions, record.start.prompt);
    record.running = running;
    void running.result
      .then((value): RuntimeRunResult => {
        const phase = record.terminalEmitted
          ? record.phase
          : value.interrupted ? 'interrupted' : value.success ? 'completed' : 'failed';
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, result: value };
      })
      .catch((error: unknown): RuntimeRunResult => {
        const normalized = normalizeError(error);
        const phase = record.terminalEmitted ? record.phase : 'failed';
        if (phase === 'failed') {
          record.error = normalized.message;
        }
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, error: normalized };
      })
      .then(finish);
  };

  const drainNext = (sessionId: string): void => {
    const queue = queueBySession.get(sessionId);
    if (!queue || queue.length === 0 || activeRunBySession.has(sessionId)) return;
    const nextRunId = queue.shift();
    if (queue.length === 0) queueBySession.delete(sessionId);
    if (!nextRunId) return;
    const next = deps.runs.get(nextRunId);
    if (!next || next.phase !== 'queued') {
      drainNext(sessionId);
      return;
    }
    startRecord(next);
  };

  const enqueue = (record: RuntimeRunRecord): void => {
    const queue = queueBySession.get(record.sessionId) ?? [];
    queue.push(record.runId);
    queueBySession.set(record.sessionId, queue);
    deps.bus.emit('run.queued', statusFromRecord(record), {
      sessionId: record.sessionId,
      runId: record.runId,
    });
  };

  return {
    async start(input) {
      deps.ensureOpen();
      const prompt = resolveRuntimePrompt(input);
      const session = await deps.sessionManager.loadSession(input.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }
      const options = input.options ?? {};
      const provider = options.provider ?? deps.defaultProvider;
      if (!provider) {
        throw new Error('runtime.runs.start requires input.options.provider or runtime defaultProvider');
      }
      const model = options.modelOverride ?? options.model ?? deps.defaultModel;
      const runId = createRunId();
      const startedAt = new Date().toISOString();
      let resolveResult: (result: RuntimeRunResult) => void = () => undefined;
      const result = new Promise<RuntimeRunResult>((resolve) => {
        resolveResult = resolve;
      });
      const isQueued = activeRunBySession.has(input.sessionId);
      const record: RuntimeRunRecord = {
        runId,
        sessionId: input.sessionId,
        phase: isQueued ? 'queued' : 'running',
        startedAt,
        ...(isQueued ? { queuedAt: startedAt } : {}),
        provider,
        ...(model !== undefined ? { model } : {}),
        ...(options.reasoningMode !== undefined ? { reasoning: options.reasoningMode } : {}),
        mode: input.mode ?? 'coding',
        start: {
          prompt,
          options,
          resolve: resolveResult,
        },
        terminalEmitted: false,
      };
      deps.runs.set(runId, record);
      if (isQueued) {
        enqueue(record);
      } else {
        startRecord(record);
      }

      return {
        runId,
        sessionId: input.sessionId,
        get turnId() {
          return record.turnId;
        },
        result,
      };
    },

    async get(runId) {
      deps.ensureOpen();
      return statusFromRecord(getRecord(runId));
    },

    async list(filter) {
      deps.ensureOpen();
      return [...deps.runs.values()]
        .filter((run) => runMatchesFilter(run, filter))
        .map(statusFromRecord);
    },

    async abort(runId) {
      deps.ensureOpen();
      const run = getRecord(runId);
      if (run.phase === 'queued') {
        removeQueuedRun(queueBySession, run);
        markRunTerminal(deps.bus, deps.persistence, run, 'cancelled');
        run.start?.resolve({ runId, sessionId: run.sessionId, phase: run.phase });
        run.start = undefined;
        return;
      }
      if (!isActiveRunPhase(run.phase)) return;
      run.running?.abort(new Error('runtime run aborted'));
      run.abortController?.abort(new Error('runtime run aborted'));
      markRunTerminal(deps.bus, deps.persistence, run, 'cancelled');
    },

    async setModel(runId, model) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.model = model;
      run.running?.setModel(model);
    },

    async setProvider(runId, provider) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.provider = provider;
      run.running?.setProvider(provider);
    },

    async setReasoning(runId, reasoning) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.reasoning = reasoning;
      run.running?.setReasoning(reasoning);
    },
  };
}

function createRuntimeWorkflowService(): RuntimeWorkflowService {
  const manager = getDefaultWorkflowRunManager();
  return {
    async list(filter) {
      const list = manager.list();
      const filtered = filter?.runId
        ? list.filter((item) => item.runId === filter.runId)
        : list;
      return filter?.limit === undefined ? filtered : filtered.slice(0, filter.limit);
    },

    async get(runId) {
      return manager.getWorkflowProcessSnapshot(runId);
    },

    subscribe(filter, listener) {
      const unsubscribe = manager.subscribeWorkflowProcess((event) => {
        if (filter.runId && event.snapshot.runId !== filter.runId) return;
        if (filter.activeOnly === true && isFinalWorkflowStatus(event.snapshot.status)) return;
        listener(event);
      });
      return { close: unsubscribe };
    },

    async pause(runId) {
      return manager.pause(runId);
    },

    async resume(runId) {
      return manager.resume(runId);
    },

    async stop(runId) {
      return manager.stop(runId);
    },
  };
}

function buildRunOptions(input: {
  readonly events: KodaXEvents;
  readonly model?: string;
  readonly options: RuntimeKodaXOptions;
  readonly provider: string;
  readonly record: RuntimeRunRecord;
  readonly sessionManager: SessionManager;
}): KodaXOptions {
  const { events, model, options, provider, record, sessionManager } = input;
  return {
    ...options,
    provider,
    ...(model !== undefined ? { modelOverride: model } : {}),
    session: {
      ...(options.session ?? {}),
      id: record.sessionId,
      storage: sessionManager.storage,
    },
    events,
  };
}

function createRuntimeStatusService(deps: {
  readonly identity: RuntimeIdentity;
  readonly permissions: RuntimePermissionRegistry;
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
  readonly workflows: RuntimeWorkflowService;
}): RuntimeStatusService {
  return {
    async snapshot() {
      return {
        runtimeId: deps.identity.runtimeId,
        mode: deps.identity.mode,
        profile: deps.identity.profile,
        startedAt: deps.identity.startedAt,
        sessions: (await deps.sessionManager.listSessions({ includeArchived: true }))
          .map(toRuntimeSessionSummary),
        runs: [...deps.runs.values()].map(statusFromRecord),
        pendingPermissions: await deps.permissions.service.listPending(),
        workflows: await deps.workflows.list({}),
      };
    },
  };
}

function isActiveRunPhase(phase: RuntimeRunPhase): boolean {
  return phase === 'running'
    || phase === 'waiting_permission'
    || phase === 'waiting_user_input';
}

function removeQueuedRun(queueBySession: Map<string, string[]>, run: RuntimeRunRecord): void {
  const queue = queueBySession.get(run.sessionId);
  if (!queue) return;
  const next = queue.filter((runId) => runId !== run.runId);
  if (next.length === 0) {
    queueBySession.delete(run.sessionId);
  } else {
    queueBySession.set(run.sessionId, next);
  }
}

function createRuntimeEventBus(persistence: RuntimePersistence) {
  let nextSeq = 1;
  let closed = false;
  const events: RuntimeEvent[] = [];
  const subscribers = new Set<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }>();

  const matches = (event: RuntimeEvent, filter: RuntimeEventFilter | undefined): boolean => {
    if (!filter) return true;
    if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
    if (filter.runId !== undefined && event.runId !== filter.runId) return false;
    if (filter.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.includes(event.type)) return false;
    }
    return true;
  };

  const service: RuntimeEventService = {
    subscribe(filter, listener) {
      if (closed) {
        throw new Error('KodaX runtime event bus is closed');
      }
      const subscriber = { filter, listener };
      subscribers.add(subscriber);
      return {
        close() {
          subscribers.delete(subscriber);
        },
      };
    },

    async replay(filter) {
      const source = persistence.replay(filter);
      const replayEvents = source.length > 0 ? source : events;
      const matched = replayEvents.filter((event) => (
        matches(event, filter)
        && (filter?.sinceSeq === undefined || event.seq > filter.sinceSeq)
      ));
      return filter?.limit === undefined ? matched : matched.slice(-filter.limit);
    },
  };

  return {
    service,
    emit(
      type: RuntimeEventType,
      payload: unknown,
      scope: { readonly sessionId: string; readonly runId: string; readonly turnId?: string },
    ): RuntimeEvent {
      const event: RuntimeEvent = {
        id: `evt_${nextSeq}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        seq: nextSeq,
        time: new Date().toISOString(),
        sessionId: scope.sessionId,
        runId: scope.runId,
        ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
        type,
        payload,
      };
      nextSeq += 1;
      events.push(event);
      try {
        persistence.appendEvent(event);
      } catch (error: unknown) {
        const warning: RuntimeEvent = {
          id: `evt_${nextSeq}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
          seq: nextSeq,
          time: new Date().toISOString(),
          sessionId: scope.sessionId,
          runId: scope.runId,
          ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
          type: 'runtime.warning',
          payload: {
            message: normalizeError(error).message,
            sourceEventId: event.id,
          },
        };
        nextSeq += 1;
        events.push(warning);
      }
      for (const subscriber of subscribers) {
        if (matches(event, subscriber.filter)) {
          subscriber.listener(event);
        }
      }
      return event;
    },
    close() {
      closed = true;
      subscribers.clear();
    },
  };
}

function createRuntimePersistence(options: CreateKodaXRuntimeOptions): RuntimePersistence {
  const baseDir = options.homeDir
    ? path.resolve(options.homeDir)
    : options.sessionsDir
      ? path.resolve(options.sessionsDir, '..')
      : process.cwd();
  const runtimeDir = path.join(baseDir, '.kodax', 'runtime');
  const runsDir = path.join(runtimeDir, 'runs');

  const runDir = (runId: string): string => path.join(runsDir, encodeURIComponent(runId));
  const eventFile = (runId: string): string => path.join(runDir(runId), 'events.jsonl');
  const statusFile = (runId: string): string => path.join(runDir(runId), 'status.json');

  const readEventsFromFile = (file: string): RuntimeEvent[] => {
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf-8');
    const events: RuntimeEvent[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as RuntimeEvent;
      events.push(parsed);
    }
    return events;
  };

  return {
    runtimeDir,
    appendEvent(event) {
      const dir = runDir(event.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(eventFile(event.runId), `${JSON.stringify(event)}\n`, 'utf-8');
    },
    replay(filter) {
      if (filter?.runId) {
        return readEventsFromFile(eventFile(filter.runId)).filter((event) => eventMatchesReplayFilter(event, filter));
      }
      if (!fs.existsSync(runsDir)) return [];
      const result: RuntimeEvent[] = [];
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        result.push(...readEventsFromFile(path.join(runsDir, entry.name, 'events.jsonl')));
      }
      return result
        .filter((event) => eventMatchesReplayFilter(event, filter))
        .sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);
    },
    saveRunStatus(status) {
      const dir = runDir(status.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statusFile(status.runId), JSON.stringify(status, null, 2), 'utf-8');
    },
    loadRunStatuses() {
      if (!fs.existsSync(runsDir)) return [];
      const statuses: RuntimeRunStatus[] = [];
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(runsDir, entry.name, 'status.json');
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RuntimeRunStatus;
        statuses.push(parsed);
      }
      return statuses;
    },
  };
}

function eventMatchesReplayFilter(
  event: RuntimeEvent,
  filter: RuntimeEventReplayFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) return false;
  return true;
}

function recordFromPersistedStatus(status: RuntimeRunStatus): RuntimeRunRecord {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    ...(status.turnId !== undefined ? { turnId: status.turnId } : {}),
    phase: status.phase,
    startedAt: status.startedAt,
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    provider: status.provider,
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.reasoning !== undefined ? { reasoning: status.reasoning } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
    mode: 'coding',
    terminalEmitted: isTerminalRunPhase(status.phase),
  };
}

function createRuntimePermissionRegistry(bus: RuntimeEventBus, defaultTimeoutMs: number) {
  const pending = new Map<string, PendingPermission>();

  const trackAndWait = (
    request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
    timeoutMs = defaultTimeoutMs,
  ): {
    readonly request: RuntimePermissionRequest;
    readonly response: Promise<RuntimePermissionDecision>;
  } => {
    let resolveResponse: (decision: RuntimePermissionDecision) => void = () => {};
    const response = new Promise<RuntimePermissionDecision>((resolve) => {
      resolveResponse = resolve;
    });
    const created = createPendingPermission(request, [resolveResponse], timeoutMs);
    return { request: created, response };
  };

  const resolvePending = (requestId: string, decision: RuntimePermissionDecision): boolean => {
    const item = pending.get(requestId);
    if (!item) return false;
    pending.delete(requestId);
    if (item.timer) clearTimeout(item.timer);
    for (const resolve of item.waiters) resolve(decision);
    bus.emit('permission.resolved', { requestId, decision }, {
      sessionId: item.request.sessionId,
      runId: item.request.runId,
      ...(item.request.turnId !== undefined ? { turnId: item.request.turnId } : {}),
    });
    return true;
  };

  const service: RuntimePermissionService = {
    request(input) {
      const pendingPermission = trackAndWait({
        sessionId: input.sessionId,
        runId: input.runId,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.risk !== undefined ? { risk: input.risk } : {}),
        ...(input.inputPreview !== undefined ? { inputPreview: input.inputPreview } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }, input.timeoutMs ?? defaultTimeoutMs);
      return pendingPermission.response;
    },

    async listPending(filter) {
      return [...pending.values()]
        .map((item) => item.request)
        .filter((request) => permissionMatchesFilter(request, filter));
    },

    async respond(requestId, decision) {
      return resolvePending(requestId, decision);
    },
  };

  return {
    service,
    track(request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>): RuntimePermissionRequest {
      const created = createPendingPermission(request, []);
      return created;
    },
    trackAndWait(
      request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
      timeoutMs = defaultTimeoutMs,
    ) {
      return trackAndWait(request, timeoutMs);
    },
    resolve(requestId: string, decision: RuntimePermissionDecision): void {
      resolvePending(requestId, decision);
    },
  };

  function createPendingPermission(
    request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
    waiters: Array<(decision: RuntimePermissionDecision) => void>,
    timeoutMs = defaultTimeoutMs,
  ): RuntimePermissionRequest {
    const created: RuntimePermissionRequest = {
      ...request,
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          const item = pending.get(created.id);
          if (!item) return;
          pending.delete(created.id);
          const decision: RuntimePermissionDecision = {
            type: 'reject',
            reason: 'permission request timed out',
          };
          for (const resolve of item.waiters) resolve(decision);
          bus.emit('permission.resolved', { requestId: created.id, decision }, {
            sessionId: created.sessionId,
            runId: created.runId,
            ...(created.turnId !== undefined ? { turnId: created.turnId } : {}),
          });
        }, timeoutMs)
      : undefined;
    pending.set(created.id, {
      request: created,
      waiters,
      ...(timer !== undefined ? { timer } : {}),
    });
    bus.emit('permission.requested', created, {
      sessionId: created.sessionId,
      runId: created.runId,
      ...(created.turnId !== undefined ? { turnId: created.turnId } : {}),
    });
    return created;
  }
}

function wrapKodaXEvents(input: {
  readonly bus: RuntimeEventBus;
  readonly original?: KodaXEvents;
  readonly permissions: RuntimePermissionRegistry;
  readonly record: RuntimeRunRecord;
}): KodaXEvents {
  const { bus, original, permissions, record } = input;
  const scopeFromMeta = (meta?: Partial<KodaXActivityEventMeta>) => ({
    sessionId: meta?.sessionId ?? record.sessionId,
    runId: record.runId,
    turnId: meta?.turnId ?? record.turnId,
  });
  const emit = (
    type: RuntimeEventType,
    payload: unknown,
    meta?: Partial<KodaXActivityEventMeta>,
  ): void => {
    bus.emit(type, payload, scopeFromMeta(meta));
  };

  return {
    ...original,
    onTextDelta(text, meta) {
      emit('assistant.delta', { text, meta }, meta);
      original?.onTextDelta?.(text, meta);
    },
    onThinkingDelta(text, meta) {
      emit('thinking.delta', { text, meta }, meta);
      original?.onThinkingDelta?.(text, meta);
    },
    onToolUseStart(tool, meta) {
      emit('tool.started', { tool, meta }, meta);
      original?.onToolUseStart?.(tool, meta);
    },
    onToolProgress(update, meta) {
      emit('tool.progress', { update, meta }, meta);
      original?.onToolProgress?.(update, meta);
    },
    onToolInputDelta(toolName, partialJson, meta) {
      emit('tool.progress', { toolName, partialJson, meta }, meta);
      original?.onToolInputDelta?.(toolName, partialJson, meta);
    },
    onToolResult(result, meta) {
      emit('tool.finished', { result, meta }, meta);
      original?.onToolResult?.(result, meta);
    },
    onSessionStart(info) {
      record.provider = info.provider;
      bus.emit('session.loaded', info, {
        sessionId: info.sessionId,
        runId: record.runId,
        turnId: info.turnId ?? record.turnId,
      });
      original?.onSessionStart?.(info);
    },
    onTurnStarted(event) {
      record.turnId = event.turnId;
      bus.emit('turn.started', event, {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnStarted?.(event);
    },
    onTurnCompleted(event) {
      original?.onTurnCompleted?.(event);
    },
    onTurnFailed(event) {
      original?.onTurnFailed?.(event);
    },
    onEffectiveConfig(config) {
      emit('config.effective', config, config);
      original?.onEffectiveConfig?.(config);
    },
    onWorkflowProcessEvent(event) {
      const mapped = workflowEventType(event);
      bus.emit(mapped, event, {
        sessionId: event.snapshot.hostMetadata?.sessionId ?? record.sessionId,
        runId: record.runId,
        turnId: record.turnId,
      });
      original?.onWorkflowProcessEvent?.(event);
    },
    onComplete(meta) {
      original?.onComplete?.(meta);
    },
    onError(error, meta) {
      original?.onError?.(error, meta);
    },
    beforeToolExecute: async (
      tool: string,
      toolInput: Record<string, unknown>,
      meta?: KodaXToolEventMeta,
    ): Promise<RuntimePermissionToolDecision> => {
      const previousPhase = record.phase;
      if (record.phase === 'running') {
        record.phase = 'waiting_permission';
      }
      const pendingPermission = permissions.trackAndWait({
        sessionId: meta?.sessionId ?? record.sessionId,
        runId: record.runId,
        ...(meta?.turnId ?? record.turnId ? { turnId: meta?.turnId ?? record.turnId } : {}),
        ...(meta?.toolId ? { toolCallId: meta.toolId } : {}),
        toolName: tool,
        inputPreview: previewInput(toolInput),
      });
      try {
        if (!original?.beforeToolExecute) {
          const decision = await pendingPermission.response;
          return decisionToToolDecision(decision);
        }
        const hookDecision = Promise.resolve(original.beforeToolExecute(tool, toolInput, meta))
          .then((decision): RuntimePermissionRaceResult => ({
            source: 'hook',
            decision,
          }));
        const runtimeDecision = pendingPermission.response
          .then((decision): RuntimePermissionRaceResult => ({
            source: 'runtime',
            decision: decisionToToolDecision(decision),
          }));
        const result = await Promise.race([hookDecision, runtimeDecision]);
        if (result.source === 'hook') {
          permissions.resolve(
            pendingPermission.request.id,
            decisionToPermissionDecision(result.decision),
          );
        }
        return result.decision;
      } catch (error: unknown) {
        permissions.resolve(pendingPermission.request.id, {
          type: 'reject',
          reason: normalizeError(error).message,
        });
        throw error;
      } finally {
        if (record.phase === 'waiting_permission') {
          record.phase = previousPhase === 'queued' ? 'running' : previousPhase;
        }
      }
    },
    ...(original?.askUser
      ? {
          askUser: (
            options: AskUserQuestionOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<AskUserAnswer> => original.askUser!(options, meta),
        }
      : {}),
    ...(original?.askUserMulti
      ? {
          askUserMulti: (
            options: AskUserMultiOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<Record<string, AskUserAnswer> | undefined> =>
            original.askUserMulti!(options, meta),
        }
      : {}),
    ...(original?.askUserInput
      ? {
          askUserInput: (
            options: { question: string; default?: string },
            meta?: KodaXToolEventMeta,
          ): Promise<string | undefined> => original.askUserInput!(options, meta),
        }
      : {}),
  };
}

function buildSessionRuntimeInfo(
  input: RuntimeCreateSessionInput,
  projectPath: string | undefined,
  gitRoot: string | undefined,
): KodaXSessionRuntimeInfo | undefined {
  const info: KodaXSessionRuntimeInfo = {
    ...(gitRoot !== undefined ? { canonicalRepoRoot: gitRoot } : {}),
    ...(projectPath !== undefined ? { workspaceRoot: projectPath, executionCwd: projectPath } : {}),
    ...(projectPath !== undefined ? { workspaceKind: 'managed' } : {}),
    ...(input.surface !== undefined ? { surface: input.surface } : {}),
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

function toRuntimeSessionSummary(summary: SessionSummary): RuntimeSessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    msgCount: summary.msgCount,
    ...(summary.runtimeInfo?.gitRoot ? { gitRoot: summary.runtimeInfo.gitRoot } : {}),
    ...(summary.runtimeInfo?.workspaceRoot ? { workspaceRoot: summary.runtimeInfo.workspaceRoot } : {}),
    ...(summary.runtimeInfo?.surface ? { surface: summary.runtimeInfo.surface } : {}),
    ...(summary.runtimeInfo?.profileId ? { profileId: summary.runtimeInfo.profileId } : {}),
    ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
    ...(summary.tag !== undefined ? { tag: summary.tag } : {}),
    ...(summary.projectKey !== undefined ? { projectKey: summary.projectKey } : {}),
    ...(summary.archived === true ? { archived: true } : {}),
  };
}

function resolveRuntimePrompt(input: RuntimeStartRunInput): string {
  if (input.prompt !== undefined) return input.prompt;
  if (input.input?.type === 'text') return input.input.text;
  throw new Error('runtime.runs.start requires prompt or text input');
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function statusFromRecord(run: RuntimeRunRecord): RuntimeRunStatus {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    phase: run.phase,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    provider: run.provider,
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function runMatchesFilter(
  run: RuntimeRunRecord,
  filter: RuntimeRunFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && run.sessionId !== filter.sessionId) return false;
  if (filter.phase !== undefined) {
    const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
    if (!phases.includes(run.phase)) return false;
  }
  return true;
}

function markRunTerminal(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord,
  phase: RuntimeRunPhase,
): void {
  if (run.terminalEmitted) return;
  run.phase = phase;
  run.endedAt = new Date().toISOString();
  run.terminalEmitted = true;
  const type: RuntimeEventType =
    phase === 'completed'
      ? 'run.completed'
      : phase === 'cancelled'
        ? 'run.cancelled'
        : phase === 'interrupted'
          ? 'run.interrupted'
          : 'run.failed';
  bus.emit(type, statusFromRecord(run), {
    sessionId: run.sessionId,
    runId: run.runId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
  });
  persistence.saveRunStatus(statusFromRecord(run));
}

function isTerminalRunPhase(phase: RuntimeRunPhase): boolean {
  return phase === 'completed'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'interrupted';
}

function workflowEventType(event: WorkflowProcessEvent): RuntimeEventType {
  if (event.type === 'workflow_started') return 'workflow.started';
  if (event.type === 'workflow_finished') return 'workflow.finished';
  return 'workflow.updated';
}

function isFinalWorkflowStatus(status: WorkflowProcessSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function permissionMatchesFilter(
  request: RuntimePermissionRequest,
  filter: RuntimePermissionFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && request.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && request.runId !== filter.runId) return false;
  if (filter.toolName !== undefined && request.toolName !== filter.toolName) return false;
  return true;
}

function decisionToPermissionDecision(decision: boolean | string): RuntimePermissionDecision {
  if (decision === true) return { type: 'allow_once' };
  return {
    type: 'reject',
    reason: decision === false ? 'tool execution rejected' : decision,
  };
}

type RuntimePermissionRaceResult =
  | { readonly source: 'hook'; readonly decision: RuntimePermissionToolDecision }
  | { readonly source: 'runtime'; readonly decision: RuntimePermissionToolDecision };

function decisionToToolDecision(
  decision: RuntimePermissionDecision | undefined,
): RuntimePermissionToolDecision {
  if (!decision) return false;
  if (decision.type === 'allow_once' || decision.type === 'allow_always') return true;
  return decision.reason ?? false;
}

function previewInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length <= 500 ? json : `${json.slice(0, 497)}...`;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertDeleteSucceeded(sessionId: string, result: DeleteSessionResult): void {
  if ('ok' in result) return;
  throw new Error(`Session is running and cannot be deleted: ${sessionId}`);
}

function cloneMessage(message: KodaXMessage): KodaXMessage {
  return structuredClone(message);
}

export type {
  KodaXMessage,
  KodaXResult,
  KodaXEvents,
  SessionTranscriptEntry,
};
