import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from '../runtime/agent-home.js';
import { LearnedAreaStore } from './learned-area-store.js';

describe('LearnedAreaStore Runtime boundary', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kodax-learned-store-'));
  });

  afterEach(async () => {
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a project root that aliases the Agent Runtime tree', async () => {
    const agentHome = path.join(root, 'agent-home');
    const runtime = path.join(agentHome, 'runtime');
    const learnedRoot = path.join(agentHome, 'learned', 'projects', 'tenant', 'project');
    await mkdir(runtime, { recursive: true });
    await mkdir(path.dirname(learnedRoot), { recursive: true });
    await symlink(runtime, learnedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    setAgentConfigHome(agentHome);

    await expect(new LearnedAreaStore(learnedRoot).initialize())
      .rejects.toThrow('aliases protected Runtime state');
    expect(await readdir(runtime)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'matches the Runtime boundary with Windows filesystem case semantics',
    async () => {
      const agentHome = path.join(root, 'agent-home');
      const runtime = path.join(agentHome, 'Runtime');
      const learnedRoot = path.join(agentHome, 'learned', 'projects', 'tenant', 'project');
      await mkdir(runtime, { recursive: true });
      await mkdir(path.dirname(learnedRoot), { recursive: true });
      await symlink(runtime, learnedRoot, 'junction');
      setAgentConfigHome(agentHome);

      await expect(new LearnedAreaStore(learnedRoot).initialize())
        .rejects.toThrow('aliases protected Runtime state');
      expect(await readdir(runtime)).toEqual([]);
    },
  );
});
