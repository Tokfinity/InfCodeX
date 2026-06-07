/**
 * KodaX session storage - filesystem implementation.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import type {
  KodaXExtensionSessionRecord,
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionScope,
  KodaXSessionStorage,
} from '@kodax-ai/coding';
import {
  appendSessionLineageLabel,
  archiveOldIslands,
  cleanupIncompleteToolCalls,
  countActiveLineageMessages,
  createSessionLineage,
  findPreviousUserEntryId,
  forkSessionLineage,
  generateSessionId,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from '@kodax-ai/coding';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
// `KODAX_SESSIONS_DIR` is a module-load-time-frozen constant (see
// `../common/utils.ts` JSDoc — v0.7.35.1 FEATURE_145). It is the default
// used when `FileSessionStorage` is constructed without an explicit
// `sessionsDir` override (v0.7.43 FEATURE_173 Part B follow-up).
// Substrate consumers that need the agent-config-home redirected via
// `setAgentConfigHome()` from `@kodax-ai/agent` MUST still call it
// BEFORE importing `@kodax-ai/repl`. SDK consumers that want a
// per-instance override should pass `{ sessionsDir }` to
// `createSessionManager()` instead.
import { getGitRoot, KODAX_SESSIONS_DIR } from '../common/utils.js';
import { inspectWorkspaceRuntime, isSameCanonicalRepo, resolveSessionRuntimeInfo } from './workspace-runtime.js';
import { deriveProjectKeyFromData, deriveProjectKeyFromRoot, type ProjectIdentity } from './project-key.js';
import {
  isKodaXExtensionSessionRecord,
  isKodaXExtensionSessionState,
  isKodaXJsonValue,
  isKodaXMessage,
  isKodaXSessionUiHistory,
  isRecord,
  isSessionErrorMetadata,
} from './json-guards.js';

interface PersistedExtensionRecordLine extends KodaXExtensionSessionRecord {
  _type: 'extension_record';
}

interface PersistedLineageEntryLine {
  _type: 'lineage_entry';
  entry: KodaXSessionEntry;
}

interface PersistedArtifactLedgerLine {
  _type: 'artifact_ledger_entry';
  entry: KodaXSessionArtifactLedgerEntry;
}

interface PersistedMetaUpdateLine {
  _type: 'meta_update';
  title?: string;
  activeEntryId?: string | null;
  activeMessageCount?: number;
  uiHistory?: KodaXSessionMeta['uiHistory'];
  scope?: string;
}

function isPersistedMetaUpdateLine(value: unknown): value is PersistedMetaUpdateLine {
  if (!isRecord(value) || value._type !== 'meta_update') {
    return false;
  }
  return (value.title === undefined || typeof value.title === 'string')
    && (value.activeEntryId === undefined || typeof value.activeEntryId === 'string' || value.activeEntryId === null)
    && (value.activeMessageCount === undefined || typeof value.activeMessageCount === 'number')
    && (value.uiHistory === undefined || isKodaXSessionUiHistory(value.uiHistory))
    && (value.scope === undefined || typeof value.scope === 'string');
}

interface PersistedSessionSnapshot {
  meta?: KodaXSessionMeta;
  legacyMessages: KodaXMessage[];
  lineageEntries: KodaXSessionEntry[];
  artifactLedger: KodaXSessionArtifactLedgerEntry[];
  extensionRecords: KodaXExtensionSessionRecord[];
  malformedCount: number;
}

interface ResolvedSessionSnapshot {
  data: SessionData;
  createdAt?: string;
}

function warnMalformedSessionData(filePath: string, count: number): void {
  if (count === 0 || process.env.NODE_ENV === 'test') {
    return;
  }

  process.stderr.write(
    `[KodaX] Skipped ${count} malformed session record(s) from ${path.basename(filePath)}.\n`,
  );
}

function writeStorageNotice(message: string): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  process.stderr.write(`${message}\n`);
}

function toExtensionRecordLine(
  record: KodaXExtensionSessionRecord,
): PersistedExtensionRecordLine {
  return {
    _type: 'extension_record',
    ...record,
  };
}

function toLineageEntryLine(entry: KodaXSessionEntry): PersistedLineageEntryLine {
  return {
    _type: 'lineage_entry',
    entry,
  };
}

function toArtifactLedgerLine(entry: KodaXSessionArtifactLedgerEntry): PersistedArtifactLedgerLine {
  return {
    _type: 'artifact_ledger_entry',
    entry,
  };
}

function isPersistedExtensionRecordLine(
  value: unknown,
): value is PersistedExtensionRecordLine {
  return isRecord(value)
    && value._type === 'extension_record'
    && isKodaXExtensionSessionRecord(value);
}

function hasEntryBase(value: unknown): value is { id: string; parentId: string | null; timestamp: string; type: string } {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string';
}

function isKodaXSessionEntry(value: unknown): value is KodaXSessionEntry {
  if (!hasEntryBase(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  switch (entry.type) {
    case 'message':
      return isKodaXMessage(entry.message);
    case 'compaction':
      return typeof entry.summary === 'string'
        && (entry.firstKeptEntryId === undefined || typeof entry.firstKeptEntryId === 'string')
        && (entry.tokensBefore === undefined || typeof entry.tokensBefore === 'number');
    case 'branch_summary':
      return typeof entry.summary === 'string'
        && (entry.fromId === undefined || typeof entry.fromId === 'string')
        && (entry.details === undefined || isKodaXJsonValue(entry.details));
    case 'label':
      return typeof entry.targetId === 'string'
        && (entry.label === undefined || typeof entry.label === 'string');
    case 'archive_marker':
      return typeof entry.archiveBatchId === 'string'
        && typeof entry.archivedEntryCount === 'number'
        && typeof entry.summary === 'string';
    default:
      return false;
  }
}

function isPersistedLineageEntryLine(
  value: unknown,
): value is PersistedLineageEntryLine {
  return isRecord(value)
    && value._type === 'lineage_entry'
    && isKodaXSessionEntry(value.entry);
}

function isKodaXSessionArtifactLedgerEntry(
  value: unknown,
): value is KodaXSessionArtifactLedgerEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.target === 'string'
    && typeof value.timestamp === 'string'
    && (value.sourceTool === undefined || typeof value.sourceTool === 'string')
    && (value.action === undefined || typeof value.action === 'string')
    && (value.displayTarget === undefined || typeof value.displayTarget === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.sessionEntryId === undefined || typeof value.sessionEntryId === 'string')
    && (value.metadata === undefined || isKodaXJsonValue(value.metadata));
}

function isPersistedArtifactLedgerLine(
  value: unknown,
): value is PersistedArtifactLedgerLine {
  return isRecord(value)
    && value._type === 'artifact_ledger_entry'
    && isKodaXSessionArtifactLedgerEntry(value.entry);
}

function isKodaXSessionRuntimeInfo(value: unknown): value is KodaXSessionRuntimeInfo {
  return isRecord(value)
    && (value.canonicalRepoRoot === undefined || typeof value.canonicalRepoRoot === 'string')
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string')
    && (value.executionCwd === undefined || typeof value.executionCwd === 'string')
    && (value.branch === undefined || typeof value.branch === 'string')
    && (
      value.workspaceKind === undefined
      || value.workspaceKind === 'detected'
      || value.workspaceKind === 'managed'
    );
}

/**
 * v0.7.38 FEATURE_157 — Windows-aware path equality for session-list
 * gating. Windows filesystem paths are case-insensitive (NTFS / ReFS
 * fold case on lookup) and node sometimes returns the drive letter in
 * different case across processes (`C:\...` from one PowerShell, `c:\...`
 * from a VS Code-spawned shell). The session-list filter at line ~880
 * compares `sessionGitRoot === currentGitRoot` literally; a case
 * mismatch on the drive letter wipes the entire prior-session list,
 * leaving `kodax -c` / `kodax -r` with nothing to resume — which
 * surfaces as "the previous conversation seems lost, agent answered
 * from scratch".
 *
 * Reproduction (2026-05-11 user report): session
 * `20260511_110542.jsonl` saved with
 * `gitRoot: "C:/Works/GitWorks/KodaX-author/KodaX"`. Subsequent
 * `kodax -c` produced session `20260511_130217.jsonl` rooted from a
 * shell where `getGitRoot()` returned the drive letter lowercased,
 * the list filter excluded all four prior same-repo sessions, and
 * the new session was created fresh without resume context.
 *
 * POSIX behaviour unchanged: literal string equality preserves
 * case-sensitive semantics where the filesystem is case-sensitive.
 */
