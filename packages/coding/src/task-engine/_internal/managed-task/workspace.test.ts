import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeManagedTaskFile } from './workspace.js';

describe('managed-task computed artifact boundary', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-artifact-'));
  });

  afterEach(async () => {
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('allows ordinary workspace artifacts but rejects an alias into Runtime', async () => {
    const ordinary = path.join(root, 'workspace', '.agent', 'managed-tasks', 'task-1', 'result.json');
    await writeManagedTaskFile(ordinary, '{}\n');
    expect(await readFile(ordinary, 'utf8')).toBe('{}\n');

    const agentHome = path.join(root, 'agent-home');
    const runtime = path.join(agentHome, 'runtime');
    const alias = path.join(root, 'workspace', '.agent', 'managed-tasks-link');
    await mkdir(runtime, { recursive: true });
    await symlink(runtime, alias, process.platform === 'win32' ? 'junction' : 'dir');
    setAgentConfigHome(agentHome);

    await expect(
      writeManagedTaskFile(path.join(alias, 'task-2', 'result.json'), '{}\n'),
    ).rejects.toThrow('protected KodaX state');
  });
});
