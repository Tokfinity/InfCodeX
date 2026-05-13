/**
 * FEATURE_116 Sub-task D — DeepSeek private cache field adapter (v0.7.37).
 *
 * `normalizeOpenAIUsage` is shared by all 5 OpenAI-compat providers
 * (OpenAI, DeepSeek, Kimi, Qwen, Zhipu). Real OpenAI uses the standard
 * `prompt_tokens_details.cached_tokens` field; DeepSeek diverges and
 * returns `prompt_cache_hit_tokens` at the TOP level of `usage` instead.
 * This file pins both code paths so the parser handles both shapes
 * without silently dropping cache hit counts (which would lead to
 * ~4x over-reported costs for cached DeepSeek requests, since the
 * cache rate is ~8% of the input rate on V4 Pro).
 *
 * Verified field shapes against:
 *   - OpenAI: https://platform.openai.com/docs/api-reference/chat/object#chat/object-usage
 *   - DeepSeek: https://api-docs.deepseek.com/zh-cn/api/create-chat-completion (2026-05-08)
 */
import { describe, expect, it } from 'vitest';

import { normalizeOpenAIUsage, type OpenAIUsageLike } from './openai.js';

describe('FEATURE_116-D — normalizeOpenAIUsage cache field handling', () => {
  it('reads OpenAI-standard prompt_tokens_details.cached_tokens', () => {
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 800 },
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      cachedReadTokens: 800,
    });
  });

  it('reads DeepSeek-private prompt_cache_hit_tokens (top-level under usage)', () => {
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      cachedReadTokens: 600,
    });
  });

  it('OpenAI-standard wins over DeepSeek-private when both are present (forward compat)', () => {
    // Synthetic case: if DeepSeek ever adds the OpenAI-standard field
    // alongside their own, prefer the standard one. Hypothetical today
    // but pinned so the priority order is deterministic.
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 500 },
      prompt_cache_hit_tokens: 300,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result?.cachedReadTokens).toBe(500);
  });

  it('returns no cachedReadTokens when neither field is present', () => {
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
    });
    expect(result).not.toHaveProperty('cachedReadTokens');
  });

  it('treats null prompt_cache_hit_tokens as absent (defensive)', () => {
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: null,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result).not.toHaveProperty('cachedReadTokens');
  });

  it('rejects negative prompt_cache_hit_tokens (defensive against malformed responses)', () => {
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: -1,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result).not.toHaveProperty('cachedReadTokens');
  });

  it('exact DeepSeek response shape from api-docs.deepseek.com (2026-05-08)', () => {
    // Reproduces the exact JSON structure documented in DeepSeek API docs:
    //   usage = { prompt_tokens, completion_tokens, total_tokens,
    //             prompt_cache_hit_tokens, prompt_cache_miss_tokens,
    //             completion_tokens_details: { reasoning_tokens } }
    // Invariant: prompt_tokens === prompt_cache_hit_tokens + prompt_cache_miss_tokens
    const usage: OpenAIUsageLike = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    };
    const result = normalizeOpenAIUsage(usage);
    expect(result?.cachedReadTokens).toBe(800);
    // The invariant is the user's contract with DeepSeek server, not
    // ours to enforce — but if it's violated, our parser still picks
    // up the documented field and lets cost-tracker do the right thing.
  });
});
