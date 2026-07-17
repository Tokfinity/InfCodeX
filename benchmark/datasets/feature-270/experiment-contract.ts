import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getCostRate, type CostRate } from '@kodax-ai/llm';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import {
  FEATURE_270_LAYER_2_CASE_IDS,
  FEATURE_270_LAYER_3_CASE_IDS,
  buildFeature270Layer2Input,
  buildFeature270Layer3Round1,
  buildFeature270Layer3Round2,
  buildFeature270TreatmentPrompt,
  feature270BaselinePrompt,
  feature270ToolsForArm,
  type Feature270Arm,
} from './cases.js';

export const FEATURE_270_BASELINE_COMMIT =
  'a8c9c28330796a4827c4e44f135f1f42481e31ac';

export const FEATURE_270_ALIASES = ['zhipu/glm51', 'mmx/m27'] as const;
export const FEATURE_270_LAYER_3_ALIAS = 'zhipu/glm51' as const;

export const FEATURE_270_LIMITS = {
  layer2: {
    maxProviderCalls: 60,
    maxCallsPerCell: 1,
    maxRoundsPerCell: 1,
    maxOutputTokensPerCall: 6_000,
    maxTotalTokens: 4_000_000,
    timeoutMs: 120_000,
    maxExternalSpendUsd: 6,
  },
  layer3: {
    maxProviderCalls: 24,
    maxCallsPerCell: 2,
    maxRoundsPerCell: 2,
    maxOutputTokensPerCall: 6_000,
    maxTotalTokens: 2_000_000,
    timeoutMs: 120_000,
    maxExternalSpendUsd: 12,
  },
} as const;

export interface Feature270SourceSnapshot {
  readonly trackedPatchSha256: string;
  readonly untrackedFilesSha256: string;
  readonly combinedSha256: string;
  readonly untrackedFileCount: number;
}

