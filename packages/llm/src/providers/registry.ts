/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */

import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import {
  KodaXModelDescriptor,
  KodaXProviderCapabilityProfile,
  KodaXProviderConfig,
  KodaXReasoningCapability,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import {
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
} from '../constants.js';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  cloneCapabilityProfile,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
  normalizeCapabilityProfile,
} from './capability-profile.js';
import {
  getCodexCliDefaultModel,
  getCodexCliKnownModels,
  getGeminiCliDefaultModel,
  getGeminiCliKnownModels,
} from './cli-bridge-models.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const GEMINI_CLI_DEFAULT_MODEL = getGeminiCliDefaultModel();
const GEMINI_CLI_MODELS = getGeminiCliKnownModels();
const CODEX_CLI_DEFAULT_MODEL = getCodexCliDefaultModel();
const CODEX_CLI_MODELS = getCodexCliKnownModels();

// ============== Provider 名称类型 ==============

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'kimi-code'
  | 'qwen'
  | 'zhipu'
  | 'zhipu-coding'
  | 'minimax-coding'
  | 'mimo-coding'
  | 'ark-coding'
  | 'gemini-cli'
  | 'codex-cli';

/**
 * Per-provider static metadata. v0.7.43 — promoted from a partial
 * descriptor (`models: string[]`) to the full capability surface so
 * SDK consumers can read context windows / max output tokens /
 * thinking-budget caps / per-model descriptors without instantiating
 * a Provider class (which previously required a valid API key just
 * to read static metadata — architectural mismatch).
 *
 * This map is now the single source of truth for capability data;
 * Provider classes derive their runtime `config` from it via
 * `buildProviderConfig`.
 */
type ProviderSnapshot = {
  model: string;
  /**
   * Alternative model descriptors beyond the default `model`. Carries
   * per-model capability overrides (`contextWindow` / `maxOutputTokens` /
   * `thinkingBudgetCap` / `reasoningCapability` / `replayReasoningContent` /
   * `strictThinkingSignature`). Provider-level defaults below fill any
   * gaps a descriptor leaves unset. The default model has no descriptor
   * entry — it inherits provider-level defaults directly.
   */
  models?: readonly KodaXModelDescriptor[];
  apiKeyEnv: string;
  reasoningCapability: KodaXReasoningCapability;
  modelReasoningCapabilities?: Partial<Record<string, KodaXReasoningCapability>>;
  capabilityProfile: KodaXProviderCapabilityProfile;
  /** Maximum input context window (tokens). Provider-level default. */
  contextWindow?: number;
  /** Per-turn output token cap KodaX requests. Provider-level default. */
  maxOutputTokens?: number;
  /** Upper bound on `thinking_budget` for native-budget reasoning providers. */
  thinkingBudgetCap?: number;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  supportsThinking?: boolean;
};

