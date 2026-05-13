/**
 * FEATURE_134 (v0.7.40) — persist a normalized image buffer to disk and
 * construct a `KodaXImageBlock` for downstream message-pipeline use.
 *
 * The AI layer's `KodaXImageBlock` is path-based, not inline-base64:
 *
 * ```ts
 * interface KodaXImageBlock {
 *   type: 'image';
 *   path: string;
 *   mediaType?: string;
 * }
 * ```
 *
 * So we write the buffer to the KodaX paste temp directory, then return
 * the block referencing that path. Provider serializers
 * (`packages/ai/src/providers/anthropic.ts`, `openai.ts`, etc.) read
 * the file at request time and produce wire-level base64.
 *
 * Temp directory: `tmpdir() + '/kodax-paste'`. OS-level tmpdir cleanup
 * handles lifecycle on reboot. KodaX does not auto-GC paste files
 * (acceptable: each file is at most TARGET_RAW_SIZE_BYTES ≈ 3.75MB and
 * the OS clears tmpdir on boot).
 *
 * Override via `KODAX_PASTE_TMP_DIR` env var (used by tests).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KodaXImageBlock } from '@kodax-ai/llm';
import type { NormalizedImage } from './image-normalize.js';

export const PASTE_TMP_DIR_ENV = 'KODAX_PASTE_TMP_DIR';

function resolvePasteTmpDir(): string {
  return process.env[PASTE_TMP_DIR_ENV] ?? path.join(tmpdir(), 'kodax-paste');
}

export async function persistImageAsBlock(
  image: NormalizedImage,
): Promise<KodaXImageBlock> {
  const dir = resolvePasteTmpDir();
  await mkdir(dir, { recursive: true });
  const ext = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
  const filename = `paste-${randomUUID()}${ext}`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, image.buffer);
  return {
    type: 'image',
    path: fullPath,
    mediaType: image.mediaType,
  };
}
