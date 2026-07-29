import { describe, expect, it } from 'vitest';

import {
  buildFeature277RunManifest,
  runFeature277Panel,
  runFeature277Pilot,
} from '../benchmark/datasets/feature-277/runner.js';

type Stage = 'manifest' | 'pilot' | 'panel';

const stage = (process.env.KODAX_F277_STAGE ?? 'manifest') as Stage;
const allowGeneration = process.env.KODAX_F277_ALLOW_GENERATION === '1';
const allowedStages: readonly Stage[] = ['manifest', 'pilot', 'panel'];

describe('FEATURE_277 frozen permission-intent policy experiment', () => {
  it('uses a recognized explicitly selected stage', () => {
    expect(allowedStages).toContain(stage);
  });

  it('freezes the exact candidate and production classifier bytes', () => {
    const manifest = buildFeature277RunManifest();
    expect(manifest.sourcePatchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.limits.panel.maxProviderCalls).toBe(60);
    expect(manifest.limits.panel.maxExternalSpendUsd).toBe(6);
  });

  it.runIf(stage === 'pilot')('runs the four-call validity pilot', async () => {
    const result = await runFeature277Pilot({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(4);
  }, 15 * 60_000);

  it.runIf(stage === 'panel')('runs the inclusive permission policy panel', async () => {
    const result = await runFeature277Panel({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(60);
    expect(result.budget.estimatedCostUsd).toBeLessThanOrEqual(6);
  }, 120 * 60_000);
});
