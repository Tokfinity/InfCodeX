import { describe, expect, it } from 'vitest';
import { KodaXMediaError } from './errors.js';
import { readClipboardImage } from './clipboard-image.js';

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux', 'win32']);

describe('readClipboardImage', () => {
  it('returns Buffer | null on supported platforms and a typed error otherwise', async () => {
    if (SUPPORTED_PLATFORMS.has(process.platform)) {
      const result = await readClipboardImage();
      expect(result === null || Buffer.isBuffer(result)).toBe(true);
      return;
    }

    await expect(readClipboardImage()).rejects.toBeInstanceOf(KodaXMediaError);
    await expect(readClipboardImage()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });
});
