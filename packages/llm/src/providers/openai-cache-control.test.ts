/**
 * FEATURE_116 (v0.7.37) Phase 1.3 — KodaXOpenAICompatProvider strip tests.
 *
 * Defensive contract: cache-boundary markers must not survive into the
 * OpenAI wire payload. v1 stripping is idempotent and identity-preserving
 * for messages with no boundaries.
 */

import { describe, expect, it } from 'vitest';
import { KodaXOpenAICompatProvider } from './openai.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
} from '../types.js';

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_KEY',
    model: 'test-model',
    reasoningCapability: 'native-effort',
    models: [{ id: 'test-model' }],
    contextWindow: 128_000,
    supportsThinking: true,
  };

  public exposedStripCacheBoundariesFromMessages(messages: KodaXMessage[]) {
    return this.stripCacheBoundariesFromMessages(messages);
  }
}

const makeProvider = () => {
  process.env.TEST_KEY = 'sk-test';
  return new TestOpenAIProvider();
};

describe('KodaXOpenAICompatProvider.stripCacheBoundariesFromMessages', () => {
  it('strips boundary markers from array-content messages', () => {
    const provider = makeProvider();
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'cache-boundary', hint: 'system' },
          { type: 'text', text: 'world' },
        ],
      },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('preserves identity (===) when no boundaries are present', () => {
    const provider = makeProvider();
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
  });

  it('passes through string-content messages unchanged', () => {
    const provider = makeProvider();
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result).toEqual(messages);
  });

  it('is idempotent', () => {
    const provider = makeProvider();
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'cache-boundary' },
        ],
      },
    ];
    const once = provider.exposedStripCacheBoundariesFromMessages(messages);
    const twice = provider.exposedStripCacheBoundariesFromMessages(once);
    expect(twice).toEqual(once);
  });

  it('handles mixed content arrays (text + tool_use + boundary)', () => {
    const provider = makeProvider();
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking…' },
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
          { type: 'cache-boundary', hint: 'tools' },
        ],
      },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result[0]!.content).toEqual([
      { type: 'text', text: 'thinking…' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
    ]);
  });

  it('does not mutate input', () => {
    const provider = makeProvider();
    const original: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'cache-boundary' },
        ],
      },
    ];
    provider.exposedStripCacheBoundariesFromMessages(original);
    expect(Array.isArray(original[0]!.content)).toBe(true);
    expect(original[0]!.content).toHaveLength(2);
  });
});
