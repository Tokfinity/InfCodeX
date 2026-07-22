import { describe, expect, it } from 'vitest';

import * as codingMedia from '@kodax-ai/coding/media';
import { readAndNormalizeClipboardImage, readClipboardImage } from './clipboard-image.js';
import {
  ImageResizeError,
  MAX_DIMENSION,
  TARGET_RAW_SIZE_BYTES,
  normalizePastedImage,
} from './image-normalize.js';
import {
  PASTE_TMP_DIR_ENV,
  PASTE_TMP_TTL_MS,
  persistImageAsBlock,
  prunePasteTmpDir,
} from './persist-image.js';

describe('REPL media facades', () => {
  it('re-exports Coding media without local wrappers', () => {
    expect({
      readAndNormalizeClipboardImage,
      readClipboardImage,
      ImageResizeError,
      MAX_DIMENSION,
      TARGET_RAW_SIZE_BYTES,
      normalizePastedImage,
      PASTE_TMP_DIR_ENV,
      PASTE_TMP_TTL_MS,
      persistImageAsBlock,
      prunePasteTmpDir,
    }).toEqual({
      readAndNormalizeClipboardImage: codingMedia.readAndNormalizeClipboardImage,
      readClipboardImage: codingMedia.readClipboardImage,
      ImageResizeError: codingMedia.ImageResizeError,
      MAX_DIMENSION: codingMedia.MAX_DIMENSION,
      TARGET_RAW_SIZE_BYTES: codingMedia.TARGET_RAW_SIZE_BYTES,
      normalizePastedImage: codingMedia.normalizePastedImage,
      PASTE_TMP_DIR_ENV: codingMedia.PASTE_TMP_DIR_ENV,
      PASTE_TMP_TTL_MS: codingMedia.PASTE_TMP_TTL_MS,
      persistImageAsBlock: codingMedia.persistImageAsBlock,
      prunePasteTmpDir: codingMedia.prunePasteTmpDir,
    });
  });
});
