/**
 * Runtime capability cache — `~/.kodax/capability-cache.json`.
 *
 * A DISPOSABLE local layer that narrows the static/inherited reasoning
 * capability with efforts a model has been observed (or probed) to reject.
 * It only ever REMOVES rungs — never widens — because a provider accepting an
 * effort doesn't prove it's distinct (it may silently alias/clamp), whereas a
 * hard rejection is ground truth. Paired with the optimistic-wide default
 * (registry inheritance), this lets the ladder self-correct from real traffic:
 * a rejected effort drops out of Ctrl+T, `/effort`, and the wire request, so
 * the user never selects it again.
 *
 * No `version` field: the file is regenerable (rejections re-learn, probes
 * re-run), so on any parse failure we reset rather than migrate.
 */

import fsSync from 'fs';
import path from 'path';
import { getAgentConfigHome } from '@kodax-ai/agent';
import type { KodaXReasoningProfile } from '@kodax-ai/coding';

export const CAPABILITY_CACHE_FILE = path.join(
  getAgentConfigHome(),
  'capability-cache.json',
);

function getCapabilityCacheFile(): string {
  return path.join(getAgentConfigHome(), 'capability-cache.json');
}

export type CapabilityCacheSource = 'observed' | 'probed';

export interface CapabilityCacheEntry {
  /** Efforts this provider/model rejected — removed from the effective ladder. */
  readonly rejected: readonly string[];
  /** How we learned it (display/trust only). */
  readonly source: CapabilityCacheSource;
  /** ISO timestamp of the last update (display + future staleness). */
  readonly updatedAt: string;
}

/** Keyed by `provider/model`. */
export type CapabilityCache = Record<string, CapabilityCacheEntry>;

export function capabilityCacheKey(provider: string, model: string | undefined): string {
  return `${provider}/${model ?? ''}`;
}

// ─── Pure operations (no IO — unit-tested directly) ───────────────────────

/**
 * Narrow a reasoning profile by the cached rejections: drop them from
 * `supportedEfforts` and fold them into `localRejectEfforts` so every
 * consumer (cycle / options / label / wire validation) treats them as
 * unsupported. Returns the input unchanged when there is nothing to remove.
 */
export function narrowReasoningProfile(
  profile: KodaXReasoningProfile,
  rejected: readonly string[],
): KodaXReasoningProfile {
  if (rejected.length === 0) {
    return profile;
  }
  const rejectedSet = new Set(rejected);
  return {
    ...profile,
    supportedEfforts: profile.supportedEfforts?.filter(
      (preset) => !rejectedSet.has(preset.value),
    ),
    localRejectEfforts: Array.from(
      new Set([...(profile.localRejectEfforts ?? []), ...rejected]),
    ),
  };
}

export function getRejectedEfforts(
  cache: CapabilityCache,
  provider: string,
  model: string | undefined,
): readonly string[] {
  return cache[capabilityCacheKey(provider, model)]?.rejected ?? [];
}

/** Immutable: returns a new cache with `effort` recorded as rejected. */
export function addRejectedEffort(
  cache: CapabilityCache,
  provider: string,
  model: string | undefined,
  effort: string,
  source: CapabilityCacheSource,
  updatedAt: string,
): CapabilityCache {
  const key = capabilityCacheKey(provider, model);
  const prior = cache[key];
  const rejected = prior?.rejected.includes(effort)
    ? prior.rejected
    : [...(prior?.rejected ?? []), effort];
  return { ...cache, [key]: { rejected, source, updatedAt } };
}

/** Immutable: drop one model's entry, or the whole cache when no key given. */
export function removeCacheEntry(
  cache: CapabilityCache,
  provider?: string,
  model?: string,
): CapabilityCache {
  if (!provider) {
    return {};
  }
  const next = { ...cache };
  delete next[capabilityCacheKey(provider, model)];
  return next;
}

function sanitizeCache(raw: unknown): CapabilityCache {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: CapabilityCache = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const rejected = Array.isArray(entry.rejected)
      ? entry.rejected.filter((e): e is string => typeof e === 'string')
      : [];
    const source: CapabilityCacheSource = entry.source === 'probed' ? 'probed' : 'observed';
    const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : '';
    out[key] = { rejected, source, updatedAt };
  }
  return out;
}

// ─── Thin IO (memoized; write-through) ────────────────────────────────────

let memo: CapabilityCache | null = null;

export function loadCapabilityCache(): CapabilityCache {
  if (memo) {
    return memo;
  }
  const cacheFile = getCapabilityCacheFile();
  try {
    memo = fsSync.existsSync(cacheFile)
      ? sanitizeCache(JSON.parse(fsSync.readFileSync(cacheFile, 'utf-8')))
      : {};
  } catch {
    // Disposable cache: a corrupt file is reset, not migrated.
    memo = {};
  }
  return memo;
}

function persistCapabilityCache(cache: CapabilityCache): void {
  memo = cache;
  const cacheFile = getCapabilityCacheFile();
  fsSync.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fsSync.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

/** Cached rejections for the current provider/model (read path). */
export function getCachedRejectedEfforts(
  provider: string,
  model: string | undefined,
): readonly string[] {
  return getRejectedEfforts(loadCapabilityCache(), provider, model);
}

/** Record a rejection and write through (passive-learning / probe writer). */
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

/** Clear one model's cache, or the whole file (`/provider forget-capability`). */
export function clearCapabilityCache(provider?: string, model?: string): void {
  persistCapabilityCache(removeCacheEntry(loadCapabilityCache(), provider, model));
}

/** Test hook — drop the in-memory memo so the next load re-reads disk. */
export function resetCapabilityCacheMemoForTesting(): void {
  memo = null;
}
