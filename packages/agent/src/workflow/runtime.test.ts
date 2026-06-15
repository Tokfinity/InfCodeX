/**
 * FEATURE_217 (v0.7.49) — Workflow runtime tests (Phase A).
 *
 * Validates the agent-layer orchestration engine against a fake backend
 * (no real agents): event ordering, maxAgents total cap, maxConcurrency
 * in-flight gate, parallel concurrency, abort handling, budget accounting.
 */

import { describe, expect, it } from 'vitest';

import {
  createWorkflowRuntime,
  runWorkflow,
  WorkflowAbortError,
  WorkflowBudgetError,
  WorkflowLimitError,
  type WorkflowAgentBackend,
  type WorkflowEvent,
  type WorkflowSpawnAgentInput,
  type WorkflowTaskResult,
} from './index.js';

/** Fake backend: each spawn resolves wait after a tick; tracks the max
 *  number of simultaneously in-flight agents so concurrency caps can be
 *  asserted. */
function fakeBackend(
  config: { waitDelayMs?: number } = {},
): {
  backend: WorkflowAgentBackend;
  peakInFlight: () => number;
  spawnCount: () => number;
  stoppedTaskIds: () => readonly string[];
} {
  let counter = 0;
  let inFlight = 0;
  let peak = 0;
  let spawns = 0;
  const stopped: string[] = [];
  const inFlightByTask = new Map<string, boolean>();
  const backend: WorkflowAgentBackend = {
    spawn: async (input: WorkflowSpawnAgentInput) => {
      spawns += 1;
      counter += 1;
      const taskId = `task-${counter}`;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      inFlightByTask.set(taskId, true);
      return { taskId, name: input.name };
    },
    wait: async (taskId: string): Promise<WorkflowTaskResult> => {
      if (config.waitDelayMs) await new Promise((r) => setTimeout(r, config.waitDelayMs));
      else await Promise.resolve();
      if (inFlightByTask.get(taskId)) {
        inFlight -= 1;
        inFlightByTask.set(taskId, false);
      }
      return { taskId, name: taskId, status: 'completed', finalText: 'done', usage: { outputTokens: 10 } };
    },
    output: async (taskId: string) => ({ taskId, name: taskId, status: 'running' as const }),
    send: async () => {},
    stop: async (taskId: string) => {
      stopped.push(taskId);
      if (inFlightByTask.get(taskId)) {
        inFlight -= 1;
        inFlightByTask.set(taskId, false);
      }
    },
  };
  return {
    backend,
    peakInFlight: () => peak,
    spawnCount: () => spawns,
    stoppedTaskIds: () => [...stopped],
  };
}

const baseOpts = (backend: WorkflowAgentBackend, extra = {}) => ({
  runId: 'run-1',
  backend,
  ...extra,
});

