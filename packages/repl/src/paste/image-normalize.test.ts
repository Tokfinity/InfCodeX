import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  ImageResizeError,
  MAX_DIMENSION,
  TARGET_RAW_SIZE_BYTES,
  normalizePastedImage,
} from './image-normalize.js';

async function makePng(width: number, height: number, color = 0xff0000ff): Promise<Buffer> {
  const img = new Jimp({ width, height, color });
  const out = await img.getBuffer('image/png');
  return Buffer.from(out);
}

async function makePoorlyCompressingPng(width: number, height: number): Promise<Buffer> {
  const img = new Jimp({ width, height });
  const data = img.bitmap.data;
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[i++] = (x * 31 + y * 17) & 0xff;
      data[i++] = (x * 53 + y * 41) & 0xff;
      data[i++] = (x * 11 + y * 73) & 0xff;
      data[i++] = 0xff;
    }
  }
  const out = await img.getBuffer('image/png');
  return Buffer.from(out);
}

describe('normalizePastedImage', () => {
  it('returns the input as-is when small enough (PNG fast path)', async () => {
    const input = await makePng(100, 100);
    const result = await normalizePastedImage(input);
    expect(result.mediaType).toBe('image/png');
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('clamps width/height to MAX_DIMENSION when larger', async () => {
    const input = await makePng(MAX_DIMENSION + 10, (MAX_DIMENSION + 10) / 2);
    const result = await normalizePastedImage(input);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_DIMENSION);
    // 2010:1005 aspect ratio = 2:1 -> clamped to 2000:1000.
    expect(result.width).toBe(MAX_DIMENSION);
    expect(result.height).toBe(MAX_DIMENSION / 2);
  });

  it('preserves aspect ratio on portrait images', async () => {
    const input = await makePng((MAX_DIMENSION + 10) / 2, MAX_DIMENSION + 10);
    const result = await normalizePastedImage(input);
    expect(result.width).toBe(MAX_DIMENSION / 2);
    expect(result.height).toBe(MAX_DIMENSION);
  });

  it('does not upscale small images', async () => {
    const input = await makePng(50, 50);
    const result = await normalizePastedImage(input);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  it('produces output ≤ TARGET_RAW_SIZE_BYTES even for large noisy input', { timeout: 45_000 }, async () => {
    // Random-ish content compresses poorly under PNG; separate tests cover
    // the clamp path, so keep this focused on the output-size contract.
    const pngInput = await makePoorlyCompressingPng(MAX_DIMENSION - 100, MAX_DIMENSION - 100);
    const result = await normalizePastedImage(pngInput);
    // The output may be PNG or JPEG — either is fine, the contract is
    // "fit under TARGET_RAW_SIZE_BYTES".
    expect(['image/png', 'image/jpeg']).toContain(result.mediaType);
    expect(result.buffer.length).toBeLessThanOrEqual(TARGET_RAW_SIZE_BYTES);
    // And the dimensions should be clamped.
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_DIMENSION);
  });

  it('throws ImageResizeError when input buffer is empty', async () => {
    await expect(normalizePastedImage(Buffer.alloc(0))).rejects.toBeInstanceOf(ImageResizeError);
  });

  it('throws ImageResizeError when input is not a valid image', async () => {
    const garbage = Buffer.from('this is not an image, just plain text');
    await expect(normalizePastedImage(garbage)).rejects.toBeInstanceOf(ImageResizeError);
  });
});
