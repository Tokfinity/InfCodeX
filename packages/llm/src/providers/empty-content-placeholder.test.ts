import { describe, expect, it } from 'vitest';

import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import type { KodaXMessage, KodaXProviderConfig } from '../types.js';

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic-empty-content';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    contextWindow: 200000,
  };
}

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai-empty-content';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    contextWindow: 200000,
  };
}

type AnthropicWireMessage = {
  readonly role: string;
  readonly content: unknown;
};

type OpenAIWireMessage = Record<string, unknown>;

type AnthropicConverter = {
  convertMessages(messages: KodaXMessage[], model?: string): Promise<AnthropicWireMessage[]>;
};

type OpenAIConverter = {
  convertMessages(messages: KodaXMessage[], model?: string): Promise<OpenAIWireMessage[]>;
};

const emptyToolResultMessages: KodaXMessage[] = [
  { role: 'user', content: 'run noop' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'noop', input: {} },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: '' },
    ],
  },
];

describe('provider empty-content placeholders', () => {
  it('preserves empty Anthropic tool_result content instead of rewriting it to "..."', async () => {
    const provider = new TestAnthropicProvider() as unknown as AnthropicConverter;
    const converted = await provider.convertMessages(emptyToolResultMessages);

    const toolResultTurn = converted[2];
    expect(toolResultTurn?.role).toBe('user');
    expect(Array.isArray(toolResultTurn?.content)).toBe(true);

    const content = toolResultTurn!.content as readonly Record<string, unknown>[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: '',
    });
  });

  it('preserves empty OpenAI tool message content instead of rewriting it to "..."', async () => {
    const provider = new TestOpenAIProvider() as unknown as OpenAIConverter;
    const converted = await provider.convertMessages(emptyToolResultMessages);

    const toolMessage = converted.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '',
    });
  });
});
