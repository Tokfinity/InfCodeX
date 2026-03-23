import { describe, expect, it, vi } from 'vitest';
import { KodaXBaseProvider } from './base.js';
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
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
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
  ): Promise<T> {
    return this.withRateLimit(fn, signal, retries, onRateLimit);
  }
}

describe('KodaXBaseProvider', () => {
  it('deduplicates the default model from getAvailableModels', () => {
    const provider = new TestProvider();
    expect(provider.getAvailableModels()).toEqual([
      'default-model',
      'native-toggle-model',
      'plain-model',
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
      return 0 as ReturnType<typeof setTimeout>;
    });

    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, onRateLimit),
      ).resolves.toBe('ok');
      expect(onRateLimit).toHaveBeenCalledWith(1, 2, 2000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
