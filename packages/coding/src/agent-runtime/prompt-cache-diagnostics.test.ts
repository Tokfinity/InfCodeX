import { describe, expect, it, vi } from 'vitest';
import type { KodaXBaseProvider, KodaXMessage } from '@kodax-ai/llm';
import { getProvider } from '@kodax-ai/llm';

import type { KodaXPromptCacheDiagnosticEvent } from '../types.js';
import {
  createCompactionPromptCacheObserver,
  emitPromptCacheDiagnosticRequest,
  emitPromptCacheDiagnosticResponse,
  hashProviderVisibleMessages,
  normalizeDiagnosticEnvelope,
} from './prompt-cache-diagnostics.js';

const provider = {
  getBaseUrl: () => 'https://example.test/v1/chat/completions',
  getWireModel: (model: string) => `wire:${model}`,
  getEffectiveMaxOutputTokens: () => 4096,
} as unknown as KodaXBaseProvider;

const messages: readonly KodaXMessage[] = [
  { role: 'user', content: 'prior turn', turnId: 'turn-1' },
  { role: 'assistant', content: 'prior answer', turnId: 'turn-1' },
  { role: 'user', content: 'current turn', turnId: 'turn-2' },
];

describe('prompt-cache diagnostics', () => {
  it('matches Anthropic-compatible inline System trimming without changing OpenAI-compatible whitespace', () => {
    const inlineSystem: readonly KodaXMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: '  RULE  ' },
          { type: 'text', text: '   ' },
        ],
      },
      { role: 'user', content: 'task' },
    ];

    expect(normalizeDiagnosticEnvelope(
      'base',
      inlineSystem,
      getProvider('zai-coding'),
    ).system).toBe('base\n\nRULE');
    expect(normalizeDiagnosticEnvelope('base', inlineSystem, provider).system)
      .toBe('base\n\n  RULE  \n   ');
  });

  it('hashes an ephemeral suffix separately without changing the reusable message prefix hash', () => {
    const emitted: KodaXPromptCacheDiagnosticEvent[] = [];
    const events = {
      onPromptCacheDiagnostics: (event: KodaXPromptCacheDiagnosticEvent) => emitted.push(event),
    };
    const base = {
      events,
      enabled: true,
      provider,
      providerName: 'test-provider',
      contextKind: 'child' as const,
      agentId: '/root/reviewer',
      model: 'test-model',
      reasoning: undefined,
      disablePromptCache: undefined,
      system: 'stable system',
      tools: [],
      messages,
      attempt: 1,
    };

    const first = emitPromptCacheDiagnosticRequest({
      ...base,
      ephemeralSuffix: { content: 'first reminder' },
    });
    const second = emitPromptCacheDiagnosticRequest({
      ...base,
      ephemeralSuffix: { content: 'second reminder' },
    });

    expect(first).toMatchObject({
      contextKind: 'child',
      agentId: '/root/reviewer',
      messagePrefixCount: 2,
    });
    expect(first?.messagePrefixHash).toBe(second?.messagePrefixHash);
    expect(first?.requestMessagesHash).toBe(second?.requestMessagesHash);
    expect(first?.ephemeralSuffixHash).not.toBe(second?.ephemeralSuffixHash);
    expect(first?.requestEnvelopeHash).not.toBe(second?.requestEnvelopeHash);
    expect(JSON.stringify(emitted)).not.toContain('first reminder');
    expect(JSON.stringify(emitted)).not.toContain('second reminder');
  });

  it('observes compaction provider calls including their ephemeral suffix and official usage', () => {
    const emitted: KodaXPromptCacheDiagnosticEvent[] = [];
    const observer = createCompactionPromptCacheObserver({
      events: { onPromptCacheDiagnostics: (event) => emitted.push(event) },
      enabled: true,
      provider,
      providerName: 'test-provider',
      model: 'test-model',
      disablePromptCache: false,
    });
    const request = {
      messages,
      tools: [],
      system: 'stable system',
      reasoning: false,
      ephemeralSuffix: { content: 'summarize this prefix' },
    } as const;

    observer?.onRequest?.(request);
    observer?.onResponse?.(request, {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedReadTokens: 80,
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      phase: 'request',
      ephemeralSuffixHash: expect.any(String),
    });
    expect(emitted[1]).toMatchObject({
      phase: 'response',
      cachedReadTokens: 80,
    });
    expect(JSON.stringify(emitted)).not.toContain('summarize this prefix');
  });

  it('omits hashes for empty ephemeral suffixes that providers do not send', () => {
    const event = emitPromptCacheDiagnosticRequest({
      events: { onPromptCacheDiagnostics: vi.fn() },
      enabled: true,
      provider,
      providerName: 'test-provider',
      model: 'test-model',
      reasoning: undefined,
      disablePromptCache: undefined,
      system: 'stable system',
      tools: [],
      messages,
      ephemeralSuffix: { content: '' },
      attempt: 1,
    });

    expect(event?.ephemeralSuffixHash).toBeUndefined();
  });

  it('does no hashing work when diagnostics are disabled', () => {
    const onPromptCacheDiagnostics = vi.fn();
    const event = emitPromptCacheDiagnosticRequest({
      events: { onPromptCacheDiagnostics },
      enabled: false,
      provider,
      providerName: 'test-provider',
      model: 'test-model',
      reasoning: undefined,
      disablePromptCache: undefined,
      system: 'secret system',
      tools: [],
      messages,
      attempt: 1,
    });

    expect(event).toBeUndefined();
    expect(onPromptCacheDiagnostics).not.toHaveBeenCalled();
  });

  it('ignores cache markers and local tool-call recovery flags that never reach provider wire', () => {
    const base: readonly KodaXMessage[] = [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call-1',
        name: 'read',
        input: { path: 'README.md' },
      }],
    }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'README contents',
      }],
    }];
    const withLocalOnlyFields: readonly KodaXMessage[] = [{
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'read',
          input: { path: 'README.md' },
          _salvaged: true,
          _truncated: true,
        },
        { type: 'cache-boundary', hint: 'role-prompt' },
      ],
    }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'README contents',
      }],
    }];

    expect(hashProviderVisibleMessages(withLocalOnlyFields, getProvider('deepseek')))
      .toBe(hashProviderVisibleMessages(base, getProvider('deepseek')));
    expect(hashProviderVisibleMessages(withLocalOnlyFields, getProvider('zai-coding')))
      .toBe(hashProviderVisibleMessages(base, getProvider('zai-coding')));
  });

  it('canonicalizes provider block order before hashing', () => {
    const toolUse: KodaXMessage = {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call-1',
        name: 'read',
        input: { path: 'README.md' },
      }],
    };
    const textThenToolResult: readonly KodaXMessage[] = [toolUse, {
      role: 'user',
      content: [
        { type: 'text', text: 'continue' },
        { type: 'tool_result', tool_use_id: 'call-1', content: 'result' },
      ],
    }];
    const toolResultThenText: readonly KodaXMessage[] = [toolUse, {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'result' },
        { type: 'text', text: 'continue' },
      ],
    }];

    expect(hashProviderVisibleMessages(textThenToolResult, getProvider('deepseek')))
      .toBe(hashProviderVisibleMessages(toolResultThenText, getProvider('deepseek')));
    expect(hashProviderVisibleMessages(textThenToolResult, getProvider('zai-coding')))
      .toBe(hashProviderVisibleMessages(toolResultThenText, getProvider('zai-coding')));
  });

  it('hashes only the final ACP prompt instead of ignored history', () => {
    const acp = getProvider('codex-cli');
    const first: readonly KodaXMessage[] = [
      { role: 'user', content: 'old-a' },
      { role: 'assistant', content: 'old-answer-a' },
      { role: 'user', content: 'current' },
    ];
    const second: readonly KodaXMessage[] = [
      { role: 'user', content: 'old-b' },
      { role: 'assistant', content: 'old-answer-b' },
      { role: 'user', content: 'current' },
    ];

    expect(hashProviderVisibleMessages(first, acp))
      .toBe(hashProviderVisibleMessages(second, acp));
  });

  it('matches OpenAI orphan-tool repair after empty tool calls become a placeholder', () => {
    const orphan: readonly KodaXMessage[] = [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'orphan',
        name: 'read',
        input: { path: 'missing' },
      }],
    }];
    const repaired: readonly KodaXMessage[] = [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '...' },
      ],
    }];

    expect(hashProviderVisibleMessages(orphan, getProvider('deepseek')))
      .toBe(hashProviderVisibleMessages(repaired, getProvider('deepseek')));
  });

  it('fails open when provider identity diagnostics throw', () => {
    const onPromptCacheDiagnostics = vi.fn();
    const throwingProvider = {
      getBaseUrl: () => {
        throw new Error('diagnostic getter failed');
      },
    } as unknown as KodaXBaseProvider;

    expect(() => emitPromptCacheDiagnosticRequest({
      events: { onPromptCacheDiagnostics },
      enabled: true,
      provider: throwingProvider,
      providerName: 'throwing-provider',
      model: 'test-model',
      reasoning: undefined,
      disablePromptCache: undefined,
      system: 'stable system',
      tools: [],
      messages,
      attempt: 1,
    })).not.toThrow();
    expect(onPromptCacheDiagnostics).not.toHaveBeenCalled();
  });

  it('fails open when response usage or callback getters throw', () => {
    const request = emitPromptCacheDiagnosticRequest({
      events: { onPromptCacheDiagnostics: vi.fn() },
      enabled: true,
      provider,
      providerName: 'test-provider',
      model: 'test-model',
      reasoning: undefined,
      disablePromptCache: undefined,
      system: 'stable system',
      tools: [],
      messages,
      attempt: 1,
    });
    const events = Object.defineProperty({}, 'onPromptCacheDiagnostics', {
      get: () => {
        throw new Error('callback getter failed');
      },
    });
    const usage = Object.defineProperty({}, 'inputTokens', {
      get: () => {
        throw new Error('usage getter failed');
      },
    });

    expect(() => emitPromptCacheDiagnosticResponse(
      events,
      request,
      usage,
    )).not.toThrow();
  });
});
