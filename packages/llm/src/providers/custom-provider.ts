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
  type KodaXReasoningCapabilityV2,
  type KodaXVerifyStrategy,
} from '../types.js';
import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { createReasoningCapabilityFromPreset } from '../reasoning.js';

const VALID_CUSTOM_PROVIDER_USER_AGENT_MODES = new Set(['compat', 'sdk']);
const VALID_CUSTOM_PROVIDER_VERIFY_STRATEGIES = new Set<KodaXVerifyStrategy>([
  'count-tokens',
  'models-list',
  'minimal-message',
  'unsupported',
]);

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

export function legacyCapabilityFromV2(
  capability: KodaXReasoningCapabilityV2 | undefined,
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
      return 'generic-thinking-toggle';
    case 'native-budget':
      return protocol === 'anthropic' ? 'anthropic-budget' : 'qwen-hybrid-thinking';
    case 'native-effort':
      return protocol === 'anthropic' ? 'claude-adaptive-max' : 'openai-chat-reasoning';
    case 'native-adaptive':
      return protocol === 'anthropic' ? 'claude-adaptive-max' : 'generic-thinking-toggle';
    default:
      return supportsThinking === true ? 'generic-thinking-toggle' : undefined;
  }
}

function resolveCustomReasoningCapabilityV2(
  reasoningCapabilityV2: KodaXReasoningCapabilityV2 | undefined,
  reasoningPreset: KodaXModelDescriptor['reasoningPreset'],
  reasoning: KodaXModelDescriptor['reasoning'],
  legacy?: {
    readonly protocol: KodaXProtocolFamily;
    readonly reasoningCapability?: KodaXReasoningCapability;
    readonly supportsThinking?: boolean;
  },
): KodaXReasoningCapabilityV2 | undefined {
  if (reasoningCapabilityV2) {
    return { ...reasoningCapabilityV2, ...(reasoning ?? {}) };
  }
  const effectivePreset = reasoningPreset ?? (legacy
    ? legacyReasoningPresetForProtocol(
        legacy.protocol,
        legacy.reasoningCapability,
        legacy.supportsThinking,
      )
    : undefined);
  return effectivePreset
    ? createReasoningCapabilityFromPreset(effectivePreset, reasoning)
    : undefined;
}

export function resolveCustomProviderReasoningCapabilityV2(
  config: KodaXCustomProviderConfig,
): KodaXReasoningCapabilityV2 | undefined {
  return resolveCustomReasoningCapabilityV2(
    config.reasoningCapabilityV2,
    config.reasoningPreset,
    config.reasoning,
    {
      protocol: config.protocol,
      reasoningCapability: config.reasoningCapability,
      supportsThinking: config.supportsThinking,
    },
  );
}

export function resolveCustomModelReasoningCapabilityV2(
  descriptor: KodaXModelDescriptor,
  protocol: KodaXProtocolFamily,
): KodaXReasoningCapabilityV2 | undefined {
  return resolveCustomReasoningCapabilityV2(
    descriptor.reasoningCapabilityV2,
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
  const reasoningCapabilityV2 = resolveCustomModelReasoningCapabilityV2(entry, protocol);
  return reasoningCapabilityV2
    ? { ...entry, reasoningCapabilityV2 }
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
  const reasoningCapabilityV2 = resolveCustomProviderReasoningCapabilityV2(custom);
  const reasoningCapability =
    custom.reasoningCapability ??
    legacyCapabilityFromV2(reasoningCapabilityV2) ??
    (custom.supportsThinking ? 'native-toggle' : 'none');
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
    reasoningCapabilityV2,
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
