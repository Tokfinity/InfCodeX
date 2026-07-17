import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function withLearningFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await acquireLock(lockPath);
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
): Promise<{ readonly handle: FileHandle; readonly token: string }> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await createLock(lockPath);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`learning store lock timed out: ${lockPath}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
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
    await rm(lockPath, { force: true });
    throw error;
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    if (Date.now() - (await stat(lockPath)).mtimeMs <= 30_000) return false;
    const owner = parseOwner(await readFile(lockPath, 'utf8'));
    return owner !== undefined && !isProcessAlive(owner.pid);
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].some((code) => isFileError(error, code))) return false;
    throw error;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = parseOwner(await readFile(lockPath, 'utf8'));
    if (owner?.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) throw error;
  }
}

function parseOwner(raw: string): { readonly pid: number; readonly token?: string } | undefined {
  const match = /^(\d+)(?: ([0-9a-f-]+))?\s*$/i.exec(raw);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return match[2] === undefined ? { pid } : { pid, token: match[2] };
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
