import type {
  ImpactEstimateResult,
  ModuleCapsule,
  ModuleContextResult,
  ProcessContextResult,
  ProcessCapsule,
  RepoSymbolRecord,
  RepoIntelligenceIndex,
  SymbolContextResult,
} from './query.js';
import {
  buildRepoIntelligenceIndex as buildFallbackRepoIntelligenceIndex,
  getImpactEstimate as getFallbackImpactEstimate,
  getModuleContext as getFallbackModuleContext,
  getProcessContext as getFallbackProcessContext,
  getRepoIntelligenceIndex as getFallbackRepoIntelligenceIndex,
  getRepoRoutingSignals as getFallbackRepoRoutingSignals,
  renderImpactEstimate,
  renderModuleContext,
  renderProcessContext,
  renderSymbolContext,
  getSymbolContext as getFallbackSymbolContext,
} from './query.js';
import path from 'node:path';
import { buildRepoIntelligenceContext as buildBaselineRepoIntelligenceContext } from './index.js';
import type {
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTrace,
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
import type { RepoPreturnBundle } from '@kodax-ai/repointel-protocol';
import { REPOINTEL_CONTRACT_VERSION } from '@kodax-ai/repointel-protocol';
import {
  callPremiumDaemon,
  resolveRepoIntelligenceMode,
  resolveRepoIntelligenceRuntimeConfig,
} from './premium-client.js';
import { debugLogRepoIntelligence } from './internal.js';

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;

/**
 * v0.7.41 hotfix — cacheKey-input normalizer. Different callers produce
 * subtly-different path strings for the same workspace:
 *   - `run-substrate.ts` runs `path.resolve(opts.context.executionCwd)`
 *     which (on Windows) upper-cases the drive letter (`c:\` → `C:\`).
 *   - Startup prewarm previously passed the raw `context.gitRoot` from
 *     React state without any normalization.
 *
 * Without normalizing here the two callers produce different cacheKey
 * strings for the same workspace → cache miss → prewarm misses its target
 * round entirely. Normalizing inside the cacheKey computation makes the
 * cache robust to all caller variations (case differences, trailing slash,
 * forward/back slash on Windows, relative vs absolute, etc.).
 *
 * Empty input returns '' (matches prior behaviour of `context.X ?? ''`).
 */
function normalizeCachePath(value: string | undefined | null): string {
  if (!value) return '';
  try {
    return path.resolve(value);
  } catch {
    return value;
  }
}
type ValidatedRepoPreturnBundle = Omit<
  RepoPreturnBundle,
  'routingSignals' | 'moduleContext' | 'impactEstimate'
> & {
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
};
type PremiumPreturnResult = {
  bundle: ValidatedRepoPreturnBundle;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
};

const PRETURN_CACHE_TTL_MS = 1_500;
/**
 * v0.7.41 P3 — routing-signals cache TTL. Routing signals (active module id,
 * primaryTask hints, harness profile, complexity) describe stable repo
 * properties; for an interactive REPL session they do not change between
 * rounds unless cwd / gitRoot / mode changes — and the cache key already
 * includes those. The 60s TTL is a defensive ceiling so a long-running
 * session eventually re-validates against fresh daemon state. Caller can
 * still bypass with `refresh: true` (e.g. eval harness, explicit /repointel
 * refresh path).
 *
 * Cross-layer note: this cache sits OUTSIDE `tryPremiumPreturn`'s 1.5s
 * cache — the inner cache coalesces same-round duplicates (P2); this outer
 * cache eliminates daemon round-trips across rounds (P3).
 */
const ROUTING_SIGNALS_CACHE_TTL_MS = 60_000;
/**
 * v0.7.41 P2 — `pending` distinguishes an in-flight daemon call from a
 * resolved-and-cached entry. While `pending===true` the entry's `expiresAt`
 * is `Number.POSITIVE_INFINITY` so the TTL never prunes it mid-flight; once
 * the promise resolves we flip `pending=false` and stamp the real expiry.
 * This lets same-round duplicate callers (e.g. `getRepoRoutingSignals` then
 * `getRepoPreturnBundle`, both keyed on the same preturn payload) coalesce
 * onto one daemon round-trip even when that round-trip exceeds the prior
 * 1.5s TTL — the pre-fix cache effectively coalesced nothing because daemon
 * refresh calls routinely run 5-30s.
 */
type PremiumPreturnCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<PremiumPreturnResult | null>;
};
const premiumPreturnCache = new Map<string, PremiumPreturnCacheEntry>();
const MAX_PRETURN_CACHE_ENTRIES = 64;

