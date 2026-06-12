/**
 * FEATURE_217 (v0.7.49) — Workflow runtime: concurrency gate, agent cap,
 * budget accounting, event recording.
 *
 * The runtime is the orchestration engine. It wraps an injected
 * `WorkflowAgentBackend` with: a maxAgents lifetime cap, a maxConcurrency
 * in-flight gate (for runAgent / parallel), token-budget accounting (NOT
 * hard-enforced in this slice), abort handling, and an append-only event
 * log. It has zero `@kodax-ai/coding` dependency.
 */

import type { WorkflowEvent, WorkflowEventType } from './events.js';
import { WorkflowEventRecorder } from './events.js';
import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowBudget,
  WorkflowAgentBackend,
  WorkflowLimits,
  WorkflowLogEvent,
  WorkflowParallelOptions,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowSpawnAgentInput,
  WorkflowSynthesizeInput,
  WorkflowSynthesis,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowWaitOptions,
} from './types.js';

/** Thrown when the workflow's abort signal fires mid-run. */
export class WorkflowAbortError extends Error {
  constructor(message = 'Workflow aborted') {
    super(message);
    this.name = 'WorkflowAbortError';
  }
}

/** Thrown when a spawn would exceed the run's maxAgents lifetime cap. */
export class WorkflowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowLimitError';
  }
}

/** Capacity-bounded async semaphore. `Infinity` capacity never blocks. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}

/**
 * Run lazy thunks with a bounded number in flight, preserving result
 * order by index. Aborts launching new thunks once `signal` fires.
 */
async function runPool<T>(
  thunks: readonly (() => Promise<T>)[],
  concurrency: number,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new WorkflowAbortError();
      const index = cursor;
      cursor += 1;
      if (index >= thunks.length) return;
      results[index] = await thunks[index]!();
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, thunks.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

export interface CreateWorkflowRuntimeOptions {
  readonly runId: string;
  readonly args?: unknown;
  readonly backend: WorkflowAgentBackend;
  readonly limits?: WorkflowLimits;
  readonly signal?: AbortSignal;
  /** Sink for every run-graph event (durable writer / UI subscribe here). */
  readonly onEvent?: (event: WorkflowEvent) => void;
  /** Sink for free-text `wf.log(...)` progress lines. */
  readonly onLog?: (event: WorkflowLogEvent) => void;
}

export interface WorkflowRuntimeHandle {
  readonly api: WorkflowApi;
  getState(): WorkflowRunState;
}

interface InternalRuntime extends WorkflowRuntimeHandle {
  readonly recorder: WorkflowEventRecorder;
  setStatus(status: WorkflowRunStatus): void;
}

function buildRuntime(opts: CreateWorkflowRuntimeOptions): InternalRuntime {
  const recorder = new WorkflowEventRecorder(opts.onEvent);
  const maxAgents = opts.limits?.maxAgents ?? Infinity;
  const maxConcurrency = opts.limits?.maxConcurrency ?? Infinity;
  const tokenBudget = opts.limits?.tokenBudget ?? null;
  const concurrency = new Semaphore(maxConcurrency);

  let totalSpawned = 0;
  let spentOutputTokens = 0;
  let status: WorkflowRunStatus = 'running';
  const artifacts: WorkflowArtifactRef[] = [];

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new WorkflowAbortError();
  };

  const doSpawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    checkAbort();
    if (totalSpawned >= maxAgents) {
      throw new WorkflowLimitError(`maxAgents cap (${maxAgents}) reached`);
    }
    totalSpawned += 1;
    const handle = await opts.backend.spawn(input);
    recorder.emit('agent_spawned', { taskId: handle.taskId, name: handle.name });
    return handle;
  };

  const accrue = (result: WorkflowTaskResult): void => {
    spentOutputTokens += result.usage?.outputTokens ?? 0;
  };

  const terminalEventType = (s: WorkflowTaskResult['status']): WorkflowEventType =>
    s === 'stopped' ? 'agent_stopped' : 'agent_completed';

  const doWait = async (
    taskId: string,
    opts2: WorkflowWaitOptions | undefined,
  ): Promise<WorkflowTaskResult> => {
    const result = await opts.backend.wait(taskId, opts2);
    accrue(result);
    recorder.emit(terminalEventType(result.status), {
      taskId: result.taskId,
      name: result.name,
      status: result.status,
    });
    return result;
  };

  const budget: WorkflowBudget = {
    total: tokenBudget,
    spent: () => spentOutputTokens,
    remaining: () =>
      tokenBudget === null ? Infinity : Math.max(0, tokenBudget - spentOutputTokens),
  };

  const api: WorkflowApi = {
    runId: opts.runId,
    args: opts.args,
    budget,

    phase: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      recorder.emit('phase_started', { name });
      try {
        return await fn();
      } finally {
        recorder.emit('phase_finished', { name });
      }
    },

    spawnAgent: (input) => doSpawn(input),

    runAgent: async (input) => {
      checkAbort();
      await concurrency.acquire();
      try {
        const handle = await doSpawn(input);
        return await doWait(handle.taskId, undefined);
      } finally {
        concurrency.release();
      }
    },

    wait: (taskId, waitOpts) => doWait(taskId, waitOpts),

    output: (taskId): Promise<WorkflowTaskSnapshot> => opts.backend.output(taskId),

    send: async (taskId, content) => {
      await opts.backend.send(taskId, content);
      recorder.emit('agent_message_sent', { taskId });
    },

    stop: async (taskId, reason) => {
      await opts.backend.stop(taskId, reason);
      recorder.emit('agent_stopped', { taskId, reason });
    },

    parallel: <T>(items: readonly (() => Promise<T>)[], parallelOpts?: WorkflowParallelOptions) => {
      checkAbort();
      const cap = Math.min(parallelOpts?.concurrency ?? maxConcurrency, maxConcurrency);
      return runPool(items, cap, opts.signal);
    },

    synthesize: async (input: WorkflowSynthesizeInput): Promise<WorkflowSynthesis> => {
      if (!opts.backend.synthesize) {
        throw new Error('synthesize is not supported by this workflow backend');
      }
      const result = await opts.backend.synthesize(input);
      recorder.emit('synthesis_completed');
      return result;
    },

    artifact: async (name, value): Promise<WorkflowArtifactRef> => {
      const ref = opts.backend.writeArtifact
        ? await opts.backend.writeArtifact(name, value)
        : { name };
      artifacts.push(ref);
      recorder.emit('artifact_written', { name });
      return ref;
    },

    log: (event) => {
      opts.onLog?.(event);
    },
  };

  return {
    api,
    recorder,
    setStatus: (s) => {
      status = s;
    },
    getState: (): WorkflowRunState => ({
      runId: opts.runId,
      status,
      totalSpawned,
      events: recorder.snapshot(),
      artifacts: [...artifacts],
    }),
  };
}

