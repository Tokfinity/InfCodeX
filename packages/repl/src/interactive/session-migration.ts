/**
 * FEATURE_219 (v0.7.46) — Upgrade-transparent auto-migration from the flat
 * session pool to the per-project directory layout. See ADR-038 §6/§8.
 *
 * Safety posture (locked + journaled + resumable + non-destructive):
 *   - runs once per process at the first storage entry point
 *     (`ensureLayoutMigrated`, gated by a one-time Promise in storage.ts)
 *   - dual-layout read (the id-only locator) ships FIRST, so an interrupted
 *     migration never makes a session unreadable
 *   - `.layout.json` marker (written last, temp+rename) makes it idempotent
 *   - `.migration-lock/` directory lock (atomic mkdir) + `owner.json` with
 *     pid/heartbeat stale-reclaim guards against a crashed holder
 *   - `.migration-journal.jsonl` records every move → resume forward on the
 *     next start; never auto-rollback, never auto-delete session data
 *   - orphan island sidecars (no surviving main file) are RELOCATED to
 *     `_unknown/orphan-islands/`, never deleted
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

import { deriveProjectKeyFromData, UNKNOWN_PROJECT_KEY } from './project-key.js';

export const LAYOUT_VERSION = 2;

/** A lock whose heartbeat is older than this is considered abandoned. */
const STALE_LOCK_MS = 5 * 60 * 1000;
const HEAD_READ_BYTES = 65536;

const layoutMarkerPath = (dir: string): string => path.join(dir, '.layout.json');
const lockDirPath = (dir: string): string => path.join(dir, '.migration-lock');
const ownerPath = (dir: string): string => path.join(lockDirPath(dir), 'owner.json');
const journalPath = (dir: string): string => path.join(dir, '.migration-journal.jsonl');
const sessionsArchiveDir = (dir: string): string => path.join(path.dirname(dir), 'sessions-archive');

interface MovePlan {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.');
}

/** The session id of an island sidecar, or null if `name` is not a sidecar. */
function sidecarId(name: string): string | null {
  if (name.endsWith('.archive.jsonl')) {
    return name.slice(0, -'.archive.jsonl'.length);
  }
  if (name.endsWith('.islands.jsonl')) {
    return name.slice(0, -'.islands.jsonl'.length);
  }
  return null;
}

/** Read just the meta head line of a flat session file. */
async function readMeta(filePath: string): Promise<{ gitRoot?: string; runtimeInfo?: unknown } | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_READ_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }
    const head = buf.toString('utf8', 0, bytesRead);
    const nl = head.indexOf('\n');
    const firstLine = (nl >= 0 ? head.slice(0, nl) : head).trim();
    if (!firstLine) {
      return null;
    }
    const parsed: unknown = JSON.parse(firstLine);
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)._type === 'meta') {
      const rec = parsed as Record<string, unknown>;
      return {
        gitRoot: typeof rec.gitRoot === 'string' ? rec.gitRoot : undefined,
        runtimeInfo: rec.runtimeInfo,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Destination project key for a flat session file. Uses the SAME resolver as
 * live writes (`deriveProjectKeyFromData`) so a migrated session and a future
 * re-save converge on one directory. A meta-less / unreadable file → `_unknown`.
 */
async function destKeyFor(filePath: string): Promise<string> {
  const meta = await readMeta(filePath);
  if (!meta) {
    return UNKNOWN_PROJECT_KEY;
  }
  return deriveProjectKeyFromData({
    gitRoot: meta.gitRoot,
    // runtimeInfo shape is validated downstream by resolveSessionRuntimeInfo;
    // pass through as-is (deriveProjectKeyFromData tolerates partial shapes).
    runtimeInfo: meta.runtimeInfo as never,
  }).key;
}

/** Collect the flat `*.jsonl` (+ sidecars) and `sessions-archive/` contents. */
async function collectFlatSources(sessionsDir: string): Promise<string[]> {
  const sources: string[] = [];
  const pushDir = async (dir: string, allowSidecars: boolean): Promise<void> => {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) {
        continue;
      }
      if (isSessionFile(e.name) || (allowSidecars && sidecarId(e.name) !== null)) {
        sources.push(path.join(dir, e.name));
      }
    }
  };
  await pushDir(sessionsDir, true);
  await pushDir(sessionsArchiveDir(sessionsDir), true);
  return sources;
}

