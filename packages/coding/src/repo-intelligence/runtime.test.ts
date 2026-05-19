import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./premium-client.js', async () => {
  const actual = await vi.importActual<typeof import('./premium-client.js')>('./premium-client.js');
  return {
    ...actual,
    callPremiumDaemon: vi.fn(),
  };
});

import { callPremiumDaemon } from './premium-client.js';
import {
  getModuleContext,
  getRepoPreturnBundle,
  getRepoRoutingSignals,
  _resetRepoIntelligenceCachesForTesting,
} from './runtime.js';
import { getModuleContext as getFallbackModuleContext } from './query.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      'export function runApp(name: string): string {',
      '  return name.trim();',
      '}',
      '',
    ].join('\n'),
  );
}

describe('repo-intelligence runtime facade', () => {
  let tempDir = '';
  const mockedCallPremiumDaemon = vi.mocked(callPremiumDaemon);
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-runtime-ri-'));
    createWorkspaceFixture(tempDir);
    mockedCallPremiumDaemon.mockReset();
    // v0.7.41: drop module-singleton caches so prior tests don't leak
    // resolved values into the next test's mocked-daemon scenario.
    _resetRepoIntelligenceCachesForTesting();
    originalEndpoint = process.env.KODAX_REPOINTEL_ENDPOINT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetRepoIntelligenceCachesForTesting();
    if (originalEndpoint === undefined) {
      delete process.env.KODAX_REPOINTEL_ENDPOINT;
    } else {
      process.env.KODAX_REPOINTEL_ENDPOINT = originalEndpoint;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('falls back to the OSS baseline when premium is unavailable', async () => {
    mockedCallPremiumDaemon.mockResolvedValue(null);

    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'oss',
      engine: 'oss',
      level: 'basic',
    });
    expect(result.capability?.warnings.join(' ')).toContain('Premium repo intelligence unavailable');
  });

  it('preserves premium preturn metadata and summaries when the daemon responds', async () => {
    const fallbackModuleContext = await getFallbackModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: '.',
      },
    );

    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        cacheHit: true,
        trace: {
          capsuleEstimatedTokens: 111,
        },
        result: {
          summary: 'premium preturn summary',
          repoContext: 'premium repo context',
          recommendedFiles: ['packages/app/src/index.ts'],
          lowConfidence: false,
          moduleContext: fallbackModuleContext,
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 9,
        cacheHit: true,
        capsuleEstimatedTokens: 111,
      },
    });

    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(bundle.summary).toBe('premium preturn summary');
    expect(bundle.repoContext).toBe('premium repo context');
    expect(bundle.recommendedFiles).toEqual(['packages/app/src/index.ts']);
    expect(bundle.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
      bridge: 'native',
      level: 'enhanced',
      contractVersion: 1,
    });
    expect(bundle.trace).toMatchObject({
      daemonLatencyMs: 9,
      capsuleEstimatedTokens: 111,
      cacheHit: true,
    });
    expect(bundle.moduleContext?.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
    });
  });

  it('reuses the same premium preturn response across routing and prompt preturn calls', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'shared premium preturn',
          repoContext: 'repo context',
          recommendedFiles: ['packages/app/src/index.ts'],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 5,
      },
    });

    const context = { executionCwd: tempDir };
    const routing = await getRepoRoutingSignals(context, {
      targetPath: '.',
      mode: 'premium-native',
    });
    const bundle = await getRepoPreturnBundle(context, {
      targetPath: '.',
      mode: 'premium-native',
    });

    expect(routing.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
    });
    expect(bundle.summary).toBe('shared premium preturn');
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
  });

  it('falls back to OSS when premium returns malformed preturn payloads', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'bad payload',
          moduleContext: {
            freshness: 'now',
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
      },
    });

    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(bundle.capability).toMatchObject({
      mode: 'oss',
      engine: 'oss',
      level: 'basic',
    });
    expect(bundle.summary).not.toBe('bad payload');
  });

  it('does not reuse a cached premium preturn after switching the repointel endpoint', async () => {
    mockedCallPremiumDaemon
      .mockResolvedValueOnce({
        response: {
          contractVersion: 1,
          status: 'ok',
          result: {
            summary: 'endpoint-one',
            repoContext: 'repo context one',
            recommendedFiles: ['packages/app/src/index.ts'],
            lowConfidence: false,
          },
        },
        trace: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          triggeredAt: '2026-04-01T00:00:00.000Z',
          source: 'premium',
          daemonLatencyMs: 4,
        },
      })
      .mockResolvedValueOnce({
        response: {
          contractVersion: 1,
          status: 'ok',
          result: {
            summary: 'endpoint-two',
            repoContext: 'repo context two',
            recommendedFiles: ['packages/app/src/index.ts'],
            lowConfidence: false,
          },
        },
        trace: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          triggeredAt: '2026-04-01T00:00:01.000Z',
          source: 'premium',
          daemonLatencyMs: 6,
        },
      });

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    const first = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47892';
    const second = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(first.summary).toBe('endpoint-one');
    expect(second.summary).toBe('endpoint-two');
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(2);
  });

  // v0.7.41 P2 — in-flight Promise sharing across same-round duplicate
  // callers. Pre-fix the 1.5s TTL coalesced nothing when daemon latency
  // exceeded the window; this test pins that *concurrent* duplicate calls
  // (overlapping in time, regardless of latency) share one round-trip.
  it('P2: in-flight preturn calls coalesce into one daemon call when fired concurrently', async () => {
    // Deferred daemon — resolves only when we say so, so both calls land
    // while the first call is still in-flight (worst-case for coalescing).
    let resolveDaemon!: (value: Parameters<typeof mockedCallPremiumDaemon.mockResolvedValue>[0]) => void;
    mockedCallPremiumDaemon.mockImplementationOnce(() => new Promise((res) => {
      resolveDaemon = res as typeof resolveDaemon;
    }));

    const ctx = { executionCwd: tempDir };
    const opts = { targetPath: '.', mode: 'premium-native' as const };

    // Fire both calls concurrently. Internally each calls tryPremiumPreturn
    // with the same cacheKey — they must share the single in-flight Promise.
    const routingPromise = getRepoRoutingSignals(ctx, opts);
    const bundlePromise = getRepoPreturnBundle(ctx, opts);

    // Settle the deferred daemon.
    resolveDaemon({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'shared',
          repoContext: 'ctx',
          recommendedFiles: [],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-05-18T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 1,
      },
    });

    await Promise.all([routingPromise, bundlePromise]);
    // ONE daemon call services both consumers.
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
  });

  // v0.7.41 P3 — cross-call routing-signals memoization. A second
  // `getRepoRoutingSignals` with the same cacheKey must hit cache and
  // NOT trigger a fresh daemon call. Pre-fix every round did a fresh
  // daemon roundtrip.
  it('P3: a second getRepoRoutingSignals with same cacheKey hits the cross-call cache', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'first',
          repoContext: 'ctx',
          recommendedFiles: [],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-05-18T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 1,
      },
    });

    const ctx = { executionCwd: tempDir };
    const opts = { targetPath: '.', mode: 'premium-native' as const };

    const a = await getRepoRoutingSignals(ctx, opts);
    const b = await getRepoRoutingSignals(ctx, opts);
    // Same daemon call serves both rounds (1 not 2).
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
    // Result identity preserved (same cached promise).
    expect(a.activeModuleId).toBe(b.activeModuleId);
  });

  // v0.7.41 P3 — semantics update: `refresh:true` within TTL must still hit
  // the cache, because the cached data IS fresh (resolved within TTL). This
  // is what lets startup prewarm (refresh:true) cover the first-round
  // refresh:true call from buildAutoRepoIntelligenceContext — without this,
  // prewarm would do daemon work the first round throws away.
  it('P3: refresh:true within TTL still hits the fresh cache (prewarm/first-round coalesce)', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'r',
          repoContext: 'ctx',
          recommendedFiles: [],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-05-18T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 1,
      },
    });

    const ctx = { executionCwd: tempDir };
    // Cache-key invariant: refresh value MUST NOT be part of cacheKey, so
    // calls with different refresh values share the same entry. This is
    // exercised under the strictest scenario (both refresh:true, the budget
    // hog), which strictly dominates the actual production path where
    // both prewarm (L2) and first-round (L1) use refresh:false.
    await getRepoRoutingSignals(ctx, { targetPath: '.', mode: 'premium-native', refresh: true });
    await getRepoRoutingSignals(ctx, { targetPath: '.', mode: 'premium-native', refresh: true });
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
  });

  // v0.7.41 P3+ — preturn bundle session cache. Same cache-key invariant as
  // routing signals: any refresh combination shares one entry. Production
  // path after L1/L2 is refresh:false everywhere; this test asserts the
  // invariant under the harder refresh:true scenario.
  it('P3+: getRepoPreturnBundle shares one daemon call across prewarm + multiple rounds', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'shared bundle',
          repoContext: 'ctx',
          recommendedFiles: [],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-05-18T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 1,
      },
    });

    const ctx = { executionCwd: tempDir };
    // Three calls, mixed refresh values — cacheKey ignores refresh so all
    // three share one daemon round-trip. Production path (post L1/L2) only
    // ever uses refresh:false; the refresh:true calls below are the strictest
    // regression check on the cacheKey invariant.
    await getRepoPreturnBundle(ctx, { targetPath: '.', mode: 'premium-native', refresh: true });
    await getRepoPreturnBundle(ctx, { targetPath: '.', mode: 'premium-native', refresh: true });
    await getRepoPreturnBundle(ctx, { targetPath: '.', mode: 'premium-native' });
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
  });
});
