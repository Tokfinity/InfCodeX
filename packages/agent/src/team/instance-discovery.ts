/**
 * FEATURE_125 (v0.7.41) — Team Mode Layer 2a: sibling instance discovery.
 *
 * Scans `<agentConfigHome>/instances/`, filters out the caller's own
 * pid, drops any directory whose `heartbeat` file is stale (>30s of no
 * touch), parses `state.json`, validates `version === '1'`, and returns
 * a typed list of live sibling instances. Stale directories are
 * optionally reaped (`reapStale: true`) — the next session entering
 * Team Mode does the cleanup so crashed processes don't accumulate
 * forever.
 *
 * Per-instance failures (corrupt JSON, vanished file mid-read, permission
 * error) are isolated: the bad directory is logged + skipped, the rest
 * of the scan completes. Discovery NEVER throws to its caller — a
 * Team-Mode-disabled return is `[]`, not an exception. This keeps the
 * worker LLM call path resilient to one peer session's bad state.
 *
 * DI-clean: every fs / clock / logger dependency is injectable so
 * hermetic tests can simulate stale / corrupt / mid-scan-deletion
 * scenarios without real disk.
 */

import { promises as _fsPromises } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';

import { getAgentConfigPath } from '../runtime/agent-home.js';
import type { PersistedSessionState } from './state-writer.js';

void _fsPromises; // reserved for a future async variant; keep the import surface aligned.

/** A sibling KodaX session that passed stale + version-guard checks. */
export interface DiscoveredInstance {
  readonly pid: number;
  readonly state: PersistedSessionState;
  /** Heartbeat mtime in ms (epoch). Useful for ordering "freshest first". */
  readonly heartbeatMtimeMs: number;
}

/** Minimal injectable fs surface used by `discoverInstances`. */
export interface InstanceDiscoveryFs {
  existsSync(targetPath: string): boolean;
  readdirSync(dirPath: string): string[];
  /** Returns the mtime of the path in ms, or `null` if missing / unreadable. */
  statMtimeMs(filePath: string): number | null;
  readFileSync(filePath: string, encoding: 'utf8'): string;
  rmSync(dirPath: string, options: { recursive: true; force: true }): void;
}

