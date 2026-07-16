/**
 * FEATURE_116 (v0.7.37) — cache_control helper tests.
 *
 * Locks the boundary insertion + lowering contract before any provider
 * base class wires it in. Two-phase test design:
 *   Phase 1.1 (this file): pure data-flow contract — no provider, no wire.
 *   Phase 1.2-1.3: Anthropic-compat / OpenAI-compat / ACP integration tests.
 */

import { describe, expect, it } from 'vitest';
import {
  insertCacheBoundary,
  isCacheBoundary,
  lowerCacheBoundaries,
  stripCacheBoundaries,
  type KodaXAnthropicCacheableBlock,
} from './cache-control.js';
import type { KodaXCacheBoundary, KodaXTextBlock } from './types.js';

const text = (s: string): KodaXTextBlock => ({ type: 'text', text: s });
const boundary = (hint?: KodaXCacheBoundary['hint']): KodaXCacheBoundary =>
  hint ? { type: 'cache-boundary', hint } : { type: 'cache-boundary' };

describe('isCacheBoundary', () => {
  it('returns true for boundary marker', () => {
    expect(isCacheBoundary(boundary())).toBe(true);
    expect(isCacheBoundary(boundary('system'))).toBe(true);
  });

  it('returns false for content blocks and primitives', () => {
    expect(isCacheBoundary(text('hi'))).toBe(false);
    expect(isCacheBoundary({ type: 'tool_use' })).toBe(false);
    expect(isCacheBoundary(null)).toBe(false);
    expect(isCacheBoundary(undefined)).toBe(false);
    expect(isCacheBoundary('string')).toBe(false);
    expect(isCacheBoundary(42)).toBe(false);
  });

  it('rejects objects that share the discriminant but carry extra fields', () => {
    // A wire payload coincidentally named cache-boundary but with extra
    // fields must NOT be stripped — it could be a legitimate provider
    // payload we have not yet modelled.
    expect(isCacheBoundary({ type: 'cache-boundary', text: 'hi' })).toBe(false);
    expect(isCacheBoundary({ type: 'cache-boundary', cache_id: 'abc' })).toBe(false);
  });
});

describe('insertCacheBoundary', () => {
  it('appends a boundary with hint to the end', () => {
    const blocks = [text('a'), text('b')];
    const result = insertCacheBoundary(blocks, 'system');
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ type: 'cache-boundary', hint: 'system' });
  });

  it('appends without hint when none provided', () => {
    const result = insertCacheBoundary([text('a')], undefined);
    expect(result[1]).toEqual({ type: 'cache-boundary' });
  });

  it('is idempotent: same hint at the tail does not double-mark', () => {
    const blocks = insertCacheBoundary([text('a')], 'system');
    const again = insertCacheBoundary(blocks, 'system');
    expect(again).toBe(blocks); // same reference, no append
    expect(again).toHaveLength(2);
  });

  it('appends a second marker when hint differs', () => {
    const blocks = insertCacheBoundary([text('a')], 'system');
    const next = insertCacheBoundary(blocks, 'tools');
    expect(next).toHaveLength(3);
    expect((next[2] as KodaXCacheBoundary).hint).toBe('tools');
  });

  it('does not mutate the input array', () => {
    const blocks = [text('a')];
    insertCacheBoundary(blocks, 'system');
    expect(blocks).toHaveLength(1);
  });

  it('handles empty input array', () => {
    const result = insertCacheBoundary([], 'system');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'cache-boundary', hint: 'system' });
  });
});

describe('lowerCacheBoundaries — attach mode', () => {
  it('attaches cache_control to the block before the boundary', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      boundary('system'),
      { type: 'text', text: 'c' },
    ];
    const result = lowerCacheBoundaries(blocks, 'attach');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', text: 'a' });
    expect(result[1]).toEqual({
      type: 'text',
      text: 'b',
      cache_control: { type: 'ephemeral' },
    });
    expect(result[2]).toEqual({ type: 'text', text: 'c' });
  });

  it('attaches to last block when boundary is trailing', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'a' },
      boundary('tools'),
    ];
    const result = lowerCacheBoundaries(blocks, 'attach');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'text',
      text: 'a',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('drops a leading boundary with no predecessor', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      boundary('system'),
      { type: 'text', text: 'a' },
    ];
    const result = lowerCacheBoundaries(blocks, 'attach');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'a' });
  });

  it('handles multiple boundaries marking distinct prefixes', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'sys' },
      boundary('system'),
      { type: 'text', text: 'tools' },
      boundary('tools'),
    ];
    const result = lowerCacheBoundaries(blocks, 'attach');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(result[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('collapses back-to-back boundaries onto the same predecessor', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'a' },
      boundary('system'),
      boundary('tools'),
      { type: 'text', text: 'b' },
    ];
    const result = lowerCacheBoundaries(blocks, 'attach');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'text',
      text: 'a',
      cache_control: { type: 'ephemeral' },
    });
    expect(result[1]).toEqual({ type: 'text', text: 'b' });
  });

  it('does not mutate the input array', () => {
    const original: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'a' },
      boundary('system'),
    ];
    lowerCacheBoundaries(original, 'attach');
    expect(original).toHaveLength(2);
    expect(original[0]).toEqual({ type: 'text', text: 'a' });
    expect((original[0] as KodaXAnthropicCacheableBlock).cache_control).toBeUndefined();
  });
});

describe('lowerCacheBoundaries — strip mode', () => {
  it('strips boundaries without attaching cache_control', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      { type: 'text', text: 'a' },
      boundary('system'),
      { type: 'text', text: 'b' },
    ];
    const result = lowerCacheBoundaries(blocks, 'strip');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'a' });
    expect(result[1]).toEqual({ type: 'text', text: 'b' });
    expect((result[0] as KodaXAnthropicCacheableBlock).cache_control).toBeUndefined();
    expect((result[1] as KodaXAnthropicCacheableBlock).cache_control).toBeUndefined();
  });

  it('strips multiple boundaries cleanly', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      boundary('system'),
      { type: 'text', text: 'a' },
      boundary('tools'),
      { type: 'text', text: 'b' },
      boundary('role-prompt'),
    ];
    const result = lowerCacheBoundaries(blocks, 'strip');
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.cache_control === undefined)).toBe(true);
  });

  it('leaves block array empty when only boundaries are present', () => {
    const blocks: (KodaXAnthropicCacheableBlock | KodaXCacheBoundary)[] = [
      boundary('system'),
      boundary('tools'),
    ];
    expect(lowerCacheBoundaries(blocks, 'strip')).toEqual([]);
  });
});

describe('stripCacheBoundaries', () => {
  it('removes every boundary preserving order', () => {
    const blocks = [
      text('a'),
      boundary('system'),
      text('b'),
      boundary('tools'),
      text('c'),
    ];
    const result = stripCacheBoundaries(blocks);
    expect(result).toEqual([text('a'), text('b'), text('c')]);
  });

  it('returns empty array when input is all boundaries', () => {
    expect(stripCacheBoundaries([boundary(), boundary('tools')])).toEqual([]);
  });

  it('returns input-equivalent array when no boundaries present', () => {
    const blocks = [text('a'), text('b')];
    expect(stripCacheBoundaries(blocks)).toEqual(blocks);
  });
});
