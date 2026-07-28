import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  LearnedCapabilityRecord,
  LearningClientRecord,
  LearningEvent,
} from './center-types.js';
import {
  LearningCapabilityError,
  learningEventIdFor,
  learningEventKindForRecord,
} from './center-types.js';
import { withLearningFileLock } from './store-lock.js';

export interface LearnedAreaPaths {
  readonly root: string;
  readonly skills: string;
  readonly extensions: string;
  readonly capabilities: string;
  readonly events: string;
  readonly clients: string;
}

export function resolveLearnedAreaPaths(rootDir: string): LearnedAreaPaths {
  return {
    root: rootDir,
    skills: join(rootDir, 'skills'),
    extensions: join(rootDir, 'extensions'),
    capabilities: join(rootDir, 'capabilities'),
    events: join(rootDir, 'events'),
    clients: join(rootDir, 'clients'),
  };
}

function assertSafeFileKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new LearningCapabilityError('invalid_record', `${label} is not a safe file key`);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) {
      throw new LearningCapabilityError('store_integrity_error', `invalid JSON in ${filePath}`);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function assertCapability(value: unknown, filePath: string): LearnedCapabilityRecord {
  if (!isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.capabilityId !== 'string'
    || typeof value.displayName !== 'string'
    || typeof value.slug !== 'string'
    || typeof value.revision !== 'number'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.source)
    || (value.schemaVersion === 2 && !isValidV2Capability(value))) {
    throw new LearningCapabilityError('store_integrity_error', `invalid capability record in ${filePath}`);
  }
  return value as unknown as LearnedCapabilityRecord;
}

function isValidV2Capability(value: Record<string, unknown>): boolean {
  if (value.carrier !== 'skill'
    || !isRecord(value.scope)
    || !isRecord(value.artifact)
    || !isRecord(value.provenance)
    || !isRecord(value.canary)) return false;
  const scope = value.scope;
  const artifact = value.artifact;
  const provenance = value.provenance;
  const canary = value.canary;
  return [scope.configHomeHash, scope.tenantHash, scope.projectHash]
    .every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))
    && artifact.kind === 'skill_markdown'
    && typeof artifact.relativePath === 'string'
    && typeof artifact.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.fingerprint)
    && Number.isSafeInteger(artifact.contentRevision)
    && ['jobId', 'inputHash', 'decisionId', 'actionId']
      .every((key) => typeof provenance[key] === 'string')
    && canary.maxInvocations === 3
    && Number.isSafeInteger(canary.invocationCount)
    && Number.isSafeInteger(canary.verifiedSuccesses)
    && Number.isSafeInteger(canary.credibleNegatives)
    && (canary.binding === undefined || isValidCanaryBinding(canary.binding))
    && Array.isArray(canary.invocations)
    && canary.invocations.every(isValidCanaryInvocation);
}

function isValidCanaryBinding(value: unknown): boolean {
  return isRecord(value)
    && typeof value.bindingId === 'string'
    && typeof value.ownerSessionRef === 'string'
    && isValidTimestamp(value.expiresAt);
}

function isValidCanaryInvocation(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.invocationId !== 'string'
    || typeof value.bindingId !== 'string'
    || !['pending', 'verified_success', 'credible_negative', 'inconclusive']
      .includes(String(value.status))
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every((ref) => typeof ref === 'string')
    || !isValidTimestamp(value.invokedAt)
    || (value.usageSessionHash !== undefined
      && (typeof value.usageSessionHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.usageSessionHash)))
    || (value.artifactRevision !== undefined && !Number.isSafeInteger(value.artifactRevision))
    || (value.artifactFingerprint !== undefined
      && (typeof value.artifactFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.artifactFingerprint)))) {
    return false;
  }
  return value.status === 'pending'
    ? value.completedAt === undefined
    : isValidTimestamp(value.completedAt);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertEvent(value: unknown, filePath: string): LearningEvent {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.sequence !== 'number'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.eventId !== 'string'
    || typeof value.capabilityId !== 'string'
    || typeof value.capabilityRevision !== 'number') {
    throw new LearningCapabilityError('store_integrity_error', `invalid learning event in ${filePath}`);
  }
  return value as unknown as LearningEvent;
}

function assertClient(value: unknown, identity: string): LearningClientRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.clientIdentity !== identity
    || !isRecord(value.events)) {
    throw new LearningCapabilityError('store_integrity_error', `invalid learning client record for ${identity}`);
  }
  return value as unknown as LearningClientRecord;
}

async function listJsonFiles(dirPath: string): Promise<readonly string[]> {
  try {
    return (await readdir(dirPath))
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => join(dirPath, entry));
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
}

export class LearnedAreaStore {
  readonly paths: LearnedAreaPaths;
  readonly #globalRoot: string;

