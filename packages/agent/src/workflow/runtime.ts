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

const STOP_ACTIVE_TASK_TIMEOUT_MS = 250;
const CONCURRENCY_DEADLOCK_CHECK_MS = 50;
const MAX_TASK_EVENT_SUMMARY_CHARS = 4096;
const WORKFLOW_HANDOFF_OPEN = '[workflow handoff]';
const WORKFLOW_HANDOFF_CLOSE = '[/workflow handoff]';

type StopActiveTaskOutcome =
  | 'stopped'
  | 'timed-out'
  | { readonly error: string };

interface SemaphoreAcquireOptions {
  readonly deadlockCheckMs?: number;
  shouldRejectWait(): boolean;
  createRejection(): Error;
}

interface SemaphoreWaiter {
  resolve(): void;
  reject(error: Error): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedTaskEventSummary(text: string): string {
  return text.length > MAX_TASK_EVENT_SUMMARY_CHARS
    ? `${text.slice(0, MAX_TASK_EVENT_SUMMARY_CHARS).trimEnd()}...`
    : text;
}

function extractWorkflowHandoffBlock(text: string): string | undefined {
  const lower = text.toLowerCase();
  const closeIndex = lower.lastIndexOf(WORKFLOW_HANDOFF_CLOSE);
  if (closeIndex < 0) return undefined;
  const openIndex = lower.lastIndexOf(WORKFLOW_HANDOFF_OPEN, closeIndex);
  if (openIndex < 0) return undefined;
  const end = closeIndex + WORKFLOW_HANDOFF_CLOSE.length;
  const block = text.slice(openIndex, end).trim();
  return block ? boundedTaskEventSummary(block) : undefined;
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
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(options?: SemaphoreAcquireOptions): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (options?.deadlockCheckMs !== undefined) {
        timer = setTimeout(() => {
          if (!options.shouldRejectWait()) return;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(options.createRejection());
        }, options.deadlockCheckMs);
      }
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
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
  const inputs = normalizeSynthesisInputs(input.inputs);
  const rubric = normalizeSynthesisRubric(input.rubric);
  const body = inputs
    .map(
      (item, i) =>
        `## Input ${i + 1}\n${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`,
    )
    .join('\n\n');
  return [
    'You are synthesizing the findings below into a single result.',
    '',
    `Rubric: ${rubric}`,
    '',
    body,
  ].join('\n');
}

function normalizeSynthesisRubric(rubric: unknown): string {
  if (typeof rubric === 'string' && rubric.trim().length > 0) return rubric;
  throw new TypeError('workflow synthesize rubric must be a non-empty string');
}

function normalizeSynthesisInputs(inputs: unknown): readonly unknown[] {
  if (Array.isArray(inputs)) return inputs;
  if (typeof inputs === 'string') return [inputs];
  if (typeof inputs === 'object' && inputs !== null) {
    return Object.entries(inputs).map(([name, value]) => ({ name, value }));
  }
  throw new TypeError('workflow synthesize inputs must be an array, string, or object');
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
  stopActiveTasks(reason: string): Promise<readonly string[]>;
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
  const activeTaskIds = new Set<string>();
  const terminalTaskIds = new Set<string>();
  let activeReleaseOperations = 0;

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
    activeTaskIds.delete(taskId);
    release();
  };

  const checkAgentCap = (): void => {
    if (totalSpawned >= maxAgents) {
      throw new WorkflowLimitError(`maxAgents lifetime cap (${maxAgents}) reached`);
    }
  };

  const blockedByUnreleasedTasks = (): boolean =>
    Number.isFinite(maxConcurrency) &&
    activeTaskIds.size >= maxConcurrency &&
    activeReleaseOperations === 0;

