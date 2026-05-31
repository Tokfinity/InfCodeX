import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveModelHintTier } from './model-hint-routing.js';

describe('resolveModelHintTier (FEATURE_102 P1-auto)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes a read-only `fast` child to the configured cheap tier', () => {
    vi.stubEnv('KODAX_FAST_PROVIDER', 'ark-coding');
    vi.stubEnv('KODAX_FAST_MODEL', 'deepseek-v4-flash');
    expect(resolveModelHintTier('fast', true)).toEqual({
      provider: 'ark-coding',
      model: 'deepseek-v4-flash',
    });
  });

  it('does NOT route a write `fast` child (cheap tier is read-only-gated)', () => {
    vi.stubEnv('KODAX_FAST_PROVIDER', 'ark-coding');
    vi.stubEnv('KODAX_FAST_MODEL', 'deepseek-v4-flash');
    expect(resolveModelHintTier('fast', false)).toBeUndefined();
  });

  it('returns undefined for `fast` when the cheap tier is unconfigured (default OFF)', () => {
    expect(resolveModelHintTier('fast', true)).toBeUndefined();
  });

  it('routes `deep` to the strong tier regardless of read/write', () => {
    vi.stubEnv('KODAX_DEEP_PROVIDER', 'anthropic');
    vi.stubEnv('KODAX_DEEP_MODEL', 'claude-opus-4-8');
    expect(resolveModelHintTier('deep', true)).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(resolveModelHintTier('deep', false)).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('treats `balanced` and undefined as parent (no routing)', () => {
    vi.stubEnv('KODAX_FAST_MODEL', 'deepseek-v4-flash');
    expect(resolveModelHintTier('balanced', true)).toBeUndefined();
    expect(resolveModelHintTier(undefined, true)).toBeUndefined();
  });

  it('tolerates a partial tier (only model configured)', () => {
    vi.stubEnv('KODAX_FAST_MODEL', 'deepseek-v4-flash');
    expect(resolveModelHintTier('fast', true)).toEqual({ provider: undefined, model: 'deepseek-v4-flash' });
  });

  it('ignores whitespace-only env values', () => {
    vi.stubEnv('KODAX_FAST_PROVIDER', '   ');
    vi.stubEnv('KODAX_FAST_MODEL', '');
    expect(resolveModelHintTier('fast', true)).toBeUndefined();
  });
});
