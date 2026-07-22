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

function image(content: string, mediaType: NormalizedImage['mediaType'] = 'image/png'): NormalizedImage {
  return { buffer: Buffer.from(content), mediaType, width: 1, height: 1 };
}

describe('persisted media images', () => {
  let tempDir = '';
  let previousTempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-media-persist-'));
    previousTempDir = process.env[PASTE_TMP_DIR_ENV];
    process.env[PASTE_TMP_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    if (previousTempDir === undefined) delete process.env[PASTE_TMP_DIR_ENV];
    else process.env[PASTE_TMP_DIR_ENV] = previousTempDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes under a caller-provided directory with a sanitized hash-based name', async () => {
    const block = await persistImageAsBlock(image('image-bytes'), {
      directory: tempDir,
      fileNamePrefix: 'space clip',
    });

    expect(block).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(path.dirname(block.path)).toBe(tempDir);
    expect(path.basename(block.path)).toMatch(/^space-clip-[a-f0-9]{16}\.png$/);
    await expect(fs.readFile(block.path, 'utf8')).resolves.toBe('image-bytes');
  });

  it('uses the JPEG extension for JPEG content', async () => {
    const block = await persistImageAsBlock(image('jpeg-bytes', 'image/jpeg'));

    expect(block.path).toMatch(/\.jpg$/);
    expect(block.mediaType).toBe('image/jpeg');
  });

  it('reuses a path for identical content and separates different content', async () => {
    const [first, duplicate, different] = await Promise.all([
      persistImageAsBlock(image('same')),
      persistImageAsBlock(image('same')),
      persistImageAsBlock(image('different')),
    ]);

    expect(duplicate.path).toBe(first.path);
    expect(different.path).not.toBe(first.path);
    await expect(fs.readdir(tempDir)).resolves.toHaveLength(2);
  });

  it('creates a missing target directory', async () => {
    const nestedDir = path.join(tempDir, 'nested', 'paste-dir');
    process.env[PASTE_TMP_DIR_ENV] = nestedDir;

    const block = await persistImageAsBlock(image('content'));

    expect(path.dirname(block.path)).toBe(nestedDir);
    expect((await fs.stat(nestedDir)).isDirectory()).toBe(true);
  });

  it('returns zero when the temporary directory does not exist', async () => {
    process.env[PASTE_TMP_DIR_ENV] = path.join(tempDir, 'missing');

    await expect(prunePasteTmpDir()).resolves.toBe(0);
  });

  it('prunes stale KodaX images across prefixes while preserving current and unrelated files', async () => {
    const now = Date.now();
    const staleDate = new Date(now - PASTE_TMP_TTL_MS - 1_000);
    const current = await persistImageAsBlock(image('current'));
    const custom = await persistImageAsBlock(image('custom'), { fileNamePrefix: 'partner-clip' });
    const standard = await persistImageAsBlock(image('standard'));
    const unrelated = path.join(tempDir, 'notes.txt');
    await fs.writeFile(unrelated, 'keep');
    await Promise.all([
      fs.utimes(custom.path, staleDate, staleDate),
      fs.utimes(standard.path, staleDate, staleDate),
      fs.utimes(unrelated, staleDate, staleDate),
    ]);

    await expect(prunePasteTmpDir(now)).resolves.toBe(2);
    await expect(fs.access(custom.path)).rejects.toThrow();
    await expect(fs.access(standard.path)).rejects.toThrow();
    await expect(fs.access(current.path)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });
});