  const doSpawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    checkAbort();
    checkBudget();
    checkAgentCap();
    await concurrency.acquire({
      deadlockCheckMs: Number.isFinite(maxConcurrency)
        ? CONCURRENCY_DEADLOCK_CHECK_MS
        : undefined,
      shouldRejectWait: blockedByUnreleasedTasks,
      createRejection: () =>
        new WorkflowLimitError(
          `maxConcurrency cap (${maxConcurrency}) is occupied by active spawned agents; ` +
            'wait or stop existing handles before launching more agents',
        ),
    });
    let acquired = true;
    let handle: WorkflowTaskHandle | undefined;
    try {
      checkAbort();
      checkBudget();
      checkAgentCap();
      handle = await opts.backend.spawn(input);
      totalSpawned += 1;
      activeTaskIds.add(handle.taskId);
      releaseByTask.set(handle.taskId, () => {
        if (!acquired) return;
        acquired = false;
        concurrency.release();
      });
      recorder.emit('agent_spawned', { taskId: handle.taskId, name: handle.name });
      return handle;
    } catch (error) {
      const spawnedHandle = handle;
      if (spawnedHandle) {
        activeTaskIds.delete(spawnedHandle.taskId);
        releaseByTask.delete(spawnedHandle.taskId);
        await Promise.race([
          Promise.resolve()
            .then(() => opts.backend.stop(spawnedHandle.taskId, 'workflow spawn failed'))
            .catch(() => undefined),
          delay(STOP_ACTIVE_TASK_TIMEOUT_MS),
        ]);
      }
      if (acquired) {
        acquired = false;
        concurrency.release();
      }
      throw error;
    }
  };

  const accrue = (result: WorkflowTaskResult): void => {
    spentOutputTokens += result.usage?.outputTokens ?? result.usage?.totalTokens ?? 0;
  };

  const terminalEventType = (s: WorkflowTaskResult['status']): WorkflowEventType =>
    s === 'stopped' ? 'agent_stopped' : 'agent_completed';

  const summarizeTaskResult = (result: WorkflowTaskResult): string | undefined => {
    const trimmed = result.finalText.trim();
    if (!trimmed) return undefined;
    return extractWorkflowHandoffBlock(trimmed) ?? boundedTaskEventSummary(trimmed);
  };

  const emitTerminalTaskEvent = (
    taskId: string,
    type: WorkflowEventType,
    data: Record<string, unknown>,
  ): boolean => {
    if (terminalTaskIds.has(taskId)) return false;
    terminalTaskIds.add(taskId);
    recorder.emit(type, data);
    return true;
  };

  const stopBackendTask = async (
    taskId: string,
    reason: string,
  ): Promise<{ readonly error?: string; readonly stopTimedOut?: true }> => {
    const stop = Promise.resolve()
      .then(() => opts.backend.stop(taskId, reason))
      .then((): StopActiveTaskOutcome => 'stopped')
      .catch((error: unknown): StopActiveTaskOutcome => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    const timeout = delay(STOP_ACTIVE_TASK_TIMEOUT_MS).then(
      (): StopActiveTaskOutcome => 'timed-out',
    );
    const outcome = await Promise.race([stop, timeout]);
    if (typeof outcome === 'object') return { error: outcome.error };
    if (outcome === 'timed-out') return { stopTimedOut: true };
    return {};
  };

  const createAbortRace = (): {
    readonly promise: Promise<never>;
    dispose(): void;
  } | undefined => {
    if (!opts.signal) return undefined;
    let onAbort: (() => void) | undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new WorkflowAbortError());
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
      promise,
      dispose: () => {
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      },
    };
  };

  const doWait = async (
    taskId: string,
    opts2: WorkflowWaitOptions | undefined,
  ): Promise<WorkflowTaskResult> => {
    const releasesCapacity = releaseByTask.has(taskId);
    if (releasesCapacity) activeReleaseOperations += 1;
    let abortRace: ReturnType<typeof createAbortRace>;
    try {
      checkAbort();
      abortRace = createAbortRace();
      const wait = opts.backend.wait(taskId, opts2);
      const result = abortRace ? await Promise.race([wait, abortRace.promise]) : await wait;
      const summary = result.status === 'completed' ? summarizeTaskResult(result) : undefined;
      if (emitTerminalTaskEvent(result.taskId, terminalEventType(result.status), {
        taskId: result.taskId,
        name: result.name,
        status: result.status,
        ...(result.usage !== undefined
          ? { usage: result.usage }
          : {}),
        ...(summary !== undefined
          ? { summary }
          : {}),
      })) {
        accrue(result);
      }
      return result;
    } catch (error) {
      if (releasesCapacity && !terminalTaskIds.has(taskId)) {
        const reason = error instanceof WorkflowAbortError
          ? 'workflow aborted'
          : 'workflow wait failed';
        const stopOutcome = await stopBackendTask(taskId, reason);
        emitTerminalTaskEvent(taskId, 'agent_stopped', {
          taskId,
          reason,
          ...(error instanceof Error ? { error: error.message } : {}),
          ...(stopOutcome.error !== undefined ? { stopError: stopOutcome.error } : {}),
          ...(stopOutcome.stopTimedOut ? { stopTimedOut: true } : {}),
        });
      }
      throw error;
    } finally {
      abortRace?.dispose();
      if (releasesCapacity) activeReleaseOperations -= 1;
      releaseTaskCapacity(taskId);
    }
  };

  // Run an agent through the same spawn/wait gate; doWait owns abort
  // propagation so runAgent and bare spawnAgent+wait behave consistently.
  const runAgentImpl = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult> => {
    checkAbort();
    const handle = await doSpawn(input);
    return await doWait(handle.taskId, undefined);
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
      const releasesCapacity = releaseByTask.has(taskId);
      if (releasesCapacity) activeReleaseOperations += 1;
      try {
        await opts.backend.stop(taskId, reason);
      } finally {
        if (releasesCapacity) activeReleaseOperations -= 1;
        releaseTaskCapacity(taskId);
        emitTerminalTaskEvent(taskId, 'agent_stopped', { taskId, reason });
      }
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
    stopActiveTasks: async (reason: string): Promise<readonly string[]> => {
      const errors: string[] = [];
      const taskIds = [...activeTaskIds];
      await Promise.all(
        taskIds.map(async (taskId) => {
          let stopError: string | undefined;
          let stopTimedOut = false;
          const stop = Promise.resolve()
            .then(() => opts.backend.stop(taskId, reason))
            .then((): StopActiveTaskOutcome => 'stopped')
            .catch((error: unknown): StopActiveTaskOutcome => ({
              error: error instanceof Error ? error.message : String(error),
            }));
          const timeout = delay(STOP_ACTIVE_TASK_TIMEOUT_MS).then(
            (): StopActiveTaskOutcome => 'timed-out',
          );
          const outcome = await Promise.race([stop, timeout]);
          if (typeof outcome === 'object') {
            stopError = outcome.error;
            errors.push(`${taskId}: ${stopError}`);
          } else if (outcome === 'timed-out') {
            stopTimedOut = true;
            errors.push(`${taskId}: stop timed out after ${STOP_ACTIVE_TASK_TIMEOUT_MS}ms`);
          }
          releaseTaskCapacity(taskId);
          emitTerminalTaskEvent(taskId, 'agent_stopped', {
            taskId,
            reason,
            ...(stopError !== undefined ? { error: stopError } : {}),
            ...(stopTimedOut ? { stopTimedOut } : {}),
          });
        }),
      );
      return errors;
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
    const stopErrors = await rt.stopActiveTasks('workflow completed');
    rt.setStatus('completed');
    rt.recorder.emit('workflow_completed', stopErrors.length > 0 ? { stopErrors } : undefined);
    return { ok: true, result, state: rt.getState() };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (rt) {
      const stopped = err instanceof WorkflowAbortError;
      const stopErrors = await rt.stopActiveTasks(stopped ? 'workflow stopped' : 'workflow failed');
      rt.setStatus(stopped ? 'stopped' : 'failed');
      if (stopped) {
        rt.recorder.emit(
          'workflow_stopped',
          stopErrors.length > 0 ? { stopErrors } : undefined,
        );
      } else {
        rt.recorder.emit('workflow_failed', {
          error: err.message,
          ...(stopErrors.length > 0 ? { stopErrors } : {}),
        });
      }
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
