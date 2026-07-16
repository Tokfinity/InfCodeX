import { describe, it, expect } from 'vitest';
import type { KodaXTokenUsage } from '@kodax-ai/llm';
import {
  applyAccountingDelta,
  buildBlockedGoal,
  buildCompleteGoal,
  buildCreatedGoal,
  buildPausedGoal,
  buildResumedGoal,
  isValidTokenBudget,
} from './state.js';

const FIXED_NOW = 1_700_000_000_000;

describe('buildCreatedGoal', () => {
  it('builds a fresh active goal with the given objective + budget', () => {
    const g = buildCreatedGoal('my-objective', 50_000, FIXED_NOW);
    expect(g.objective).toBe('my-objective');
    expect(g.tokenBudget).toBe(50_000);
    expect(g.status).toBe('active');
    expect(g.tokensUsed).toBe(0);
    expect(g.blockerTurnCount).toBe(0);
    expect(g.lastBlockerKind).toBeNull();
    expect(g.createdAt).toBe(FIXED_NOW);
    expect(g.updatedAt).toBe(FIXED_NOW);
    expect(g.version).toBe(1);
    expect(g.id).toMatch(/^\d+-[0-9a-f]{8}$/);
  });

  it('trims objective whitespace', () => {
    const g = buildCreatedGoal('  build the thing  ', null, FIXED_NOW);
    expect(g.objective).toBe('build the thing');
  });

  it('throws on empty objective', () => {
    expect(() => buildCreatedGoal('', null)).toThrow(/non-empty/);
    expect(() => buildCreatedGoal('   ', null)).toThrow(/non-empty/);
  });

  it('throws on non-positive tokenBudget', () => {
    expect(() => buildCreatedGoal('x', 0)).toThrow(/positive/);
    expect(() => buildCreatedGoal('x', -100)).toThrow(/positive/);
  });

  it('accepts null tokenBudget (no budget)', () => {
    const g = buildCreatedGoal('x', null);
    expect(g.tokenBudget).toBeNull();
  });

  it('returns a frozen object', () => {
    const g = buildCreatedGoal('x', null);
    expect(Object.isFrozen(g)).toBe(true);
  });
});

describe('applyAccountingDelta', () => {
  const usage: KodaXTokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };

  it('returns unchanged state when status != active', () => {
    const g = buildCreatedGoal('x', 1000, FIXED_NOW);
    const paused = buildPausedGoal(g, FIXED_NOW + 1);
    const r = applyAccountingDelta(paused, usage, 1, FIXED_NOW + 2);
    expect(r.nextState).toBe(paused);
    expect(r.budgetLimited).toBe(false);
  });

  it('returns unchanged state on zero delta', () => {
    const g = buildCreatedGoal('x', 1000, FIXED_NOW);
    const r = applyAccountingDelta(g, undefined, 0, FIXED_NOW + 1);
    expect(r.nextState).toBe(g);
    expect(r.budgetLimited).toBe(false);
  });

  it('accumulates tokens and time', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const r = applyAccountingDelta(g, usage, 5, FIXED_NOW + 10);
    expect(r.nextState.tokensUsed).toBe(150);
    expect(r.nextState.timeUsedSeconds).toBe(5);
    expect(r.budgetLimited).toBe(false);
  });

  it('flips status to budget_limited on budget cross', () => {
    const g = buildCreatedGoal('x', 100, FIXED_NOW);
    const r = applyAccountingDelta(g, usage, 1, FIXED_NOW + 1);
    expect(r.budgetLimited).toBe(true);
    expect(r.nextState.status).toBe('budget_limited');
    expect(r.nextState.tokensUsed).toBe(150);
  });

  it('does not flip when delta keeps usage under budget', () => {
    const g = buildCreatedGoal('x', 1000, FIXED_NOW);
    const r = applyAccountingDelta(g, usage, 1, FIXED_NOW + 1);
    expect(r.budgetLimited).toBe(false);
    expect(r.nextState.status).toBe('active');
  });

  it('preserves id and objective', () => {
    const g = buildCreatedGoal('x', 1000, FIXED_NOW);
    const r = applyAccountingDelta(g, usage, 1, FIXED_NOW + 1);
    expect(r.nextState.id).toBe(g.id);
    expect(r.nextState.objective).toBe(g.objective);
  });
});

describe('buildPausedGoal / buildResumedGoal', () => {
  it('paused→resumed roundtrip preserves identity + accounting', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const updated = applyAccountingDelta(
      g,
      { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      2,
      FIXED_NOW + 1,
    ).nextState;
    const paused = buildPausedGoal(updated, FIXED_NOW + 2);
    expect(paused.status).toBe('paused');
    expect(paused.tokensUsed).toBe(30);
    const resumed = buildResumedGoal(paused, FIXED_NOW + 3);
    expect(resumed.status).toBe('active');
    expect(resumed.tokensUsed).toBe(30);
    expect(resumed.id).toBe(g.id);
  });

  it('paused throws when source is not active', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const paused = buildPausedGoal(g, FIXED_NOW + 1);
    expect(() => buildPausedGoal(paused)).toThrow(/only 'active'/);
  });

  it('resumed throws when source is not paused', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    expect(() => buildResumedGoal(g)).toThrow(/only 'paused'/);
  });
});

describe('buildBlockedGoal', () => {
  it('flips to blocked with the given kind + counter', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const b = buildBlockedGoal(g, 'awaiting-permission', 3, FIXED_NOW + 1);
    expect(b.status).toBe('blocked');
    expect(b.lastBlockerKind).toBe('awaiting-permission');
    expect(b.blockerTurnCount).toBe(3);
  });

  it('throws when source is not active', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const paused = buildPausedGoal(g, FIXED_NOW + 1);
    expect(() => buildBlockedGoal(paused, 'k', 3)).toThrow(/only 'active'/);
  });
});

describe('buildCompleteGoal', () => {
  it('flips to complete from active', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const c = buildCompleteGoal(g, FIXED_NOW + 1);
    expect(c.status).toBe('complete');
    expect(c.updatedAt).toBe(FIXED_NOW + 1);
  });

  it('throws when source is not active', () => {
    const g = buildCreatedGoal('x', null, FIXED_NOW);
    const paused = buildPausedGoal(g, FIXED_NOW + 1);
    expect(() => buildCompleteGoal(paused)).toThrow(/only 'active'/);
  });
});

describe('isValidTokenBudget', () => {
  it('accepts null', () => {
    expect(isValidTokenBudget(null)).toBe(true);
  });

  it('accepts positive finite numbers', () => {
    expect(isValidTokenBudget(1)).toBe(true);
    expect(isValidTokenBudget(50_000)).toBe(true);
  });

  it('rejects zero / negatives / non-finite / non-number', () => {
    expect(isValidTokenBudget(0)).toBe(false);
    expect(isValidTokenBudget(-10)).toBe(false);
    expect(isValidTokenBudget(NaN)).toBe(false);
    expect(isValidTokenBudget(Infinity)).toBe(false);
    expect(isValidTokenBudget('100')).toBe(false);
    expect(isValidTokenBudget(undefined)).toBe(false);
  });
});
