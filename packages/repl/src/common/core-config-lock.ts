import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

export class CoreConfigWriteConflictError extends Error {
  constructor(configPath: string) {
    super(`Core configuration is being changed by another KodaX writer: ${configPath}`);
    this.name = 'CoreConfigWriteConflictError';
  }
}

export function coreConfigWriteLockPath(configPath: string): string {
  return `${configPath}.write.lock`;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function withCoreConfigWriteLock<T>(
  configPath: string,
  action: () => T,
): T {
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = coreConfigWriteLockPath(configPath);
  let lock: number;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new CoreConfigWriteConflictError(configPath);
    throw new Error(`Failed to acquire the core configuration write lock: ${configPath}`, {
      cause: error,
    });
  }
  try {
    return action();
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}
