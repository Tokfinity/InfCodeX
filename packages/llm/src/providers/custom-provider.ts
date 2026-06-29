/**
 * Custom Provider Factory
 *
 * Creates KodaXBaseProvider instances from KodaXCustomProviderConfig.
 * Supports both OpenAI and Anthropic protocol families.
 */

import {
  type KodaXCustomProviderConfig,
  type KodaXModelDescriptor,
  type KodaXProtocolFamily,
  type KodaXProviderConfig,
  type KodaXReasoningCapability,
  type KodaXReasoningConfig,
  type KodaXReasoningProfile,
  type KodaXSimpleReasoningConfig,
  type KodaXVerifyStrategy,
} from '../types.js';
import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { createReasoningProfileFromPreset } from '../reasoning.js';

const VALID_CUSTOM_PROVIDER_USER_AGENT_MODES = new Set(['compat', 'sdk']);
const VALID_CUSTOM_PROVIDER_VERIFY_STRATEGIES = new Set<KodaXVerifyStrategy>([
  'count-tokens',
  'models-list',
  'minimal-message',
  'unsupported',
]);

type DeprecatedReasoningProfileAlias = {
  readonly reasoningCapabilityV2?: KodaXReasoningProfile;
};

function getConfiguredReasoningProfile(
  value: { readonly reasoningProfile?: KodaXReasoningProfile } & DeprecatedReasoningProfileAlias,
): KodaXReasoningProfile | undefined {
  return value.reasoningProfile ?? value.reasoningCapabilityV2;
}

/**
 * FEATURE_216 v0.7.45 — Derive the default verify strategy when a custom
 * provider config does not set `verifyStrategy` explicitly:
 *   - anthropic protocol → count-tokens (true 0-token if implemented)
 *   - openai protocol    → models-list (auth-gated GET if implemented)
 * Custom providers that hit an upstream where these defaults fail should
 * set `verifyStrategy: 'minimal-message'` explicitly in their config.
 */
function defaultVerifyStrategyForProtocol(
  protocol: 'anthropic' | 'openai',
): KodaXVerifyStrategy {
  return protocol === 'anthropic' ? 'count-tokens' : 'models-list';
}

export function legacyCapabilityFromReasoningProfile(
  capability: KodaXReasoningProfile | undefined,
): KodaXReasoningCapability | undefined {
  if (!capability) {
    return undefined;
  }
  if (capability.effortStrategy === 'none') {
    return 'none';
  }
  if (capability.effortStrategy === 'prompt-only') {
    return 'prompt-only';
  }
  if (capability.thinkingStrategy === 'anthropic-adaptive') {
    return 'native-adaptive';
  }
  if (capability.effortStrategy === 'provider-budget') {
    return 'native-budget';
  }
  if (capability.effortStrategy === 'provider-toggle') {
    return 'native-toggle';
  }
  return 'native-effort';
}

function legacyReasoningPresetForProtocol(
  protocol: KodaXProtocolFamily,
  reasoningCapability: KodaXReasoningCapability | undefined,
  supportsThinking?: boolean,
): KodaXModelDescriptor['reasoningPreset'] | undefined {
  if (supportsThinking === false) {
    return 'none';
  }
  switch (reasoningCapability) {
    case 'none':
    case 'prompt-only':
      return 'none';
    case 'native-toggle':
      // anthropic-compat: bare thinking:{type:'enabled'} is the correct non-Claude
      // shape (matches the built-in zhipu/kimi/minimax presets). openai-compat: there
      // is no portable thinking-toggle wire param — the Anthropic-shaped
      // thinking:{type:'enabled'} that generic-thinking-toggle would emit is
      // rejected/ignored by OpenAI-style relays (the v0.7.57 relay-deepseek
      // regression). Stay passive there: no profile → the name-gated capability
      // switch sends nothing for a custom (non-qwen/zhipu) provider, and
      // reasoning_content is parsed unconditionally regardless.
      return protocol === 'anthropic' ? 'generic-thinking-toggle' : undefined;
    case 'native-budget':
      return protocol === 'anthropic' ? 'anthropic-budget' : 'qwen-hybrid-thinking';
    case 'native-effort':
      return protocol === 'anthropic' ? 'claude-adaptive-max' : 'openai-chat-reasoning';
    case 'native-adaptive':
      // openai-compat has no portable adaptive wire param; stay passive there too.
      return protocol === 'anthropic' ? 'claude-adaptive-max' : undefined;
    default:
      // Bare supportsThinking with no explicit capability: anthropic-compat keeps the
      // non-Claude enable toggle; openai-compat stays passive (see native-toggle).
      if (supportsThinking !== true) return undefined;
      return protocol === 'anthropic' ? 'generic-thinking-toggle' : undefined;
  }
}

