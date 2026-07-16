import { describe, expect, it } from 'vitest';
import type { KodaXToolExecutionContext } from '../../types.js';
import { applyCompiledOutputFilters } from './compiled/index.js';
import { applyDeclarativeOutputFilters } from './declarative.js';
import { applyGenericOutputFilter } from './generic.js';
import {
  filterBashOutputBodies,
  finalizeFilteredBashOutput,
  renderBashBody,
} from './registry.js';

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    executionCwd: process.cwd(),
  };
}

describe('output filter registry', () => {
  it('renders stdout, stderr, and notes in the same body shape bash uses', () => {
    expect(renderBashBody({
      stdout: 'out',
      stderr: 'err',
      lossiness: 'none',
      note: '[hint] saved',
    })).toBe('out\n[stderr]\nerr\n[hint] saved');
  });

  it('applies the Phase 0 generic filter to decoded bash bodies', async () => {
    const result = await filterBashOutputBodies({
      command: 'node color.js',
      stdout: '\u001B[31mok\u001B[0m',
      stderr: '',
      ctx: makeCtx(),
    });

    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
    expect(result.lossiness).toBe('none');
  });

  it('does not run command-specific lossy filters by default', async () => {
    const repeatedBody = Array.from({ length: 60 }, (_, index) => (
      `${index.toString(16).padStart(7, 'a')} commit-${index}`
    )).join('\n');
    let persisted = false;
    const result = await filterBashOutputBodies({
      command: 'git log --oneline',
      stdout: repeatedBody,
      stderr: '',
      ctx: makeCtx(),
      persist: async () => {
        persisted = true;
        return 'C:\\tmp\\unused.txt';
      },
    });

    expect(result).toEqual({
      stdout: repeatedBody,
      stderr: '',
      lossiness: 'none',
    });
    expect(persisted).toBe(false);
  });

  it('keeps command-specific filters available for explicit use', async () => {
    const repeatedBody = Array.from({ length: 120 }, (_, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      'index 111..222 100644',
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')).join('\n');
    const result = await filterBashOutputBodies({
      command: 'git diff',
      stdout: repeatedBody,
      stderr: '',
      ctx: makeCtx(),
      filters: [
        applyGenericOutputFilter,
        applyCompiledOutputFilters,
        applyDeclarativeOutputFilters,
      ],
      persist: async (toolName, content) => {
        expect(toolName).toBe('bash-output-raw');
        expect(content).toBe(repeatedBody);
        return 'C:\\tmp\\git-diff-raw.txt';
      },
    });

    expect(result.lossiness).toBe('whole');
    expect(result.stdout).toContain('[git diff summarized: 120 files, +120 -120]');
    expect(result.note).toContain('full raw output saved to: C:\\tmp\\git-diff-raw.txt');
  });

  it('returns raw bodies when a filter throws', async () => {
    const result = await filterBashOutputBodies({
      command: 'node noisy.js',
      stdout: 'raw stdout',
      stderr: 'raw stderr',
      ctx: makeCtx(),
      filters: [
        () => {
          throw new Error('bad filter');
        },
      ],
    });

    expect(result).toEqual({
      stdout: 'raw stdout',
      stderr: 'raw stderr',
      lossiness: 'none',
    });
  });

  it('persists raw body and appends a recovery hint for lossy filters', async () => {
    const rawStdout = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
    const result = await finalizeFilteredBashOutput({
      raw: {
        stdout: rawStdout,
        stderr: '',
        lossiness: 'none',
      },
      filtered: {
        stdout: 'line 1',
        stderr: '',
        lossiness: 'tail',
      },
      ctx: makeCtx(),
      persist: async (_toolName, content) => {
        expect(content).toBe(rawStdout);
        return 'C:\\tmp\\raw-output.txt';
      },
    });

    expect(result.stdout).toBe('line 1');
    expect(result.note).toContain('full raw output saved to: C:\\tmp\\raw-output.txt');
    expect(result.lossiness).toBe('tail');
  });

  it('does not persist lossy candidates that do not reduce token usage before recovery hints', async () => {
    let persistCalled = false;
    const result = await finalizeFilteredBashOutput({
      raw: {
        stdout: 'small',
        stderr: '',
        lossiness: 'none',
      },
      filtered: {
        stdout: 'small but longer',
        stderr: '',
        lossiness: 'tail',
      },
      ctx: makeCtx(),
      persist: async () => {
        persistCalled = true;
        return 'C:\\tmp\\unused.txt';
      },
    });

    expect(result).toEqual({
      stdout: 'small',
      stderr: '',
      lossiness: 'none',
    });
    expect(persistCalled).toBe(false);
  });

  it('returns the raw body when lossy persistence fails', async () => {
    const result = await finalizeFilteredBashOutput({
      raw: {
        stdout: 'line 1\nline 2\nline 3',
        stderr: '',
        lossiness: 'none',
      },
      filtered: {
        stdout: 'line 1',
        stderr: '',
        lossiness: 'tail',
      },
      ctx: makeCtx(),
      persist: async () => {
        throw new Error('disk full');
      },
    });

    expect(result).toEqual({
      stdout: 'line 1\nline 2\nline 3',
      stderr: '',
      lossiness: 'none',
    });
  });
});
