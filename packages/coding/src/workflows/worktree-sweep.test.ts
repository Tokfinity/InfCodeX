/**
 * FEATURE_217 (v0.7.49) — workflow worktree sweep / GC tests.
 *
 * git access + mtime are injected, so these run without a real repository.
 */

import { describe, it, expect } from 'vitest';
import {
  workflowWorktreeBaseDir,
  sweepWorkflowRunWorktrees,
  pruneStaleWorkflowWorktrees,
  DEFAULT_STALE_WORKTREE_MS,
} from './worktree-sweep.js';

/** Build a fake `runGit` over an in-memory worktree set; records calls. */
function fakeGit(initial: Array<{ path: string; branch?: string }>) {
  const worktrees = new Map(initial.map((w) => [w.path, w.branch]));
  const calls: string[][] = [];
  const runGit = async (args: readonly string[], _cwd: string): Promise<string> => {
    calls.push([...args]);
    if (args[0] === 'worktree' && args[1] === 'list') {
      const lines: string[] = [];
      for (const [path, branch] of worktrees) {
        lines.push(`worktree ${path}`, 'HEAD abc123');
        if (branch) lines.push(`branch refs/heads/${branch}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      const path = args[2];
      if (!worktrees.has(path)) throw new Error(`not a worktree: ${path}`);
      worktrees.delete(path);
      return '';
    }
    return '';
  };
  return { runGit, calls, worktrees };
}

describe('workflowWorktreeBaseDir', () => {
  it('nests worktrees under the run dir', () => {
    expect(workflowWorktreeBaseDir('/runs/p/r1').replace(/\\/g, '/')).toBe('/runs/p/r1/worktrees');
  });
});

describe('sweepWorkflowRunWorktrees (Layer 2)', () => {
  it('removes only worktrees under the run base dir and deletes their branches', async () => {
    const git = fakeGit([
      { path: '/repo', branch: 'main' },
      { path: '/runs/p/r1/worktrees/.kodax-worktree-kodax-wt-workflow-wf-child-1', branch: 'kodax-wt-workflow-wf-child-1' },
      { path: '/runs/p/r1/worktrees/.kodax-worktree-kodax-wt-workflow-wf-child-2', branch: 'kodax-wt-workflow-wf-child-2' },
      { path: '/runs/p/r2/worktrees/.kodax-worktree-other', branch: 'other' },
    ]);

    const result = await sweepWorkflowRunWorktrees(
      { baseDir: '/runs/p/r1/worktrees', gitRoot: '/repo' },
      { runGit: git.runGit },
    );

    expect(result.removed).toHaveLength(2);
    expect(git.worktrees.has('/repo')).toBe(true);
    expect(git.worktrees.has('/runs/p/r2/worktrees/.kodax-worktree-other')).toBe(true);
    // Branch deletion attempted for each removed worktree.
    expect(git.calls).toContainEqual(['branch', '-D', 'kodax-wt-workflow-wf-child-1']);
    // Prune runs once after removals.
    expect(git.calls).toContainEqual(['worktree', 'prune']);
  });

  it('is a no-op without a gitRoot', async () => {
    const result = await sweepWorkflowRunWorktrees({ baseDir: '/runs/p/r1/worktrees' });
    expect(result.removed).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('does not prune when nothing matched', async () => {
    const git = fakeGit([{ path: '/repo', branch: 'main' }]);
    await sweepWorkflowRunWorktrees(
      { baseDir: '/runs/p/r1/worktrees', gitRoot: '/repo' },
      { runGit: git.runGit },
    );
    expect(git.calls).not.toContainEqual(['worktree', 'prune']);
  });

  it('collects a warning and keeps going when one remove fails', async () => {
    const git = fakeGit([
      { path: '/runs/p/r1/worktrees/a', branch: 'a' },
      { path: '/runs/p/r1/worktrees/b', branch: 'b' },
    ]);
    const runGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === '/runs/p/r1/worktrees/a') {
        throw new Error('locked');
      }
      return git.runGit(args, cwd);
    };
    const result = await sweepWorkflowRunWorktrees(
      { baseDir: '/runs/p/r1/worktrees', gitRoot: '/repo' },
      { runGit },
    );
    expect(result.removed).toEqual(['/runs/p/r1/worktrees/b']);
    expect(result.warnings.some((w) => w.includes('locked'))).toBe(true);
  });
});

describe('pruneStaleWorkflowWorktrees (Layer 3)', () => {
  const baseDeps = (git: ReturnType<typeof fakeGit>, ages: Record<string, number>, nowMs: number) => ({
    runGit: git.runGit,
    now: () => nowMs,
    mtimeMs: (path: string) => nowMs - (ages[path] ?? 0),
  });

  it('removes worktrees older than the staleness window, keeps fresh ones', async () => {
    const now = 1_000_000_000_000;
    const git = fakeGit([
      { path: '/repo', branch: 'main' },
      { path: '/runs/p/r-old/worktrees/stale', branch: 'stale' },
      { path: '/runs/p/r-new/worktrees/fresh', branch: 'fresh' },
    ]);
    const result = await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: '/runs/p', gitRoot: '/repo' },
      baseDeps(git, {
        '/runs/p/r-old/worktrees/stale': DEFAULT_STALE_WORKTREE_MS + 1,
        '/runs/p/r-new/worktrees/fresh': 1000,
      }, now),
    );

    expect(result.removed).toEqual(['/runs/p/r-old/worktrees/stale']);
    expect(git.worktrees.has('/runs/p/r-new/worktrees/fresh')).toBe(true);
    expect(git.worktrees.has('/repo')).toBe(true);
  });

  it('ignores worktrees outside the workflow-runs root', async () => {
    const now = 1_000_000_000_000;
    const git = fakeGit([
      { path: '/other/place/worktrees/old', branch: 'old' },
    ]);
    const result = await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: '/runs/p', gitRoot: '/repo' },
      baseDeps(git, { '/other/place/worktrees/old': DEFAULT_STALE_WORKTREE_MS * 10 }, now),
    );
    expect(result.removed).toHaveLength(0);
    expect(git.worktrees.has('/other/place/worktrees/old')).toBe(true);
  });

  it('always runs git worktree prune even with no stale entries', async () => {
    const git = fakeGit([{ path: '/repo', branch: 'main' }]);
    await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: '/runs/p', gitRoot: '/repo' },
      baseDeps(git, {}, 1_000_000_000_000),
    );
    expect(git.calls).toContainEqual(['worktree', 'prune']);
  });

  it('is a no-op without a gitRoot', async () => {
    const result = await pruneStaleWorkflowWorktrees({ workflowRunsRoot: '/runs/p' });
    expect(result.removed).toHaveLength(0);
  });
});
