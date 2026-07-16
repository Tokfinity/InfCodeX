/**
 * KodaX Cost Rates - Multi-Provider pricing table
 *
 * 成本费率表 - 所有 Provider 的计费标准
 * 支持 11 个内置 Provider 的成本追踪，用户可以覆盖默认费率
 */

export interface CostRate {
  readonly inputPer1M: number; // USD per 1M input tokens
  readonly outputPer1M: number; // USD per 1M output tokens
  /** @deprecated Use cacheReadPer1M/cacheWritePer1M when the provider prices them separately. */
  readonly cachePer1M?: number;
  readonly cacheReadPer1M?: number;
  readonly cacheWritePer1M?: number;
}

// Default rates for all built-in providers (approximate, user can override)
// Rates are from official pricing pages as of 2026-07
export const DEFAULT_COST_RATES: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
  anthropic: {
    'claude-opus-4-8': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    },
    'claude-opus-4-7': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    },
    'claude-opus-4-6': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    },
    'claude-sonnet-4-6': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachePer1M: 0.375,
      cacheReadPer1M: 0.375,
      cacheWritePer1M: 3.75,
    },
    'claude-haiku-4-5': {
      inputPer1M: 0.8,
      outputPer1M: 4.0,
      cachePer1M: 0.08,
      cacheReadPer1M: 0.08,
      cacheWritePer1M: 1.0,
    },
  },
  openai: {
    'gpt-5.4': { inputPer1M: 30.0, outputPer1M: 120.0 },
    'gpt-5.3-codex-spark': { inputPer1M: 10.0, outputPer1M: 40.0 },
  },
  deepseek: {
    // V4 series. DeepSeek publishes pricing in CNY/M tokens; values below are
    // converted at ¥1 ≈ $0.14 (official USD rates not yet posted as of 2026-04).
    // Update once api-docs.deepseek.com lists USD rates directly.
    //   v4-flash: ¥1 / ¥0.2 cached / ¥2 out
    //   v4-pro:   ¥12 / ¥1 cached / ¥24 out
    'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28, cachePer1M: 0.028 },
    'deepseek-v4-pro': { inputPer1M: 1.68, outputPer1M: 3.36, cachePer1M: 0.14 },
  },
  kimi: {
    // Official prices are published in CNY; converted at ¥1 ≈ $0.14,
    // matching the convention used for DeepSeek above. cachePer1M is
    // the automatic context-cache hit price.
    'kimi-k2.7-code': { inputPer1M: 0.91, outputPer1M: 3.78, cachePer1M: 0.182 },
    'kimi-k2.7-code-highspeed': { inputPer1M: 1.82, outputPer1M: 7.56, cachePer1M: 0.364 },
    'kimi-k2.6': { inputPer1M: 0.91, outputPer1M: 3.78, cachePer1M: 0.154 },
    'kimi-k2.5': { inputPer1M: 0.56, outputPer1M: 2.94, cachePer1M: 0.098 },
  },
  'kimi-code': {
    // Kimi-for-Coding is a subscription endpoint — the per-token rate
    // shown here is a nominal placeholder for cost-tracker accounting;
    // real-world cost is the flat membership fee plus request-quota.
    'kimi-for-coding': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'k3': { inputPer1M: 0.005, outputPer1M: 0.015 },
    // HighSpeed consumes roughly 3x the membership quota of Standard.
    'kimi-for-coding-highspeed': { inputPer1M: 0.015, outputPer1M: 0.045 },
  },
  qwen: {
    'qwen3.5-plus': { inputPer1M: 0.003, outputPer1M: 0.006 },
  },
  zhipu: {
    'glm-5': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5.1': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'zhipu-coding': {
    // 2026-06: GLM-5 / GLM-5.1 retired (auto-routed to GLM-5.2 upstream).
    // Coding Plan now serves GLM-5.2 / GLM-5 Turbo / GLM-4.7.
    'glm-5.2': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'glm-4.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'zai-coding': {
    // Zhipu Coding Plan overseas mirror (api.z.ai). Same model lineup
    // and per-token rates as zhipu-coding — both routes proxy to the
    // same upstream backend. Mirror keeps cost-tracker output
    // comparable when users split between the CN and overseas endpoint.
    'glm-5.2': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'glm-4.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'minimax-coding': {
    // 2026-06: official MiniMax Coding Plan endpoint retired the
    // M2.x family (M2.5 / M2.1 / M2 + their -highspeed variants).
    // Only M2.7 / M2.7-highspeed (legacy GA) and M3 (Frontier
    // Coding) remain on the gateway.
    'MiniMax-M3': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.7-highspeed': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'mimo-coding': {
    // MiMo Token Plan is a flat-rate subscription — per-token rates here are
    // a nominal placeholder for cost-tracker accounting; real-world cost is
    // the monthly fee plus request-quota.
    'mimo-v2.5-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  mimo: {
    // Xiaomi MiMo public pay-per-token Anthropic-compat endpoint
    // (https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api).
    // Same model family as mimo-coding but billed per token. Placeholders
    // mirror mimo-coding so cost-tracker output is non-zero until the
    // user supplies real CNY rates via `~/.kodax/config.json`.
    'mimo-v2.5-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'ark-coding': {
    // Volcengine Ark Coding Plan is a 5-hour sliding-window subscription —
    // per-token rates here are nominal placeholders for cost-tracker
    // accounting; real-world cost is the Lite/Pro membership fee plus
    // sliding-window quota. Listed at ~10% of the standard pay-per-token
    // Ark API rates per the Plan announcement.
    // 2026-07-03 catalog refresh: Ark retired glm-5.1 / glm-4.7 /
    // deepseek-v3.2 (wire returns UnsupportedModel 404). GLM-5.2
    // promoted to default (with wire alias glm-latest). Doubao Seed Code
    // (no "2.0" suffix) added as the next-gen coding variant on the
    // Doubao route (probe-max-tokens.mjs green).
    'glm-5.2': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.7-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.6': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'MiniMax-M3': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'MiniMax-M2.7': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4-flash': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-lite': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
  },
  // CLI bridge providers - no direct cost (user pays their own CLI usage)
  'gemini-cli': {},
  'codex-cli': {},
};

export function getCostRate(
  provider: string,
  model: string,
  userOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>,
): CostRate | undefined {
  // User overrides take priority
  const overrideRate = userOverrides?.[provider]?.[model];
  if (overrideRate) return overrideRate;
  return DEFAULT_COST_RATES[provider]?.[model];
}

export function calculateCost(
  rate: CostRate,
  totalInputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const uncachedInputTokens = Math.max(
    0,
    totalInputTokens - cacheReadTokens - cacheWriteTokens,
  );
  const cacheReadRate = rate.cacheReadPer1M ?? rate.cachePer1M ?? rate.inputPer1M;
  const cacheWriteRate = rate.cacheWritePer1M ?? rate.cachePer1M ?? rate.inputPer1M;
  const inputCost = (uncachedInputTokens / 1_000_000) * rate.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rate.outputPer1M;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * cacheReadRate;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * cacheWriteRate;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
