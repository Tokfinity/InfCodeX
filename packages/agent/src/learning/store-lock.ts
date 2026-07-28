import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { emitKodaXDiagnostic } from '../diagnostics.js';

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 10;
const LOCK_STALE_MS = 30_000;
const TICKET_NUMBER_WIDTH = 16;
const LOCK_CLEANUP_ATTEMPTS = 8;

interface LockTicket {
  readonly queuePath: string;
  readonly path: string;
  readonly name: string;
  readonly raw: string;
}

export async function withLearningFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await acquireLock(lockPath, acquireTimeoutMs);
  try {
    return await operation();
  } finally {
    try {
      await lock.handle.close();
    } finally {
      await releaseLock(lockPath, lock.token);
    }
  }
}

async function acquireLock(
  lockPath: string,
  acquireTimeoutMs: number,
): Promise<{ readonly handle: FileHandle; readonly token: string }> {
  const deadline = Date.now() + acquireTimeoutMs;
  const ticket = await createLockTicket(lockPath);
  let acquired: { readonly handle: FileHandle; readonly token: string } | undefined;
  let missingAccessRetryUsed = false;
  try {
    await waitForTicketTurn(ticket, deadline, lockPath);
    while (true) {
      await assertTicketOwned(ticket);
      try {
        acquired = await createLock(lockPath);
        return acquired;
      } catch (error) {
        const contention = await classifyExistingLockContention(error, lockPath);
        if (contention === 'retry_missing') {
          if (missingAccessRetryUsed) throw error;
          missingAccessRetryUsed = true;
          await delay(LOCK_POLL_MS);
          continue;
        }
        if (contention === 'not_contended') throw error;
        missingAccessRetryUsed = false;
        const staleLock = await observeStaleLock(lockPath);
        if (staleLock !== undefined && await removeObservedStaleLock(lockPath, staleLock)) {
          continue;
        }
        if (Date.now() >= deadline) throw lockTimeout(lockPath);
        await delay(LOCK_POLL_MS);
      }
    }
  } finally {
    try {
      await releaseQueueEntry(ticket.path, ticket.raw);
    } catch (cleanupError) {
      if (acquired === undefined) throw cleanupError;
      const cleanupErrors: unknown[] = [cleanupError];
      try {
        await acquired.handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await releaseLock(lockPath, acquired.token);
      } catch (error) {
        cleanupErrors.push(error);
      }
      throw cleanupErrors.length === 1
        ? cleanupError
        : new AggregateError(cleanupErrors, 'learning lock acquisition cleanup failed');
    }
  }
}

async function createLockTicket(lockPath: string): Promise<LockTicket> {
  const queuePath = `${lockPath}.queue`;
  const token = randomUUID();
  const raw = `${process.pid} ${token}\n`;
  const choosingPath = join(queuePath, `choosing-${token}.lock`);
  await mkdir(queuePath, { recursive: true });
  await createOwnerFile(choosingPath, raw);
  try {
    await cleanupAbandonedQueueEntries(queuePath);
    const tickets = await listQueueTickets(queuePath);
    const nextNumber = Math.max(0, ...tickets.map((ticket) => ticket.number)) + 1;
    if (!Number.isSafeInteger(nextNumber)) throw new Error('learning lock ticket overflow');
    const name = `ticket-${String(nextNumber).padStart(TICKET_NUMBER_WIDTH, '0')}-${token}.lock`;
    const ticketPath = join(queuePath, name);
    await createOwnerFile(ticketPath, raw);
    return { queuePath, path: ticketPath, name, raw };
  } finally {
    await releaseQueueEntry(choosingPath, raw);
  }
}

