import { describe, expect, it } from 'vitest';
import { filterGitDiff } from './git-diff.js';

describe('git diff output filter', () => {
  it('summarizes file-level diff metadata and marks the result recoverably lossy', () => {
    const body = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      '-old',
      '+new',
      '+another',
      ' context',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');

    const result = filterGitDiff({
      command: 'git diff',
      stdout: body,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('whole');
    expect(result.stdout).toContain('[git diff summarized: 2 files, +4 -1]');
    expect(result.stdout).toContain('src/a.ts (+2 -1, 1 hunk)');
    expect(result.stdout).toContain('src/b.ts (+2 -0, 1 hunk, new)');
    expect(result.stdout).not.toContain('context');
  });
});
