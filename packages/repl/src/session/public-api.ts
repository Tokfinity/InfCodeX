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
import { randomUUID } from 'node:crypto';

import { createSessionLineage, discoverInstances, emitKodaXDiagnostic } from '@kodax-ai/agent';
import type {
  KodaXJsonValue,
  KodaXMessage,
  KodaXSessionClientNoticeEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionRuntimeInfo,
  KodaXTaskResultMetadata,
} from '@kodax-ai/agent';

import { FileSessionStorage, readSessionFirstLine } from '../interactive/storage.js';
import { compactSession } from './compact-session.js';
export { compactSession } from './compact-session.js';
export type { CompactSessionOptions, CompactSessionResult } from './compact-session.js';
import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import { ensureLayoutMigrated } from '../interactive/session-migration.js';
import { isKodaXJsonValue } from '../interactive/json-guards.js';
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

function normalizeComparableRoot(value: string | undefined): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function sessionMatchesProjectRoot(
  summaryRuntime: { workspaceRoot?: string; gitRoot?: string } | undefined,
  metaGitRoot: string | undefined,
  projectRoot: string | undefined,
): boolean {
  const target = normalizeComparableRoot(projectRoot);
  if (!target) {
    return true;
  }
  return [
    summaryRuntime?.gitRoot,
    summaryRuntime?.workspaceRoot,
    metaGitRoot,
  ].some((candidate) => normalizeComparableRoot(candidate) === target);
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  /** Opaque continuation token; pass the last item cursor back to listSessions(). */
  readonly cursor?: string;
  readonly title: string;
  readonly msgCount: number;
  readonly tag?: string;
  readonly createdAt?: string;
  // FEATURE_247 (R5): surface + profileId are projected onto the list summary
  // so an embedder can filter a Partner session from a Coder session without a
  // full loadSession(). provider/model/etc. stay on the full-load runtimeInfo.
  readonly runtimeInfo?: {
    workspaceRoot?: string;
    gitRoot?: string;
    surface?: string;
    profileId?: string;
  };
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

export type SessionTranscriptEntryType =
  | 'message'
  | 'compaction'
  | 'branch_summary'
  /** Rewind audit marker; not included in `FullTranscriptSessionData.messages`. */
  | 'rewind_marker'
  | 'client_notice'
  /**
   * Synthetic task/workflow completion entry derived from `_taskResult`,
   * `_taskResults`, or legacy `<task-completed>` banners. The original
   * `KodaXMessage` is still exposed on `message`, but consumers that want a
   * complete transcript should not filter only `type === 'message'`.
   */
  | 'task_result';

export type SessionTranscriptEntrySource =
  | 'user'
  | 'assistant'
  | 'workflow'
  | 'child_task'
  | 'system'
  | 'client';

export interface SessionTranscriptEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  /** Stable logical identity shared by cloned/forked copies of the same entry. */
  readonly logicalId: string;
  /** Root source physical entry id when this transcript entry was cloned/forked. */
  readonly sourceEntryId?: string;
  readonly timestamp: string;
  readonly type: SessionTranscriptEntryType;
  readonly source?: SessionTranscriptEntrySource;
  readonly turnId?: string;
  readonly message: KodaXMessage;
  readonly active: boolean;
  readonly summary?: string;
  readonly payload?: unknown;
  readonly taskResults?: readonly KodaXTaskResultMetadata[];
}

export interface FullTranscriptSessionData extends Omit<SessionData, 'messages'> {
  readonly messages: KodaXMessage[];
  readonly activeMessages: KodaXMessage[];
  readonly transcriptEntries: SessionTranscriptEntry[];
}

export interface AppendClientNoticeOptions {
  readonly source?: string;
  readonly content: string;
  readonly timestamp?: string;
  readonly turnId?: string;
  readonly payload?: KodaXJsonValue;
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
  /** Exact match. Omitted means no tag filter. */
  readonly tag?: string;
  /** Exact runtime surface match, for example `repl`, `cli`, `acp`, or `partner`. */
  readonly surface?: string;
  /** Opaque cursor returned on a previous page's last SessionSummary. */
  readonly cursor?: string;
}

type SessionListCandidate = SessionSummary & { _createdAtMs?: number };

interface SessionListReadFilter {
  readonly scope: NonNullable<ListSessionsOptions['scope']>;
  readonly before?: number;
  readonly tag?: string;
  readonly surface?: string;
  readonly gitRoot?: string;
}