/** True for the canonical friendly form (`{ efforts }`) or `"none"`. */
function isSimpleReasoning(
  reasoning: KodaXReasoningConfig | undefined,
): reasoning is KodaXSimpleReasoningConfig | 'none' {
  return (
    reasoning === 'none'
    || (typeof reasoning === 'object'
      && reasoning !== null
      && Array.isArray((reasoning as KodaXSimpleReasoningConfig).efforts))
  );
}

/**
 * Build a full reasoning profile from the friendly `{ efforts, default }` form.
 * The wire strategy is derived from `protocol` so users never name a preset;
 * `"off"` maps to the internal `none` rung and lights up disable-thinking.
 */
function buildReasoningProfileFromSimple(
  simple: KodaXSimpleReasoningConfig | 'none',
  protocol: KodaXProtocolFamily,
): KodaXReasoningProfile {
  if (simple === 'none') {
    return createReasoningProfileFromPreset('none');
  }
  const toWire = (effort: string): string => (effort === 'off' ? 'none' : effort);
  const wireEfforts = simple.efforts.map(toWire);
  const defaultWire = simple.default ? toWire(simple.default) : undefined;
  const canDisable = wireEfforts.includes('none');
  const supportedEfforts = wireEfforts.map((value) =>
    value === defaultWire ? { value, isDefault: true } : { value },
  );
  return {
    // anthropic-compat: most anthropic-compatible endpoints front NON-Claude models
    // (zhipu/kimi/minimax/deepseek), whose thinking dialect is {type:'enabled'} +
    // reasoning_effort — NOT Claude's adaptive + output_config.effort. Map the friendly
    // form there so those models get thinking-on + a tunable effort (B1). A real-Claude
    // anthropic-compat endpoint instead wants adaptive: configure an explicit
    // reasoningProfile (effortStrategy:'anthropic-output-effort') for that case.
    effortStrategy: protocol === 'anthropic' ? 'anthropic-reasoning-effort' : 'openai-chat-effort',
    thinkingStrategy: 'provider-toggle',
    ...(defaultWire !== undefined ? { defaultEffort: defaultWire } : {}),
    supportedEfforts,
    ...(canDisable ? { disabledEfforts: ['none'], supportsDisabledThinking: true } : {}),
    supportsReasoningEffort: true,
  };
}

function resolveCustomReasoningProfile(
  reasoningProfile: KodaXReasoningProfile | undefined,
  reasoningPreset: KodaXModelDescriptor['reasoningPreset'],
  reasoning: KodaXModelDescriptor['reasoning'],
  legacy?: {
    readonly protocol: KodaXProtocolFamily;
    readonly reasoningCapability?: KodaXReasoningCapability;
    readonly supportsThinking?: boolean;
  },
): KodaXReasoningProfile | undefined {
  const simple = isSimpleReasoning(reasoning) ? reasoning : undefined;
  const partialOverride: Partial<KodaXReasoningProfile> | undefined =
    reasoning !== undefined && !isSimpleReasoning(reasoning) ? reasoning : undefined;

  // 1. Explicit full profile wins; an advanced partial override merges on top.
  if (reasoningProfile) {
    return { ...reasoningProfile, ...(partialOverride ?? {}) };
  }
  // 2. Canonical friendly form — preferred over the deprecated preset/legacy path.
  if (simple !== undefined) {
    return buildReasoningProfileFromSimple(simple, legacy?.protocol ?? 'openai');
  }
  // 3. Deprecated (auto-migrated): explicit preset name or legacy capability mapping.
  const effectivePreset = reasoningPreset ?? (legacy
    ? legacyReasoningPresetForProtocol(
        legacy.protocol,
        legacy.reasoningCapability,
        legacy.supportsThinking,
      )
    : undefined);
  return effectivePreset
    ? createReasoningProfileFromPreset(effectivePreset, partialOverride)
    : undefined;
}

export function resolveCustomProviderReasoningProfile(
  config: KodaXCustomProviderConfig,
): KodaXReasoningProfile | undefined {
  return resolveCustomReasoningProfile(
    getConfiguredReasoningProfile(config),
    config.reasoningPreset,
    config.reasoning,
    {
      protocol: config.protocol,
      reasoningCapability: config.reasoningCapability,
      supportsThinking: config.supportsThinking,
    },
  );
}

export function resolveCustomModelReasoningProfile(
  descriptor: KodaXModelDescriptor,
  protocol: KodaXProtocolFamily,
): KodaXReasoningProfile | undefined {
  return resolveCustomReasoningProfile(
    getConfiguredReasoningProfile(descriptor),
    descriptor.reasoningPreset,
    descriptor.reasoning,
    {
      protocol,
      reasoningCapability: descriptor.reasoningCapability,
    },
  );
}

function customModelDescriptorToFull(
  entry: string | KodaXModelDescriptor,
  protocol: KodaXProtocolFamily,
): KodaXModelDescriptor {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  const reasoningProfile = resolveCustomModelReasoningProfile(entry, protocol);
  return reasoningProfile
    ? { ...entry, reasoningProfile }
    : entry;
}

