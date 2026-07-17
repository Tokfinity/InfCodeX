import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
    || value.schemaVersion !== 1
    || typeof value.capabilityId !== 'string'
    || typeof value.displayName !== 'string'
    || typeof value.slug !== 'string'
    || typeof value.revision !== 'number'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.source)) {
    throw new LearningCapabilityError('store_integrity_error', `invalid capability record in ${filePath}`);
  }
  return value as unknown as LearnedCapabilityRecord;
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

  constructor(rootDir: string) {
    this.paths = resolveLearnedAreaPaths(rootDir);
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
    return value === undefined ? undefined : assertCapability(value, filePath);
  }

  async listCapabilities(): Promise<readonly LearnedCapabilityRecord[]> {
    return Promise.all((await listJsonFiles(this.paths.capabilities)).map(async (filePath) => {
      return assertCapability(await readJson(filePath), filePath);
    }));
  }

  async writeCapability(record: LearnedCapabilityRecord): Promise<void> {
    assertSafeFileKey(record.capabilityId, 'capabilityId');
    await writeJsonAtomic(join(this.paths.capabilities, `${record.capabilityId}.json`), record);
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
    return withLearningFileLock(join(this.paths.root, '.owner.lock'), operation);
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
