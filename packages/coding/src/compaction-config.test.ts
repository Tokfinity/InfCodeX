import { describe, expect, it } from 'vitest';
import { adaptiveTriggerPercent, loadCompactionConfig } from './compaction-config.js';

describe('adaptiveTriggerPercent', () => {
  it('uses the product default 75% for every context window', () => {
    for (const window of [undefined, -1, 0, 100_000, 200_000, 500_000, 1_000_000]) {
      expect(adaptiveTriggerPercent(window)).toBe(75);
    }
  });
});

describe('loadCompactionConfig - always-on default', () => {
  it('keeps compaction enabled by default', async () => {
    expect((await loadCompactionConfig(200_000)).enabled).toBe(true);
    expect((await loadCompactionConfig(1_000_000)).enabled).toBe(true);
  });

  it('uses a valid trigger in the 15..90 range', async () => {
    for (const window of [100_000, 200_000, 256_000, 500_000, 1_000_000]) {
      const config = await loadCompactionConfig(window);
      expect(config.triggerPercent).toBeGreaterThanOrEqual(15);
      expect(config.triggerPercent).toBeLessThanOrEqual(90);
    }
  });

  it('is stable across windows unless the user explicitly overrides it', async () => {
    const small = await loadCompactionConfig(200_000);
    const large = await loadCompactionConfig(1_000_000);
    expect(small.triggerPercent).toBe(large.triggerPercent);
  });
});

describe('loadCompactionConfig - SDK overrides', () => {
  it('lets an explicit trigger win over the default', async () => {
    const config = await loadCompactionConfig(1_000_000, { triggerPercent: 42 });
    expect(config.triggerPercent).toBe(42);
  });

  it('applies an SDK context-window override without changing the default percentage', async () => {
    const viaArgument = await loadCompactionConfig(200_000);
    const viaSdk = await loadCompactionConfig(1_000_000, {
      contextWindow: 200_000,
    });
    expect(viaSdk.contextWindow).toBe(200_000);
    expect(viaSdk.triggerPercent).toBe(viaArgument.triggerPercent);
  });

  it('normalizes the deprecated SDK disable flag back to enabled', async () => {
    expect((await loadCompactionConfig(200_000, { enabled: false })).enabled).toBe(true);
  });

  it('clamps percentage overrides and exposes the absolute token threshold', async () => {
    expect((await loadCompactionConfig(1_000_000, { triggerPercent: 1 })).triggerPercent).toBe(15);
    expect((await loadCompactionConfig(1_000_000, { triggerPercent: 99 })).triggerPercent).toBe(90);
    expect((await loadCompactionConfig(1_000_000, { triggerTokens: 300_000 })).triggerTokens).toBe(300_000);
    expect((await loadCompactionConfig(1_000_000, { triggerTokens: 0 })).triggerTokens).toBeUndefined();
  });

  it('falls through when override fields are omitted', async () => {
    const base = await loadCompactionConfig(1_000_000);
    const withEmptyOverride = await loadCompactionConfig(1_000_000, {});
    expect(withEmptyOverride).toEqual(base);
  });
});