async function readSessionMetaRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  const firstLine = await readSessionFirstLine(filePath);
  if (!firstLine) return undefined;
  const first: unknown = JSON.parse(firstLine);
  if (first === null || typeof first !== 'object') return undefined;
  const meta = first as Record<string, unknown>;
  return meta._type === 'meta' ? meta : undefined;
}

async function readActiveMessageCount(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<number> {
  if (typeof meta.activeMessageCount === 'number' && meta.activeMessageCount >= 0) {
    return meta.activeMessageCount;
  }
  const content = (await fsPromises.readFile(filePath, 'utf-8')).trim();
  const extensionRecordCount =
    typeof meta.extensionRecordCount === 'number' && meta.extensionRecordCount > 0
      ? meta.extensionRecordCount
      : 0;
  return Math.max(0, content.split('\n').length - 1 - extensionRecordCount);
}

async function readSessionListCandidate(
  filePath: string,
  filter: SessionListReadFilter,
): Promise<SessionListCandidate | undefined> {
  const meta = await readSessionMetaRecord(filePath);
  if (!meta) return undefined;
  const sessionScope = meta.scope === 'managed-task-worker' ? 'managed-task-worker' : 'user';
  if (filter.scope !== 'all' && filter.scope !== sessionScope) return undefined;

  const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;
  const createdAtMs = createdAt ? Date.parse(createdAt) : undefined;
  if (
    filter.before !== undefined
    && createdAtMs !== undefined
    && Number.isFinite(createdAtMs)
    && createdAtMs >= filter.before
  ) {
    return undefined;
  }
  const tag = typeof meta.tag === 'string' ? meta.tag : undefined;
  if (filter.tag !== undefined && tag !== filter.tag) return undefined;

  const runtimeInfo = meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
    ? extractRuntimeInfoSummary(meta.runtimeInfo as KodaXSessionRuntimeInfo)
    : undefined;
  const metaGitRoot = typeof meta.gitRoot === 'string' ? meta.gitRoot : undefined;
  const summaryRuntime = runtimeInfo ?? (metaGitRoot ? { gitRoot: metaGitRoot } : undefined);
  if (!sessionMatchesProjectRoot(summaryRuntime, metaGitRoot, filter.gitRoot)) return undefined;
  if (filter.surface !== undefined && summaryRuntime?.surface !== filter.surface) return undefined;

  const id = path.basename(filePath, '.jsonl');
  const archived = path.basename(path.dirname(filePath)) === 'archived';
  return {
    id,
    title: typeof meta.title === 'string' ? meta.title : '',
    msgCount: await readActiveMessageCount(filePath, meta),
    ...(tag !== undefined ? { tag } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(summaryRuntime !== undefined ? { runtimeInfo: summaryRuntime } : {}),
    projectKey: deriveProjectKeyFromRoot(summaryRuntime?.gitRoot ?? summaryRuntime?.workspaceRoot).key,
    ...(archived ? { archived: true } : {}),
    _createdAtMs: createdAtMs,
  };
}

export type WatchSessionsCallback = (
  event: { kind: 'change' | 'add' | 'remove'; sessionId: string },
) => void;

export interface SessionManager {
  listSessions: typeof listSessions;
  loadSession: typeof loadSession;
  loadFullTranscript: typeof loadFullTranscript;
  appendClientNotice: typeof appendClientNotice;
  forkSession: typeof forkSession;
  rewindSession: typeof rewindSession;
  setActiveEntry: typeof setActiveEntry;
  deleteSession: typeof deleteSession;
  archiveSession: typeof archiveSession;
  unarchiveSession: typeof unarchiveSession;
  listRunningSessions: typeof listRunningSessions;
  watchSessions: typeof watchSessions;
  /** FEATURE_247 (R6) — imperatively compact a session by id (writes lineage + emits nothing; returns stats). */
  compactSession: typeof compactSession;
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

function encodeSessionCursor(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url');
}

function decodeSessionCursor(cursor: string): string | undefined {
  if (!cursor || cursor.length > 1024) return undefined;
  try {
    const sessionId = Buffer.from(cursor, 'base64url').toString('utf8');
    return sessionId && encodeSessionCursor(sessionId) === cursor ? sessionId : undefined;
  } catch {
    return undefined;
  }
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
    // FEATURE_219 — trigger the one-shot auto-migration here too, so the SDK
    // SLOW path (scope='all' / before / includeArchived) which reads the
    // directory directly (collectSessionFilePaths) doesn't bypass the gate the
    // FileSessionStorage entry points enforce. Idempotent (marker fast-path).
    await ensureLayoutMigrated(sessionsDir);
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
    const tag = opts?.tag;
    const surface = opts?.surface;
    const cursorId = opts?.cursor === undefined ? undefined : decodeSessionCursor(opts.cursor);
    if (opts?.cursor !== undefined && cursorId === undefined) return [];

    if (
      scope === 'user'
      && !gitRoot
      && before === undefined
      && !includeArchived
      && tag === undefined
      && surface === undefined
      && cursorId === undefined
    ) {
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

    const sessions: SessionListCandidate[] = [];
    const seenIds = new Set<string>();
    const readFilter: SessionListReadFilter = {
      scope,
      ...(before !== undefined ? { before } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(surface !== undefined ? { surface } : {}),
      ...(gitRoot !== undefined ? { gitRoot } : {}),
    };

    const readConcurrency = 48;
    for (let index = 0; index < filePaths.length; index += readConcurrency) {
      const batch = await Promise.all(
        filePaths.slice(index, index + readConcurrency).map(async (filePath) => {
          try {
            return await readSessionListCandidate(filePath, readFilter);
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: 'session.public-api',
              level: 'warn',
              message: 'Unreadable session record was skipped.',
              detail: { filePath, error },
            });
            return undefined;
          }
        }),
      );
      for (const candidate of batch) {
        if (candidate && !seenIds.has(candidate.id)) {
          seenIds.add(candidate.id);
          sessions.push(candidate);
        }
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

    const cursorIndex = cursorId === undefined
      ? -1
      : sessions.findIndex((session) => session.id === cursorId);
    if (cursorId !== undefined && cursorIndex < 0) return [];
    const pageStart = cursorIndex + 1;

    return sessions.slice(pageStart, pageStart + limit).map(({ id, title, msgCount, tag: sessionTag, createdAt, runtimeInfo, projectKey, archived }) => ({
      id,
      cursor: encodeSessionCursor(id),
      title,
      msgCount,
      ...(sessionTag !== undefined ? { tag: sessionTag } : {}),
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
): { workspaceRoot?: string; gitRoot?: string; surface?: string; profileId?: string } | undefined {
  // FEATURE_247 (R5): include surface + profileId so a Partner session is
  // identifiable from the list without a full load, even when it has no
  // workspace root.
  const out = {
    ...(ri.workspaceRoot ? { workspaceRoot: ri.workspaceRoot } : {}),
    ...(ri.canonicalRepoRoot ? { gitRoot: ri.canonicalRepoRoot } : {}),
    ...(ri.surface ? { surface: ri.surface } : {}),
    ...(ri.profileId ? { profileId: ri.profileId } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function toSessionSummary(raw: {
  id: string;
  title: string;
  msgCount: number;
  tag?: string;
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
    cursor: encodeSessionCursor(raw.id),
    title: raw.title,
    msgCount: raw.msgCount,
    ...(raw.tag !== undefined ? { tag: raw.tag } : {}),
    ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    projectKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessage(value: unknown): value is KodaXMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.role === 'user'
    || value.role === 'assistant'
    || value.role === 'system'
  ) && (
    typeof value.content === 'string'
    || Array.isArray(value.content)
  );
}

function hasEntryBase(value: unknown): value is {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  logicalId?: string;
  sourceEntryId?: string;
} {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string'
    && (value.logicalId === undefined || typeof value.logicalId === 'string')
    && (value.sourceEntryId === undefined || typeof value.sourceEntryId === 'string');
}

function isTranscriptSidecarEntry(value: unknown): value is KodaXSessionEntry {
  if (!hasEntryBase(value)) {
    return false;
  }
  const entry = value as Record<string, unknown> & {
    id: string;
    parentId: string | null;
    timestamp: string;
    type: string;
  };
  switch (entry.type) {
    case 'message':
      return isMessage(entry.message);
    case 'compaction':
      return typeof entry.summary === 'string';
    case 'branch_summary':
      return typeof entry.summary === 'string';
    case 'archive_marker':
      return typeof entry.archiveBatchId === 'string'
        && typeof entry.archivedEntryCount === 'number'
        && typeof entry.summary === 'string';
    case 'rewind_marker':
      return typeof entry.targetId === 'string'
        && (entry.fromId === undefined || typeof entry.fromId === 'string')
        && typeof entry.truncatedCount === 'number'
        && typeof entry.summary === 'string';
    case 'label':
      return typeof entry.targetId === 'string'
        && (entry.label === undefined || typeof entry.label === 'string');
    case 'client_notice':
      return typeof entry.source === 'string'
        && typeof entry.content === 'string'
        && (entry.turnId === undefined || typeof entry.turnId === 'string')
        && (entry.payload === undefined || isKodaXJsonValue(entry.payload));
    case 'goal':
      return typeof entry.event === 'string';
    default:
      return false;
  }
}

function isArchivedEntryLine(value: unknown): value is {
  _type: 'archived_entry';
  archiveBatchId: string;
  entry: KodaXSessionEntry;
} {
  return isRecord(value)
    && value._type === 'archived_entry'
    && typeof value.archiveBatchId === 'string'
    && isTranscriptSidecarEntry(value.entry);
}

async function readArchivedTranscriptEntries(
  id: string,
  sessionsDir: string,
): Promise<KodaXSessionEntry[]> {
  let sessionFile: string | undefined;
  const candidateNames = new Set([`${id}.jsonl`, `archived-${id}.jsonl`]);
  for (const filePath of await collectSessionFilePaths(sessionsDir, true)) {
    if (candidateNames.has(path.basename(filePath))) {
      sessionFile = filePath;
      break;
    }
  }
  if (!sessionFile) {
    return [];
  }

  const dir = path.dirname(sessionFile);
  const stem = path.basename(sessionFile, '.jsonl');
  const stems = Array.from(new Set([id, stem]));
  const sidecarPaths = stems.flatMap((candidate) => [
    path.join(dir, `${candidate}.islands.jsonl`),
    path.join(dir, `${candidate}.archive.jsonl`),
  ]);

  const entries: KodaXSessionEntry[] = [];
  const seenEntryIds = new Set<string>();
  for (const sidecarPath of sidecarPaths) {
    let text = '';
    try {
      text = await fsPromises.readFile(sidecarPath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isArchivedEntryLine(parsed)) {
          if (!seenEntryIds.has(parsed.entry.id)) {
            seenEntryIds.add(parsed.entry.id);
            entries.push(parsed.entry);
          }
        }
      } catch {
        // Ignore malformed sidecar records; the main session is still useful.
      }
    }
  }
  return entries;
}

function mergeTranscriptLineageEntries(
  archivedEntries: readonly KodaXSessionEntry[],
  lineageEntries: readonly KodaXSessionEntry[],
): KodaXSessionEntry[] {
  const seenEntryIds = new Set<string>();
  const merged: KodaXSessionEntry[] = [];

  for (const entry of archivedEntries) {
    if (!seenEntryIds.has(entry.id)) {
      seenEntryIds.add(entry.id);
      merged.push(entry);
    }
  }
  for (const entry of lineageEntries) {
    if (!seenEntryIds.has(entry.id)) {
      seenEntryIds.add(entry.id);
      merged.push(entry);
    }
  }

  return merged;
}

// ── loadSession ───────────────────────────────────────────────────────────────

// Full transcript helpers preserve append order without changing active
// lineage semantics.
function collectActiveIds(lineage: KodaXSessionLineage): Set<string> {
  const byId = new Map(lineage.entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set<string>();
  let currentId = lineage.activeEntryId;
  while (currentId) {
    const entry = byId.get(currentId);
    if (!entry) {
      break;
    }
    activeIds.add(entry.id);
    currentId = entry.parentId;
  }
  return activeIds;
}

function summaryMessage(summary: string, kind: SessionTranscriptEntryType): KodaXMessage {
  if (kind === 'branch_summary') {
    return {
      role: 'user',
      content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}\n</summary>`,
    };
  }
  return {
    role: 'system',
    content: `[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n${summary}`,
  };
}

function rewindMarkerMessage(summary: string): KodaXMessage {
  return {
    role: 'system',
    content: `[Rewind] ${summary}`,
  };
}

function clientNoticeMessage(entry: KodaXSessionClientNoticeEntry): KodaXMessage {
  return {
    role: 'system',
    content: entry.content,
    _source: 'client_notice',
    timestamp: entry.timestamp,
    ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
  };
}

function messageStringField(message: KodaXMessage, key: string): string | undefined {
  const value = (message as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function messageSource(message: KodaXMessage): SessionTranscriptEntrySource | undefined {
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  if (message.role === 'system') return 'system';
  return undefined;
}

function isTaskResultMetadata(value: unknown): value is KodaXTaskResultMetadata {
  if (!isRecord(value)) return false;
  return value.type === 'task_result'
    && (value.source === 'workflow' || value.source === 'child_task')
    && typeof value.taskId === 'string'
    && (
      value.status === 'completed'
      || value.status === 'failed'
      || value.status === 'cancelled'
    )
    && (value.runId === undefined || typeof value.runId === 'string')
    && (value.title === undefined || typeof value.title === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (
      value.artifactRefs === undefined
      || (Array.isArray(value.artifactRefs) && value.artifactRefs.every((item) => typeof item === 'string'))
    );
}

function taskResultsFromMessage(message: KodaXMessage): KodaXTaskResultMetadata[] {
  if (isTaskResultMetadata(message._taskResult)) {
    return [message._taskResult];
  }
  if (Array.isArray(message._taskResults)) {
    return message._taskResults.filter(isTaskResultMetadata);
  }
  if (message._source !== 'task-completed' || typeof message.content !== 'string') {
    return [];
  }
  const results: KodaXTaskResultMetadata[] = [];
  const pattern = /<task-completed\s+task_id="([^"]+)">([\s\S]*?)<\/task-completed>/g;
  for (const match of message.content.matchAll(pattern)) {
    const taskId = match[1];
    if (!taskId) continue;
    const summary = match[2]?.trim() ?? '';
    results.push({
      type: 'task_result',
      source: 'child_task',
      taskId,
      status: summary.startsWith('failed:') || summary.startsWith('[Tool Error]')
        ? 'failed'
        : 'completed',
      ...(summary.length > 0 ? { summary } : {}),
    });
  }
  return results;
}

function taskResultPayload(results: readonly KodaXTaskResultMetadata[]): unknown {
  if (results.length === 1) {
    return results[0];
  }
  const first = results[0];
  return first
    ? {
        type: 'task_result',
        source: first.source,
        taskId: first.taskId,
        status: first.status,
        results,
      }
    : undefined;
}

function legacyRewindDetails(details: KodaXJsonValue | undefined): {
  readonly rewindTargetId?: string;
  readonly truncatedCount?: number;
} {
  if (!isRecord(details)) {
    return {};
  }
  const rewindTargetId = typeof details.rewindTargetId === 'string'
    ? details.rewindTargetId
    : undefined;
  const truncatedCount = typeof details.truncatedCount === 'number'
    ? details.truncatedCount
    : undefined;
  return {
    ...(rewindTargetId !== undefined ? { rewindTargetId } : {}),
    ...(truncatedCount !== undefined ? { truncatedCount } : {}),
  };
}

function transcriptEntryActive(
  entry: KodaXSessionEntry,
  activeIds: ReadonlySet<string>,
  activeEntryId: string | null,
): boolean {
  if (activeIds.has(entry.id)) {
    return true;
  }
  if (entry.type !== 'client_notice' && entry.type !== 'rewind_marker') {
    return false;
  }
  return entry.parentId === null
    ? activeEntryId === null
    : activeIds.has(entry.parentId);
}

function transcriptEntryIdentity(entry: KodaXSessionEntry): {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly logicalId: string;
  readonly sourceEntryId?: string;
} {
  return {
    entryId: entry.id,
    parentId: entry.parentId,
    logicalId: entry.logicalId ?? entry.id,
    ...(entry.sourceEntryId !== undefined ? { sourceEntryId: entry.sourceEntryId } : {}),
  };
}

function toTranscriptEntry(
  entry: KodaXSessionEntry,
  activeIds: ReadonlySet<string>,
  activeEntryId: string | null,
): SessionTranscriptEntry | null {
  const active = transcriptEntryActive(entry, activeIds, activeEntryId);
  switch (entry.type) {
    case 'message': {
      const taskResults = taskResultsFromMessage(entry.message);
      if (taskResults.length > 0) {
        const first = taskResults[0]!;
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'task_result',
          source: first.source,
          turnId: messageStringField(entry.message, 'turnId'),
          message: entry.message,
          active,
          payload: taskResultPayload(taskResults),
          taskResults,
        };
      }
      if (entry.message._source === 'client_notice') {
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'client_notice',
          source: 'client',
          turnId: messageStringField(entry.message, 'turnId'),
          message: entry.message,
          active,
          payload: {
            content: entry.message.content,
            entersModelContext: false,
          },
        };
      }
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'message',
        source: messageSource(entry.message),
        turnId: messageStringField(entry.message, 'turnId'),
        message: entry.message,
        active,
      };
    }
    case 'compaction':
      if (entry.reason === 'rewind') {
        const details = legacyRewindDetails(entry.details);
        const markerActive = active || (entry.parentId === null
          ? activeEntryId === null
          : activeIds.has(entry.parentId));
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'rewind_marker',
          source: 'system',
          message: rewindMarkerMessage(entry.summary),
          active: markerActive,
          summary: entry.summary,
          payload: {
            summary: entry.summary,
            reason: 'rewind',
            ...(details.rewindTargetId !== undefined ? { rewindTargetId: details.rewindTargetId } : {}),
            ...(details.truncatedCount !== undefined ? { truncatedCount: details.truncatedCount } : {}),
            ...(entry.details !== undefined ? { details: entry.details } : {}),
          },
        };
      }
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'compaction',
        source: 'system',
        message: summaryMessage(entry.summary, 'compaction'),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          tokensAfter: entry.tokensAfter,
          reason: entry.reason,
          details: entry.details,
        },
      };
    case 'rewind_marker':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'rewind_marker',
        source: 'system',
        message: rewindMarkerMessage(entry.summary),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          rewindTargetId: entry.targetId,
          ...(entry.fromId !== undefined ? { fromId: entry.fromId } : {}),
          truncatedCount: entry.truncatedCount,
        },
      };
    case 'branch_summary':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'branch_summary',
        source: 'system',
        message: summaryMessage(entry.summary, 'branch_summary'),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          fromId: entry.fromId,
          details: entry.details,
        },
      };
    case 'client_notice':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'client_notice',
        source: 'client',
        turnId: entry.turnId,
        message: clientNoticeMessage(entry),
        active,
        payload: {
          source: entry.source,
          content: entry.content,
          entersModelContext: false,
          ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        },
      };
    case 'archive_marker':
    case 'label':
    case 'goal':
    case 'memory_outcome_digest':
    case 'memory_review_receipt':
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function buildTranscriptEntries(lineage: KodaXSessionLineage): SessionTranscriptEntry[] {
  const activeIds = collectActiveIds(lineage);
  return lineage.entries
    .map((entry) => toTranscriptEntry(entry, activeIds, lineage.activeEntryId))
    .filter((entry): entry is SessionTranscriptEntry => entry !== null);
}

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

/**
 * Load append-order transcript data by ID.
 *
 * `loadSession` remains the active model-context API. This helper is for UI
 * scrollback: it returns every persisted transcript-bearing lineage entry in
 * append order and keeps the active branch in `activeMessages`.
 */
export async function loadFullTranscript(id: string): Promise<FullTranscriptSessionData | null> {
  return loadFullTranscriptImpl(id, undefined);
}

async function loadFullTranscriptImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<FullTranscriptSessionData | null> {
  try {
    const sessionsDir = resolveSessionsDir(sessionsDirOverride);
    await ensureLayoutMigrated(sessionsDir);
    const storage = getStorage(sessionsDirOverride);
    const activeData = await storage.load(id);
    if (!activeData) {
      return null;
    }
    const lineage = await storage.getLineage(id);
    if (!lineage) {
      return {
        ...activeData,
        activeMessages: activeData.messages,
        transcriptEntries: [],
      };
    }
    const archivedEntries = await readArchivedTranscriptEntries(id, sessionsDir);
    const fullLineage = archivedEntries.length > 0
      ? { ...lineage, entries: mergeTranscriptLineageEntries(archivedEntries, lineage.entries) }
      : lineage;
    const transcriptEntries = buildTranscriptEntries(fullLineage);
    return {
      ...activeData,
      messages: transcriptEntries
        .filter((entry) => entry.type !== 'rewind_marker')
        .map((entry) => entry.message),
      activeMessages: activeData.messages,
      transcriptEntries,
      lineage: fullLineage,
    };
  } catch {
    return null;
  }
}

function normalizeClientNoticeSource(source: string | undefined): string {
  const trimmed = source?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'client';
}

function createClientNoticeEntry(
  lineage: KodaXSessionLineage,
  options: AppendClientNoticeOptions,
): KodaXSessionClientNoticeEntry {
  const entryId = `notice_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return {
    type: 'client_notice',
    id: entryId,
    parentId: lineage.activeEntryId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    logicalId: entryId,
    source: normalizeClientNoticeSource(options.source),
    content: options.content,
    ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  };
}

/**
 * Append a host-owned transcript notice that never enters model context.
 *
 * Use this for local slash-command output such as `/doctor`, `/mcp status`,
 * or host-side status panes. It is visible through `loadFullTranscript()` but
 * `loadSession()` keeps returning only the active model messages.
 */
export async function appendClientNotice(
  id: string,
  options: AppendClientNoticeOptions,
): Promise<SessionTranscriptEntry | null> {
  return appendClientNoticeImpl(id, options, undefined);
}

async function appendClientNoticeImpl(
  id: string,
  options: AppendClientNoticeOptions,
  sessionsDirOverride: string | undefined,
): Promise<SessionTranscriptEntry | null> {
  return appendClientNoticeWithStorage(id, options, getStorage(sessionsDirOverride));
}

async function appendClientNoticeWithStorage(
  id: string,
  options: AppendClientNoticeOptions,
  storage: FileSessionStorage,
): Promise<SessionTranscriptEntry | null> {
  try {
    const loaded = await storage.load(id);
    if (!loaded) {
      return null;
    }

    const lineage = loaded.lineage ?? createSessionLineage(loaded.messages);
    const notice = createClientNoticeEntry(lineage, options);
    const nextLineage: KodaXSessionLineage = {
      ...lineage,
      entries: [...lineage.entries, notice],
    };
    const nextData: SessionData = {
      ...loaded,
      lineage: nextLineage,
      messages: loaded.messages,
    };

    await storage.appendSessionDelta(id, nextData);
    const activeIds = collectActiveIds(nextLineage);
    return toTranscriptEntry(notice, activeIds, nextLineage.activeEntryId);
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
  // FEATURE_219 — kick off the one-shot migration so a watcher started before
  // any read/write still observes the per-project layout (fire-and-forget; the
  // recursive watcher / poll picks up the moved files as migration lands).
  void ensureLayoutMigrated(sessionsDir).catch(() => undefined);
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
      loadFullTranscript,
      appendClientNotice: (id, options) => appendClientNoticeWithStorage(id, options, storage),
      forkSession,
      rewindSession,
      setActiveEntry,
      deleteSession,
      archiveSession,
      unarchiveSession,
      listRunningSessions,
      watchSessions,
      // FEATURE_247 (R6): bind the manager's own storage so a manager-scoped
      // compact always uses the manager's directory (a caller-supplied
      // `storage`/`sessionsDir` cannot silently bypass the manager's isolation).
      compactSession: (id, o) => compactSession(id, { ...o, storage }),
      storage,
    };
  }
  return {
    listSessions: (o) => listSessionsImpl(o, sessionsDir),
    loadSession: (id) => loadSessionImpl(id, sessionsDir),
    loadFullTranscript: (id) => loadFullTranscriptImpl(id, sessionsDir),
    appendClientNotice: (id, options) => appendClientNoticeWithStorage(id, options, storage),
    forkSession: (id, o) => forkSessionImpl(id, o, sessionsDir),
    rewindSession: (id, o) => rewindSessionImpl(id, o, sessionsDir),
    setActiveEntry: (id, selector) => setActiveEntryImpl(id, selector, sessionsDir),
    deleteSession: (id) => deleteSessionImpl(id, sessionsDir),
    archiveSession: (id) => archiveSessionImpl(id, sessionsDir),
    unarchiveSession: (id) => unarchiveSessionImpl(id, sessionsDir),
    listRunningSessions,
    watchSessions: (cb) => watchSessionsImpl(cb, sessionsDir),
    // FEATURE_247 (R6): bind the manager's sessionsDir-scoped storage so a
    // caller-supplied `storage` cannot bypass the manager's dir isolation.
    compactSession: (id, o) => compactSession(id, { ...o, storage }),
    storage,
  };
}
