import { describe, expect, it } from 'vitest';
import { filterTestRunner } from './test-runner.js';

describe('test runner output filter', () => {
  it('focuses long test output on failures and summaries', () => {
    const passingNoise = Array.from({ length: 160 }, (_, index) => `PASS src/pass-${index}.test.ts`).join('\n');
    const stdout = [
      passingNoise,
      'FAIL src/fail.test.ts',
      'AssertionError: expected true to be false',
      '  at src/fail.test.ts:10:5',
      'Test Files 1 failed | 160 passed',
      'Tests 1 failed | 320 passed',
    ].join('\n');

    const result = filterTestRunner({
      command: 'npx vitest run',
      stdout,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('FAIL src/fail.test.ts');
    expect(result.stdout).toContain('AssertionError');
    expect(result.stdout).toContain('Test Files 1 failed');
    expect(result.stdout).not.toContain('pass-0.test.ts');
  });
});
