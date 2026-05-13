/**
 * FEATURE_134 (v0.7.40) — image normalization for paste input.
 *
 * Decodes a binary image buffer (whatever the OS clipboard handed us:
 * PNG, JPEG, BMP, GIF, etc.) and re-encodes it as PNG or JPEG within
 * KodaX's size budget for provider vision payloads.
 *
 * Size budget targets:
 *   - `MAX_DIMENSION = 2000` — clamp width/height (matches claudecode
 *     `IMAGE_MAX_WIDTH/HEIGHT`)
 *   - `TARGET_RAW_SIZE_BYTES = 3.75 * 1024 * 1024` — Anthropic's 5MB
 *     base64 wire limit reverse-engineered to raw bytes (5MB / 4 * 3)
 *
 * Encoding strategy:
 *   1. Try PNG.
 *   2. If PNG > target, try JPEG quality 80 → 60 → 40.
 *   3. If still oversized, throw `ImageResizeError` so the REPL can
 *      surface an inline error to the user.
 *
 * Pure function module. No I/O outside the jimp Buffer pipeline.
 */

import { Jimp } from 'jimp';

export const MAX_DIMENSION = 2000;
export const TARGET_RAW_SIZE_BYTES = Math.floor(3.75 * 1024 * 1024);

export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageResizeError';
  }
}

export interface NormalizedImage {
  buffer: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const JPEG_QUALITY_LADDER: readonly number[] = [80, 60, 40];

export async function normalizePastedImage(input: Buffer): Promise<NormalizedImage> {
  if (input.length === 0) {
    throw new ImageResizeError('Empty image buffer.');
  }

  let image;
  try {
    image = await Jimp.read(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ImageResizeError(`Failed to decode image: ${reason}`);
  }

  // Clamp dimensions so resize ratio is at most 1.
  const { width, height } = image.bitmap;
  const longestSide = Math.max(width, height);
  if (longestSide > MAX_DIMENSION) {
    const ratio = MAX_DIMENSION / longestSide;
    image.resize({
      w: Math.max(1, Math.round(width * ratio)),
      h: Math.max(1, Math.round(height * ratio)),
    });
  }

  const finalWidth = image.bitmap.width;
  const finalHeight = image.bitmap.height;

  // First try PNG. PNG is lossless and small for screenshots with flat
  // regions (the dominant paste payload type).
  const pngBuffer = await image.getBuffer('image/png');
  if (pngBuffer.length <= TARGET_RAW_SIZE_BYTES) {
    return {
      buffer: Buffer.from(pngBuffer),
      mediaType: 'image/png',
      width: finalWidth,
      height: finalHeight,
    };
  }

  // PNG too big. Fall back to JPEG quality ladder.
  for (const quality of JPEG_QUALITY_LADDER) {
    const jpegBuffer = await image.getBuffer('image/jpeg', { quality });
    if (jpegBuffer.length <= TARGET_RAW_SIZE_BYTES) {
      return {
        buffer: Buffer.from(jpegBuffer),
        mediaType: 'image/jpeg',
        width: finalWidth,
        height: finalHeight,
      };
    }
  }

  throw new ImageResizeError(
    `Image still exceeds budget (${TARGET_RAW_SIZE_BYTES} bytes raw) after PNG and JPEG q40 compression. `
      + 'Try a smaller image or take a fresh screenshot of a smaller region.',
  );
}
