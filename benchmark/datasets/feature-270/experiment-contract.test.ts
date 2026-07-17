import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FEATURE_270_LIMITS,
  assertFeature270GenerationAuthorized,
  buildFeature270ExperimentManifest,
  feature270Pricing,
  hashFeature270SourceSnapshot,
} from './experiment-contract.js';

describe('FEATURE_270 experiment contract', () => {
  it('freezes the preregistered call, token, timeout, and spend ceilings', () => {
    expect(FEATURE_270_LIMITS).toEqual({
      layer2: {
        maxProviderCalls: 60,
        maxCallsPerCell: 1,
        maxRoundsPerCell: 1,
        maxOutputTokensPerCall: 1_500,
        maxTotalTokens: 4_000_000,
        timeoutMs: 120_000,
        maxExternalSpendUsd: 6,
      },
      layer3: {
        maxProviderCalls: 24,
        maxCallsPerCell: 2,
        maxRoundsPerCell: 2,
        maxOutputTokensPerCall: 1_500,
        maxTotalTokens: 2_000_000,
        timeoutMs: 120_000,
        maxExternalSpendUsd: 12,
      },
    });
  });

  it('binds untracked paths and bytes into the experiment revision', () => {
    const base = hashFeature270SourceSnapshot('tracked', [
      { path: 'new/a.ts', content: Buffer.from('alpha') },
      { path: 'new/b.ts', content: Buffer.from('beta') },
    ]);
    const reordered = hashFeature270SourceSnapshot('tracked', [
      { path: 'new/b.ts', content: Buffer.from('beta') },
      { path: 'new/a.ts', content: Buffer.from('alpha') },
    ]);
    const changed = hashFeature270SourceSnapshot('tracked', [
      { path: 'new/a.ts', content: Buffer.from('changed') },
      { path: 'new/b.ts', content: Buffer.from('beta') },
    ]);

    expect(reordered).toEqual(base);
    expect(changed.combinedSha256).not.toBe(base.combinedSha256);
  });

  it('builds a manifest outside the repository with paid generation held', () => {
    const manifest = buildFeature270ExperimentManifest();

    expect(manifest.featureId).toBe(270);
    expect(manifest.authorization).toBe('pending-explicit-owner-approval');
    expect(manifest.rawOutputRoot).toContain(path.join('kodax-eval-dumps', 'feature-270'));
    expect(manifest.rawOutputRoot).not.toContain(process.cwd());
    expect(manifest.exactBytes.baselinePromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.exactBytes.treatmentToolsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('freezes a pre-call price for the historical routed GLM alias', () => {
    expect(feature270Pricing('zhipu/glm51')).toEqual({
      rate: { inputPer1M: 0.05, outputPer1M: 0.1 },
      source: 'zhipu-coding/glm-5.2 nominal rate for the upstream-routed glm-5.1 alias',
    });
    expect(feature270Pricing('mmx/m27').source).toBe('minimax-coding/MiniMax-M2.7');
  });

  it('requires both an explicit caller flag and the paid-generation environment gate', () => {
    expect(() => assertFeature270GenerationAuthorized(false, {})).toThrow(/disabled/i);
    expect(() => assertFeature270GenerationAuthorized(true, {})).toThrow(/KODAX_F270_ALLOW_GENERATION/);
    expect(() => assertFeature270GenerationAuthorized(true, {
      KODAX_F270_ALLOW_GENERATION: '1',
    })).toThrow(/KODAX_F270_AUTHORIZATION/);
    expect(() => assertFeature270GenerationAuthorized(true, {
      KODAX_F270_ALLOW_GENERATION: '1',
      KODAX_F270_AUTHORIZATION: 'Owner approved the bounded $18 eval.',
    })).not.toThrow();
  });
});
