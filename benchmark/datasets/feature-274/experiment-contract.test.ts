import { describe, expect, it } from 'vitest';

import {
  FEATURE_274_JOURNEY_CASES,
  FEATURE_274_POLICY_CASES,
} from './cases.js';
import {
  FEATURE_274_JOURNEY_CASES_SHA256,
  FEATURE_274_POLICY_CASES_SHA256,
  buildFeature274ExperimentContract,
} from './experiment-contract.js';

describe('FEATURE_274 preregistered experiment contract', () => {
  it('freezes eight policy cases and five choreographed journeys', () => {
    expect(FEATURE_274_POLICY_CASES).toHaveLength(8);
    expect(FEATURE_274_JOURNEY_CASES).toHaveLength(5);
    expect(new Set(FEATURE_274_POLICY_CASES.map((item) => item.id))).toHaveLength(8);
    expect(new Set(FEATURE_274_JOURNEY_CASES.map((item) => item.id))).toHaveLength(5);
    expect(FEATURE_274_POLICY_CASES_SHA256)
      .toBe('10cf0872ecbb4b86f911a1d7397057389f7b8df13e54f270582dbc5eb66f750e');
    expect(FEATURE_274_JOURNEY_CASES_SHA256)
      .toBe('d6813fdd0372f56121b7f1a822775732590cca762443cd641f30030f16bc17de');
  });

  it('pins the documented call, token, spend, round, and timeout ceilings', () => {
    const contract = buildFeature274ExperimentContract() as {
      readonly layer2: {
        readonly maxCallsPerCell: number;
        readonly maxRoundsPerCell: number;
        readonly timeoutMs: number;
        readonly pilot: { readonly maxProviderCalls: number };
        readonly inclusiveExpansion: { readonly maxProviderCalls: number };
      };
      readonly layer3: {
        readonly maxCallsPerCell: number;
        readonly maxRoundsPerCell: number;
        readonly maxProviderCalls: number;
      };
      readonly totalCeiling: {
        readonly maxProviderCalls: number;
        readonly maxTotalTokens: number;
        readonly maxExternalSpendUsd: number;
      };
      readonly generationSafety: string;
      readonly preCallFreeze: { readonly required: boolean };
    };

    expect(contract.layer2).toMatchObject({
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      timeoutMs: 90_000,
      pilot: { maxProviderCalls: 8 },
      inclusiveExpansion: { maxProviderCalls: 96 },
    });
    expect(contract.layer3).toMatchObject({
      maxCallsPerCell: 2,
      maxRoundsPerCell: 2,
      maxProviderCalls: 40,
    });
    expect(contract.totalCeiling).toEqual({
      maxProviderCalls: 136,
      maxTotalTokens: 3_000_000,
      maxExternalSpendUsd: 24,
      maxMinutes: 90,
    });
    expect(contract.generationSafety).toContain('explicit user authorization');
    expect(contract.preCallFreeze.required).toBe(true);
  });
});
