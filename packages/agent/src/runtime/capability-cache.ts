import fsSync from 'node:fs';
import path from 'node:path';
import {
  addRejectedEffort,
  getRejectedEfforts,
  removeCacheEntry,
  sanitizeCapabilityCache,
  type CapabilityCache,
  type CapabilityCacheSource,
} from '@kodax-ai/llm';
import { getAgentConfigPath } from './agent-home.js';

export const CAPABILITY_CACHE_FILENAME = 'capability-cache.json';

export function getCapabilityCacheFile(): string {
  return getAgentConfigPath(CAPABILITY_CACHE_FILENAME);
}

let memo: CapabilityCache | null = null;
let memoPath: string | null = null;

export function loadCapabilityCache(): CapabilityCache {
  const cacheFile = getCapabilityCacheFile();
  if (memo && memoPath === cacheFile) {
    return memo;
  }
  try {
    memo = fsSync.existsSync(cacheFile)
      ? sanitizeCapabilityCache(JSON.parse(fsSync.readFileSync(cacheFile, 'utf-8')))
      : {};
    memoPath = cacheFile;
  } catch {
    // Disposable cache: corrupt or unreadable files are reset, not migrated.
    memo = {};
    memoPath = cacheFile;
  }
  return memo;
}

function persistCapabilityCache(cache: CapabilityCache): void {
  const cacheFile = getCapabilityCacheFile();
  memo = cache;
  memoPath = cacheFile;
  fsSync.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fsSync.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

export function getCachedRejectedEfforts(
  provider: string,
  model: string | undefined,
): readonly string[] {
  return getRejectedEfforts(loadCapabilityCache(), provider, model);
}

export function recordRejectedEffort(
  provider: string,
  model: string | undefined,
  effort: string,
  source: CapabilityCacheSource,
  updatedAt: string,
): void {
  persistCapabilityCache(
    addRejectedEffort(loadCapabilityCache(), provider, model, effort, source, updatedAt),
  );
}

export function clearCapabilityCache(provider?: string, model?: string): void {
  persistCapabilityCache(removeCacheEntry(loadCapabilityCache(), provider, model));
}

export function resetCapabilityCacheMemoForTesting(): void {
  memo = null;
  memoPath = null;
}
