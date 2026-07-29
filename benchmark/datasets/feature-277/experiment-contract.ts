import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { FEATURE_277_CASES, FEATURE_277_PILOT_CASES } from './cases.js';

export const FEATURE_277_REVISION = 'f277-v0.7.78.3' as const;
export const FEATURE_277_CASES_SHA256 =
  '3d929aead6d86d6e36eb649fc94c2f4803cff68ff6fcf9887ac48855faedf7c9' as const;
export const FEATURE_277_PILOT_ALIAS: ModelAlias = 'ark/v4flash';
export const FEATURE_277_PANEL_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52', 'mmx/m3']);
export const FEATURE_277_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-277',
  FEATURE_277_REVISION,
);

export function buildFeature277ExperimentContract(): object {
  assertHash('cases', FEATURE_277_CASES, FEATURE_277_CASES_SHA256);
  return {
    schemaVersion: 1,
    featureId: 277,
    release: '0.7.78',
    revision: FEATURE_277_REVISION,
    supersedes: [
      {
        revision: 'feature-092-v0.7.33',
        status: 'historical-regression-evidence',
        reuseAllowed: false,
        reason: 'it predates compact intent evidence and the v0.7.78 intent-aligned permission policy',
      },
      {
        revision: 'auto-mode-classifier-timeout-v0.7.73',
        status: 'historical-latency-evidence',
        reuseAllowed: false,
        reason: 'it measures timeout behavior rather than the v0.7.78 semantic policy',
      },
    ],
    caseHash: FEATURE_277_CASES_SHA256,
    preCallFreeze: {
      required: true,
      status: 'blocked until exact Git SHA, rendered prompt hashes, scorer hash, alias resolution, pricing, and owner authorization are recorded',
    },
    pilot: {
      alias: FEATURE_277_PILOT_ALIAS,
      caseIds: FEATURE_277_PILOT_CASES.map((item) => item.id),
      repetitions: 2,
      maxProviderCalls: 4,
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxOutputTokensPerCall: 256,
      timeoutMs: 90_000,
      maxTotalTokens: 40_000,
      maxExternalSpendUsd: 1,
    },
    inclusivePanel: {
      aliases: FEATURE_277_PANEL_ALIASES,
      caseIds: FEATURE_277_CASES.map((item) => item.id),
      repetitions: 2,
      maxProviderCalls: 60,
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxOutputTokensPerCall: 256,
      timeoutMs: 90_000,
      maxTotalTokens: 300_000,
      maxExternalSpendUsd: 6,
    },
    concurrency: 'one in-flight request per provider/model lane',
    generationSafety: 'contract-only by default; provider calls require explicit user authorization and an enable flag',
    rawOutputRoot: FEATURE_277_RAW_ROOT,
    reviewPolicy: 'current main session reviews blinded closed-oracle evidence before opening expected-verdict reveal data',
    evaluationScope: 'intent-aligned Auto[LLM] classifier next-decision semantics; no tool execution or sandbox-effect claim',
    conclusionPolicy: 'mechanical verdicts diagnose behavior; task validity, harm, and recommend-ship/iterate/revert/eval-invalid come from main-session review',
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
