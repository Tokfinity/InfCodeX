import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  MAX_DIMENSION,
  TARGET_RAW_SIZE_BYTES,
  normalizePastedImage,
} from './image-normalize.js';
import { ImageResizeError } from './errors.js';

async function makePng(width: number, height: number, color = 0x2266ccff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return Buffer.from(await image.getBuffer('image/png'));
}

async function makePoorlyCompressingPng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height });
  const data = image.bitmap.data;
  let offset = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[offset++] = (x * 31 + y * 17) & 0xff;
      data[offset++] = (x * 53 + y * 41) & 0xff;
      data[offset++] = (x * 11 + y * 73) & 0xff;
      data[offset++] = 0xff;
    }
  }
  return Buffer.from(await image.getBuffer('image/png'));
}

describe('normalizePastedImage', () => {
  it('decodes a real PNG buffer and keeps small images at their original size', async () => {
    const result = await normalizePastedImage(await makePng(64, 48));

    expect(result.mediaType).toBe('image/png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('clamps large images to the configured maximum dimension', async () => {
    const landscape = await normalizePastedImage(
      await makePng(MAX_DIMENSION + 20, MAX_DIMENSION / 2 + 10),
    );
    const portrait = await normalizePastedImage(
      await makePng(MAX_DIMENSION / 2 + 10, MAX_DIMENSION + 20),
    );

    expect([landscape.width, landscape.height]).toEqual([MAX_DIMENSION, MAX_DIMENSION / 2]);
    expect([portrait.width, portrait.height]).toEqual([MAX_DIMENSION / 2, MAX_DIMENSION]);
  });

  it('keeps poorly compressing output within the raw-size contract', { timeout: 45_000 }, async () => {
    const input = await makePoorlyCompressingPng(MAX_DIMENSION - 100, MAX_DIMENSION - 100);
    const result = await normalizePastedImage(input);

    expect(['image/png', 'image/jpeg']).toContain(result.mediaType);
    expect(result.buffer.length).toBeLessThanOrEqual(TARGET_RAW_SIZE_BYTES);
  });

  it.each([Buffer.alloc(0), Buffer.from('not an image')])(
    'wraps decode failures in ImageResizeError',
    async (input) => {
      await expect(normalizePastedImage(input))
        .rejects.toBeInstanceOf(ImageResizeError);
    },
  );
});
