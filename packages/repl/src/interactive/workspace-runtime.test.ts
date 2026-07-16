import { describe, expect, it } from 'vitest';
import { formatWorkspaceTruth, isSameCanonicalRepo, resolveSessionRuntimeInfo } from './workspace-runtime.js';

describe('workspace-runtime helpers', () => {
  it('resolves runtime info from persisted legacy gitRoot data', () => {
    // resolveSessionRuntimeInfo normalizes via path.resolve(). 'C:/...' is
    // absolute on win32 but RELATIVE on POSIX (path.resolve would prepend the
    // cwd), so use a root that is absolute on both platforms — otherwise the
    // normalized output diverges from the input on Linux CI.
    const root = process.platform === 'win32'
      ? 'C:/repo/worktrees/feature-runtime'
      : '/repo/worktrees/feature-runtime';
    expect(resolveSessionRuntimeInfo({
      gitRoot: root,
      runtimeInfo: undefined,
    })).toEqual({
      canonicalRepoRoot: root,
      workspaceRoot: root,
      executionCwd: root,
      branch: undefined,
      workspaceKind: 'detected',
    });
  });

  it('formats lightweight current-workspace truth', () => {
    expect(formatWorkspaceTruth({
      canonicalRepoRoot: 'C:/repo',
      workspaceRoot: 'C:/repo/worktrees/feature-runtime',
      executionCwd: 'C:/repo/worktrees/feature-runtime/packages/repl',
      branch: 'feature/runtime-truth',
      workspaceKind: 'managed',
    })).toBe('C:/repo/worktrees/feature-runtime @ feature/runtime-truth [managed]');
  });

  it('compares canonical repo identity independently from workspace root', () => {
    expect(isSameCanonicalRepo(
      {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/main',
      },
      {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/feature-runtime',
      },
    )).toBe(true);
  });
});
