import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { FEATURE_275_CASES, FEATURE_275_PILOT_CASES } from './cases.js';

export const FEATURE_275_REVISION = 'f275-v0.7.77.2' as const;
export const FEATURE_275_PILOT_CASES_SHA256 =
  '5cc116eee4c43403f24799cbc94dd9ae6ba90a134fb53512648df237f7f41361' as const;
export const FEATURE_275_CASES_SHA256 =
  '2ed0fc54dfccbe15d0a3ff186b4cb2258912eb35d1510bc0ac5045fe6edaddc8' as const;
export const FEATURE_275_PILOT_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52']);
export const FEATURE_275_VALIDATION_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/k27', 'zhipu/glm52', 'mmx/m3']);
export const FEATURE_275_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-275',
  FEATURE_275_REVISION,
);

export function buildFeature275ExperimentContract(): object {
  assertHash('pilot cases', FEATURE_275_PILOT_CASES, FEATURE_275_PILOT_CASES_SHA256);
  assertHash('validation cases', FEATURE_275_CASES, FEATURE_275_CASES_SHA256);
  return {
    schemaVersion: 1,
    featureId: 275,
    release: '0.7.77',
    revision: FEATURE_275_REVISION,
    arms: {
      A: {
        policy: 'F260 control',
        calls: ['action'],
      },
      B: {
        policy: 'deterministic candidate only',
        calls: ['action'],
      },
      C: {
        policy: 'explicit semantic selector runner',
        calls: ['selector', 'action'],
      },
    },
    preCallFreeze: {
      required: true,
      status: 'blocked until exact full Git SHA, prompt/tool/policy bytes, scorer hash, and alias resolution are recorded',
    },
    caseHashes: {
      pilot: FEATURE_275_PILOT_CASES_SHA256,
      validation: FEATURE_275_CASES_SHA256,
    },
    pilot: {
      aliases: FEATURE_275_PILOT_ALIASES,
      caseIds: FEATURE_275_PILOT_CASES.map((item) => item.id),
      repetitions: 1,
      armCallsPerCaseAlias: 4,
      maxProviderCalls: 16,
      maxCallsPerCell: { A: 1, B: 1, C: 2 },
      maxRoundsPerCell: { A: 1, B: 1, C: 2 },
      maxOutputTokens: {
        selector: 256,
        action: 512,
      },
      timeoutMs: { selector: 5_000, action: 90_000 },
      maxTotalTokens: 200_000,
      maxExternalSpendUsd: 2,
    },
    validation: {
      aliases: FEATURE_275_VALIDATION_ALIASES,
      caseIds: FEATURE_275_CASES.map((item) => item.id),
      repetitions: 3,
      armCallsPerCaseAlias: 4,
      maxProviderCalls: 144,
      maxCallsPerCell: { A: 1, B: 1, C: 2 },
      maxRoundsPerCell: { A: 1, B: 1, C: 2 },
      maxOutputTokens: {
        selector: 256,
        action: 512,
      },
      timeoutMs: { selector: 5_000, action: 90_000 },
      maxTotalTokens: 1_200_000,
      maxExternalSpendUsd: 30,
    },
    deterministicHardGates: [
      'candidate coverage',
      'private and sensitive exclusion',
      'unknown-ID rejection',
      'stale-result discard',
      'source quotas',
      'stable ordering and fingerprints',
    ],
    concurrency: 'one in-flight request per provider/model lane',
    generationSafety: 'contract-only by default; external calls require explicit user authorization',
    rawOutputRoot: FEATURE_275_RAW_ROOT,
    reviewPolicy: 'current main session reviews blinded A/B/C evidence after mechanical scoring',
    evaluationScope: 'next-action selection and immediate action quality only; no final-task-result claim',
    conclusionPolicy: 'pilot validates measurement only; no external run or product-effect claim is allowed before pre-call freeze and authorized validation',
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertHash(label: string, value: unknown, expected: string): void {
  const actual = hash(value);
  if (actual !== expected) {
    throw new Error(`${label} hash changed; bump the experiment revision and pin the new hash.`);
  }
}
