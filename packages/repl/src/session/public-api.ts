/**
 * FEATURE_173 Part B (v0.7.42) — Session Management Public SDK.
 *
 * Thin facades over FileSessionStorage + discoverInstances. All methods
 * NEVER throw — missing sessions return null, blocked operations return
 * an error envelope, missing directories return empty arrays / no-op
 * watchers.
 *
 * The `@kodax-ai/kodax/session` SDK subpath re-exports this module.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { discoverInstances } from '@kodax-ai/agent';
import type { KodaXSessionRuntimeInfo } from '@kodax-ai/agent';

import { FileSessionStorage } from '../interactive/storage.js';
import type { SessionData } from '../ui/utils/session-storage.js';
import { KODAX_SESSIONS_DIR } from '../common/utils.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly msgCount: number;
  readonly createdAt?: string;
  readonly runtimeInfo?: { workspaceRoot?: string; gitRoot?: string };
}

export interface ListSessionsOptions {
  /**
   * Alias for gitRoot; backwards-compat with KodaX Space terminology.
   * When provided, list() is scoped to sessions from this project root.
   */
  readonly projectRoot?: string;
  /**
   * Which session scopes to include.
   * - 'user' (default): only user-initiated sessions.
   * - 'managed-task-worker': only managed-task worker sessions.
   * - 'all': no scope filter.
   */
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  /**
   * Whether to include archived sessions (filename starts with `archived-`).
   * Default false — no archived sessions exist today; reserved for future use.
   */
  readonly includeArchived?: boolean;
  /** Maximum number of sessions to return. Default 50. */
  readonly limit?: number;
  /**
   * ISO date string — return only sessions whose createdAt is before this
   * timestamp. Applied after list + scope filtering.
   */
  readonly before?: string;
}

export type WatchSessionsCallback = (
  event: { kind: 'change' | 'add' | 'remove'; sessionId: string },
) => void;

export interface SessionManager {
  listSessions: typeof listSessions;
  loadSession: typeof loadSession;
  forkSession: typeof forkSession;
  rewindSession: typeof rewindSession;
  setActiveEntry: typeof setActiveEntry;
  deleteSession: typeof deleteSession;
  listRunningSessions: typeof listRunningSessions;
  watchSessions: typeof watchSessions;
  /**
   * v0.7.43 — the raw write-side storage instance. SDK embedders pass
   * this into `runKodaX({ session: { id, scope, storage } })` so the
   * SA / AMA loops write per-turn JSONL snapshots to disk. Without an
   * injected storage, `saveSessionSnapshot` is a silent no-op and the
   * sessions directory stays empty regardless of `session.id`.
   *
   * See {@link FileSessionStorage} for the concrete implementation and
   * `docs/SDK_EMBEDDER_GUIDE.md` §6 for the end-to-end recipe.
   */
  storage: FileSessionStorage;
}

// ── Shared storage instance (lazy) ───────────────────────────────────────────

function getStorage(sessionsDir?: string): FileSessionStorage {
  return sessionsDir !== undefined
    ? new FileSessionStorage({ sessionsDir })
    : new FileSessionStorage();
}

function resolveSessionsDir(override?: string): string {
  return override ?? KODAX_SESSIONS_DIR;
}

// ── listSessions ─────────────────────────────────────────────────────────────

/**
 * List sessions, optionally filtered by scope, limit, and date.
 * NEVER throws. Returns [] when the sessions directory is empty or missing.
 */
export async function listSessions(opts?: ListSessionsOptions): Promise<SessionSummary[]> {
  return listSessionsImpl(opts, undefined);
}

