import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { assertPatternEvidenceRefVisible } from './pattern-strategy.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

describe('F274 pattern evidence path policy', () => {
  it('normalizes an absolute traversal path before policy validation and delivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kodax-pattern-path-'));
    tempDirs.push(root);
    const secretPath = path.join(root, 'secret.txt');
    await writeFile(secretPath, 'bounded evidence');
    const rawPath = `${path.join(root, 'safe')}${path.sep}..${path.sep}secret.txt`;
    const assertReadablePath = vi.fn();
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      assertReadablePath,
    };

    await expect(assertPatternEvidenceRefVisible(`file:${rawPath}`, ctx))
      .resolves.toBeUndefined();

    expect(assertReadablePath).toHaveBeenCalledOnce();
    expect(assertReadablePath).toHaveBeenCalledWith(path.resolve(rawPath));
  });
});
