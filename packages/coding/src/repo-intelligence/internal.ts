import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs/promises';
import path from 'path';

const repoIntelligenceStorageDirContext = new AsyncLocalStorage<string | undefined>();

export async function safeReadJson<T>(
  filePath: string,
  validator?: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (validator && !validator(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function debugLogRepoIntelligence(message: string, error?: unknown): void {
  if (!process.env.KODAX_DEBUG_REPO_INTELLIGENCE) {
    return;
  }
  if (error === undefined) {
    console.debug('[kodax:repo-intelligence]', message);
    return;
  }
  console.debug('[kodax:repo-intelligence]', message, error);
}

export function withRepoIntelligenceStorageDir<T>(
  storageDir: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return repoIntelligenceStorageDirContext.run(storageDir?.trim() || undefined, work);
}

export function resolveRepoIntelligenceStorageDir(
  defaultStorageDir: string,
): string {
  return repoIntelligenceStorageDirContext.getStore()?.trim()
    || process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR?.trim()
    || defaultStorageDir;
}

// Orphan temp files older than this are from writes that never completed
// (the process was hard-killed between writeFile and rename, so the catch
// below never ran). A generous window keeps the sweep from ever touching a
// concurrent writer's in-flight temp, whose mtime is always near-now.
const STALE_TEMP_FILE_MS = 60 * 60 * 1000;

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // The write or rename failed (e.g. Windows EPERM when the target is
    // locked by a concurrent reader). Remove our own temp so failed writes
    // don't accumulate one orphan `.tmp` each, then surface the error.
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  // Best-effort mop-up of stale orphans left by writes that were hard-killed
  // before the catch above could run. Never lets a sweep failure break the
  // write that just succeeded.
  await sweepStaleTempFiles(directory, path.basename(filePath)).catch(() => {});
}

async function sweepStaleTempFiles(
  directory: string,
  baseName: string,
): Promise<void> {
  const prefix = `${baseName}.`;
  const now = Date.now();
  const entries = await fs.readdir(directory);
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map(async (name) => {
        const fullPath = path.join(directory, name);
        try {
          const info = await fs.stat(fullPath);
          if (now - info.mtimeMs >= STALE_TEMP_FILE_MS) {
            await fs.rm(fullPath, { force: true });
          }
        } catch {
          // Raced another sweeper or the owning writer — ignore.
        }
      }),
  );
}
