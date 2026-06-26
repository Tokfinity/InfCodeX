/**
 * KodaX Provider Registry
 *
 * Provider 娉ㄥ唽琛?- 缁熶竴绠＄悊鎵€鏈?Provider
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
  KodaXReasoningProfile,
  KodaXVerifyStrategy,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import {
  cloneCapabilityProfile,
  normalizeCapabilityProfile,
} from './capability-profile.js';
import { getProviderSnapshots } from './provider-capabilities.loader.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ============== Provider 鍚嶇О绫诲瀷 ==============

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'kimi-code'
  | 'qwen'
  | 'zhipu'
  | 'zhipu-coding'
  | 'zai-coding'
  | 'minimax-coding'
  | 'mimo-coding'
  | 'mimo'
  | 'ark-coding'
  | 'gemini-cli'
  | 'codex-cli';

/**
 * Per-provider static metadata. v0.7.43 promoted this from a partial
 * descriptor (`models: string[]`) to the full capability surface so
 * SDK consumers can read context windows / max output tokens /
 * thinking-budget caps / per-model descriptors without instantiating
 * a Provider class (which previously required a valid API key just
 * to read static metadata).
 *
 * v0.7.44 FEATURE_198 moved the data into a separate JSON file
 * (`provider-capabilities.json`) so it can be patched without a
 * KodaX release. The structural type below mirrors the JSON-resolved
 * shape and remains the single source of truth for capability data;
 * Provider classes derive their runtime `config` from it via
 * `buildProviderConfig`.
 */
type ProviderSnapshot = {
  readonly model: string;
  /**
   * Alternative model descriptors beyond the default `model`. Carries
   * per-model capability overrides (`contextWindow` / `maxOutputTokens` /
   * `thinkingBudgetCap` / `reasoningCapability` / `replayReasoningContent` /
   * `strictThinkingSignature`). Provider-level defaults below fill any
   * gaps a descriptor leaves unset. The default model has no descriptor
   * entry 鈥?it inherits provider-level defaults directly.
   */
  readonly models?: readonly KodaXModelDescriptor[];
  readonly apiKeyEnv: string;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly reasoningProfile?: KodaXReasoningProfile;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: KodaXProviderCapabilityProfile;
  /** Maximum input context window (tokens). Provider-level default. */
  readonly contextWindow?: number;
  /** Per-turn output token cap KodaX requests. Provider-level default. */
  readonly maxOutputTokens?: number;
  /** Upper bound on `thinking_budget` for native-budget reasoning providers. */
  readonly thinkingBudgetCap?: number;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  readonly supportsThinking?: boolean;
  /**
   * FEATURE_216 v0.7.45 鈥?Which verify primitive this provider supports
   * for credential checks. Mirrors `provider-capabilities.types.ts`
   * ProviderSnapshot's required field.
   */
  readonly verifyStrategy: KodaXVerifyStrategy;
};

// Canonical source for provider identity (apiKeyEnv, default model,
// reasoning capability, capability profile). Per-class Provider configs
// derive the three overlapping fields via `buildProviderConfig` so the
// two structures cannot drift.
//
// v0.7.44 FEATURE_198: backed by `provider-capabilities.json` via the
// loader; the JSON is read once at module init, validated, and resolved
// (profile-name strings 鈫?KodaXProviderCapabilityProfile objects;
// cliBridge entries filled with local CLI's default/known models). The
// export surface is unchanged 鈥?every consumer that read this Record
// continues to read the same Record shape, no caller-side changes.
export const KODAX_PROVIDER_SNAPSHOTS: Record<ProviderName, ProviderSnapshot> =
  // Loader returns Readonly<Record<string, ProviderSnapshot>>; the boot
  // validator ensures every ProviderName key is populated, so the
  // narrowed cast is safe. Double-cast (via unknown) silences the TS
  // overlap warning that FEATURE_216's stricter ProviderSnapshot
  // (mandatory verifyStrategy) surfaces.
  getProviderSnapshots() as unknown as Record<ProviderName, ProviderSnapshot>;

