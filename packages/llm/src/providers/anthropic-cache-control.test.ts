/**
 * FEATURE_116 (v0.7.37) Phase 1.2 — KodaXAnthropicCompatProvider cache_control lowering tests.
 *
 * Verifies the protected `applyCacheControlToSystem` and
 * `applyCacheControlToTools` hooks emit Anthropic-wire shapes that
 * carry `cache_control: { type: 'ephemeral' }` markers in the right
 * places, and that `KODAX_DISABLE_PROMPT_CACHE=1` cleanly disables.
 *
 * No SDK is invoked — these tests exercise the request-construction
 * helpers directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import type { KodaXProviderConfig, KodaXToolDefinition } from '../types.js';

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_KEY',
    model: 'test-model',
    reasoningCapability: 'native-budget',
    models: [{ id: 'test-model' }],
    contextWindow: 200000,
    supportsThinking: true,
  };

  // Expose protected helpers for direct testing.
  public exposedApplyCacheControlToSystem(systemText: string) {
    return this.applyCacheControlToSystem(systemText);
  }
  public exposedApplyCacheControlToTools(tools: KodaXToolDefinition[]) {
    return this.applyCacheControlToTools(tools);
  }
  public exposedApplyCacheControlToMessages(messages: Anthropic.Messages.MessageParam[]) {
    return this.applyCacheControlToMessages(messages);
  }
}

const tool = (name: string, description = 'desc'): KodaXToolDefinition => ({
  name,
  description,
  input_schema: { type: 'object', properties: {} },
});

describe('KodaXAnthropicCompatProvider.applyCacheControlToSystem', () => {
  let provider: TestAnthropicProvider;

  beforeEach(() => {
    process.env.TEST_KEY = 'sk-test';
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
    provider = new TestAnthropicProvider();
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
  });

  it('wraps non-empty system text as a single cacheable text block', () => {
    const result = provider.exposedApplyCacheControlToSystem('You are a helpful assistant.');
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Anthropic.Messages.TextBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('returns empty string unchanged (no cache marker on empty prompt)', () => {
    expect(provider.exposedApplyCacheControlToSystem('')).toBe('');
    expect(provider.exposedApplyCacheControlToSystem('   \n  ')).toBe('   \n  ');
  });

  it('honours KODAX_DISABLE_PROMPT_CACHE=1 escape hatch', () => {
    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    const result = provider.exposedApplyCacheControlToSystem('You are a helpful assistant.');
    expect(typeof result).toBe('string');
    expect(result).toBe('You are a helpful assistant.');
  });

  it('does NOT leak cache-boundary marker into wire payload', () => {
    const result = provider.exposedApplyCacheControlToSystem('hello');
    if (typeof result === 'string') {
      throw new Error('expected blocks array');
    }
    for (const block of result) {
      expect((block as { type: unknown }).type).not.toBe('cache-boundary');
    }
  });
});

describe('KodaXAnthropicCompatProvider.applyCacheControlToTools', () => {
  let provider: TestAnthropicProvider;

  beforeEach(() => {
    process.env.TEST_KEY = 'sk-test';
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
    provider = new TestAnthropicProvider();
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
  });

  it('marks the last tool with cache_control, leaves earlier tools untouched', () => {
    const result = provider.exposedApplyCacheControlToTools([
      tool('read'),
      tool('write'),
      tool('edit'),
    ]);
    expect(result).toHaveLength(3);
    expect((result[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((result[1] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((result[2] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles single-tool array', () => {
    const result = provider.exposedApplyCacheControlToTools([tool('read')]);
    expect(result).toHaveLength(1);
    expect((result[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns empty array unchanged', () => {
    const empty: KodaXToolDefinition[] = [];
    expect(provider.exposedApplyCacheControlToTools(empty)).toEqual([]);
  });

  it('does NOT mutate input array', () => {
    const tools = [tool('read'), tool('write')];
    provider.exposedApplyCacheControlToTools(tools);
    expect((tools[1] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('honours KODAX_DISABLE_PROMPT_CACHE=1 escape hatch', () => {
    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    const result = provider.exposedApplyCacheControlToTools([tool('read'), tool('write')]);
    expect((result[1] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });
});

describe('KodaXAnthropicCompatProvider — boundary leak guard', () => {
  let provider: TestAnthropicProvider;

  beforeEach(() => {
    process.env.TEST_KEY = 'sk-test';
    provider = new TestAnthropicProvider();
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
  });

  it('serializeSystemMessageContent rejects cache-boundary in content array', () => {
    // Reach into the private method via bracket access — we are testing
    // the fail-loud guard, not normal usage.
    const serialize = (provider as unknown as {
      serializeSystemMessageContent: (
        content: string | Array<{ type: string; text?: string }>,
      ) => string;
    }).serializeSystemMessageContent.bind(provider);

    const blocksWithBoundary: Array<{ type: string; text?: string }> = [
      { type: 'text', text: 'a' },
      { type: 'cache-boundary' },
    ];
    expect(() => serialize(blocksWithBoundary)).toThrow(/cache-boundary marker reached/);
  });

  it('serializeSystemMessageContent passes through plain text content', () => {
    const serialize = (provider as unknown as {
      serializeSystemMessageContent: (
        content: string | Array<{ type: string; text?: string }>,
      ) => string;
    }).serializeSystemMessageContent.bind(provider);

    expect(serialize('hello')).toBe('hello');
    const textBlocks: Array<{ type: string; text?: string }> = [{ type: 'text', text: 'hi' }];
    expect(serialize(textBlocks)).toBe('hi');
  });
});

describe('KodaXAnthropicCompatProvider.applyCacheControlToMessages', () => {
  let provider: TestAnthropicProvider;

  beforeEach(() => {
    process.env.TEST_KEY = 'sk-test';
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
    provider = new TestAnthropicProvider();
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
  });

  const userMsg = (
    text: string,
    blocks?: Anthropic.Messages.ContentBlockParam[],
  ): Anthropic.Messages.MessageParam => ({
    role: 'user',
    content: blocks ?? [{ type: 'text', text }],
  });
  const asstMsg = (text: string): Anthropic.Messages.MessageParam => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const cc = (m: Anthropic.Messages.MessageParam): unknown => {
    const content = m.content;
    if (typeof content === 'string' || content.length === 0) return undefined;
    return (content[content.length - 1] as { cache_control?: unknown }).cache_control;
  };

  it('marks the last block of the second-to-last user turn', () => {
    const msgs = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2'), userMsg('u3')];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    // second-to-last user turn is index 2
    expect(cc(result[2]!)).toEqual({ type: 'ephemeral' });
    // last user turn (index 4) is left untouched
    expect(cc(result[4]!)).toBeUndefined();
  });

  it('marks only the LAST block when the user turn has multiple blocks', () => {
    const multi = userMsg('', [
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'text', text: 'follow-up' },
    ]);
    const msgs = [multi, asstMsg('a1'), userMsg('u2')];
    // second-to-last user turn here is `multi` (index 0)
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    const content = result[0]!.content as Anthropic.Messages.ContentBlockParam[];
    expect((content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((content[1] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns unchanged when fewer than 2 user turns', () => {
    const msgs = [userMsg('u1'), asstMsg('a1')];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    expect(cc(result[0]!)).toBeUndefined();
  });

  it('returns empty array unchanged', () => {
    expect(provider.exposedApplyCacheControlToMessages([])).toEqual([]);
  });

  it('returns unchanged when the target user turn content is a string', () => {
    const msgs: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'u1-string' },
      asstMsg('a1'),
      userMsg('u2'),
    ];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    expect(result[0]!.content).toBe('u1-string');
    expect(cc(result[2]!)).toBeUndefined();
  });

  it('returns unchanged when the target user turn content is an empty array', () => {
    const msgs: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: [] },
      asstMsg('a1'),
      userMsg('u2'),
    ];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    expect((result[0]!.content as unknown[]).length).toBe(0);
  });

  it('does not touch assistant turns', () => {
    const msgs = [userMsg('u1'), asstMsg('a1'), userMsg('u2')];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    // assistant at index 1 must stay clean
    const asst = result[1]!.content as Anthropic.Messages.ContentBlockParam[];
    expect((asst[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('honours KODAX_DISABLE_PROMPT_CACHE=1 escape hatch', () => {
    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    const msgs = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2'), userMsg('u3')];
    const result = provider.exposedApplyCacheControlToMessages(msgs);
    expect(cc(result[2]!)).toBeUndefined();
  });

  it('does not mutate the input array or its messages', () => {
    const msgs = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2'), userMsg('u3')];
    provider.exposedApplyCacheControlToMessages(msgs);
    expect(cc(msgs[2]!)).toBeUndefined();
  });
});
