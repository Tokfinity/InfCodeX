import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { MAX_PER_FILE, pretty, report } from './diagnostic.js';

function diag(line: number, character: number, message: string, severity = 1): Diagnostic {
  return {
    severity,
    range: { start: { line, character }, end: { line, character: character + 1 } },
    message,
  };
}

describe('pretty', () => {
  it('formats severity + 1-based line/col + message', () => {
    expect(pretty(diag(11, 4, "Cannot find name 'foo'"))).toBe("ERROR [12:5] Cannot find name 'foo'");
  });

  it('labels non-error severities', () => {
    expect(pretty(diag(0, 0, 'warn', 2))).toBe('WARN [1:1] warn');
    expect(pretty(diag(0, 0, 'info', 3))).toBe('INFO [1:1] info');
    expect(pretty(diag(0, 0, 'hint', 4))).toBe('HINT [1:1] hint');
  });
});

describe('report', () => {
  it('returns empty string when there are no errors', () => {
    expect(report('/a.ts', [])).toBe('');
    expect(report('/a.ts', [diag(0, 0, 'w', 2), diag(1, 1, 'i', 3)])).toBe('');
  });

  it('surfaces only ERROR-severity diagnostics', () => {
    const block = report('/a.ts', [diag(0, 0, 'real error', 1), diag(1, 0, 'just a warning', 2)]);
    expect(block).toContain('real error');
    expect(block).not.toContain('just a warning');
  });

  it('wraps in a <diagnostics file> block', () => {
    const block = report('/abs/a.ts', [diag(2, 0, 'boom')]);
    expect(block).toBe('<diagnostics file="/abs/a.ts">\nERROR [3:1] boom\n</diagnostics>');
  });

  it('caps at MAX_PER_FILE and notes the overflow', () => {
    const many = Array.from({ length: MAX_PER_FILE + 5 }, (_, i) => diag(i, 0, `e${i}`));
    const block = report('/a.ts', many);
    const lines = block.split('\n').filter((l) => l.startsWith('ERROR'));
    expect(lines).toHaveLength(MAX_PER_FILE);
    expect(block).toContain('... and 5 more');
  });

  it('treats a missing severity as ERROR', () => {
    const block = report('/a.ts', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' }]);
    expect(block).toContain('ERROR [1:1] x');
  });
});
