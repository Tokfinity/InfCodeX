import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent } from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import type { KodaXOptions } from '../../../types.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

const PROVIDER_NAME = 'managed-cache-affinity';
const PROVIDER_KEY_ENV = 'MANAGED_CACHE_AFFINITY_KEY';
const LOGICAL_SESSION_ID = 'stable-logical-session';

class ManagedCacheAffinityProvider extends KodaXBaseProvider {
  static promptCacheKeys: Array<string | undefined> = [];
  static transportSessionIds: Array<string | undefined> = [];

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: PROVIDER_KEY_ENV,
    model: 'cache-affinity-model',
    supportsThinking: false,
    contextWindow: 64_000,
    maxOutputTokens: 2_048,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    ManagedCacheAffinityProvider.promptCacheKeys.push(streamOptions?.promptCacheKey);
    ManagedCacheAffinityProvider.transportSessionIds.push(streamOptions?.sessionId);
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      stopReason: 'end_turn',
    };
  }
}

const agent: Agent = {
  name: 'worker',
  instructions: 'work',
  tools: [],
  reasoning: { default: 'none', max: 'none' },
};

function options(
  physicalSessionId: string,
  currentAgentId?: string,
  disablePromptCache?: boolean,
): KodaXOptions {
  return {
    provider: PROVIDER_NAME,
    model: 'cache-affinity-model',
    effort: 'none',
    session: { id: physicalSessionId },
    context: {
      contextIdentitySessionId: LOGICAL_SESSION_ID,
      ...(currentAgentId !== undefined ? { currentAgentId } : {}),
    },
    ...(disablePromptCache !== undefined ? { disablePromptCache } : {}),
  };
}

async function callAdapter(input: KodaXOptions): Promise<void> {
  const adapter = buildRunnerLlmAdapter(input);
  await adapter([
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'task' },
  ], agent);
}

describe('managed-task provider prompt-cache affinity', () => {
  beforeEach(() => {
    process.env[PROVIDER_KEY_ENV] = 'test-key';
    ManagedCacheAffinityProvider.promptCacheKeys = [];
    ManagedCacheAffinityProvider.transportSessionIds = [];
    registerModelProvider(PROVIDER_NAME, () => new ManagedCacheAffinityProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[PROVIDER_KEY_ENV];
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
  });

  it('keeps the same root affinity key across runs and restored physical Sessions', async () => {
    await callAdapter(options('physical-session-a'));
    await callAdapter(options('physical-session-b'));

    expect(ManagedCacheAffinityProvider.promptCacheKeys).toHaveLength(2);
    expect(ManagedCacheAffinityProvider.promptCacheKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(ManagedCacheAffinityProvider.promptCacheKeys[1])
      .toBe(ManagedCacheAffinityProvider.promptCacheKeys[0]);
    expect(ManagedCacheAffinityProvider.transportSessionIds).toEqual([undefined, undefined]);
  });

  it('keeps a child stable across physical worker Sessions while isolating it from root', async () => {
    await callAdapter(options('physical-root'));
    await callAdapter(options('worker-random-a', '/root/reviewer'));
    await callAdapter(options('worker-random-b', '/root/reviewer'));

    const [rootKey, firstChildKey, resumedChildKey] =
      ManagedCacheAffinityProvider.promptCacheKeys;
    expect(rootKey).toMatch(/^[a-f0-9]{64}$/);
    expect(firstChildKey).toMatch(/^[a-f0-9]{64}$/);
    expect(resumedChildKey).toBe(firstChildKey);
    expect(firstChildKey).not.toBe(rootKey);
    expect(ManagedCacheAffinityProvider.transportSessionIds)
      .toEqual([undefined, undefined, undefined]);
  });

  it('omits affinity when prompt caching is explicitly disabled', async () => {
    await callAdapter(options('physical-session', undefined, true));

    expect(ManagedCacheAffinityProvider.promptCacheKeys).toEqual([undefined]);
    expect(ManagedCacheAffinityProvider.transportSessionIds).toEqual([undefined]);
  });

  it('honors the env bridge while allowing an explicit SDK false to re-enable affinity', async () => {
    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    await callAdapter(options('env-disabled'));
    await callAdapter(options('sdk-re-enabled', undefined, false));

    expect(ManagedCacheAffinityProvider.promptCacheKeys[0]).toBeUndefined();
    expect(ManagedCacheAffinityProvider.promptCacheKeys[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(ManagedCacheAffinityProvider.transportSessionIds).toEqual([undefined, undefined]);
  });
});