describe('runWorkflow — event envelope + ordering', () => {
  it('emits workflow_started first and workflow_completed last in seq order', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.phase('investigate', async () => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
      });
      return 'ok';
    });
    expect(outcome.ok).toBe(true);
    const types = outcome.state.events.map((e) => e.type);
    expect(types[0]).toBe('workflow_started');
    expect(types[types.length - 1]).toBe('workflow_completed');
    expect(types).toEqual([
      'workflow_started',
      'phase_started',
      'agent_spawned',
      'agent_completed',
      'phase_finished',
      'workflow_completed',
    ]);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toBe('done');
    expect(completed?.data?.usage).toEqual({ outputTokens: 10 });
    // seq strictly increasing.
    const seqs = outcome.state.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('prefers the child self-distilled digest for completed-agent events', async () => {
    const finalText = [
      'I now have a complete picture of the workflow changes.',
      'Here is my long report.',
      'x'.repeat(700),
      'Finding: this full report stays available for synthesis.',
    ].join('\n');
    const digest = [
      '- Finding: workflow transcript uses the child digest.',
      '- Evidence: full finalText stays separate for synthesis.',
    ].join('\n');
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-long', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'long-child',
        status: 'completed',
        finalText,
        digest,
      }),
      output: async (taskId: string) => ({ taskId, name: 'long-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.runAgent({ name: 'long-child', prompt: 'x' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toBe(digest);
    expect(completed?.data?.summaryKind).toBe('digest');
    expect(completed?.data?.summary).not.toContain('long report');
  });

  it('falls back to bounded finalText excerpts when a child digest is missing', async () => {
    const finalText = [
      'I now have a complete picture of the workflow changes.',
      'Here is my long report.',
      'overview details '.repeat(400),
      'Finding: finalText fallback remains bounded.',
    ].join('\n');
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-long', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'long-child',
        status: 'completed',
        finalText,
      }),
      output: async (taskId: string) => ({ taskId, name: 'long-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.runAgent({ name: 'long-child', prompt: 'x' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toContain('overview details');
    expect(completed?.data?.summaryKind).toBe('excerpt');
    expect(String(completed?.data?.summary).length).toBeLessThanOrEqual(4096 + 3);
  });

  it('emits pending completion first and appends async digest updates later', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summary?: string; readonly summaryKind: 'digest' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-async', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'async-child',
        status: 'completed',
        finalText: 'Full report while digest is still running.',
        digestPending: true,
      }),
      output: async (taskId: string) => ({ taskId, name: 'async-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.runAgent({ name: 'async-child', prompt: 'x' });
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    const completed = events.find((event) => event.type === 'agent_completed');
    expect(completed?.data).toMatchObject({
      taskId: 'task-async',
      summary: 'Full report while digest is still running.',
      summaryKind: 'pending',
    });

    summaryListener?.('task-async', {
      summary: '- Finding: async digest arrived.',
      summaryKind: 'digest',
    });

    expect(events.at(-1)).toMatchObject({
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-async',
        summary: '- Finding: async digest arrived.',
        summaryKind: 'digest',
      },
    });
  });

  it('drops async digest updates after the workflow is stopped', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summary?: string; readonly summaryKind: 'digest' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-stop', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'stopped-child',
        status: 'completed',
        finalText: 'done',
      }),
      output: async (taskId: string) => ({ taskId, name: 'stopped-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.spawnAgent({ name: 'stopped-child', prompt: 'x' });
        throw new WorkflowAbortError();
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('stopped');
    const eventCount = events.length;

    summaryListener?.('task-stop', {
      summary: '- Finding: digest arrived after stop.',
      summaryKind: 'digest',
    });

    expect(events).toHaveLength(eventCount);
    expect(events.some((event) => event.type === 'agent_summary_updated')).toBe(false);
  });

  it('emits workflow_failed and surfaces the error when the script throws', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async () => {
      throw new Error('script boom');
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toBe('script boom');
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.events.at(-1)?.type).toBe('workflow_failed');
  });

  it('records user aborts as stopped instead of failed', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async () => {
      throw new WorkflowAbortError();
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('stopped');
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'workflow_stopped',
    ]);
  });

  it('stops spawned-but-unwaited children when the workflow fails', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      throw new Error('script boom');
    });

    expect(outcome.ok).toBe(false);
    expect(stoppedTaskIds()).toEqual(['task-1']);
    expect(outcome.state.events.map((event) => event.type)).toContain('agent_stopped');
  });

  it('stops spawned-but-unwaited children when the workflow succeeds', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    expect(stoppedTaskIds()).toEqual(['task-1']);
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'agent_spawned',
      'agent_stopped',
      'workflow_completed',
    ]);
  });

  it('does not leak concurrency capacity when the agent_spawned event sink throws', async () => {
    const { backend, peakInFlight } = fakeBackend();
    let failFirstSpawnEvent = true;
    const outcome = await runWorkflow(
      baseOpts(backend, {
        limits: { maxConcurrency: 1 },
        onEvent: (event: WorkflowEvent) => {
          if (event.type === 'agent_spawned' && failFirstSpawnEvent) {
            failFirstSpawnEvent = false;
            throw new Error('event sink failed');
          }
        },
      }),
      async (wf) => {
        try {
          await wf.spawnAgent({ name: 'first', prompt: 'x' });
        } catch {
          // Simulates generated workflow recovery after a host-side event failure.
        }
        const second = await wf.spawnAgent({ name: 'second', prompt: 'x' });
        await wf.stop(second.taskId, 'done');
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBe(1);
  });

  it('does not emit agent_completed after a failed workflow has stopped the task', async () => {
    const events: WorkflowEvent[] = [];
    let resolveWait: ((result: WorkflowTaskResult) => void) | undefined;
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-1', name: input.name }),
      wait: (taskId) =>
        new Promise<WorkflowTaskResult>((resolve) => {
          resolveWait = resolve;
        }).then((result) => ({ ...result, taskId })),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        const handle = await wf.spawnAgent({ name: 'late-finisher', prompt: 'keep working' });
        void wf.wait(handle.taskId);
        await Promise.resolve();
        throw new Error('script boom');
      },
    );

    expect(outcome.ok).toBe(false);
    expect(events.some((event) => event.type === 'agent_stopped')).toBe(true);
    resolveWait?.({
      taskId: 'task-1',
      name: 'late-finisher',
      status: 'completed',
      finalText: 'late done',
    });
    await Promise.resolve();
    await Promise.resolve();

    const terminalTypes = events
      .filter((event) => event.type === 'agent_stopped' || event.type === 'agent_completed')
      .map((event) => event.type);
    expect(terminalTypes).toEqual(['agent_stopped']);
  });

  it('does not hang the failed outcome when backend.stop never resolves', async () => {
    const { backend } = fakeBackend();
    const hangingStopBackend: WorkflowAgentBackend = {
      ...backend,
      stop: () => new Promise<void>(() => {}),
    };
    const startedAt = Date.now();

    const outcome = await runWorkflow(baseOpts(hangingStopBackend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      throw new Error('script boom');
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.events.at(-1)?.type).toBe('workflow_failed');
    const stopped = outcome.state.events.find((event) => event.type === 'agent_stopped');
    expect(stopped?.data?.stopTimedOut).toBe(true);
  });
});

