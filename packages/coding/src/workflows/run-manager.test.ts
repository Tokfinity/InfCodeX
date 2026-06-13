import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowAgentBackend, WorkflowModule } from '@kodax-ai/agent';

import { createWorkflowRunManager } from './run-manager.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeBackend(): {
  readonly backend: WorkflowAgentBackend;
  readonly spawnCount: () => number;
  readonly stopCount: () => number;
} {
  let spawns = 0;
  let stops = 0;
  const names = new Map<string, string>();
  const backend: WorkflowAgentBackend = {
    spawn: async (input) => {
      spawns += 1;
      const taskId = `t${spawns}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `done:${taskId}`,
    }),
    output: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'running',
    }),
    send: async () => {},
    stop: async () => {
      stops += 1;
    },
  };
  return { backend, spawnCount: () => spawns, stopCount: () => stops };
}

describe('WorkflowRunManager', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-manager-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts a workflow in the background and records the terminal snapshot', async () => {
    const manager = createWorkflowRunManager();
    const { backend } = fakeBackend();
    const module: WorkflowModule = {
      meta: { name: 'quick', description: 'quick', readOnly: true },
      run: async (wf) => {
        await wf.runAgent({ name: 'reader', prompt: 'read', readOnly: true });
        return 'ok';
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-bg',
      runDir: dir,
      backend,
    });

    expect(manager.get('run-bg')?.status).toBe('running');
    const outcome = await run.done;
    expect(outcome.kind).toBe('completed');
    expect(manager.get('run-bg')).toMatchObject({
      runId: 'run-bg',
      workflow: 'quick',
      status: 'completed',
      totalSpawned: 1,
    });
  });

  it('pauses before launching new agents and resumes later', async () => {
    const manager = createWorkflowRunManager();
    const { backend, spawnCount } = fakeBackend();
    const readyForSecond = deferred<void>();
    const allowSecond = deferred<void>();
    const module: WorkflowModule = {
      meta: { name: 'pausable', description: 'pausable', readOnly: true },
      run: async (wf) => {
        await wf.runAgent({ name: 'first', prompt: 'first', readOnly: true });
        readyForSecond.resolve();
        await allowSecond.promise;
        await wf.runAgent({ name: 'second', prompt: 'second', readOnly: true });
        return 'ok';
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-pause',
      runDir: dir,
      backend,
    });

    await readyForSecond.promise;
    expect(spawnCount()).toBe(1);
    expect(manager.pause('run-pause')).toBe(true);
    allowSecond.resolve();
    await Promise.resolve();
    expect(manager.get('run-pause')?.status).toBe('paused');
    expect(spawnCount()).toBe(1);

    expect(manager.resume('run-pause')).toBe(true);
    const outcome = await run.done;
    expect(outcome.kind).toBe('completed');
    expect(spawnCount()).toBe(2);
  });

  it('stops an in-flight workflow through abort propagation', async () => {
    const manager = createWorkflowRunManager();
    const waitStarted = deferred<void>();
    const backendState = fakeBackend();
    const backend: WorkflowAgentBackend = {
      ...backendState.backend,
      wait: async (taskId) => {
        waitStarted.resolve();
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                taskId,
                name: taskId,
                status: 'stopped',
                finalText: '',
              }),
            20,
          );
        });
      },
    };
    const module: WorkflowModule = {
      meta: { name: 'stop-me', description: 'stop', readOnly: true },
      run: async (wf) => wf.runAgent({ name: 'long', prompt: 'long', readOnly: true }),
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-stop',
      runDir: dir,
      backend,
    });

    await waitStarted.promise;
    expect(manager.stop('run-stop', 'test stop')).toBe(true);
    await run.done;
    expect(manager.get('run-stop')?.status).toBe('stopped');
    expect(backendState.stopCount()).toBeGreaterThan(0);
  });
});
