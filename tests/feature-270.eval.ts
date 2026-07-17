import { describe, expect, it } from 'vitest';

import {
  buildFeature270ExperimentManifest,
  writeFeature270ExperimentManifest,
} from '../benchmark/datasets/feature-270/experiment-contract.js';
import {
  runFeature270Layer2,
  runFeature270Layer3,
  runFeature270Pilot,
} from '../benchmark/datasets/feature-270/runner.js';

type Stage = 'manifest' | 'pilot' | 'layer2' | 'layer3';

const stage = (process.env.KODAX_F270_STAGE ?? 'manifest') as Stage;
const allowGeneration = process.env.KODAX_F270_ALLOW_GENERATION === '1';
const allowedStages: readonly Stage[] = ['manifest', 'pilot', 'layer2', 'layer3'];

describe('FEATURE_270 bounded collaboration-policy experiment', () => {
  it('uses a recognized explicitly selected stage', () => {
    expect(allowedStages).toContain(stage);
  });

  it('freezes the manifest before any optional provider call', async () => {
    const manifest = buildFeature270ExperimentManifest();
    const target = await writeFeature270ExperimentManifest(manifest);

    expect(target).toContain('feature-270');
    expect(manifest.limits.layer2.maxExternalSpendUsd
      + manifest.limits.layer3.maxExternalSpendUsd).toBe(18);
  });

  it.runIf(stage === 'pilot')('runs the four-call validity pilot', async () => {
    const result = await runFeature270Pilot({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(4);
    expect(result.reviewStatus).toBe('pending-main-session-blind-review');
  }, 15 * 60_000);

  it.runIf(stage === 'layer2')('runs the 60-call single-turn comparison', async () => {
    const result = await runFeature270Layer2({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(60);
    expect(result.budget.estimatedCostUsd).toBeLessThanOrEqual(6);
  }, 180 * 60_000);

  it.runIf(stage === 'layer3')('runs the 24-call fixed two-round comparison', async () => {
    const result = await runFeature270Layer3({ allowGeneration });
    expect(result.complete).toBe(true);
    expect(result.expectedCalls).toBe(24);
    expect(result.budget.estimatedCostUsd).toBeLessThanOrEqual(12);
  }, 120 * 60_000);
});