/**
 * v0.7.41 P3 — routing-signals cross-round cache. Same in-flight/TTL shape
 * as `premiumPreturnCache`. Key serialises (mode, executionCwd, gitRoot,
 * targetPath) so any change there triggers a fresh resolve.
 */
type RoutingSignalsCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<KodaXRepoRoutingSignals>;
};
const routingSignalsCache = new Map<string, RoutingSignalsCacheEntry>();

/**
 * v0.7.41 P3+ — preturn-bundle session cache (same shape as routing signals).
 * The bundle returned by `getRepoPreturnBundle` is the heavy daemon payload —
 * the rest of the pre-LLM pipeline keys off it. Sharing across rounds (and
 * across startup prewarm → first-round) is the single biggest TTFB win.
 */
type RepoPreturnBundleResult = {
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
  repoContext?: string;
  summary?: string;
  recommendedFiles?: string[];
  lowConfidence?: boolean;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
};
type PreturnBundleCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<RepoPreturnBundleResult>;
};
const preturnBundleCache = new Map<string, PreturnBundleCacheEntry>();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isModuleCapsule(value: unknown): value is ModuleCapsule {
  return isRecord(value)
    && typeof value.moduleId === 'string'
    && typeof value.label === 'string'
    && typeof value.root === 'string'
    && isFiniteNumber(value.fileCount)
    && isFiniteNumber(value.sourceFileCount)
    && isFiniteNumber(value.symbolCount)
    && Array.isArray(value.languages)
    && isStringArray(value.topSymbols)
    && isStringArray(value.dependencies)
    && isStringArray(value.dependents)
    && isStringArray(value.entryFiles)
    && isStringArray(value.keyTests)
    && isStringArray(value.keyDocs)
    && isStringArray(value.sampleFiles)
    && isStringArray(value.processIds)
    && isFiniteNumber(value.confidence);
}

function isRepoSymbolRecord(value: unknown): value is RepoSymbolRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.qualifiedName === 'string'
    && typeof value.filePath === 'string'
    && typeof value.moduleId === 'string'
    && typeof value.language === 'string'
    && typeof value.capabilityTier === 'string'
    && isFiniteNumber(value.line)
    && typeof value.signature === 'string'
    && typeof value.exported === 'boolean'
    && isStringArray(value.calls)
    && Array.isArray(value.callTargets)
    && isStringArray(value.importPaths)
    && isFiniteNumber(value.confidence);
}

function isProcessCapsule(value: unknown): value is ProcessCapsule {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.moduleId === 'string'
    && typeof value.entryFile === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.steps)
    && value.steps.every((step) => isRecord(step)
      && typeof step.kind === 'string'
      && typeof step.symbolName === 'string'
      && typeof step.filePath === 'string'
      && typeof step.note === 'string'
      && (step.line === undefined || isFiniteNumber(step.line)))
    && isFiniteNumber(value.confidence);
}

function isRepoRoutingSignals(value: unknown): value is KodaXRepoRoutingSignals {
  return isRecord(value)
    && isFiniteNumber(value.changedFileCount)
    && isFiniteNumber(value.changedLineCount)
    && isFiniteNumber(value.addedLineCount)
    && isFiniteNumber(value.deletedLineCount)
    && isFiniteNumber(value.touchedModuleCount)
    && isStringArray(value.changedModules)
    && typeof value.crossModule === 'boolean'
    && isStringArray(value.riskHints)
    && typeof value.plannerBias === 'boolean'
    && typeof value.investigationBias === 'boolean'
    && typeof value.lowConfidence === 'boolean';
}