  constructor(rootDir: string) {
    const normalizedRoot = resolve(rootDir);
    this.#globalRoot = globalLearnedAreaRoot(normalizedRoot);
    this.paths = {
      ...resolveLearnedAreaPaths(normalizedRoot),
      events: join(this.#globalRoot, 'events'),
      clients: join(this.#globalRoot, 'clients'),
    };
  }

  async initialize(): Promise<void> {
    await Promise.all(Object.values(this.paths).map((path) => mkdir(path, { recursive: true })));
    await this.withOwnerMutation(async () => {
      for (const record of await this.listCapabilities()) await this.ensureCurrentEvent(record);
    });
  }

  async readCapability(capabilityId: string): Promise<LearnedCapabilityRecord | undefined> {
    assertSafeFileKey(capabilityId, 'capabilityId');
    const filePath = join(this.paths.capabilities, `${capabilityId}.json`);
    const value = await readJson(filePath);
    if (value !== undefined) return assertCapability(value, filePath);
    if (this.#globalRoot !== this.paths.root) return undefined;
    const matches = await projectCapabilityFiles(this.#globalRoot, capabilityId);
    if (matches.length > 1) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        `duplicate project capabilityId: ${capabilityId}`,
      );
    }
    const projectFile = matches[0];
    return projectFile === undefined
      ? undefined
      : assertCapability(await readJson(projectFile), projectFile);
  }

  async listCapabilities(): Promise<readonly LearnedCapabilityRecord[]> {
    const direct = await listJsonFiles(this.paths.capabilities);
    const project = this.#globalRoot === this.paths.root
      ? await projectCapabilityFiles(this.#globalRoot)
      : [];
    return Promise.all([...direct, ...project].map(async (filePath) => {
      return assertCapability(await readJson(filePath), filePath);
    }));
  }

  async writeCapability(record: LearnedCapabilityRecord): Promise<void> {
    assertSafeFileKey(record.capabilityId, 'capabilityId');
    const capabilities = this.#globalRoot === this.paths.root && record.schemaVersion === 2
      ? join(
          this.#globalRoot,
          'projects',
          record.scope.tenantHash,
          record.scope.projectHash,
          'capabilities',
        )
      : this.paths.capabilities;
    const filePath = join(capabilities, `${record.capabilityId}.json`);
    assertCapability(record, filePath);
    await writeJsonAtomic(filePath, record);
  }

  async writeEvent(event: LearningEvent): Promise<void> {
    assertSafeFileKey(event.eventId, 'eventId');
    await writeJsonAtomic(join(this.paths.events, `${event.eventId}.json`), event);
  }

  async listEvents(): Promise<readonly LearningEvent[]> {
    const events = await Promise.all((await listJsonFiles(this.paths.events)).map(async (filePath) => {
      return assertEvent(await readJson(filePath), filePath);
    }));
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  async readClient(identity: string): Promise<LearningClientRecord> {
    assertSafeFileKey(identity, 'clientIdentity');
    const filePath = join(this.paths.clients, `${identity}.json`);
    const value = await readJson(filePath);
    return value === undefined
      ? { schemaVersion: 1, clientIdentity: identity, events: {} }
      : assertClient(value, identity);
  }

  async writeClient(record: LearningClientRecord): Promise<void> {
    assertSafeFileKey(record.clientIdentity, 'clientIdentity');
    await writeJsonAtomic(join(this.paths.clients, `${record.clientIdentity}.json`), record);
  }

  withOwnerMutation<T>(operation: () => Promise<T>): Promise<T> {
    return withLearningFileLock(join(this.#globalRoot, '.owner.lock'), operation);
  }

  withClientMutation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    assertSafeFileKey(identity, 'clientIdentity');
    return withLearningFileLock(join(this.paths.clients, `.${identity}.lock`), operation);
  }

  async ensureCurrentEvent(record: LearnedCapabilityRecord): Promise<LearningEvent> {
    const eventId = learningEventIdFor(record);
    const existing = await readJson(join(this.paths.events, `${eventId}.json`));
    if (existing !== undefined) return assertEvent(existing, eventId);
    const events = await this.listEvents();
    const event = eventFromCapability(record, (events.at(-1)?.sequence ?? 0) + 1);
    await this.writeEvent(event);
    return event;
  }
}

function globalLearnedAreaRoot(rootDir: string): string {
  const projectHash = basename(rootDir);
  const tenantRoot = dirname(rootDir);
  const tenantHash = basename(tenantRoot);
  const projectsRoot = dirname(tenantRoot);
  if (/^[a-f0-9]{64}$/.test(projectHash)
    && /^[a-f0-9]{64}$/.test(tenantHash)
    && basename(projectsRoot) === 'projects') {
    return dirname(projectsRoot);
  }
  return rootDir;
}

async function projectCapabilityFiles(
  globalRoot: string,
  capabilityId?: string,
): Promise<readonly string[]> {
  const projectsRoot = join(globalRoot, 'projects');
  const files: string[] = [];
  for (const tenant of await listDirectories(projectsRoot)) {
    for (const project of await listDirectories(join(projectsRoot, tenant))) {
      const capabilities = join(projectsRoot, tenant, project, 'capabilities');
      if (capabilityId !== undefined) {
        const candidate = join(capabilities, `${capabilityId}.json`);
        if (await readJson(candidate) !== undefined) files.push(candidate);
      } else {
        files.push(...await listJsonFiles(capabilities));
      }
    }
  }
  return files.sort();
}

async function listDirectories(dirPath: string): Promise<readonly string[]> {
  try {
    return (await readdir(dirPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
}

export function eventFromCapability(record: LearnedCapabilityRecord, sequence: number): LearningEvent {
  return {
    schemaVersion: 1,
    sequence,
    eventId: learningEventIdFor(record),
    capabilityId: record.capabilityId,
    capabilityRevision: record.revision,
    kind: learningEventKindForRecord(record),
    lifecycle: record.lifecycle,
    displayName: record.displayName,
    slug: record.slug,
    carrier: record.carrier,
    createdAt: record.updatedAt,
  };
}