describe('maxAgents total cap', () => {
  it('throws WorkflowLimitError when total spawns exceed maxAgents', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend, { limits: { maxAgents: 2 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' });
      await wf.runAgent({ name: 'b', prompt: 'x' });
      await wf.runAgent({ name: 'c', prompt: 'x' }); // 3rd exceeds cap
      return 'unreached';
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    expect(spawnCount()).toBe(2); // 3rd never reached backend.spawn
  });
});

describe('maxConcurrency / parallel in-flight gate', () => {
  it('fails fast on invalid maxConcurrency instead of hanging spawned agents', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 0 } }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
        return 'unreached';
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    expect(spawnCount()).toBe(0);
  });

  it('never exceeds maxConcurrency simultaneously in flight', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 2 } }),
      async (wf) => {
        await wf.parallel(
          Array.from({ length: 6 }, (_unused, i) => () => wf.runAgent({ name: `a${i}`, prompt: 'x' })),
        );
        return 'ok';
      },
    );
    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('parallel(opts.concurrency) clamps below maxConcurrency', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    await runWorkflow(baseOpts(backend, { limits: { maxConcurrency: 8 } }), async (wf) => {
      await wf.parallel(
        Array.from({ length: 6 }, (_unused, i) => () => wf.runAgent({ name: `a${i}`, prompt: 'x' })),
        { concurrency: 2 },
      );
      return 'ok';
    });
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('rejects invalid parallel concurrency', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.parallel([() => Promise.resolve('a')], { concurrency: 0 });
      return 'unreached';
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
  });

  it('parallel preserves result order by index', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      return wf.parallel([
        () => Promise.resolve('a'),
        () => Promise.resolve('b'),
        () => Promise.resolve('c'),
      ]);
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual(['a', 'b', 'c']);
  });

  it('gates bare spawnAgent until the matching wait releases capacity', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 2 } }),
      async (wf) => {
        await Promise.all(
          Array.from({ length: 6 }, async (_unused, i) => {
            const handle = await wf.spawnAgent({ name: `bare-${i}`, prompt: 'x' });
            return wf.wait(handle.taskId);
          }),
        );
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('fails fast instead of soft-deadlocking behind an un-waited spawnAgent handle', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcomeOrTimeout = await Promise.race([
      runWorkflow(
        baseOpts(backend, { limits: { maxConcurrency: 1 } }),
        async (wf) => {
          await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
          await wf.parallel([
            () => wf.runAgent({ name: 'blocked-behind-left-running', prompt: 'x' }),
          ]);
          return 'unreached';
        },
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(outcomeOrTimeout).not.toBe('timeout');
    if (outcomeOrTimeout !== 'timeout') {
      expect(outcomeOrTimeout.ok).toBe(false);
      if (!outcomeOrTimeout.ok) expect(outcomeOrTimeout.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(stoppedTaskIds()).toEqual(['task-1']);
  });
});

describe('abort handling', () => {
  it('runAgent throws WorkflowAbortError when signal is already aborted', async () => {
    const { backend, spawnCount } = fakeBackend();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
        return 'unreached';
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowAbortError);
    expect(spawnCount()).toBe(0);
  });

  it('propagates a mid-run abort to the in-flight child via backend.stop', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 't1', name: input.name }),
      // wait blocks until the run aborts, then resolves as 'stopped'.
      wait: (taskId) =>
        new Promise((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => resolve({ taskId, name: taskId, status: 'stopped', finalText: '' }),
            { once: true },
          );
        }),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async (taskId) => { stopped.push(taskId); },
    };
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal }),
      async (wf) => {
        const handlePromise = wf.runAgent({ name: 'a', prompt: 'x' });
        setTimeout(() => controller.abort(), 5);
        return handlePromise;
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowAbortError);
    expect(stopped).toEqual(['t1']); // abort reached the in-flight child
  });

  it('parallel stops launching new thunks after abort fires mid-run', async () => {
    const { backend } = fakeBackend();
    const controller = new AbortController();
    let launched = 0;
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal, limits: { maxConcurrency: 1 } }),
      async (wf) => {
        await wf.parallel(
          Array.from({ length: 5 }, (_unused, i) => async () => {
            launched += 1;
            if (i === 1) controller.abort();
            await Promise.resolve();
            return i;
          }),
        );
        return 'ok';
      },
    );
    expect(outcome.ok).toBe(false);
    expect(launched).toBeLessThan(5); // abort prevented remaining launches
  });

  it('propagates a mid-run abort to a bare spawnAgent waiter', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'bare-1', name: input.name }),
      wait: () => new Promise<WorkflowTaskResult>(() => {}),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async (taskId) => {
        stopped.push(taskId);
      },
    };

    const outcomeOrTimeout = await Promise.race([
      runWorkflow(
        baseOpts(backend, { signal: controller.signal }),
        async (wf) => {
          const handle = await wf.spawnAgent({ name: 'bare', prompt: 'x' });
          setTimeout(() => controller.abort(), 5);
          await wf.wait(handle.taskId);
          return 'unreached';
        },
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(outcomeOrTimeout).not.toBe('timeout');
    if (outcomeOrTimeout !== 'timeout') {
      expect(outcomeOrTimeout.ok).toBe(false);
      if (!outcomeOrTimeout.ok) expect(outcomeOrTimeout.error).toBeInstanceOf(WorkflowAbortError);
      expect(outcomeOrTimeout.state.events.some((event) => event.type === 'agent_stopped')).toBe(true);
    }
    expect(stopped).toEqual(['bare-1']);
  });
});