export function validateCustomProviderConfig(
  custom: KodaXCustomProviderConfig,
): void {
  if (!custom.name || !custom.baseUrl || !custom.apiKeyEnv || !custom.model) {
    throw new Error(
      `Custom provider requires name, baseUrl, apiKeyEnv, and model. Got: ${JSON.stringify({ name: custom.name, baseUrl: custom.baseUrl, apiKeyEnv: custom.apiKeyEnv, model: custom.model })}`,
    );
  }

  if (custom.protocol !== 'anthropic' && custom.protocol !== 'openai') {
    throw new Error(
      `Unknown protocol "${custom.protocol}" for custom provider "${custom.name}". Must be "anthropic" or "openai".`,
    );
  }

  if (
    custom.userAgentMode !== undefined
    && !VALID_CUSTOM_PROVIDER_USER_AGENT_MODES.has(custom.userAgentMode)
  ) {
    throw new Error(
      `Unknown userAgentMode "${custom.userAgentMode}" for custom provider "${custom.name}". Must be "compat" or "sdk".`,
    );
  }

  // FEATURE_216 v0.7.45 — Validate explicit verifyStrategy. Also guard
  // against the most common misconfiguration: 'count-tokens' on openai
  // protocol (openai-compat servers do not implement count_tokens).
  if (custom.verifyStrategy !== undefined) {
    if (!VALID_CUSTOM_PROVIDER_VERIFY_STRATEGIES.has(custom.verifyStrategy)) {
      throw new Error(
        `Unknown verifyStrategy "${custom.verifyStrategy}" for custom provider "${custom.name}". Must be one of "count-tokens" | "models-list" | "minimal-message" | "unsupported".`,
      );
    }
    if (custom.protocol === 'openai' && custom.verifyStrategy === 'count-tokens') {
      throw new Error(
        `Custom provider "${custom.name}": verifyStrategy="count-tokens" requires Anthropic protocol; got protocol="openai". Use "models-list" or "minimal-message" for OpenAI-compat.`,
      );
    }
  }
}

function buildProviderConfig(custom: KodaXCustomProviderConfig): KodaXProviderConfig {
  // Accept both legacy string ids and KodaXModelDescriptor objects.
  // FEATURE_098: descriptor objects carry per-model contextWindow /
  // maxOutputTokens / reasoningCapability so cross-model providers
  // can express real differences instead of a single provider-wide
  // value.
  const models = custom.models?.length
    ? custom.models.map((entry) => customModelDescriptorToFull(entry, custom.protocol))
    : undefined;
  const reasoningProfile = resolveCustomProviderReasoningProfile(custom);
  // supportsThinking:false forces the no-thinking preset at runtime
  // (legacyReasoningPresetForProtocol short-circuits to 'none'), so report the
  // capability as 'none' too — otherwise the capability surface advertises a tunable
  // effort the request never actually sends, misleading SDK / workflow consumers that
  // can't see the startup warning (see warnOnIgnoredReasoningCapability).
  const reasoningCapability =
    custom.supportsThinking === false
      ? 'none'
      : (custom.reasoningCapability ??
         legacyCapabilityFromReasoningProfile(reasoningProfile) ??
         (custom.supportsThinking ? 'native-toggle' : 'none'));
  const supportsThinking = custom.supportsThinking ??
    (reasoningCapability !== 'none' && reasoningCapability !== 'prompt-only');

  return {
    apiKeyEnv: custom.apiKeyEnv,
    model: custom.model,
    baseUrl: custom.baseUrl,
    models,
    userAgentMode: custom.userAgentMode,
    supportsThinking,
    reasoningCapability,
    reasoningProfile,
    capabilityProfile: custom.capabilityProfile,
    contextWindow: custom.contextWindow,
    maxOutputTokens: custom.maxOutputTokens,
    thinkingBudgetCap: custom.thinkingBudgetCap,
    // Provider-level defaults for the three two-layer cascade fields.
    // false / undefined match the legacy implicit defaults so existing
    // custom providers see zero behavior change. Per-model entries in
    // `models[]` can override individually via KodaXModelDescriptor.
    replayReasoningContent: custom.replayReasoningContent ?? false,
    strictThinkingSignature: custom.strictThinkingSignature ?? false,
    streamMaxDurationMs: custom.streamMaxDurationMs,
    // FEATURE_216 v0.7.45 — explicit verifyStrategy wins; otherwise
    // derive from protocol per the table in the type's JSDoc.
    verifyStrategy:
      custom.verifyStrategy ?? defaultVerifyStrategyForProtocol(custom.protocol),
  };
}

export function createCustomProvider(custom: KodaXCustomProviderConfig): KodaXBaseProvider {
  validateCustomProviderConfig(custom);

  const config = buildProviderConfig(custom);

  if (custom.protocol === 'anthropic') {
    return new DynamicAnthropicProvider(custom.name, config);
  }

  return new DynamicOpenAIProvider(custom.name, config);
}

class DynamicAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
  }
}

class DynamicOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
  }
}
