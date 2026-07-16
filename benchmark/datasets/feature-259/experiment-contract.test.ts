import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildFeature259ExperimentManifest,
  FEATURE_259_DECISION_ALIASES,
  FEATURE_259_LAYER_2_CASES,
  FEATURE_259_LAYER_3_FIXTURES,
  writeFeature259ExperimentManifest,
} from './experiment-contract.js';

const input = {
  gitCommit: 'abc123',
  dirtyPatch: 'diff bytes',
  baselinePrompt: 'baseline',
  proposedPrompt: 'proposed',
  baselineToolDescription: 'long tool text',
  proposedToolDescription: 'short hint',
  toolSchemas: [{ name: 'run_workflow' }],
  scoringSource: 'score-v1',
  contextWindow: 128_000,
  resolvedAliases: Object.fromEntries(
    FEATURE_259_DECISION_ALIASES.map((alias) => [alias, { provider: alias, model: 'frozen' }]),
  ),
};

describe('FEATURE_259 frozen experiment contract', () => {
  it('freezes the required panel, cases, quality fixtures, hashes, and spend cap', () => {
    const manifest = buildFeature259ExperimentManifest(input) as Record<string, unknown>;
    expect(manifest.aliases).toEqual(FEATURE_259_DECISION_ALIASES);
    expect(manifest.layer2Cases).toEqual(FEATURE_259_LAYER_2_CASES);
    expect(manifest.layer3Fixtures).toEqual(FEATURE_259_LAYER_3_FIXTURES);
    expect(manifest.hardExternalSpendCapUsd).toBe(75);
    expect(manifest.concurrencyPolicy).toMatch(/ark-coding up to three models/);
    expect(manifest.crossProviderConcurrency).toBe(true);
    expect(manifest.conclusionPolicy).toMatch(/owner decides/);
    expect(manifest.reviewPolicy).toMatch(/main session/);
    expect(manifest.generationSafety).toMatch(/allowGeneration=true/);
    expect(manifest.tokenCoveragePolicy).toMatch(/never estimate/);
    expect(manifest.sourceHashes).toMatchObject({ baselinePrompt: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('writes aggregate contract data to an explicit temp path, never the repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-f259-manifest-'));
    const outputPath = path.join(dir, 'experiment.json');
    try {
      expect(await writeFeature259ExperimentManifest(input, outputPath)).toBe(outputPath);
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toMatchObject({ featureId: 259 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
