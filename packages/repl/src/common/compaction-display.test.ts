import { describe, expect, it } from 'vitest';

import {
  formatCompactionPolicy,
  resolveCompactionThresholdTokens,
} from './compaction-display.js';

describe('compaction display policy', () => {
  it('describes the default 75% policy', () => {
    expect(formatCompactionPolicy(200_000, 75)).toBe('@ 75% (150k)');
  });

  it('keeps an explicit early trigger visible', () => {
    expect(formatCompactionPolicy(200_000, 75)).toBe('@ 75% (150k)');
  });

  it('clamps a legacy 100% input to the always-on 90% maximum', () => {
    expect(resolveCompactionThresholdTokens(200_000, 100, 0)).toBe(180_000);
  });

  it('honours an explicit earlier trigger when it is below capacity', () => {
    expect(resolveCompactionThresholdTokens(200_000, 75, 32_000)).toBe(150_000);
  });

  it('shows and applies the smaller absolute threshold', () => {
    expect(formatCompactionPolicy(200_000, 75, 120_000)).toBe(
      '@ min(75%, 120k) (120k)',
    );
    expect(resolveCompactionThresholdTokens(200_000, 75, 32_000, 120_000)).toBe(120_000);
  });

  it('treats an absolute zero as inactive', () => {
    expect(formatCompactionPolicy(200_000, 75, 0)).toBe('@ 75% (150k)');
  });
});
