import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';

import { getAgentConfigPath } from '../runtime/agent-home.js';
import { hashCwd, sanitizeProjectKey, tryGitRemote } from '../memory/paths.js';
import type {
  GovernedSkillSource,
  SkillOwnership,
  SkillWriteOrigin,
} from './types.js';

const LEDGER_VERSION = 1;

export type SkillUsageEvent =
  | 'view'
  | 'invoke'
  | 'patch_proposed'
  | 'patch_applied';

export interface SkillUsageRecord {
  readonly skillName: string;
  readonly source: GovernedSkillSource;
  readonly views: number;
  readonly invokes: number;
  readonly patchProposals: number;
  readonly patchApplies: number;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
}

export interface SkillUsageLedgerReadResult {
  readonly records: readonly SkillUsageRecord[];
  readonly warnings: readonly string[];
}

export interface SkillUsageEventInput {
  readonly skillName: string;
  readonly source: GovernedSkillSource;
  readonly event: SkillUsageEvent;
  readonly now?: () => string;
}

export type SkillUsageRecordResult =
  | {
      readonly recorded: true;
      readonly record: SkillUsageRecord;
      readonly warnings: readonly string[];
    }
  | {
      readonly recorded: false;
      readonly warnings: readonly string[];
    };

export type SkillTrustState =
  | 'provisional'
  | 'trusted'
  | 'quarantined'
  | 'archived';

export interface SkillTrustRecord {
  readonly skillName: string;
  readonly source: 'project' | 'user';
  readonly ownership: 'background_created';
  readonly state: SkillTrustState;
  readonly createdByAgent: true;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface SkillTrustLedgerReadResult {
  readonly records: readonly SkillTrustRecord[];
  readonly warnings: readonly string[];
}

export interface SkillTrustUpdateInput {
  readonly skillName: string;
  readonly source: GovernedSkillSource;
  readonly ownership: SkillOwnership;
  readonly origin: SkillWriteOrigin;
  readonly state: SkillTrustState;
  readonly pinned?: boolean;
  readonly reason?: string;
  readonly now?: () => string;
}

export type SkillTrustUpdateResult =
  | {
      readonly updated: true;
      readonly record: SkillTrustRecord;
    }
  | {
      readonly updated: false;
      readonly reason: string;
    };

interface UsageDocument {
  readonly version: 1;
  readonly records: readonly SkillUsageRecord[];
}

interface TrustDocument {
  readonly version: 1;
  readonly records: readonly SkillTrustRecord[];
}

function projectLearningPath(cwd: string, filename: string): string {
  const remote = tryGitRemote(cwd);
  const key = remote ? sanitizeProjectKey(remote) : `local-${hashCwd(cwd)}`;
  return getAgentConfigPath('projects', key, 'learning', filename);
}

export function resolveSkillUsageLedger(cwd: string): string {
  return projectLearningPath(cwd, 'skill-usage.json');
}

export function resolveSkillTrustLedger(cwd: string): string {
  return projectLearningPath(cwd, 'skill-trust.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGovernedSkillSource(value: unknown): value is GovernedSkillSource {
  return value === 'project'
    || value === 'user'
    || value === 'plugin'
    || value === 'builtin'
    || value === 'learned'
    || value === 'external';
}

function isSkillTrustState(value: unknown): value is SkillTrustState {
  return value === 'provisional'
    || value === 'trusted'
    || value === 'quarantined'
    || value === 'archived';
}

function isUsageRecord(value: unknown): value is SkillUsageRecord {
  return isRecord(value)
    && typeof value.skillName === 'string'
    && isGovernedSkillSource(value.source)
    && typeof value.views === 'number'
    && typeof value.invokes === 'number'
    && typeof value.patchProposals === 'number'
    && typeof value.patchApplies === 'number'
    && typeof value.firstEventAt === 'string'
    && typeof value.lastEventAt === 'string';
}

function isTrustRecord(value: unknown): value is SkillTrustRecord {
  return isRecord(value)
    && typeof value.skillName === 'string'
    && (value.source === 'project' || value.source === 'user')
    && value.ownership === 'background_created'
    && isSkillTrustState(value.state)
    && value.createdByAgent === true
    && typeof value.updatedAt === 'string'
    && (value.reason === undefined || typeof value.reason === 'string');
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.kodax-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readJsonDocument(filePath: string): Promise<{ readonly parsed?: unknown; readonly warnings: readonly string[] }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { warnings: [] };
    }
    throw error;
  }

  try {
    return { parsed: JSON.parse(raw) as unknown, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warnings: [`ledger is not valid JSON: ${message}`] };
  }
}

