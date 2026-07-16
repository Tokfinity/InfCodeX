import { describe, it, expect } from 'vitest';
import type { KodaXTokenUsage } from '@kodax-ai/llm';
import {
  goalTokenDelta,
  shouldFlipBudgetLimited,
  turnWallTimeDelta,
} from './accounting.js';

describe('goalTokenDelta', () => {
  it('returns 0 for undefined usage', () => {
    expect(goalTokenDelta(undefined)).toBe(0);
  });

  it('counts input + output when cached fields are absent', () => {
    const usage: KodaXTokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };
    expect(goalTokenDelta(usage)).toBe(150);
  });

  it('deducts cachedReadTokens from input', () => {
    const usage: KodaXTokenUsage = {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      cachedReadTokens: 600,
    };
    // inputNet = 1000 - 600 = 400; output = 100 → 500
    expect(goalTokenDelta(usage)).toBe(500);
  });

  it('clamps negative input to 0 when cached > input (shouldnt happen but safe)', () => {
    const usage: KodaXTokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedReadTokens: 200,
    };
    // inputNet = max(0, 100-200) = 0; output = 50 → 50
    expect(goalTokenDelta(usage)).toBe(50);
  });

  it('cachedWriteTokens does NOT reduce input (write = new cost)', () => {
    const usage: KodaXTokenUsage = {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      cachedWriteTokens: 600,
    };
    // cachedWrite is not deducted → 1000 + 100 = 1100
    expect(goalTokenDelta(usage)).toBe(1100);
  });
});

describe('turnWallTimeDelta', () => {
  it('returns whole seconds', () => {
    expect(turnWallTimeDelta(1000, 4500)).toBe(3);
  });

  it('returns 0 for zero / negative diff', () => {
    expect(turnWallTimeDelta(1000, 1000)).toBe(0);
    expect(turnWallTimeDelta(2000, 1000)).toBe(0);
  });

  it('returns 0 for non-finite input', () => {
    expect(turnWallTimeDelta(NaN, 1000)).toBe(0);
  });
});

describe('shouldFlipBudgetLimited', () => {
  it('returns false when tokenBudget is null', () => {
    expect(shouldFlipBudgetLimited(0, 1000, null)).toBe(false);
  });

  it('returns true when delta would meet or exceed budget', () => {
    expect(shouldFlipBudgetLimited(0, 100, 100)).toBe(true);
    expect(shouldFlipBudgetLimited(50, 60, 100)).toBe(true);
  });

  it('returns false when sum stays strictly under', () => {
    expect(shouldFlipBudgetLimited(50, 49, 100)).toBe(false);
  });
});
