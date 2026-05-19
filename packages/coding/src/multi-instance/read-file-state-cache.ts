/**
 * FEATURE_177 (v0.7.42) — per-task read-file-state cache (anti-loop).
 *
 * Tracks each `(filePath, offset, limit)` tuple the LLM has already
 * observed in this task. On re-read, when the file's mtime has not
 * changed since that observation, the read tool returns a short stub
 * instead of the full content — breaking the "narrate-then-re-read"
 * loop that surfaces on models with structural decoder floors
 * (kimi-code in May 2026: narrate-without-tool floor causes the model
 * to keep emitting identical `read` calls without making progress).
 *
 * Design mirrors claudecode's `FileReadTool.readFileState` and the
 * community `read-once` Claude Code hook. KodaX-specific adaptations:
 *
 *   - Lifetime: per-managed-task. Created in `runner-driven.ts`
 *     alongside `contentHashCache`; discarded when the task exits.
 *     Not shared across sessions, not persisted.
 *   - Cache key: `(filePath, offset, limit)`. Different offset/limit
 *     pairs against the same file are distinct entries so a model that
 *     legitimately pages through a large file is not penalized.
 *   - Invalidation: (a) mtime change → automatic miss on lookup;
 *     (b) Edit/Write/MultiEdit success → explicit `forget(filePath)`
 *     drops all entries for that file (mtime might tick but the safe
 *     belt-and-suspenders move is to drop the row); (c) context
 *     compaction → `clear()` from the compaction post-hook because the
 *     earlier `tool_result` the stub points the model back to may have
 *     been summarized away.
 *   - Killswitch: `KODAX_READ_DEDUP_KILLSWITCH=1` makes every operation
 *     a no-op (lookup always returns miss). Mirrors claudecode's
 *     `tengu_read_dedup_killswitch` so the feature can be rolled back
 *     without code changes.
 *
 * DI-clean: fs + clock are injectable so tests can simulate mtime
 * drift deterministically.
 */

import * as nodeFs from 'node:fs';

/** Minimal fs surface used by the cache. Tests inject an in-memory fake. */
export interface ReadFileStateCacheFs {
  statSync(filePath: string): { mtimeMs: number };
}

const REAL_FS: ReadFileStateCacheFs = {
  statSync(p) {
    const s = nodeFs.statSync(p);
    return { mtimeMs: s.mtimeMs };
  },
};

export interface ReadFileStateCacheOptions {
  readonly fs?: ReadFileStateCacheFs;
  readonly clock?: () => number;
  /**
   * When true, force-disable the cache (every lookup returns miss,
   * every record is a no-op). Defaults to reading
   * `KODAX_READ_DEDUP_KILLSWITCH === '1'`.
   */
  readonly disabled?: boolean;
}

/** Result of a cache lookup. */
export type ReadStateLookup =
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'hit';
      /** Wall-clock time (ms since epoch) of the prior matching read. */
      readonly previousReadAtMs: number;
    };

export interface ReadFileStateCache {
  /**
   * Have we read this exact `(filePath, offset, limit)` in this task,
   * with no mtime change since? `'hit'` means yes — caller should
   * return a stub instead of re-reading the file off disk.
   *
   * On stat failure (file deleted / permission denied between record
   * and lookup), returns `'miss'` so the read tool runs its own stat
   * and reports the right error to the LLM rather than serving a stale
   * stub.
   */
  lookup(filePath: string, offset: number, limit: number): ReadStateLookup;

  /**
   * Record a successful read at this `(filePath, offset, limit)` with
   * the mtime observed at read time. The mtime is supplied by the
   * caller (the read tool already stats the file) so the cache does
   * not pay a second stat call.
   */
  record(
    filePath: string,
    offset: number,
    limit: number,
    mtimeMs: number,
  ): void;

  /** Drop all entries for this file. Called by Edit / Write / MultiEdit on success. */
  forget(filePath: string): void;

  /** Drop everything. Called by the compaction post-hook. */
  clear(): void;

  /** Test/diagnostic accessor — number of distinct files currently cached. */
  size(): number;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly readAtMs: number;
}

function rangeKey(offset: number, limit: number): string {
  return `${offset}|${limit}`;
}

/**
 * Build a fresh per-task read-file-state cache. Cheap — call once at
 * managed-task entry; pass the same instance to every tool execution
 * context until the task exits.
 */
export function createReadFileStateCache(
  options: ReadFileStateCacheOptions = {},
): ReadFileStateCache {
  const disabled =
    options.disabled ?? process.env.KODAX_READ_DEDUP_KILLSWITCH === '1';

  if (disabled) {
    return {
      lookup: () => ({ kind: 'miss' }),
      record: () => {},
      forget: () => {},
      clear: () => {},
      size: () => 0,
    };
  }

  const fs = options.fs ?? REAL_FS;
  const clock = options.clock ?? Date.now;
  const entries = new Map<string, Map<string, CacheEntry>>();

  return {
    lookup(filePath, offset, limit) {
      const fileEntries = entries.get(filePath);
      if (!fileEntries) return { kind: 'miss' };

      const entry = fileEntries.get(rangeKey(offset, limit));
      if (!entry) return { kind: 'miss' };

      let currentMtime: number;
      try {
        currentMtime = fs.statSync(filePath).mtimeMs;
      } catch {
        // File deleted / permission / transient FS error since record.
        // Treat as miss so the read tool's own stat surfaces the real
        // error to the LLM.
        return { kind: 'miss' };
      }

      if (currentMtime !== entry.mtimeMs) {
        // External modification (peer session, user manual edit, build
        // tool). Drop the stale row so subsequent reads land in record.
        fileEntries.delete(rangeKey(offset, limit));
        return { kind: 'miss' };
      }

      return { kind: 'hit', previousReadAtMs: entry.readAtMs };
    },

    record(filePath, offset, limit, mtimeMs) {
      let fileEntries = entries.get(filePath);
      if (!fileEntries) {
        fileEntries = new Map();
        entries.set(filePath, fileEntries);
      }
      fileEntries.set(rangeKey(offset, limit), {
        mtimeMs,
        readAtMs: clock(),
      });
    },

    forget(filePath) {
      entries.delete(filePath);
    },

    clear() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
}

/**
 * Build the standard stub text the read tool returns on a cache hit.
 * The wording is pinned by unit tests so cross-tool messaging stays
 * consistent and the model gets the same recovery hint every time.
 */
export function buildReadFileUnchangedStub(
  filePath: string,
  offset: number,
  limit: number,
): string {
  return (
    `[Read Cache] ${filePath} is unchanged since you read it earlier in this task `
    + `(offset=${offset}, limit=${limit}). The content from the earlier read tool_result `
    + `in this conversation is still current — refer to that instead of re-reading. `
    + `If you need different lines, call read with a different offset/limit. `
    + `If the file is modified externally, this cache invalidates automatically on mtime change.`
  );
}