async function waitForTicketTurn(
  ticket: LockTicket,
  deadline: number,
  lockPath: string,
): Promise<void> {
  while (true) {
    await cleanupAbandonedQueueEntries(ticket.queuePath);
    await assertTicketOwned(ticket);
    const names = await readdir(ticket.queuePath);
    const choosing = names.some((name) => name.startsWith('choosing-'));
    const first = names
      .map(parseQueueTicket)
      .filter((entry) => entry !== undefined)
      .sort(compareQueueTickets)[0];
    if (!choosing && first?.name === ticket.name) return;
    if (Date.now() >= deadline) throw lockTimeout(lockPath);
    await delay(LOCK_POLL_MS);
  }
}

async function createOwnerFile(filePath: string, raw: string): Promise<void> {
  const handle = await open(filePath, 'wx');
  try {
    try {
      await handle.writeFile(raw, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeFileWithTransientRetry(filePath);
    throw error;
  }
}

async function assertTicketOwned(ticket: LockTicket): Promise<void> {
  try {
    if (await readFile(ticket.path, 'utf8') !== ticket.raw) {
      throw new Error(`learning store lock ticket lost: ${ticket.path}`);
    }
  } catch (error) {
    if (isFileError(error, 'ENOENT')) {
      throw new Error(`learning store lock ticket lost: ${ticket.path}`);
    }
    throw error;
  }
}

interface QueueTicketName {
  readonly name: string;
  readonly number: number;
}

async function listQueueTickets(queuePath: string): Promise<readonly QueueTicketName[]> {
  return (await readdir(queuePath))
    .map(parseQueueTicket)
    .filter((entry) => entry !== undefined);
}

function parseQueueTicket(name: string): QueueTicketName | undefined {
  const match = /^ticket-(\d{16})-[0-9a-f-]+\.lock$/i.exec(name);
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? { name, number } : undefined;
}

function compareQueueTickets(left: QueueTicketName, right: QueueTicketName): number {
  return left.number - right.number || left.name.localeCompare(right.name);
}

async function cleanupAbandonedQueueEntries(queuePath: string): Promise<void> {
  const names = await readdir(queuePath);
  await Promise.all(names
    .filter(isQueueEntryName)
    .map(async (name) => {
      const entryPath = join(queuePath, name);
      if (await isAbandonedQueueEntry(entryPath)) {
        await removeFileWithTransientRetry(entryPath);
      }
    }));
}

function isQueueEntryName(name: string): boolean {
  return /^choosing-[0-9a-f-]+\.lock$/i.test(name) || parseQueueTicket(name) !== undefined;
}

async function isAbandonedQueueEntry(entryPath: string): Promise<boolean> {
  try {
    const snapshot = await stat(entryPath);
    const owner = parseOwner(await readFile(entryPath, 'utf8'));
    if (owner?.released === true) return true;
    if (Date.now() - snapshot.mtimeMs <= LOCK_STALE_MS) return false;
    return owner === undefined || !isProcessAlive(owner.pid);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return false;
    if (['EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) return false;
    throw error;
  }
}

async function createLock(
  lockPath: string,
): Promise<{ readonly handle: FileHandle; readonly token: string }> {
  const handle = await open(lockPath, 'wx');
  const token = randomUUID();
  try {
    await handle.writeFile(`${process.pid} ${token}\n`, 'utf8');
    return { handle, token };
  } catch (error) {
    await handle.close();
    await removeFileWithTransientRetry(lockPath);
    throw error;
  }
}

interface ObservedStaleLock {
  readonly raw: string;
  readonly mtimeMs: number;
  readonly size: number;
}

async function observeStaleLock(lockPath: string): Promise<ObservedStaleLock | undefined> {
  try {
    const snapshot = await stat(lockPath);
    const raw = await readFile(lockPath, 'utf8');
    const owner = parseOwner(raw);
    const explicitlyReleased = owner?.token !== undefined
      && await hasReleaseMarker(lockPath, owner.token);
    if (!explicitlyReleased && Date.now() - snapshot.mtimeMs <= LOCK_STALE_MS) return undefined;
    return explicitlyReleased || (owner !== undefined && !isProcessAlive(owner.pid))
      ? { raw, mtimeMs: snapshot.mtimeMs, size: snapshot.size }
      : undefined;
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) {
      return undefined;
    }
    throw error;
  }
}

async function removeObservedStaleLock(
  lockPath: string,
  observed: ObservedStaleLock,
): Promise<boolean> {
  try {
    const current = await stat(lockPath);
    if (current.mtimeMs !== observed.mtimeMs || current.size !== observed.size) return false;
    if (await readFile(lockPath, 'utf8') !== observed.raw) return false;
    await removeFileWithTransientRetry(lockPath);
    return true;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return true;
    if (['EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) return false;
    throw error;
  }
}

async function classifyExistingLockContention(
  error: unknown,
  lockPath: string,
): Promise<'contended' | 'retry_missing' | 'not_contended'> {
  if (isFileError(error, 'EEXIST')) return 'contended';
  if (!['EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) {
    return 'not_contended';
  }
  try {
    return (await stat(lockPath)).isFile() ? 'contended' : 'not_contended';
  } catch (statError) {
    if (isFileError(statError, 'ENOENT')) return 'retry_missing';
    throw error;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = parseOwner(await readFile(lockPath, 'utf8'));
    if (owner?.token !== token) return;
    let markerError: unknown;
    try {
      await writeFile(releaseMarkerPath(lockPath, token), `${token}\n`, 'utf8');
    } catch (error) {
      markerError = error;
    }
    try {
      await removeFileWithTransientRetry(lockPath);
    } catch (error) {
      if (markerError === undefined && isTransientFileContention(error)) return;
      if (markerError === undefined) throw error;
      throw new AggregateError(
        [markerError, error],
        'learning lock release marker and owner cleanup both failed',
      );
    }
    try {
      await removeFileWithTransientRetry(releaseMarkerPath(lockPath, token));
    } catch (error) {
      emitKodaXDiagnostic({
        source: 'learning.store-lock',
        level: 'warn',
        message: 'Released learning lock left a harmless cleanup marker.',
        detail: {
          filePath: releaseMarkerPath(lockPath, token),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) throw error;
  }
}

async function releaseQueueEntry(filePath: string, raw: string): Promise<void> {
  let markerError: unknown;
  try {
    const current = await readFile(filePath, 'utf8');
    if (current !== raw) throw new Error(`learning store lock queue entry lost: ${filePath}`);
    await writeFile(filePath, `${raw.trimEnd()} released\n`, 'utf8');
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    markerError = error;
  }
  try {
    await removeFileWithTransientRetry(filePath);
  } catch (error) {
    if (markerError === undefined && isTransientFileContention(error)) return;
    if (markerError === undefined) throw error;
    throw new AggregateError(
      [markerError, error],
      'learning lock queue marker and cleanup both failed',
    );
  }
}

async function hasReleaseMarker(lockPath: string, token: string): Promise<boolean> {
  try {
    return (await readFile(releaseMarkerPath(lockPath, token), 'utf8')).trim() === token;
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) {
      return false;
    }
    throw error;
  }
}

function releaseMarkerPath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.released`;
}

function parseOwner(
  raw: string,
): { readonly pid: number; readonly token?: string; readonly released: boolean } | undefined {
  const match = /^(\d+)(?: ([0-9a-f-]+))?(?: (released))?\s*$/i.exec(raw);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return match[2] === undefined
    ? { pid, released: match[3] !== undefined }
    : { pid, token: match[2], released: match[3] !== undefined };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileError(error, 'ESRCH');
  }
}

function isFileError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isTransientFileContention(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code));
}

async function removeFileWithTransientRetry(filePath: string): Promise<void> {
  for (let attempt = 1; attempt <= LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await rm(filePath, { force: true });
      return;
    } catch (error) {
      if (isFileError(error, 'ENOENT')) return;
      const transient = isTransientFileContention(error);
      if (!transient || attempt === LOCK_CLEANUP_ATTEMPTS) throw error;
      await delay(LOCK_POLL_MS);
    }
  }
}

function lockTimeout(lockPath: string): Error {
  return new Error(`learning store lock timed out: ${lockPath}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
