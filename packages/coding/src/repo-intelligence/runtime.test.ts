import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getModuleContext,
  getRepoPreturnBundle,
  getRepoRoutingSignals,
  inspectRepoIntelligenceRuntime,
  prewarmRepoIntelligenceCaches,
  resolveKodaXHotPathRepoMode,
  _resetRepoIntelligenceCachesForTesting,
} from './runtime.js';
import { shutdownRepoIntelligenceWorkerForTest } from './semantic-worker-client.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      'export function trimName(name: string): string {',
      '  return name.trim();',
      '}',
      '',
      'export function runApp(name: string): string {',
      '  return trimName(name).toUpperCase();',
      '}',
      '',
    ].join('\n'),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('repo-intelligence runtime facade', () => {
  let tempDir = '';
  const originalEnv = {
    intelligence: process.env.KODAX_REPO_INTELLIGENCE,
    legacyMode: process.env.KODAX_REPO_INTELLIGENCE_MODE,
    legacyEndpoint: process.env.KODAX_REPOINTEL_ENDPOINT,
    legacyBin: process.env.KODAX_REPOINTEL_BIN,
    legacyBuildId: process.env.KODAX_REPOINTEL_BUILD_ID,
    prewarm: process.env.KODAX_PREWARM_REPO_INTELLIGENCE,
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-runtime-ri-'));
    createWorkspaceFixture(tempDir);
    _resetRepoIntelligenceCachesForTesting();
    delete process.env.KODAX_REPO_INTELLIGENCE;
    delete process.env.KODAX_REPO_INTELLIGENCE_MODE;
    delete process.env.KODAX_REPOINTEL_ENDPOINT;
    delete process.env.KODAX_REPOINTEL_BIN;
    delete process.env.KODAX_REPOINTEL_BUILD_ID;
    delete process.env.KODAX_PREWARM_REPO_INTELLIGENCE;
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetRepoIntelligenceCachesForTesting();
    restoreEnv('KODAX_REPO_INTELLIGENCE', originalEnv.intelligence);
    restoreEnv('KODAX_REPO_INTELLIGENCE_MODE', originalEnv.legacyMode);
    restoreEnv('KODAX_REPOINTEL_ENDPOINT', originalEnv.legacyEndpoint);
    restoreEnv('KODAX_REPOINTEL_BIN', originalEnv.legacyBin);
    restoreEnv('KODAX_REPOINTEL_BUILD_ID', originalEnv.legacyBuildId);
    restoreEnv('KODAX_PREWARM_REPO_INTELLIGENCE', originalEnv.prewarm);
    await shutdownRepoIntelligenceWorkerForTest();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      tempDir = '';
    }
  });

  it('uses the built-in full engine by default', async () => {
    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      level: 'enhanced',
      status: 'ok',
    });
    expect(result.module.sourceFileCount).toBeGreaterThan(0);
  });

  it('keeps the shared light profile available', async () => {
    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'light',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'light',
      engine: 'light',
      level: 'basic',
    });
  });

  it('builds preturn bundles from the built-in full engine', async () => {
    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(bundle.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      level: 'enhanced',
    });
    expect(bundle.moduleContext?.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.routingSignals?.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.summary).toContain('active module:');
    expect(bundle.recommendedFiles?.some((file) => file.endsWith('index.ts'))).toBe(true);
  });

  it('does not key the built-in full cache by legacy repointel endpoint', async () => {
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    const first = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47892';
    const second = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(second.summary).toBe(first.summary);
  });

  it('ignores legacy mode and bridge env vars during runtime inspection', async () => {
    process.env.KODAX_REPO_INTELLIGENCE_MODE = 'premium-native';
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    process.env.KODAX_REPOINTEL_BIN = 'C:/tmp/repointel.exe';
    process.env.KODAX_REPOINTEL_BUILD_ID = 'old';

    const inspection = await inspectRepoIntelligenceRuntime();

    expect(inspection.requestedMode).toBe('full');
    expect(inspection.effectiveEngine).toBe('full');
    expect(inspection.warnings.join(' ')).toContain('Ignoring deprecated KODAX_REPO_INTELLIGENCE_MODE');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_ENDPOINT');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_BIN');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_BUILD_ID');
  });

  it('keeps automatic hot paths on the resolved full engine', () => {
    expect(resolveKodaXHotPathRepoMode()).toBe('full');
    expect(resolveKodaXHotPathRepoMode('auto')).toBe('full');
    expect(resolveKodaXHotPathRepoMode('light')).toBe('light');
    expect(resolveKodaXHotPathRepoMode('full')).toBe('full');
    expect(resolveKodaXHotPathRepoMode('off')).toBe('off');
  });

  it('does not prewarm repo intelligence when startup prewarm is disabled', async () => {
    process.env.KODAX_PREWARM_REPO_INTELLIGENCE = '0';
    prewarmRepoIntelligenceCaches({ executionCwd: tempDir }, { mode: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(join(tempDir, '.agent', 'repo-intelligence'))).toBe(false);
  });

  it('does not schedule startup prewarm outside full mode', async () => {
    vi.useFakeTimers();
    process.env.KODAX_REPO_INTELLIGENCE = 'light';

    prewarmRepoIntelligenceCaches({ executionCwd: tempDir }, { mode: 'auto' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(existsSync(join(tempDir, '.agent', 'repo-intelligence'))).toBe(false);
  });

  it('coalesces concurrent routing and preturn requests on the full engine', async () => {
    const context = { executionCwd: tempDir };
    const options = {
      targetPath: 'packages/app/src/index.ts',
      mode: 'full' as const,
    };

    const [routing, bundle] = await Promise.all([
      getRepoRoutingSignals(context, options),
      getRepoPreturnBundle(context, options),
    ]);

    expect(routing.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
  });
});
