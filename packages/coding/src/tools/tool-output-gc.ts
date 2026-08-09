/**
 * FEATURE_121 v0.7.40 — explicit TTL cleanup helper for legacy tool-output
 * spillover files plus production reference-aware cleanup.
 *
 * `persistToolOutput` (`./truncate.ts`) writes large tool outputs (read /
 * grep / bash / child-task spillover) to `~/.kodax/tool-results/<file>.txt`.
 * Recovery artifacts can be referenced by resumable session history. Age alone
 * cannot prove that an artifact is dead, so `persistToolOutput` never runs an
 * age-only sweep. Production callers supply the complete live-reference set;
 * the legacy age-only helper remains an explicit host/operator action.
 *
 * Design:
 *   - 14-day TTL remains the legacy/manual default, not a liveness claim.
 *   - Reference-aware cleanup retains every path named by resumable sessions.
 *   - Optional throttling coalesces calls made by a host.
 *   - Per-file IO failures are returned in the result summary.
 *   - Stateless across processes: the cooldown lives in a module-level
 *     variable. Process restart resets it. No `.last-gc` marker file
 *     (that would just be another file to manage).
 *
 * Tested at `./tool-output-gc.test.ts`.
 */

import fs from 'fs/promises';
import path from 'path';
import { withFileMutation } from './_internal/file-mutation-queue.js';

/** Legacy/manual retention default. Callers must establish artifact liveness. */
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
  return withFileMutation(dir, () => cleanupExpiredToolOutputsInPlace(dir, ttlMs, now))
    .catch(() => ({ scanned: 0, removed: 0, failed: 1, bytesRemoved: 0 }));
}

async function cleanupExpiredToolOutputsInPlace(
  dir: string,
  ttlMs: number,
  now: number,
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

function normalizeArtifactPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Production-safe sweep: age is only a grace gate; a referenced artifact is
 * retained regardless of age. Callers must supply references from every live
 * and resumable session in their storage scope.
 */
export async function cleanupUnreferencedToolOutputs(
  dir: string,
  referencedPaths: ReadonlySet<string>,
  graceMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult> {
  return withFileMutation(
    dir,
    () => cleanupUnreferencedToolOutputsInPlace(dir, referencedPaths, graceMs, now),
  ).catch(() => ({ scanned: 0, removed: 0, failed: 1, bytesRemoved: 0 }));
}

async function cleanupUnreferencedToolOutputsInPlace(
  dir: string,
  referencedPaths: ReadonlySet<string>,
  graceMs: number,
  now: number,
): Promise<ToolOutputGcResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { scanned: 0, removed: 0, failed: 0, bytesRemoved: 0 };
  }

  const referenced = new Set([...referencedPaths].map(normalizeArtifactPath));
  let scanned = 0;
  let removed = 0;
  let failed = 0;
  let bytesRemoved = 0;
  for (const name of entries) {
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      scanned += 1;
      if (referenced.has(normalizeArtifactPath(filePath)) || now - stat.mtimeMs <= graceMs) continue;
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
 * Throttled wrapper for an explicit host/operator cleanup request. It is not
 * called by `persistToolOutput`. Returns:
 *   - the GC result promise if this call actually launched a sweep, OR
 *   - `null` if the cooldown is still in effect (no sweep launched).
 *
 * Callers may await the result when they need an auditable cleanup summary.
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

/**
 * Throttled production entry point. Reference discovery happens only after the
 * cooldown admits a sweep; discovery failure cancels deletion fail-closed.
 */
export function maybeRunReferenceAwareToolOutputGc(
  dir: string,
  loadReferencedPaths: () => Promise<ReadonlySet<string>>,
  graceMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult | null> {
  if (inFlight) return inFlight;
  if (now - lastGcAtMs < GC_COOLDOWN_MS) return Promise.resolve(null);
  lastGcAtMs = now;
  inFlight = loadReferencedPaths()
    .then((referenced) => cleanupUnreferencedToolOutputs(dir, referenced, graceMs, now))
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
