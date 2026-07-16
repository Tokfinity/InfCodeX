import { describe, expect, it } from 'vitest';
import * as capacityApi from './context-capacity.js';

import {
  calculateContextSafetyMargin,
  calculateMaxContextInputTokens,
  exceedsContextCapacity,
} from './context-capacity.js';

describe('physical context capacity', () => {
  it('uses the 2048-token safety floor for smaller requests', () => {
    expect(calculateContextSafetyMargin(20_000)).toBe(2_048);
  });

  it('uses a 3% safety margin for larger requests', () => {
    expect(calculateContextSafetyMargin(100_000)).toBe(3_000);
  });

  it('does not expose instantaneous slack as an append-budget API', () => {
    expect('calculateAvailableContextTokens' in capacityApi).toBe(false);
  });

  it('triggers only when request, response reserve, and safety exceed the window', () => {
    expect(exceedsContextCapacity({
      contextWindow: 200_000,
      currentTokens: 160_000,
      reservedResponseTokens: 32_000,
    })).toBe(false);
    expect(exceedsContextCapacity({
      contextWindow: 200_000,
      currentTokens: 164_000,
      reservedResponseTokens: 32_000,
    })).toBe(true);
  });

  it('solves the largest safe input boundary exactly', () => {
    const maximum = calculateMaxContextInputTokens(200_000, 32_000);
    expect(exceedsContextCapacity({
      contextWindow: 200_000,
      currentTokens: maximum,
      reservedResponseTokens: 32_000,
    })).toBe(false);
    expect(exceedsContextCapacity({
      contextWindow: 200_000,
      currentTokens: maximum + 1,
      reservedResponseTokens: 32_000,
    })).toBe(true);
  });
});
