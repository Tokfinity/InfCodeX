/**
 * FEATURE_134 (v0.7.40) — orchestrator for the 5 paste sources.
 *
 * Sources (per docs/features/v0.7.40.md):
 *   1. Bracketed paste — base path (`parse-keypress.ts` already
 *      unwraps `ESC[200~...ESC[201~` to a `name='paste'` event).
 *   2. File path paste — paste content matches `isImageFilePath`,
 *      read the path(s) from disk.
 *   3. macOS empty paste → read NSPasteboard via `readClipboardImage`.
 *   4. Windows Alt+V → explicit `triggerExplicitClipboardImage` call.
 *   5. macOS/Linux Ctrl+V → same as 4 but different keybind.
 *
 * This module is the I/O orchestrator. The REPL wires its results into
 * the input pipeline + UI. The orchestrator itself is pure async
 * dispatch + delegation to the supporting modules.
 */

import { readFile } from 'node:fs/promises';
import type { KodaXImageBlock } from '@kodax-ai/llm';
import { readClipboardImage } from './clipboard-image.js';
import {
  ImageResizeError,
  normalizePastedImage,
} from './image-normalize.js';
import { persistImageAsBlock } from './persist-image.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Outcome of handling a single paste event.
 *
 *   `kind: 'text'`   — caller should insert `text` into the input box
 *                       (existing text-paste handler path).
 *   `kind: 'images'` — caller should append the image blocks to the
 *                       pending images list AND insert `pills` (e.g.
 *                       `[Image #1] [Image #2]`) into the input box.
 *   `kind: 'noop'`   — caller should do nothing (e.g., Alt+V hit with
 *                       empty clipboard).
 *   `kind: 'error'`  — caller should surface `message` as a UI error.
 */
export type PasteHandlerOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'images'; blocks: readonly KodaXImageBlock[] }
  | { kind: 'noop' }
  | { kind: 'error'; message: string };

/**
 * Source 1 + Source 2 + Source 3 entry point. Called when
 * `parse-keypress.ts` emits an `isPaste` event with unwrapped content.
 */
export async function handleBracketedPaste(
  pasteContent: string,
): Promise<PasteHandlerOutcome> {
  if (pasteContent.length === 0) {
    // Source 3 — empty bracketed paste. On macOS this typically means
    // the user pressed Cmd+V with a binary image on the clipboard
    // (the terminal can't carry binary in the paste stream, so the
    // brackets enclose nothing).
    if (process.platform === 'darwin') {
      return readClipboardAsImagesOutcome();
    }
    // Non-mac: treat as no-op text paste. Cmd+V auto-clipboard linkage
    // is macOS-specific. Linux/Windows users should use Source 4/5
    // explicit keybindings.
    return { kind: 'text', text: '' };
  }

  // Source 2 — paste content may be one or more image file paths
  // (typical of GUI drag-to-terminal).
  const paths = extractImagePaths(pasteContent);
  if (paths.length > 0) {
    return readImagePathsAsOutcome(paths, pasteContent);
  }

  // Fall through — paste is plain text (URL, code snippet, whatever).
  return { kind: 'text', text: pasteContent };
}

/**
 * Source 4 + Source 5 entry point. Called from the REPL keybinding
 * handler for Alt+V (Windows) / Ctrl+V (macOS / Linux backup).
 */
export async function triggerExplicitClipboardImage(): Promise<PasteHandlerOutcome> {
  return readClipboardAsImagesOutcome();
}

async function readClipboardAsImagesOutcome(): Promise<PasteHandlerOutcome> {
  let buf: Buffer | null;
  try {
    buf = await readClipboardImage();
  } catch (err) {
    return {
      kind: 'error',
      message: `Failed to read clipboard image: ${describeError(err)}`,
    };
  }
  if (!buf) {
    // No image on clipboard. v1 surfaces this as silent no-op rather
    // than an error banner: the user may have pressed Alt+V before
    // copying, and a banner would be more annoying than helpful.
    return { kind: 'noop' };
  }
  return decodeBufferToOutcome(buf);
}

async function readImagePathsAsOutcome(
  paths: readonly string[],
  rawPasteContent: string,
): Promise<PasteHandlerOutcome> {
  const blocks: KodaXImageBlock[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    let buf: Buffer;
    try {
      buf = await readFile(p);
    } catch (err) {
      errors.push(`Failed to read ${p}: ${describeError(err)}`);
      continue;
    }
    const decoded = await decodeBufferToOutcome(buf);
    if (decoded.kind === 'images') {
      blocks.push(...decoded.blocks);
    } else if (decoded.kind === 'error') {
      errors.push(decoded.message);
    }
  }
  if (blocks.length === 0) {
    if (errors.length > 0) {
      // All paths failed → surface as error.
      return { kind: 'error', message: errors.join('; ') };
    }
    // No paths produced blocks (shouldn't happen given extractImagePaths
    // gating) → fall back to text paste of the original content.
    return { kind: 'text', text: rawPasteContent };
  }
  return { kind: 'images', blocks };
}

async function decodeBufferToOutcome(buf: Buffer): Promise<PasteHandlerOutcome> {
  try {
    const normalized = await normalizePastedImage(buf);
    const block = await persistImageAsBlock(normalized);
    return { kind: 'images', blocks: [block] };
  } catch (err) {
    if (err instanceof ImageResizeError) {
      return { kind: 'error', message: err.message };
    }
    return {
      kind: 'error',
      message: `Failed to process pasted image: ${describeError(err)}`,
    };
  }
}

/**
 * Split paste content into candidate image paths. Mirrors claudecode's
 * `usePasteHandler.ts:127` regex but extended to also handle Windows
 * `C:\Users\...` paths in addition to POSIX `/abs/...`.
 *
 * Returns the subset of split segments that look like image files by
 * extension. Returns empty array if no segment matches — caller should
 * treat the original content as plain text.
 */
export function extractImagePaths(pasteContent: string): readonly string[] {
  // Split on spaces that immediately precede a new absolute path. This
  // is the same heuristic claudecode uses. It correctly handles a
  // single path with spaces in its name (as long as the inner spaces
  // are not immediately followed by another absolute-path prefix).
  const segments = pasteContent.split(/ (?=\/|[A-Za-z]:\\)/);
  return segments.filter((seg) => IMAGE_EXT_RE.test(seg.trim()));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