async function listSessionsImpl(
  opts: ListSessionsOptions | undefined,
  sessionsDirOverride: string | undefined,
): Promise<SessionSummary[]> {
  try {
    const sessionsDir = resolveSessionsDir(sessionsDirOverride);
    // FileSessionStorage.list() accepts an optional gitRoot to scope to the
    // current workspace. Map projectRoot alias to gitRoot.
    const gitRoot = opts?.projectRoot;
    const storage = getStorage(sessionsDirOverride);

    // Read all .jsonl files directly so we can lift the hard-cap of 10 that
    // FileSessionStorage.list() applies, and support scope='all' / 'managed-task-worker'.
    // We replicate the core listing logic here to get createdAt + runtimeInfo
    // without re-reading files.
    await fsPromises.mkdir(sessionsDir, { recursive: true });
    const scope = opts?.scope ?? 'user';
    const includeArchived = opts?.includeArchived ?? false;
    const limit = opts?.limit ?? 50;
    const before = opts?.before ? Date.parse(opts.before) : undefined;

    if (scope === 'user' && !gitRoot && before === undefined && !includeArchived) {
      // Fast path: delegate to storage.list() which already handles the common case.
      // We only need to lift the 10→50 cap by calling it with the gitRoot override.
      const raw = await storage.list(gitRoot);
      return raw.slice(0, limit).map(toSessionSummary);
    }

    // Slow path: read the sessions directory ourselves for scope / before filtering.
    const files = (await fsPromises.readdir(sessionsDir))
      .filter((f) => f.endsWith('.jsonl') && (includeArchived || !f.startsWith('archived-')));

    const sessions: Array<SessionSummary & { _createdAtMs?: number }> = [];

    for (const file of files) {
      try {
        const content = (
          await fsPromises.readFile(path.join(sessionsDir, file), 'utf-8')
        ).trim();
        const firstLine = content.split('\n')[0];
        if (!firstLine) continue;

        const first: unknown = JSON.parse(firstLine);
        if (
          first === null
          || typeof first !== 'object'
          || (first as Record<string, unknown>)._type !== 'meta'
        ) {
          continue;
        }

        const meta = first as Record<string, unknown>;
        const sessionScope: string =
          meta.scope === 'managed-task-worker' ? 'managed-task-worker' : 'user';

        if (scope === 'user' && sessionScope !== 'user') continue;
        if (scope === 'managed-task-worker' && sessionScope !== 'managed-task-worker') continue;
        // scope === 'all' → no filter

        const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;
        if (before !== undefined && createdAt !== undefined) {
          const ts = Date.parse(createdAt);
          if (!Number.isNaN(ts) && ts >= before) continue;
        }

        const lineCount = content.split('\n').length;
        const extensionRecordCount =
          typeof meta.extensionRecordCount === 'number' && meta.extensionRecordCount > 0
            ? meta.extensionRecordCount
            : 0;
        const activeMessageCount =
          typeof meta.activeMessageCount === 'number' && meta.activeMessageCount >= 0
            ? meta.activeMessageCount
            : Math.max(0, lineCount - 1 - extensionRecordCount);

        const runtimeInfo =
          meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
            ? extractRuntimeInfoSummary(meta.runtimeInfo as KodaXSessionRuntimeInfo)
            : undefined;

        const gitRootVal = typeof meta.gitRoot === 'string' ? meta.gitRoot : undefined;

        sessions.push({
          id: file.replace('.jsonl', ''),
          title: typeof meta.title === 'string' ? meta.title : '',
          msgCount: activeMessageCount,
          createdAt,
          runtimeInfo: runtimeInfo ?? (gitRootVal ? { gitRoot: gitRootVal } : undefined),
          _createdAtMs: createdAt ? Date.parse(createdAt) : undefined,
        });
      } catch {
        // Corrupt or unreadable file — skip silently.
        continue;
      }
    }

    // Sort newest-first (mirrors FileSessionStorage.list()).
    sessions.sort((a, b) => {
      const at = a._createdAtMs;
      const bt = b._createdAtMs;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) {
        return (bt as number) - (at as number);
      }
      if (Number.isFinite(bt) && !Number.isFinite(at)) return 1;
      if (Number.isFinite(at) && !Number.isFinite(bt)) return -1;
      return b.id.localeCompare(a.id);
    });

    return sessions.slice(0, limit).map(({ id, title, msgCount, createdAt, runtimeInfo }) => ({
      id,
      title,
      msgCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
    }));
  } catch {
    return [];
  }
}

