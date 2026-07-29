import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import {
  FEATURE_263_DOWNSTREAM_CASES,
  FEATURE_263_REVIEWER_CASES,
  FEATURE_263_REVIEWER_PILOT_CASES,
} from './cases.js';

export const FEATURE_263_REVISION = 'f263-v0.7.78.3' as const;
export const FEATURE_263_REVIEWER_CASES_SHA256 =
  '29e7786dca531770f8a47d9479db296dd4da09b9a1b5bcb937a0cd6e3d55dc5d' as const;
export const FEATURE_263_DOWNSTREAM_CASES_SHA256 =
  'e6e88790c8ce7befa9f83ef2d72b4e0916f26682cd302aa10cac86dbe96f0e21' as const;
export const FEATURE_263_PILOT_ALIAS: ModelAlias = 'ark/v4flash';
export const FEATURE_263_PANEL_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52', 'mmx/m3']);
export const FEATURE_263_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-263',
  FEATURE_263_REVISION,
);

export function buildFeature263ExperimentContract(): object {
  assertHash(
    'reviewer cases',
    FEATURE_263_REVIEWER_CASES,
    FEATURE_263_REVIEWER_CASES_SHA256,
  );
  assertHash(
    'downstream cases',
    FEATURE_263_DOWNSTREAM_CASES,
    FEATURE_263_DOWNSTREAM_CASES_SHA256,
  );
  return {
    schemaVersion: 1,
    featureId: 263,
    release: '0.7.78',
    revision: FEATURE_263_REVISION,
    caseHashes: {
      reviewer: FEATURE_263_REVIEWER_CASES_SHA256,
      downstream: FEATURE_263_DOWNSTREAM_CASES_SHA256,
    },
    preCallFreeze: {
      required: true,
      status: 'blocked until exact Git SHA, prompt/tool/policy bytes, rendered action prompts, scorer hash, alias resolution, pricing, and owner authorization are recorded',
    },
    reviewer: {
      pilot: {
        alias: FEATURE_263_PILOT_ALIAS,
        caseIds: FEATURE_263_REVIEWER_PILOT_CASES.map((item) => item.id),
        repetitions: 2,
        maxProviderCalls: 4,
      },
      inclusiveSafetyPanel: {
        aliases: FEATURE_263_PANEL_ALIASES,
        caseIds: FEATURE_263_REVIEWER_CASES.map((item) => item.id),
        repetitions: 3,
        maxProviderCalls: 54,
      },
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxOutputTokensPerCall: 1_200,
      timeoutMs: 90_000,
    },
    downstream: {
      aliases: FEATURE_263_PANEL_ALIASES,
      caseIds: FEATURE_263_DOWNSTREAM_CASES.map((item) => item.id),
      arms: ['control', 'with_skill'],
      repetitions: 2,
      maxProviderCalls: 24,
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxOutputTokensPerCall: 1_200,
      timeoutMs: 90_000,
    },
    totalCeiling: {
      maxProviderCalls: 78,
      maxTotalTokens: 850_000,
      maxExternalSpendUsd: 10,
    },
    concurrency: 'one in-flight request per provider/model lane',
    generationSafety: 'contract-only by default; provider calls require explicit user authorization and an enable flag',
    rawOutputRoot: FEATURE_263_RAW_ROOT,
    reviewPolicy: 'current main session audits safety output and blinded downstream pairs before reveal',
    evaluationScope: 'reviewer safety and immediate next-action value only; no free-running task-effect claim',
    conclusionPolicy: 'credible high-severity safety harm prevents recommend-ship regardless of aggregate mechanical scores',
  };
}

function assertHash(label: string, value: unknown, expected: string): void {
  const actual = createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
  if (actual !== expected) {
    throw new Error(
      `${label} hash changed; bump the experiment revision and pin ${actual}.`,
    );
  }
}