function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function getLastNavigableEntryId(entries: KodaXSessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.type !== 'label') {
      return entry.id;
    }
  }
  return null;
}

function buildLineage(
  snapshot: PersistedSessionSnapshot,
): KodaXSessionLineage | undefined {
  if (snapshot.lineageEntries.length > 0) {
    return {
      version: 2,
      activeEntryId: snapshot.meta?.activeEntryId ?? getLastNavigableEntryId(snapshot.lineageEntries),
      entries: snapshot.lineageEntries,
    };
  }

  if (snapshot.legacyMessages.length === 0) {
    return undefined;
  }

  return createSessionLineage(snapshot.legacyMessages);
}

function serializeMessageContentForCompare(content: KodaXMessage['content']): string {
  return typeof content === 'string' ? `t:${content}` : `j:${JSON.stringify(content)}`;
}

function sameMessageByContent(left: KodaXMessage, right: KodaXMessage): boolean {
  if (left === right) {
    return true;
  }
  return left.role === right.role
    && serializeMessageContentForCompare(left.content) === serializeMessageContentForCompare(right.content);
}

/**
 * FEATURE_173 no-regress guard.
 *
 * Resolve the lineage a snapshot `save()` should persist. The runner's
 * `saveSessionSnapshot` writes flat messages with NO lineage; rebuilding via
 * `createSessionLineage(messages, existing)` keeps every existing entry but
 * sets `activeEntryId` from the message walk. When the snapshot's messages
 * are a PREFIX of the persisted active path (a stale / subset view — exactly
 * what a delayed runner save carries), that walk regresses `activeEntryId`
 * to an earlier round, so resume only replays up to that point ("resume only
 * loads the first round"). In that case the snapshot has nothing new to
 * contribute, so reuse the persisted lineage verbatim — the active pointer
 * never moves backward.
 *
 * An EMPTY message set is treated the same as a prefix — it carries nothing
 * new, so the persisted lineage is reused verbatim. This guards the
 * error-recovery save path (`runner-driven.ts:419` passes `messages: []`
 * when no in-flight messages were recovered): rebuilding via
 * `createSessionLineage([], existing)` would reset `activeEntryId` to null
 * and make resume load an empty conversation, while the errorMetadata that
 * the caller DOES want persisted still lands via the merge.
 *
 * A caller-supplied lineage (the REPL's authoritative `context.lineage`) is
 * always honoured. Divergent / extending message sets reconcile normally,
 * so legitimate new rounds and headless single-writer saves are unaffected.
 * Rewind / fork / setActiveEntry never reach here — they own dedicated
 * methods that set `activeEntryId` explicitly.
 */
function resolveSnapshotLineage(
  data: SessionData,
  existingLineage: KodaXSessionLineage | undefined,
): KodaXSessionLineage {
  if (data.lineage) {
    return data.lineage;
  }
  if (existingLineage) {
    const activeMessages = getSessionMessagesFromLineage(existingLineage);
    const messages = data.messages;
    // Empty or prefix-of-active → the snapshot adds nothing; keep the
    // persisted lineage so `activeEntryId` never regresses (incl. to null).
    const carriesNothingNew =
      messages.length <= activeMessages.length
      && messages.every((message, index) => sameMessageByContent(message, activeMessages[index]!));
    if (carriesNothingNew) {
      return existingLineage;
    }
  }
  return createSessionLineage(data.messages, existingLineage);
}

function buildSessionData(snapshot: PersistedSessionSnapshot): ResolvedSessionSnapshot {
  const lineage = buildLineage(snapshot);
  return {
    createdAt: snapshot.meta?.createdAt,
      data: {
        messages: lineage
          ? getSessionMessagesFromLineage(lineage)
          : [...snapshot.legacyMessages],
        title: snapshot.meta?.title ?? '',
        gitRoot: snapshot.meta?.gitRoot ?? '',
        runtimeInfo: isKodaXSessionRuntimeInfo(snapshot.meta?.runtimeInfo)
          ? { ...snapshot.meta.runtimeInfo }
          : undefined,
        scope: snapshot.meta?.scope ?? 'user',
        uiHistory: isKodaXSessionUiHistory(snapshot.meta?.uiHistory)
          ? snapshot.meta.uiHistory.map((item) => ({ ...item }))
          : undefined,
        errorMetadata: isSessionErrorMetadata(snapshot.meta?.errorMetadata)
          ? { ...snapshot.meta!.errorMetadata }
          : undefined,
      extensionState: isKodaXExtensionSessionState(snapshot.meta?.extensionState)
        ? snapshot.meta?.extensionState
        : undefined,
      extensionRecords: snapshot.extensionRecords.map((record) => ({ ...record })),
      lineage,
      artifactLedger: snapshot.artifactLedger.map((entry) => ({
        ...entry,
        metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
      })),
    },
  };
}

