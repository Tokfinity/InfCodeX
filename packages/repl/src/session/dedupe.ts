import fs from 'node:fs/promises';
import path from 'node:path';

import { KODAX_SESSIONS_DIR } from '../common/utils.js';
import { ensureLayoutMigrated } from '../interactive/session-migration.js';

export type SessionDedupeSkipReason =
  | 'managed-task-worker'
  | 'unreadable'
  | 'no-match'
  | 'ambiguous-match'
  | 'move-failed';

export interface SessionDedupeOptions {
  sessionsDir?: string;
  apply?: boolean;
  now?: Date;
}

export interface SessionDedupeMatch {
  runnerId: string;
  runnerPath: string;
  canonicalId: string;
  canonicalPath: string;
  score: number;
  reasons: string[];
}

export interface SessionDedupeMove {
  runnerId: string;
  from: string;
  to: string;
}

export interface SessionDedupeSkip {
  runnerId: string;
  path: string;
  reason: SessionDedupeSkipReason;
  detail?: string;
}

export interface SessionDedupeReport {
  scanned: number;
  runnerCandidates: number;
  matches: SessionDedupeMatch[];
  moved: SessionDedupeMove[];
  skipped: SessionDedupeSkip[];
  archiveDir?: string;
}

interface SessionMetaCandidate {
  id: string;
  filePath: string;
  relativePath: string;
  projectKey?: string;
  isRunner: boolean;
  title: string;
  gitRoot: string;
  runtimeRoot?: string;
  createdAtMs?: number;
  scope: 'user' | 'managed-task-worker';
  activeMessageCount?: number;
  hasHostState: boolean;
}

interface ScoredMatch {
  canonical: SessionMetaCandidate;
  score: number;
  reasons: string[];
}

const MIN_MATCH_SCORE = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.')
    && !name.startsWith('archived-');
}

async function collectSessionFiles(sessionsDir: string): Promise<string[]> {
  const out: string[] = [];
  let topEntries: import('node:fs').Dirent[] = [];
  try {
    topEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of topEntries) {
    if (entry.isFile()) {
      if (isSessionFile(entry.name)) {
        out.push(path.join(sessionsDir, entry.name));
      }
      continue;
    }

    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const projectDir = path.join(sessionsDir, entry.name);
    let projectFiles: string[] = [];
    try {
      projectFiles = await fs.readdir(projectDir);
    } catch {
      continue;
    }

    for (const fileName of projectFiles) {
      if (isSessionFile(fileName)) {
        out.push(path.join(projectDir, fileName));
      }
    }
  }

  return out;
}

function getProjectKey(sessionsDir: string, filePath: string): string | undefined {
  const relative = path.relative(sessionsDir, filePath);
  const parts = relative.split(path.sep);
  return parts.length > 1 ? parts[0] : undefined;
}

async function parseCandidate(
  sessionsDir: string,
  filePath: string,
): Promise<SessionMetaCandidate | null> {
  const relativePath = path.relative(sessionsDir, filePath);
  const basename = path.basename(filePath, '.jsonl');
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const firstLine = content.split(/\r?\n/, 1)[0];
    if (!firstLine) {
      return null;
    }
    const parsed: unknown = JSON.parse(firstLine);
    if (!isRecord(parsed) || parsed._type !== 'meta') {
      return null;
    }

    const runtimeInfo = isRecord(parsed.runtimeInfo) ? parsed.runtimeInfo : undefined;
    const runtimeRoot = typeof runtimeInfo?.canonicalRepoRoot === 'string'
      ? runtimeInfo.canonicalRepoRoot
      : typeof runtimeInfo?.workspaceRoot === 'string'
        ? runtimeInfo.workspaceRoot
        : undefined;
    const createdAtMs = typeof parsed.createdAt === 'string'
      ? Date.parse(parsed.createdAt)
      : Number.NaN;
    const uiHistory = Array.isArray(parsed.uiHistory) ? parsed.uiHistory : undefined;
    const artifactLedgerCount =
      typeof parsed.artifactLedgerCount === 'number' ? parsed.artifactLedgerCount : 0;
    const hasActiveEntry = typeof parsed.activeEntryId === 'string' || parsed.activeEntryId === null;

    return {
      id: typeof parsed.id === 'string' ? parsed.id : basename,
      filePath,
      relativePath,
      projectKey: getProjectKey(sessionsDir, filePath),
      isRunner: basename.startsWith('runner-'),
      title: typeof parsed.title === 'string' ? parsed.title : '',
      gitRoot: typeof parsed.gitRoot === 'string' ? parsed.gitRoot : '',
      runtimeRoot,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
      scope: parsed.scope === 'managed-task-worker' ? 'managed-task-worker' : 'user',
      activeMessageCount: typeof parsed.activeMessageCount === 'number'
        ? parsed.activeMessageCount
        : undefined,
      hasHostState: Boolean(
        (uiHistory && uiHistory.length > 0)
        || parsed.lineageVersion === 2
        || hasActiveEntry
        || artifactLedgerCount > 0,
      ),
    };
  } catch {
    return null;
  }
}

function sameProject(left: SessionMetaCandidate, right: SessionMetaCandidate): boolean {
  if (left.projectKey && right.projectKey && left.projectKey === right.projectKey) {
    return true;
  }
  if (left.runtimeRoot && right.runtimeRoot && left.runtimeRoot === right.runtimeRoot) {
    return true;
  }
  return Boolean(left.gitRoot && right.gitRoot && left.gitRoot === right.gitRoot);
}

