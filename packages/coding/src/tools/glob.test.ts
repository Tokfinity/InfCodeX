import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolGlob } from './glob.js';

describe('toolGlob', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns every exact path and leaves capacity admission to the outer owner', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-glob-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    for (let index = 0; index < 120; index++) {
      writeFileSync(join(tempDir, 'src', `file-${index.toString().padStart(3, '0')}.ts`), '', 'utf8');
    }

    const result = await toolGlob({ pattern: 'src/*.ts' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result.split('\n')).toHaveLength(120);
    expect(result).toContain('file-000.ts');
    expect(result).toContain('file-119.ts');
    expect(result).not.toContain('... (more files)');
  });
});
