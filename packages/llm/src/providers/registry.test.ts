import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KODAX_DEFAULT_PROVIDER,
  getModelCapabilities,
  getProvider,
  getProviderConfiguredReasoningCapability,
  getProviderList,
  isProviderConfigured,
} from './registry.js';
import { KodaXProviderError } from '../errors.js';
import { getCodexCliDefaultModel, getGeminiCliDefaultModel } from './cli-bridge-models.js';

describe('provider registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectReasoningPreset(
    provider: string,
    model: string,
    preset: string,
  ): void {
    expect(getModelCapabilities(provider, model)?.reasoningCapabilityV2?.reasoningPreset).toBe(preset);
  }

  it('includes CLI bridge providers in the built-in registry snapshot', () => {
    const gemini = getProviderList().find((provider) => provider.name === 'gemini-cli');
    const codex = getProviderList().find((provider) => provider.name === 'codex-cli');

    expect(gemini?.model).toBe(getGeminiCliDefaultModel());
    expect(codex?.model).toBe(getCodexCliDefaultModel());
  });

  it('tracks API-key backed providers through environment configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(isProviderConfigured('openai')).toBe(true);
    expect(isProviderConfigured('unknown-provider')).toBe(false);
  });

  it('returns model-specific reasoning capabilities from snapshots', () => {
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-v4-pro')).toBe('native-effort');
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-v4-flash')).toBe('native-effort');
    expect(getProviderConfiguredReasoningCapability('unknown-provider')).toBe('unknown');
  });

  it('throws a provider error for unknown providers', () => {
    expect(() => getProvider('missing-provider')).toThrowError(KodaXProviderError);
  });

  it('registers MiniMax Coding Plan as minimax-coding (Anthropic-compat, MINIMAX_CODING_API_KEY)', () => {
    // Pin the load-bearing pieces of the multi-model gateway: the provider
    // default (M2.7 at the 204K provider window) and the M3 per-model
    // override (1M frontier context). M3 carries an explicit override
    // because it diverges from the provider default — guard the value so
    // future edits to the JSON catalog have to update this assertion.
    vi.stubEnv('MINIMAX_CODING_API_KEY', 'mm-test-key');
    const minimax = getProvider('minimax-coding');
    expect(minimax.name).toBe('minimax-coding');
    expect(minimax.getEffectiveContextWindow('MiniMax-M2.7')).toBe(204_800);
    expect(minimax.getEffectiveContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('minimax-coding', 'MiniMax-M3')).toBe('native-adaptive');
    expectReasoningPreset('minimax-coding', 'MiniMax-M3', 'minimax-m3');
    expectReasoningPreset('minimax-coding', 'MiniMax-M2.7', 'minimax-m2-always');
  });

  it('registers Xiaomi MiMo Token Plan as mimo-coding (Anthropic-compat, MIMO_CODING_API_KEY)', () => {
    vi.stubEnv('MIMO_CODING_API_KEY', 'tp-test-key');
    const mimo = getProvider('mimo-coding');
    expect(mimo.name).toBe('mimo-coding');
    expect(mimo.getEffectiveContextWindow('mimo-v2.5-pro')).toBe(1_000_000);
    expect(mimo.getEffectiveContextWindow('mimo-v2.5')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('mimo-coding', 'mimo-v2.5-pro')).toBe('native-toggle');
    expectReasoningPreset('mimo-coding', 'mimo-v2.5-pro', 'mimo-v2.5-toggle');
  });

  it('registers Xiaomi MiMo pay-per-token as mimo (Anthropic-compat, MIMO_API_KEY)', () => {
    // Same upstream model family and capability shape as mimo-coding —
    // only the baseUrl and the API key env differ. Mirroring the
    // mimo-coding assertions guards against JSON ↔ class drift after
    // the two-provider split.
    vi.stubEnv('MIMO_API_KEY', 'sk-test-key');
    const mimo = getProvider('mimo');
    expect(mimo.name).toBe('mimo');
    expect(mimo.getEffectiveContextWindow('mimo-v2.5-pro')).toBe(1_000_000);
    expect(mimo.getEffectiveContextWindow('mimo-v2.5')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('mimo', 'mimo-v2.5-pro')).toBe('native-toggle');
    expectReasoningPreset('mimo', 'mimo-v2.5-pro', 'mimo-v2.5-toggle');
  });

  it('registers Volcengine Ark Coding Plan as ark-coding (Anthropic-compat, ARK_CODING_API_KEY)', () => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const ark = getProvider('ark-coding');
    expect(ark.name).toBe('ark-coding');

    // Default + alts together must cover all 13 models the gateway routes
    // to (V4 Pro / V4 Flash added 2026-05; kimi-k2.5 + minimax-latest
    // retired and MiniMax-M3 + MiniMax-M2.7 added 2026-06; GLM-5.2 +
    // Kimi K2.7 Code added late-2026-06 per user confirmation against
    // the Ark console).
    const models = ark.getAvailableModels();
    expect(models).toEqual([
      'glm-5.1',
      'glm-5.2',
      'glm-4.7',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'MiniMax-M3',
      'MiniMax-M2.7',
      'deepseek-v3.2',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
    ]);

    // Per-model context window pins (user-confirmed against Volcengine
    // console catalog). Default GLM family at 200K, GLM-5.2 at 1M
    // (matches zhipu-coding/glm-5.2), Kimi at 256K, MiniMax-M2.7 at
    // 204_800, MiniMax-M3 at 1M (Frontier Coding), DeepSeek V3.2 at
    // 128K, DeepSeek V4 at 1M.
    expect(ark.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
    expect(ark.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('glm-4.7')).toBe(200_000);
    expect(ark.getEffectiveContextWindow('kimi-k2.7-code')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('kimi-k2.6')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('MiniMax-M2.7')).toBe(204_800);
    expect(ark.getEffectiveContextWindow('deepseek-v3.2')).toBe(128_000);
    expect(ark.getEffectiveContextWindow('deepseek-v4-pro')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('deepseek-v4-flash')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-code')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-pro')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-lite')).toBe(256_000);

    // GLM-5.2 carries an explicit maxOutputTokens override (131_072,
    // matches zhipu-coding/glm-5.2) — pin it so future JSON edits
    // can't silently regress to the provider-level 32_000 default.
    expect(ark.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);

    expect(getProviderConfiguredReasoningCapability('ark-coding', 'glm-5.1')).toBe('native-toggle');
    expectReasoningPreset('ark-coding', 'glm-5.1', 'zai-glm-toggle');
    expectReasoningPreset('ark-coding', 'glm-5.2', 'zai-glm-5.2');
    expectReasoningPreset('ark-coding', 'kimi-k2.7-code', 'kimi-k2.7-code');
    expectReasoningPreset('ark-coding', 'MiniMax-M3', 'minimax-m3');
    expectReasoningPreset('ark-coding', 'deepseek-v4-pro', 'deepseek-v4-anthropic');
    expectReasoningPreset('ark-coding', 'doubao-seed-2.0-code', 'none');
  });

  it('exposes a stable default provider snapshot', () => {
    // Default provider (zhipu-coding) needs its key to instantiate.
    vi.stubEnv('ZHIPU_CODING_API_KEY', 'test-key');
    expect(typeof KODAX_DEFAULT_PROVIDER).toBe('string');
    expect(getProvider()).toBeDefined();
  });

  // OpenAI-compat thinking-mode providers that share the deepseek
  // reasoning_content convention all opt into the replayReasoningContent
  // flag for max fault-tolerance (deepseek empirically verified;
  // kimi/qwen/zhipu unverified but identical failure-mode shape).
  // OpenAI proper stays off — different protocol, would 400 on unknown
  // field.
  it('opts kimi/qwen/zhipu/deepseek into replayReasoningContent (and excludes openai)', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('QWEN_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');

    type ConfigCarrier = { config: { replayReasoningContent?: boolean } };
    const flagOf = (name: string): boolean | undefined =>
      (getProvider(name) as unknown as ConfigCarrier).config.replayReasoningContent;

    expect(flagOf('deepseek')).toBe(true);
    expect(flagOf('kimi')).toBe(true);
    expect(flagOf('qwen')).toBe(true);
    expect(flagOf('zhipu')).toBe(true);
    expect(flagOf('openai')).toBeUndefined();
  });

  // FEATURE_098: per-model context window override where the model
  // really diverges from the provider default. Tests guard the data,
  // not the lookup mechanism (already covered in base.test.ts).
  it('pins true context windows for models that diverge from provider defaults', () => {
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_CODING_API_KEY', 'test-key');

    const kimi = getProvider('kimi');
    expect(kimi.getEffectiveContextWindow('kimi-k2.6')).toBe(256_000);
    // User-confirmed (2026-04): K2.5 also ships a 256K context window;
    // the historical 128K pin from FEATURE_098 was either outdated or
    // sourced incorrectly. Both Kimi models now inherit the 256K
    // provider-level window without per-model overrides.
    expect(kimi.getEffectiveContextWindow('k2.5')).toBe(256_000);
    expect(kimi.getAvailableModels()).toContain('kimi-k2.7-code');
    expect(kimi.getEffectiveContextWindow('kimi-k2.7-code')).toBe(256_000);
    expect(kimi.getEffectiveMaxOutputTokens('kimi-k2.7-code')).toBe(32_768);

    const zhipu = getProvider('zhipu');
    expect(zhipu.getEffectiveContextWindow('glm-5')).toBe(200_000);
    expect(zhipu.getAvailableModels()).toContain('glm-5.2');
    expect(zhipu.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(zhipu.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(zhipu.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
    // User-confirmed (2026-05): GLM-5 Turbo is also 200K, not 128K. The
    // historical FEATURE_098 128K pin mirrored docs that were outdated
    // or wrong — same correction pattern as kimi/k2.5 above. Both
    // endpoints (public + coding) now inherit the 200K provider default.
    expect(zhipu.getEffectiveContextWindow('glm-5-turbo')).toBe(200_000);

    const zhipuCoding = getProvider('zhipu-coding');
    expect(zhipuCoding.getAvailableModels()).toContain('glm-5.2');
    expect(zhipuCoding.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(zhipuCoding.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(zhipuCoding.getEffectiveContextWindow('glm-5-turbo')).toBe(200_000);
    // 2026-06: Zhipu Coding Plan now serves GLM-5.2 / GLM-5 Turbo / GLM-4.7
    // on every tier; GLM-5 and GLM-5.1 are retired and auto-routed to
    // GLM-5.2 server-side. GLM-4.7 inherits the 200K provider default.
    expect(zhipuCoding.getAvailableModels()).toContain('glm-4.7');
    expect(zhipuCoding.getEffectiveContextWindow('glm-4.7')).toBe(200_000);
  });
});
