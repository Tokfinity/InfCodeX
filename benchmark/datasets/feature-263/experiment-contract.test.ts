import { describe, expect, it } from 'vitest';

import {
  FEATURE_263_DOWNSTREAM_CASES,
  FEATURE_263_REVIEWER_CASES,
  FEATURE_263_REVIEWER_PILOT_CASES,
} from './cases.js';
import {
  FEATURE_263_DOWNSTREAM_CASES_SHA256,
  FEATURE_263_REVIEWER_CASES_SHA256,
  buildFeature263ExperimentContract,
} from './experiment-contract.js';

describe('FEATURE_263 v0.7.78 experiment revision', () => {
  it('pins the six reviewer cases and two downstream paired cases', () => {
    const contract = buildFeature263ExperimentContract() as {
      readonly featureId: number;
      readonly release: string;
      readonly revision: string;
    };

    expect(contract).toMatchObject({
      featureId: 263,
      release: '0.7.78',
      revision: 'f263-v0.7.78.3',
    });
    expect(FEATURE_263_REVIEWER_CASES).toHaveLength(6);
    expect(FEATURE_263_REVIEWER_PILOT_CASES).toHaveLength(2);
    expect(FEATURE_263_DOWNSTREAM_CASES).toHaveLength(2);
    expect(FEATURE_263_REVIEWER_CASES_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(FEATURE_263_DOWNSTREAM_CASES_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses production-plausible evidence for every reusable-method qualification', () => {
    const reusableCases = FEATURE_263_REVIEWER_CASES.filter(
      (item) => item.input.evidence.qualification.reusableMethodEvidence,
    );

    for (const evalCase of reusableCases) {
      const { outcomeDigest, priorDigests, qualification } = evalCase.input.evidence;
      expect(outcomeDigest.actionSignature, evalCase.id).toBeTruthy();
      expect(outcomeDigest.lesson ?? outcomeDigest.preconditions, evalCase.id).toBeTruthy();
      if (qualification.independentEpisodeCount < 2) continue;
      const matchingReviewKeys = new Set(
        [outcomeDigest, ...priorDigests]
          .filter((digest) => digest.actionSignature === outcomeDigest.actionSignature)
          .map((digest) => digest.reviewKey),
      );
      expect(matchingReviewKeys.size, evalCase.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('freezes the documented 78-call, 850k-token, ten-dollar ceiling', () => {
    const contract = buildFeature263ExperimentContract() as {
      readonly reviewer: {
        readonly pilot: { readonly maxProviderCalls: number };
        readonly inclusiveSafetyPanel: { readonly maxProviderCalls: number };
      };
      readonly downstream: { readonly maxProviderCalls: number };
      readonly totalCeiling: {
        readonly maxProviderCalls: number;
        readonly maxTotalTokens: number;
        readonly maxExternalSpendUsd: number;
      };
      readonly generationSafety: string;
      readonly rawOutputRoot: string;
    };

    expect(contract.reviewer.pilot.maxProviderCalls).toBe(4);
    expect(contract.reviewer.inclusiveSafetyPanel.maxProviderCalls).toBe(54);
    expect(contract.downstream.maxProviderCalls).toBe(24);
    expect(contract.totalCeiling).toEqual({
      maxProviderCalls: 78,
      maxTotalTokens: 850_000,
      maxExternalSpendUsd: 10,
    });
    expect(contract.generationSafety).toContain('explicit user authorization');
    expect(contract.rawOutputRoot).toContain('feature-263');
  });
});
