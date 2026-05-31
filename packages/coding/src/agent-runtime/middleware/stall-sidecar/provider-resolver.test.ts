/**
 * FEATURE_187 (v0.7.43) Phase B — Stall sidecar provider resolver tests.
 *
 * Mirrors `verifier-provider-resolver.test.ts` shape. Covers:
 *   - default inherit-main (no env)
 *   - partial env (one of two vars set) falls through to inherit-main
 *   - unknown provider name silently falls through to inherit-main
 *     (typo guard — F178 anti-loop is too valuable to disable on a typo)
 *   - explicit env override (both vars set, valid provider)
 *   - always-defined contract (sweep multiple env states)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXBaseProvider } from '@kodax-ai/llm';

import {
  STALL_MODEL_ENV,
  STALL_PROVIDER_ENV,
  resolveStallSidecarProvider,
} from './provider-resolver.js';

// `tryGetProvider` instantiates the named provider, which requires its API key
// (v0.7.45 FEATURE_102-A moved coding-plan keys onto dedicated env vars). Stub
// the keys used by the explicit-override cases so the named providers resolve
// instead of silently falling back to inherit-main.
beforeEach(() => {
  vi.stubEnv('KIMI_CODE_API_KEY', 'test-key');
  vi.stubEnv('ARK_CODING_API_KEY', 'test-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeMainProvider(): KodaXBaseProvider {
  return {
    name: 'fake-main',
    stream: async () => ({ textBlocks: [], toolBlocks: [], thinkingBlocks: [] }),
  } as unknown as KodaXBaseProvider;
}

function emptyEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

describe('resolveStallSidecarProvider — default inherit-main', () => {
  it('returns main provider/model when no env override set', () => {
    const main = fakeMainProvider();
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env: emptyEnv(),
    });
    expect(r.provider).toBe(main);
    expect(r.providerName).toBe('zhipu-coding');
    expect(r.model).toBe('glm-5.1');
    expect(r.source).toBe('inherit-main');
  });

  it('inherits main even when only KODAX_STALL_PROVIDER set (model missing)', () => {
    // Explicit override is all-or-nothing. Partial env intentionally
    // falls through to inherit-main rather than guessing the missing
    // model from the named provider's default.
    const main = fakeMainProvider();
    const env = { [STALL_PROVIDER_ENV]: 'kimi-code' } as NodeJS.ProcessEnv;
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.source).toBe('inherit-main');
    expect(r.providerName).toBe('zhipu-coding');
  });

  it('inherits main when only KODAX_STALL_MODEL set (provider missing)', () => {
    const main = fakeMainProvider();
    const env = { [STALL_MODEL_ENV]: 'glm-4.7' } as NodeJS.ProcessEnv;
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.source).toBe('inherit-main');
    expect(r.model).toBe('glm-5.1');
  });

  it('inherits main when explicit provider name is unknown (typo guard)', () => {
    const main = fakeMainProvider();
    const env = {
      [STALL_PROVIDER_ENV]: 'not-a-real-provider',
      [STALL_MODEL_ENV]: 'fake-model',
    } as NodeJS.ProcessEnv;
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.source).toBe('inherit-main');
    expect(r.providerName).toBe('zhipu-coding');
  });
});

describe('resolveStallSidecarProvider — explicit env override', () => {
  it('uses KODAX_STALL_PROVIDER + KODAX_STALL_MODEL when both set + valid', () => {
    const main = fakeMainProvider();
    const env = {
      [STALL_PROVIDER_ENV]: 'kimi-code',
      [STALL_MODEL_ENV]: 'kimi-for-coding',
    } as NodeJS.ProcessEnv;
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.providerName).toBe('kimi-code');
    expect(r.model).toBe('kimi-for-coding');
    expect(r.source).toBe('explicit-env');
    // Stall sidecar provider instance is the env-named provider (not main)
    expect(r.provider).not.toBe(main);
  });

  it('explicit env override wins over inherit-main path', () => {
    const main = fakeMainProvider();
    const env = {
      [STALL_PROVIDER_ENV]: 'ark-coding',
      [STALL_MODEL_ENV]: 'deepseek-v4-flash',
    } as NodeJS.ProcessEnv;
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.providerName).toBe('ark-coding');
    expect(r.model).toBe('deepseek-v4-flash');
    expect(r.source).toBe('explicit-env');
  });
});

describe('resolveStallSidecarProvider — undefined mainModel sentinel', () => {
  it('propagates undefined mainModel as undefined model on inherit-main path', () => {
    // Regression pin for the Phase B code review HIGH finding: callers
    // (`runner-driven.ts`) MUST pass `undefined` (not the truthy string
    // 'unknown') when no model is configured. The resolved `model`
    // field then short-circuits `invokeStallSidecar`'s
    // `options.model ? {modelOverride} : undefined` guard correctly.
    const main = fakeMainProvider();
    const r = resolveStallSidecarProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: undefined,
      env: emptyEnv(),
    });
    expect(r.source).toBe('inherit-main');
    expect(r.model).toBeUndefined();
    expect(r.providerName).toBe('zhipu-coding');
  });
});

describe('resolveStallSidecarProvider — always-defined contract', () => {
  it('never returns undefined; inherit-main is the safe terminal fallback', () => {
    // Sweep multiple env configurations — none should produce undefined.
    const main = fakeMainProvider();
    const envs: NodeJS.ProcessEnv[] = [
      emptyEnv(),
      { OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv,
      { [STALL_PROVIDER_ENV]: 'bogus' } as NodeJS.ProcessEnv,
      { [STALL_MODEL_ENV]: 'bogus' } as NodeJS.ProcessEnv,
    ];
    for (const env of envs) {
      const r = resolveStallSidecarProvider({
        mainProvider: main,
        mainProviderName: 'zhipu-coding',
        mainModel: 'glm-5.1',
        env,
      });
      expect(r).toBeDefined();
      expect(r.provider).toBeDefined();
      expect(r.source).toBe('inherit-main');
    }
  });
});