/**
 * Build the move plan WITHOUT touching disk (pure planner — testable / dry-run).
 * Sidecars travel with their main file and are renamed `.archive.jsonl` →
 * `.islands.jsonl`. An orphan sidecar (no surviving main) is relocated to
 * `_unknown/orphan-islands/` rather than deleted.
 */
export async function planMigration(sessionsDir: string): Promise<MovePlan[]> {
  const sources = await collectFlatSources(sessionsDir);
  const mains = sources.filter((s) => isSessionFile(path.basename(s)));
  const mainIds = new Set(mains.map((m) => path.basename(m, '.jsonl')));
  const plans: MovePlan[] = [];

  for (const main of mains) {
    const id = path.basename(main, '.jsonl');
    const key = await destKeyFor(main);
    plans.push({ from: main, to: path.join(sessionsDir, key, `${id}.jsonl`), reason: `session→${key}` });
    // Paired island sidecar (same dir as the main source) — either the old
    // `.archive.jsonl` or an already-renamed `.islands.jsonl`.
    for (const suffix of ['.archive.jsonl', '.islands.jsonl']) {
      const sidecar = path.join(path.dirname(main), `${id}${suffix}`);
      if (fsSync.existsSync(sidecar)) {
        plans.push({ from: sidecar, to: path.join(sessionsDir, key, `${id}.islands.jsonl`), reason: 'sidecar→islands' });
      }
    }
  }

  // Orphan sidecars (either suffix) whose main is gone → preserve, not delete.
  for (const src of sources) {
    const id = sidecarId(path.basename(src));
    if (id === null || mainIds.has(id)) {
      continue; // a session file, or handled as a paired sidecar above
    }
    plans.push({
      from: src,
      to: path.join(sessionsDir, UNKNOWN_PROJECT_KEY, 'orphan-islands', `${id}.islands.jsonl`),
      reason: 'orphan-sidecar→_unknown',
    });
  }
  return plans;
}

export async function isMigrated(sessionsDir: string): Promise<boolean> {
  try {
    await fs.access(layoutMarkerPath(sessionsDir));
    return true;
  } catch {
    return false;
  }
}

export async function needsMigration(sessionsDir: string): Promise<boolean> {
  if (await isMigrated(sessionsDir)) {
    return false;
  }
  const sources = await collectFlatSources(sessionsDir);
  return sources.length > 0;
}

async function lockIsStale(dir: string): Promise<boolean> {
  try {
    const data = JSON.parse(await fs.readFile(ownerPath(dir), 'utf8')) as {
      pid?: number;
      heartbeatAt?: number;
    };
    if (typeof data.pid === 'number' && data.pid !== process.pid) {
      try {
        process.kill(data.pid, 0); // throws ESRCH if the holder is gone
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return true;
        }
      }
    }
    if (typeof data.heartbeatAt === 'number' && Date.now() - data.heartbeatAt > STALE_LOCK_MS) {
      return true;
    }
    return false;
  } catch {
    return true; // unreadable owner → treat as abandoned
  }
}

async function acquireLock(dir: string): Promise<boolean> {
  const lock = lockDirPath(dir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lock); // atomic; throws EEXIST if held
      await fs.writeFile(
        ownerPath(dir),
        JSON.stringify({ pid: process.pid, startTime: Date.now(), heartbeatAt: Date.now() }),
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      if (attempt === 0 && (await lockIsStale(dir))) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue; // reclaim + retry once
      }
      return false; // another live migrator holds it
    }
  }
  return false;
}

async function releaseLock(dir: string): Promise<void> {
  await fs.rm(lockDirPath(dir), { recursive: true, force: true }).catch(() => undefined);
}

