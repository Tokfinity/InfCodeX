import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import {
  FEATURE_274_JOURNEY_CASES,
  FEATURE_274_POLICY_CASES,
} from './cases.js';

export const FEATURE_274_REVISION = 'f274-v0.7.77.2' as const;
export const FEATURE_274_POLICY_CASES_SHA256 =
  '10cf0872ecbb4b86f911a1d7397057389f7b8df13e54f270582dbc5eb66f750e' as const;
export const FEATURE_274_JOURNEY_CASES_SHA256 =
  'd6813fdd0372f56121b7f1a822775732590cca762443cd641f30030f16bc17de' as const;
export const FEATURE_274_PILOT_ALIAS: ModelAlias = 'ark/v4flash';
export const FEATURE_274_EXPANSION_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52']);
export const FEATURE_274_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-274',
  FEATURE_274_REVISION,
);

export function buildFeature274ExperimentContract(): object {
  assertHash('layer2 cases', FEATURE_274_POLICY_CASES, FEATURE_274_POLICY_CASES_SHA256);
  assertHash('layer3 cases', FEATURE_274_JOURNEY_CASES, FEATURE_274_JOURNEY_CASES_SHA256);
  return {
    schemaVersion: 1,
    featureId: 274,
    release: '0.7.77',
    revision: FEATURE_274_REVISION,
    splitHashes: {
      layer2: FEATURE_274_POLICY_CASES_SHA256,
      layer3: FEATURE_274_JOURNEY_CASES_SHA256,
    },
    preCallFreeze: {
      required: true,
      status: 'blocked until exact full Git SHA, prompt/tool bytes, scorer hash, and alias resolution are recorded',
    },
    layer2: {
      arms: ['baseline', 'candidate'],
      pilotAlias: FEATURE_274_PILOT_ALIAS,
      expansionAliases: FEATURE_274_EXPANSION_ALIASES,
      pilotCaseIds: [
        'simple-direct-solo',
        'independent-interface-coverage',
        'concrete-candidate-challenge',
        'explicit-workflow-request',
      ],
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxOutputTokensPerCall: 512,
      timeoutMs: 90_000,
      pilot: {
        maxProviderCalls: 8,
        maxTotalTokens: 200_000,
        maxExternalSpendUsd: 2,
        maxMinutes: 20,
      },
      inclusiveExpansion: {
        maxProviderCalls: 96,
        maxTotalTokens: 2_000_000,
        maxExternalSpendUsd: 16,
        maxMinutes: 60,
      },
    },
    layer3: {
      arms: ['baseline', 'candidate'],
      caseIds: FEATURE_274_JOURNEY_CASES.map((item) => item.id),
      repetitions: 2,
      maxCallsPerCell: 2,
      maxRoundsPerCell: 2,
      maxOutputTokensPerCall: 1_000,
      timeoutMs: 90_000,
      maxProviderCalls: 40,
      maxTotalTokens: 1_000_000,
      maxExternalSpendUsd: 8,
      maxMinutes: 30,
    },
    totalCeiling: {
      maxProviderCalls: 136,
      maxTotalTokens: 3_000_000,
      maxExternalSpendUsd: 24,
      maxMinutes: 90,
    },
    concurrency: 'one in-flight request per provider/model lane',
    generationSafety: 'contract-only by default; external calls require explicit user authorization',
    rawOutputRoot: FEATURE_274_RAW_ROOT,
    reviewPolicy: 'current main session reviews blinded paired evidence and records recommend-ship, recommend-iterate, recommend-revert, or eval-invalid',
    conclusionPolicy: 'mechanical metrics are diagnostic; no cross-model numeric vote authorizes shipment',
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
