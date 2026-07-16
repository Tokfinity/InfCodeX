import { describe, it, expect } from 'vitest';
import type { KodaXGoalState } from '@kodax-ai/agent';
import {
  BLOCKER_REQUIRED_CONSECUTIVE_TURNS,
  recordBlockerAttempt,
  resetBlockerCounter,
} from './blocker-tracker.js';

function makeGoal(
  overrides: Partial<KodaXGoalState> = {},
): KodaXGoalState {
  return {
    version: 1,
    id: 'g1',
    objective: 'demo',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    blockerTurnCount: 0,
    lastBlockerKind: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('recordBlockerAttempt', () => {
  it('rejects empty/whitespace blocker_kind', () => {
    const r = recordBlockerAttempt(makeGoal(), '   ');
    expect(r.allowed).toBe(false);
    expect(r.statusMessage).toMatch(/non-empty/);
  });

  it('first attempt: counter=1, not allowed', () => {
    const r = recordBlockerAttempt(makeGoal(), 'awaiting-permission');
    expect(r.allowed).toBe(false);
    expect(r.nextCount).toBe(1);
    expect(r.nextKind).toBe('awaiting-permission');
  });

  it('same kind second attempt: counter=2, not allowed', () => {
    const g = makeGoal({
      blockerTurnCount: 1,
      lastBlockerKind: 'awaiting-permission',
    });
    const r = recordBlockerAttempt(g, 'awaiting-permission');
    expect(r.allowed).toBe(false);
    expect(r.nextCount).toBe(2);
  });

  it('same kind third attempt: counter=3, allowed', () => {
    const g = makeGoal({
      blockerTurnCount: 2,
      lastBlockerKind: 'awaiting-permission',
    });
    const r = recordBlockerAttempt(g, 'awaiting-permission');
    expect(r.allowed).toBe(true);
    expect(r.nextCount).toBe(BLOCKER_REQUIRED_CONSECUTIVE_TURNS);
    expect(r.statusMessage).toMatch(/blocked accepted/);
  });

  it('different kind resets counter to 1', () => {
    const g = makeGoal({
      blockerTurnCount: 2,
      lastBlockerKind: 'awaiting-permission',
    });
    const r = recordBlockerAttempt(g, 'missing-dependency');
    expect(r.allowed).toBe(false);
    expect(r.nextCount).toBe(1);
    expect(r.nextKind).toBe('missing-dependency');
  });

  it('trims whitespace before comparison', () => {
    const g = makeGoal({
      blockerTurnCount: 2,
      lastBlockerKind: 'awaiting-permission',
    });
    const r = recordBlockerAttempt(g, '  awaiting-permission  ');
    expect(r.allowed).toBe(true);
    expect(r.nextKind).toBe('awaiting-permission');
  });
});

describe('resetBlockerCounter', () => {
  it('returns the canonical reset fields', () => {
    const r = resetBlockerCounter();
    expect(r.blockerTurnCount).toBe(0);
    expect(r.lastBlockerKind).toBeNull();
  });
});
