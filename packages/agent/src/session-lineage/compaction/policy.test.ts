import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMPACTION_TRIGGER_PERCENT,
  MAX_COMPACTION_TRIGGER_PERCENT,
  MIN_COMPACTION_TRIGGER_PERCENT,
  normalizeCompactionConfig,
  resolveCompactionPolicy,
} from './policy.js';

describe('FEATURE_272 compaction policy', () => {
  it('is always enabled and defaults to a 75% trigger', () => {
    expect(normalizeCompactionConfig({})).toEqual(expect.objectContaining({
      enabled: true,
      triggerPercent: DEFAULT_COMPACTION_TRIGGER_PERCENT,
    }));
    expect(normalizeCompactionConfig({ enabled: false }).enabled).toBe(true);
  });

  it('clamps percentage triggers to the public 15-90 range', () => {
    expect(MIN_COMPACTION_TRIGGER_PERCENT).toBe(15);
    expect(MAX_COMPACTION_TRIGGER_PERCENT).toBe(90);
    expect(normalizeCompactionConfig({ triggerPercent: -1 }).triggerPercent).toBe(15);
    expect(normalizeCompactionConfig({ triggerPercent: 14.9 }).triggerPercent).toBe(15);
    expect(normalizeCompactionConfig({ triggerPercent: 42 }).triggerPercent).toBe(42);
    expect(normalizeCompactionConfig({ triggerPercent: 90.1 }).triggerPercent).toBe(90);
    expect(normalizeCompactionConfig({ triggerPercent: 100 }).triggerPercent).toBe(90);
    expect(normalizeCompactionConfig({ triggerPercent: Number.NaN }).triggerPercent).toBe(75);
  });

  it('accepts zero as an inactive absolute threshold and rejects invalid values', () => {
    expect(normalizeCompactionConfig({ triggerTokens: 0 }).triggerTokens).toBeUndefined();
    expect(normalizeCompactionConfig({ triggerTokens: 250_000 }).triggerTokens).toBe(250_000);

    for (const triggerTokens of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => normalizeCompactionConfig({ triggerTokens })).toThrow(RangeError);
    }
  });

  it('uses the smaller percentage, absolute, and physical threshold', () => {
    expect(resolveCompactionPolicy(
      { triggerPercent: 40 },
      1_000_000,
      950_000,
    )).toEqual(expect.objectContaining({
      triggerTokens: 400_000,
      protectionTokens: 80_000,
      triggerSource: 'percentage',
    }));

    expect(resolveCompactionPolicy(
      { triggerPercent: 40, triggerTokens: 300_000 },
      1_000_000,
      950_000,
    )).toEqual(expect.objectContaining({
      triggerTokens: 300_000,
      protectionTokens: 60_000,
      triggerSource: 'absolute',
    }));

    expect(resolveCompactionPolicy(
      { triggerPercent: 90, triggerTokens: 980_000 },
      1_000_000,
      850_000,
    )).toEqual(expect.objectContaining({
      triggerTokens: 850_000,
      protectionTokens: 170_000,
      triggerSource: 'physical_capacity',
    }));
  });
});
