import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}));

import {
  inspectWorkspaceRuntime,
  resolveCanonicalWorkspaceRoot,
} from './workspace-runtime.js';

describe('workspace runtime Git inspection', () => {
  const tempDirs: string[] = [];
  const mockedCwd = path.join(os.tmpdir(), 'kodax-mocked-git-repo');

  beforeEach(() => {
    mocks.active = 0;
    mocks.maxActive = 0;
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      mocks.active += 1;
      mocks.maxActive = Math.max(mocks.maxActive, mocks.active);
      const stdout = args.includes('--show-toplevel') && args.includes('--git-common-dir')
        ? 'C:/repo\nC:/repo/.git\n'
        : args.includes('--show-toplevel')
          ? 'C:/repo\n'
        : args.includes('--git-common-dir')
          ? 'C:/repo/.git\n'
          : 'main\n';
      setTimeout(() => {
        mocks.active -= 1;
        callback(null, { stdout, stderr: '' });
      }, 10);
      return {};
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('queries repository identity and branch concurrently after locating the root', async () => {
    await expect(inspectWorkspaceRuntime({ cwd: mockedCwd })).resolves.toMatchObject({
      canonicalRepoRoot: expect.stringMatching(/repo$/i),
      branch: 'main',
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(mocks.maxActive).toBe(2);
  });

  it('resolves lightweight project identity without querying the branch and bounds Git calls', async () => {
    await expect(resolveCanonicalWorkspaceRoot({ cwd: mockedCwd, timeoutMs: 321 }))
      .resolves.toMatch(/repo$/i);

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls.every(([, args]) => !args.includes('--show-current'))).toBe(true);
    expect(mocks.execFile.mock.calls.every(([, , options]) =>
      options.timeout > 0 && options.timeout <= 321)).toBe(true);
  });

  it('uses filesystem identity for an ordinary repository without spawning Git', async () => {
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-runtime-'));
    tempDirs.push(repository);
    const nested = path.join(repository, 'packages', 'repl');
    await Promise.all([
      fs.mkdir(path.join(repository, '.git')),
      fs.mkdir(nested, { recursive: true }),
    ]);

    await expect(resolveCanonicalWorkspaceRoot({ cwd: nested }))
      .resolves.toBe(repository.replace(/\\/g, '/'));
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('falls back to the filesystem repository boundary when Git inspection fails', async () => {
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-runtime-'));
    tempDirs.push(repository);
    const nested = path.join(repository, 'packages', 'repl');
    await Promise.all([
      fs.mkdir(path.join(repository, '.git')),
      fs.mkdir(nested, { recursive: true }),
    ]);
    mocks.execFile.mockImplementation((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void,
    ) => {
      callback(new Error('git unavailable'));
      return {};
    });

    await expect(resolveCanonicalWorkspaceRoot({ cwd: nested, timeoutMs: 10 }))
      .resolves.toBe(repository.replace(/\\/g, '/'));
  });

  it('resolves a linked worktree to the common repository without spawning Git', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-runtime-'));
    tempDirs.push(root);
    const repository = path.join(root, 'main');
    const worktree = path.join(root, 'worktree');
    const gitDir = path.join(repository, '.git', 'worktrees', 'worktree');
    const nested = path.join(worktree, 'src');
    await Promise.all([
      fs.mkdir(gitDir, { recursive: true }),
      fs.mkdir(nested, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8'),
      fs.writeFile(path.join(gitDir, 'commondir'), '../..\n', 'utf8'),
    ]);
    mocks.execFile.mockImplementation((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void,
    ) => {
      callback(new Error('git unavailable'));
      return {};
    });

    await expect(resolveCanonicalWorkspaceRoot({ cwd: nested, timeoutMs: 10 }))
      .resolves.toBe(repository.replace(/\\/g, '/'));
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