describe('budget accounting + hard stop before new spawns', () => {
  it('accrues output tokens across completed agents', async () => {
    const { backend } = fakeBackend();
    let snapshot: { total: number | null; spent: number; remaining: number } | undefined;
    await runWorkflow(baseOpts(backend, { limits: { tokenBudget: 100 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' }); // 10 output tokens
      await wf.runAgent({ name: 'b', prompt: 'x' }); // 10 output tokens
      snapshot = { total: wf.budget.total, spent: wf.budget.spent(), remaining: wf.budget.remaining() };
      return 'ok';
    });
    expect(snapshot).toEqual({ total: 100, spent: 20, remaining: 80 });
  });

  it('accrues totalTokens when outputTokens is not provided', async () => {
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-total', name: input.name }),
      wait: async (taskId) => ({
        taskId,
        name: 'total',
        status: 'completed',
        finalText: 'done',
        usage: { totalTokens: 25 },
      }),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };
    let spent = 0;

    await runWorkflow(baseOpts(backend, { limits: { tokenBudget: 100 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' });
      spent = wf.budget.spent();
      return 'ok';
    });

    expect(spent).toBe(25);
  });

  it('remaining is Infinity when no budget configured', async () => {
    const { backend } = fakeBackend();
    let remaining = 0;
    await runWorkflow(baseOpts(backend), async (wf) => {
      remaining = wf.budget.remaining();
      return 'ok';
    });
    expect(remaining).toBe(Infinity);
  });

  it('throws WorkflowBudgetError before spawning after budget is exhausted', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { tokenBudget: 10 } }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' }); // spends 10 output tokens
        await wf.runAgent({ name: 'b', prompt: 'x' });
        return 'unreached';
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowBudgetError);
    expect(spawnCount()).toBe(1);
  });

  it('rechecks token budget after waiting for concurrency capacity', async () => {
    const { backend, spawnCount } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 1, tokenBudget: 10 } }),
      async (wf) => {
        await Promise.all([
          wf.runAgent({ name: 'a', prompt: 'x' }),
          wf.runAgent({ name: 'b', prompt: 'x' }),
        ]);
        return 'unreached';
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowBudgetError);
    expect(spawnCount()).toBe(1);
  });
});

