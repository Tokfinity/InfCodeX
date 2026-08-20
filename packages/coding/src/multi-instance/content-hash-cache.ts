/**
 * FEATURE_125 (v0.7.41) — Team Mode Layer 4: content-hash safety net.
 *
 * The one place where Team Mode is a HARD block, not a soft signal.
 * Mechanic:
 *
 *   1. LLM reads file foo.ts → `recordRead(filePath, content)` stores a
 *      sha256(content) hash in this cache.
 *   2. LLM later edits foo.ts → before the edit applies, the tool calls
 *      `checkStale(filePath)`. The cache re-reads the file off disk,
 *      hashes it, and compares to the recorded hash.
 *         - Hash matches → fresh; edit proceeds normally.
 *         - Hash differs → stale; tool returns a `{ok:false, reason:...}`
 *           envelope telling the LLM to re-read. NO disk mutation.
 *   3. After the LLM's own successful edit, `recordWrite(filePath,
 *      newContent)` updates the cache so the very next edit-after-edit
 *      sequence does not false-alarm on the LLM's own changes.
 *
 * Edge cases the design pins:
 *   - LLM writes a new file without reading first → cache miss → no
 *     check (intentional; this is "create", not "overwrite").
 *   - LLM read → self-edit → self-edit again → second edit sees the
 *     hash recorded by `recordWrite` from the first edit. Fresh.
 *   - Peer (other KodaX session) edits foo.ts after our read → next
 *     check sees the new disk hash; ours is stale → block.
 *   - User manually edits foo.ts in another editor → same as peer-edit:
 *     stale → block. This is the desired behavior; the LLM must not
 *     overwrite user manual changes.
 *   - File deleted on disk between read and edit → `currentHash` is null
 *     → block (something happened; the LLM must reckon with it).
 *   - File renamed → cache miss on the new path → no check on new path,
 *     but a stale alarm on the old path if re-edited. Acceptable: the
 *     LLM should not be operating on the old path anyway.
 *
 * Cache is **per-managed-task** lifetime — created at task entry,
 * discarded on task exit. Not shared across sessions, not persisted.
 * Sibling-session changes are detected via the disk-state comparison,
 * not via a shared cache.
 *
 * DI-clean: every fs / clock / hash dependency is injectable so tests
 * can simulate race conditions deterministically. The default `sha256`
 * uses Node's built-in `crypto.createHash`.
 */

import * as nodeFs from 'node:fs';
import * as crypto from 'node:crypto';

/** Minimal fs surface used by the cache. Tests inject an in-memory fake. */
export interface ContentHashCacheFs {
  readFileSync(filePath: string, encoding: 'utf8'): string;
  existsSync(filePath: string): boolean;
}

const REAL_FS: ContentHashCacheFs = {
  readFileSync(p, enc) {
    return nodeFs.readFileSync(p, enc);
  },
  existsSync(p) {
    return nodeFs.existsSync(p);
  },
};

const REAL_HASH = (content: string): string =>
  crypto.createHash('sha256').update(content).digest('hex');

export interface ContentHashCacheOptions {
  readonly fs?: ContentHashCacheFs;
  readonly clock?: () => number;
  /** Override the hash function; defaults to sha256. */
  readonly hash?: (content: string) => string;
}

/** Result of a stale-check against the current on-disk content. */
export type StaleCheckResult =
  | { readonly kind: 'no-read'; readonly stale: false }
  | { readonly kind: 'fresh'; readonly stale: false; readonly readAt: number }
  | { readonly kind: 'missing'; readonly stale: true; readonly readAt: number }
  | {
      readonly kind: 'stale';
      readonly stale: true;
      readonly readAt: number;
      readonly recordedHash: string;
      readonly currentHash: string;
    };

