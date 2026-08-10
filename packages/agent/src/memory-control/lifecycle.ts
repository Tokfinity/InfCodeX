import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withLearningFileLock } from '../learning/store-lock.js';
import type { MemoryItemRef, MemoryLifecycle } from './types.js';

interface LifecycleState {
  readonly version: 1;
  readonly entries: Readonly<Record<string, {
    readonly lifecycle: 'archived' | 'forgotten';
    readonly updatedAt: string;
  }>>;
}

export async function resolveManagedLifecycle(
  memoryRoot: string,
  ref: MemoryItemRef,
): Promise<MemoryLifecycle | 'forgotten'> {
  const state = await readLifecycleState(memoryRoot);
  if (Object.keys(state.entries).length === 0) return ref.lifecycle;
  const lifecycle = state.entries[await tombstoneKey(memoryRoot, ref.id)]?.lifecycle;
  return lifecycle ?? ref.lifecycle;
}

export async function archiveManagedMemoryRef(
  memoryRoot: string,
  ref: MemoryItemRef,
  updatedAt: string,
): Promise<void> {
  await updateLifecycle(memoryRoot, ref.id, 'archived', updatedAt);
}

export async function forgetManagedMemoryRef(
  memoryRoot: string,
  ref: MemoryItemRef,
  updatedAt: string,
  expectedBodyFingerprint?: string,
): Promise<boolean> {
  const storageUri = ref.storageUri;
  if (storageUri === undefined || !isWithin(memoryRoot, storageUri)) {
    throw new Error('memory ref is not stored under the managed memory root');
  }
  return withLifecycleLock(memoryRoot, async () => {
    if (expectedBodyFingerprint !== undefined) {
      let content: string;
      try {
        content = await readFile(storageUri, 'utf8');
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      const currentFingerprint = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (currentFingerprint !== expectedBodyFingerprint) return false;
    }
    await rm(storageUri, { force: true });
    await removeIndexLine(memoryRoot, path.basename(storageUri));
    await updateLifecycleUnlocked(memoryRoot, ref.id, 'forgotten', updatedAt);
    return true;
  });
}

async function updateLifecycle(
  memoryRoot: string,
  refId: string,
  lifecycle: 'archived' | 'forgotten',
  updatedAt: string,
): Promise<void> {
  await withLifecycleLock(memoryRoot, async () => {
    await updateLifecycleUnlocked(memoryRoot, refId, lifecycle, updatedAt);
  });
}

async function updateLifecycleUnlocked(
  memoryRoot: string,
  refId: string,
  lifecycle: 'archived' | 'forgotten',
  updatedAt: string,
): Promise<void> {
  const state = await readLifecycleState(memoryRoot);
  const key = await tombstoneKey(memoryRoot, refId);
  await writeState(memoryRoot, {
    version: 1,
    entries: { ...state.entries, [key]: { lifecycle, updatedAt } },
  });
}

async function withLifecycleLock<T>(memoryRoot: string, operation: () => Promise<T>): Promise<T> {
  return withLearningFileLock(path.join(memoryRoot, '.memory-review.lock'), operation);
}

async function removeIndexLine(memoryRoot: string, filename: string): Promise<void> {
  const indexPath = path.join(memoryRoot, 'MEMORY.md');
  const tempPath = `${indexPath}.${randomUUID()}.tmp`;
  try {
    const content = await readFile(indexPath, 'utf8');
    const next = content.split(/\r?\n/).filter((line) => !line.includes(`(${filename})`)).join('\n');
    await writeFile(tempPath, next.endsWith('\n') || next.length === 0 ? next : `${next}\n`, 'utf8');
    await rename(tempPath, indexPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (!isMissing(error)) throw error;
  }
}

async function tombstoneKey(memoryRoot: string, refId: string): Promise<string> {
  return createHmac('sha256', await readOrCreateKey(memoryRoot)).update(refId).digest('hex');
}

async function readOrCreateKey(memoryRoot: string): Promise<Buffer> {
  const keyPath = path.join(memoryRoot, '.governance', 'tombstone.key');
  try {
    return await readFile(keyPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, key, { flag: 'wx' });
    return key;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return readFile(keyPath);
  }
}

async function readLifecycleState(memoryRoot: string): Promise<LifecycleState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath(memoryRoot), 'utf8'));
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
      throw new Error('invalid memory lifecycle state');
    }
    const entries: Record<string, { lifecycle: 'archived' | 'forgotten'; updatedAt: string }> = {};
    for (const [key, entry] of Object.entries(value.entries)) {
      if (!/^[0-9a-f]{64}$/.test(key) || !isRecord(entry)) throw new Error('invalid memory lifecycle entry');
      if ((entry.lifecycle !== 'archived' && entry.lifecycle !== 'forgotten')
        || typeof entry.updatedAt !== 'string') throw new Error('invalid memory lifecycle entry');
      entries[key] = { lifecycle: entry.lifecycle, updatedAt: entry.updatedAt };
    }
    return { version: 1, entries };
  } catch (error) {
    if (isMissing(error)) return { version: 1, entries: {} };
    throw error;
  }
}

async function writeState(memoryRoot: string, state: LifecycleState): Promise<void> {
  const filePath = statePath(memoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function statePath(memoryRoot: string): string {
  return path.join(memoryRoot, '.governance', 'lifecycle.json');
}

function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  return path.resolve(candidate).startsWith(`${resolvedRoot}${path.sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}
