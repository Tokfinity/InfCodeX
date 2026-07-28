import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  LearnedCapabilityRecordV1,
  LearnedCapabilityScope,
} from './center-types.js';
import { slugifyLearnedCapabilityName } from './center-types.js';
import { LearnedAreaStore } from './learned-area-store.js';

const MARKER = '.legacy-skill-import-v1.json';
const MAX_IMPORT_BYTES = 16 * 1024;
const UNSAFE_LEGACY = [
  /!\s*`/i,
  /\b(?:allowed-tools|hooks|context|agent|model)\s*:/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|rk)-[a-z0-9_-]{24,}\b/i,
] as const;

export interface LegacyLearnedSkillMigrationResult {
  readonly migratedActive: number;
  readonly recordedAttention: number;
  readonly alreadyComplete: boolean;
}

/**
 * One-time compatibility bridge from F266's loose global learned/skills tree.
 * V1 records have no trusted historical content fingerprint. All loose
 * artifacts therefore become non-loadable Ready/attention instead of being
 * trusted from their current mutable bytes.
 */
export async function migrateLegacyLearnedSkillsForProject(
  configHome: string,
  projectStore: LearnedAreaStore,
  scope: LearnedCapabilityScope,
): Promise<LegacyLearnedSkillMigrationResult> {
  const markerPath = join(projectStore.paths.root, MARKER);
  return projectStore.withOwnerMutation(async () => {
    if (await fileExists(markerPath)) {
      return { migratedActive: 0, recordedAttention: 0, alreadyComplete: true };
    }
    const legacyRoot = join(resolve(configHome), 'learned');
    const looseRoot = join(legacyRoot, 'skills');
    const legacyRecords = (await new LearnedAreaStore(legacyRoot).listCapabilities())
      .filter((record): record is LearnedCapabilityRecordV1 => record.schemaVersion === 1);
    const migratedActive = 0;
    let recordedAttention = 0;
    for (const directory of await directDirectories(looseRoot)) {
      const skillFile = join(looseRoot, directory, 'SKILL.md');
      const content = await safeLegacyContent(join(looseRoot, directory), skillFile);
      const matched = legacyRecords.find((record) => legacyRecordMatches(
        record,
        directory,
        skillFile,
      ));
      const fingerprint = content === undefined ? undefined : sha256(content);
      const record = attentionLegacyRecord(
        scope,
        directory,
        matched,
        fingerprint,
      );
      if (await projectStore.readCapability(record.capabilityId) === undefined) {
        await projectStore.writeCapability(record);
        await projectStore.ensureCurrentEvent(record);
        recordedAttention += 1;
      }
    }
    await writeImmutableJson(markerPath, {
      version: 1,
      migratedActive,
      recordedAttention,
      completedAt: new Date().toISOString(),
    });
    return { migratedActive, recordedAttention, alreadyComplete: false };
  });
}

function attentionLegacyRecord(
  scope: LearnedCapabilityScope,
  directory: string,
  legacy: LearnedCapabilityRecordV1 | undefined,
  fingerprint: string | undefined,
): LearnedCapabilityRecordV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    capabilityId: legacyCapabilityId(scope, `attention:${directory}`),
    displayName: legacy?.displayName ?? directory,
    slug: slugifyLearnedCapabilityName(legacy?.slug ?? directory),
    carrier: 'skill',
    lifecycle: 'ready',
    revision: 1,
    createdAt: legacy?.createdAt ?? now,
    updatedAt: now,
    source: { kind: 'legacy_manual' },
    artifactPath: join('legacy-loose', directory, 'SKILL.md'),
    diagnostics: [
      fingerprint === undefined
        ? 'legacy loose Skill failed the regular-file/content safety gate and was not activated'
        : 'legacy v1 Skill had no trusted historical fingerprint and was not activated',
    ],
  };
}

async function safeLegacyContent(
  directory: string,
  skillFile: string,
): Promise<string | undefined> {
  try {
    const dirInfo = await lstat(directory);
    const fileInfo = await lstat(skillFile);
    if (!dirInfo.isDirectory()
      || dirInfo.isSymbolicLink()
      || !fileInfo.isFile()
      || fileInfo.isSymbolicLink()) return undefined;
    const entries = await readdir(directory);
    if (entries.some((entry) => entry !== 'SKILL.md')) return undefined;
    const content = await readFile(skillFile, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES
      || UNSAFE_LEGACY.some((pattern) => pattern.test(content))) return undefined;
    return content;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function legacyRecordMatches(
  record: LearnedCapabilityRecordV1,
  directory: string,
  skillFile: string,
): boolean {
  if (record.carrier !== 'skill') return false;
  const artifact = record.artifactPath;
  if (artifact === undefined) return record.slug === directory;
  const resolved = resolve(artifact);
  return resolved === resolve(skillFile)
    || resolved === resolve(skillFile, '..')
    || record.slug === directory;
}

function legacyCapabilityId(scope: LearnedCapabilityScope, name: string): string {
  return `lc_legacy_${sha256([
    scope.configHomeHash,
    scope.tenantHash,
    scope.projectHash,
    name,
  ].join('\0')).slice(0, 24)}`;
}

async function directDirectories(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
