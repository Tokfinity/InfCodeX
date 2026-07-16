import { describe, expect, it } from 'vitest';

import {
  formatCompactionPolicy,
  resolveCompactionThresholdTokens,
} from './compaction-display.js';

describe('compaction display policy', () => {
  it('describes the default policy as capacity-driven', () => {
    expect(formatCompactionPolicy(200_000, 100)).toBe('capacity-driven');
  });

  it('keeps an explicit early trigger visible', () => {
    expect(formatCompactionPolicy(200_000, 75)).toBe('@ 75% (150k)');
  });

  it('uses physical capacity for the default pressure threshold', () => {
    const threshold = resolveCompactionThresholdTokens(200_000, 100, 32_000);

    expect(threshold).toBeLessThan(168_000);
    expect(threshold).toBeGreaterThan(160_000);
  });

  it('honours an explicit earlier trigger when it is below capacity', () => {
    expect(resolveCompactionThresholdTokens(200_000, 75, 32_000)).toBe(150_000);
  });
});
