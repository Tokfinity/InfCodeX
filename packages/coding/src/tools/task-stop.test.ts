/**
 * Unit tests for `toolTaskStop` (FEATURE_120 Phase 3b).
 *
 * Covers:
 *   - happy path: known task_id → controller is aborted, optional
 *     reason flows through to the queue as a system-reminder block,
 *     return string confirms abort
 *   - rejects missing/empty task_id
 *   - rejects unknown task_id with explicit reason
 *   - rejects when childAbortControllers is unavailable (sync-mode)
 *   - already-aborted task_id reports the state without re-aborting
 *     (signal.reason preserved)
 *   - reason is optional — when absent, no queue message is enqueued
 *     and the signal.reason is a default Error mentioning the task_id
 *   - pin: tool name is in CHILD_EXCLUDE_TOOLS_BASE
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetMessageQueueForTests,
  getMessageQueue,
  type ChildTaskRegistry,
  type TaskAbortRegistry,
} from '@kodax-ai/agent';

import type { KodaXChildExecutionResult, KodaXToolExecutionContext } from '../types.js';

import { CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';

import { toolTaskStop } from './task-stop.js';

function makeCtx(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/repo',
    executionCwd: '/tmp/repo',
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeAbortRegistry(
  taskIds: readonly string[],
): TaskAbortRegistry {
  const registry: TaskAbortRegistry = new Map();
  for (const id of taskIds) {
    registry.set(id, new AbortController());
  }
  return registry;
}

function makeTaskRegistry(
  taskIds: readonly string[],
): ChildTaskRegistry<KodaXChildExecutionResult> {
  const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();
  for (const id of taskIds) {
    // Never-settling stub: routeMessage only calls `.has`.
    registry.set(id, new Promise(() => {}));
  }
  return registry;
}

/** Build a ctx that mirrors the production dispatch shape:
 *  both childTaskRegistry AND childAbortControllers are populated
 *  with matching keys for each task id. */
function makeDispatchedCtx(taskIds: readonly string[]): KodaXToolExecutionContext {
  return makeCtx({
    childAbortControllers: makeAbortRegistry(taskIds),
    childTaskRegistry: makeTaskRegistry(taskIds),
  });
}

describe('toolTaskStop — happy path', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('aborts the controller + enqueues a coordinator-stop-request when reason is supplied', async () => {
    const ctx = makeDispatchedCtx(['child-a']);

    const result = await toolTaskStop(
      { task_id: 'child-a', reason: 'user cancelled the parent task' },
      ctx,
    );

    expect(result).toMatch(/task_stop signal sent to child-a/);

    const controller = ctx.childAbortControllers!.get('child-a');
    expect(controller?.signal.aborted).toBe(true);
    expect(controller?.signal.reason).toBeInstanceOf(Error);
    expect((controller?.signal.reason as Error).message).toMatch(/user cancelled/);

    const drained = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'user',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      agentId: 'child-a',
      priority: 'user',
      mode: 'system-reminder',
    });
    expect(drained[0]?.content).toMatch(/<coordinator-stop-request>/);
    expect(drained[0]?.content).toMatch(/user cancelled the parent task/);
    expect(drained[0]?.content).toMatch(/Finish your current tool call gracefully/);
  });

  it('aborts the controller without enqueueing a message when reason is omitted', async () => {
    const ctx = makeDispatchedCtx(['child-b']);

    const result = await toolTaskStop({ task_id: 'child-b' }, ctx);

    expect(result).toMatch(/task_stop signal sent to child-b/);
    expect(ctx.childAbortControllers!.get('child-b')?.signal.aborted).toBe(true);
    // signal.reason is the default Error mentioning the task id
    const reason = ctx.childAbortControllers!.get('child-b')?.signal.reason as Error;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toMatch(/child-b/);

    // No coordinator-stop-request message — child won't see a reason
    // explanation, just the abort signal.
    expect(getMessageQueue().size()).toBe(0);
  });
});

describe('toolTaskStop — input validation', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('rejects missing task_id', async () => {
    const registry = makeAbortRegistry(['child-a']);
    const ctx = makeCtx({ childAbortControllers: registry });
    const result = await toolTaskStop({ reason: 'oops' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/task_id/);
    expect(registry.get('child-a')?.signal.aborted).toBe(false);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects empty task_id', async () => {
    const registry = makeAbortRegistry(['child-a']);
    const ctx = makeCtx({ childAbortControllers: registry });
    const result = await toolTaskStop({ task_id: '   ' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(registry.get('child-a')?.signal.aborted).toBe(false);
  });
});

describe('toolTaskStop — error paths', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('rejects unknown task_id', async () => {
    const registry = makeAbortRegistry(['child-a']);
    const ctx = makeCtx({ childAbortControllers: registry });
    const result = await toolTaskStop(
      { task_id: 'child-NOPE', reason: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Unknown task_id/i);
    expect(result).toMatch(/child-NOPE/);
    // Sibling untouched
    expect(registry.get('child-a')?.signal.aborted).toBe(false);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('does NOT enqueue an orphan stop-request when abortRegistry is missing the taskId but childTaskRegistry still has it', async () => {
    // Reproduces the small window between the inner IIFE's `.finally`
    // (deletes from childAbortControllers) and registerChildTask's
    // outer `.finally` (deletes from childTaskRegistry). If task_stop
    // enqueued the stop-request BEFORE checking the abort registry,
    // a message would orphan in the dead child's queue.
    const ctx = makeCtx({
      childAbortControllers: new Map(), // empty — child already finished
      childTaskRegistry: makeTaskRegistry(['child-a']), // still present
    });

    const result = await toolTaskStop(
      { task_id: 'child-a', reason: 'should not orphan' },
      ctx,
    );

    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Unknown task_id/i);
    // The fix: no orphan message lands in the queue.
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects when childAbortControllers is unavailable (sync-mode dispatch)', async () => {
    const ctx = makeCtx({ childAbortControllers: undefined });
    const result = await toolTaskStop({ task_id: 'child-a' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/async dispatch|registry/i);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('reports already-aborted without re-aborting; preserves first signal.reason', async () => {
    const registry = makeAbortRegistry(['child-a']);
    const firstCause = new Error('first abort cause');
    registry.get('child-a')!.abort(firstCause);

    const ctx = makeCtx({ childAbortControllers: registry });
    const result = await toolTaskStop(
      { task_id: 'child-a', reason: 'second attempt' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/already (aborted|stopped)/i);
    // signal.reason MUST still be the first cause
    expect(registry.get('child-a')?.signal.reason).toBe(firstCause);
    // No stop-request message — already-aborted skips enqueue too,
    // since the child either already exited or is about to.
    expect(getMessageQueue().size()).toBe(0);
  });
});

describe('toolTaskStop — coordinator-only invariant', () => {
  it('is listed in CHILD_EXCLUDE_TOOLS_BASE so child agents cannot call it', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('task_stop');
  });
});