function isModuleContextResult(value: unknown): value is ModuleContextResult {
  return isRecord(value)
    && isModuleCapsule(value.module)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence)
    && isStringArray(value.evidence);
}

function isSymbolContextResult(value: unknown): value is SymbolContextResult {
  return isRecord(value)
    && isRepoSymbolRecord(value.symbol)
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isRepoSymbolRecord)
    && Array.isArray(value.callers)
    && value.callers.every(isRepoSymbolRecord)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isProcessContextResult(value: unknown): value is ProcessContextResult {
  return isRecord(value)
    && isProcessCapsule(value.process)
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isProcessCapsule)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isImpactEstimateResult(value: unknown): value is ImpactEstimateResult {
  return isRecord(value)
    && isRecord(value.target)
    && typeof value.target.kind === 'string'
    && typeof value.target.label === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.impactedModules)
    && value.impactedModules.every(isModuleCapsule)
    && Array.isArray(value.impactedSymbols)
    && value.impactedSymbols.every(isRepoSymbolRecord)
    && Array.isArray(value.callers)
    && value.callers.every(isRepoSymbolRecord)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isRepoPreturnBundle(value: unknown): value is ValidatedRepoPreturnBundle {
  return isRecord(value)
    && (value.routingSignals === undefined || isRepoRoutingSignals(value.routingSignals))
    && (value.moduleContext === undefined || isModuleContextResult(value.moduleContext))
    && (value.impactEstimate === undefined || isImpactEstimateResult(value.impactEstimate))
    && (value.repoContext === undefined || typeof value.repoContext === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.recommendedFiles === undefined || isStringArray(value.recommendedFiles))
    && (value.lowConfidence === undefined || typeof value.lowConfidence === 'boolean');
}

function validatePremiumResult<T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
  label: string,
): T | undefined {
  if (validator(value)) {
    return value;
  }
  debugLogRepoIntelligence(`Premium repo-intelligence returned invalid ${label}; falling back to OSS.`);
  return undefined;
}

/**
 * v0.7.41 P2/P3 — test-only helper to drop both module-singleton caches.
 * Production code MUST NOT call this; cache invalidation in real runs is
 * handled by TTL expiry and the `refresh: true` opt-out at call sites.
 *
 * Exposed so test fixtures can isolate per-`it()` cache state without
 * depending on the previous test having different cacheKeys.
 */
export function _resetRepoIntelligenceCachesForTesting(): void {
  premiumPreturnCache.clear();
  routingSignalsCache.clear();
  preturnBundleCache.clear();
}

function pruneExpiredPremiumPreturnCache(now = Date.now()): void {
  for (const [key, entry] of premiumPreturnCache.entries()) {
    if (entry.expiresAt <= now) {
      premiumPreturnCache.delete(key);
    }
  }

  if (premiumPreturnCache.size <= MAX_PRETURN_CACHE_ENTRIES) {
    return;
  }

  const keys = Array.from(premiumPreturnCache.keys());
  for (const key of keys.slice(0, premiumPreturnCache.size - MAX_PRETURN_CACHE_ENTRIES)) {
    premiumPreturnCache.delete(key);
  }
}

function buildFallbackCapability(
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  return {
    mode: 'oss',
    engine: 'oss',
    bridge: 'none',
    level: 'basic',
    status: warnings.length > 0 ? 'limited' : 'ok',
    warnings,
  };
}

function buildPremiumCapability(
  mode: KodaXRepoIntelligenceResolvedMode,
  status: KodaXRepoIntelligenceCapability['status'],
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  return {
    mode,
    engine: 'premium',
    bridge: mode === 'premium-native' ? 'native' : 'shared',
    level: 'enhanced',
    status,
    warnings,
    contractVersion: REPOINTEL_CONTRACT_VERSION,
  };
}

