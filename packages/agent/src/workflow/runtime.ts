/**
 * FEATURE_217 (v0.7.49) — Workflow runtime: concurrency gate, agent cap,
 * budget accounting, event recording.
 *
 * The runtime is the orchestration engine. It wraps an injected
 * `WorkflowAgentBackend` with: a maxAgents lifetime cap, a maxConcurrency
 * in-flight gate (for spawnAgent / runAgent / parallel), token-budget accounting with
 * a hard stop before new spawns, abort handling, and an append-only event
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

/** Thrown when a new spawn would start after the token budget is exhausted. */
export class WorkflowBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowBudgetError';
  }
}

function readPositiveLimit(
  limits: WorkflowLimits | undefined,
  key: keyof WorkflowLimits,
): number | undefined {
  const value = limits?.[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowLimitError(`workflow limit ${key} must be a positive integer`);
  }
  return value;
}

/** Validate user-provided runtime limits for SDK consumers. */
export function normalizeWorkflowLimits(limits?: WorkflowLimits): WorkflowLimits {
  const maxAgents = readPositiveLimit(limits, 'maxAgents');
  const maxConcurrency = readPositiveLimit(limits, 'maxConcurrency');
  const tokenBudget = readPositiveLimit(limits, 'tokenBudget');
  return {
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
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

/** Render a generic synthesis prompt from inputs + rubric. Domain-neutral. */
function buildSynthesisPrompt(input: WorkflowSynthesizeInput): string {
  const body = input.inputs
    .map(
      (item, i) =>
        `## Input ${i + 1}\n${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`,
    )
    .join('\n\n');
  return [
    'You are synthesizing the findings below into a single result.',
    '',
    `Rubric: ${input.rubric}`,
    '',
    body,
  ].join('\n');
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
  const limits = normalizeWorkflowLimits(opts.limits);
  const maxAgents = limits.maxAgents ?? Infinity;
  const maxConcurrency = limits.maxConcurrency ?? Infinity;
  const tokenBudget = limits.tokenBudget ?? null;
  const concurrency = new Semaphore(maxConcurrency);

  let totalSpawned = 0;
  let spentOutputTokens = 0;
  let status: WorkflowRunStatus = 'running';
  const artifacts: WorkflowArtifactRef[] = [];
  const releaseByTask = new Map<string, () => void>();

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new WorkflowAbortError();
  };

  const checkBudget = (): void => {
    if (tokenBudget !== null && spentOutputTokens >= tokenBudget) {
      throw new WorkflowBudgetError(`tokenBudget cap (${tokenBudget}) exhausted`);
    }
  };

  const releaseTaskCapacity = (taskId: string): void => {
    const release = releaseByTask.get(taskId);
    if (!release) return;
    releaseByTask.delete(taskId);
    release();
  };

  const checkAgentCap = (): void => {
    if (totalSpawned >= maxAgents) {
      throw new WorkflowLimitError(`maxAgents cap (${maxAgents}) reached`);
    }
  };

  const doSpawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    checkAbort();
    checkBudget();
    checkAgentCap();
    await concurrency.acquire();
    let acquired = true;
    try {
      checkAbort();
      checkBudget();
      checkAgentCap();
      totalSpawned += 1;
      const handle = await opts.backend.spawn(input);
      releaseByTask.set(handle.taskId, () => {
        if (!acquired) return;
        acquired = false;
        concurrency.release();
      });
      recorder.emit('agent_spawned', { taskId: handle.taskId, name: handle.name });
      return handle;
    } catch (error) {
      if (acquired) concurrency.release();
      throw error;
    }
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
    try {
      const result = await opts.backend.wait(taskId, opts2);
      accrue(result);
      recorder.emit(terminalEventType(result.status), {
        taskId: result.taskId,
        name: result.name,
        status: result.status,
      });
      return result;
    } finally {
      releaseTaskCapacity(taskId);
    }
  };

  // Run an agent through the same spawn/wait gate, then propagate a workflow
  // abort to the in-flight child via the backend's stop().
  const runAgentImpl = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult> => {
    checkAbort();
    let onAbort: (() => void) | undefined;
    try {
      const handle = await doSpawn(input);
      if (opts.signal) {
        const { taskId } = handle;
        onAbort = () => {
          void opts.backend.stop(taskId, 'workflow aborted');
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      return await doWait(handle.taskId, undefined);
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
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

    runAgent: (input) => runAgentImpl(input),

    wait: (taskId, waitOpts) => doWait(taskId, waitOpts),

    output: (taskId): Promise<WorkflowTaskSnapshot> => opts.backend.output(taskId),

    send: async (taskId, content) => {
      await opts.backend.send(taskId, content);
      recorder.emit('agent_message_sent', { taskId });
    },

    stop: async (taskId, reason) => {
      await opts.backend.stop(taskId, reason);
      releaseTaskCapacity(taskId);
      recorder.emit('agent_stopped', { taskId, reason });
    },

    parallel: <T>(items: readonly (() => Promise<T>)[], parallelOpts?: WorkflowParallelOptions) => {
      checkAbort();
      if (
        parallelOpts?.concurrency !== undefined &&
        (!Number.isInteger(parallelOpts.concurrency) || parallelOpts.concurrency <= 0)
      ) {
        throw new WorkflowLimitError('workflow parallel concurrency must be a positive integer');
      }
      const cap = Math.min(parallelOpts?.concurrency ?? maxConcurrency, maxConcurrency);
      return runPool(items, cap, opts.signal);
    },

    synthesize: async (input: WorkflowSynthesizeInput): Promise<WorkflowSynthesis> => {
      // Synthesis runs as a gated agent (counts toward maxAgents /
      // concurrency / budget and emits agent_spawned/completed events)
      // rather than a backend side-channel that bypasses the runtime.
      const result = await runAgentImpl({
        name: 'synthesize',
        prompt: buildSynthesisPrompt(input),
        readOnly: true,
      });
      recorder.emit('synthesis_completed');
      return { text: result.finalText };
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
  let rt: InternalRuntime | undefined;
  try {
    rt = buildRuntime(opts);
    rt.recorder.emit('workflow_started', { runId: opts.runId });
    const result = await script(rt.api, opts.args);
    rt.setStatus('completed');
    rt.recorder.emit('workflow_completed');
    return { ok: true, result, state: rt.getState() };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (rt) {
      rt.setStatus('failed');
      rt.recorder.emit('workflow_failed', { error: err.message });
      return { ok: false, error: err, state: rt.getState() };
    }
    return {
      ok: false,
      error: err,
      state: {
        runId: opts.runId,
        status: 'failed',
        totalSpawned: 0,
        events: [],
        artifacts: [],
      },
    };
  }
}
