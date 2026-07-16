import { describe, expect, it } from 'vitest';
import { filterGitLog } from './git-log.js';

describe('git log output filter', () => {
  it('keeps the newest commits and omits the long tail', () => {
    const stdout = Array.from({ length: 80 }, (_, index) => `${String(index).padStart(7, 'a')} commit subject ${index}`).join('\n');
    const result = filterGitLog({
      command: 'git log --oneline',
      stdout,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('[git log summarized: showing 30 of 80 lines]');
    expect(result.stdout).toContain('commit subject 0');
    expect(result.stdout).not.toContain('commit subject 79');
  });
});
