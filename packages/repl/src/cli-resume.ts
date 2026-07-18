import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureLayoutMigrated } from './interactive/session-migration.js';
import {
  runSessionPicker,
  type SessionPickerItem,
  type SessionPickerRunOptions,
} from './ui/SessionPicker.js';

const SESSION_HEAD_READ_BYTES = 65536;
const SESSION_READ_CONCURRENCY = 48;

interface PersistedRuntimeSummary {
  readonly canonicalRepoRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
}

interface ResumeCandidate extends SessionPickerItem {
  readonly createdAtMs?: number;
}

export interface ListCliResumeSessionsOptions {
  readonly projectRoot: string;
  readonly sessionsDir?: string;
  readonly limit?: number;
}

function defaultSessionsDir(): string {
  const envHome = process.env.KODAX_HOME;
  const configHome = envHome && envHome.length > 0
    ? envHome
    : path.join(os.homedir(), '.kodax');
  return path.join(configHome, 'sessions');
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.');
}

async function collectActiveSessionFiles(sessionsDir: string): Promise<string[]> {
  const files: string[] = [];
  let top: import('node:fs').Dirent[];
  try {
    top = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of top) {
    const entryPath = path.join(sessionsDir, entry.name);
    if (entry.isFile() && isSessionFile(entry.name) && !entry.name.startsWith('archived-')) {
      files.push(entryPath);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'archived') continue;
    try {
      for (const child of await fs.readdir(entryPath, { withFileTypes: true })) {
        if (child.isFile() && isSessionFile(child.name)) {
          files.push(path.join(entryPath, child.name));
        }
      }
    } catch {
      // A concurrently removed or unreadable project directory is skipped.
    }
  }
  return files;
}

function normalizeComparableRoot(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function matchesProjectRoot(meta: Record<string, unknown>, projectRoot: string): boolean {
  const target = normalizeComparableRoot(projectRoot);
  if (!target) return true;
  const runtime = meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
    ? meta.runtimeInfo as Record<string, unknown>
    : undefined;
  const candidates = [
    typeof runtime?.canonicalRepoRoot === 'string' ? runtime.canonicalRepoRoot : undefined,
    typeof runtime?.workspaceRoot === 'string' ? runtime.workspaceRoot : undefined,
    typeof meta.gitRoot === 'string' ? meta.gitRoot : undefined,
  ];
  return candidates.some((candidate) => normalizeComparableRoot(candidate) === target);
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(SESSION_HEAD_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SESSION_HEAD_READ_BYTES, 0);
    if (bytesRead === 0) return undefined;
    const head = buffer.toString('utf8', 0, bytesRead);
    const newline = head.indexOf('\n');
    if (newline >= 0) return head.slice(0, newline).trim();
    const full = await fs.readFile(filePath, 'utf8');
    const fullNewline = full.indexOf('\n');
    return (fullNewline >= 0 ? full.slice(0, fullNewline) : full).trim();
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readMessageCount(filePath: string, meta: Record<string, unknown>): Promise<number> {
  if (typeof meta.activeMessageCount === 'number' && meta.activeMessageCount >= 0) {
    return meta.activeMessageCount;
  }
  const content = (await fs.readFile(filePath, 'utf8')).trim();
  if (!content) return 0;
  const extensionRecords = typeof meta.extensionRecordCount === 'number' && meta.extensionRecordCount > 0
    ? meta.extensionRecordCount
    : 0;
  return Math.max(0, content.split('\n').length - 1 - extensionRecords);
}

function runtimeSummary(meta: Record<string, unknown>): PersistedRuntimeSummary | undefined {
  if (meta.runtimeInfo === null || typeof meta.runtimeInfo !== 'object') return undefined;
  const runtime = meta.runtimeInfo as Record<string, unknown>;
  return {
    ...(typeof runtime.canonicalRepoRoot === 'string' ? { canonicalRepoRoot: runtime.canonicalRepoRoot } : {}),
    ...(typeof runtime.workspaceRoot === 'string' ? { workspaceRoot: runtime.workspaceRoot } : {}),
    ...(typeof runtime.surface === 'string' ? { surface: runtime.surface } : {}),
  };
}

async function readResumeCandidate(
  filePath: string,
  projectRoot: string,
): Promise<ResumeCandidate | undefined> {
  try {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) return undefined;
    const parsed: unknown = JSON.parse(firstLine);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const meta = parsed as Record<string, unknown>;
    if (meta._type !== 'meta' || meta.scope === 'managed-task-worker') return undefined;
    if (!matchesProjectRoot(meta, projectRoot)) return undefined;
    const msgCount = await readMessageCount(filePath, meta);
    if (msgCount <= 0) return undefined;
    const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;
    const runtime = runtimeSummary(meta);
    return {
      id: path.basename(filePath, '.jsonl'),
      title: typeof meta.title === 'string' ? meta.title : '',
      msgCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(runtime?.surface !== undefined ? { surface: runtime.surface } : {}),
      ...(createdAt !== undefined ? { createdAtMs: Date.parse(createdAt) } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function listCliResumeSessions(
  options: ListCliResumeSessionsOptions,
): Promise<SessionPickerItem[]> {
  try {
    const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
    await ensureLayoutMigrated(sessionsDir);
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePaths = await collectActiveSessionFiles(sessionsDir);
    const candidates: ResumeCandidate[] = [];
    const seenIds = new Set<string>();
    for (let index = 0; index < filePaths.length; index += SESSION_READ_CONCURRENCY) {
      const batch = await Promise.all(filePaths
        .slice(index, index + SESSION_READ_CONCURRENCY)
        .map((filePath) => readResumeCandidate(filePath, options.projectRoot)));
      for (const candidate of batch) {
        if (candidate && !seenIds.has(candidate.id)) {
          seenIds.add(candidate.id);
          candidates.push(candidate);
        }
      }
    }
    candidates.sort((left, right) => {
      if (Number.isFinite(left.createdAtMs) && Number.isFinite(right.createdAtMs)
          && left.createdAtMs !== right.createdAtMs) {
        return (right.createdAtMs as number) - (left.createdAtMs as number);
      }
      if (Number.isFinite(right.createdAtMs) && !Number.isFinite(left.createdAtMs)) return 1;
      if (Number.isFinite(left.createdAtMs) && !Number.isFinite(right.createdAtMs)) return -1;
      return right.id.localeCompare(left.id);
    });
    return candidates.slice(0, options.limit ?? 1000).map(({ createdAtMs: _createdAtMs, ...item }) => item);
  } catch {
    return [];
  }
}

export async function runCliResumePicker(
  sessions: readonly SessionPickerItem[],
  options: SessionPickerRunOptions = {},
): Promise<SessionPickerItem | undefined> {
  return runSessionPicker(sessions, options);
}

export type {
  SessionPickerItem,
  SessionPickerRunOptions,
} from './ui/SessionPicker.js';