function scoreCandidate(
  runner: SessionMetaCandidate,
  canonical: SessionMetaCandidate,
): ScoredMatch | null {
  if (canonical.isRunner || canonical.scope !== 'user' || !sameProject(runner, canonical)) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  if (runner.projectKey && canonical.projectKey && runner.projectKey === canonical.projectKey) {
    score += 4;
    reasons.push('same-project-dir');
  } else {
    score += 3;
    reasons.push('same-project-identity');
  }

  if (runner.title && canonical.title && runner.title === canonical.title) {
    score += 2;
    reasons.push('same-title');
  } else if (runner.title && canonical.title) {
    return null;
  }

  if (
    runner.activeMessageCount !== undefined
    && canonical.activeMessageCount !== undefined
    && runner.activeMessageCount === canonical.activeMessageCount
  ) {
    score += 1;
    reasons.push('same-active-message-count');
  }

  if (runner.createdAtMs !== undefined && canonical.createdAtMs !== undefined) {
    const diffMs = Math.abs(runner.createdAtMs - canonical.createdAtMs);
    if (diffMs <= 60 * 60 * 1000) {
      score += 1;
      reasons.push('near-created-at');
    }
  }

  if (canonical.hasHostState && !runner.hasHostState) {
    score += 2;
    reasons.push('canonical-has-host-state');
  }

  return score >= MIN_MATCH_SCORE ? { canonical, score, reasons } : null;
}

function formatArchiveBatch(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

async function uniqueTargetPath(targetPath: string): Promise<string> {
  let candidate = targetPath;
  let suffix = 1;
  while (true) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    const ext = path.extname(targetPath);
    const base = targetPath.slice(0, targetPath.length - ext.length);
    candidate = `${base}.${suffix}${ext}`;
    suffix += 1;
  }
}

export async function dedupeSessions(
  options: SessionDedupeOptions = {},
): Promise<SessionDedupeReport> {
  const sessionsDir = options.sessionsDir ?? KODAX_SESSIONS_DIR;
  if (options.apply) {
    await fs.mkdir(sessionsDir, { recursive: true });
    await ensureLayoutMigrated(sessionsDir);
  }

  const filePaths = await collectSessionFiles(sessionsDir);
  const candidates: SessionMetaCandidate[] = [];
  const skipped: SessionDedupeSkip[] = [];

  for (const filePath of filePaths) {
    const parsed = await parseCandidate(sessionsDir, filePath);
    if (!parsed) {
      if (path.basename(filePath).startsWith('runner-')) {
        skipped.push({
          runnerId: path.basename(filePath, '.jsonl'),
          path: filePath,
          reason: 'unreadable',
        });
      }
      continue;
    }

    if (parsed.isRunner && parsed.scope === 'managed-task-worker') {
      skipped.push({
        runnerId: parsed.id,
        path: parsed.filePath,
        reason: 'managed-task-worker',
      });
      continue;
    }

    candidates.push(parsed);
  }

  const runnerCandidates = candidates.filter((candidate) =>
    candidate.isRunner && candidate.scope === 'user'
  );
  const canonicalCandidates = candidates.filter((candidate) =>
    !candidate.isRunner && candidate.scope === 'user'
  );
  const matches: SessionDedupeMatch[] = [];

  for (const runner of runnerCandidates) {
    const scored = canonicalCandidates
      .map((canonical) => scoreCandidate(runner, canonical))
      .filter((match): match is ScoredMatch => match !== null)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      skipped.push({
        runnerId: runner.id,
        path: runner.filePath,
        reason: 'no-match',
      });
      continue;
    }

    if (scored.length > 1) {
      skipped.push({
        runnerId: runner.id,
        path: runner.filePath,
        reason: 'ambiguous-match',
        detail: scored.map((match) => `${match.canonical.id}:${match.score}`).join(', '),
      });
      continue;
    }

    const best = scored[0]!;
    matches.push({
      runnerId: runner.id,
      runnerPath: runner.filePath,
      canonicalId: best.canonical.id,
      canonicalPath: best.canonical.filePath,
      score: best.score,
      reasons: best.reasons,
    });
  }

  const moved: SessionDedupeMove[] = [];
  const archiveDir = path.join(
    sessionsDir,
    '.dedupe-archive',
    formatArchiveBatch(options.now ?? new Date()),
  );

  if (options.apply) {
    for (const match of matches) {
      const relativePath = path.relative(sessionsDir, match.runnerPath);
      let targetPath: string | undefined;
      try {
        targetPath = await uniqueTargetPath(path.join(archiveDir, relativePath));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(match.runnerPath, targetPath);
        moved.push({
          runnerId: match.runnerId,
          from: match.runnerPath,
          to: targetPath,
        });
      } catch (error) {
        skipped.push({
          runnerId: match.runnerId,
          path: match.runnerPath,
          reason: 'move-failed',
          detail: `target=${targetPath ?? path.join(archiveDir, relativePath)}; ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }

  return {
    scanned: filePaths.length,
    runnerCandidates: runnerCandidates.length,
    matches,
    moved,
    skipped,
    ...(options.apply ? { archiveDir } : {}),
  };
}
