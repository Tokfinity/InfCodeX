import { readFile } from 'node:fs/promises';

import { availableAliases } from '../benchmark/harness/aliases.js';
import {
  buildFeature260ExperimentManifest,
  FEATURE_260_PILOT_ALIAS,
  FEATURE_260_RAW_ROOT,
  writeFeature260ExperimentManifest,
} from '../benchmark/datasets/feature-260/experiment-contract.js';
import {
  runFeature260Pilot,
  runFeature260DecisionPanel,
  writeFeature260BlindedEvidence,
  writeFeature260DecisionBlindedEvidence,
  type Feature260PilotSummary,
} from '../benchmark/datasets/feature-260/runner.js';

describe('FEATURE_260 controlled evaluation', () => {
  it('writes a frozen manifest without making external calls', async () => {
    const manifest = buildFeature260ExperimentManifest() as {
      readonly featureId: number;
      readonly splitHashes: { readonly development: string; readonly sealedHoldout: string };
      readonly pilot: { readonly maxCalls: number; readonly maxExternalSpendUsd: number };
    };
    const manifestPath = await writeFeature260ExperimentManifest();

    expect(manifest.featureId).toBe(260);
    expect(manifest.splitHashes.development).not.toBe(manifest.splitHashes.sealedHoldout);
    expect(manifest.pilot).toMatchObject({ maxCalls: 4, maxExternalSpendUsd: 2 });
    await expect(readFile(manifestPath, 'utf8')).resolves.toContain('f260-v0.7.68.2');
  });

  it('materializes blinded evidence from an existing local pilot', async () => {
    const summaryPath = `${FEATURE_260_RAW_ROOT}/pilot/summary.json`;
    let summary: Feature260PilotSummary | undefined;
    try {
      summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Feature260PilotSummary;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (summary === undefined) return;

    await writeFeature260BlindedEvidence(summary);
    await expect(readFile(
      `${FEATURE_260_RAW_ROOT}/pilot/main-session-review/evidence.json`,
      'utf8',
    )).resolves.not.toContain('"arm": "candidate"');
  });

  it('materializes blinded paired evidence from an existing decision panel', async () => {
    const summaryPath = `${FEATURE_260_RAW_ROOT}/decision/summary.json`;
    try {
      await readFile(summaryPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }

    await writeFeature260DecisionBlindedEvidence();
    await expect(readFile(
      `${FEATURE_260_RAW_ROOT}/decision/main-session-review/evidence.json`,
      'utf8',
    )).resolves.not.toContain('"arm": "candidate"');
  });

  const pilotEnabled = process.env.KODAX_F260_STAGE === 'pilot'
    && process.env.KODAX_F260_ALLOW_GENERATION === '1'
    && availableAliases(FEATURE_260_PILOT_ALIAS).length === 1;

  it.skipIf(!pilotEnabled)('runs the bounded one-alias development pilot', async () => {
    const summary = await runFeature260Pilot({
      allowGeneration: true,
      alias: FEATURE_260_PILOT_ALIAS,
    });

    expect(summary.complete).toBe(true);
    expect(summary.calls).toBe(4);
    expect(summary.estimatedCostUsd).toBeLessThanOrEqual(summary.hardSpendCapUsd);
  }, 300_000);

  const decisionEnabled = process.env.KODAX_F260_STAGE === 'decision'
    && process.env.KODAX_F260_ALLOW_GENERATION === '1'
    && availableAliases(FEATURE_260_PILOT_ALIAS).length === 1;

  it.skipIf(!decisionEnabled)('runs or resumes the frozen 520-call decision panel', async () => {
    const summary = await runFeature260DecisionPanel({
      allowGeneration: true,
      alias: FEATURE_260_PILOT_ALIAS,
    });

    expect(summary.complete).toBe(true);
    expect(summary.totalCells).toBe(520);
    expect(summary.estimatedCostUsd).toBeLessThanOrEqual(0.02);
    expect(summary.passed).toBe(true);
  }, 3_600_000);
});

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
