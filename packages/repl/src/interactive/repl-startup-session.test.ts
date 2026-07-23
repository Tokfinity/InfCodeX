import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadClassicStartupSession, MemorySessionStorage } from './repl.js';

describe('loadClassicStartupSession', () => {
  it('loads an explicit session id even when a resume flag is also present', async () => {
    const storage = new MemorySessionStorage();
    await storage.save('explicit-session', {
      messages: [{ role: 'user', content: 'explicit history' }],
      title: 'Explicit',
      gitRoot: 'C:\\repo',
    });
    await storage.save('newer-session', {
      messages: [{ role: 'user', content: 'newer history' }],
      title: 'Newer',
      gitRoot: 'C:\\repo',
    });

    const loaded = await loadClassicStartupSession(
      { id: 'explicit-session', resume: true },
      storage,
      'C:\\repo',
    );

    expect(loaded).toMatchObject({
      id: 'explicit-session',
      kind: 'load',
      data: { title: 'Explicit' },
    });
  });

  it('skips newer empty sessions for -c/--continue', async () => {
    const storage = new MemorySessionStorage();
    const canonicalRepoRoot = path.resolve('repo');
    const workspaceRoot = path.resolve('repo-worktree');
    const executionCwd = path.join(workspaceRoot, 'packages', 'app');
    await storage.save('empty-acp-session', {
      messages: [],
      title: 'ACP placeholder',
      gitRoot: canonicalRepoRoot,
      runtimeInfo: { surface: 'acp' },
    });
    await storage.save('recent-session', {
      messages: [{ role: 'user', content: 'remember this' }],
      title: 'Recent session',
      gitRoot: canonicalRepoRoot,
      tag: 'partner',
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot,
        executionCwd,
        workspaceKind: 'worktree',
      },
    });

    const loaded = await loadClassicStartupSession(
      { resume: true },
      storage,
      canonicalRepoRoot,
    );

    expect(loaded).toMatchObject({
      id: 'recent-session',
      kind: 'continue',
      runtimeInfo: {
        canonicalRepoRoot: canonicalRepoRoot.replaceAll('\\', '/'),
        workspaceRoot: workspaceRoot.replaceAll('\\', '/'),
        executionCwd: executionCwd.replaceAll('\\', '/'),
        workspaceKind: 'worktree',
      },
      data: {
        messages: [{ role: 'user', content: 'remember this' }],
        title: 'Recent session',
        tag: 'partner',
      },
    });
  });
});