function createSessionMeta(
  id: string,
  data: SessionData,
  lineage: KodaXSessionLineage | undefined,
  createdAt?: string,
): KodaXSessionMeta {
  return {
    _type: 'meta',
    title: data.title,
    id,
    gitRoot: data.gitRoot,
    runtimeInfo: data.runtimeInfo ? { ...data.runtimeInfo } : undefined,
    createdAt: createdAt ?? new Date().toISOString(),
    scope: data.scope ?? 'user',
    uiHistory: data.uiHistory,
    errorMetadata: data.errorMetadata,
    extensionState: data.extensionState,
    extensionRecordCount: data.extensionRecords?.length ?? 0,
    artifactLedgerCount: data.artifactLedger?.length ?? 0,
    lineageVersion: lineage?.version,
    activeEntryId: lineage?.activeEntryId,
    lineageEntryCount: lineage?.entries.length ?? 0,
    activeMessageCount: lineage ? countActiveLineageMessages(lineage) : data.messages.length,
  };
}

async function readPersistedSessionFile(filePath: string): Promise<PersistedSessionSnapshot | null> {
  // Read directly and treat a missing file as "no session" rather than doing a
  // separate `existsSync` precheck — the precheck was TOCTOU-racy: a concurrent
  // deletion (another window, or opt-in session retention cleanup) between the
  // check and the read would surface as an uncaught ENOENT crash instead of a
  // graceful null. `load()` already treats null as "session not found".
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const trimmedContent = rawContent.trim();
  if (!trimmedContent) {
    return null;
  }

  const snapshot: PersistedSessionSnapshot = {
    legacyMessages: [],
    lineageEntries: [],
    artifactLedger: [],
    extensionRecords: [],
    malformedCount: 0,
  };

  const lines = trimmedContent.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const parsed = JSON.parse(lines[index]!);
      if (index === 0 && isRecord(parsed) && parsed._type === 'meta') {
        snapshot.meta = parsed as unknown as KodaXSessionMeta;
        continue;
      }

      // meta_update: white-list merge into existing meta (append-only hot path support)
      if (isPersistedMetaUpdateLine(parsed)) {
        if (snapshot.meta) {
          if (parsed.title !== undefined) snapshot.meta.title = parsed.title;
          if (parsed.activeEntryId !== undefined) snapshot.meta.activeEntryId = parsed.activeEntryId;
          if (parsed.activeMessageCount !== undefined) snapshot.meta.activeMessageCount = parsed.activeMessageCount;
          if (parsed.uiHistory !== undefined) snapshot.meta.uiHistory = parsed.uiHistory;
          if (parsed.scope !== undefined) snapshot.meta.scope = parsed.scope as KodaXSessionScope;
        }
        continue;
      }

      if (isPersistedLineageEntryLine(parsed)) {
        snapshot.lineageEntries.push(parsed.entry);
        continue;
      }

      if (isPersistedArtifactLedgerLine(parsed)) {
        snapshot.artifactLedger.push(parsed.entry);
        continue;
      }

      if (isPersistedExtensionRecordLine(parsed)) {
        snapshot.extensionRecords.push({
          id: parsed.id,
          extensionId: parsed.extensionId,
          type: parsed.type,
          ts: parsed.ts,
          data: parsed.data,
          dedupeKey: parsed.dedupeKey,
        });
        continue;
      }

      if (isKodaXMessage(parsed)) {
        snapshot.legacyMessages.push(parsed);
        continue;
      }

      snapshot.malformedCount += 1;
    } catch {
      snapshot.malformedCount += 1;
    }
  }

  return snapshot;
}

// Session-list scale fix (modeled on claudecode `sessionStoragePortable.ts`):
// `list()` only needs the `meta` first line of each session, but historically
// `fs.readFile`'d the WHOLE file (a 24MB archive or 6MB transcript) just to read
// line 1 + count lines. On a large sessions dir (hundreds of files / hundreds of
// MB) that turned `kodax -c` + the session picker into a multi-second blocking
// read. We now read only the first chunk via a single fd. The whole-file read is
// kept ONLY as a fallback for the rare cases that genuinely need it (a first line
// longer than the buffer, or a legacy non-`meta` session whose msgCount is the
// total line count).
const SESSION_HEAD_READ_BYTES = 65536;

