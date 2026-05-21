/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier provider resolver tests.
 *
 * Covers the corrected (2026-05-21) design: default-inherit-main with
 * env-var override. The architectural value is the Stop-hook shape,
 * not automatic model-family decoupling — model decoupling is an
 * opt-in escape hatch via env vars.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXBaseProvider } from '@kodax-ai/llm';

import {
  VERIFIER_MODEL_ENV,
  VERIFIER_PROVIDER_ENV,
  resolveVerifierProvider,
} from './verifier-provider-resolver.js';

function fakeMainProvider(): KodaXBaseProvider {
  return {
    name: 'fake-main',
    stream: async () => ({ textBlocks: [], toolBlocks: [], thinkingBlocks: [] }),
  } as unknown as KodaXBaseProvider;
}

function emptyEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

describe('resolveVerifierProvider — default inherit-main', () => {
  it('returns main provider/model when no env override set', () => {
    const main = fakeMainProvider();
    const r = resolveVerifierProvider({
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

  it('inherits main even when only KODAX_VERIFIER_PROVIDER set (model missing)', () => {
    // Explicit override is all-or-nothing. Partial env intentionally
    // falls through to inherit-main rather than guessing the missing
    // model from the named provider's default.
    const main = fakeMainProvider();
    const env = { [VERIFIER_PROVIDER_ENV]: 'kimi-code' } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.source).toBe('inherit-main');
    expect(r.providerName).toBe('zhipu-coding');
  });

  it('inherits main when only KODAX_VERIFIER_MODEL set (provider missing)', () => {
    const main = fakeMainProvider();
    const env = { [VERIFIER_MODEL_ENV]: 'glm-4.7' } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider({
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
      [VERIFIER_PROVIDER_ENV]: 'not-a-real-provider',
      [VERIFIER_MODEL_ENV]: 'fake-model',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.source).toBe('inherit-main');
    expect(r.providerName).toBe('zhipu-coding');
  });
});

describe('resolveVerifierProvider — explicit env override', () => {
  it('uses KODAX_VERIFIER_PROVIDER + KODAX_VERIFIER_MODEL when both set + valid', () => {
    const main = fakeMainProvider();
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'kimi-code',
      [VERIFIER_MODEL_ENV]: 'kimi-for-coding',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider({
      mainProvider: main,
      mainProviderName: 'zhipu-coding',
      mainModel: 'glm-5.1',
      env,
    });
    expect(r.providerName).toBe('kimi-code');
    expect(r.model).toBe('kimi-for-coding');
    expect(r.source).toBe('explicit-env');
    // Verifier provider instance is the env-named provider (not main)
    expect(r.provider).not.toBe(main);
  });

  it('explicit env override wins over inherit-main path', () => {
    const main = fakeMainProvider();
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'ark-coding',
      [VERIFIER_MODEL_ENV]: 'deepseek-v4-flash',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider({
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

describe('resolveVerifierProvider — always-defined contract', () => {
  it('never returns undefined; inherit-main is the safe terminal fallback', () => {
    // Sweep multiple env configurations — none should produce undefined.
    const main = fakeMainProvider();
    const envs: NodeJS.ProcessEnv[] = [
      emptyEnv(),
      { OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv,
      { [VERIFIER_PROVIDER_ENV]: 'bogus' } as NodeJS.ProcessEnv,
      { [VERIFIER_MODEL_ENV]: 'bogus' } as NodeJS.ProcessEnv,
    ];
    for (const env of envs) {
      const r = resolveVerifierProvider({
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