/**
 * Build a workflow runtime. The returned `api` is handed to a workflow
 * script; `getState()` returns an immutable snapshot of accumulated run
 * state. For the full run lifecycle (workflow_started/completed/failed
 * envelope) use `runWorkflow`.
 */
export function createWorkflowRuntime(opts: CreateWorkflowRuntimeOptions): WorkflowRuntimeHandle {
  const rt = buildRuntime(opts);
  return { api: rt.api, getState: rt.getState };
}

export type WorkflowRunOutcome<T> =
  | { readonly ok: true; readonly result: T; readonly state: WorkflowRunState }
  | { readonly ok: false; readonly error: Error; readonly state: WorkflowRunState };

/**
 * Run a workflow script end-to-end under a fresh runtime, wrapping it
 * with the workflow_started / workflow_completed|failed event envelope.
 * Never throws — failures surface as `{ ok: false, error }`.
 */
export async function runWorkflow<T>(
  opts: CreateWorkflowRuntimeOptions,
  script: (api: WorkflowApi, args: unknown) => Promise<T>,
): Promise<WorkflowRunOutcome<T>> {
  const rt = buildRuntime(opts);
  rt.recorder.emit('workflow_started', { runId: opts.runId });
  try {
    const result = await script(rt.api, opts.args);
    rt.setStatus('completed');
    rt.recorder.emit('workflow_completed');
    return { ok: true, result, state: rt.getState() };
  } catch (error) {
    rt.setStatus('failed');
    const err = error instanceof Error ? error : new Error(String(error));
    rt.recorder.emit('workflow_failed', { error: err.message });
    return { ok: false, error: err, state: rt.getState() };
  }
}
