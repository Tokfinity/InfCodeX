import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_PROJECT_KEY,
  deriveProjectKeyFromRoot,
  deriveProjectKeyFromData,
} from './project-key.js';

describe('FEATURE_219 project-key', () => {
  it('returns _unknown for empty / missing root', () => {
    expect(deriveProjectKeyFromRoot(undefined).key).toBe(UNKNOWN_PROJECT_KEY);
    expect(deriveProjectKeyFromRoot(null).key).toBe(UNKNOWN_PROJECT_KEY);
    expect(deriveProjectKeyFromRoot('   ').key).toBe(UNKNOWN_PROJECT_KEY);
    expect(deriveProjectKeyFromData({}).key).toBe(UNKNOWN_PROJECT_KEY);
  });

  it('produces a readable slug plus a hash suffix', () => {
    const id = deriveProjectKeyFromRoot('/home/user/my-project');
    expect(id.key).toMatch(/^[a-z0-9-]+-[0-9a-f]{10}$/);
    expect(id.key).toContain('my-project');
    expect(id.displayName).toBe('my-project');
  });

  it('is deterministic for the same root', () => {
    const a = deriveProjectKeyFromRoot('/home/user/repo');
    const b = deriveProjectKeyFromRoot('/home/user/repo');
    expect(a.key).toBe(b.key);
  });

  it('disambiguates slug-colliding roots via the hash suffix', () => {
    // `a-b` and `a/b` sanitize to the same slug — the hash must differ.
    const ab = deriveProjectKeyFromRoot('/home/user/a-b');
    const aSlashB = deriveProjectKeyFromRoot('/home/user/a/b');
    expect(ab.key).not.toBe(aSlashB.key);
  });

  it('folds drive-letter / path case on win32 + darwin (same dir → same key)', () => {
    const lower = deriveProjectKeyFromRoot('c:/works/kodax');
    const upper = deriveProjectKeyFromRoot('C:/Works/KodaX');
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(lower.key).toBe(upper.key);
    } else {
      // POSIX is case-sensitive — distinct dirs, distinct keys.
      expect(lower.key).not.toBe(upper.key);
    }
  });

  it('normalizes backslash separators (Windows path drift)', () => {
    const fwd = deriveProjectKeyFromRoot('C:/Works/KodaX');
    const back = deriveProjectKeyFromRoot('C:\\Works\\KodaX');
    expect(fwd.key).toBe(back.key);
  });

  it('derives key from runtimeInfo.canonicalRepoRoot (worktrees converge on the canonical repo)', () => {
    const mainCheckout = deriveProjectKeyFromData({
      gitRoot: '/repo',
      runtimeInfo: { canonicalRepoRoot: '/repo', workspaceRoot: '/repo' },
    });
    const worktree = deriveProjectKeyFromData({
      gitRoot: '/repo.worktrees/feature',
      runtimeInfo: { canonicalRepoRoot: '/repo', workspaceRoot: '/repo.worktrees/feature' },
    });
    // Same canonical repo → same project folder (worktree merges with main).
    expect(worktree.key).toBe(mainCheckout.key);
  });

  it('falls back to gitRoot when runtimeInfo is absent (non-git cwd gets its own folder)', () => {
    const id = deriveProjectKeyFromData({ gitRoot: '/some/non-git/dir' });
    expect(id.key).not.toBe(UNKNOWN_PROJECT_KEY);
    expect(id.key).toContain('dir');
  });
});