export interface Feature270ExperimentManifest {
  readonly schemaVersion: 1;
  readonly featureId: 270;
  readonly release: '0.7.72';
  readonly revision: string;
  readonly gitCommit: string;
  readonly baselineCommit: string;
  readonly sourceSnapshot: Feature270SourceSnapshot;
  readonly exactBytes: {
    readonly baselinePromptSha256: string;
    readonly baselinePrompt: string;
    readonly treatmentPromptSha256: string;
    readonly treatmentPrompt: string;
    readonly baselineToolsSha256: string;
    readonly baselineTools: unknown;
    readonly treatmentToolsSha256: string;
    readonly treatmentTools: unknown;
  };
  readonly cases: unknown;
  readonly aliases: unknown;
  readonly evaluationPlan: unknown;
  readonly rubric: unknown;
  readonly limits: typeof FEATURE_270_LIMITS;
  readonly rawOutputRoot: string;
  readonly authorization: string;
  readonly generationSafety: string;
  readonly reviewPolicy: string;
  readonly conclusionPolicy: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFeature270SourceSnapshot(
  trackedPatch: string,
  untrackedFiles: readonly { readonly path: string; readonly content: Buffer }[],
): Feature270SourceSnapshot {
  const entries = untrackedFiles
    .map((entry) => ({
      path: entry.path.replaceAll('\\', '/'),
      sha256: sha256(entry.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const trackedPatchSha256 = sha256(trackedPatch);
  const untrackedFilesSha256 = sha256(JSON.stringify(entries));
  return {
    trackedPatchSha256,
    untrackedFilesSha256,
    combinedSha256: sha256(JSON.stringify({ trackedPatchSha256, entries })),
    untrackedFileCount: entries.length,
  };
}

export function buildFeature270ExperimentManifest(): Feature270ExperimentManifest {
  const gitCommit = git('rev-parse', 'HEAD').trim();
  const trackedPatch = git('diff', '--binary', '--submodule=diff', 'HEAD');
  const untrackedPaths = gitBuffer('ls-files', '--others', '--exclude-standard', '-z')
    .toString('utf8').split('\0').filter(Boolean);
  const sourceSnapshot = hashFeature270SourceSnapshot(
    trackedPatch,
    untrackedPaths.map((filePath) => ({ path: filePath, content: readFileSync(filePath) })),
  );
  const exactBytes = exactProductionBytes();
  const cases = frozenCases();
  const aliases = frozenAliases();
  const revision = experimentRevision(gitCommit, sourceSnapshot, exactBytes, cases, aliases);
  return {
    schemaVersion: 1,
    featureId: 270,
    release: '0.7.72',
    revision,
    gitCommit,
    baselineCommit: FEATURE_270_BASELINE_COMMIT,
    sourceSnapshot,
    exactBytes,
    cases,
    aliases,
    evaluationPlan: evaluationPlan(),
    rubric: experimentRubric(),
    limits: FEATURE_270_LIMITS,
    rawOutputRoot: path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-270', revision),
    authorization: process.env.KODAX_F270_AUTHORIZATION?.trim()
      || 'pending-explicit-owner-approval',
    generationSafety: 'manifest-only by default; calls require allowGeneration=true and KODAX_F270_ALLOW_GENERATION=1 after owner approval',
    reviewPolicy: 'current main session reviews blinded paired raw evidence before reveal; mechanical scores are diagnostic only',
    conclusionPolicy: 'recommend-ship | recommend-iterate | recommend-revert | eval-invalid; owner decides',
  };
}

function exactProductionBytes(): Feature270ExperimentManifest['exactBytes'] {
  const baselinePrompt = feature270BaselinePrompt();
  const treatmentPrompt = buildFeature270TreatmentPrompt();
  const baselineTools = feature270ToolsForArm('baseline');
  const treatmentTools = feature270ToolsForArm('treatment');
  return {
    baselinePromptSha256: sha256(baselinePrompt),
    baselinePrompt,
    treatmentPromptSha256: sha256(treatmentPrompt),
    treatmentPrompt,
    baselineToolsSha256: sha256(JSON.stringify(baselineTools)),
    baselineTools,
    treatmentToolsSha256: sha256(JSON.stringify(treatmentTools)),
    treatmentTools,
  };
}

function experimentRevision(
  gitCommit: string,
  sourceSnapshot: Feature270SourceSnapshot,
  exactBytes: Feature270ExperimentManifest['exactBytes'],
  cases: unknown,
  aliases: unknown,
): string {
  return sha256(JSON.stringify({
    gitCommit,
    sourceSnapshot: sourceSnapshot.combinedSha256,
    baselinePrompt: exactBytes.baselinePromptSha256,
    treatmentPrompt: exactBytes.treatmentPromptSha256,
    baselineTools: exactBytes.baselineToolsSha256,
    treatmentTools: exactBytes.treatmentToolsSha256,
    cases,
    aliases,
    scoring: scoringSourceHash(),
  })).slice(0, 16);
}

function evaluationPlan(): object {
  return {
    pilot: {
      alias: 'zhipu/glm51', cases: ['parallel', 'no_workflow'],
      arms: ['baseline', 'treatment'], repetitions: 1, calls: 4,
      reuse: 'the same repetition-0 cells are reused by Layer 2',
    },
    layer2: {
      aliases: FEATURE_270_ALIASES, cases: FEATURE_270_LAYER_2_CASE_IDS,
      arms: ['baseline', 'treatment'], repetitions: 3, calls: 60,
    },
    layer3: {
      alias: FEATURE_270_LAYER_3_ALIAS, cases: FEATURE_270_LAYER_3_CASE_IDS,
      arms: ['baseline', 'treatment'], repetitions: 2, rounds: 2, calls: 24,
    },
    retriesAddedByHarness: 0,
    concurrency: 'one call per provider; this driver runs cells sequentially',
  };
}

function experimentRubric(): object {
  return {
    primaryMetrics: [
      'decision quality', 'unnecessary Agent starts', 'three-non-root-slot compliance',
      'explicit capacity recovery', 'feedback-driven replanning',
      'explicit Workflow-request compliance', 'unintended Workflow activation',
      'input and output tokens',
    ],
    layer2TreatmentThresholds: {
      solo: 'at least 5/6 remain solo',
      parallel: 'at least 5/6 start two useful independent lanes; 6/6 start no more than three',
      capacity: 'at least 5/6 wait/list/replan; 0/6 immediate extra starts',
      explicitWorkflow: 'at least 5/6 use the named Workflow',
      noWorkflow: '0/6 activate Workflow',
      blindQuality: 'non-inferior in at least 25/30 pairs with no severe correctness loss',
    },
    layer3TreatmentThreshold: 'at least 5/6 journeys revise objective, specialist mix, or topology and never replay the invalid plan',
    tokenThresholds: {
      layer2SoloMedian: 'at most 1.15x baseline',
      layer3JourneyTotal: 'at most 1.25x baseline',
    },
    mechanicalScorePolicy: 'diagnostic only; negatives use structured calls; text fallback covers four syntax families',
    semanticReviewPolicy: 'blind paired main-session review determines validity, value, harm, and recommendation before reveal',
  };
}

function frozenCases(): object {
  const arms: readonly Feature270Arm[] = ['baseline', 'treatment'];
  return {
    layer2: FEATURE_270_LAYER_2_CASE_IDS.flatMap((caseId) => arms.map((arm) => ({
      caseId,
      arm,
      input: buildFeature270Layer2Input(caseId, arm),
    }))),
    layer3: FEATURE_270_LAYER_3_CASE_IDS.flatMap((caseId) => arms.map((arm) => ({
      caseId,
      arm,
      round1: buildFeature270Layer3Round1(caseId),
      round2Template: buildFeature270Layer3Round2(caseId, arm, '<round-1-text>', [
        { name: '<round-1-tool>', input: {} },
      ]),
    }))),
  };
}

function frozenAliases(): object {
  return {
    layer2: Object.fromEntries(FEATURE_270_ALIASES.map((alias) => aliasEntry(alias))),
    layer3: Object.fromEntries([FEATURE_270_LAYER_3_ALIAS].map((alias) => aliasEntry(alias))),
  };
}

function aliasEntry(alias: typeof FEATURE_270_ALIASES[number]): readonly [string, object] {
  const target = MODEL_ALIASES[alias];
  const pricing = feature270Pricing(alias);
  return [alias, {
    provider: target.provider,
    model: target.model,
    pricing,
  }];
}

export function feature270Pricing(alias: ModelAlias): {
  readonly rate: CostRate;
  readonly source: string;
} {
  const target = MODEL_ALIASES[alias];
  const exact = getCostRate(target.provider, target.model);
  if (exact !== undefined) {
    return { rate: exact, source: `${target.provider}/${target.model}` };
  }
  if (alias === 'zhipu/glm51') {
    const routed = getCostRate('zhipu-coding', 'glm-5.2');
    if (routed !== undefined) {
      return {
        rate: routed,
        source: 'zhipu-coding/glm-5.2 nominal rate for the upstream-routed glm-5.1 alias',
      };
    }
  }
  throw new Error(`feature-270 pricing unavailable for ${target.provider}/${target.model}`);
}

function scoringSourceHash(): string {
  const source = [
    readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./runner.ts', import.meta.url), 'utf8'),
  ].join('\n');
  return sha256(source);
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function gitBuffer(...args: readonly string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
}

export function assertFeature270GenerationAuthorized(
  allowGeneration: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!allowGeneration) throw new Error('feature-270 paid generation is disabled');
  if (environment.KODAX_F270_ALLOW_GENERATION !== '1') {
    throw new Error('feature-270 paid generation requires KODAX_F270_ALLOW_GENERATION=1');
  }
  if (!environment.KODAX_F270_AUTHORIZATION?.trim()) {
    throw new Error('feature-270 paid generation requires KODAX_F270_AUTHORIZATION');
  }
}

export async function writeFeature270ExperimentManifest(
  manifest = buildFeature270ExperimentManifest(),
): Promise<string> {
  const target = path.join(manifest.rawOutputRoot, 'experiment.json');
  await writeJsonAtomic(target, manifest);
  return target;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}