async function readSessionFirstLine(filePath: string): Promise<string | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(SESSION_HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SESSION_HEAD_READ_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }
    const head = buf.toString('utf8', 0, bytesRead);
    const newlineIdx = head.indexOf('\n');
    if (newlineIdx >= 0) {
      return head.slice(0, newlineIdx).trim();
    }
    // First line longer than the read buffer (pathological — meta lines are
    // normally < a few KB). Fall back to a full read so we never silently drop
    // an otherwise-valid session from the list.
    const full = await fs.readFile(filePath, 'utf-8');
    const fullNewline = full.indexOf('\n');
    return (fullNewline >= 0 ? full.slice(0, fullNewline) : full).trim();
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function countSessionLines(filePath: string): Promise<number> {
  try {
    const content = (await fs.readFile(filePath, 'utf-8')).trim();
    if (!content) {
      return 0;
    }
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

export class FileSessionStorage implements KodaXSessionStorage {
  // v0.7.43 (FEATURE_173 Part B follow-up) — optional per-instance
  // override of the sessions directory. Defaults to the
  // module-load-time-frozen KODAX_SESSIONS_DIR so existing single-process
  // callers see no behavior change. Constructed by `createSessionManager`
  // to let SDK consumers point at an isolated sessions root without
  // mutating the agent-config-home singleton.
  private readonly sessionsDir: string;

  /**
   * v0.7.46 — optional explicit project cwd for in-process embedders
   * (KodaX Space) serving multiple projects from a single runtime.
   * Threaded through `getGitRoot(this.hostCwd)` and `inspectWorkspaceRuntime({cwd: this.hostCwd})`
   * so the workspace-mismatch check in `load()` compares against the
   * project the embedder opened, NOT the embedder's startup directory.
   * When set, mismatch warnings are also suppressed (the embedder is
   * authoritative about project scope; the CLI-mode warning is noise).
   * Unset → all paths behave identically to the pre-v0.7.46 form.
   */
  private readonly hostCwd?: string;

  constructor(opts?: { sessionsDir?: string; cwd?: string }) {
    this.sessionsDir = opts?.sessionsDir ?? KODAX_SESSIONS_DIR;
    this.hostCwd = opts?.cwd;
  }

  // ── Session-level write serialization ──
  // All writes (append / cold save / maintenance) for the same session are
  // serialized through a per-session promise chain.  State reads, delta
  // computation, and writes all happen inside the queued callback.
  private writeQueues = new Map<string, Promise<void>>();

  private serializedWrite(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, () => fn());
    this.writeQueues.set(id, next);
    return next;
  }

  // ── Append watermarks ──
  // Tracks how many entries have been written to disk per session.
  // When the count matches the in-memory lineage, only new entries are appended.
  // On process restart the cache is empty → first save falls back to full write.
  // load() initializes the watermark so subsequent appends don't need fallback.
  private appendState = new Map<string, {
    lineageCount: number;
    artifactCount: number;
    extensionCount: number;
    metaUpdateCount: number;
  }>();

  // ── FEATURE_219 per-project directory cache ──
  // Pins a session id to the absolute project directory it lives in for this
  // process, so repeated writes for one id never drift between folders even
  // if the in-memory runtimeInfo changes between saves. Populated on read
  // (via resolveSessionLocation) and on write (via resolveWriteDir).
  private sessionDirCache = new Map<string, string>();
  private projectJsonWritten = new Set<string>();

  /** Update watermarks. Only overwrites fields the caller actually provided. */
  private syncAppendState(id: string, data: SessionData, metaUpdateCount?: number): void {
    const prev = this.appendState.get(id);
    this.appendState.set(id, {
      lineageCount: data.lineage?.entries.length ?? prev?.lineageCount ?? 0,
      artifactCount: data.artifactLedger?.length ?? prev?.artifactCount ?? 0,
      extensionCount: data.extensionRecords?.length ?? prev?.extensionCount ?? 0,
      metaUpdateCount: metaUpdateCount ?? prev?.metaUpdateCount ?? 0,
    });
  }

  // ── FEATURE_219 path resolution ──
  // Legacy flat paths (pre-FEATURE_219 layout) are still read as a fallback
  // and lazily superseded on the next write.
  private legacyFlatPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  private legacyFlatArchivePath(id: string): string {
    return path.join(this.sessionsDir, `${id}.archive.jsonl`);
  }

  private projectDir(key: string): string {
    return path.join(this.sessionsDir, key);
  }

  /** Resolve (and cache) the project directory a write for `id` should land in. */
  private resolveWriteDir(id: string, data: SessionData): string {
    const cached = this.sessionDirCache.get(id);
    if (cached) {
      return cached;
    }
    const identity = deriveProjectKeyFromData(data);
    const dir = this.projectDir(identity.key);
    this.sessionDirCache.set(id, dir);
    return dir;
  }

  private writeFilePath(id: string, data: SessionData): string {
    return path.join(this.resolveWriteDir(id, data), `${id}.jsonl`);
  }

  /**
   * id-only locator (ADR-038 §7). Resolution order:
   *   1. cached project dir for this id
   *   2. bounded scan of project dirs:  <key>/<id>.jsonl
   *   3. bounded scan of archived:      <key>/archived/<id>.jsonl
   *   4. legacy flat:                   <sessionsDir>/<id>.jsonl
   * On multiple matches (only possible for pre-FEATURE_219 same-second
   * duplicate ids) it prefers the current process's project dir, else
   * returns null with a warning rather than guessing.
   */
  private async resolveSessionLocation(id: string): Promise<string | null> {
    const cached = this.sessionDirCache.get(id);
    if (cached) {
      const cachedPath = path.join(cached, `${id}.jsonl`);
      if (fsSync.existsSync(cachedPath)) {
        return cachedPath;
      }
      const cachedArchived = path.join(cached, 'archived', `${id}.jsonl`);
      if (fsSync.existsSync(cachedArchived)) {
        return cachedArchived;
      }
    }

    const matches: string[] = [];
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const inProject = path.join(this.sessionsDir, entry.name, `${id}.jsonl`);
      if (fsSync.existsSync(inProject)) {
        matches.push(inProject);
      }
      const inArchived = path.join(this.sessionsDir, entry.name, 'archived', `${id}.jsonl`);
      if (fsSync.existsSync(inArchived)) {
        matches.push(inArchived);
      }
    }

    if (matches.length === 0) {
      const flat = this.legacyFlatPath(id);
      return fsSync.existsSync(flat) ? flat : null;
    }
    if (matches.length === 1) {
      this.sessionDirCache.set(id, path.dirname(matches[0]!).replace(/[/\\]archived$/, ''));
      return matches[0]!;
    }
    // Ambiguous (legacy same-second duplicate ids across projects).
    const currentDir = this.projectDir(deriveProjectKeyFromRoot(this.hostCwd ?? process.cwd()).key);
    const preferred = matches.find((m) => path.dirname(m) === currentDir);
    if (preferred) {
      return preferred;
    }
    writeStorageNotice(
      `[KodaX] Ambiguous session id ${id} found in ${matches.length} projects; specify projectKey to disambiguate.`,
    );
    return null;
  }

  private async readSession(id: string): Promise<ResolvedSessionSnapshot | null> {
    const filePath = await this.resolveSessionLocation(id);
    if (!filePath) {
      return null;
    }
    const snapshot = await readPersistedSessionFile(filePath);
    if (!snapshot) {
      return null;
    }

    warnMalformedSessionData(filePath, snapshot.malformedCount);
    return buildSessionData(snapshot);
  }

  /** Write `<dir>/project.json` once per process per directory (best-effort). */
  private async ensureProjectJson(dir: string, identity: ProjectIdentity): Promise<void> {
    if (identity.canonicalRoot === null || this.projectJsonWritten.has(dir)) {
      return;
    }
    this.projectJsonWritten.add(dir);
    const manifestPath = path.join(dir, 'project.json');
    try {
      const payload = JSON.stringify({
        canonicalRoot: identity.canonicalRoot,
        displayName: identity.displayName,
        lastUsed: new Date().toISOString(),
      });
      await fs.writeFile(manifestPath, payload + '\n', 'utf-8');
    } catch {
      // best-effort — manifest is an optimization, not a correctness requirement
    }
  }

  // ── Phase 2: Streaming write (no join) ──
  // Writes one JSONL line at a time via file handle, eliminating the giant
  // concatenated string that the old join('\n') approach produced.
  private async writeSessionInternal(
    id: string,
    data: SessionData,
    createdAt?: string,
  ): Promise<void> {
    const dir = this.resolveWriteDir(id, data);
    await fs.mkdir(dir, { recursive: true });

    const targetPath = path.join(dir, `${id}.jsonl`);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const lineage = data.lineage ?? createSessionLineage(data.messages);
    const meta = createSessionMeta(id, data, lineage, createdAt);

    try {
      const handle = await fs.open(tempPath, 'w');
      try {
        await handle.write(JSON.stringify(meta) + '\n');
        for (const entry of lineage.entries) {
          await handle.write(JSON.stringify(toLineageEntryLine(entry)) + '\n');
        }
        for (const entry of (data.artifactLedger ?? [])) {
          await handle.write(JSON.stringify(toArtifactLedgerLine(entry)) + '\n');
        }
        for (const record of (data.extensionRecords ?? [])) {
          await handle.write(JSON.stringify(toExtensionRecordLine(record)) + '\n');
        }
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, targetPath);
      await this.ensureProjectJson(dir, deriveProjectKeyFromData(data));
      // Lazy migrate-on-write: a legacy flat copy is now superseded by the
      // per-project file. Remove it (and relocate its sidecar) so the locator
      // never sees the same id in two places.
      const legacy = this.legacyFlatPath(id);
      if (legacy !== targetPath && fsSync.existsSync(legacy)) {
        await fs.unlink(legacy).catch(() => undefined);
        const legacyArchive = this.legacyFlatArchivePath(id);
        if (fsSync.existsSync(legacyArchive)) {
          await fs.rename(legacyArchive, path.join(dir, `${id}.archive.jsonl`)).catch(() => undefined);
        }
      }
    } finally {
      if (fsSync.existsSync(tempPath)) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }
  }

  // ── Merge helper ──
  // Reads existing session, merges omitted fields (extensionState, runtimeInfo,
  // etc.), then does a full streamed write. Used by both save() and
  // appendSessionDelta fallback so that partially-populated data from
  // InkREPL.persistContextState never overwrites already-persisted fields.
  private async mergeAndWriteInternal(id: string, data: SessionData): Promise<void> {
    const existing = await this.readSession(id);
    const merged: SessionData = {
      ...data,
      scope: data.scope ?? existing?.data.scope ?? 'user',
      uiHistory: data.uiHistory ?? existing?.data.uiHistory,
      extensionState: data.extensionState ?? existing?.data.extensionState,
      artifactLedger: data.artifactLedger ?? existing?.data.artifactLedger,
      extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
      runtimeInfo: data.runtimeInfo ?? existing?.data.runtimeInfo,
      errorMetadata: data.errorMetadata ?? existing?.data.errorMetadata,
      // FEATURE_173 no-regress guard — a lineage-less snapshot whose messages
      // are a prefix of the persisted active path reuses the existing lineage
      // instead of regressing `activeEntryId` (the dual-writer corruption).
      lineage: resolveSnapshotLineage(data, existing?.data.lineage),
    };
    await this.writeSessionInternal(id, merged, existing?.createdAt);
    this.syncAppendState(id, merged);
  }

  // ── Phase 1: Append-only hot path ──
  // Only appends new entries + a meta_update line.  O(1) cost regardless of
  // total session size.  Falls back to full mergeAndWriteInternal when:
  //   - No cached watermark (process restart before load())
  //   - No file on disk (new session)
  //   - No lineage provided by caller
  //   - Watermark inconsistency (rewind/fork occurred)
  async appendSessionDelta(id: string, data: SessionData): Promise<void> {
    const filePath = this.writeFilePath(id, data);

    // Pre-checks that don't need serialization. A session still living in the
    // legacy flat pool (no per-project file yet) takes the save() path, which
    // writes to the project dir and supersedes the flat copy.
    if (!fsSync.existsSync(filePath) || !data.lineage) {
      await this.save(id, data);
      return;
    }

    await this.serializedWrite(id, async () => {
      // Read latest watermark INSIDE the queue (not before entry)
      const cached = this.appendState.get(id);

      // No watermark → fallback
      if (!cached) {
        await this.mergeAndWriteInternal(id, data);
        return;
      }

      // Consistency: snapshot shrunk since last write → rewind/fork → fallback
      if (
        data.lineage!.entries.length < cached.lineageCount
        || (data.artifactLedger?.length ?? 0) < cached.artifactCount
      ) {
        await this.mergeAndWriteInternal(id, data);
        return;
      }

      // Compute delta
      const newLineage = data.lineage!.entries.slice(cached.lineageCount);
      const newArtifacts = (data.artifactLedger ?? []).slice(cached.artifactCount);
      const newExtensions = (data.extensionRecords ?? []).slice(cached.extensionCount);

      const parts: string[] = [];
      for (const entry of newLineage) {
        parts.push(JSON.stringify(toLineageEntryLine(entry)));
      }
      for (const entry of newArtifacts) {
        parts.push(JSON.stringify(toArtifactLedgerLine(entry)));
      }
      for (const record of newExtensions) {
        parts.push(JSON.stringify(toExtensionRecordLine(record)));
      }

      // meta_update: only include fields the caller actually provided
      const metaUpdate: PersistedMetaUpdateLine = {
        _type: 'meta_update',
        title: data.title,
        activeEntryId: data.lineage!.activeEntryId,
        activeMessageCount: countActiveLineageMessages(data.lineage!),
        ...(data.uiHistory !== undefined ? { uiHistory: data.uiHistory } : {}),
        ...(data.scope !== undefined ? { scope: data.scope } : {}),
      };
      parts.push(JSON.stringify(metaUpdate));

      if (parts.length > 0) {
        await fs.appendFile(filePath, '\n' + parts.join('\n'), 'utf-8');
      }

      // Update watermark inside the queue
      this.syncAppendState(id, data, cached.metaUpdateCount + 1);
    });

    // Async maintenance (also goes through serializedWrite, won't race with append)
    const state = this.appendState.get(id);
    if (state && this.shouldRunMaintenance(state)) {
      this.runMaintenance(id).catch((err) => {
        if (process.env.NODE_ENV !== 'test') {
          process.stderr.write(`[KodaX] Archive maintenance failed: ${String(err)}\n`);
        }
      });
    }
  }

  // ── Phase 3: Maintenance ──
  private shouldRunMaintenance(state: { metaUpdateCount: number; lineageCount: number }): boolean {
    if (state.metaUpdateCount >= 50) return true;
    if (state.lineageCount > 500) return true;
    return false;
  }

  private async runMaintenance(id: string): Promise<void> {
    await this.serializedWrite(id, async () => {
      // Re-read current session inside the queue (not a stale snapshot)
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const { slimmedLineage, archivedEntries, archiveBatchId } = archiveOldIslands(resolved.data.lineage);
      if (archivedEntries.length === 0) {
        // Nothing to archive, but still rewrite to merge meta_updates
        await this.writeSessionInternal(id, resolved.data, resolved.createdAt);
        this.syncAppendState(id, resolved.data, 0);
        return;
      }

      // Write sidecar (streaming append — no join) into the same project dir.
      const archiveDir = this.resolveWriteDir(id, resolved.data);
      await fs.mkdir(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, `${id}.archive.jsonl`);
      const archiveHandle = await fs.open(archivePath, 'a');
      try {
        await archiveHandle.write(JSON.stringify({
          _type: 'archive_batch',
          archiveBatchId,
          sessionId: id,
          archivedAt: new Date().toISOString(),
          entryCount: archivedEntries.length,
        }) + '\n');
        for (const entry of archivedEntries) {
          await archiveHandle.write(JSON.stringify({
            _type: 'archived_entry',
            archiveBatchId,
            entry,
          }) + '\n');
        }
      } finally {
        await archiveHandle.close();
      }

      // Full streamed rewrite of main session with slimmed lineage
      const cleanedData: SessionData = { ...resolved.data, lineage: slimmedLineage };
      await this.writeSessionInternal(id, cleanedData, resolved.createdAt);
      this.syncAppendState(id, cleanedData, 0);
    });
  }

  // ── Public API ──

  async save(id: string, data: SessionData): Promise<void> {
    await this.serializedWrite(id, async () => {
      await this.mergeAndWriteInternal(id, data);
    });
  }

  async load(id: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id);
    if (!resolved) {
      return null;
    }

    // Initialize append watermark so subsequent appendSessionDelta calls
    // don't need to fallback to full rewrite.
    this.syncAppendState(id, resolved.data);

    const { data, createdAt } = resolved;
    // Label only — used by the no-op `warnMalformedSessionData(filePath, 0)`
    // call below (count 0 returns early). The actual file was already located
    // by `readSession` via the id-only locator.
    const filePath = this.legacyFlatPath(id);

    // v0.7.46 fix — thread `this.hostCwd` so in-process embedders compare
    // against the project they actually opened, not the embedder
    // process's startup directory. With this, an embedder serving
    // multiple projects no longer gets false-positive workspace-mismatch
    // warnings (and the embedder-supplied scope is authoritative;
    // we also suppress the warning entirely when `hostCwd` is set —
    // the CLI-mode "you cd'd into a different repo than the session
    // belongs to" semantics don't apply to a programmatic SDK consumer).
    const currentGitRoot = await getGitRoot(this.hostCwd);
    const currentRuntime = await inspectWorkspaceRuntime({ cwd: this.hostCwd });
    const sessionRuntime = resolveSessionRuntimeInfo(data);
    const canonicalMismatch =
      currentRuntime.canonicalRepoRoot
      && sessionRuntime?.canonicalRepoRoot
      && !isSameCanonicalRepo(currentRuntime, sessionRuntime);

    const shouldEmitMismatchWarning = !this.hostCwd && (canonicalMismatch || (
      currentGitRoot && data.gitRoot && currentGitRoot !== data.gitRoot && !isSameCanonicalRepo(
        currentRuntime,
        { canonicalRepoRoot: data.gitRoot },
      )
    ));

    if (shouldEmitMismatchWarning) {
      writeStorageNotice(chalk.yellow('\n[Warning] Session project mismatch:'));
      if (currentRuntime.workspaceRoot) {
        writeStorageNotice(`  Current workspace:  ${currentRuntime.workspaceRoot}`);
      }
      if (sessionRuntime?.workspaceRoot) {
        writeStorageNotice(`  Session workspace:  ${sessionRuntime.workspaceRoot}`);
      }
      if (currentRuntime.canonicalRepoRoot) {
        writeStorageNotice(`  Current repo:      ${currentRuntime.canonicalRepoRoot}`);
      }
      if (sessionRuntime?.canonicalRepoRoot) {
        writeStorageNotice(`  Session repo:      ${sessionRuntime.canonicalRepoRoot}`);
      } else if (data.gitRoot) {
        writeStorageNotice(`  Session repo:      ${data.gitRoot}`);
      }
      writeStorageNotice('  Continuing anyway...\n');
    }

    if (data.errorMetadata?.consecutiveErrors && data.errorMetadata.consecutiveErrors > 0) {
      const cleaned = cleanupIncompleteToolCalls(data.messages);
      if (cleaned !== data.messages) {
        writeStorageNotice(chalk.cyan('[Session Recovery] Cleaned incomplete tool calls from previous session'));
        const recovered: SessionData = {
          ...data,
          messages: cleaned,
          errorMetadata: {
            ...data.errorMetadata,
            consecutiveErrors: 0,
          },
          lineage: createSessionLineage(cleaned, data.lineage),
        };
        await this.serializedWrite(id, async () => {
          await this.writeSessionInternal(id, recovered, createdAt);
          this.syncAppendState(id, recovered);
        });
        return recovered;
      }
    }

    warnMalformedSessionData(filePath, 0);
    return data;
  }

  async getLineage(id: string): Promise<KodaXSessionLineage | null> {
    const resolved = await this.readSession(id);
    return resolved?.data.lineage ?? null;
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: { summarizeCurrentBranch?: boolean },
  ): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = setSessionLineageActiveEntry(
        resolved.data.lineage,
        selector,
        options,
      );
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        messages: getSessionMessagesFromLineage(lineage),
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async rewind(id: string, selector?: string): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const targetId = selector ?? findPreviousUserEntryId(resolved.data.lineage);
      if (!targetId) return;

      const lineage = rewindSessionLineage(resolved.data.lineage, targetId);
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        messages: getSessionMessagesFromLineage(lineage),
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async setLabel(id: string, selector: string, label?: string): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = appendSessionLineageLabel(resolved.data.lineage, selector, label);
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null> {
    let result: { sessionId: string; data: SessionData } | null = null;
    // Serialize on the SOURCE session (the one being read)
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = forkSessionLineage(resolved.data.lineage, selector);
      if (!lineage) return;

      const sessionId = options?.sessionId ?? await generateSessionId();
      const forked: SessionData = {
        messages: getSessionMessagesFromLineage(lineage),
        title: options?.title ?? resolved.data.title,
        gitRoot: resolved.data.gitRoot,
        uiHistory: resolved.data.uiHistory
          ? resolved.data.uiHistory.map((item) => ({ ...item }))
          : undefined,
        extensionState: resolved.data.extensionState
          ? structuredClone(resolved.data.extensionState)
          : undefined,
        artifactLedger: resolved.data.artifactLedger
          ? structuredClone(resolved.data.artifactLedger)
          : undefined,
        extensionRecords: resolved.data.extensionRecords
          ? structuredClone(resolved.data.extensionRecords)
          : undefined,
        lineage,
      };
      // Fork writes to a NEW session id — serialize on that id too
      await this.writeSessionInternal(sessionId, forked);
      result = { sessionId, data: forked };
    });
    return result;
  }

  /**
   * v0.7.46 — `opts.limit` added so SDK consumers can request more than
   * the legacy 10-entry cap. Default stays at 10 to preserve the
   * interactive REPL picker's behavior. The `public-api.ts` fast path
   * forwards the caller's `limit`; `deleteAll()` passes a large value
   * so it can enumerate ALL sessions for the gitRoot.
   *
   * v0.7.46 — return now carries `createdAt` so the fast path in
   * `public-api.ts` no longer silently strips it. Pre-v0.7.46 callers
   * that only destructured `{id, title, msgCount, runtimeInfo}` are
   * unaffected (extra fields are ignored).
   */
  async list(
    gitRoot?: string,
    opts?: { limit?: number },
  ): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    runtimeInfo?: KodaXSessionRuntimeInfo;
    createdAt?: string;
  }>> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot(this.hostCwd);
    const currentRuntime = await inspectWorkspaceRuntime({
      cwd: currentGitRoot ?? this.hostCwd ?? process.cwd(),
    });
    // FEATURE_219 — candidate files come from the CURRENT project's directory
    // (O(sessions-in-project), the whole point of the per-project layout) plus
    // the legacy flat pool (compat until auto-migration empties it). When there
    // is no resolvable project root (rootless `kodax -c`), fall back to scanning
    // every project dir so the "show me everything" behavior is preserved.
    // Exclude `.archive.jsonl` island sidecars and the `archived/` subdir.
    const topEntries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    // `trusted` files live in the resolved current-project dir — the folder key
    // IS the canonical identity, so they skip the per-file canonical match
    // filter below (which could otherwise hide a correctly-placed session on a
    // stored-runtimeInfo quirk). Flat-pool files are untrusted and still filter.
    const candidatePaths: Array<{ path: string; trusted: boolean }> = [];
    const currentProjectKey = deriveProjectKeyFromData({
      gitRoot: currentGitRoot ?? undefined,
      runtimeInfo: currentRuntime,
    }).key;
    const projectDirNames = currentGitRoot
      ? [currentProjectKey]
      : topEntries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    for (const key of projectDirNames) {
      let dirFiles: string[] = [];
      try {
        dirFiles = await fs.readdir(this.projectDir(key));
      } catch {
        continue;
      }
      for (const f of dirFiles) {
        if (f.endsWith('.jsonl') && !f.endsWith('.archive.jsonl')) {
          candidatePaths.push({ path: path.join(this.projectDir(key), f), trusted: Boolean(currentGitRoot) });
        }
      }
    }
    for (const e of topEntries) {
      if (
        e.isFile() &&
        e.name.endsWith('.jsonl') &&
        !e.name.endsWith('.archive.jsonl') &&
        !e.name.startsWith('archived-')
      ) {
        candidatePaths.push({ path: path.join(this.sessionsDir, e.name), trusted: false });
      }
    }

    const sessions: Array<{
      id: string;
      title: string;
      msgCount: number;
      createdAt?: string;
      runtimeInfo?: KodaXSessionRuntimeInfo;
    }> = [];

    type SessionEntry = (typeof sessions)[number];
    const parseSessionFile = async (filePath: string, trusted: boolean): Promise<SessionEntry | null> => {
      try {
        const firstLine = await readSessionFirstLine(filePath);
        if (!firstLine) {
          return null;
        }

        const first = JSON.parse(firstLine);
        if (isRecord(first) && first._type === 'meta') {
          const sessionGitRoot = typeof first.gitRoot === 'string' ? first.gitRoot : '';
          const sessionRuntime = isKodaXSessionRuntimeInfo(first.runtimeInfo)
            ? first.runtimeInfo
            : undefined;
          const scope: KodaXSessionScope = first.scope === 'managed-task-worker'
            ? 'managed-task-worker'
            : 'user';
          if (currentGitRoot && !trusted) {
            const sameCanonicalRepo = isSameCanonicalRepo(currentRuntime, sessionRuntime);
            // FEATURE_157: Windows-aware comparison (case-insensitive on
            // win32/darwin) — see `pathsEqual` JSDoc for the resume-loss
            // failure shape this guards against. Branching preserved
            // identical to the pre-FEATURE_157 logic: workspace branch
            // when sessionRuntime carries workspaceRoot, gitRoot
            // otherwise — only the equality operator changes.
            const sameWorkspace = sessionRuntime?.workspaceRoot
              ? pathsEqual(sessionRuntime.workspaceRoot, currentRuntime.workspaceRoot ?? '')
              : pathsEqual(sessionGitRoot, currentGitRoot);
            if (!sameCanonicalRepo && !sameWorkspace) {
              return null;
            }
          }
          if (scope !== 'user') {
            return null;
          }

          const extensionRecordCount =
            typeof first.extensionRecordCount === 'number' && first.extensionRecordCount > 0
              ? first.extensionRecordCount
              : 0;
          // `activeMessageCount` (present on modern meta records) lets us avoid
          // reading the whole file. Only legacy meta records without it need a
          // full line count — rare, and these tend to be small/old sessions.
          const activeMessageCount =
            typeof first.activeMessageCount === 'number' && first.activeMessageCount >= 0
              ? first.activeMessageCount
              : Math.max(0, (await countSessionLines(filePath)) - 1 - extensionRecordCount);
          return {
            id: path.basename(filePath, '.jsonl'),
            title: typeof first.title === 'string' ? first.title : '',
            msgCount: activeMessageCount,
            createdAt: typeof first.createdAt === 'string' ? first.createdAt : undefined,
            // v0.7.46 fix — fall back to `sessionGitRoot` when the meta
            // record predates the nested `runtimeInfo` field. Without
            // this, legacy meta records returned `runtimeInfo:
            // undefined` even though `gitRoot` was right there at the
            // top level — the in-process embedder bug Space reported.
            //
            // Wrapped as `{ canonicalRepoRoot }` (NOT `{ gitRoot }`)
            // because `KodaXSessionRuntimeInfo` uses canonicalRepoRoot
            // as the project-identity field — verified semantic match
            // in storage.ts:842 (`isSameCanonicalRepo(...,
            // { canonicalRepoRoot: data.gitRoot })`) and in
            // session/public-api.ts:234 where `extractRuntimeInfoSummary`
            // remaps `canonicalRepoRoot → gitRoot` on the consumer side.
            runtimeInfo: sessionRuntime
              ? { ...sessionRuntime }
              : sessionGitRoot
                ? { canonicalRepoRoot: sessionGitRoot }
                : undefined,
          };
        }
        const lineCount = await countSessionLines(filePath);
        return { id: path.basename(filePath, '.jsonl'), title: '', msgCount: lineCount };
      } catch {
        return null;
      }
    };

    // Head-read every candidate concurrently (bounded so we never exhaust fds
    // on a large sessions dir). Project-dir paths are listed before flat paths,
    // so on a duplicate id (a session mid-migration) the project-dir copy wins.
    const LIST_READ_CONCURRENCY = 48;
    const seenIds = new Set<string>();
    for (let i = 0; i < candidatePaths.length; i += LIST_READ_CONCURRENCY) {
      const batch = await Promise.all(
        candidatePaths.slice(i, i + LIST_READ_CONCURRENCY).map((c) => parseSessionFile(c.path, c.trusted)),
      );
      for (const entry of batch) {
        if (entry && !seenIds.has(entry.id)) {
          seenIds.add(entry.id);
          sessions.push(entry);
        }
      }
    }

    // v0.7.46 — `opts.limit` overrides the legacy 10-entry hard cap.
    // Default stays at 10 so the interactive REPL picker keeps its
    // existing behavior; SDK consumers pass an explicit limit.
    const limit = opts?.limit ?? 10;
    return sessions
      .sort((left, right) => {
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        if (Number.isFinite(rightTime) && !Number.isFinite(leftTime)) {
          return 1;
        }
        if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) {
          return -1;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(0, limit)
      // v0.7.46 — surface `createdAt` so the public-api fast path can
      // populate `SessionSummary.createdAt` instead of silently
      // emitting `undefined` (previously every fast-path summary had
      // createdAt=undefined → consumer UIs sorting by date got
      // random order).
      .map(({ id, title, msgCount, runtimeInfo, createdAt }) => (
        runtimeInfo
          ? { id, title, msgCount, runtimeInfo, createdAt }
          : { id, title, msgCount, createdAt }
      ));
  }

  async delete(id: string): Promise<void> {
    // Locate the session anywhere (project dir / archived / legacy flat), then
    // remove it together with its island sidecar (paired — never orphan a
    // sidecar, ADR-038 §4). Also sweep a legacy flat copy if one lingers.
    const located = await this.resolveSessionLocation(id);
    const targets = new Set<string>();
    if (located) {
      targets.add(located);
      targets.add(located.replace(/\.jsonl$/, '.archive.jsonl'));
      targets.add(located.replace(/\.jsonl$/, '.islands.jsonl'));
    }
    targets.add(this.legacyFlatPath(id));
    targets.add(this.legacyFlatArchivePath(id));
    for (const target of targets) {
      if (fsSync.existsSync(target)) {
        await fs.unlink(target).catch(() => undefined);
      }
    }
    this.sessionDirCache.delete(id);
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    const currentGitRoot = gitRoot ?? await getGitRoot(this.hostCwd);
    // v0.7.46 fix — bypass the legacy 10-entry cap so "delete all
    // sessions for this project" actually deletes ALL of them. Pre-fix
    // `deleteAll()` silently leaked any session beyond the 10 most
    // recent because it reused `list()`'s default cap.
    const sessions = await this.list(currentGitRoot ?? undefined, {
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const session of sessions) {
      await this.delete(session.id);
    }
  }

  /**
   * Auto-retention: delete session files (`.jsonl` + `.archive.jsonl`) whose
   * mtime is older than `retentionDays`. Modeled on claudecode's
   * `cleanup.ts` (`unlinkIfOld`). Bounds the sessions directory so it never
   * accumulates unboundedly — which is what keeps `list()`'s head-read pass
   * fast (its cost scales with file COUNT, not size). A non-positive /
   * non-finite `retentionDays` disables cleanup (no-op). Best-effort: per-file
   * errors are swallowed so a single locked/racing file never aborts the
   * sweep. Returns the number of files removed. mtime-based, so the session
   * currently being written/resumed (fresh mtime) is never eligible.
   */
  async cleanupOldSessions(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }
    let removed = 0;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const unlinkIfOld = async (filePath: string): Promise<void> => {
      if (!filePath.endsWith('.jsonl')) {
        return;
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffMs) {
          await fs.unlink(filePath);
          removed++;
        }
      } catch {
        // ignore — locked/racing file
      }
    };
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      // FEATURE_219 — sweep the flat pool (legacy), every project dir, and each
      // project's `archived/` subdir. One level of recursion is enough; the
      // layout is never deeper than `<key>/archived/<id>.jsonl`.
      const top = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      for (const entry of top) {
        const entryPath = path.join(this.sessionsDir, entry.name);
        if (entry.isFile()) {
          await unlinkIfOld(entryPath);
          continue;
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }
        let inner: import('fs').Dirent[] = [];
        try {
          inner = await fs.readdir(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of inner) {
          const childPath = path.join(entryPath, child.name);
          if (child.isFile()) {
            await unlinkIfOld(childPath);
          } else if (child.isDirectory() && child.name === 'archived') {
            let archived: string[] = [];
            try {
              archived = await fs.readdir(childPath);
            } catch {
              continue;
            }
            for (const f of archived) {
              await unlinkIfOld(path.join(childPath, f));
            }
          }
        }
      }
    } catch {
      // best-effort — never block startup on cleanup
    }
    return removed;
  }
}
