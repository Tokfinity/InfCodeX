/**
 * FEATURE_217 (v0.7.49) Phase B — Coding workflow agent backend.
 *
 * Bridges the domain-neutral `WorkflowAgentBackend` (from
 * `@kodax-ai/agent/workflow`) onto KodaX's existing child-dispatch
 * substrate: `executeChildAgents` + per-child AbortController registry +
 * `childProgressSnapshots` + `MessageQueue` routing. It does NOT
 * duplicate the child state model — spawn/wait/output/stop/send all
 * reuse the same primitives `dispatch_child_task` / `task_output` /
 * `task_stop` / `send_message` already use.
 *
 * Each `spawn` launches one bundle through `executeChildAgents`
 * (maxParallel:1) without awaiting; the workflow runtime owns the
 * concurrency gate (Semaphore) so each backend spawn is a single child.
 *
 * Test seams (DI): `runChild` (defaults to `executeChildAgents`),
 * `queue`, `generateId`, `now`. Tests inject a fake `runChild` + a
 * minimal ctx so no real agents run.
 */

import { registerChildTask, routeMessage, getMessageQueue } from '@kodax-ai/agent';
import type { ChildTaskRegistry, MessageQueue } from '@kodax-ai/agent';
import type {
  WorkflowAgentBackend,
  WorkflowSpawnAgentInput,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowTaskStatus,
} from '@kodax-ai/agent';

