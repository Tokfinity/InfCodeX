import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractImagePaths,
  handleBracketedPaste,
  triggerExplicitClipboardImage,
} from './paste-handler.js';
import { PASTE_TMP_DIR_ENV } from './persist-image.js';

describe('extractImagePaths', () => {
  it('returns empty array for plain text', () => {
    expect(extractImagePaths('hello world')).toEqual([]);
  });

  it('returns empty array for paths without image extensions', () => {
    expect(extractImagePaths('/home/user/README.md')).toEqual([]);
  });

  it('extracts a single POSIX image path', () => {
    expect(extractImagePaths('/home/user/screenshot.png')).toEqual([
      '/home/user/screenshot.png',
    ]);
  });

  it('extracts a single Windows image path', () => {
    expect(extractImagePaths('C:\\Users\\iceto\\Pictures\\screenshot.png')).toEqual([
      'C:\\Users\\iceto\\Pictures\\screenshot.png',
    ]);
  });

  it('extracts multiple paths separated by spaces', () => {
    const input = '/a/one.png /b/two.jpg /c/three.gif';
    expect(extractImagePaths(input)).toEqual([
      '/a/one.png',
      '/b/two.jpg',
      '/c/three.gif',
    ]);
  });

  it('accepts common image extensions case-insensitively', () => {
    expect(extractImagePaths('/path/to/PIC.PNG')).toEqual(['/path/to/PIC.PNG']);
    expect(extractImagePaths('/path/to/pic.JPEG')).toEqual(['/path/to/pic.JPEG']);
    expect(extractImagePaths('/path/to/pic.WebP')).toEqual(['/path/to/pic.WebP']);
  });

  it('handles space-separated path + image (e.g. user typed a label before drag)', () => {
    // The separator regex looks for " " followed by "/" or "X:\". Plain
    // text before a path is treated as a separate segment that won't
    // match the image regex.
    const input = 'check this /home/img.png';
    expect(extractImagePaths(input)).toEqual(['/home/img.png']);
  });
});

describe('handleBracketedPaste', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-paste-handler-'));
    process.env[PASTE_TMP_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[PASTE_TMP_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('plain text → text outcome', async () => {
    const outcome = await handleBracketedPaste('hello world');
    expect(outcome.kind).toBe('text');
    if (outcome.kind === 'text') {
      expect(outcome.text).toBe('hello world');
    }
  });

  it('text containing a non-image path → text outcome (no false-positive)', async () => {
    const outcome = await handleBracketedPaste('see /home/user/README.md');
    expect(outcome.kind).toBe('text');
  });

  it('reads a real image file path and produces images outcome', async () => {
    const imgFile = path.join(tempDir, 'fixture.png');
    const img = new Jimp({ width: 50, height: 50, color: 0xff0000ff });
    const pngBuf = Buffer.from(await img.getBuffer('image/png'));
    await fs.writeFile(imgFile, pngBuf);
    const outcome = await handleBracketedPaste(imgFile);
    expect(outcome.kind).toBe('images');
    if (outcome.kind === 'images') {
      expect(outcome.blocks).toHaveLength(1);
      expect(outcome.blocks[0]!.type).toBe('image');
      expect(outcome.blocks[0]!.path.startsWith(tempDir)).toBe(true);
    }
  });

  it('handles multiple image paths in one paste (drag of multiple files)', async () => {
    const a = path.join(tempDir, 'a.png');
    const b = path.join(tempDir, 'b.png');
    const imgA = new Jimp({ width: 10, height: 10, color: 0xff0000ff });
    const imgB = new Jimp({ width: 10, height: 10, color: 0x00ff00ff });
    await fs.writeFile(a, Buffer.from(await imgA.getBuffer('image/png')));
    await fs.writeFile(b, Buffer.from(await imgB.getBuffer('image/png')));
    const outcome = await handleBracketedPaste(`${a} ${b}`);
    expect(outcome.kind).toBe('images');
    if (outcome.kind === 'images') {
      expect(outcome.blocks).toHaveLength(2);
    }
  });

  it('non-existent image path → error outcome with descriptive message', async () => {
    const outcome = await handleBracketedPaste('/nonexistent/never.png');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('Failed to read');
    }
  });

  it('empty paste on non-macOS → text outcome with empty string', async () => {
    if (process.platform === 'darwin') {
      // Skip — macOS branch reads clipboard which we don't control here.
      return;
    }
    const outcome = await handleBracketedPaste('');
    expect(outcome.kind).toBe('text');
    if (outcome.kind === 'text') {
      expect(outcome.text).toBe('');
    }
  });
});

describe('triggerExplicitClipboardImage', () => {
  it('returns Buffer|null|error without throwing', async () => {
    // In CI the clipboard is typically empty / the helper binary may be
    // missing. Either way the function must not throw.
    const outcome = await triggerExplicitClipboardImage();
    expect(['noop', 'images', 'error']).toContain(outcome.kind);
  });
});