export interface ContentHashCache {
  /** Record a hash for `filePath` keyed by the content the LLM observed. */
  recordRead(filePath: string, content: string): void;
  /**
   * Compare the recorded hash to the file's current on-disk hash.
   * Returns `{kind:'no-read'}` when the LLM has not yet recorded this
   * file — callers should treat that as "no check applies" (creating
   * a new file, deferring to the soft-warning layer, etc.).
   */
  checkStale(filePath: string): StaleCheckResult;
  /** Compare against content already read through a narrower filesystem capability. */
  checkStaleContent(filePath: string, currentContent: string | undefined): StaleCheckResult;
  /** Record the post-edit hash so subsequent self-edits do not false-alarm. */
  recordWrite(filePath: string, newContent: string): void;
  /** Drop the recorded hash. Use on delete or when the LLM explicitly forgets. */
  forget(filePath: string): void;
  /** Test/diagnostic accessor — read the recorded readAt (or undefined). */
  getReadAt(filePath: string): number | undefined;
  /** Test/diagnostic accessor — read the recorded hash (or undefined). */
  getRecordedHash(filePath: string): string | undefined;
}

interface CacheEntry {
  readonly hash: string;
  readonly readAt: number;
}

/**
 * Build a fresh per-task content-hash cache. Cheap — call once at
 * managed-task entry; pass the same instance to every tool execution
 * context until the task exits.
 */
export function createContentHashCache(
  options: ContentHashCacheOptions = {},
): ContentHashCache {
  const fs = options.fs ?? REAL_FS;
  const clock = options.clock ?? Date.now;
  const hash = options.hash ?? REAL_HASH;
  const entries = new Map<string, CacheEntry>();
  const checkStaleContent = (
    filePath: string,
    currentContent: string | undefined,
  ): StaleCheckResult => {
    const recorded = entries.get(filePath);
    if (!recorded) return { kind: 'no-read', stale: false };
    if (currentContent === undefined) {
      return { kind: 'missing', stale: true, readAt: recorded.readAt };
    }
    const currentHash = hash(currentContent);
    if (currentHash === recorded.hash) {
      return { kind: 'fresh', stale: false, readAt: recorded.readAt };
    }
    return {
      kind: 'stale',
      stale: true,
      readAt: recorded.readAt,
      recordedHash: recorded.hash,
      currentHash,
    };
  };

  return {
    recordRead(filePath, content) {
      entries.set(filePath, { hash: hash(content), readAt: clock() });
    },
    recordWrite(filePath, newContent) {
      // Same shape as recordRead; the LLM has now seen the new content
      // via the edit's resulting state. clock() advances so the
      // pre-edit and post-edit timestamps are distinguishable.
      entries.set(filePath, { hash: hash(newContent), readAt: clock() });
    },
    forget(filePath) {
      entries.delete(filePath);
    },
    checkStale(filePath) {
      if (!entries.has(filePath)) return { kind: 'no-read', stale: false };

      // File deletion / rename mid-task → treat as stale. The LLM must
      // reckon with the disappearance rather than silently writing a
      // fresh file on the old path.
      if (!fs.existsSync(filePath)) {
        return checkStaleContent(filePath, undefined);
      }

      let currentContent: string;
      try {
        currentContent = fs.readFileSync(filePath, 'utf8');
      } catch {
        // Transient read failure → treat as stale rather than risk a
        // silent overwrite. The LLM retries the read next turn.
        return checkStaleContent(filePath, undefined);
      }
      return checkStaleContent(filePath, currentContent);
    },
    checkStaleContent(filePath, currentContent) {
      return checkStaleContent(filePath, currentContent);
    },
    getReadAt(filePath) {
      return entries.get(filePath)?.readAt;
    },
    getRecordedHash(filePath) {
      return entries.get(filePath)?.hash;
    },
  };
}

/**
 * Build the standard stale-write tool-result reason string. Surfaced
 * via `tool-result envelope reason field` so the LLM has a clear
 * recovery hint ("re-read first"). The text is pinned by the tool
 * unit tests in S5 so cross-tool wording stays consistent.
 */
export function buildStaleWriteReason(filePath: string, result: StaleCheckResult): string {
  if (result.kind === 'missing') {
    return (
      `${filePath} has changed since you last read it (the file is now missing or unreadable — `
      + `another session or the user may have moved or deleted it). Read the file again or pick a different path.`
    );
  }
  if (result.kind === 'stale') {
    return (
      `${filePath} has changed since you last read it (another session or the user modified it; `
      + `your cached version is no longer current). Re-read the file before editing so you can integrate their changes.`
    );
  }
  // 'fresh' and 'no-read' never reach this path in production, but
  // return a safe default for completeness.
  return `${filePath}: no stale-write check applies.`;
}