// Canonical source for provider identity (apiKeyEnv, default model,
// reasoning capability, capability profile). Per-class Provider configs
// derive the three overlapping fields via `buildProviderConfig` so the
// two structures cannot drift.
export const KODAX_PROVIDER_SNAPSHOTS: Record<ProviderName, ProviderSnapshot> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-4-6', displayName: 'Opus 4.6', thinkingBudgetCap: 28000 },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', thinkingBudgetCap: 10000 },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 200000,
    // Anthropic API: max_tokens = thinking + output combined budget.
    // With thinkingBudgetCap=28000, 32768 left only ~4768 for actual output.
    // 64000 ensures ~36000+ tokens for output even at maximum thinking.
    maxOutputTokens: 64000,
    thinkingBudgetCap: 28000,
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5.3-codex',
    models: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4' },
      { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark' },
    ],
    reasoningCapability: 'native-effort',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 400000,
    maxOutputTokens: 32768,
  },
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek V4 series (1M context, OpenAI-style `reasoning_effort`).
    // The pre-V4 aliases `deepseek-chat` / `deepseek-reasoner` are slated
    // for deprecation on 2026-07-24 and have been removed from KodaX —
    // existing configs pointing at them should switch to v4-flash.
    // Vision: inherits `KodaXOpenAICompatProvider` `image_url` serialization
    // (openai.ts:904). Upstream model-level vision support varies per model
    // — flag means KodaX does not artificially block the request; users see
    // real API errors if a specific model is text-only. v0.7.40 FEATURE_134.
    model: 'deepseek-v4-flash',
    models: [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    ],
    reasoningCapability: 'native-effort',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    // V4 series ships a 1M context. Server advertises a 384K max output
    // ceiling but we cap per-turn output at the standard escalation budget
    // so streams finish well under server-side timeouts; the agent loop
    // already escalates on `stop_reason: max_tokens`.
    contextWindow: 1_000_000,
    maxOutputTokens: KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
  },
  kimi: {
    apiKeyEnv: 'KIMI_API_KEY',
    model: 'kimi-k2.6',
    models: [
      // Both K2.5 and K2.6 ship a 256K context (user-confirmed against
      // the upstream catalog, 2026-04). FEATURE_098 originally pinned
      // k2.5 to 128K based on documentation available at that time;
      // either Moonshot upgraded K2.5 since or the original 128K figure
      // was incorrect. No override — k2.5 inherits the 256K provider
      // default below.
      { id: 'k2.5', displayName: 'K2.5' },
    ],
    reasoningCapability: 'native-effort',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 256000,
    maxOutputTokens: 32768,
  },
  'kimi-code': {
    apiKeyEnv: 'KIMI_API_KEY',
    // The Kimi-for-Coding endpoint ignores the request `model` field and
    // always routes to whichever K2.x GA model the platform has currently
    // promoted (K2.6 as of 2026-04). We surface a single stable label so
    // users aren't tempted to pick a specific version that the server will
    // silently ignore.
    // Vision: inherits Anthropic-compat image-block serialization
    // (anthropic.ts:770). User-validated 2026-05-13 — kimi-for-coding
    // endpoint accepts and processes image input. v0.7.40 FEATURE_134.
    model: 'kimi-for-coding',
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 256000,
    // Bench-confirmed (2026-04): kimi-for-coding completes 64K stream
    // cleanly at 525s with stop_reason=tool_use (23K output tokens, 1400
    // HTML lines). Does NOT share the zhipu-coding 308s server-side kill
    // window. Capped at 32K for cost predictability; tasks needing more
    // output flow through the L5 continuation meta path. Override with
    // `KODAX_MAX_OUTPUT_TOKENS` to allow larger single-turn generation.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  },
  qwen: {
    apiKeyEnv: 'QWEN_API_KEY',
    model: 'qwen3.5-plus',
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 256000,
    maxOutputTokens: 32768,
  },
  zhipu: {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      // User-confirmed (2026-05): GLM-5 Turbo ships the same 200K window
      // as GLM-5 / GLM-5.1 on the public endpoint. The original FEATURE_098
      // 128K pin mirrored docs that were either outdated or wrong — same
      // correction pattern as kimi/k2.5. Inherits the 200K provider default.
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 200000,
    maxOutputTokens: 32768,
  },
  'zhipu-coding': {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      // User-confirmed (2026-05): GLM-5 Turbo ships the same 200K window as
      // GLM-5 / GLM-5.1 on this endpoint. The original FEATURE_098 128K pin
      // mirrored docs that were either outdated or wrong — same correction
      // pattern as kimi/k2.5. Inheriting the 200K provider-level default.
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 200000,
    // Bench-confirmed: GLM Coding Plan has a ~308s server-side kill window
    // (mean 308.4s ± 0.2s, 6/6 reproductions on 64K stream tasks). 16K cap
    // targets completion within the kill window for typical tool_use turns
    // (~40-57 tok/s decode rate). Override with `KODAX_MAX_OUTPUT_TOKENS`
    // to bypass.
    maxOutputTokens: 16_000,
    thinkingBudgetCap: 16000,
  },
  'minimax-coding': {
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'MiniMax-M2.7',
    // Probe (2026-04) against the public Token Plan: bare model IDs
    // (no `-highspeed` suffix) resolve, the `-highspeed` variants
    // return 500 "your current token plan not support model". Listing
    // the bare IDs as the canonical surface; legacy `-highspeed`
    // entries kept for users who do have them on a higher tier.
    models: [
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', displayName: 'MiniMax M2.5 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2.1', displayName: 'MiniMax M2.1' },
      { id: 'MiniMax-M2.1-highspeed', displayName: 'MiniMax M2.1 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2', displayName: 'MiniMax M2' },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 204800,
    // Bench-confirmed (2026-04, MiniMax-M2.7 64K stream): completes cleanly
    // at 464.9s. Standard 32K cap + L5 continuation handles long generation.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  },
  'mimo-coding': {
    // Xiaomi MiMo Token Plan subscription endpoint (Anthropic-compat).
    // Token Plan keys are `tp-xxxxx`; pay-as-you-go keys (`sk-xxxxx`) are
    // a separate product on a different host and are NOT cross-compatible.
    apiKeyEnv: 'MIMO_API_KEY',
    model: 'mimo-v2.5-pro',
    models: [
      { id: 'mimo-v2.5', displayName: 'MiMo V2.5' },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    // V2.5 series advertises a 1M context window (per platform docs).
    contextWindow: 1_000_000,
    // Bench-confirmed (2026-04): mimo-v2.5-pro completes 64K stream cleanly
    // at 309.6s. Standard 32K cap + L5 continuation handles long generation.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
    thinkingBudgetCap: 16_000,
  },
  'ark-coding': {
    // Volcengine Ark Coding Plan subscription endpoint (Anthropic-compat).
    // Multi-model gateway routing by the request `model` field — unlike
    // kimi-for-coding the gateway honors per-request model selection. Bench
    // (2026-04) confirmed model routing with the standard `x-api-key` header
    // (no Bearer needed despite the official Claude Code config recommending
    // `ANTHROPIC_AUTH_TOKEN`). DeepSeek V4 added 2026-05.
    apiKeyEnv: 'ARK_API_KEY',
    model: 'glm-5.1',
    // Per-model context windows below are user-confirmed against the
    // Volcengine console model catalog (2026-04). Provider-level default
    // 200K matches the GLM family; the rest get explicit overrides.
    models: [
      { id: 'glm-4.7', displayName: 'GLM-4.7' },
      { id: 'kimi-k2.6', displayName: 'Kimi K2.6', contextWindow: 256_000 },
      { id: 'kimi-k2.5', displayName: 'Kimi K2.5', contextWindow: 256_000 },
      // `minimax-latest` is the Ark-side alias that resolves to the
      // current MiniMax GA coding model (M2.7 as of 2026-04). Pinned to
      // 204_800 to match the `minimax-coding` provider's M2.x family.
      { id: 'minimax-latest', displayName: 'MiniMax Latest', contextWindow: 204_800 },
      // V3 series 128K window; V4 series ships 1M (matches direct DeepSeek
      // provider). Ark gateway exposed V4 via Coding Plan as of 2026-05.
      { id: 'deepseek-v3.2', displayName: 'DeepSeek V3.2', contextWindow: 128_000 },
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
      { id: 'doubao-seed-2.0-code', displayName: 'Doubao Seed 2.0 Code', contextWindow: 256_000 },
      { id: 'doubao-seed-2.0-pro', displayName: 'Doubao Seed 2.0 Pro', contextWindow: 256_000 },
      { id: 'doubao-seed-2.0-lite', displayName: 'Doubao Seed 2.0 Lite', contextWindow: 256_000 },
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: true,
    contextWindow: 200_000,
    // Bench-confirmed (2026-04, glm-5.1 32K stream + tool_use): completes
    // cleanly at 947s. Standard 32K cap matches the kimi-code / mimo-coding
    // / minimax-coding pattern; tasks needing more output flow through the
    // L5 continuation meta path. Override with `KODAX_MAX_OUTPUT_TOKENS`.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  },
  'gemini-cli': {
    // FEATURE_134 v0.7.40: Gemini CLI 2.x supports `@<path>` file-include
    // syntax in prompts (including image files). KodaX's ACP bridge
    // `KodaXGeminiCliProvider.serializeImageBlockToPromptToken` returns
    // `@<abs-path>` for each image block on the latest user message,
    // letting Gemini's CLI side resolve the file content. Other CLI-bridge
    // providers (codex-cli) still default to text-only.
    apiKeyEnv: 'GEMINI_API_KEY',
    model: GEMINI_CLI_DEFAULT_MODEL,
    // CLI bridge: model surface is owned by the local Gemini CLI binary
    // (KodaX delegates the actual model call). KodaX-side context window
    // and max output tokens are not authoritative — the upstream CLI
    // resolves them per its own version + flag set. Leave capability
    // fields undefined so consumers know to defer.
    models: GEMINI_CLI_MODELS.filter((model) => model !== GEMINI_CLI_DEFAULT_MODEL).map((id) => ({ id })),
    reasoningCapability: 'prompt-only',
    capabilityProfile: IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: false,
  },
  'codex-cli': {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: CODEX_CLI_DEFAULT_MODEL,
    // CLI bridge — same rationale as gemini-cli above. Capability fields
    // intentionally undefined; the local Codex CLI owns the model surface.
    models: CODEX_CLI_MODELS.filter((model) => model !== CODEX_CLI_DEFAULT_MODEL).map((id) => ({ id })),
    reasoningCapability: 'prompt-only',
    capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    supportsThinking: false,
  },
};

// Derive a Provider class's config from the canonical snapshot plus the
// per-class overrides (runtime-only fields: baseUrl, streamMaxDurationMs,
// replayReasoningContent, strictThinkingSignature, etc.). All capability
// fields (`apiKeyEnv` / `model` / `reasoningCapability` / `models` /
// `contextWindow` / `maxOutputTokens` / `thinkingBudgetCap` /
// `supportsThinking`) are sourced exclusively from the snapshot so the
// snapshot stays the single source of truth — Provider classes only
// supply runtime knobs.
type ProviderRuntimeExtras = Omit<
  KodaXProviderConfig,
  | 'apiKeyEnv'
  | 'model'
  | 'reasoningCapability'
  | 'models'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'thinkingBudgetCap'
  | 'supportsThinking'
> & { supportsThinking?: boolean };

function buildProviderConfig<K extends ProviderName>(
  name: K,
  extras: ProviderRuntimeExtras = {},
): KodaXProviderConfig {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  return {
    apiKeyEnv: snapshot.apiKeyEnv,
    model: snapshot.model,
    reasoningCapability: snapshot.reasoningCapability,
    models: snapshot.models,
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    thinkingBudgetCap: snapshot.thinkingBudgetCap,
    supportsThinking: snapshot.supportsThinking ?? false,
    ...extras,
  };
}

// ============== 具体 Provider 实现 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('anthropic', {
    // Anthropic proper cryptographically verifies `signature` on
    // `thinking` blocks. Cross-provider thinking (kept around when
    // user /model-switches mid-session) carries empty or other-issuer
    // signatures that fail verification → 400. The serialiser converts
    // those to a `<prior_reasoning>` text block; only Anthropic-issued
    // thinking blocks pass through. Third-party Anthropic-compat
    // providers (kimi-code, ark-coding, etc.) lack the signing key and
    // accept any signature, so they keep the lenient default. v0.7.28.
    strictThinkingSignature: true,
  });
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu-coding', {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    // streamMaxDurationMs 300s: GLM's 308s server-side kill window includes
    // server-side jitter; client-side timer measured from request send sees
    // server kill at ~308.5s (after RTT). 300s gives a ~8s pre-emption
    // margin so the watchdog aborts BEFORE the server RSTs, routing through
    // non_streaming_fallback cleanly. Other anthropic-compat coding-plan
    // providers (kimi-code, mimo-coding, minimax-coding) completed 64K
    // cleanly in bench and need no equivalent cap.
    streamMaxDurationMs: 300_000,
  });
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi-code', {
    // api.kimi.com/coding/ is a unified subscription-routed coding endpoint:
    // the server ignores the request `model` field and always serves the
    // current K2.x GA model. Listing version-specific labels (K2.5 / K2.6)
    // here would be misleading — the only honest identifier is the routing
    // alias `kimi-for-coding`, exposed via the snapshot's default model.
    // K2 server-side prefix caching is automatic on this endpoint, so
    // switching to the OpenAI-compat sibling (api.kimi.com/coding/v1) would
    // yield no cache benefit while losing tool_use schema fidelity.
    baseUrl: 'https://api.kimi.com/coding/',
  });
  constructor() { super(); this.initClient(); }
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('minimax-coding', {
    baseUrl: 'https://api.minimaxi.com/anthropic',
  });
  constructor() { super(); this.initClient(); }
}

class MimoCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo-coding', {
    // CN cluster (Token Plan also has SGP / AMS clusters at
    // token-plan-{sgp,ams}.xiaomimimo.com/anthropic — same protocol,
    // pin to CN until users surface a region-switch need).
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  });
  constructor() { super(); this.initClient(); }
}

class ArkCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'ark-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('ark-coding', {
    // Volcengine Ark Coding Plan, Beijing cluster. The overseas BytePlus
    // mirror at https://ark.ap-southeast.bytepluses.com/api/coding speaks
    // the same protocol; users outside CN can override via baseUrl env or
    // a custom provider entry.
    //
    // ⚠️  Use ONLY the `/api/coding` path. The sibling `/api/v3` (without
    // `coding/`) is the standard pay-per-token Ark API and does NOT consume
    // Coding Plan quota — accidentally pointing here bills outside the
    // subscription.
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  });
  constructor() { super(); this.initClient(); }
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('openai');
  constructor() { super(); this.initClient(); }
}

class DeepSeekProvider extends KodaXOpenAICompatProvider {
  readonly name = 'deepseek';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    // V4 thinking mode 400s on multi-turn replays that strip
    // reasoning_content (empirically verified via direct API probe).
    // Kimi/Qwen/Zhipu share the same OpenAI-compat field convention so
    // they get the same flag for max fault-tolerance — see those
    // provider entries below.
    replayReasoningContent: true,
  });
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi', {
    baseUrl: 'https://api.moonshot.cn/v1',
    // Same OpenAI-compat reasoning_content convention as DeepSeek V4.
    // Empirically unverified for Kimi specifically, but the failure mode
    // (multi-turn 400 when reasoning_content is stripped from history)
    // is identical in shape — opting in for max fault-tolerance.
    // OpenAI proper stays explicitly off (different protocol).
    replayReasoningContent: true,
  });
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('qwen', {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // Same rationale as Kimi above — unverified, opting in.
    replayReasoningContent: true,
  });
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu', {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // Same rationale as Kimi above — unverified, opting in.
    replayReasoningContent: true,
  });
  constructor() { super(); this.initClient(); }
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
  'mimo-coding': () => new MimoCodingProvider(),
  'ark-coding': () => new ArkCodingProvider(),
  'gemini-cli': () => new KodaXGeminiCliProvider(),
  'codex-cli': () => new KodaXCodexCliProvider(),
};

