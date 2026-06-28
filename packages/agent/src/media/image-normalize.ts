import { Jimp } from 'jimp';
import { ImageResizeError } from './errors.js';

export const MAX_DIMENSION = 2000;
export const TARGET_RAW_SIZE_BYTES = Math.floor(3.75 * 1024 * 1024);

export interface NormalizedImage {
  readonly buffer: Buffer;
  readonly mediaType: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
}

export interface NormalizeImageOptions {
  readonly maxDimension?: number;
  readonly targetBytes?: number;
  readonly preferMediaType?: 'image/png' | 'image/jpeg';
}

const JPEG_QUALITY_LADDER: readonly number[] = [80, 60, 40];

export async function normalizePastedImage(
  input: Buffer,
  options: NormalizeImageOptions = {},
): Promise<NormalizedImage> {
  const maxDimension = options.maxDimension ?? MAX_DIMENSION;
  const targetBytes = options.targetBytes ?? TARGET_RAW_SIZE_BYTES;

  if (input.length === 0) {
    throw new ImageResizeError('Empty image buffer.', { code: 'IMAGE_DECODE_FAILED' });
  }

  let image;
  try {
    image = await Jimp.read(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ImageResizeError(`Failed to decode image: ${reason}`, {
      code: 'IMAGE_DECODE_FAILED',
      cause: error,
    });
  }

  const { width, height } = image.bitmap;
  const longestSide = Math.max(width, height);
  if (longestSide > maxDimension) {
    const ratio = maxDimension / longestSide;
    image.resize({
      w: Math.max(1, Math.round(width * ratio)),
      h: Math.max(1, Math.round(height * ratio)),
    });
  }

  const finalWidth = image.bitmap.width;
  const finalHeight = image.bitmap.height;

  if (options.preferMediaType !== 'image/jpeg') {
    const png = await image.getBuffer('image/png');
    if (png.length <= targetBytes) {
      return {
        buffer: Buffer.from(png),
        mediaType: 'image/png',
        width: finalWidth,
        height: finalHeight,
      };
    }
  }

  for (const quality of JPEG_QUALITY_LADDER) {
    const jpeg = await image.getBuffer('image/jpeg', { quality });
    if (jpeg.length <= targetBytes) {
      return {
        buffer: Buffer.from(jpeg),
        mediaType: 'image/jpeg',
        width: finalWidth,
        height: finalHeight,
      };
    }
  }

  if (options.preferMediaType === 'image/jpeg') {
    const png = await image.getBuffer('image/png');
    if (png.length <= targetBytes) {
      return {
        buffer: Buffer.from(png),
        mediaType: 'image/png',
        width: finalWidth,
        height: finalHeight,
      };
    }
  }

  throw new ImageResizeError(
    `Image still exceeds budget (${targetBytes} bytes raw) after PNG and JPEG q40 compression. `
      + 'Try a smaller image or take a fresh screenshot of a smaller region.',
    { code: 'IMAGE_TOO_LARGE' },
  );
}