function extractRuntimeInfoSummary(
  ri: KodaXSessionRuntimeInfo,
): { workspaceRoot?: string; gitRoot?: string } | undefined {
  if (!ri.workspaceRoot && !ri.canonicalRepoRoot) return undefined;
  return {
    ...(ri.workspaceRoot ? { workspaceRoot: ri.workspaceRoot } : {}),
    ...(ri.canonicalRepoRoot ? { gitRoot: ri.canonicalRepoRoot } : {}),
  };
}

function toSessionSummary(raw: {
  id: string;
  title: string;
  msgCount: number;
  runtimeInfo?: KodaXSessionRuntimeInfo;
}): SessionSummary {
  const runtimeInfo = raw.runtimeInfo
    ? extractRuntimeInfoSummary(raw.runtimeInfo)
    : undefined;
  return {
    id: raw.id,
    title: raw.title,
    msgCount: raw.msgCount,
    ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
  };
}

// ── loadSession ───────────────────────────────────────────────────────────────

/**
 * Load full session data by ID.
 * Returns null for a missing session. NEVER throws.
 */
export async function loadSession(id: string): Promise<SessionData | null> {
  return loadSessionImpl(id, undefined);
}

async function loadSessionImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<SessionData | null> {
  try {
    return await getStorage(sessionsDirOverride).load(id);
  } catch {
    return null;
  }
}

// ── forkSession ───────────────────────────────────────────────────────────────

/**
 * Fork a session at an optional selector.
 * Returns null for a missing session. NEVER throws.
 */
export async function forkSession(
  id: string,
  opts?: { selector?: string; sessionId?: string; title?: string },
): Promise<{ sessionId: string; data: SessionData } | null> {
  return forkSessionImpl(id, opts, undefined);
}

async function forkSessionImpl(
  id: string,
  opts: { selector?: string; sessionId?: string; title?: string } | undefined,
  sessionsDirOverride: string | undefined,
): Promise<{ sessionId: string; data: SessionData } | null> {
  try {
    return await getStorage(sessionsDirOverride).fork(id, opts?.selector, {
      sessionId: opts?.sessionId,
      title: opts?.title,
    });
  } catch {
    return null;
  }
}

// ── rewindSession ─────────────────────────────────────────────────────────────

/**
 * Rewind a session to a previous user entry.
 * Returns null for a missing session. NEVER throws.
 */
export async function rewindSession(
  id: string,
  opts?: { selector?: string },
): Promise<SessionData | null> {
  return rewindSessionImpl(id, opts, undefined);
}

async function rewindSessionImpl(
  id: string,
  opts: { selector?: string } | undefined,
  sessionsDirOverride: string | undefined,
): Promise<SessionData | null> {
  try {
    return await getStorage(sessionsDirOverride).rewind(id, opts?.selector);
  } catch {
    return null;
  }
}

// ── setActiveEntry ────────────────────────────────────────────────────────────

/**
 * Set the active lineage entry by selector.
 * Returns null for a missing session. NEVER throws.
 */
export async function setActiveEntry(
  id: string,
  selector: string,
): Promise<SessionData | null> {
  return setActiveEntryImpl(id, selector, undefined);
}

async function setActiveEntryImpl(
  id: string,
  selector: string,
  sessionsDirOverride: string | undefined,
): Promise<SessionData | null> {
  try {
    return await getStorage(sessionsDirOverride).setActiveEntry(id, selector);
  } catch {
    return null;
  }
}

// ── listRunningSessions ───────────────────────────────────────────────────────