async function readJournalDone(dir: string): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    const content = await fs.readFile(journalPath(dir), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const rec = JSON.parse(line) as { from?: string; done?: boolean };
        if (rec.done && typeof rec.from === 'string') {
          done.add(rec.from);
        }
      } catch {
        // skip malformed journal line
      }
    }
  } catch {
    // no journal yet
  }
  return done;
}

/** Move one file; race-safe (a pre-existing dest is a newer write — keep it). */
async function executeMove(plan: MovePlan): Promise<void> {
  await fs.mkdir(path.dirname(plan.to), { recursive: true });
  if (fsSync.existsSync(plan.to)) {
    // Destination already written (concurrent live write or a prior run) — the
    // flat source is superseded; remove it without clobbering the newer file.
    await fs.unlink(plan.from).catch(() => undefined);
    return;
  }
  try {
    await fs.rename(plan.from, plan.to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      await fs.copyFile(plan.from, plan.to);
      await fs.unlink(plan.from).catch(() => undefined);
    } else if (code !== 'ENOENT') {
      throw err;
    }
    // ENOENT → source already moved by a racing process; nothing to do.
  }
}

async function writeMarker(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  const tmp = `${layoutMarkerPath(sessionsDir)}.${process.pid}.tmp`;
  const payload = JSON.stringify({
    version: LAYOUT_VERSION,
    migratedAt: new Date().toISOString(),
    from: 'flat-v1',
  });
  await fs.writeFile(tmp, payload + '\n', 'utf8');
  await fs.rename(tmp, layoutMarkerPath(sessionsDir));
}

async function retireSessionsArchive(sessionsDir: string): Promise<void> {
  const dir = sessionsArchiveDir(sessionsDir);
  try {
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) {
      await fs.rmdir(dir).catch(() => undefined);
    }
  } catch {
    // never existed — fine
  }
}

export interface MigrationResult {
  readonly moved: number;
  readonly planned: number;
}

/**
 * Execute the migration under lock + journal. Idempotent: a prior-run journal
 * skips completed moves; the marker is written ONLY after every move lands and
 * `sessions-archive/` is retired. Returns counts (0 moved if another process
 * holds the lock — the caller still operates fine via dual-layout reads).
 */
export async function runMigration(sessionsDir: string): Promise<MigrationResult> {
  if (!(await acquireLock(sessionsDir))) {
    return { moved: 0, planned: 0 };
  }
  try {
    const plans = await planMigration(sessionsDir);
    const done = await readJournalDone(sessionsDir);
    const handle = await fs.open(journalPath(sessionsDir), 'a');
    let moved = 0;
    try {
      for (const plan of plans) {
        if (done.has(plan.from)) {
          continue;
        }
        await executeMove(plan);
        await handle.write(JSON.stringify({ from: plan.from, to: plan.to, done: true }) + '\n');
        moved += 1;
      }
    } finally {
      await handle.close();
    }
    await retireSessionsArchive(sessionsDir);
    await writeMarker(sessionsDir);
    // Journal has served its purpose; the marker is the durable idempotency
    // guard. Removing it is safe (it never held session data).
    await fs.rm(journalPath(sessionsDir), { force: true }).catch(() => undefined);
    return { moved, planned: plans.length };
  } finally {
    await releaseLock(sessionsDir);
  }
}

/**
 * One-shot entry gate. Best-effort: any failure leaves the flat pool intact and
 * readable through the locator, so the next start simply tries again.
 */
export async function ensureLayoutMigrated(sessionsDir: string): Promise<void> {
  try {
    if (await isMigrated(sessionsDir)) {
      return;
    }
    if (!(await needsMigration(sessionsDir))) {
      // Fresh install / already per-project — stamp the marker so we don't
      // re-scan the directory on every subsequent start.
      await writeMarker(sessionsDir).catch(() => undefined);
      return;
    }
    await runMigration(sessionsDir);
  } catch {
    // best-effort — dual-layout reads keep everything working
  }
}
