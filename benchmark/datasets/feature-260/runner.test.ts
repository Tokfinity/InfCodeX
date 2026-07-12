import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readFeature260JsonCache } from './runner.js';

describe('FEATURE_260 raw cache integrity', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined only for a missing cache file', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-f260-cache-'));
    await expect(readFeature260JsonCache(path.join(dir, 'missing.json'))).resolves.toBeUndefined();
  });

  it('fails loudly for malformed raw JSON', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-f260-cache-corrupt-'));
    const filePath = path.join(dir, 'cell.json');
    await writeFile(filePath, '{"truncated":', 'utf8');

    await expect(readFeature260JsonCache(filePath)).rejects.toThrow(/corrupt feature-260 cache/i);
  });
});