export interface RunningSessionInfo {
  readonly pid: number;
  readonly startedAt: number;
  readonly cwd: string;
  /**
   * v0.7.43 — populated from `PersistedSessionState.sessionId`, published
   * by the REPL after `createInteractiveContext`. Remains `undefined` for
   * a brief window during a peer's bootstrap (before the first sessionId
   * is generated) and for peers running pre-v0.7.43 binaries; consumers
   * MUST handle `undefined`.
   */
  readonly sessionId: string | undefined;
}

/**
 * Returns live KodaX sibling instances (excluding this process).
 * Uses discoverInstances() from @kodax-ai/agent (FEATURE_125 Team Mode).
 * NEVER throws. Returns [] when no instances directory exists.
 */
export async function listRunningSessions(): Promise<RunningSessionInfo[]> {
  try {
    const instances = discoverInstances({ excludePid: process.pid });
    return instances.map((inst) => ({
      pid: inst.pid,
      startedAt: inst.state.meta.startedAt,
      cwd: inst.state.meta.cwd,
      sessionId: inst.state.sessionId,
    }));
  } catch {
    return [];
  }
}

// ── deleteSession ─────────────────────────────────────────────────────────────

export type DeleteSessionResult =
  | { ok: true }
  | { error: { code: 'session_running'; runningProcess: { pid: number; startedAt: number } } };

/**
 * Delete a session by ID.
 * Returns { ok: true } on success (including when the session doesn't exist).
 * Returns an error envelope when the session is currently running.
 * NEVER throws.
 */
export async function deleteSession(id: string): Promise<DeleteSessionResult> {
  return deleteSessionImpl(id, undefined);
}

async function deleteSessionImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<DeleteSessionResult> {
  try {
    const running = await listRunningSessions();
    const match = running.find((r) => r.sessionId === id);
    if (match) {
      return {
        error: {
          code: 'session_running',
          runningProcess: { pid: match.pid, startedAt: match.startedAt },
        },
      };
    }
    await getStorage(sessionsDirOverride).delete(id);
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ── watchSessions ─────────────────────────────────────────────────────────────

/**
 * Watch the sessions directory for changes.
 * Returns { close() } that stops the watcher / poll interval.
 *
 * Platform branches:
 * - POSIX: fs.watch() with 100ms debounce.
 * - Windows: readdir poll every 1000ms, diffed against a snapshot.
 *
 * NEVER throws — if the directory doesn't exist the watcher is a no-op
 * until the directory is created.
 */
export function watchSessions(cb: WatchSessionsCallback): { close: () => void } {
  return watchSessionsImpl(cb, undefined);
}

function watchSessionsImpl(
  cb: WatchSessionsCallback,
  sessionsDirOverride: string | undefined,
): { close: () => void } {
  const sessionsDir = resolveSessionsDir(sessionsDirOverride);
  if (process.platform === 'win32') {
    return watchSessionsWindows(cb, sessionsDir);
  }
  return watchSessionsPosix(cb, sessionsDir);
}

function sessionIdFromFilename(filename: string): string | null {
  if (!filename.endsWith('.jsonl')) return null;
  return filename.slice(0, -6); // strip ".jsonl"
}

function watchSessionsPosix(
  cb: WatchSessionsCallback,
  sessionsDir: string,
): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let closed = false;

  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  function emitDebounced(kind: 'change' | 'add' | 'remove', sessionId: string): void {
    const existing = debounceMap.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceMap.delete(sessionId);
      if (!closed) cb({ kind, sessionId });
    }, 100);
    debounceMap.set(sessionId, timer);
  }

  function startWatch(): void {
    if (closed) return;
    try {
      if (!fs.existsSync(sessionsDir)) {
        // Directory not yet created — retry after 1s.
        setTimeout(startWatch, 1000);
        return;
      }
      watcher = fs.watch(sessionsDir, (eventType, filename) => {
        if (!filename) return;
        const sessionId = sessionIdFromFilename(filename);
        if (!sessionId) return;
        const kind = eventType === 'rename' ? detectRenameKind(sessionsDir, filename) : 'change';
        emitDebounced(kind, sessionId);
      });
      watcher.on('error', () => {
        // Watcher error (e.g. directory deleted) — restart.
        watcher?.close();
        watcher = null;
        if (!closed) setTimeout(startWatch, 1000);
      });
    } catch {
      // Silently ignore — directory may not exist yet.
    }
  }

  startWatch();

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      for (const t of debounceMap.values()) clearTimeout(t);
      debounceMap.clear();
    },
  };
}