const REAL_FS: InstanceDiscoveryFs = {
  existsSync(p) {
    return nodeFs.existsSync(p);
  },
  readdirSync(p) {
    return nodeFs.readdirSync(p);
  },
  statMtimeMs(p) {
    try {
      return nodeFs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
  readFileSync(p, enc) {
    return nodeFs.readFileSync(p, enc);
  },
  rmSync(p, options) {
    nodeFs.rmSync(p, options);
  },
};

export interface DiscoveryOptions {
  /**
   * pid to exclude from the result. Defaults to `process.pid` — the
   * caller's own state.json should not appear in its own sibling list.
   */
  readonly excludePid?: number;
  /**
   * Heartbeat mtime older than `now - staleThresholdMs` → directory is
   * stale. Default 30_000 (matches v0.7.41 spec).
   */
  readonly staleThresholdMs?: number;
  /**
   * When true, stale directories are removed during the scan (best-
   * effort `rmSync(force:true)`; failure is swallowed). When false,
   * stale directories are skipped but left on disk. Defaults to false
   * — wire from the session-startup path with `true` so crashed-process
   * dirs don't accumulate.
   */
  readonly reapStale?: boolean;
  readonly clock?: () => number;
  readonly fs?: InstanceDiscoveryFs;
  readonly instancesRoot?: string;
  /** Per-instance failure log; defaults to a no-op. Pass `console.warn` in dev. */
  readonly logger?: (message: string) => void;
}

const DEFAULT_STALE_THRESHOLD_MS = 30_000;

/**
 * Synchronous discovery scan. Returns a freshness-sorted array
 * (newest heartbeat first) so callers that want only the N most-recent
 * siblings can slice without re-sorting.
 *
 * Never throws. A missing `<instancesRoot>` directory means the user
 * is the first session ever on this machine → `[]`. A scan failure on
 * one entry is logged + skipped, not propagated.
 */
export function discoverInstances(options: DiscoveryOptions = {}): DiscoveredInstance[] {
  const fs = options.fs ?? REAL_FS;
  const clock = options.clock ?? Date.now;
  const excludePid = options.excludePid ?? process.pid;
  const staleThreshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const reapStale = options.reapStale ?? false;
  const log = options.logger ?? (() => undefined);
  const instancesRoot = options.instancesRoot ?? getAgentConfigPath('instances');

  if (!fs.existsSync(instancesRoot)) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(instancesRoot);
  } catch (error) {
    log(`team:discovery: readdir(${instancesRoot}) failed: ${stringifyError(error)}`);
    return [];
  }

  const now = clock();
  const live: DiscoveredInstance[] = [];

  for (const entry of entries) {
    // Filter non-pid directories defensively — a stray file in the
    // instances dir (manual paste, OS .DS_Store, etc.) must not crash.
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === excludePid) continue;

    const pidDir = path.join(instancesRoot, entry);
    const heartbeatPath = path.join(pidDir, 'heartbeat');
    const heartbeatMtime = fs.statMtimeMs(heartbeatPath);

    // No heartbeat file → not a valid kodax instance dir. Treat as
    // stale (zero-mtime equivalent) so the reap path can clean it up.
    if (heartbeatMtime === null) {
      maybeReap(fs, pidDir, reapStale, log);
      continue;
    }

    // Stale heartbeat → instance is dead / crashed.
    if (now - heartbeatMtime > staleThreshold) {
      maybeReap(fs, pidDir, reapStale, log);
      continue;
    }

    // Alive heartbeat → try to read + validate state.json.
    const statePath = path.join(pidDir, 'state.json');
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      // Heartbeat says alive but state file vanished — likely mid-write
      // race with the peer's own atomicWrite. Skip this scan; the next
      // tick picks them up. Do NOT reap — they're still writing.
      log(`team:discovery: read(${statePath}) failed (peer mid-write?): ${stringifyError(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Partial JSON during a non-atomic write window is possible on
      // OSes where rename isn't atomic across all conditions. Skip,
      // do not reap — next tick re-reads.
      log(`team:discovery: parse(${statePath}) failed (partial write?): ${stringifyError(error)}`);
      continue;
    }

    if (!isPersistedV1(parsed)) {
      // Unknown / future schema version. Per S1 reader contract: log + skip,
      // never crash. Do NOT reap a future writer — they may legitimately
      // be running a newer version that we just don't understand.
      const v = (parsed as { version?: unknown } | null)?.version;
      log(`team:discovery: ${statePath} has unknown version=${JSON.stringify(v)}; skipping`);
      continue;
    }

    // Pid coherence check: the directory name SHOULD equal the state.pid.
    // If they disagree (manual file move? stale dir reused?), prefer the
    // directory name as the addressable identity but log the divergence.
    if (parsed.pid !== pid) {
      log(`team:discovery: ${statePath} pid mismatch (dir=${pid}, file=${parsed.pid}); using dir`);
    }

    live.push({
      pid,
      state: parsed,
      heartbeatMtimeMs: heartbeatMtime,
    });
  }

  // Sort freshest-first. Callers that want fewer (e.g. top-3 active
  // peers) can slice without re-sorting.
  live.sort((left, right) => right.heartbeatMtimeMs - left.heartbeatMtimeMs);
  return live;
}

function maybeReap(
  fs: InstanceDiscoveryFs,
  pidDir: string,
  reap: boolean,
  log: (message: string) => void,
): void {
  if (!reap) return;
  try {
    fs.rmSync(pidDir, { recursive: true, force: true });
  } catch (error) {
    // Best-effort cleanup; the peer might have raced us. Next scan retries.
    log(`team:discovery: reap(${pidDir}) failed: ${stringifyError(error)}`);
  }
}

function isPersistedV1(value: unknown): value is PersistedSessionState {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== '1') return false;
  if (typeof obj.pid !== 'number') return false;
  if (typeof obj.updatedAt !== 'number') return false;
  if (typeof obj.agentPhase !== 'string') return false;
  if (
    obj.agentPhase !== 'idle'
    && obj.agentPhase !== 'awaiting_llm'
    && obj.agentPhase !== 'running_tool'
  ) {
    return false;
  }
  if (obj.meta === null || typeof obj.meta !== 'object') return false;
  const meta = obj.meta as Record<string, unknown>;
  if (typeof meta.cwd !== 'string') return false;
  if (typeof meta.startedAt !== 'number') return false;
  return true;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