function attachRepoIntelligenceMeta<T extends object>(
  result: T,
  capability: KodaXRepoIntelligenceCapability,
  trace?: KodaXRepoIntelligenceTrace,
): T {
  return {
    ...result,
    capability,
    ...(trace ? { trace } : {}),
  };
}

function premiumWarnings(
  mode: KodaXRepoIntelligenceResolvedMode,
  responseWarnings?: string[],
): string[] {
  return [
    ...(responseWarnings ?? []),
    ...(mode === 'premium-shared'
      ? ['Premium shared mode keeps KodaX on the cross-host path without native auto preturn injection.']
      : []),
  ];
}

async function tryPremiumPreturn(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<PremiumPreturnResult | null> {
  const runtimeConfig = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const resolvedMode = resolveRepoIntelligenceMode(runtimeConfig.mode);
  // P2 in-flight cacheKey DELIBERATELY includes `refresh` (and `trace`) —
  // intentional asymmetry with the P3/P3+ outer caches (which omit refresh).
  // P3+ already dominates within 60s; P2 only matters when P3+ misses AND
  // two concurrent callers fire with different refresh values in the same
  // 1.5s window. In that narrow case, an explicit refresh:true caller
  // (e.g. `/repointel warm`, eval harness) deserves its own daemon work
  // and MUST NOT be served a refresh:false sibling's Promise. Outer cache
  // semantics ("data within TTL is fresh by definition") apply at 60s
  // session scope; in-flight Promise sharing keeps the finer-grained intent.
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    endpoint: runtimeConfig.endpoint,
    bin: runtimeConfig.bin,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: options.targetPath ?? '',
    refresh: options.refresh ?? false,
    trace: runtimeConfig.trace,
  });
  const now = Date.now();
  pruneExpiredPremiumPreturnCache(now);
  const cached = premiumPreturnCache.get(cacheKey);
  if (cached) {
    // v0.7.41 P2: an in-flight call always coalesces, regardless of TTL.
    // A resolved entry honours the original 1.5s TTL.
    if (cached.pending || cached.expiresAt > now) {
      return cached.promise;
    }
  }

  // Allocate the entry with `pending: true` BEFORE awaiting so any
  // concurrent caller arriving between this point and the first await
  // sees the same in-flight promise. `expiresAt: Infinity` keeps prune
  // (TTL pass) from removing it while pending.
  const entry: PremiumPreturnCacheEntry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise: undefined as unknown as Promise<PremiumPreturnResult | null>,
  };

  const promise = callPremiumDaemon('preturn', {
    executionCwd: context.executionCwd,
    gitRoot: context.gitRoot,
    targetPath: options.targetPath,
    refresh: options.refresh,
    host: 'kodax',
    intent: 'auto',
    budget: 1600,
  }, {
    mode: options.mode,
    trace: options.trace,
  }).then((premium) => {
    const bundle = validatePremiumResult(
      premium?.response.result,
      isRepoPreturnBundle,
      'preturn bundle',
    );
    // Flip in-flight → TTL-controlled now that the call has resolved. Use
    // a fresh Date.now() because the daemon call may have been slow.
    entry.pending = false;
    entry.expiresAt = Date.now() + PRETURN_CACHE_TTL_MS;
    if (!premium || !bundle) {
      return null;
    }
    return {
      bundle,
      capability: buildPremiumCapability(
        resolvedMode,
        premium.response.status,
        premiumWarnings(resolvedMode, premium.response.warnings),
      ),
      trace: premium.trace,
    };
  }).catch((error) => {
    premiumPreturnCache.delete(cacheKey);
    throw error;
  });

  entry.promise = promise;
  premiumPreturnCache.set(cacheKey, entry);
  pruneExpiredPremiumPreturnCache(now);
  return promise;
}

