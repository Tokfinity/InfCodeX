import { describe, expect, it } from 'vitest';
import { applyGenericOutputFilter, stripAnsiCodes } from './generic.js';

describe('generic output filter', () => {
  it('strips ANSI SGR codes from stdout and stderr without marking output lossy', () => {
    const result = applyGenericOutputFilter({
      stdout: '\u001B[31mred\u001B[0m\nplain',
      stderr: '\u001B[33mwarn\u001B[0m',
      lossiness: 'none',
    });

    expect(result).toEqual({
      stdout: 'red\nplain',
      stderr: 'warn',
      lossiness: 'none',
    });
  });

  it('strips OSC terminal-title sequences too', () => {
    expect(stripAnsiCodes('\u001B]0;secret-title\u0007done')).toBe('done');
  });

  it('preserves OSC8 hyperlink targets in the normalized text', () => {
    expect(stripAnsiCodes(
      '\u001B]8;;https://example.test/result\u0007open result\u001B]8;;\u0007',
    )).toBe('open result (https://example.test/result)');
  });

  it('preserves cursor-control sequences that cannot be stripped losslessly', () => {
    const output = 'abc\u001B[2DXY';

    expect(stripAnsiCodes(output)).toBe(output);
  });
});
