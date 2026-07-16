import { describe, expect, it } from 'vitest';
import { filterLint } from './lint.js';

describe('lint output filter', () => {
  it('keeps diagnostics and summaries from noisy lint output', () => {
    const noise = Array.from({ length: 120 }, (_, index) => `checked file ${index}`).join('\n');
    const result = filterLint({
      command: 'npx eslint .',
      stdout: [
        noise,
        'src/a.ts',
        '  10:5  error  Unexpected var  no-var',
        '',
        '\u2716 1 problem (1 error, 0 warnings)',
      ].join('\n'),
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('tail');
    expect(result.stdout).toContain('Unexpected var');
    expect(result.stdout).toContain('1 problem');
    expect(result.stdout).not.toContain('checked file 0');
  });
});
