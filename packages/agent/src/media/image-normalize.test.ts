import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  MAX_DIMENSION,
  normalizePastedImage,
} from './image-normalize.js';
import { ImageResizeError } from './errors.js';

async function makePng(width: number, height: number, color = 0x2266ccff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
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
    const result = await normalizePastedImage(
      await makePng(MAX_DIMENSION + 20, MAX_DIMENSION / 2 + 10),
    );

    expect(result.width).toBe(MAX_DIMENSION);
    expect(result.height).toBe(MAX_DIMENSION / 2);
  });

  it('wraps decode failures in ImageResizeError', async () => {
    await expect(normalizePastedImage(Buffer.from('not an image')))
      .rejects.toBeInstanceOf(ImageResizeError);
  });
});
