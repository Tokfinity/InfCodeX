import { describe, expect, it } from 'vitest';

import {
  auditChildProcessSource,
} from '../scripts/audit-runtime-windows-hide.mjs';

describe('Runtime Worker windowsHide audit', () => {
  it('reads windowsHide from the AST instead of truncated source text', () => {
    const padding = Array.from({ length: 20 }, (_, index) => (
      `padding${index}: ${JSON.stringify(`value-${index}`)}`
    )).join(',\n');
    const result = auditChildProcessSource(
      'packages/example/dist/background.js',
      `
        import { spawn } from 'node:child_process';
        spawn('background-server', [], {
          ${padding},
          windowsHide: true,
        });
      `,
    );

    expect(result.calls).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  it('rejects a background child process without windowsHide', () => {
    const result = auditChildProcessSource(
      'packages/example/dist/background.js',
      `
        import { execFile } from 'node:child_process';
        execFile('git', ['status'], { cwd: process.cwd() });
      `,
    );

    expect(result.violations).toEqual([
      expect.objectContaining({
        method: 'execFile',
        line: 3,
      }),
    ]);
  });

  it('reports a missing options argument instead of crashing', () => {
    const result = auditChildProcessSource(
      'packages/example/dist/background.js',
      `
        import { spawn } from 'node:child_process';
        spawn('background-server');
      `,
    );

    expect(result.violations).toEqual([
      expect.objectContaining({
        method: 'spawn',
        line: 3,
      }),
    ]);
  });

  it('keeps the explicit external editor as an interactive exception', () => {
    const result = auditChildProcessSource(
      'packages/repl/dist/interactive/readline-helpers.js',
      `
        import * as childProcess from 'child_process';
        childProcess.spawnSync(editor, [tmpFile], {
          stdio: 'inherit',
          shell: false,
        });
      `,
    );

    expect(result.violations).toEqual([]);
    expect(result.exceptions).toEqual([
      expect.objectContaining({
        reason: 'explicit interactive external editor',
      }),
    ]);
  });
});
