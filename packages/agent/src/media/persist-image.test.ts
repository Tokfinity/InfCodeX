import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalizedImage } from './image-normalize.js';
import { persistImageAsBlock } from './persist-image.js';

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
});
