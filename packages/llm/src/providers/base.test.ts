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

  exposeShouldFallbackForForcedToolChoiceError(error: unknown): boolean {
    return this.shouldFallbackForForcedToolChoiceError(error);
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

  it('treats generic upstream 5xx as forced tool_choice fallback candidates', () => {
    const provider = new TestProvider();
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        Object.assign(new Error('Internal Server Error'), { status: 500 }),
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('unsupported parameter: tool_choice'),
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('network disconnected'),
      ),
    ).toBe(false);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('requested 550 tokens, reduce max output'),
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

  it('reads default-model contextWindow from models[] when declared there', () => {
    // Regression: a custom provider whose DEFAULT model also appears in
    // models[] with a per-model contextWindow must resolve to that window,
    // not the provider-level fallback. Previously getModelDescriptor
    // short-circuited the default model to a bare { id }, dropping the
    // declared contextWindow and silently using the provider default.
    class DefaultInListProvider extends KodaXBaseProvider {
      readonly name = 'default-in-list';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'DEFAULT_IN_LIST_KEY',
        model: 'glm-5.2',
        models: [
          { id: 'glm-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
          { id: 'glm-5.1' },
        ],
        supportsThinking: false,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      };
      async stream(): Promise<KodaXStreamResult> {
        throw new Error('not implemented in unit test');
      }
    }
    const provider = new DefaultInListProvider();
    // Default model resolved both explicitly and via the no-arg overload.
    expect(provider.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(provider.getEffectiveContextWindow()).toBe(1_000_000);
    expect(provider.getContextWindow()).toBe(1_000_000);
    expect(provider.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    // A models[] entry without contextWindow still falls back to provider level.
    expect(provider.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
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

  it('cascades streamMaxDurationMs from per-model descriptor → provider → undefined', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'override-model', streamMaxDurationMs: 123_456 },
          { id: 'inherit-model' },
        ],
        supportsThinking: false,
        streamMaxDurationMs: 300_000,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getStreamMaxDurationMs('override-model')).toBe(123_456);
    expect(provider.getStreamMaxDurationMs('inherit-model')).toBe(300_000);
    expect(provider.getStreamMaxDurationMs('default-model')).toBe(300_000);
    expect(provider.getStreamMaxDurationMs()).toBe(300_000);

    class NoProviderCap extends KodaXBaseProvider {
      readonly name = 'nocap';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NOCAP_KEY',
        model: 'default-model',
        models: [{ id: 'specific', streamMaxDurationMs: 200_000 }],
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const nocap = new NoProviderCap();
    expect(nocap.getStreamMaxDurationMs('specific')).toBe(200_000);
    expect(nocap.getStreamMaxDurationMs('default-model')).toBeUndefined();
    expect(nocap.getStreamMaxDurationMs()).toBeUndefined();
  });

  it('cascades replayReasoningContent from per-model → provider → false', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = true;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'force-off', replayReasoningContent: false },
          { id: 'force-on', replayReasoningContent: true },
          { id: 'inherit' },
        ],
        supportsThinking: true,
        replayReasoningContent: true,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getEffectiveReplayReasoningContent('force-on')).toBe(true);
    // Per-model false MUST win even though provider says true (the real-world
    // case: a gateway routing both DeepSeek V4 and OpenAI proper).
    expect(provider.getEffectiveReplayReasoningContent('force-off')).toBe(false);
    expect(provider.getEffectiveReplayReasoningContent('inherit')).toBe(true);
    expect(provider.getEffectiveReplayReasoningContent('default-model')).toBe(true);
    expect(provider.getEffectiveReplayReasoningContent()).toBe(true);

    class NoProviderDefault extends KodaXBaseProvider {
      readonly name = 'no-default';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NO_DEFAULT_KEY',
        model: 'default-model',
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    expect(new NoProviderDefault().getEffectiveReplayReasoningContent()).toBe(false);
  });

  it('cascades strictThinkingSignature from per-model → provider → false', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = true;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'force-lenient', strictThinkingSignature: false },
          { id: 'force-strict', strictThinkingSignature: true },
          { id: 'inherit' },
        ],
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getEffectiveStrictThinkingSignature('force-strict')).toBe(true);
    expect(provider.getEffectiveStrictThinkingSignature('force-lenient')).toBe(false);
    expect(provider.getEffectiveStrictThinkingSignature('inherit')).toBe(true);
    expect(provider.getEffectiveStrictThinkingSignature('default-model')).toBe(true);

    class NoProviderDefault extends KodaXBaseProvider {
      readonly name = 'no-default';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NO_DEFAULT_KEY',
        model: 'default-model',
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    expect(new NoProviderDefault().getEffectiveStrictThinkingSignature()).toBe(false);
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

  it('aborts rate-limit retry sleep when the signal aborts', async () => {
    vi.useFakeTimers();
    const provider = new TestProvider();
    const controller = new AbortController();
    const error = Object.assign(new Error('429 rate limit hit'), {
      headers: { 'retry-after': '60' },
    });
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    try {
      const promise = provider.exposeWithRateLimit(
        task,
        controller.signal,
        2,
        () => undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
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
