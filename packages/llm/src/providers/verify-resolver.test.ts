/**
 * FEATURE_216 v0.7.45 — Top-level helper unit tests.
 *
 * Covers `verifyProviderCredential(name)` short-circuit paths (unknown
 * name / cli-bridge / unconfigured env) WITHOUT hitting the wire and
 * WITHOUT instantiating Provider classes (which throw on missing key).
 *
 * Real wire happy-path is in `verify-credential-integration.test.ts`
 * (skipped when KODAX_INTEGRATION_TEST != '1').
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  listProviderModels,
  verifyProviderCredential,
} from './resolver.js';
import { registerCustomProviders } from './custom-registry.js';

describe('FEATURE_216 verifyProviderCredential — short-circuit paths', () => {
  it('unknown provider name → unsupported (no instantiation)', async () => {
    const r = await verifyProviderCredential('not-a-real-provider-name');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported');
    expect(r.strategy).toBe('unsupported');
    expect(r.message).toMatch(/Unknown provider/);
  });

  it('cli-bridge built-in (gemini-cli) → unsupported (no instantiation)', async () => {
    // gemini-cli has verifyStrategy='unsupported' in provider-capabilities.json;
    // top-level helper short-circuits BEFORE the ctor would touch any state.
    const r = await verifyProviderCredential('gemini-cli');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported');
    expect(r.strategy).toBe('unsupported');
  });

  it('cli-bridge built-in (codex-cli) → unsupported (no instantiation)', async () => {
    const r = await verifyProviderCredential('codex-cli');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported');
  });

  it('env var missing → unconfigured (no ctor throw)', async () => {
    const apiKeyEnv = 'KODAX_TEST_UNSET_KEY_DO_NOT_USE';
    const previous = process.env[apiKeyEnv];
    delete process.env[apiKeyEnv];

    registerCustomProviders([{
      name: 'custom-unconfigured-test',
      protocol: 'openai',
      apiKeyEnv,
      baseUrl: 'https://api.example.com',
      model: 'fake-model',
    }]);
    try {
      const r = await verifyProviderCredential('custom-unconfigured-test');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('unconfigured');
      expect(r.strategy).toBe('models-list'); // openai protocol default
      expect(r.message).toContain(apiKeyEnv);
    } finally {
      registerCustomProviders([]);
      if (previous !== undefined) process.env[apiKeyEnv] = previous;
    }
  });

  it('custom provider with anthropic protocol → strategy defaults to count-tokens', async () => {
    const apiKeyEnv = 'KODAX_TEST_UNSET_KEY_DO_NOT_USE';
    delete process.env[apiKeyEnv];
    registerCustomProviders([{
      name: 'custom-anthropic-unconfigured',
      protocol: 'anthropic',
      apiKeyEnv,
      baseUrl: 'https://api.example.com',
      model: 'fake-model',
    }]);
    try {
      const r = await verifyProviderCredential('custom-anthropic-unconfigured');
      expect(r.error).toBe('unconfigured');
      expect(r.strategy).toBe('count-tokens'); // anthropic protocol default
    } finally {
      registerCustomProviders([]);
    }
  });

  it('custom provider with explicit verifyStrategy override wins', async () => {
    const apiKeyEnv = 'KODAX_TEST_UNSET_KEY_DO_NOT_USE';
    delete process.env[apiKeyEnv];
    registerCustomProviders([{
      name: 'custom-explicit-strategy',
      protocol: 'anthropic',
      apiKeyEnv,
      baseUrl: 'https://api.example.com',
      model: 'fake-model',
      verifyStrategy: 'minimal-message',
    }]);
    try {
      const r = await verifyProviderCredential('custom-explicit-strategy');
      expect(r.error).toBe('unconfigured');
      expect(r.strategy).toBe('minimal-message');
    } finally {
      registerCustomProviders([]);
    }
  });
});

describe('FEATURE_216 listProviderModels — static path', () => {
  it('unknown provider name → failed', async () => {
    const r = await listProviderModels('not-a-real-name');
    expect(r.ok).toBe(false);
    expect(r.source).toBe('failed');
  });

  it('built-in provider → ok + static models from snapshot', async () => {
    const r = await listProviderModels('anthropic');
    expect(r.ok).toBe(true);
    expect(r.source).toBe('static');
    expect(Array.isArray(r.models)).toBe(true);
    expect(r.models?.length).toBeGreaterThanOrEqual(2);
    // Default model is first
    expect(r.models?.[0]).toBe('claude-sonnet-4-6');
  });

  it('cli-bridge provider → ok + filled static models', async () => {
    const r = await listProviderModels('gemini-cli');
    expect(r.ok).toBe(true);
    expect(r.source).toBe('static');
    expect(r.models?.length).toBeGreaterThan(0);
  });

  it('custom provider → ok + static models from custom config', async () => {
    registerCustomProviders([{
      name: 'custom-list-test',
      protocol: 'openai',
      apiKeyEnv: 'KODAX_TEST_KEY',
      baseUrl: 'https://api.example.com',
      model: 'custom-default',
      models: ['custom-alt-1', 'custom-alt-2'],
    }]);
    try {
      const r = await listProviderModels('custom-list-test');
      expect(r.ok).toBe(true);
      expect(r.source).toBe('static');
      expect(r.models).toEqual(['custom-default', 'custom-alt-1', 'custom-alt-2']);
    } finally {
      registerCustomProviders([]);
    }
  });
});

describe('FEATURE_216 custom provider validator — verifyStrategy guards', () => {
  it('rejects openai protocol with verifyStrategy="count-tokens"', () => {
    expect(() =>
      registerCustomProviders([{
        name: 'bad-config',
        protocol: 'openai',
        apiKeyEnv: 'K',
        baseUrl: 'https://api.example.com',
        model: 'm',
        verifyStrategy: 'count-tokens',
      }]),
    ).toThrow(/verifyStrategy="count-tokens" requires Anthropic protocol/);
  });

  it('rejects unknown verifyStrategy value', () => {
    expect(() =>
      registerCustomProviders([{
        name: 'bad-config',
        protocol: 'anthropic',
        apiKeyEnv: 'K',
        baseUrl: 'https://api.example.com',
        model: 'm',
        // @ts-expect-error intentionally bad value
        verifyStrategy: 'send-postcard',
      }]),
    ).toThrow(/Unknown verifyStrategy/);
  });

  it('accepts anthropic protocol with verifyStrategy="count-tokens" / "minimal-message" / "models-list" / "unsupported"', () => {
    for (const strategy of ['count-tokens', 'minimal-message', 'models-list', 'unsupported'] as const) {
      expect(() =>
        registerCustomProviders([{
          name: `ok-${strategy}`,
          protocol: 'anthropic',
          apiKeyEnv: 'K',
          baseUrl: 'https://api.example.com',
          model: 'm',
          verifyStrategy: strategy,
        }]),
      ).not.toThrow();
      registerCustomProviders([]);
    }
  });
});
