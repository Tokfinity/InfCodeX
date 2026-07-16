import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_POLICY_ARTIFACT } from '../../../packages/coding/src/memory/policy-artifact.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import {
  FEATURE_260_BOUNDED_RECOVERY_CASES,
  FEATURE_260_DEVELOPMENT_CASES,
  FEATURE_260_IMMEDIATE_RECALL_CASES,
  FEATURE_260_MUST_SILENT_CASES,
  FEATURE_260_PAIRED_CASES,
  FEATURE_260_PILOT_CASES,
  FEATURE_260_SEALED_HOLDOUT_CASES,
  FEATURE_260_SHIP_THRESHOLDS,
} from './cases.js';

export const FEATURE_260_PILOT_ALIAS = 'ark/v4flash' as const;
export const FEATURE_260_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-260-memory-agent',
  MEMORY_POLICY_ARTIFACT.policyVersion,
);

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildFeature260ExperimentManifest(): object {
  const alias = MODEL_ALIASES[FEATURE_260_PILOT_ALIAS];
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirtyPatch = execFileSync('git', ['diff', '--binary', '--submodule=diff', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const untrackedPaths = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ).toString('utf8').split('\0').filter((value) => value.length > 0);
  const sourceSnapshot = hashFeature260SourceSnapshot(
    dirtyPatch,
    untrackedPaths.map((filePath) => ({ path: filePath, content: readFileSync(filePath) })),
  );
  return {
    schemaVersion: 2,
    featureId: 260,
    release: '0.7.68',
    gitCommit,
    dirtyPatchSha256: hash(dirtyPatch),
    sourceSnapshot,
    policyArtifact: MEMORY_POLICY_ARTIFACT,
    splitHashes: {
      development: hash(JSON.stringify(FEATURE_260_DEVELOPMENT_CASES)),
      sealedHoldout: hash(JSON.stringify(FEATURE_260_SEALED_HOLDOUT_CASES)),
      decisionPanel: hash(JSON.stringify([
        ...FEATURE_260_IMMEDIATE_RECALL_CASES,
        ...FEATURE_260_MUST_SILENT_CASES,
        ...FEATURE_260_PAIRED_CASES,
        ...FEATURE_260_BOUNDED_RECOVERY_CASES,
      ])),
    },
    splitPolicy: 'v1 evidence is retired diagnostic data; v2 development cases may be inspected; the v2 sealed holdout is frozen before generation and never used for tuning',
    pilot: {
      alias: FEATURE_260_PILOT_ALIAS,
      resolvedProvider: alias.provider,
      resolvedModel: alias.model,
      cases: FEATURE_260_PILOT_CASES.map((item) => item.id),
      arms: ['baseline', 'candidate'],
      maxCalls: 4,
      maxCallsPerCell: 1,
      concurrency: 1,
      timeoutMs: 90_000,
      maxOutputTokens: 512,
      maxExternalSpendUsd: 2,
      retriesAddedByHarness: 0,
    },
    decisionPanel: {
      alias: FEATURE_260_PILOT_ALIAS,
      immediateRecallCases: {
        general: 60,
        highValue: 40,
      },
      mustSilentCases: 200,
      pairedCases: 90,
      boundedRecoveryCases: 20,
      maxCalls: 520,
      maxCallsPerCase: 2,
      concurrency: 1,
      timeoutMs: 90_000,
      maxOutputTokens: 256,
      maxInputTokens: 1_600_000,
      maxOutputTokensTotal: 136_000,
      maxExternalSpendUsd: 0.02,
      retriesAddedByHarness: 0,
      resumePolicy: 'reuse only structurally valid v2 raw cells with matching policy-root/case/arm/round/alias',
      shipThresholds: FEATURE_260_SHIP_THRESHOLDS,
    },
    productionBytes: {
      deliberateRecallTool: MEMORY_POLICY_ARTIFACT.deliberateRecallToolSha256,
      evidenceTemplate: MEMORY_POLICY_ARTIFACT.evidenceTemplateSha256,
      memoryRules: MEMORY_POLICY_ARTIFACT.memoryRulesSha256,
    },
    generationSafety: 'manifest-only by default; external calls require KODAX_F260_ALLOW_GENERATION=1',
    reviewPolicy: 'current main session reviews blinded paired raw evidence after mechanical scoring',
    rawOutputRoot: FEATURE_260_RAW_ROOT,
    authorization: 'User explicitly requested the necessary v0.7.68 eval on 2026-07-12; v2 pilot remains bounded by four calls and USD 2.',
    conclusionPolicy: 'pilot can recommend iterate/revert or justify holdout; it cannot independently authorize default-on ship',
  };
}

export function hashFeature260SourceSnapshot(
  trackedPatch: string,
  untrackedFiles: readonly { readonly path: string; readonly content: Buffer }[],
): {
  readonly trackedPatchSha256: string;
  readonly untrackedFilesSha256: string;
  readonly combinedSha256: string;
  readonly untrackedFileCount: number;
} {
  const entries = untrackedFiles
    .map((entry) => ({ path: entry.path.replaceAll('\\', '/'), sha256: hashBuffer(entry.content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const trackedPatchSha256 = hash(trackedPatch);
  const untrackedFilesSha256 = hash(JSON.stringify(entries));
  return {
    trackedPatchSha256,
    untrackedFilesSha256,
    combinedSha256: hash(JSON.stringify({ trackedPatchSha256, entries })),
    untrackedFileCount: entries.length,
  };
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function writeFeature260ExperimentManifest(): Promise<string> {
  const target = path.join(FEATURE_260_RAW_ROOT, 'experiment.json');
  await writeJsonAtomic(target, buildFeature260ExperimentManifest());
  return target;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}
