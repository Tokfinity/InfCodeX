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
  getProviderCredentialEnvironmentNames,
  isKnownProvider,
  resolveProvider,
} from './resolver.js';

class TestRuntimeProvider extends KodaXBaseProvider {
  readonly name = 'runtime-test-provider';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'RUNTIME_TEST_PROVIDER_AUTH',
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

class NamedCredentialRuntimeProvider extends TestRuntimeProvider {
  constructor(private readonly credentialEnvironmentName: string) {
    super();
  }

  override getApiKeyEnv(): string {
    return this.credentialEnvironmentName;
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
    expect(getProviderCredentialEnvironmentNames()).toContain(
      'RUNTIME_TEST_PROVIDER_AUTH',
    );

    dispose();

    expect(isKnownProvider('runtime-test-provider')).toBe(false);
  });

  it('reports credentials from every stacked runtime registration', () => {
    const disposeShadowed = registerModelProvider(
      'stacked-runtime-provider',
      () => new NamedCredentialRuntimeProvider('SHADOWED_PROVIDER_AUTH'),
    );
    const disposeActive = registerModelProvider(
      'stacked-runtime-provider',
      () => new NamedCredentialRuntimeProvider('ACTIVE_PROVIDER_AUTH'),
    );

    expect(getProviderCredentialEnvironmentNames()).toEqual(
      expect.arrayContaining([
        'SHADOWED_PROVIDER_AUTH',
        'ACTIVE_PROVIDER_AUTH',
      ]),
    );

    disposeActive();
    disposeShadowed();
  });
});