export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

// Lazy singleton cache for built-in provider instances. Keyed on both the
// provider name and the current apiKey env value so tests that mutate
// `*_API_KEY` between cases still see a fresh SDK client (Issue: repeated
// `new Anthropic({...})` is expensive and held onto process state — the
// cache means each provider class wires its SDK client exactly once per
// credential configuration, and shared across call sites).
interface BuiltinProviderCacheEntry {
  apiKey: string | undefined;
  instance: KodaXBaseProvider;
}
const builtinProviderCache = new Map<string, BuiltinProviderCacheEntry>();

function resolveApiKeyEnvForProvider(name: string): string | undefined {
  if (!isProviderName(name)) {
    return undefined;
  }
  return KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv;
}

export function getProvider(name?: string): KodaXBaseProvider {
  const n = name ?? KODAX_DEFAULT_PROVIDER;
  const factory = KODAX_PROVIDERS[n];
  if (!factory) throw new KodaXProviderError(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`, n);

  const apiKeyEnv = resolveApiKeyEnvForProvider(n);
  const currentApiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

  const cached = builtinProviderCache.get(n);
  if (cached && cached.apiKey === currentApiKey) {
    return cached.instance;
  }

  const instance = factory();
  builtinProviderCache.set(n, { apiKey: currentApiKey, instance });
  return instance;
}

/**
 * Drop all cached built-in provider instances. Intended for tests that
 * manipulate `*_API_KEY` env variables outside the normal lifecycle
 * (the cache already self-invalidates on env changes, but callers may
 * want an explicit reset for isolation).
 */
export function resetBuiltinProviderCache(): void {
  builtinProviderCache.clear();
}

// 检查 Provider 是否已配置 API Key
export function isProviderConfigured(name: string): boolean {
  if (!isProviderName(name)) {
    return false;
  }
  return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
}

// 获取 Provider 使用的模型名称
export function getProviderModel(name: string): string | null {
  return isProviderName(name)
    ? KODAX_PROVIDER_SNAPSHOTS[name].model
    : null;
}

export function getProviderConfiguredReasoningCapability(
  name: string,
  modelOverride?: string,
): KodaXReasoningCapability | 'unknown' {
  if (!isProviderName(name)) {
    return 'unknown';
  }

  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  const effectiveModel = modelOverride ?? snapshot.model;

  return snapshot.modelReasoningCapabilities?.[effectiveModel]
    ?? snapshot.reasoningCapability;
}

export function getProviderConfiguredCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  return isProviderName(name)
    ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
    : null;
}

// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: KodaXReasoningCapability;
  capabilityProfile: KodaXProviderCapabilityProfile;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: KodaXReasoningCapability;
    capabilityProfile: KodaXProviderCapabilityProfile;
  }> = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    result.push({
      name,
      model: snapshot.model,
      models: snapshot.models
        ? [snapshot.model, ...snapshot.models.map((m) => m.id)]
        : [snapshot.model],
      configured: !!process.env[snapshot.apiKeyEnv],
      reasoningCapability: snapshot.reasoningCapability,
      capabilityProfile: cloneCapabilityProfile(snapshot.capabilityProfile),
    });
  }
  return result;
}

// 获取内置 Provider 的可用模型列表（不需要实例化 Provider，不依赖 API Key）
export function getProviderModels(name: string): string[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  return snapshot.models
    ? [snapshot.model, ...snapshot.models.map((m) => m.id)]
    : [snapshot.model];
}

// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name: string): name is ProviderName {
  return name in KODAX_PROVIDERS;
}

// ============== SDK Model Capability Exposure (v0.7.43) ==============
//
// These getters read directly from `KODAX_PROVIDER_SNAPSHOTS` (the single
// source of truth post-refactor) so SDK consumers can list provider /
// model capabilities WITHOUT a Provider instance — meaning without
// requiring the API key env var to be set. KodaX itself maintains this
// metadata; consumers only need to know the provider name.
//
// Custom-provider counterparts live in `custom-registry.ts` and dispatch
// from `resolveProviderModelDescriptors` / `resolveModelCapabilities`
// below (which route built-in vs custom-name lookups transparently).

/**
 * Effective per-model capability surface. v0.7.43 SDK exposure.
 *
 * Values are resolved with the cascade:
 *   1. Per-model descriptor override (`KodaXModelDescriptor` field)
 *   2. Provider-level default (`KODAX_PROVIDER_SNAPSHOTS[name].*`)
 *   3. `undefined` (the field is genuinely not advertised for this model)
 *
 * `displayName` falls back to `id` when not set; never undefined.
 *
 * **Why no `maxOutputTokens`**: Upstream providers report it inconsistently
 * (some advertise inflated "theoretical" ceilings, others don't expose it
 * at all, and stream behavior often deviates from the advertised value).
 * KodaX uses an internal per-turn output cap (`KodaXProviderConfig.maxOutputTokens`)
 * that the agent loop can escalate via L5 continuation — that cap is a KodaX
 * runtime decision, not a model claim, and surfacing it as model metadata
 * would mislead SDK consumers into building UIs around an unreliable number.
 * If you need to know "how much output a turn can produce", consult the
 * provider's own documentation; KodaX does not certify this value.
 */
export interface KodaXModelCapabilities {
  /** Provider name (`anthropic`, `kimi`, `ark-coding`, or any custom name). */
  provider: string;
  /** Model id (the value `runKodaX(... { model } ...)` accepts). */
  model: string;
  /** Human-readable label — falls back to `model` when no descriptor entry. */
  displayName: string;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  supportsThinking: boolean;
  /** Effective reasoning capability for THIS model (per-model override aware). */
  reasoningCapability: KodaXReasoningCapability;
  /** Maximum input context window (tokens). `undefined` for CLI-bridge providers. */
  contextWindow?: number;
  /** Upper bound on `thinking_budget` (native-budget providers only). */
  thinkingBudgetCap?: number;
  /** True when the model is the provider's default (the `model` field on the snapshot). */
  isDefault: boolean;
}

function makeDefaultDescriptor(
  snapshot: ProviderSnapshot,
): KodaXModelDescriptor {
  // The default model has no descriptor entry in `models[]` — synthesize
  // one from provider-level defaults so callers see a uniform shape.
  return { id: snapshot.model };
}

function effectiveCapabilities(
  providerName: string,
  snapshot: ProviderSnapshot,
  descriptor: KodaXModelDescriptor,
): KodaXModelCapabilities {
  const isDefault = descriptor.id === snapshot.model;
  return {
    provider: providerName,
    model: descriptor.id,
    displayName: descriptor.displayName ?? descriptor.id,
    supportsThinking: snapshot.supportsThinking ?? false,
    reasoningCapability:
      descriptor.reasoningCapability ?? snapshot.reasoningCapability,
    contextWindow: descriptor.contextWindow ?? snapshot.contextWindow,
    thinkingBudgetCap:
      descriptor.thinkingBudgetCap ?? snapshot.thinkingBudgetCap,
    isDefault,
  };
}

/**
 * List all model descriptors for a built-in provider — default model first,
 * then alternatives. No API key required (reads from KODAX_PROVIDER_SNAPSHOTS).
 *
 * Returns an empty array for unknown provider names so SDK consumers can
 * iterate `[...KODAX_PROVIDER_LIST, ...customNames]` without a guard per name.
 */
export function getProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  return [makeDefaultDescriptor(snapshot), ...(snapshot.models ?? [])];
}

/**
 * Effective per-model capability surface for a built-in provider. Returns
 * `undefined` for unknown provider name or unknown model under a known
 * provider — caller should fall back to `DEFAULT_CONTEXT_WINDOW` from
 * `@kodax-ai/kodax/agent` when nothing is advertised.
 *
 * No API key required.
 */
export function getModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[providerName as ProviderName];
  if (!snapshot) return undefined;
  if (modelId === snapshot.model) {
    return effectiveCapabilities(providerName, snapshot, makeDefaultDescriptor(snapshot));
  }
  const entry = snapshot.models?.find((m) => m.id === modelId);
  if (!entry) return undefined;
  return effectiveCapabilities(providerName, snapshot, entry);
}

/**
 * Full capability listing for every built-in provider/model pair. Default
 * model comes first per provider, in the order providers appear in
 * `KODAX_PROVIDERS`. Use this for popout UIs that enumerate all models
 * without filtering by `configured` (the consumer can filter post-hoc by
 * checking `process.env[snapshot.apiKeyEnv]` themselves, or just present
 * everything for selection).
 *
 * Custom-provider models are exposed via the equivalent helper in
 * `custom-registry.ts` (`getCustomProviderModelCapabilities`).
 */
export function listBuiltinModelCapabilities(): KodaXModelCapabilities[] {
  const result: KodaXModelCapabilities[] = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    result.push(effectiveCapabilities(name, snapshot, makeDefaultDescriptor(snapshot)));
    for (const entry of snapshot.models ?? []) {
      result.push(effectiveCapabilities(name, snapshot, entry));
    }
  }
  return result;
}

export { normalizeCapabilityProfile };
