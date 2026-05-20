import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import { estimateTokens, countTokens } from './tokenizer.js';

describe('estimateTokens — image block accounting', () => {
  it('counts a single image block at ~1500 tokens', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', path: '/tmp/screenshot.png', mediaType: 'image/png' },
        ],
      },
    ];
    // 4 (message overhead) + 1500 (image) = 1504
    expect(estimateTokens(messages)).toBeGreaterThanOrEqual(1500);
    expect(estimateTokens(messages)).toBeLessThan(1600);
  });

  it('counts image blocks additively across messages', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', path: '/tmp/a.png' },
          { type: 'image', path: '/tmp/b.png' },
        ],
      },
    ];
    // 4 + 1500 + 1500 = 3004
    expect(estimateTokens(messages)).toBeGreaterThanOrEqual(3000);
    expect(estimateTokens(messages)).toBeLessThan(3100);
  });

  it('counts image alongside text in same message', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', path: '/tmp/screenshot.png' },
        ],
      },
    ];
    const textOnly = estimateTokens([
      { role: 'user', content: [{ type: 'text', text: 'What is in this image?' }] },
    ]);
    expect(estimateTokens(messages)).toBeGreaterThanOrEqual(textOnly + 1500);
  });
});

describe('estimateTokens — baseline coverage', () => {
  it('counts plain string content', () => {
    expect(estimateTokens([{ role: 'user', content: 'hello world' }])).toBeGreaterThan(0);
  });

  it('counts tool_use name + JSON input', () => {
    const tokens = estimateTokens([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'read', input: { path: '/x/y.ts' } },
        ],
      },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tool_result content', () => {
    const tokens = estimateTokens([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file content here' },
        ],
      },
    ]);
    expect(tokens).toBeGreaterThan(4);
  });

  it('counts thinking block text', () => {
    const tokens = estimateTokens([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoning here', signature: 'sig' }],
      },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns positive count for non-empty text', () => {
    expect(countTokens('hello')).toBeGreaterThan(0);
  });
});
