import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  countTokens,
  estimateMultilingualTokens,
  estimateTokens,
  looksLikeDenseEncodedData,
} from './tokenizer.js';

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

  it('interpolates ASCII and BMP Chinese from UTF-8 bytes and UTF-16 units', () => {
    expect(estimateMultilingualTokens('a'.repeat(400))).toBe(100);
    expect(estimateMultilingualTokens('中'.repeat(100))).toBe(100);
    expect(estimateMultilingualTokens(`${'a'.repeat(200)}${'中'.repeat(100)}`)).toBe(150);
  });

  it.each([
    ['continuous ASCII', 'A'.repeat(512)],
    ['random Base64', Buffer.from(
      Array.from({ length: 512 }, (_, index) => (index * 73 + 41) % 256),
    ).toString('base64')],
    ['random Hex', Buffer.from(
      Array.from({ length: 256 }, (_, index) => (index * 47 + 19) % 256),
    ).toString('hex')],
    ['URL-safe base64', 'AbCdEf0123456789-_'.repeat(29)],
  ])('detects dense encoded data: %s', (_label, text) => {
    expect(looksLikeDenseEncodedData(text)).toBe(true);
    expect(countTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length * 0.75));
  });

  it.each([
    ['English', 'The quick brown fox jumps over the lazy dog. '.repeat(20)],
    ['Chinese', '这是一个用于验证多语言估算的句子。'.repeat(20)],
    ['JSON/code', JSON.stringify({ value: 'hello', enabled: true, count: 42 }).repeat(20)],
    ['Emoji', '🙂🚀👩‍💻'.repeat(50)],
    ['multiline', Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n')],
  ])('estimates bounded %s content without BPE tokenization', (_label, text) => {
    expect(countTokens(text)).toBeGreaterThan(0);
    expect(Number.isFinite(countTokens(text))).toBe(true);
  });

  it('handles the 174,763-byte reproduction without stalling the event loop', async () => {
    const text = 'A'.repeat(174_763);
    const startedAt = performance.now();
    const nextTimer = new Promise<number>((resolve) => {
      setTimeout(() => resolve(performance.now() - startedAt), 0);
    });
    const tokens = countTokens(text);

    expect(tokens).toBe(Math.ceil(text.length * 0.75));
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(await nextTimer).toBeLessThan(250);
  });
});
