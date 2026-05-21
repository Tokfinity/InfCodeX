/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier provider resolver tests.
 *
 * Covers the three-step resolution order, decoupling guarantees
 * (no zhipu fallback), and `source` telemetry tagging. Uses synthetic
 * env objects so real `process.env` is not mutated.
 */

import { describe, expect, it } from 'vitest';

import {
  PREFERRED_VERIFIER_CANDIDATES,
  VERIFIER_MODEL_ENV,
  VERIFIER_PROVIDER_ENV,
  resolveVerifierProvider,
} from './verifier-provider-resolver.js';

function emptyEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

describe('PREFERRED_VERIFIER_CANDIDATES — architectural constraints', () => {
  it('lists only model-family-decoupled candidates (no zhipu/glm51 family)', () => {
    // The whole point of the resolver: never auto-pick the same model
    // family as the documented main-agent floor (zhipu · glm-5.1 OR
    // ark-coding · glm-5.1 — both run the same underlying model).
    for (const c of PREFERRED_VERIFIER_CANDIDATES) {
      expect(c.model).not.toBe('glm-5.1');
      expect(c.providerName).not.toBe('zhipu-coding');
    }
  });

  it('only uses coding-plan provider names (cost control)', () => {
    const codingPlanProviders = new Set([
      'kimi-code',
      'ark-coding',
      'zhipu-coding',
      'minimax-coding',
      'mimo-coding',
    ]);
    for (const c of PREFERRED_VERIFIER_CANDIDATES) {
      expect(codingPlanProviders.has(c.providerName)).toBe(true);
    }
  });

  it('is frozen — cannot be mutated by callers', () => {
    expect(Object.isFrozen(PREFERRED_VERIFIER_CANDIDATES)).toBe(true);
    expect(Object.isFrozen(PREFERRED_VERIFIER_CANDIDATES[0])).toBe(true);
  });
});

describe('resolveVerifierProvider — explicit env override', () => {
  it('uses KODAX_VERIFIER_PROVIDER + KODAX_VERIFIER_MODEL when both set', () => {
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'kimi-code',
      [VERIFIER_MODEL_ENV]: 'kimi-for-coding',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r).toBeDefined();
    expect(r?.providerName).toBe('kimi-code');
    expect(r?.model).toBe('kimi-for-coding');
    expect(r?.source).toBe('explicit-env');
  });

  it('falls through when ONLY KODAX_VERIFIER_PROVIDER set (model missing)', () => {
    // Explicit override is all-or-nothing. Falling through is safer
    // than silently using the provider's default model — caller may
    // have intended a non-default model and forgotten the env var.
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'kimi-code',
      // No KODAX_VERIFIER_MODEL
      KIMI_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    // Falls through to step 2; KIMI_API_KEY is set so kimi-code wins
    expect(r?.source).toBe('default-preferred');
    expect(r?.providerName).toBe('kimi-code');
    expect(r?.model).toBe('kimi-for-coding'); // default from preferred list
  });

  it('falls through when explicit provider name is unknown', () => {
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'not-a-real-provider',
      [VERIFIER_MODEL_ENV]: 'fake-model',
      KIMI_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r?.source).toBe('default-preferred');
    expect(r?.providerName).toBe('kimi-code');
  });
});

describe('resolveVerifierProvider — default preferred list', () => {
  it('picks kimi-code first when KIMI_API_KEY is set', () => {
    const env = {
      KIMI_API_KEY: 'sk-test',
      ARK_API_KEY: 'ark-test',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r?.providerName).toBe('kimi-code');
    expect(r?.model).toBe('kimi-for-coding');
    expect(r?.source).toBe('default-preferred');
  });

  it('falls back to ark-coding when only ARK_API_KEY is set', () => {
    const env = { ARK_API_KEY: 'ark-test' } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r?.providerName).toBe('ark-coding');
    expect(r?.model).toBe('deepseek-v4-flash');
    expect(r?.source).toBe('default-preferred');
  });

  it('does NOT fall back to zhipu even when only ZHIPU_API_KEY is set', () => {
    // Architectural guarantee: never use zhipu/glm-5.1 as verifier.
    // Same model family as the documented floor would defeat the
    // decoupling purpose.
    const env = { ZHIPU_API_KEY: 'zhipu-test' } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r).toBeUndefined();
  });
});

describe('resolveVerifierProvider — no candidates available', () => {
  it('returns undefined when no API keys set (caller skips verifier)', () => {
    const r = resolveVerifierProvider(emptyEnv());
    expect(r).toBeUndefined();
  });

  it('returns undefined when only unrelated API keys set', () => {
    const env = {
      OPENAI_API_KEY: 'openai-test',
      GEMINI_API_KEY: 'gemini-test',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r).toBeUndefined();
  });

  it('treats empty-string API key as absent', () => {
    const env = {
      KIMI_API_KEY: '',
      ARK_API_KEY: '',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r).toBeUndefined();
  });
});

describe('resolveVerifierProvider — explicit override priority over default', () => {
  it('explicit env wins even when default-preferred candidates available', () => {
    const env = {
      [VERIFIER_PROVIDER_ENV]: 'ark-coding',
      [VERIFIER_MODEL_ENV]: 'deepseek-v4-pro',
      KIMI_API_KEY: 'sk-test', // would be picked first in default path
      ARK_API_KEY: 'ark-test',
    } as NodeJS.ProcessEnv;
    const r = resolveVerifierProvider(env);
    expect(r?.providerName).toBe('ark-coding');
    expect(r?.model).toBe('deepseek-v4-pro');
    expect(r?.source).toBe('explicit-env');
  });
});
