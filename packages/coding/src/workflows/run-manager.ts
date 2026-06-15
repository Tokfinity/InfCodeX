import type {
  WorkflowEvent,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
  WorkflowProcessTracker,
  WorkflowRunState,
} from '@kodax-ai/agent';
import {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
} from '@kodax-ai/agent';

import {
  clampWorkflowLimits,
  runWorkflowFromOptions,
  runWorkflowModule,
  type RunWorkflowFromOptionsInput,
  type RunWorkflowModuleOptions,
  type RunWorkflowModuleOutcome,
} from './workflow-runner.js';

export type ManagedWorkflowStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'stopped';

export interface ManagedWorkflowSnapshot {
  readonly runId: string;
  readonly workflow: string;
  readonly status: ManagedWorkflowStatus;
  readonly runDir: string;
  readonly totalSpawned: number;
  readonly eventCount: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly resultText?: string;
}

export interface ManagedWorkflowRun {
  readonly runId: string;
  readonly done: Promise<RunWorkflowModuleOutcome>;
  readonly getSnapshot?: () => ManagedWorkflowSnapshot | undefined;
  readonly getProcessSnapshot?: () => WorkflowProcessSnapshot | undefined;
}

interface MutableRun {
  runId: string;
  workflow: string;
  status: ManagedWorkflowStatus;
  runDir: string;
  totalSpawned: number;
  eventCount: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  resultText?: string;
  controller: AbortController;
  pauseWaiters: Array<() => void>;
  process: WorkflowProcessTracker;
}

export interface WorkflowRunManager {
  start(opts: RunWorkflowModuleOptions): ManagedWorkflowRun;
  startFromOptions(input: RunWorkflowFromOptionsInput): ManagedWorkflowRun;
  list(): readonly ManagedWorkflowSnapshot[];
  get(runId: string): ManagedWorkflowSnapshot | undefined;
  subscribeWorkflowProcess(listener: (event: WorkflowProcessEvent) => void): () => void;
  getWorkflowProcessSnapshot(runId: string): WorkflowProcessSnapshot | undefined;
  listWorkflowProcessSnapshots(options?: { readonly activeOnly?: boolean; readonly limit?: number }): readonly WorkflowProcessSnapshot[];
  pause(runId: string): boolean;
  resume(runId: string): boolean;
  stop(runId: string, reason?: string): boolean;
}

function snapshot(run: MutableRun): ManagedWorkflowSnapshot {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    runDir: run.runDir,
    totalSpawned: run.totalSpawned,
    eventCount: run.eventCount,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.resultText !== undefined ? { resultText: run.resultText } : {}),
  };
}

function terminalStatus(outcome: RunWorkflowModuleOutcome, aborted: boolean): ManagedWorkflowStatus {
  if (aborted) return 'stopped';
  if (outcome.kind === 'completed') return 'completed';
  if (outcome.kind === 'denied') return 'denied';
  return 'failed';
}

