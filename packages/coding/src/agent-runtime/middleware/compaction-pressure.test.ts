import { describe, expect, it } from 'vitest';

import {
  consumeCompactionCooldown,
  createCompactionAntiThrashState,
  recordCompactionSavings,
  shouldSkipLlmCompaction,
} from './compaction-pressure.js';

describe('compaction anti-thrashing state', () => {
  it('starts inactive', () => {
    const state = createCompactionAntiThrashState();

    expect(shouldSkipLlmCompaction(state)).toBe(false);
    expect(state.lowSavingsStreak).toBe(0);
    expect(state.cooldownTurnsRemaining).toBe(0);
  });

  it('enters cooldown after two consecutive low-savings compactions', () => {
    const first = recordCompactionSavings(
      createCompactionAntiThrashState(),
      { tokensBefore: 1_000, tokensAfter: 950 },
    );
    const second = recordCompactionSavings(
      first.state,
      { tokensBefore: 1_000, tokensAfter: 930 },
    );

    expect(first.enteredCooldown).toBe(false);
    expect(first.state.lowSavingsStreak).toBe(1);
    expect(second.enteredCooldown).toBe(true);
    expect(second.state.lowSavingsStreak).toBe(0);
    expect(second.state.cooldownTurnsRemaining).toBeGreaterThan(0);
    expect(shouldSkipLlmCompaction(second.state)).toBe(true);
  });

  it('resets low-savings streak after useful compaction', () => {
    const first = recordCompactionSavings(
      createCompactionAntiThrashState(),
      { tokensBefore: 1_000, tokensAfter: 950 },
    );
    const useful = recordCompactionSavings(
      first.state,
      { tokensBefore: 1_000, tokensAfter: 700 },
    );

    expect(useful.enteredCooldown).toBe(false);
    expect(useful.state.lowSavingsStreak).toBe(0);
    expect(useful.state.cooldownTurnsRemaining).toBe(0);
  });

  it('decrements cooldown without going negative', () => {
    const cooled = {
      lowSavingsStreak: 0,
      cooldownTurnsRemaining: 2,
    };

    const once = consumeCompactionCooldown(cooled);
    const twice = consumeCompactionCooldown(once);
    const third = consumeCompactionCooldown(twice);

    expect(once.cooldownTurnsRemaining).toBe(1);
    expect(twice.cooldownTurnsRemaining).toBe(0);
    expect(third.cooldownTurnsRemaining).toBe(0);
  });

  it('does not recompact the same covered context until meaningful new growth', () => {
    const compacted = recordCompactionSavings(
      createCompactionAntiThrashState(),
      { tokensBefore: 100_000, tokensAfter: 76_000 },
    );

    expect(shouldSkipLlmCompaction(compacted.state, 76_000)).toBe(true);
    expect(shouldSkipLlmCompaction(compacted.state, 77_000)).toBe(true);
    expect(shouldSkipLlmCompaction(compacted.state, 84_000)).toBe(false);
  });
});
