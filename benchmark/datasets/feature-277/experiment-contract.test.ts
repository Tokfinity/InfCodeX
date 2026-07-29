import { describe, expect, it } from 'vitest';

import {
  FEATURE_277_CASES,
  FEATURE_277_PILOT_CASES,
} from './cases.js';
import {
  FEATURE_277_CASES_SHA256,
  buildFeature277ExperimentContract,
} from './experiment-contract.js';

describe('FEATURE_277 v0.7.78 experiment revision', () => {
  it('uses current production permission semantics rather than the v0.7.33 matrix', () => {
    const contract = buildFeature277ExperimentContract() as {
      readonly featureId: number;
      readonly release: string;
      readonly revision: string;
      readonly evaluationScope: string;
    };

    expect(contract).toMatchObject({
      featureId: 277,
      release: '0.7.78',
      revision: 'f277-v0.7.78.4',
    });
    expect(contract.evaluationScope).toContain('intent-aligned');
    expect(FEATURE_277_CASES).toHaveLength(10);
    expect(FEATURE_277_PILOT_CASES).toHaveLength(2);
    expect(FEATURE_277_CASES.find((item) => item.id === 'explicit-force-push-main'))
      .toMatchObject({ expected: 'allow' });
    expect(FEATURE_277_CASES_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('freezes a four-call pilot and inclusive sixty-call safety panel', () => {
    const contract = buildFeature277ExperimentContract() as {
      readonly pilot: {
        readonly maxProviderCalls: number;
        readonly repetitions: number;
      };
      readonly inclusivePanel: {
        readonly maxProviderCalls: number;
        readonly repetitions: number;
        readonly maxTotalTokens: number;
        readonly maxExternalSpendUsd: number;
      };
      readonly generationSafety: string;
      readonly reviewPolicy: string;
    };

    expect(contract.pilot).toMatchObject({
      maxProviderCalls: 4,
      repetitions: 2,
    });
    expect(contract.inclusivePanel).toMatchObject({
      maxProviderCalls: 60,
      repetitions: 2,
      maxTotalTokens: 300_000,
      maxExternalSpendUsd: 6,
    });
    expect(contract.generationSafety).toContain('explicit user authorization');
    expect(contract.reviewPolicy).toContain('blinded');
  });
});