// Derive a Provider class's config from the canonical snapshot plus the
// per-class overrides (runtime-only fields: baseUrl, streamMaxDurationMs,
// replayReasoningContent, strictThinkingSignature, etc.). All capability
// fields (`apiKeyEnv` / `model` / `reasoningCapability` / `models` /
// `contextWindow` / `maxOutputTokens` / `thinkingBudgetCap` /
// `supportsThinking` / `reasoningProfile`) are sourced exclusively from the snapshot so the
// snapshot stays the single source of truth 鈥?Provider classes only
// supply runtime knobs.
type ProviderRuntimeExtras = Omit<
  KodaXProviderConfig,
  | 'apiKeyEnv'
  | 'model'
  | 'reasoningCapability'
  | 'reasoningProfile'
  | 'models'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'thinkingBudgetCap'
  | 'supportsThinking'
  | 'verifyStrategy'
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
    reasoningProfile: snapshot.reasoningProfile,
    models: snapshot.models,
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    thinkingBudgetCap: snapshot.thinkingBudgetCap,
    supportsThinking: snapshot.supportsThinking ?? false,
    verifyStrategy: snapshot.verifyStrategy,
    ...extras,
  };
}

// ============== 鍏蜂綋 Provider 瀹炵幇 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('anthropic', {
    // Anthropic proper cryptographically verifies `signature` on
    // `thinking` blocks. Cross-provider thinking (kept around when
    // user /model-switches mid-session) carries empty or other-issuer
    // signatures that fail verification 鈫?400. The serialiser converts
    // those to a `<prior_reasoning>` text block; only Anthropic-issued
    // thinking blocks pass through. Third-party Anthropic-compat
    // providers (kimi-code, ark-coding, etc.) lack the signing key and
    // accept any signature, so they keep the lenient default. v0.7.28.
    strictThinkingSignature: true,
  });

  // Anthropic proper talks to api.anthropic.com and must keep the SDK's
  // native user agent 鈥?unlike the compat base, it adds no gateway headers.
  protected override buildClient(): Anthropic {
    return new Anthropic({ apiKey: this.getApiKey() });
  }
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
}

class ZaiCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zai-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zai-coding', {
    // Zhipu Coding Plan overseas mirror (api.z.ai). Same upstream models
    // and capability surface as zhipu-coding — the two providers differ
    // only in baseUrl and the API-key env var. Inherits the 300s
    // streamMaxDurationMs cap for the same GLM server-side kill-window
    // reason documented above (the overseas gateway proxies to the same
    // backend, so the timing characteristic applies identically).
    baseUrl: 'https://api.z.ai/api/anthropic',
    streamMaxDurationMs: 300_000,
  });
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi-code', {
    // api.kimi.com/coding/ is a unified subscription-routed coding endpoint:
    // the server ignores the request `model` field and always serves the
    // current K2.x GA model. Listing version-specific labels (K2.5 / K2.6)
    // here would be misleading 鈥?the only honest identifier is the routing
    // alias `kimi-for-coding`, exposed via the snapshot's default model.
    // K2 server-side prefix caching is automatic on this endpoint, so
    // switching to the OpenAI-compat sibling (api.kimi.com/coding/v1) would
    // yield no cache benefit while losing tool_use schema fidelity.
    baseUrl: 'https://api.kimi.com/coding/',
  });
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('minimax-coding', {
    baseUrl: 'https://api.minimaxi.com/anthropic',
  });
}

class MimoCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo-coding', {
    // CN cluster (Token Plan also has SGP / AMS clusters at
    // token-plan-{sgp,ams}.xiaomimimo.com/anthropic 鈥?same protocol,
    // pin to CN until users surface a region-switch need).
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  });
}

class MimoProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo', {
    // Xiaomi MiMo public pay-per-token Anthropic-compat endpoint
    // (https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api).
    // Same upstream model family as `mimo-coding` (mimo-v2.5-pro /
    // mimo-v2.5) 鈥?the two providers differ only in baseUrl and the
    // billing model (pay-per-token here vs Token-Plan subscription on
    // mimo-coding). All capability fields (context window, thinking
    // budget, max_tokens, etc.) come from `provider-capabilities.json`.
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
  });
}

class ArkCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'ark-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('ark-coding', {
    // Volcengine Ark Coding Plan, Beijing cluster. The overseas BytePlus
    // mirror at https://ark.ap-southeast.bytepluses.com/api/coding speaks
    // the same protocol; users outside CN can override via baseUrl env or
    // a custom provider entry.
    //
    // 鈿狅笍  Use ONLY the `/api/coding` path. The sibling `/api/v3` (without
    // `coding/`) is the standard pay-per-token Ark API and does NOT consume
    // Coding Plan quota 鈥?accidentally pointing here bills outside the
    // subscription.
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  });
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('openai');
}

class DeepSeekProvider extends KodaXOpenAICompatProvider {
  readonly name = 'deepseek';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    // V4 thinking mode 400s on multi-turn replays that strip
    // reasoning_content (empirically verified via direct API probe).
    // Kimi/Qwen/Zhipu share the same OpenAI-compat field convention so
    // they get the same flag for max fault-tolerance 鈥?see those
    // provider entries below.
    replayReasoningContent: true,
  });
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi', {
    baseUrl: 'https://api.moonshot.cn/v1',
    // Same OpenAI-compat reasoning_content convention as DeepSeek V4.
    // Empirically unverified for Kimi specifically, but the failure mode
    // (multi-turn 400 when reasoning_content is stripped from history)
    // is identical in shape 鈥?opting in for max fault-tolerance.
    // OpenAI proper stays explicitly off (different protocol).
    replayReasoningContent: true,
  });
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('qwen', {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // Same rationale as Kimi above 鈥?unverified, opting in.
    replayReasoningContent: true,
  });
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu', {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // Same rationale as Kimi above 鈥?unverified, opting in.
    replayReasoningContent: true,
  });
}

// ============== Provider 宸ュ巶 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'zai-coding': () => new ZaiCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
  'mimo-coding': () => new MimoCodingProvider(),
  mimo: () => new MimoProvider(),
  'ark-coding': () => new ArkCodingProvider(),
  'gemini-cli': () => new KodaXGeminiCliProvider(),
  'codex-cli': () => new KodaXCodexCliProvider(),
};

export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

// Lazy singleton cache for built-in provider instances. Keyed on both the
// provider name and the current apiKey env value so tests that mutate
// `*_API_KEY` between cases still see a fresh SDK client (Issue: repeated
// `new Anthropic({...})` is expensive and held onto process state 鈥?the
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

// 妫€鏌?Provider 鏄惁宸查厤缃?API Key
export function isProviderConfigured(name: string): boolean {
  if (!isProviderName(name)) {
    return false;
  }
  return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
}

// 鑾峰彇 Provider 浣跨敤鐨勬ā鍨嬪悕绉?
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
  const descriptor = snapshot.models?.find((m) => m.id === effectiveModel);

  return descriptor?.reasoningCapability
    ?? snapshot.modelReasoningCapabilities?.[effectiveModel]
    ?? snapshot.reasoningCapability;
}

export function getProviderConfiguredCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  return isProviderName(name)
    ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
    : null;
}

// 鑾峰彇鎵€鏈夊彲鐢ㄧ殑 Provider 鍒楄〃锛堝甫閰嶇疆鐘舵€侊級
export function getProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: KodaXReasoningCapability;
  reasoningProfile?: KodaXReasoningProfile;
  capabilityProfile: KodaXProviderCapabilityProfile;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: KodaXReasoningCapability;
    reasoningProfile?: KodaXReasoningProfile;
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
      reasoningProfile: snapshot.reasoningProfile,
      capabilityProfile: cloneCapabilityProfile(snapshot.capabilityProfile),
    });
  }
  return result;
}

// 鑾峰彇鍐呯疆 Provider 鐨勫彲鐢ㄦā鍨嬪垪琛紙涓嶉渶瑕佸疄渚嬪寲 Provider锛屼笉渚濊禆 API Key锛?
export function getProviderModels(name: string): string[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  return snapshot.models
    ? [snapshot.model, ...snapshot.models.map((m) => m.id)]
    : [snapshot.model];
}