function detectRenameKind(sessionsDir: string, filename: string): 'add' | 'remove' {
  // On POSIX 'rename' fires for both add and remove; check existence.
  try {
    fs.statSync(path.join(sessionsDir, filename));
    return 'add';
  } catch {
    return 'remove';
  }
}

function watchSessionsWindows(
  cb: WatchSessionsCallback,
  sessionsDir: string,
): { close: () => void } {
  let closed = false;
  let lastSnapshot = new Set<string>();

  function buildSnapshot(): Set<string> {
    try {
      if (!fs.existsSync(sessionsDir)) return new Set();
      return new Set(
        fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => f.slice(0, -6)),
      );
    } catch {
      return new Set();
    }
  }

  // Build initial snapshot without emitting events.
  lastSnapshot = buildSnapshot();

  const interval = setInterval(() => {
    if (closed) return;
    const current = buildSnapshot();
    for (const id of current) {
      if (!lastSnapshot.has(id)) cb({ kind: 'add', sessionId: id });
    }
    for (const id of lastSnapshot) {
      if (!current.has(id)) cb({ kind: 'remove', sessionId: id });
    }
    lastSnapshot = current;
  }, 1000);

  return {
    close() {
      closed = true;
      clearInterval(interval);
    },
  };
}

// ── createSessionManager ──────────────────────────────────────────────────────

/**
 * Factory that returns an object with all session management methods bound.
 *
 * v0.7.43 (FEATURE_173 Part B follow-up) — the `sessionsDir` override is
 * now honored. When provided, all read/write/watch operations go through
 * that directory instead of the module-load-frozen `KODAX_SESSIONS_DIR`.
 * `listRunningSessions` still consults the agent-config-home instances
 * directory (sibling-process awareness is not scoped per sessions dir).
 */
export function createSessionManager(opts?: { sessionsDir?: string }): SessionManager {
  const sessionsDir = opts?.sessionsDir;
  // Single FileSessionStorage instance per manager. Returned via the
  // `storage` field so callers can pass it through
  // `runKodaX({ session: { id, storage } })`; sharing one instance keeps
  // write-queue + append-watermark caches (CAP-013-001) coherent across
  // mixed read (load/list) + write (run) operations.
  const storage = sessionsDir !== undefined
    ? new FileSessionStorage({ sessionsDir })
    : new FileSessionStorage();
  if (sessionsDir === undefined) {
    return {
      listSessions,
      loadSession,
      forkSession,
      rewindSession,
      setActiveEntry,
      deleteSession,
      listRunningSessions,
      watchSessions,
      storage,
    };
  }
  return {
    listSessions: (o) => listSessionsImpl(o, sessionsDir),
    loadSession: (id) => loadSessionImpl(id, sessionsDir),
    forkSession: (id, o) => forkSessionImpl(id, o, sessionsDir),
    rewindSession: (id, o) => rewindSessionImpl(id, o, sessionsDir),
    setActiveEntry: (id, selector) => setActiveEntryImpl(id, selector, sessionsDir),
    deleteSession: (id) => deleteSessionImpl(id, sessionsDir),
    listRunningSessions,
    watchSessions: (cb) => watchSessionsImpl(cb, sessionsDir),
    storage,
  };
}
