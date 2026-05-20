import { describe, expect, it } from 'vitest';

import {
  type CompactionInfoResolverProviderLookup,
  type LiveCompactionInfo,
  resolveEffectiveCompactionInfo,
} from './compaction-info.js';

function makeLookup(
  byName: Record<string, (model?: string) => number | undefined>,
): CompactionInfoResolverProviderLookup {
  return (name) => {
    const fn = byName[name];
    if (!fn) return undefined;
    return {
      getEffectiveContextWindow: (model) => {
        const value = fn(model);
        // The contract is that the provider's getter returns a `number`,
        // so undefined here exercises the fall-through path the React
        // call site relies on (CAP-056 1d).
        return value as unknown as number;
      },
    };
  };
}

const BASE: LiveCompactionInfo = {
  contextWindow: 200_000,
  triggerPercent: 60,
  enabled: true,
};

describe('resolveEffectiveCompactionInfo', () => {
  it('returns undefined when no startup info is provided', () => {
    expect(resolveEffectiveCompactionInfo(undefined, { provider: 'p' }, () => undefined)).toBeUndefined();
  });

  it('honours an explicit user-config override above everything else', () => {
    const startup: LiveCompactionInfo = {
      ...BASE,
      contextWindow: 50_000,
      userOverrideContextWindow: 50_000,
    };
    const lookup = makeLookup({ ark: () => 1_000_000 });
    const result = resolveEffectiveCompactionInfo(
      startup,
      { provider: 'ark', model: 'deepseek-v4-pro' },
      lookup,
    );
    expect(result?.contextWindow).toBe(50_000);
    // Identity preserved when the value already matches the override.
    expect(result).toBe(startup);
  });

  it('uses the active provider per-model value when no user override is set', () => {
    const lookup = makeLookup({
      ark: (model) => {
        if (model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash') return 1_000_000;
        if (model === 'deepseek-v3.2') return 128_000;
        return 200_000; // default model fallback
      },
    });
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'ark', model: 'deepseek-v4-pro' }, lookup)?.contextWindow,
    ).toBe(1_000_000);
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'ark', model: 'deepseek-v4-flash' }, lookup)?.contextWindow,
    ).toBe(1_000_000);
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'ark', model: 'deepseek-v3.2' }, lookup)?.contextWindow,
    ).toBe(128_000);
  });

  it('falls through to the startup contextWindow when provider lookup fails', () => {
    const lookup: CompactionInfoResolverProviderLookup = (name) => {
      throw new Error(`Provider not found: ${name}`);
    };
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'gone', model: 'whatever' }, lookup)?.contextWindow,
    ).toBe(200_000);
  });

  it('falls through to startup when provider has no getEffectiveContextWindow method', () => {
    const lookup: CompactionInfoResolverProviderLookup = () => ({});
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'x', model: 'm' }, lookup)?.contextWindow,
    ).toBe(200_000);
  });

  it('falls through to startup when provider returns undefined for unknown model', () => {
    const lookup = makeLookup({ ark: () => undefined });
    expect(
      resolveEffectiveCompactionInfo(BASE, { provider: 'ark', model: 'unknown' }, lookup)?.contextWindow,
    ).toBe(200_000);
  });

  it('preserves identity when the resolved value equals startup contextWindow', () => {
    const lookup = makeLookup({ ark: () => 200_000 });
    const result = resolveEffectiveCompactionInfo(BASE, { provider: 'ark', model: 'glm-5.1' }, lookup);
    // Same value → no allocation, same object identity (memo-friendly).
    expect(result).toBe(BASE);
  });

  it('preserves the other compactionInfo fields across resolution', () => {
    const startup: LiveCompactionInfo = {
      contextWindow: 200_000,
      triggerPercent: 75,
      enabled: false,
    };
    const lookup = makeLookup({ ark: () => 1_000_000 });
    const result = resolveEffectiveCompactionInfo(
      startup,
      { provider: 'ark', model: 'deepseek-v4-pro' },
      lookup,
    );
    expect(result).toEqual({
      contextWindow: 1_000_000,
      triggerPercent: 75,
      enabled: false,
    });
  });
});