// 绫诲瀷瀹堝崼鍑芥暟锛氭鏌ュ瓧绗︿覆鏄惁涓烘湁鏁堢殑 Provider 鍚嶇О
export function isProviderName(name: string): name is ProviderName {
  return name in KODAX_PROVIDERS;
}

// ============== SDK Model Capability Exposure (v0.7.43) ==============
//
// These getters read directly from `KODAX_PROVIDER_SNAPSHOTS` (the single
// source of truth post-refactor) so SDK consumers can list provider /
// model capabilities WITHOUT a Provider instance 鈥?meaning without
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
 * **All fields below are KodaX-maintained values** 鈥?they reflect what
 * KodaX itself uses at runtime (the per-turn `max_tokens` we request,
 * the thinking budget we cap at, etc.), benchmarked against the upstream
 * model so they are honest representations of the agent's behavior. They
 * are deliberately NOT sourced from upstream `/models` API responses,
 * which a 2026-05 cross-provider probe confirmed are sparse and often
 * empty (see docs/SDK_EMBEDDER_GUIDE.md 搂9). Embedders showing these
 * values in a popout UI can trust them.
 */
export interface KodaXModelCapabilities {
  /** Provider name (`anthropic`, `kimi`, `ark-coding`, or any custom name). */
  provider: string;
  /** Model id (the value `runKodaX(... { model } ...)` accepts). */
  model: string;
  /** Human-readable label 鈥?falls back to `model` when no descriptor entry. */
  displayName: string;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  supportsThinking: boolean;
  /** Effective reasoning capability for THIS model (per-model override aware). */
  reasoningCapability: KodaXReasoningCapability;
  /** Effort-first reasoning capability metadata for THIS model, when known. */
  reasoningProfile?: KodaXReasoningProfile;
  /** Maximum input context window (tokens). `undefined` for CLI-bridge providers. */
  contextWindow?: number;
  /**
   * Per-turn `max_tokens` KodaX requests. KodaX-side decision 鈥?
   * benchmarked against each provider (kill-windows, decode rate, cost
   * predictability). NOT the upstream "theoretical maximum" 鈥?providers
   * often advertise inflated ceilings; this value reflects what KodaX
   * actually asks for. If you display "expected output size" in your UI,
   * use this. Long generations escalate through the L5 continuation
   * meta path, not by raising this number per-turn.
   */
  maxOutputTokens?: number;
  /** Upper bound on `thinking_budget` (native-budget providers only). */
  thinkingBudgetCap?: number;
  /** True when the model is the provider's default (the `model` field on the snapshot). */
  isDefault: boolean;
}

function makeDefaultDescriptor(
  snapshot: ProviderSnapshot,
): KodaXModelDescriptor {
  // The default model has no descriptor entry in `models[]` 鈥?synthesize
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
    reasoningProfile:
      descriptor.reasoningProfile ?? snapshot.reasoningProfile,
    contextWindow: descriptor.contextWindow ?? snapshot.contextWindow,
    maxOutputTokens: descriptor.maxOutputTokens ?? snapshot.maxOutputTokens,
    thinkingBudgetCap:
      descriptor.thinkingBudgetCap ?? snapshot.thinkingBudgetCap,
    isDefault,
  };
}

/**
 * List all model descriptors for a built-in provider 鈥?default model first,
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
 * Effective per-model capability surface for a built-in provider.
 *
 * Returns `undefined` only for an unknown PROVIDER name. An unknown MODEL under
 * a known provider inherits the provider-level capability (optimistic-wide
 * default — see the inline note below), so callers always get a usable surface
 * for any model id routed to a known provider.
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
  if (!entry) {
    // Unknown model under a KNOWN built-in provider: inherit the provider-level
    // capability (reasoning strategy is overwhelmingly a provider/family trait,
    // not per-model), tagged to the requested model id. This optimistic-wide
    // default keeps every effort rung the family advertises reachable, so a
    // freshly-released model id (e.g. a new GLM revision) still gets the right
    // ladder instead of collapsing to the generic off/low/medium/high fallback.
    // If a specific effort turns out unsupported, the real-response narrowing
    // path corrects it. Returns a non-default descriptor so `isDefault` is false.
    return effectiveCapabilities(providerName, snapshot, { id: modelId });
  }
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
