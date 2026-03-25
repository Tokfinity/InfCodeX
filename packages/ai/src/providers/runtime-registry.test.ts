import { afterEach, describe, expect, it } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '../types.js';
import { KodaXBaseProvider } from './base.js';
import {
  clearRuntimeModelProviders,
  registerModelProvider,
} from './runtime-registry.js';
import {
  getAvailableProviderNames,
  isKnownProvider,
  resolveProvider,
} from './resolver.js';

class TestRuntimeProvider extends KodaXBaseProvider {
  readonly name = 'runtime-test-provider';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'RUNTIME_TEST_PROVIDER_API_KEY',
    model: 'runtime-model',
    supportsThinking: false,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    return {
      textBlocks: [],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };
  }
}

describe('runtime model provider registry', () => {
  afterEach(() => {
    clearRuntimeModelProviders();
  });

  it('registers runtime model providers for resolver lookups', () => {
    const dispose = registerModelProvider(
      'runtime-test-provider',
      () => new TestRuntimeProvider(),
    );

    const provider = resolveProvider('runtime-test-provider');

    expect(provider).toBeInstanceOf(TestRuntimeProvider);
    expect(isKnownProvider('runtime-test-provider')).toBe(true);
    expect(getAvailableProviderNames()).toContain('runtime-test-provider');

    dispose();

    expect(isKnownProvider('runtime-test-provider')).toBe(false);
  });
});
