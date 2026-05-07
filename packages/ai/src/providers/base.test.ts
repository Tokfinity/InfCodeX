import { describe, expect, it, vi } from 'vitest';
import { KodaXBaseProvider } from './base.js';
import type { KodaXOnRetryAfterCallback } from './base.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '../types.js';

class TestProvider extends KodaXBaseProvider {
  readonly name = 'test-provider';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_PROVIDER_API_KEY',
    model: 'default-model',
    models: [
      { id: 'native-toggle-model', reasoningCapability: 'native-toggle' },
      { id: 'plain-model' },
      {
        id: 'small-window-model',
        contextWindow: 50_000,
        maxOutputTokens: 8_000,
      },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new Error('not implemented in unit test');
  }

  exposeConfiguredReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    return this.getConfiguredReasoningCapability(modelOverride);
  }

  exposeShouldFallbackForReasoningError(error: unknown, ...terms: string[]): boolean {
    return this.shouldFallbackForReasoningError(error, ...terms);
  }

  exposeReasoningFallbackChain(capability: KodaXReasoningCapability): KodaXReasoningCapability[] {
    return this.getReasoningFallbackChain(capability);
  }

  exposeNormalizeReasoning(reasoning?: boolean | KodaXReasoningRequest): Required<KodaXReasoningRequest> {
    return this.normalizeReasoning(reasoning);
  }

  exposeWithRateLimit<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void,
    onRetryAfter?: KodaXOnRetryAfterCallback,
  ): Promise<T> {
    return this.withRateLimit(fn, signal, retries, onRateLimit, onRetryAfter);
  }
}

describe('KodaXBaseProvider', () => {
  it('deduplicates the default model from getAvailableModels', () => {
    const provider = new TestProvider();
    expect(provider.getAvailableModels()).toEqual([
      'default-model',
      'native-toggle-model',
      'plain-model',
      'small-window-model',
    ]);
  });

  it('prefers model-specific reasoning capability overrides from descriptors', () => {
    const provider = new TestProvider();
    expect(provider.exposeConfiguredReasoningCapability()).toBe('native-budget');
    expect(provider.exposeConfiguredReasoningCapability('native-toggle-model')).toBe('native-toggle');
  });

  it('recognizes unsupported parameter errors for reasoning fallback', () => {
    const provider = new TestProvider();
    expect(
      provider.exposeShouldFallbackForReasoningError(
        new Error('Unsupported reasoning_effort parameter'),
        'reasoning_effort',
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForReasoningError(
        new Error('network disconnected'),
        'reasoning_effort',
      ),
    ).toBe(false);
  });

  it('returns the expected fallback chains for reasoning capabilities', () => {
    const provider = new TestProvider();
    expect(provider.exposeReasoningFallbackChain('native-budget')).toEqual([
      'native-budget',
      'native-toggle',
      'none',
    ]);
    expect(provider.exposeReasoningFallbackChain('native-effort')).toEqual([
      'native-effort',
      'none',
    ]);
  });

  it('normalizes boolean reasoning flags into full requests', () => {
    const provider = new TestProvider();
    expect(provider.exposeNormalizeReasoning(true)).toMatchObject({
      enabled: true,
      mode: 'auto',
      depth: 'medium',
    });
    expect(provider.exposeNormalizeReasoning(false)).toMatchObject({
      enabled: false,
      mode: 'off',
    });
  });

  it('reads contextWindow from the active model descriptor when present', () => {
    const provider = new TestProvider();
    expect(provider.getEffectiveContextWindow()).toBe(200_000);
    expect(provider.getEffectiveContextWindow('default-model')).toBe(200_000);
    expect(provider.getEffectiveContextWindow('small-window-model')).toBe(50_000);
    expect(provider.getEffectiveContextWindow('plain-model')).toBe(200_000);
    expect(provider.getEffectiveContextWindow('unknown-model')).toBe(200_000);
  });

  it('reads maxOutputTokens from the active model descriptor when present', () => {
    const provider = new TestProvider();
    expect(provider.getEffectiveMaxOutputTokens()).toBe(32_000);
    expect(provider.getEffectiveMaxOutputTokens('default-model')).toBe(32_000);
    expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(8_000);
    expect(provider.getEffectiveMaxOutputTokens('plain-model')).toBe(32_000);
  });

  it('keeps one-shot maxOutputTokens override above descriptor data', () => {
    const provider = new TestProvider();
    provider.setMaxOutputTokensOverride(64_000);
    try {
      expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(64_000);
    } finally {
      provider.setMaxOutputTokensOverride(undefined);
    }
  });

  it('keeps env KODAX_MAX_OUTPUT_TOKENS above descriptor data', () => {
    const provider = new TestProvider();
    vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', '12345');
    try {
      expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(12_345);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps backwards-compatible getContextWindow() reading the default model', () => {
    const provider = new TestProvider();
    // Existing call sites still use the no-arg overload — must continue
    // resolving to the provider-level (or default-model) value.
    expect(provider.getContextWindow()).toBe(200_000);
  });

  it('FEATURE_130: fires structured onRetryAfter with parsed source and provider name', async () => {
    const provider = new TestProvider();
    const onRetryAfter = vi.fn();
    // Throw an error that carries a Retry-After header; subsequent attempt succeeds.
    const error = Object.assign(new Error('429 rate limit hit'), {
      headers: { 'retry-after': '7' },
    });
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, undefined, onRetryAfter),
      ).resolves.toBe('ok');
      expect(onRetryAfter).toHaveBeenCalledTimes(1);
      const event = onRetryAfter.mock.calls[0]![0];
      expect(event.provider).toBe('test-provider');
      expect(event.waitMs).toBe(7_000);
      expect(event.reason).toBe('rate-limit');
      expect(event.source).toBe('retry-after-seconds');
      expect(event.attempt).toBe(1);
      expect(event.maxAttempts).toBe(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('FEATURE_130: classifies overloaded errors with reason="overloaded"', async () => {
    const provider = new TestProvider();
    const onRetryAfter = vi.fn();
    const error = new Error('Server overloaded — please retry');
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      // The classifier matches "overload" via isRateLimitError keywords —
      // confirm overloaded errors go through the same retry path.
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, undefined, onRetryAfter),
      ).resolves.toBe('ok');
      expect(onRetryAfter).toHaveBeenCalledTimes(1);
      const event = onRetryAfter.mock.calls[0]![0];
      expect(event.reason).toBe('overloaded');
      expect(event.source).toBe('exponential-backoff');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('surfaces rate-limit retry callbacks with the computed delay', async () => {
    const provider = new TestProvider();
    const onRateLimit = vi.fn();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    // Stub jitter to a deterministic 0 so we can assert an exact delay
    // (the production formula adds Math.random() * 0.25 * baseDelay).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, onRateLimit),
      ).resolves.toBe('ok');
      // First retry (i=0): baseDelay = min(500 * 2^0, 32_000) = 500ms,
      // jitter = 0 (mocked) → total 500ms.
      expect(onRateLimit).toHaveBeenCalledWith(1, 2, 500);
    } finally {
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});
