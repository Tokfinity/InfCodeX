import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getCostRate } from '@kodax-ai/llm';
import { describe, expect, it } from 'vitest';

import {
  FEATURE_259_DECISION_ALIASES,
  writeFeature259ExperimentManifest,
} from '../benchmark/datasets/feature-259/experiment-contract.js';
import {
  BASELINE_RUN_WORKFLOW_DESCRIPTION,
  buildBaselineWorkerPrompt,
  buildProposedWorkerPrompt,
  PROPOSED_RUN_WORKFLOW_DESCRIPTION,
} from '../benchmark/datasets/feature-259/cases.js';
import {
  runFeature259Layer2,
  runFeature259Layer3,
} from '../benchmark/datasets/feature-259/runner.js';
import { MODEL_ALIASES } from '../benchmark/harness/aliases.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

type Stage = 'manifest' | 'pilot' | 'layer2' | 'layer3' | 'confirm';

const stage = (process.env.KODAX_F259_STAGE ?? 'manifest') as Stage;
const allowed: readonly Stage[] = ['manifest', 'pilot', 'layer2', 'layer3', 'confirm'];

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function writeManifest(): Promise<string> {
  const workflowTool = getToolDefinition('run_workflow');
  if (!workflowTool) throw new Error('run_workflow tool definition is unavailable');
  const resolvedAliases = Object.fromEntries(FEATURE_259_DECISION_ALIASES.map((alias) => {
    const target = MODEL_ALIASES[alias];
    return [alias, { provider: target.provider, model: target.model }];
  }));
  const pricingSnapshot = Object.fromEntries(FEATURE_259_DECISION_ALIASES.map((alias) => {
    const target = MODEL_ALIASES[alias];
    return [alias, getCostRate(target.provider, target.model) ?? null];
  }));
  const scoringSource = [
    readFileSync('benchmark/datasets/feature-259/cases.ts', 'utf8'),
    readFileSync('benchmark/datasets/feature-259/runner.ts', 'utf8'),
  ].join('\n');
  const input = {
    gitCommit: git('rev-parse', 'HEAD'),
    dirtyPatch: git('diff', '--binary', 'HEAD'),
    baselinePrompt: buildBaselineWorkerPrompt(),
    proposedPrompt: buildProposedWorkerPrompt(),
    baselineToolDescription: BASELINE_RUN_WORKFLOW_DESCRIPTION,
    proposedToolDescription: PROPOSED_RUN_WORKFLOW_DESCRIPTION,
    toolSchemas: workflowTool.input_schema,
    scoringSource,
    contextWindow: 128_000,
    resolvedAliases,
    pricingSnapshot,
  };
  const primary = await writeFeature259ExperimentManifest(input);
  await writeFeature259ExperimentManifest(
    input,
    path.join(os.tmpdir(), 'kodax-feature-259-eval-mirror', 'experiment.json'),
  );
  return primary;
}

describe('FEATURE 259 paid decision experiment', () => {
  it('uses a recognized explicitly selected stage', () => {
    expect(allowed).toContain(stage);
  });

  it('freezes the experiment manifest before external calls', async () => {
    const manifestPath = await writeManifest();
    expect(manifestPath).toContain('feature-259');
  });

  it.runIf(stage === 'pilot')('runs the Layer-2 pilot', async () => {
    const result = await runFeature259Layer2('pilot');
    expect(result.complete).toBe(true);
    expect(result.usageCovered).toBe(true);
  }, 20 * 60_000);

  it.runIf(stage === 'layer2')('runs the Layer-2 decision panel', async () => {
    const result = await runFeature259Layer2('layer2');
    expect(result.decisionPassed).toBe(true);
  }, 120 * 60_000);

  it.runIf(stage === 'layer3')('runs the paired Layer-3 topology decision', async () => {
    const result = await runFeature259Layer3('layer3');
    expect(result.decisionPassed).toBe(true);
  }, 120 * 60_000);

  it.runIf(stage === 'confirm')('runs the Layer-3 cross-model confirmation', async () => {
    const result = await runFeature259Layer3('confirm');
    expect(result.decisionPassed).toBe(true);
  }, 60 * 60_000);
});
