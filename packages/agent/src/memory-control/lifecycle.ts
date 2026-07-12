import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

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
): Promise<void> {
  if (ref.storageUri === undefined || !isWithin(memoryRoot, ref.storageUri)) {
    throw new Error('memory ref is not stored under the managed memory root');
  }
  await rm(ref.storageUri, { force: true });
  await removeIndexLine(memoryRoot, path.basename(ref.storageUri));
  await updateLifecycle(memoryRoot, ref.id, 'forgotten', updatedAt);
}

async function updateLifecycle(
  memoryRoot: string,
  refId: string,
  lifecycle: 'archived' | 'forgotten',
  updatedAt: string,
): Promise<void> {
  await withLifecycleLock(memoryRoot, async () => {
    const state = await readLifecycleState(memoryRoot);
    const key = await tombstoneKey(memoryRoot, refId);
    await writeState(memoryRoot, {
      version: 1,
      entries: { ...state.entries, [key]: { lifecycle, updatedAt } },
    });
  });
}

async function withLifecycleLock(memoryRoot: string, operation: () => Promise<void>): Promise<void> {
  const lockPath = path.join(memoryRoot, '.governance', 'lifecycle.lock');
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await acquireLifecycleLock(lockPath);
  try {
    await operation();
  } finally {
    try {
      await handle.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

async function acquireLifecycleLock(lockPath: string): Promise<FileHandle> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await open(lockPath, 'wx');
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLifecycleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`memory lifecycle lock timed out: ${lockPath}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function isStaleLifecycleLock(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 30_000;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeIndexLine(memoryRoot: string, filename: string): Promise<void> {
  const indexPath = path.join(memoryRoot, 'MEMORY.md');
  try {
    const content = await readFile(indexPath, 'utf8');
    const next = content.split(/\r?\n/).filter((line) => !line.includes(`(${filename})`)).join('\n');
    await writeFile(indexPath, next.endsWith('\n') || next.length === 0 ? next : `${next}\n`, 'utf8');
  } catch (error) {
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
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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