describe('createWorkflowRuntime — lower-level handle', () => {
  it('exposes api + getState without the run envelope', async () => {
    const { backend } = fakeBackend();
    const onLog: string[] = [];
    const rt = createWorkflowRuntime(baseOpts(backend, { onLog: (e: { message: string }) => onLog.push(e.message) }));
    rt.api.log({ message: 'hello' });
    await rt.api.runAgent({ name: 'a', prompt: 'x' });
    const state = rt.getState();
    expect(state.totalSpawned).toBe(1);
    expect(state.status).toBe('running'); // no envelope sets terminal status
    expect(onLog).toEqual(['hello']);
  });

  it('artifact() records a ref and emits artifact_written', async () => {
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts(backend));
    const ref = await rt.api.artifact('report', { k: 1 });
    expect(ref.name).toBe('report');
    expect(rt.getState().artifacts).toHaveLength(1);
    expect(rt.getState().events.some((e) => e.type === 'artifact_written')).toBe(true);
  });

  it('synthesize runs as a gated agent (counts toward totalSpawned + emits event)', async () => {
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts(backend));
    const result = await rt.api.synthesize({ inputs: ['a', 'b'], rubric: 'r' });
    expect(typeof result.text).toBe('string');
    expect(rt.getState().totalSpawned).toBe(1); // synthesize spawned one agent
    expect(rt.getState().events.some((e) => e.type === 'synthesis_completed')).toBe(true);
    expect(rt.getState().events.some((e) => e.type === 'agent_spawned')).toBe(true);
  });

  it('synthesize accepts named input objects generated by dynamic workflows', async () => {
    const seenPrompts: string[] = [];
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts({
      ...backend,
      spawn: async (input: WorkflowSpawnAgentInput) => {
        seenPrompts.push(input.prompt);
        return await backend.spawn(input);
      },
    }));

    const result = await rt.api.synthesize({
      inputs: {
        investigation: 'first finding',
        verification: { risk: 'confirmed' },
      },
      rubric: 'merge findings',
    });

    expect(result.text).toBe('done');
    expect(rt.getState().totalSpawned).toBe(1);
    expect(seenPrompts[0]).toContain('"name": "investigation"');
    expect(seenPrompts[0]).toContain('first finding');
    expect(seenPrompts[0]).toContain('"risk": "confirmed"');
  });

  it('synthesize accepts already-formatted text generated by dynamic workflows', async () => {
    const seenPrompts: string[] = [];
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts({
      ...backend,
      spawn: async (input: WorkflowSpawnAgentInput) => {
        seenPrompts.push(input.prompt);
        return await backend.spawn(input);
      },
    }));

    const combined = [
      '## control-sense-reviewer',
      'Users need bounded child summaries.',
      '',
      '## feedback-auditor',
      'The live surface needs clearer progress.',
    ].join('\n');

    const result = await rt.api.synthesize({
      inputs: combined,
      rubric: 'merge findings',
    });

    expect(result.text).toBe('done');
    expect(rt.getState().totalSpawned).toBe(1);
    expect(seenPrompts[0]).toContain('## Input 1');
    expect(seenPrompts[0]).toContain('## control-sense-reviewer');
    expect(seenPrompts[0]).toContain('The live surface needs clearer progress.');
  });
});
