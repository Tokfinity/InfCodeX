import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalizedImage } from './image-normalize.js';
import {
  PASTE_TMP_DIR_ENV,
  PASTE_TMP_TTL_MS,
  persistImageAsBlock,
  prunePasteTmpDir,
} from './persist-image.js';

describe('persistImageAsBlock media helper', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-media-persist-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('writes under caller-provided directory with a hash-based file name', async () => {
    const image: NormalizedImage = {
      buffer: Buffer.from('image-bytes'),
      mediaType: 'image/png',
      width: 10,
      height: 10,
    };

    const block = await persistImageAsBlock(image, {
      directory: tempDir,
      fileNamePrefix: 'space-clip',
    });

    expect(block.type).toBe('image');
    expect(block.mediaType).toBe('image/png');
    expect(block.path.startsWith(tempDir)).toBe(true);
    expect(path.basename(block.path)).toMatch(/^space-clip-[a-f0-9]{16}\.png$/);
    await expect(fs.readFile(block.path, 'utf8')).resolves.toBe('image-bytes');
  });

  it('prunePasteTmpDir removes stale files with ANY KodaX prefix and spares unrelated files', async () => {
    const prev = process.env[PASTE_TMP_DIR_ENV];
    process.env[PASTE_TMP_DIR_ENV] = tempDir;
    try {
      const now = Date.now();
      const staleDate = new Date(now - PASTE_TMP_TTL_MS - 60_000);
      const hash = 'a'.repeat(16);
      const custom = path.join(tempDir, `partner-clip-${hash}.png`); // non-default prefix
      const dfault = path.join(tempDir, `paste-${hash}.jpg`);
      const unrelated = path.join(tempDir, 'notes.txt'); // not KodaX-shaped
      for (const [file, body] of [[custom, 'x'], [dfault, 'y'], [unrelated, 'z']] as const) {
        await fs.writeFile(file, body);
        await fs.utimes(file, staleDate, staleDate);
      }
      const deleted = await prunePasteTmpDir(now);
      expect(deleted).toBe(2); // both KodaX-shaped files, regardless of prefix
      await expect(fs.access(custom)).rejects.toThrow();
      await expect(fs.access(dfault)).rejects.toThrow();
      await expect(fs.access(unrelated)).resolves.toBeUndefined(); // untouched
    } finally {
      if (prev === undefined) delete process.env[PASTE_TMP_DIR_ENV];
      else process.env[PASTE_TMP_DIR_ENV] = prev;
    }
  });
});
