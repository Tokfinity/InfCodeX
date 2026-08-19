import { describe, expect, it, vi } from 'vitest';
import { APIUserAbortError as AnthropicAPIUserAbortError } from '@anthropic-ai/sdk';
import { KodaXBaseProvider } from './base.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '../types.js';

vi.mock('openai', () => {
  throw new Error('openai unavailable');
});

class TestProvider extends KodaXBaseProvider {
  readonly name = 'test-provider';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_PROVIDER_API_KEY',
    model: 'default-model',
    supportsThinking: true,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    throw new Error('not implemented in unit test');
  }

  exposeWithRateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withRateLimit(fn, signal);
  }
}

describe('provider SDK abort import isolation', () => {
  it('still normalizes an Anthropic abort when the OpenAI SDK fails to load', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new AnthropicAPIUserAbortError());
    controller.abort();

    await expect(
      provider.exposeWithRateLimit(task, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps an independent error on the provider path when the OpenAI SDK fails to load', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Request was aborted.'));
    controller.abort();

    await expect(
      provider.exposeWithRateLimit(task, controller.signal),
    ).rejects.toMatchObject({ name: 'KodaXProviderError' });
    expect(task).toHaveBeenCalledTimes(1);
  });
});