function fallbackWarningsForMode(
  mode?: KodaXRepoIntelligenceMode,
): string[] {
  const resolvedMode = resolveRepoIntelligenceMode(mode);
  if (resolvedMode === 'off') {
    return ['Repo intelligence auto lane is disabled; using OSS baseline only.'];
  }
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    return ['Premium repo intelligence unavailable; fell back to OSS baseline.'];
  }
  return [];
}

export function resolveKodaXAutoRepoMode(
  mode?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const resolved = resolveRepoIntelligenceMode(mode);
  if (resolved === 'premium-shared') {
    return 'oss';
  }
  return resolved;
}

export async function buildRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const index = await buildFallbackRepoIntelligenceIndex(context, options);
  return attachRepoIntelligenceMeta(index, buildFallbackCapability());
}

export async function getRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const index = await getFallbackRepoIntelligenceIndex(context, options);
  return attachRepoIntelligenceMeta(index, buildFallbackCapability());
}

export async function getModuleContext(
  context: RepoContext,
  options: { module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode } = {},
): Promise<ModuleContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('context-pack', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'auto',
      budget: 2200,
    }, {
      mode: options.mode,
    });
    const result = validatePremiumResult(
      premium?.response.result,
      isRepoPreturnBundle,
      'context-pack bundle',
    );
    if (premium && result?.moduleContext) {
      return attachRepoIntelligenceMeta(
        result.moduleContext,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackModuleContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getSymbolContext(
  context: RepoContext,
  options: { symbol: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<SymbolContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('symbol', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      symbol: options.symbol,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'explain',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isSymbolContextResult,
      'symbol context',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackSymbolContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getProcessContext(
  context: RepoContext,
  options: { entry?: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<ProcessContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('process', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      entry: options.entry,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'explain',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isProcessContextResult,
      'process context',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackProcessContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getImpactEstimate(
  context: RepoContext,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<ImpactEstimateResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('impact', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      path: options.path,
      module: options.module,
      symbol: options.symbol,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'review',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isImpactEstimateResult,
      'impact estimate',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackImpactEstimate(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getRepoRoutingSignals(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode } = {},
): Promise<KodaXRepoRoutingSignals> {
  const runtimeConfig = resolveRepoIntelligenceRuntimeConfig(options.mode);
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);

  // v0.7.41 P3 — session-scoped cache. Two-tier lookup:
  //   1. In-flight: always share the pending promise, regardless of refresh.
  //      Otherwise two concurrent callers (startup prewarm + first-round
  //      prompt) would each launch their own daemon call.
  //   2. Resolved + within TTL: serve from cache even when caller asked for
  //      refresh:true. The intent of refresh:true is "I want fresh data";
  //      data resolved within the 60s TTL is BY DEFINITION fresh, so the
  //      cache hit honors that intent without redundant daemon work. This
  //      is what lets startup prewarm (L2, refresh:false) cover the
  //      first-round middleware call (L1, also refresh:false).
  //   3. Resolved + stale (past TTL): cache miss; new daemon call is made,
  //      and refresh:true (when supplied) drives the daemon's own refresh
  //      semantics on that call.
  //
  // cacheKey must include `endpoint` + `bin` so an in-process endpoint swap
  // (e.g. test env mutating KODAX_REPOINTEL_ENDPOINT, or user running
  // `/repointel mode premium-native --endpoint=...`) invalidates the cache.
  // cacheKey deliberately OMITS `refresh` so prewarm and first-round share
  // the same entry — see the prewarm/first-round coalescing semantics above.
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    endpoint: runtimeConfig.endpoint,
    bin: runtimeConfig.bin,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: options.targetPath ?? '',
  });
  const cached = routingSignalsCache.get(cacheKey);
  if (cached) {
    if (cached.pending) {
      return cached.promise;
    }
    if (cached.expiresAt > Date.now()) {
      return cached.promise;
    }
  }

  const entry: RoutingSignalsCacheEntry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise: undefined as unknown as Promise<KodaXRepoRoutingSignals>,
  };

  const promise = (async (): Promise<KodaXRepoRoutingSignals> => {
    if (resolvedMode === 'premium-native') {
      const premium = await tryPremiumPreturn(context, options);
      if (premium?.bundle.routingSignals) {
        return attachRepoIntelligenceMeta(
          premium.bundle.routingSignals,
          premium.capability,
          premium.trace,
        );
      }
    }
    const fallback = await getFallbackRepoRoutingSignals(context, options);
    return attachRepoIntelligenceMeta(
      fallback,
      buildFallbackCapability(fallbackWarningsForMode(options.mode)),
    );
  })().then((result) => {
    entry.pending = false;
    entry.expiresAt = Date.now() + ROUTING_SIGNALS_CACHE_TTL_MS;
    return result;
  }).catch((error) => {
    routingSignalsCache.delete(cacheKey);
    throw error;
  });

  entry.promise = promise;
  routingSignalsCache.set(cacheKey, entry);
  return promise;
}

export async function getRepoPreturnBundle(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
  } = {},
): Promise<RepoPreturnBundleResult> {
  // v0.7.41 P3+ — session cache. Same semantics as routing signals:
  //   1. In-flight: share regardless of refresh
  //   2. Resolved + within TTL: serve even on refresh:true (the data IS fresh)
  //   3. Resolved + stale: miss → new daemon call (refresh propagates)
  // cacheKey omits refresh so startup prewarm and first-round share entry.
  const runtimeConfig = resolveRepoIntelligenceRuntimeConfig(options.mode);
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    endpoint: runtimeConfig.endpoint,
    bin: runtimeConfig.bin,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: options.targetPath ?? '',
  });
  const cached = preturnBundleCache.get(cacheKey);
  if (cached) {
    if (cached.pending) {
      return cached.promise;
    }
    if (cached.expiresAt > Date.now()) {
      return cached.promise;
    }
  }

  const entry: PreturnBundleCacheEntry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise: undefined as unknown as Promise<RepoPreturnBundleResult>,
  };

  const promise = fetchRepoPreturnBundleInner(context, options).then((result) => {
    entry.pending = false;
    entry.expiresAt = Date.now() + ROUTING_SIGNALS_CACHE_TTL_MS;
    return result;
  }).catch((error) => {
    preturnBundleCache.delete(cacheKey);
    throw error;
  });

  entry.promise = promise;
  preturnBundleCache.set(cacheKey, entry);
  return promise;
}

async function fetchRepoPreturnBundleInner(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
  } = {},
): Promise<RepoPreturnBundleResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-native') {
    const premium = await tryPremiumPreturn(context, options);
    if (premium) {
      return {
        routingSignals: premium.bundle.routingSignals
          ? attachRepoIntelligenceMeta(
            premium.bundle.routingSignals,
            premium.capability,
            premium.trace,
          )
          : undefined,
        moduleContext: premium.bundle.moduleContext
          ? attachRepoIntelligenceMeta(
            premium.bundle.moduleContext,
            premium.capability,
            premium.trace,
          )
          : undefined,
        impactEstimate: premium.bundle.impactEstimate
          ? attachRepoIntelligenceMeta(
            premium.bundle.impactEstimate,
            premium.capability,
            premium.trace,
          )
          : undefined,
        repoContext: premium.bundle.repoContext,
        summary: premium.bundle.summary,
        recommendedFiles: premium.bundle.recommendedFiles,
        lowConfidence: premium.bundle.lowConfidence,
        capability: premium.capability,
        trace: premium.trace,
      };
    }
  }

  const activeTargetPath = options.targetPath ?? (context.executionCwd ? '.' : undefined);
  const [routingSignals, moduleContext, impactEstimate, repoContext] = await Promise.all([
    getRepoRoutingSignals(context, { targetPath: options.targetPath, refresh: options.refresh, mode: 'oss' }),
    activeTargetPath
      ? getModuleContext(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'oss' }).catch(() => undefined)
      : Promise.resolve(undefined),
    activeTargetPath
      ? getImpactEstimate(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'oss' }).catch(() => undefined)
      : Promise.resolve(undefined),
    buildBaselineRepoIntelligenceContext(context, {
      includeRepoOverview: true,
      includeChangedScope: true,
      refreshOverview: options.refresh,
      changedScope: 'all',
      targetPath: options.targetPath,
    }).catch(() => ''),
  ]);

  const capability = buildFallbackCapability(fallbackWarningsForMode(options.mode));
  const recommendedFiles = [
    ...(moduleContext?.module?.entryFiles ?? []),
    ...(impactEstimate?.impactedSymbols?.slice(0, 4).map((symbol) => symbol.filePath) ?? []),
  ].slice(0, 6);
  return {
    routingSignals,
    moduleContext,
    impactEstimate,
    repoContext: repoContext || undefined,
    summary: repoContext
      || impactEstimate?.summary
      || (moduleContext ? `active module: ${moduleContext.module.label}` : undefined),
    recommendedFiles: recommendedFiles.length > 0 ? recommendedFiles : undefined,
    lowConfidence: (routingSignals?.lowConfidence ?? false)
      || (moduleContext?.confidence ?? 1) < 0.72
      || (impactEstimate?.confidence ?? 1) < 0.72,
    capability,
  };
}

