import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KodaXOpenAICompatProvider } from './openai.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '../types.js';
import { loadReasoningOverride } from '../reasoning-overrides.js';

const MESSAGES: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
const TOOLS: KodaXToolDefinition[] = [];
const TEST_CONFIG_FILE = path.join(
  os.tmpdir(),
  `kodax-openai-reasoning-${Date.now()}.json`,
);

function createCompletedOpenAIStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const chunks = [
        {
          choices: [
            {
              delta: { content: 'ok' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: 'stop',
            },
          ],
        },
      ];
      return {
        next: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(
    name: string,
    capability: KodaXReasoningCapability,
    client: unknown,
  ) {
    super();
    this.name = name;
    this.config = {
      apiKeyEnv: 'TEST_API_KEY',
      model: 'test-model',
      supportsThinking: capability !== 'none' && capability !== 'prompt-only',
      reasoningCapability: capability,
      maxOutputTokens: 32768,
    };
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('openai reasoning capability', () => {
  const reasoning: KodaXReasoningRequest = {
    enabled: true,
    mode: 'balanced',
    depth: 'medium',
    taskType: 'review',
    executionMode: 'pr-review',
  };

  beforeEach(() => {
    process.env.KODAX_CONFIG_FILE = TEST_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  afterEach(() => {
    delete process.env.KODAX_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  it('sends reasoning_effort for native-effort providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('medium');
  });

  it('sends budget controls for qwen-style providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('qwen', 'native-budget', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      extra_body: {
        enable_thinking: true,
        thinking_budget: 10000,
      },
    });
  });

  it('falls back from budget to toggle and persists the override', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unknown parameter: budget_tokens'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-budget', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 10000,
    });
    expect(create.mock.calls[1]?.[0].thinking).toMatchObject({
      type: 'enabled',
    });
    expect(create.mock.calls[1]?.[0].thinking).not.toHaveProperty('budget_tokens');
    expect(
      loadReasoningOverride('zhipu', {
        baseUrl: undefined,
        model: 'test-model',
      }),
    ).toBe('toggle');
  });
});
