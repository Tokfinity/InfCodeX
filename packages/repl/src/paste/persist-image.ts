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
 * Temp directory: `tmpdir() + '/kodax-paste'`. Override via
 * `KODAX_PASTE_TMP_DIR` env var (used by tests).
 *
 * Content-hash filename: filenames are derived from a sha256 prefix of
 * the buffer so identical content (e.g., user pressing Alt+V multiple
 * times on the same screenshot, or OS-level key autorepeat firing the
 * Alt+V handler twice within a frame) produces a stable path instead of
 * a fresh UUID each time. This caps temp-dir bloat per unique image at
 * one file per session.
 *
 * Cross-session GC: `prunePasteTmpDir` is called once at REPL bootstrap
 * (`InkREPL.tsx` startup) to delete `paste-*` files older than
 * `PASTE_TMP_TTL_MS` (default 24 hours). Active session files written
 * within the TTL window are preserved — if a user opens KodaX, pastes an
 * image, then leaves it idle for 23 hours, the image is still readable
 * by the LLM. Files written by other concurrent KodaX instances during
 * the prune window are likewise preserved (mtime is within TTL).
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { KodaXImageBlock } from '@kodax-ai/llm';
import type { NormalizedImage } from './image-normalize.js';

export const PASTE_TMP_DIR_ENV = 'KODAX_PASTE_TMP_DIR';

// 24 hours — long enough that a developer leaving KodaX idle overnight
// finds their pasted images still attached on resume; short enough that
// a long-lived dev machine doesn't accumulate paste files across
// multiple weeks of sessions.
export const PASTE_TMP_TTL_MS = 24 * 60 * 60 * 1000;

function resolvePasteTmpDir(): string {
  return process.env[PASTE_TMP_DIR_ENV] ?? path.join(tmpdir(), 'kodax-paste');
}

export async function persistImageAsBlock(
  image: NormalizedImage,
): Promise<KodaXImageBlock> {
  const dir = resolvePasteTmpDir();
  await mkdir(dir, { recursive: true });
  const ext = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
  const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 16);
  const filename = `paste-${hash}${ext}`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, image.buffer);
  return {
    type: 'image',
    path: fullPath,
    mediaType: image.mediaType,
  };
}

/**
 * Best-effort age-based prune of the paste temp directory. Called once
 * at REPL bootstrap. Returns the number of files deleted (zero if the
 * directory does not yet exist — which is the common first-launch
 * case). Silently swallows per-file errors (concurrent KodaX instance
 * removed the same file between readdir and unlink, etc.) so a transient
 * filesystem race never breaks REPL startup.
 *
 * Only files matching the `paste-*` filename pattern are considered, so
 * an unrelated file the user dropped into the same directory survives.
 */
export async function prunePasteTmpDir(now: number = Date.now()): Promise<number> {
  const dir = resolvePasteTmpDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now - PASTE_TMP_TTL_MS;
  let deleted = 0;
  await Promise.all(
    entries
      .filter((name) => name.startsWith('paste-'))
      .map(async (name) => {
        const full = path.join(dir, name);
        try {
          const st = await stat(full);
          if (st.mtimeMs < cutoff) {
            await unlink(full);
            deleted += 1;
          }
        } catch {
          /* swallow per-file race / permission errors */
        }
      }),
  );
  return deleted;
}