import { executeChildAgents } from '../child-executor.js';
import type { ChildExecutorOptions } from '../child-executor.js';
import {
  initChildSnapshot,
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
} from '../child-progress-snapshot.js';
import type { ChildProgressStatus } from '../child-progress-snapshot.js';
import type {
  KodaXChildContextBundle,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';

/** The subset of `ChildExecutorOptions` the caller fixes once per run;
 *  the adapter adds `maxParallel` / `abortSignal` / `snapshotUpdater`
 *  per spawn. */
export type WorkflowChildOptions = Omit<
  ChildExecutorOptions,
  'maxParallel' | 'abortSignal' | 'snapshotUpdater'
>;

export interface CodingWorkflowBackendDeps {
  /** Parent tool-execution context (carries abort + snapshot registries). */
  readonly ctx: KodaXToolExecutionContext;
  /** Fixed per-run child options (parentRole / parentHarness / parentOptions
   *  / maxIterationsPerChild / guardrails / …). */
  readonly childOptions: WorkflowChildOptions;
  /** Seam: child runner. Defaults to `executeChildAgents`. */
  readonly runChild?: (
    bundles: readonly KodaXChildContextBundle[],
    ctx: KodaXToolExecutionContext,
    options: ChildExecutorOptions,
  ) => Promise<KodaXChildExecutionResult>;
  /** Seam: message queue. Defaults to the process-global singleton. */
  readonly queue?: MessageQueue;
  /** Seam: unique child id generator. */
  readonly generateId?: () => string;
  /** Seam: clock for snapshot timestamps. */
  readonly now?: () => number;
}

interface TaskEntry {
  readonly name: string;
  readonly promise: Promise<KodaXChildExecutionResult>;
}

function buildBundle(childId: string, input: WorkflowSpawnAgentInput): KodaXChildContextBundle {
  return {
    id: childId,
    fanoutClass: 'evidence-scan',
    objective: input.prompt,
    readOnly: input.readOnly ?? false,
    evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : [],
    constraints: [],
    ...(input.modelHint ? { modelHint: input.modelHint } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
    ...(input.subagentType ? { specialistName: input.subagentType } : {}),
  };
}

/** Derive workflow-level terminal status + final text from a single-bundle
 *  execution result. */
function deriveTerminal(
  result: KodaXChildExecutionResult,
  taskId: string,
): { status: WorkflowTaskStatus; snapStatus: ChildProgressStatus; finalText: string } {
  if (result.cancelledChildren.includes(taskId)) {
    return { status: 'stopped', snapStatus: 'aborted', finalText: '' };
  }
  const child = result.results[0];
  const finalText = child?.summary ?? '';
  if (child?.status === 'completed') {
    return { status: 'completed', snapStatus: 'completed', finalText };
  }
  return { status: 'failed', snapStatus: 'failed', finalText };
}

/**
 * Build a `WorkflowAgentBackend` over the coding child-dispatch substrate.
 */
export function createCodingWorkflowBackend(deps: CodingWorkflowBackendDeps): WorkflowAgentBackend {
  const { ctx, childOptions } = deps;
  const runChild = deps.runChild ?? executeChildAgents;
  const queue = deps.queue ?? getMessageQueue();
  const now = deps.now ?? (() => Date.now());
  let counter = 0;
  const genId = deps.generateId ?? (() => `wf-child-${(counter += 1)}`);

  const tasks = new Map<string, TaskEntry>();
  // Registry used ONLY for routeMessage target validation; auto-cleared on
  // settle by registerChildTask. `tasks` (above) persists for wait/output.
  const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();

  const spawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    const childId = genId();
    const bundle = buildBundle(childId, input);
    const abort = new AbortController();
    ctx.childAbortControllers?.set(childId, abort);
    const snapshotMap = ctx.childProgressSnapshots;
    if (snapshotMap) {
      initChildSnapshot(snapshotMap, {
        childId,
        startedAt: now(),
        maxIterations: childOptions.maxIterationsPerChild,
        parentRole: childOptions.parentRole,
        readOnly: bundle.readOnly,
        specialistName: bundle.specialistName,
      });
    }
    const perChild: ChildExecutorOptions = {
      ...childOptions,
      maxParallel: 1,
      abortSignal: abort.signal,
      snapshotUpdater: snapshotMap
        ? (event) => applyChildSnapshotEvent(snapshotMap, childId, event)
        : undefined,
    };

    const promise = (async (): Promise<KodaXChildExecutionResult> => {
      let result: KodaXChildExecutionResult | undefined;
      try {
        result = await runChild([bundle], ctx, perChild);
        return result;
      } finally {
        ctx.childAbortControllers?.delete(childId);
        if (snapshotMap) {
          const term = result
            ? deriveTerminal(result, childId)
            : { snapStatus: 'failed' as ChildProgressStatus, finalText: '' };
          finalizeChildSnapshot(snapshotMap, childId, {
            status: term.snapStatus,
            finalText: term.finalText,
            endedAt: now(),
          });
        }
      }
    })();

    tasks.set(childId, { name: input.name, promise });
    registerChildTask(registry, childId, promise);
    return { taskId: childId, name: input.name };
  };

  const wait = async (taskId: string): Promise<WorkflowTaskResult> => {
    const entry = tasks.get(taskId);
    if (!entry) throw new Error(`unknown workflow task: ${taskId}`);
    const result = await entry.promise;
    const term = deriveTerminal(result, taskId);
    return {
      taskId,
      name: entry.name,
      status: term.status,
      finalText: term.finalText,
      usage: { outputTokens: result.totalTokensUsed },
    };
  };

  const output = async (taskId: string): Promise<WorkflowTaskSnapshot> => {
    const name = tasks.get(taskId)?.name ?? taskId;
    const snap = ctx.childProgressSnapshots?.get(taskId);
    if (!snap) return { taskId, name, status: 'running' };
    const status: WorkflowTaskStatus = snap.status === 'aborted' ? 'stopped' : snap.status;
    return snap.finalText !== undefined
      ? { taskId, name, status, lastText: snap.finalText }
      : { taskId, name, status };
  };

  const send = async (taskId: string, content: string): Promise<void> => {
    routeMessage({ to: taskId, priority: 'user', mode: 'prompt', content, registry, queue });
  };

  const stop = async (taskId: string): Promise<void> => {
    ctx.childAbortControllers?.get(taskId)?.abort();
  };

  // NOTE: no `synthesize` here — `wf.synthesize` runs as a gated agent in
  // the runtime (through spawn/wait) so it counts toward maxAgents /
  // concurrency / budget and emits run-graph events.
  return { spawn, wait, output, send, stop };
}
