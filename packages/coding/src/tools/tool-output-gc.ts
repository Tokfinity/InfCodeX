/**
 * FEATURE_121 v0.7.40 — TTL-based GC for tool-output spillover directory.
 *
 * `persistToolOutput` (`./truncate.ts`) writes large tool outputs (read /
 * grep / bash / child-task spillover) to `~/.kodax/tool-results/<file>.txt`.
 * Without GC, that directory grows unbounded over a long install lifetime —
 * each spillover is a few-KB to a few-hundred-KB file, and a heavy KodaX
 * user can accumulate thousands per week.
 *
 * Design:
 *   - 14-day TTL by default. Spillover files only matter during the
 *     session that wrote them (Worker reads them once when the user
 *     asks for detail). Past 14 days they are dead storage.
 *   - Lazy + throttled: triggered from `persistToolOutput` itself with
 *     a 1-hour in-process cooldown so heavy spillover bursts do not
 *     scan-storm the filesystem.
 *   - Best-effort: every IO failure is swallowed. GC must never break
 *     the calling write path.
 *   - Stateless across processes: the cooldown lives in a module-level
 *     variable. Process restart resets it. No `.last-gc` marker file
 *     (that would just be another file to manage).
 *
 * No new dependency, no env var, no config. Operators who need a manual
 * sweep can run `find ~/.kodax/tool-results -type f -mtime +14 -delete`.
 *
 * Tested at `./tool-output-gc.test.ts`.
 */

import fs from 'fs/promises';
import path from 'path';

/** 14 days — long enough to survive normal session pauses, short enough
 * that a stopped-and-resumed laptop-month doesn't pile up GB of dead
 * spillover. Override per-call only (not via env) — surface kept tight. */
export const DEFAULT_TOOL_OUTPUT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 1-hour in-process cooldown for `maybeRunToolOutputGc`. */
export const GC_COOLDOWN_MS = 60 * 60 * 1000;

export interface ToolOutputGcResult {
  /** Files inspected (including those not yet expired). */
  readonly scanned: number;
  /** Files deleted because they exceeded the TTL. */
  readonly removed: number;
  /** Files that failed to stat or unlink (IO error). */
  readonly failed: number;
  /** Total bytes reclaimed. */
  readonly bytesRemoved: number;
}

/**
 * Walk `dir` once and unlink any regular file whose mtime is older than
 * `now - ttlMs`. Subdirectories are ignored (defensive: a future feature
 * may want to namespace by session — leaving directories untouched lets
 * that work coexist with TTL cleanup of legacy flat files).
 *
 * Returns a count summary. Never throws — directory-missing / per-file
 * IO errors are swallowed and reported via `failed`.
 */
export async function cleanupExpiredToolOutputs(
  dir: string,
  ttlMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { scanned: 0, removed: 0, failed: 0, bytesRemoved: 0 };
  }

  let scanned = 0;
  let removed = 0;
  let failed = 0;
  let bytesRemoved = 0;

  for (const name of entries) {
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      failed += 1;
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    scanned += 1;
    const ageMs = now - stat.mtimeMs;
    if (ageMs <= ttlMs) {
      continue;
    }
    try {
      await fs.unlink(filePath);
      removed += 1;
      bytesRemoved += stat.size;
    } catch {
      failed += 1;
    }
  }

  return { scanned, removed, failed, bytesRemoved };
}

// In-process throttle state — reset on process restart. Not exported;
// `__resetGcCooldownForTests` below punches through for the test file.
let lastGcAtMs = 0;
let inFlight: Promise<ToolOutputGcResult | null> | null = null;

/**
 * Fire-and-forget GC trigger called from `persistToolOutput` after each
 * spillover write. Returns:
 *   - the GC result promise if this call actually launched a sweep, OR
 *   - `null` if the cooldown is still in effect (no sweep launched).
 *
 * Callers should NOT await this — the whole point is to not block the
 * write path. The return value is exposed only so tests can deterministi-
 * cally observe sweep completion.
 */
export function maybeRunToolOutputGc(
  dir: string,
  ttlMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult | null> {
  if (inFlight) {
    return inFlight;
  }
  if (now - lastGcAtMs < GC_COOLDOWN_MS) {
    return Promise.resolve(null);
  }
  lastGcAtMs = now;
  inFlight = cleanupExpiredToolOutputs(dir, ttlMs, now)
    .then((result) => {
      inFlight = null;
      return result;
    })
    .catch(() => {
      inFlight = null;
      return null;
    });
  return inFlight;
}

/** Test hook — resets the cooldown so each test starts from a clean slate. */
export function __resetGcCooldownForTests(): void {
  lastGcAtMs = 0;
  inFlight = null;
}
