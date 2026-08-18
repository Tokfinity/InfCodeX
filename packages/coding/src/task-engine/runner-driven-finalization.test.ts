import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const maintenanceMocks = vi.hoisted(() => ({
  attachRepoIntelligence: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock('./_internal/managed-task/repo-intelligence.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./_internal/managed-task/repo-intelligence.js')
  >();
  return {
    ...actual,
    attachManagedTaskRepoIntelligence: maintenanceMocks.attachRepoIntelligence,
  };
});

import { runManagedTaskViaRunner } from './runner-driven.js';

const tempRoots: string[] = [];

afterEach(async () => {
  maintenanceMocks.attachRepoIntelligence.mockClear();
  await Promise.all(tempRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  )));
});

it('does not keep the managed terminal Promise open for stuck repo maintenance', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-maintenance-'));
  tempRoots.push(workspaceRoot);

  const run = runManagedTaskViaRunner(
    {
      provider: 'anthropic',
      context: {
        executionCwd: workspaceRoot,
        gitRoot: workspaceRoot,
        managedTaskWorkspaceDir: workspaceRoot,
        repoIntelligenceMode: 'off',
      },
      events: {},
    },
    'Return a direct answer.',
    async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
  );

  await expect(Promise.race([
    run,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('managed terminal timed out')), 2_000);
      timer.unref();
    }),
  ])).resolves.toMatchObject({ success: true, lastText: 'done' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(maintenanceMocks.attachRepoIntelligence).toHaveBeenCalledOnce();
});