export async function readSkillUsageLedger(filePath: string): Promise<SkillUsageLedgerReadResult> {
  const read = await readJsonDocument(filePath);
  if (read.warnings.length > 0) {
    return { records: [], warnings: read.warnings };
  }
  if (read.parsed === undefined) {
    return { records: [], warnings: [] };
  }
  if (!isRecord(read.parsed) || read.parsed.version !== LEDGER_VERSION || !Array.isArray(read.parsed.records)) {
    return { records: [], warnings: ['skill usage ledger has unsupported shape'] };
  }
  const warnings: string[] = [];
  const records = read.parsed.records
    .map((entry, index) => {
      if (isUsageRecord(entry)) return entry;
      warnings.push(`usage record ${index} has invalid shape`);
      return undefined;
    })
    .filter((entry): entry is SkillUsageRecord => entry !== undefined);
  return { records, warnings };
}

export async function recordSkillUsage(
  filePath: string,
  input: SkillUsageEventInput,
): Promise<SkillUsageRecordResult> {
  try {
    const read = await readSkillUsageLedger(filePath);
    if (read.warnings.length > 0) {
      return { recorded: false, warnings: read.warnings };
    }

    const timestamp = (input.now ?? (() => new Date().toISOString()))();
    const existing = read.records.find((record) =>
      record.skillName === input.skillName && record.source === input.source,
    );
    const base: SkillUsageRecord = existing ?? {
      skillName: input.skillName,
      source: input.source,
      views: 0,
      invokes: 0,
      patchProposals: 0,
      patchApplies: 0,
      firstEventAt: timestamp,
      lastEventAt: timestamp,
    };
    const record: SkillUsageRecord = {
      ...base,
      views: base.views + (input.event === 'view' ? 1 : 0),
      invokes: base.invokes + (input.event === 'invoke' ? 1 : 0),
      patchProposals: base.patchProposals + (input.event === 'patch_proposed' ? 1 : 0),
      patchApplies: base.patchApplies + (input.event === 'patch_applied' ? 1 : 0),
      lastEventAt: timestamp,
    };
    const records = existing
      ? read.records.map((entry) =>
          entry.skillName === input.skillName && entry.source === input.source ? record : entry,
        )
      : [...read.records, record];
    const document: UsageDocument = { version: LEDGER_VERSION, records };
    await writeAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
    return { recorded: true, record, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { recorded: false, warnings: [`failed to record skill usage: ${message}`] };
  }
}

export async function readSkillTrustLedger(filePath: string): Promise<SkillTrustLedgerReadResult> {
  const read = await readJsonDocument(filePath);
  if (read.warnings.length > 0) {
    return { records: [], warnings: read.warnings };
  }
  if (read.parsed === undefined) {
    return { records: [], warnings: [] };
  }
  if (!isRecord(read.parsed) || read.parsed.version !== LEDGER_VERSION || !Array.isArray(read.parsed.records)) {
    return { records: [], warnings: ['skill trust ledger has unsupported shape'] };
  }
  const warnings: string[] = [];
  const records = read.parsed.records
    .map((entry, index) => {
      if (isTrustRecord(entry)) return entry;
      warnings.push(`trust record ${index} has invalid shape`);
      return undefined;
    })
    .filter((entry): entry is SkillTrustRecord => entry !== undefined);
  return { records, warnings };
}

export async function updateSkillTrustLedger(
  filePath: string,
  input: SkillTrustUpdateInput,
): Promise<SkillTrustUpdateResult> {
  if (input.source !== 'project' && input.source !== 'user') {
    return { updated: false, reason: 'only project or user skills can enter the F224 trust ledger' };
  }
  if (input.ownership !== 'background_created' || input.origin !== 'background_learning') {
    return { updated: false, reason: 'only background-created skills from background learning are curation-eligible' };
  }
  if (input.pinned && (input.state === 'quarantined' || input.state === 'archived')) {
    return { updated: false, reason: 'pinned skills cannot be quarantined or archived by F224' };
  }

  const read = await readSkillTrustLedger(filePath);
  if (read.warnings.length > 0) {
    return { updated: false, reason: `refusing to update corrupt trust ledger: ${read.warnings.join('; ')}` };
  }
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const record: SkillTrustRecord = {
    skillName: input.skillName,
    source: input.source,
    ownership: 'background_created',
    state: input.state,
    createdByAgent: true,
    updatedAt: timestamp,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  const records = read.records.some((entry) => entry.skillName === input.skillName && entry.source === input.source)
    ? read.records.map((entry) =>
        entry.skillName === input.skillName && entry.source === input.source ? record : entry,
      )
    : [...read.records, record];
  const document: TrustDocument = { version: LEDGER_VERSION, records };
  await writeAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
  return { updated: true, record };
}
