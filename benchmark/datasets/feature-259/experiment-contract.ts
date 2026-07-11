import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FEATURE_259_DECISION_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
] as const;

export const FEATURE_259_LAYER_2_CASES = [
  'workflow-selection',
  'explicit-tier-intent',
  'judgment-refuses-fast',
  'focused-briefing',
  'terse-structured-review',
  'requirements-not-verifiable',
] as const;

export const FEATURE_259_LAYER_3_FIXTURES = [
  { id: 'edge-condition', severity: 'medium', disposition: 'confirmed', layout: 'one', risk: false, standardReview: true },
  { id: 'trust-boundary', severity: 'critical', disposition: 'confirmed', layout: 'one', risk: true, standardReview: false },
  { id: 'shared-state', severity: 'high', disposition: 'confirmed', layout: 'two-plus-cross', risk: true, standardReview: false },
  { id: 'misleading-test', severity: 'medium', disposition: 'confirmed', layout: 'one', risk: false, standardReview: true },
  { id: 'extra-feature', severity: 'medium', disposition: 'confirmed', layout: 'one', risk: false, standardReview: true },
  { id: 'requirement-not-provable', severity: null, disposition: 'not-verifiable', layout: 'one', risk: false, standardReview: true },
  { id: 'plan-mandated-defect', severity: 'high', disposition: 'confirmed', layout: 'one', risk: true, standardReview: false },
  { id: 'clean-control', severity: null, disposition: 'approved', layout: 'one', risk: false, standardReview: true },
] as const;

export interface Feature259ExperimentInput {
  readonly gitCommit: string;
  readonly dirtyPatch: string;
  readonly baselinePrompt: string;
  readonly proposedPrompt: string;
  readonly baselineToolDescription: string;
  readonly proposedToolDescription: string;
  readonly toolSchemas: unknown;
  readonly scoringSource: string;
  readonly contextWindow: number;
  readonly resolvedAliases: Readonly<Record<string, { readonly provider: string; readonly model: string }>>;
  readonly pricingSnapshot?: unknown;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildFeature259ExperimentManifest(input: Feature259ExperimentInput): object {
  return {
    schemaVersion: 1,
    featureId: 259,
    gitCommit: input.gitCommit,
    dirtyPatchHash: hash(input.dirtyPatch),
    sourceHashes: {
      baselinePrompt: hash(input.baselinePrompt),
      proposedPrompt: hash(input.proposedPrompt),
      baselineToolDescription: hash(input.baselineToolDescription),
      proposedToolDescription: hash(input.proposedToolDescription),
      toolSchemas: hash(JSON.stringify(input.toolSchemas)),
      scoring: hash(input.scoringSource),
    },
    exactBytes: {
      baselinePrompt: input.baselinePrompt,
      proposedPrompt: input.proposedPrompt,
      baselineToolDescription: input.baselineToolDescription,
      proposedToolDescription: input.proposedToolDescription,
    },
    contextWindow: input.contextWindow,
    aliases: FEATURE_259_DECISION_ALIASES,
    resolvedAliases: input.resolvedAliases,
    effort: 'provider-default-frozen-per-cell',
    temperature: 'provider-default-frozen-per-cell',
    concurrencyPerAlias: 1,
    fallbackRule: 'rerun both arms of every affected pair on the same canonical fallback',
    timeoutMs: 120_000,
    repetitions: { pilot: 1, decision: 5 },
    layer2Cases: FEATURE_259_LAYER_2_CASES,
    layer3Fixtures: FEATURE_259_LAYER_3_FIXTURES,
    callGraphs: {
      baselineReview: ['four-primary-lenses', 'final-synthesis'],
      proposedReview: ['one-primary-per-packet', 'optional-high-risk-primary', 'finding-batch-verifier', 'final-synthesis'],
    },
    pairedTokenCells: 'every alias × case × repetition × arm pair',
    tokenCoveragePolicy: 'missing required usage invalidates the pair; never estimate',
    judgePolicy: 'automated scoring requires manual audit; excessive disagreement invalidates the run',
    rawOutputRoot: path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-259'),
    pricingSnapshot: input.pricingSnapshot ?? null,
    estimatedExternalSpendUsd: 75,
    hardExternalSpendCapUsd: 75,
    decisionsEnabled: [
      'resident workflow teaching non-inferiority',
      'tier-intent quality',
      'terse-output fidelity',
      'review quality and packet-read reduction',
    ],
  };
}

export async function writeFeature259ExperimentManifest(
  input: Feature259ExperimentInput,
  outputPath = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-259', 'experiment.json'),
): Promise<string> {
  const manifest = buildFeature259ExperimentManifest(input);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return outputPath;
}
