import { describe, expect, it } from 'vitest';
import { adaptiveTriggerPercent, loadCompactionConfig } from './compaction-config.js';

describe('adaptiveTriggerPercent', () => {
  it('uses capacity-only 100% for every context window', () => {
    for (const window of [undefined, -1, 0, 100_000, 200_000, 500_000, 1_000_000]) {
      expect(adaptiveTriggerPercent(window)).toBe(100);
    }
  });
});

describe('loadCompactionConfig - capacity-driven default', () => {
  it('keeps compaction enabled by default', async () => {
    expect((await loadCompactionConfig(200_000)).enabled).toBe(true);
    expect((await loadCompactionConfig(1_000_000)).enabled).toBe(true);
  });

  it('uses a valid trigger in the 1..100 range', async () => {
    for (const window of [100_000, 200_000, 256_000, 500_000, 1_000_000]) {
      const config = await loadCompactionConfig(window);
      expect(config.triggerPercent).toBeGreaterThanOrEqual(1);
      expect(config.triggerPercent).toBeLessThanOrEqual(100);
    }
  });

  it('is stable across windows unless the user explicitly overrides it', async () => {
    const small = await loadCompactionConfig(200_000);
    const large = await loadCompactionConfig(1_000_000);
    expect(small.triggerPercent).toBe(large.triggerPercent);
  });
});

describe('loadCompactionConfig - SDK overrides', () => {
  it('lets an explicit early trigger win over the capacity-only default', async () => {
    const config = await loadCompactionConfig(1_000_000, { triggerPercent: 42 });
    expect(config.triggerPercent).toBe(42);
  });

  it('applies an SDK context-window override without inventing an early trigger', async () => {
    const viaArgument = await loadCompactionConfig(200_000);
    const viaSdk = await loadCompactionConfig(1_000_000, {
      contextWindow: 200_000,
    });
    expect(viaSdk.contextWindow).toBe(200_000);
    expect(viaSdk.triggerPercent).toBe(viaArgument.triggerPercent);
  });

  it('lets the SDK disable compaction', async () => {
    expect((await loadCompactionConfig(200_000, { enabled: false })).enabled).toBe(false);
  });

  it('falls through when override fields are omitted', async () => {
    const base = await loadCompactionConfig(1_000_000);
    const withEmptyOverride = await loadCompactionConfig(1_000_000, {});
    expect(withEmptyOverride).toEqual(base);
  });
});
