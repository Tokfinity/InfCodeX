import { describe, expect, it } from 'vitest';

import { createWorkflowRunManager } from './run-manager.js';
import type { ManagedRunClassification } from './run-manager.js';
import type { WorkflowEvent } from './events.js';

type Outcome = { kind: 'completed' | 'failed' | 'denied'; result?: string; error?: Error };

const classify = (o: Outcome): ManagedRunClassification => ({
  status: o.kind,
  ...(o.error ? { error: o.error } : {}),
  ...(o.kind === 'completed' && o.result !== undefined ? { resultText: o.result } : {}),
});

const onError = (error: unknown): Outcome => ({
  kind: 'failed',
  error: error instanceof Error ? error : new Error(String(error)),
});

const ev = (type: WorkflowEvent['type'], seq: number): WorkflowEvent => ({ seq, type });

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createWorkflowRunManager (neutral)', () => {
  it('runs a thunk and resolves done to the caller outcome; snapshot reflects completion', async () => {
    const m = createWorkflowRunManager();
    const run = m.start<Outcome>({
      runId: 'r1',
      workflow: 'wf',
      runFn: async () => ({ kind: 'completed', result: 'all good' }),
      classify,
      onError,
    });
    const outcome = await run.done;
    expect(outcome).toEqual({ kind: 'completed', result: 'all good' });
    const snap = m.get('r1');
    expect(snap?.status).toBe('completed');
    expect(snap?.resultText).toBe('all good');
    expect(snap?.endedAt).toBeTypeOf('number');
  });

  it('counts agent_spawned via the injected onEvent hook', async () => {
    const m = createWorkflowRunManager();
    const run = m.start<Outcome>({
      runId: 'r2',
      workflow: 'wf',
      runFn: async (hooks) => {
        hooks.onEvent(ev('agent_spawned', 1));
        hooks.onEvent(ev('agent_completed', 2));
        hooks.onEvent(ev('agent_spawned', 3));
        return { kind: 'completed' };
      },
      classify,
      onError,
    });
    await run.done;
    expect(m.get('r2')?.totalSpawned).toBe(2);
    expect(m.get('r2')?.eventCount).toBe(3);
  });

  it('classifies a failed outcome and records the error on the snapshot', async () => {
    const m = createWorkflowRunManager();
    const run = m.start<Outcome>({
      runId: 'r3',
      workflow: 'wf',
      runFn: async () => ({ kind: 'failed', error: new Error('boom') }),
      classify,
      onError,
    });
    await run.done;
    expect(m.get('r3')?.status).toBe('failed');
    expect(m.get('r3')?.error).toBe('boom');
  });

  it('routes a thrown runFn through onError to a failed outcome', async () => {
    const m = createWorkflowRunManager();
    const run = m.start<Outcome>({
      runId: 'r4',
      workflow: 'wf',
      runFn: async () => {
        throw new Error('explode');
      },
      classify,
      onError,
    });
    const outcome = await run.done;
    expect(outcome.kind).toBe('failed');
    expect(m.get('r4')?.status).toBe('failed');
    expect(m.get('r4')?.error).toBe('explode');
  });

  it('pause() blocks the next beforeSpawn until resume()', async () => {
    const m = createWorkflowRunManager();
    let startSpawn: () => void = () => {};
    const canSpawn = new Promise<void>((resolve) => {
      startSpawn = resolve;
    });
    let spawnReached = false;
    const run = m.start<Outcome>({
      runId: 'r5',
      workflow: 'wf',
      runFn: async (hooks) => {
        await canSpawn;
        await hooks.beforeSpawn();
        spawnReached = true;
        return { kind: 'completed' };
      },
      classify,
      onError,
    });
    expect(m.pause('r5')).toBe(true);
    expect(m.get('r5')?.status).toBe('paused');
    startSpawn();
    await tick();
    expect(spawnReached).toBe(false); // gated by pause
    expect(m.resume('r5')).toBe(true);
    await run.done;
    expect(spawnReached).toBe(true);
    expect(m.get('r5')?.status).toBe('completed');
  });

  it('stop() aborts the run; beforeSpawn rejects and the run settles as stopped', async () => {
    const m = createWorkflowRunManager();
    let startSpawn: () => void = () => {};
    const canSpawn = new Promise<void>((resolve) => {
      startSpawn = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const run = m.start<Outcome>({
      runId: 'r6',
      workflow: 'wf',
      runFn: async (hooks) => {
        capturedSignal = hooks.signal;
        await canSpawn;
        await hooks.beforeSpawn(); // rejects: signal aborted
        return { kind: 'completed' };
      },
      classify,
      onError,
    });
    expect(m.stop('r6')).toBe(true);
    startSpawn();
    await run.done;
    expect(capturedSignal?.aborted).toBe(true);
    expect(m.get('r6')?.status).toBe('stopped');
  });

  it('invokes runFn eagerly (synchronously) — the body starts before start() returns', () => {
    // Regression: A0 briefly deferred runFn via Promise.resolve().then(...),
    // which let a caller that releases a held-open run right after a single
    // await call its release before the body was even entered — the run then
    // never settled (deadlock). Eager start keeps the pre-A0 contract.
    const m = createWorkflowRunManager();
    let entered = false;
    m.start<Outcome>({
      runId: 'eager',
      workflow: 'wf',
      runFn: async () => {
        entered = true;
        return { kind: 'completed' };
      },
      classify,
      onError,
    });
    expect(entered).toBe(true);
  });

  it('settles a held-open run released only after the caller awaits — no deadlock', async () => {
    // Mirrors the /workflow run-id completer test: start a run whose body holds
    // open until an external release, do other awaited work, then release and
    // await done. Must resolve (would hang under a deferred start).
    const m = createWorkflowRunManager();
    let release: () => void = () => {};
    const run = m.start<Outcome>({
      runId: 'held',
      workflow: 'wf',
      runFn: () =>
        new Promise<Outcome>((resolve) => {
          release = () => resolve({ kind: 'completed' });
        }),
      classify,
      onError,
    });
    await tick(); // caller does other work first
    expect(m.get('held')?.status).toBe('running');
    release();
    const outcome = await run.done;
    expect(outcome.kind).toBe('completed');
    expect(m.get('held')?.status).toBe('completed');
  });

  it('forwards process events to subscribers and lists active snapshots', async () => {
    const m = createWorkflowRunManager();
    const received: number[] = [];
    const unsubscribe = m.subscribeWorkflowProcess(() => received.push(1));
    const run = m.start<Outcome>({
      runId: 'r7',
      workflow: 'wf',
      phases: ['investigate'],
      runFn: async (hooks) => {
        hooks.onEvent(ev('agent_spawned', 1));
        return { kind: 'completed' };
      },
      classify,
      onError,
    });
    await run.done;
    expect(received.length).toBeGreaterThan(0);
    expect(m.getWorkflowProcessSnapshot('r7')).toBeDefined();
    unsubscribe();
  });
});
