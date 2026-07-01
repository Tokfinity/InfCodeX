import { describe, expect, it } from 'vitest';
import {
  getRunScopedConfig,
  runWithScopedConfig,
  resolveWorkflowMaxConcurrency,
  WORKFLOW_MAX_CONCURRENCY_DEFAULT,
} from '@kodax-ai/llm';

import { resolveModelHintTier } from './model-hint-routing.js';

/**
 * Run-scoped config (AsyncLocalStorage) — the concurrency-safe replacement for
 * the global-env bridge on the SDK path. runManagedTask wraps each run in
 * runWithScopedConfig(options-derived config); readers (here resolveModelHintTier)
 * read the store first, env fallback second. The concurrency test is the point:
 * two overlapping runs with different tiers must NOT clobber each other.
 */
describe('run-scoped model tiers (ALS, concurrency-safe)', () => {
  it('resolveModelHintTier reads the run-scoped deep tier (any child)', () => {
    const tier = runWithScopedConfig(
      { modelTiers: { deep: { provider: 'zhipu-coding', model: 'glm-5.2' } } },
      () => resolveModelHintTier('deep', false),
    );
    expect(tier).toEqual({ provider: 'zhipu-coding', model: 'glm-5.2' });
  });

  it("'fast' tier stays read-only-gated (write child gets no tier)", () => {
    const cfg = { modelTiers: { fast: { provider: 'deepseek', model: 'deepseek-v4-flash' } } };
    expect(runWithScopedConfig(cfg, () => resolveModelHintTier('fast', true)))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(runWithScopedConfig(cfg, () => resolveModelHintTier('fast', false))).toBeUndefined();
  });

  it('concurrent runs with different tiers do NOT clobber each other', async () => {
    const runA = runWithScopedConfig({ modelTiers: { deep: { model: 'A' } } }, async () => {
      await new Promise((r) => setTimeout(r, 5)); // let run B interleave
      return resolveModelHintTier('deep', false)?.model;
    });
    const runB = runWithScopedConfig({ modelTiers: { deep: { model: 'B' } } }, async () =>
      resolveModelHintTier('deep', false)?.model,
    );
    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('falls back to env outside any run-scoped context', () => {
    const saved = { p: process.env.KODAX_DEEP_PROVIDER, m: process.env.KODAX_DEEP_MODEL };
    try {
      delete process.env.KODAX_DEEP_PROVIDER;
      process.env.KODAX_DEEP_MODEL = 'env-model';
      expect(getRunScopedConfig()).toBeUndefined();
      expect(resolveModelHintTier('deep', false)).toEqual({ provider: undefined, model: 'env-model' });
    } finally {
      if (saved.p === undefined) delete process.env.KODAX_DEEP_PROVIDER; else process.env.KODAX_DEEP_PROVIDER = saved.p;
      if (saved.m === undefined) delete process.env.KODAX_DEEP_MODEL; else process.env.KODAX_DEEP_MODEL = saved.m;
    }
  });
});

describe('resolveWorkflowMaxConcurrency (default 8, configurable, clamped)', () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
    try {
      if (value === undefined) delete process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
      else process.env.KODAX_WORKFLOW_MAX_CONCURRENCY = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
      else process.env.KODAX_WORKFLOW_MAX_CONCURRENCY = saved;
    }
  }

  it('defaults to 8 with no override', () => {
    withEnv(undefined, () => {
      expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT);
      expect(WORKFLOW_MAX_CONCURRENCY_DEFAULT).toBe(8);
    });
  });

  it('reads the KODAX_WORKFLOW_MAX_CONCURRENCY env bridge', () => {
    withEnv('4', () => expect(resolveWorkflowMaxConcurrency()).toBe(4));
  });

  it('run-scoped SDK config wins over the env bridge', () => {
    withEnv('4', () => {
      const resolved = runWithScopedConfig(
        { workflow: { maxConcurrency: 12 } },
        () => resolveWorkflowMaxConcurrency(),
      );
      expect(resolved).toBe(12);
    });
  });

  it('clamps to [1, 32] and ignores non-positive/garbage values', () => {
    withEnv('999', () => expect(resolveWorkflowMaxConcurrency()).toBe(32));
    withEnv('0', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    withEnv('-5', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    withEnv('abc', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    expect(
      runWithScopedConfig({ workflow: { maxConcurrency: 100 } }, () => resolveWorkflowMaxConcurrency()),
    ).toBe(32);
  });
});
