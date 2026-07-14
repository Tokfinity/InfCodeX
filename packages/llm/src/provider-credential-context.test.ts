import { describe, expect, it } from 'vitest';

import {
  getScopedProviderCredential,
  redactScopedProviderCredential,
  resolveProviderCredential,
  runWithProviderCredential,
} from './provider-credential-context.js';
import {
  getProvider,
  isProviderConfigured,
  resetBuiltinProviderCache,
} from './providers/registry.js';

describe('provider credential context', () => {
  it('isolates concurrent run credentials and clears them outside the scope', async () => {
    const [first, second] = await Promise.all([
      runWithProviderCredential('openai', 'first-secret', async () => {
        await Promise.resolve();
        return getScopedProviderCredential('openai');
      }),
      runWithProviderCredential('openai', 'second-secret', async () => {
        await Promise.resolve();
        return getScopedProviderCredential('openai');
      }),
    ]);

    expect(first).toBe('first-secret');
    expect(second).toBe('second-secret');
    expect(getScopedProviderCredential('openai')).toBeUndefined();
  });

  it('never falls back to an ambient credential inside a mismatched run scope', () => {
    expect(resolveProviderCredential('openai', 'ambient-secret')).toBe('ambient-secret');

    const resolved = runWithProviderCredential('anthropic', 'leased-secret', () => ({
      matching: resolveProviderCredential('anthropic', 'ambient-secret'),
      mismatched: resolveProviderCredential('openai', 'ambient-secret'),
    }));

    expect(resolved).toEqual({ matching: 'leased-secret', mismatched: undefined });
  });

  it('satisfies provider configuration checks only inside the matching run scope', () => {
    const previous = process.env.KODAX_OPENAI_API_KEY;
    delete process.env.KODAX_OPENAI_API_KEY;
    resetBuiltinProviderCache();
    try {
      expect(isProviderConfigured('openai')).toBe(false);
      expect(getProvider('openai').isConfigured()).toBe(false);

      runWithProviderCredential('openai', 'leased-secret', () => {
        expect(isProviderConfigured('openai')).toBe(true);
        expect(getProvider('openai').isConfigured()).toBe(true);
      });

      expect(isProviderConfigured('openai')).toBe(false);
      expect(getProvider('openai').isConfigured()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_OPENAI_API_KEY;
      } else {
        process.env.KODAX_OPENAI_API_KEY = previous;
      }
      resetBuiltinProviderCache();
    }
  });

  it('redacts nested, cyclic, error, key, and non-plain diagnostic values', () => {
    const credential = 'leased-secret';
    const detail: Record<string, unknown> = {
      [`token-${credential}`]: [credential, new Error(`failed with ${credential}`)],
      url: new URL(`https://example.test/?token=${credential}`),
    };
    detail.self = detail;

    const redacted = runWithProviderCredential('openai', credential, () =>
      redactScopedProviderCredential(detail));

    expect(redacted).not.toBe(detail);
    expect(redacted.self).toBe(redacted);
    const { self: _self, ...serializable } = redacted;
    expect(JSON.stringify(serializable)).not.toContain(credential);
    expect(Object.keys(redacted)).toContain('token-[REDACTED_CREDENTIAL]');
    const entries = redacted['token-[REDACTED_CREDENTIAL]'];
    expect(entries).toBeInstanceOf(Array);
    const error = (entries as unknown[])[1];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('failed with [REDACTED_CREDENTIAL]');
    expect(redacted.url).toEqual({});
    expect(redactScopedProviderCredential(detail)).toBe(detail);
  });

  it('rejects empty credential scopes', () => {
    expect(() => runWithProviderCredential('', 'secret', () => undefined)).toThrow(
      'requires non-empty values',
    );
    expect(() => runWithProviderCredential('openai', '', () => undefined)).toThrow(
      'requires non-empty values',
    );
  });
});
