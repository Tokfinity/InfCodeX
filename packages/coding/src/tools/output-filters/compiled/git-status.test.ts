import { describe, expect, it } from 'vitest';
import { filterGitStatus } from './git-status.js';

describe('git status output filter', () => {
  it('groups porcelain status output by status code', () => {
    const result = filterGitStatus({
      command: 'git status --porcelain=v1',
      stdout: [
        ' M src/a.ts',
        ' M src/b.ts',
        'A  src/new.ts',
        '?? docs/new.md',
      ].join('\n'),
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('[git status summarized: 4 paths]');
    expect(result.stdout).toContain('M: 2');
    expect(result.stdout).toContain('A: 1');
    expect(result.stdout).toContain('??: 1');
  });

  it('summarizes long human status output and drops advisory boilerplate', () => {
    const modified = Array.from({ length: 40 }, (_, index) => `\tmodified:   src/file-${index}.ts`).join('\n');
    const result = filterGitStatus({
      command: 'git status',
      stdout: `On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n${modified}`,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('On branch main');
    expect(result.stdout).toContain('modified: 40');
    expect(result.stdout).not.toContain('use "git add');
  });
});
