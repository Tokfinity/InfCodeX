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
import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import type { SessionData } from '../ui/utils/session-storage.js';
import { KODAX_SESSIONS_DIR } from '../common/utils.js';

/**
 * FEATURE_219 — collect candidate session file paths from the per-project
 * layout (flat legacy pool + every `<projectKey>/` dir, plus each project's
 * `archived/` subdir when requested). Returns absolute file paths. Excludes
 * island sidecars (`.archive.jsonl` / `.islands.jsonl`).
 */
async function collectSessionFilePaths(
  sessionsDir: string,
  includeArchived: boolean,
): Promise<string[]> {
  const out: string[] = [];
  const isSession = (name: string): boolean =>
    name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.'); // skip control files (.migration-journal.jsonl)
  let top: import('node:fs').Dirent[] = [];
  try {
    top = await fsPromises.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of top) {
    if (entry.isFile()) {
      if (isSession(entry.name) && (includeArchived || !entry.name.startsWith('archived-'))) {
        out.push(path.join(sessionsDir, entry.name));
      }
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    try {
      for (const f of await fsPromises.readdir(dir)) {
        if (isSession(f)) {
          out.push(path.join(dir, f));
        }
      }
    } catch {
      // unreadable project dir — skip
    }
    if (includeArchived) {
      const archivedDir = path.join(dir, 'archived');
      try {
        for (const f of await fsPromises.readdir(archivedDir)) {
          if (isSession(f)) {
            out.push(path.join(archivedDir, f));
          }
        }
      } catch {
        // no archived subdir — fine
      }
    }
  }
  return out;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly msgCount: number;
  readonly createdAt?: string;
  readonly runtimeInfo?: { workspaceRoot?: string; gitRoot?: string };
  /**
   * FEATURE_219 (v0.7.46) — the per-project directory key this session lives
   * under (ADR-038 §7). A backward-compatible hint: consumers may pass it back
   * for precise disambiguation, but `loadSession(id)` works without it.
   */
  readonly projectKey?: string;
  /** FEATURE_219 — true when the session is whole-session archived (only ever
   * surfaced when `includeArchived` is set). */
  readonly archived?: boolean;
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
   * Whether to include whole-session-archived sessions. FEATURE_219 (v0.7.46):
   * archived sessions live in `<projectKey>/archived/` (see `archiveSession`);
   * also still hides the legacy `archived-` filename prefix. Default false.
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
  archiveSession: typeof archiveSession;
  unarchiveSession: typeof unarchiveSession;
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
      // Fast path: delegate to storage.list() which already handles the
      // common case (head-read every meta file, sorted newest-first,
      // archived/.archive.jsonl filtered, runtimeInfo + gitRoot
      // fallback applied). v0.7.46 — pass `limit` so the caller's
      // requested page size actually lands at the storage layer
      // (pre-v0.7.46 storage.list() had a hardcoded `.slice(0, 10)`
      // that silently truncated any larger limit).
      const raw = await storage.list(gitRoot, { limit });
      return raw.map(toSessionSummary);
    }

    // Slow path: read the sessions directory ourselves for scope / before
    // filtering. FEATURE_219 — gather from the per-project layout (+ flat
    // legacy pool), dedup by id (a session mid-migration may appear twice).
    const filePaths = await collectSessionFilePaths(sessionsDir, includeArchived);

    const sessions: Array<SessionSummary & { _createdAtMs?: number }> = [];
    const seenIds = new Set<string>();

    for (const filePath of filePaths) {
      try {
        const id = path.basename(filePath, '.jsonl');
        if (seenIds.has(id)) continue;
        const archived = path.basename(path.dirname(filePath)) === 'archived';
        const content = (await fsPromises.readFile(filePath, 'utf-8')).trim();
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
        const ri = runtimeInfo ?? (gitRootVal ? { gitRoot: gitRootVal } : undefined);
        const projectKey = deriveProjectKeyFromRoot(ri?.gitRoot ?? ri?.workspaceRoot).key;

        seenIds.add(id);
        sessions.push({
          id,
          title: typeof meta.title === 'string' ? meta.title : '',
          msgCount: activeMessageCount,
          createdAt,
          runtimeInfo: ri,
          projectKey,
          ...(archived ? { archived: true } : {}),
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

    return sessions.slice(0, limit).map(({ id, title, msgCount, createdAt, runtimeInfo, projectKey, archived }) => ({
      id,
      title,
      msgCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(archived ? { archived: true } : {}),
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
  /**
   * v0.7.46 — carried through from `storage.list()` so the fast path
   * populates `SessionSummary.createdAt`. Pre-v0.7.46 this field was
   * dropped on the fast path (storage.list() return shape lacked it),
   * so any consumer sorting by createdAt got `undefined` for every
   * entry on the common-case call.
   */
  createdAt?: string;
}): SessionSummary {
  const runtimeInfo = raw.runtimeInfo
    ? extractRuntimeInfoSummary(raw.runtimeInfo)
    : undefined;
  const projectKey = deriveProjectKeyFromRoot(
    runtimeInfo?.gitRoot ?? runtimeInfo?.workspaceRoot,
  ).key;
  return {
    id: raw.id,
    title: raw.title,
    msgCount: raw.msgCount,
    ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    projectKey,
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

// ── archiveSession / unarchiveSession ─────────────────────────────────────────

/**
 * FEATURE_219 (v0.7.46) — whole-session archive. Moves the session (and its
 * island sidecar) into `<projectKey>/archived/`. Returns false for a missing
 * session. NEVER throws. Archived sessions are hidden from the default listing
 * and resurface only with `listSessions({ includeArchived: true })`.
 */
export async function archiveSession(id: string): Promise<boolean> {
  return archiveSessionImpl(id, undefined);
}

async function archiveSessionImpl(id: string, sessionsDirOverride: string | undefined): Promise<boolean> {
  try {
    return await getStorage(sessionsDirOverride).archive(id);
  } catch {
    return false;
  }
}

/** Restore an archived session back into its project directory. NEVER throws. */
export async function unarchiveSession(id: string): Promise<boolean> {
  return unarchiveSessionImpl(id, undefined);
}

async function unarchiveSessionImpl(id: string, sessionsDirOverride: string | undefined): Promise<boolean> {
  try {
    return await getStorage(sessionsDirOverride).unarchive(id);
  } catch {
    return false;
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
  // FEATURE_219 — recursive watch events carry a `<projectKey>/<id>.jsonl`
  // relative path; reduce to the basename and reject island sidecars.
  const base = path.basename(filename);
  if (
    !base.endsWith('.jsonl')
    || base.endsWith('.archive.jsonl')
    || base.endsWith('.islands.jsonl')
    || base.startsWith('.') // skip control files (.migration-journal.jsonl)
  ) {
    return null;
  }
  return base.slice(0, -6); // strip ".jsonl"
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
      // FEATURE_219 — watch recursively so per-project subdir writes surface.
      // Linux does not support `{ recursive: true }` and throws; fall back to a
      // flat watch of the top dir (degraded — sees flat + new project dirs).
      const onEvent = (eventType: string, filename: string | Buffer | null): void => {
        if (!filename) return;
        const name = typeof filename === 'string' ? filename : filename.toString();
        const sessionId = sessionIdFromFilename(name);
        if (!sessionId) return;
        const kind = eventType === 'rename' ? detectRenameKind(sessionsDir, name) : 'change';
        emitDebounced(kind, sessionId);
      };
      try {
        watcher = fs.watch(sessionsDir, { recursive: true }, onEvent);
      } catch {
        watcher = fs.watch(sessionsDir, onEvent);
      }
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

  function addIds(target: Set<string>, dir: string): void {
    try {
      for (const f of fs.readdirSync(dir)) {
        const id = sessionIdFromFilename(f);
        if (id) target.add(id);
      }
    } catch {
      // unreadable dir — skip
    }
  }

  function buildSnapshot(): Set<string> {
    const ids = new Set<string>();
    try {
      if (!fs.existsSync(sessionsDir)) return ids;
      // FEATURE_219 — snapshot the flat pool + every <projectKey>/ dir + each
      // project's archived/ subdir, so Space sees per-project writes.
      for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          const id = sessionIdFromFilename(entry.name);
          if (id) ids.add(id);
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const dir = path.join(sessionsDir, entry.name);
          addIds(ids, dir);
          addIds(ids, path.join(dir, 'archived'));
        }
      }
    } catch {
      // best-effort
    }
    return ids;
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
      archiveSession,
      unarchiveSession,
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
    archiveSession: (id) => archiveSessionImpl(id, sessionsDir),
    unarchiveSession: (id) => unarchiveSessionImpl(id, sessionsDir),
    listRunningSessions,
    watchSessions: (cb) => watchSessionsImpl(cb, sessionsDir),
    storage,
  };
}
