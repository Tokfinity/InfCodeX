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
} {
  let counter = 0;
  let inFlight = 0;
  let peak = 0;
  let spawns = 0;
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
    stop: async () => {},
  };
  return {
    backend,
    peakInFlight: () => peak,
    spawnCount: () => spawns,
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
    // seq strictly increasing.
    const seqs = outcome.state.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
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
    expect(outcome.ok).toBe(true);
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
});