export {
  renderImpactEstimate,
  renderModuleContext,
  renderProcessContext,
  renderSymbolContext,
};

/**
 * v0.7.41 L2 — best-effort warm both session-level caches (routing signals +
 * preturn bundle) for a given workspace. Designed to be called fire-and-forget
 * at REPL startup so the first user prompt finds the in-process caches warm.
 *
 * Why this works (and why M1's `refresh:true` design did NOT):
 *   - Uses `refresh: false` (4s budget) — daemon returns its already-cached
 *     state immediately. Total prewarm wall-time is typically 1-2s.
 *   - Daemon's own background polling keeps its state fresh; we don't need
 *     to force a refresh on every REPL startup.
 *   - If user submits BEFORE prewarm completes, P2 in-flight Promise sharing
 *     coalesces both calls onto the same 4s daemon round-trip. The user pays
 *     at most ~2s, NOT the 30s budget that `refresh:true` would burn.
 *   - If user submits AFTER prewarm completes, P3+ session cache (60s TTL)
 *     serves the result in ~0ms.
 *   - The middleware/first-round path (L1) also uses `refresh:false`, so
 *     prewarm and user-path are cache-coherent — the user-path call genuinely
 *     hits the warmed entry instead of being forced to bypass it.
 *
 * Failure modes:
 *   - All calls `.catch(() => {})` — prewarm is best-effort. If the daemon
 *     is down, the first prompt falls back to OSS as before.
 *   - `off` mode short-circuits — no work at all when repo intelligence
 *     is disabled.
 */
export function prewarmRepoIntelligenceCaches(
  context: RepoContext,
  options: { mode?: KodaXRepoIntelligenceMode } = {},
): void {
  const resolved = resolveKodaXAutoRepoMode(options.mode);
  if (resolved === 'off') {
    return;
  }
  if (!context.executionCwd && !context.gitRoot) {
    return;
  }

  // Fire-and-forget — caller does not await.
  void getRepoRoutingSignals(context, {
    mode: options.mode,
    refresh: false,
  }).catch(() => {});

  // Only premium-native uses the heavy preturn bundle path; OSS-only modes
  // don't need to warm it (the OSS fallback path inside getRepoPreturnBundle
  // does git+readdir which is cheap and not worth pre-warming).
  if (resolved === 'premium-native') {
    void getRepoPreturnBundle(context, {
      mode: options.mode,
      refresh: false,
      targetPath: '.',
    }).catch(() => {});
  }
}