function resultText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const synthesis = record.synthesis;
  if (typeof synthesis === 'string' && synthesis.trim().length > 0) return synthesis;
  if (typeof synthesis === 'object' && synthesis !== null) {
    const text = (synthesis as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  for (const key of ['summary', 'report', 'text', 'result']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function failedOutcome(run: MutableRun, error: unknown): RunWorkflowModuleOutcome {
  const err = toError(error);
  const state: WorkflowRunState = {
    runId: run.runId,
    status: 'failed',
    totalSpawned: run.totalSpawned,
    events: [],
    artifacts: [],
  };
  return { kind: 'failed', error: err, state };
}

export function createWorkflowRunManager(
  deps: { readonly now?: () => number } = {},
): WorkflowRunManager {
  const now = deps.now ?? (() => Date.now());
  const runs = new Map<string, MutableRun>();
  const subscribers = new Set<(event: WorkflowProcessEvent) => void>();
  const isoNow = (): string => new Date(now()).toISOString();

  const notifyProcess = (event: WorkflowProcessEvent): void => {
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {
        // Process subscribers are observers. A host panel must not break the
        // workflow runner or durable event writer.
      }
    }
  };

  const waitIfPaused = async (run: MutableRun): Promise<void> => {
    while (run.status === 'paused' && !run.controller.signal.aborted) {
      await new Promise<void>((resolve) => run.pauseWaiters.push(resolve));
    }
    if (run.controller.signal.aborted) {
      throw new Error('workflow stopped');
    }
  };

  const releasePauseWaiters = (run: MutableRun): void => {
    const waiters = run.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  const onEvent = (
    run: MutableRun,
    original: ((event: WorkflowEvent) => void) | undefined,
  ) => (event: WorkflowEvent): void => {
    run.eventCount += 1;
    if (event.type === 'agent_spawned') run.totalSpawned += 1;
    notifyProcess(run.process.applyEvent(event));
    original?.(event);
  };

  const createRun = (
    opts: {
      readonly runId: string;
      readonly workflow: string;
      readonly phases?: readonly string[];
      readonly maxAgents?: number;
      readonly plannedAgents?: number;
      readonly tokenBudget?: number;
    },
    runDir: string,
    signal: AbortSignal | undefined,
  ): MutableRun => {
    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const run: MutableRun = {
      runId: opts.runId,
      workflow: opts.workflow,
      status: 'running',
      runDir,
      totalSpawned: 0,
      eventCount: 0,
      startedAt: now(),
      controller,
      pauseWaiters: [],
      process: createWorkflowProcessTracker({
        runId: opts.runId,
        workflowName: opts.workflow,
        displayName: opts.workflow,
        ...(opts.phases !== undefined ? { phases: opts.phases } : {}),
        ...(opts.maxAgents !== undefined ? { maxAgents: opts.maxAgents } : {}),
        ...(opts.plannedAgents !== undefined ? { plannedAgents: opts.plannedAgents } : {}),
        ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        now: isoNow,
      }),
    };
    runs.set(opts.runId, run);
    return run;
  };

  const settle = (
    run: MutableRun,
    outcome: RunWorkflowModuleOutcome,
  ): RunWorkflowModuleOutcome => {
    run.status = terminalStatus(outcome, run.controller.signal.aborted || run.status === 'stopped');
    run.endedAt = now();
    if (outcome.kind === 'failed' && run.status !== 'stopped') run.error = outcome.error.message;
    if (outcome.kind === 'completed') run.resultText = resultText(outcome.result);
    if (outcome.kind === 'completed' && run.resultText !== undefined) {
      notifyProcess(run.process.setResultSummary(run.resultText));
    } else if (outcome.kind === 'failed' && !isFinalWorkflowProcessStatus(run.process.getSnapshot().status)) {
      notifyProcess(run.process.setStatus('failed', outcome.error.message));
    } else if (outcome.kind === 'denied') {
      notifyProcess(run.process.setStatus('cancelled', 'workflow denied'));
    } else if (run.status === 'stopped' && run.process.getSnapshot().status !== 'cancelled') {
      notifyProcess(run.process.setStatus('cancelled', 'workflow stopped'));
    }
    releasePauseWaiters(run);
    return outcome;
  };

  return {
    start: (opts) => {
      const limits = clampWorkflowLimits(opts.module.meta, opts.hostPolicy);
      const run = createRun({
        runId: opts.runId,
        workflow: opts.module.meta.name,
        ...(opts.module.meta.phases !== undefined ? { phases: opts.module.meta.phases } : {}),
        ...(limits.maxAgents !== undefined ? { maxAgents: limits.maxAgents } : {}),
        ...(opts.module.meta.plannedAgents !== undefined
          ? { plannedAgents: opts.module.meta.plannedAgents }
          : {}),
        ...(limits.tokenBudget !== undefined ? { tokenBudget: limits.tokenBudget } : {}),
      }, opts.runDir, opts.signal);
      const done = runWorkflowModule({
        ...opts,
        signal: run.controller.signal,
        beforeSpawn: () => waitIfPaused(run),
        onEvent: onEvent(run, opts.onEvent),
      })
        .catch((error: unknown) => failedOutcome(run, error))
        .then((outcome) => settle(run, outcome));
      return {
        runId: run.runId,
        done,
        getSnapshot: () => snapshot(run),
        getProcessSnapshot: () => run.process.getSnapshot(),
      };
    },

    startFromOptions: (input) => {
      const limits = clampWorkflowLimits(input.module.meta, input.options.workflowHostPolicy);
      const run = createRun({
        runId: input.runId,
        workflow: input.module.meta.name,
        ...(input.module.meta.phases !== undefined ? { phases: input.module.meta.phases } : {}),
        ...(limits.maxAgents !== undefined ? { maxAgents: limits.maxAgents } : {}),
        ...(input.module.meta.plannedAgents !== undefined
          ? { plannedAgents: input.module.meta.plannedAgents }
          : {}),
        ...(limits.tokenBudget !== undefined ? { tokenBudget: limits.tokenBudget } : {}),
      }, input.runDir, input.signal);
      const done = runWorkflowFromOptions({
        ...input,
        signal: run.controller.signal,
        beforeSpawn: () => waitIfPaused(run),
        onEvent: onEvent(run, input.onEvent),
      })
        .catch((error: unknown) => failedOutcome(run, error))
        .then((outcome) => settle(run, outcome));
      return {
        runId: run.runId,
        done,
        getSnapshot: () => snapshot(run),
        getProcessSnapshot: () => run.process.getSnapshot(),
      };
    },

    list: () =>
      [...runs.values()]
        .map(snapshot)
        .sort((a, b) => b.startedAt - a.startedAt),

    get: (runId) => {
      const run = runs.get(runId);
      return run ? snapshot(run) : undefined;
    },

    subscribeWorkflowProcess: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    getWorkflowProcessSnapshot: (runId) => runs.get(runId)?.process.getSnapshot(),

    listWorkflowProcessSnapshots: (options) => {
      const snapshots = [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((run) => run.process.getSnapshot())
        .filter((process) =>
          options?.activeOnly === true ? !isFinalWorkflowProcessStatus(process.status) : true,
        );
      return options?.limit === undefined ? snapshots : snapshots.slice(0, options.limit);
    },

    pause: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'running') return false;
      run.status = 'paused';
      notifyProcess(run.process.setStatus('paused', 'workflow paused'));
      return true;
    },

    resume: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'paused') return false;
      run.status = 'running';
      notifyProcess(run.process.setStatus('running', 'workflow resumed'));
      releasePauseWaiters(run);
      return true;
    },

    stop: (runId, reason) => {
      const run = runs.get(runId);
      if (!run || ['completed', 'failed', 'denied', 'stopped'].includes(run.status)) return false;
      run.status = 'stopped';
      notifyProcess(run.process.setStatus('cancelled', reason ?? 'workflow stopped'));
      run.controller.abort();
      releasePauseWaiters(run);
      return true;
    },
  };
}

let defaultWorkflowRunManager: WorkflowRunManager | undefined;

export function getDefaultWorkflowRunManager(): WorkflowRunManager {
  defaultWorkflowRunManager ??= createWorkflowRunManager();
  return defaultWorkflowRunManager;
}
