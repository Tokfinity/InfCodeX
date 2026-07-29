import { describe, expect, it } from 'vitest';

import {
  buildFeature263RunManifest,
  runFeature263Downstream,
  runFeature263ReviewerPilot,
  runFeature263ReviewerSafetyPanel,
} from '../benchmark/datasets/feature-263/runner.js';

type Stage = 'manifest' | 'pilot' | 'safety' | 'downstream';

const stage = (process.env.KODAX_F263_STAGE ?? 'manifest') as Stage;
const allowGeneration = process.env.KODAX_F263_ALLOW_GENERATION === '1';
const allowedStages: readonly Stage[] = ['manifest', 'pilot', 'safety', 'downstream'];

describe('FEATURE_263 frozen learning release experiment', () => {
  it('uses a recognized explicitly selected stage', () => {
    expect(allowedStages).toContain(stage);
  });

  it('freezes the exact candidate and production review/action bytes', async () => {
    const manifest = await buildFeature263RunManifest();
    expect(manifest.sourcePatchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.limits.maxProviderCalls).toBe(78);
    expect(manifest.limits.maxExternalSpendUsd).toBe(10);
  });

  it.runIf(stage === 'pilot')('runs the four-call reviewer validity pilot', async () => {
    const result = await runFeature263ReviewerPilot({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(4);
  }, 15 * 60_000);

  it.runIf(stage === 'safety')('runs the inclusive reviewer safety panel', async () => {
    const result = await runFeature263ReviewerSafetyPanel({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(54);
    expect(result.totalBudget.estimatedCostUsd).toBeLessThanOrEqual(10);
  }, 180 * 60_000);

  it.runIf(stage === 'downstream')('runs the blinded downstream A/B panel', async () => {
    const result = await runFeature263Downstream({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(24);
    expect(result.totalBudget.estimatedCostUsd).toBeLessThanOrEqual(10);
  }, 120 * 60_000);
});
