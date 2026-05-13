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
    const input = await makePng(3000, 1500);
    const result = await normalizePastedImage(input);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_DIMENSION);
    // 3000:1500 aspect ratio = 2:1 → clamped to 2000:1000
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
  });

  it('preserves aspect ratio on portrait images', async () => {
    const input = await makePng(1500, 3000);
    const result = await normalizePastedImage(input);
    expect(result.width).toBe(1000);
    expect(result.height).toBe(2000);
  });

  it('does not upscale small images', async () => {
    const input = await makePng(50, 50);
    const result = await normalizePastedImage(input);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  // This test generates a 2500×2500 noise PNG which is slow under parallel
  // vitest load (4-9s wall clock). Default 5s timeout flaps; bump to 30s.
  it('produces output ≤ TARGET_RAW_SIZE_BYTES even for large noisy input', { timeout: 30_000 }, async () => {
    // Random-ish content compresses poorly under PNG. Large dimensions
    // ensure the post-clamp 2000×2000 result still has enough entropy to
    // force the JPEG quality ladder (PNG won't fit budget for noise).
    const w = 2500;
    const h = 2500;
    const img = new Jimp({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = (x * 31 + y * 17) & 0xff;
        const g = (x * 53 + y * 41) & 0xff;
        const b = (x * 11 + y * 73) & 0xff;
        // RGBA packed as unsigned 32-bit (Jimp expects uint32).
        const rgba = ((r * 0x1000000) + (g * 0x10000) + (b * 0x100) + 0xff) >>> 0;
        img.setPixelColor(rgba, x, y);
      }
    }
    const pngInput = Buffer.from(await img.getBuffer('image/png'));
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
