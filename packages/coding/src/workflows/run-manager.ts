import type { WorkflowEvent } from '@kodax-ai/agent';

import {
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
}

export interface WorkflowRunManager {
  start(opts: RunWorkflowModuleOptions): ManagedWorkflowRun;
  startFromOptions(input: RunWorkflowFromOptionsInput): ManagedWorkflowRun;
  list(): readonly ManagedWorkflowSnapshot[];
  get(runId: string): ManagedWorkflowSnapshot | undefined;
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

export function createWorkflowRunManager(
  deps: { readonly now?: () => number } = {},
): WorkflowRunManager {
  const now = deps.now ?? (() => Date.now());
  const runs = new Map<string, MutableRun>();

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
    original?.(event);
  };

  const createRun = (
    runId: string,
    workflow: string,
    runDir: string,
    signal: AbortSignal | undefined,
  ): MutableRun => {
    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const run: MutableRun = {
      runId,
      workflow,
      status: 'running',
      runDir,
      totalSpawned: 0,
      eventCount: 0,
      startedAt: now(),
      controller,
      pauseWaiters: [],
    };
    runs.set(runId, run);
    return run;
  };

  const settle = (
    run: MutableRun,
    outcome: RunWorkflowModuleOutcome,
  ): RunWorkflowModuleOutcome => {
    run.status = terminalStatus(outcome, run.controller.signal.aborted || run.status === 'stopped');
    run.endedAt = now();
    if (outcome.kind === 'failed') run.error = outcome.error.message;
    if (outcome.kind === 'completed') run.resultText = resultText(outcome.result);
    releasePauseWaiters(run);
    return outcome;
  };

  return {
    start: (opts) => {
      const run = createRun(opts.runId, opts.module.meta.name, opts.runDir, opts.signal);
      const done = runWorkflowModule({
        ...opts,
        signal: run.controller.signal,
        beforeSpawn: () => waitIfPaused(run),
        onEvent: onEvent(run, opts.onEvent),
      }).then((outcome) => settle(run, outcome));
      return { runId: run.runId, done };
    },

    startFromOptions: (input) => {
      const run = createRun(input.runId, input.module.meta.name, input.runDir, input.signal);
      const done = runWorkflowFromOptions({
        ...input,
        signal: run.controller.signal,
        beforeSpawn: () => waitIfPaused(run),
        onEvent: onEvent(run, input.onEvent),
      }).then((outcome) => settle(run, outcome));
      return { runId: run.runId, done };
    },

    list: () =>
      [...runs.values()]
        .map(snapshot)
        .sort((a, b) => b.startedAt - a.startedAt),

    get: (runId) => {
      const run = runs.get(runId);
      return run ? snapshot(run) : undefined;
    },

    pause: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'running') return false;
      run.status = 'paused';
      return true;
    },

    resume: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'paused') return false;
      run.status = 'running';
      releasePauseWaiters(run);
      return true;
    },

    stop: (runId) => {
      const run = runs.get(runId);
      if (!run || ['completed', 'failed', 'denied', 'stopped'].includes(run.status)) return false;
      run.status = 'stopped';
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
