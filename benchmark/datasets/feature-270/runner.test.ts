import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { buildFeature270ExperimentManifest } from './experiment-contract.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import {
  assertFeature270Budget,
  readFeature270RawCell,
  runFeature270Layer2,
  runFeature270Layer3,
  runFeature270Pilot,
} from './runner.js';

describe('FEATURE_270 runner safety', () => {
  let directory: string | undefined;
  const rawRoots = new Set<string>();
  const previousAllow = process.env.KODAX_F270_ALLOW_GENERATION;
  const previousAuthorization = process.env.KODAX_F270_AUTHORIZATION;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    for (const rawRoot of rawRoots) await rm(rawRoot, { recursive: true, force: true });
    rawRoots.clear();
    restoreEnvironment('KODAX_F270_ALLOW_GENERATION', previousAllow);
    restoreEnvironment('KODAX_F270_AUTHORIZATION', previousAuthorization);
    runOneShotMock.mockReset();
  });

  it('returns undefined only for a missing raw cell and rejects corrupt evidence', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-f270-raw-'));
    await expect(readFeature270RawCell(path.join(directory, 'missing.json'))).resolves.toBeUndefined();

    const corrupt = path.join(directory, 'corrupt.json');
    await writeFile(corrupt, '{"truncated":', 'utf8');
    await expect(readFeature270RawCell(corrupt)).rejects.toThrow(/corrupt feature-270 raw cell/i);
  });

  it('fails closed before exceeding calls, tokens, or spend', () => {
    expect(() => assertFeature270Budget('layer2', {
      calls: 72, totalTokens: 1, estimatedCostUsd: 0,
    }, 'before-call')).toThrow(/call cap/i);
    expect(() => assertFeature270Budget('layer2', {
      calls: 1, totalTokens: 4_000_000, estimatedCostUsd: 0,
    }, 'before-call')).toThrow(/token cap/i);
    expect(() => assertFeature270Budget('layer3', {
      calls: 1, totalTokens: 1, estimatedCostUsd: 12,
    }, 'before-call')).toThrow(/spend cap/i);
    expect(() => assertFeature270Budget('layer2', {
      calls: 1, totalTokens: 4_000_001, estimatedCostUsd: 0,
    }, 'after-call')).toThrow(/token cap/i);
    expect(() => assertFeature270Budget('layer3', {
      calls: 1, totalTokens: 1, estimatedCostUsd: 12.01,
    }, 'after-call')).toThrow(/spend cap/i);
  });

  it('runs pilot, resume, Layer 2, and two-round Layer 3 with a zero-cost fake provider', async () => {
    process.env.KODAX_F270_ALLOW_GENERATION = '1';
    process.env.KODAX_F270_AUTHORIZATION = 'Unit-test fake provider; no external call.';
    const manifest = buildFeature270ExperimentManifest();
    expect(manifest.rawOutputRoot.startsWith(path.join(os.tmpdir(), 'kodax-eval-dumps'))).toBe(true);
    rawRoots.add(manifest.rawOutputRoot);
    await rm(manifest.rawOutputRoot, { recursive: true, force: true });
    runOneShotMock.mockImplementation(async (alias: ModelAlias) => ({
      alias,
      target: MODEL_ALIASES[alias],
      text: 'Controlled fake-provider response.',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      durationMs: 1,
    }));

    const pilot = await runFeature270Pilot({ allowGeneration: true });
    expect(pilot).toMatchObject({ complete: true, expectedCalls: 6, externalCallsThisRun: 6 });
    expect(runOneShotMock).toHaveBeenCalledTimes(6);

    runOneShotMock.mockClear();
    const resumedPilot = await runFeature270Pilot({ allowGeneration: true });
    expect(resumedPilot.externalCallsThisRun).toBe(0);
    expect(runOneShotMock).not.toHaveBeenCalled();

    const layer2 = await runFeature270Layer2({ allowGeneration: true });
    expect(layer2).toMatchObject({ complete: true, expectedCalls: 72, externalCallsThisRun: 66 });
    const layer3 = await runFeature270Layer3({ allowGeneration: true });
    expect(layer3).toMatchObject({ complete: true, expectedCalls: 24, externalCallsThisRun: 24 });
    expect(runOneShotMock).toHaveBeenCalledTimes(90);

    const evidence = await readFile(
      path.join(manifest.rawOutputRoot, 'layer3', 'main-session-review', 'evidence.json'),
      'utf8',
    );
    const reveal = await readFile(
      path.join(manifest.rawOutputRoot, 'layer3', 'main-session-review', 'reveal.json'),
      'utf8',
    );
    expect(evidence).not.toContain('"arm":"baseline"');
    expect(reveal).toContain('baseline');
    expect(reveal).toContain('treatment');
  }, 30_000);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
