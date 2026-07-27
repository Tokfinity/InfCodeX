import { describe, expect, it } from 'vitest';

import { FEATURE_275_CASES, FEATURE_275_PILOT_CASES } from './cases.js';
import {
  FEATURE_275_CASES_SHA256,
  FEATURE_275_PILOT_CASES_SHA256,
  buildFeature275ExperimentContract,
} from './experiment-contract.js';

describe('FEATURE_275 experiment revision', () => {
  it('uses a new F275 identity and matched positive/negative cases', () => {
    const contract = buildFeature275ExperimentContract() as {
      readonly featureId: number;
      readonly release: string;
      readonly revision: string;
      readonly arms: Readonly<Record<string, { readonly calls: readonly string[] }>>;
    };

    expect(contract).toMatchObject({
      featureId: 275,
      release: '0.7.77',
      revision: 'f275-v0.7.77.3',
    });
    expect(contract.revision).not.toContain('feature-260');
    expect(FEATURE_275_CASES).toHaveLength(4);
    expect(FEATURE_275_PILOT_CASES).toHaveLength(2);
    expect(FEATURE_275_PILOT_CASES.some((item) => item.expectedInjection)).toBe(true);
    expect(FEATURE_275_PILOT_CASES.some((item) => !item.expectedInjection)).toBe(true);
    expect(contract.arms.A?.calls).toEqual(['action']);
    expect(contract.arms.B?.calls).toEqual(['action']);
    expect(contract.arms.C?.calls).toEqual(['selector', 'action']);
    expect(FEATURE_275_PILOT_CASES_SHA256)
      .toBe('5cc116eee4c43403f24799cbc94dd9ae6ba90a134fb53512648df237f7f41361');
    expect(FEATURE_275_CASES_SHA256)
      .toBe('2ed0fc54dfccbe15d0a3ff186b4cb2258912eb35d1510bc0ac5045fe6edaddc8');
  });

  it('pins the 16-call pilot and 144-call validation without authorizing generation', () => {
    const contract = buildFeature275ExperimentContract() as {
      readonly pilot: {
        readonly aliases: readonly string[];
        readonly maxProviderCalls: number;
        readonly armCallsPerCaseAlias: number;
        readonly maxTotalTokens: number;
        readonly timeoutMs: { readonly selector: number; readonly action: number };
      };
      readonly validation: {
        readonly aliases: readonly string[];
        readonly repetitions: number;
        readonly maxProviderCalls: number;
        readonly maxTotalTokens: number;
        readonly maxExternalSpendUsd: number;
      };
      readonly generationSafety: string;
      readonly evaluationScope: string;
      readonly preCallFreeze: { readonly required: boolean };
    };

    expect(contract.pilot).toMatchObject({
      aliases: ['ark/v4flash', 'zhipu/glm52'],
      maxProviderCalls: 16,
      armCallsPerCaseAlias: 4,
      maxTotalTokens: 200_000,
      timeoutMs: { selector: 5_000, action: 90_000 },
    });
    expect(contract.validation).toMatchObject({
      aliases: ['ark/k27', 'zhipu/glm52', 'mmx/m3'],
      repetitions: 3,
      maxProviderCalls: 144,
      maxTotalTokens: 1_200_000,
      maxExternalSpendUsd: 30,
    });
    expect(contract.generationSafety).toContain('explicit user authorization');
    expect(contract.evaluationScope).toContain('next-action');
    expect(contract.preCallFreeze.required).toBe(true);
  });
});
