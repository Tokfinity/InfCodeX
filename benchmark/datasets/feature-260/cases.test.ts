import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MEMORY_POLICY_ARTIFACT } from '../../../packages/coding/src/memory/policy-artifact.js';
import { MEMORY_RECALL_TOOL_BYTES_SHA256 } from '../../../packages/coding/src/tools/memory-recall.js';
import {
  FEATURE_260_DEVELOPMENT_CASES,
  FEATURE_260_BOUNDED_RECOVERY_CASES,
  FEATURE_260_IMMEDIATE_RECALL_CASES,
  FEATURE_260_MUST_SILENT_CASES,
  FEATURE_260_PAIRED_CASES,
  FEATURE_260_PILOT_CASES,
  FEATURE_260_SEALED_HOLDOUT_CASES,
  FEATURE_260_SHIP_THRESHOLDS,
} from './cases.js';

describe('FEATURE_260 eval contract', () => {
  it('separates development cases from the frozen holdout', () => {
    const developmentIds = new Set(FEATURE_260_DEVELOPMENT_CASES.map((item) => item.id));
    const holdoutIds = FEATURE_260_SEALED_HOLDOUT_CASES.map((item) => item.id);

    expect(FEATURE_260_DEVELOPMENT_CASES).toHaveLength(12);
    expect(FEATURE_260_PILOT_CASES).toHaveLength(2);
    expect(FEATURE_260_SEALED_HOLDOUT_CASES).toHaveLength(410);
    expect(holdoutIds.every((id) => !developmentIds.has(id))).toBe(true);
    expect(hash(FEATURE_260_SEALED_HOLDOUT_CASES)).toBe(
      'a9490bcb6034cde3d8945630aa001121504a2e6063cd0e206db494187cf65b99',
    );
  });

  it('freezes the revised 520-call sealed decision panel without ID overlap', () => {
    expect(FEATURE_260_IMMEDIATE_RECALL_CASES).toHaveLength(100);
    expect(FEATURE_260_IMMEDIATE_RECALL_CASES.filter((item) => item.recallClass === 'general'))
      .toHaveLength(60);
    expect(FEATURE_260_IMMEDIATE_RECALL_CASES.filter((item) => item.recallClass === 'high_value'))
      .toHaveLength(40);
    expect(FEATURE_260_MUST_SILENT_CASES).toHaveLength(200);
    expect(FEATURE_260_PAIRED_CASES).toHaveLength(90);
    expect(FEATURE_260_BOUNDED_RECOVERY_CASES).toHaveLength(20);
    const ids = [
      ...FEATURE_260_IMMEDIATE_RECALL_CASES,
      ...FEATURE_260_MUST_SILENT_CASES,
      ...FEATURE_260_PAIRED_CASES,
      ...FEATURE_260_BOUNDED_RECOVERY_CASES,
    ].map((item) => item.id);
    expect(new Set(ids)).toHaveLength(410);
    expect(hash(ids)).toBe('814529cd96aa1808a948561514ca3d72b23cb732a863f049e6b0c436c194ea73');
  });

  it('keeps critical safety and permission gates deterministic', () => {
    expect(FEATURE_260_IMMEDIATE_RECALL_CASES.some((item) => item.recallClass === 'safety'))
      .toBe(false);
    expect(FEATURE_260_BOUNDED_RECOVERY_CASES.some((item) => item.recallClass === 'safety'))
      .toBe(false);
    expect(FEATURE_260_SHIP_THRESHOLDS).toEqual({
      generalImmediateRecallRate: 0.9,
      highValueImmediateRecallRate: 0.95,
      boundedRecoveryRate: 0.95,
      maxSilentFalsePositives: 2,
      silenceWilsonLower95: 0.95,
      pairedLift: 0.08,
      maxControlRegression: 0.02,
      deterministicCriticalGuardViolations: 0,
    });
  });

  it('pins the source-controlled policy and production tool bytes', () => {
    expect(MEMORY_POLICY_ARTIFACT.policyVersion).toBe('f260-v0.7.68.2');
    expect(MEMORY_POLICY_ARTIFACT.deliberateRecallToolSha256)
      .toBe(MEMORY_RECALL_TOOL_BYTES_SHA256);
  });
});

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
