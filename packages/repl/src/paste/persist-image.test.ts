import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PASTE_TMP_DIR_ENV,
  PASTE_TMP_TTL_MS,
  persistImageAsBlock,
  prunePasteTmpDir,
} from './persist-image.js';
import type { NormalizedImage } from './image-normalize.js';

/** A minimal normalized PNG whose bytes vary by `content` (→ distinct hash). */
function pngImage(content: string): NormalizedImage {
  return { buffer: Buffer.from(content), mediaType: 'image/png', width: 1, height: 1 };
}

describe('persistImageAsBlock', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-persist-image-test-'));
    process.env[PASTE_TMP_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[PASTE_TMP_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('writes the buffer to disk and returns a KodaXImageBlock referencing the file', async () => {
    const fakeImage: NormalizedImage = {
      buffer: Buffer.from('FAKE-PNG-CONTENT'),
      mediaType: 'image/png',
      width: 10,
      height: 10,
    };
    const block = await persistImageAsBlock(fakeImage);
    expect(block.type).toBe('image');
    expect(block.mediaType).toBe('image/png');
    expect(block.path.endsWith('.png')).toBe(true);
    expect(block.path.startsWith(tempDir)).toBe(true);

    const onDisk = await fs.readFile(block.path);
    expect(onDisk.toString('utf-8')).toBe('FAKE-PNG-CONTENT');
  });

  it('uses .jpg extension for image/jpeg mediaType', async () => {
    const fakeImage: NormalizedImage = {
      buffer: Buffer.from('FAKE-JPEG'),
      mediaType: 'image/jpeg',
      width: 10,
      height: 10,
    };
    const block = await persistImageAsBlock(fakeImage);
    expect(block.path.endsWith('.jpg')).toBe(true);
    expect(block.mediaType).toBe('image/jpeg');
  });

  it('reuses the same path for identical content (content-hash filename)', async () => {
    const image: NormalizedImage = {
      buffer: Buffer.from('x'),
      mediaType: 'image/png',
      width: 1,
      height: 1,
    };
    const results = await Promise.all([
      persistImageAsBlock(image),
      persistImageAsBlock(image),
      persistImageAsBlock(image),
    ]);
    const paths = new Set(results.map((b) => b.path));
    expect(paths.size).toBe(1);
    const entries = await fs.readdir(tempDir);
    expect(entries.length).toBe(1);
  });

  it('produces distinct paths for different content', async () => {
    const a: NormalizedImage = {
      buffer: Buffer.from('alpha'),
      mediaType: 'image/png',
      width: 1,
      height: 1,
    };
    const b: NormalizedImage = {
      buffer: Buffer.from('beta'),
      mediaType: 'image/png',
      width: 1,
      height: 1,
    };
    const blockA = await persistImageAsBlock(a);
    const blockB = await persistImageAsBlock(b);
    expect(blockA.path).not.toBe(blockB.path);
  });

  it('creates the temp directory if it does not exist', async () => {
    const nestedDir = path.join(tempDir, 'nested', 'paste-dir');
    process.env[PASTE_TMP_DIR_ENV] = nestedDir;
    const image: NormalizedImage = {
      buffer: Buffer.from('content'),
      mediaType: 'image/png',
      width: 1,
      height: 1,
    };
    const block = await persistImageAsBlock(image);
    expect(block.path.startsWith(nestedDir)).toBe(true);
    const stat = await fs.stat(nestedDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('prunePasteTmpDir', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-prune-test-'));
    process.env[PASTE_TMP_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[PASTE_TMP_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns 0 and does not throw when the paste tmp dir does not exist', async () => {
    process.env[PASTE_TMP_DIR_ENV] = path.join(tempDir, 'does-not-exist');
    const deleted = await prunePasteTmpDir();
    expect(deleted).toBe(0);
  });

  it('deletes paste files older than PASTE_TMP_TTL_MS', async () => {
    // Use the real writer so the fixtures carry the actual `-<16 hex>.png`
    // filename shape prunePasteTmpDir matches — hard-coded fake names (e.g.
    // 'paste-oldhash.png') silently stop matching if the shape is tightened.
    const oldBlock = await persistImageAsBlock(pngImage('old'));
    const newBlock = await persistImageAsBlock(pngImage('new'));
    // Backdate the old file 48h
    const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(oldBlock.path, oldMtime, oldMtime);

    const deleted = await prunePasteTmpDir();
    expect(deleted).toBe(1);
    await expect(fs.stat(oldBlock.path)).rejects.toThrow();
    await expect(fs.stat(newBlock.path)).resolves.toBeDefined();
  });

  it('preserves non-paste files (e.g., user accidentally dropped a notes.txt)', async () => {
    const unrelated = path.join(tempDir, 'notes.txt');
    await fs.writeFile(unrelated, 'user notes');
    const oldPaste = await persistImageAsBlock(pngImage('old'));
    // Backdate both
    const backdated = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(unrelated, backdated, backdated);
    await fs.utimes(oldPaste.path, backdated, backdated);

    const deleted = await prunePasteTmpDir();
    expect(deleted).toBe(1);
    await expect(fs.stat(unrelated)).resolves.toBeDefined();
  });

  it('TTL boundary — files at exactly TTL_MS are deleted (older than cutoff)', async () => {
    const borderline = await persistImageAsBlock(pngImage('borderline'));
    const now = Date.now();
    // Set mtime to just past the TTL boundary
    const justPast = new Date(now - PASTE_TMP_TTL_MS - 1000);
    await fs.utimes(borderline.path, justPast, justPast);

    const deleted = await prunePasteTmpDir(now);
    expect(deleted).toBe(1);
  });
});
