/**
 * Custom Provider Registry
 *
 * In-memory registry for user-defined providers from config.json.
 * Custom providers are separate from built-in providers to avoid
 * modifying the closed ProviderName union.
 */

import type {
  KodaXCustomProviderConfig,
  KodaXModelDescriptor,
  KodaXVerifyStrategy,
} from '../types.js';
import type { KodaXBaseProvider } from './base.js';
import {
  createCustomProvider,
  legacyCapabilityFromReasoningProfile,
  resolveCustomModelReasoningProfile,
  resolveCustomProviderReasoningProfile,
  validateCustomProviderConfig,
} from './custom-provider.js';
import {
  KODAX_PROVIDERS,
  type KodaXModelCapabilities,
} from './registry.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';

type CustomProviderFactory = () => KodaXBaseProvider;

const customProviders = new Map<string, KodaXCustomProviderConfig>();
const customFactories = new Map<string, CustomProviderFactory>();

const THINKING_REASONING_CAPABILITIES = new Set([
  'native-toggle',
  'native-budget',
  'native-effort',
  'native-adaptive',
]);

/**
 * F2 — non-fatal config guidance for a genuinely-contradictory reasoning config:
 * `supportsThinking: false` short-circuits to the "no thinking" preset and silently
 * ignores any `reasoningCapability`, so a config that sets a thinking capability AND
 * disables thinking is almost certainly a mistake. We deliberately do NOT warn on a
 * bare `supportsThinking: true` with no explicit reasoning mapping — that resolves to
 * a sensible default (passive on openai-compat, enable-toggle on anthropic-compat) and
 * is a valid, common config; warning on it would be noise. An explicit reasoningProfile
 * / reasoning / reasoningPreset overrides the legacy path, so it is not contradicted.
 */
function warnOnIgnoredReasoningCapability(config: KodaXCustomProviderConfig): void {
  const hasExplicitProfile = Boolean(
    config.reasoningProfile || config.reasoning || config.reasoningPreset,
  );
  if (
    config.supportsThinking === false &&
    config.reasoningCapability !== undefined &&
    THINKING_REASONING_CAPABILITIES.has(config.reasoningCapability) &&
    !hasExplicitProfile
  ) {
    console.warn(
      `[kodax] Custom provider "${config.name}": reasoningCapability "${config.reasoningCapability}" is ignored because supportsThinking is false (thinking stays off). Set supportsThinking: true to enable thinking, or remove reasoningCapability.`,
    );
  }
}

/**
 * Register custom providers from config. Replaces all existing custom providers.
 */
export function registerCustomProviders(configs: KodaXCustomProviderConfig[]): void {
  const seen = new Set<string>();
  const nextProviders = new Map<string, KodaXCustomProviderConfig>();
  const nextFactories = new Map<string, CustomProviderFactory>();
  for (const config of configs) {
    validateCustomProviderConfig(config);
    if (seen.has(config.name)) {
      throw new Error(`Duplicate custom provider name: "${config.name}". Each custom provider must have a unique name.`);
    }
    if (config.name in KODAX_PROVIDERS) {
      console.warn(`[kodax] Custom provider "${config.name}" shadows a built-in provider. The built-in provider will be used. Choose a different name to use your custom provider.`);
    }
    warnOnIgnoredReasoningCapability(config);
    seen.add(config.name);
    nextProviders.set(config.name, config);
    nextFactories.set(config.name, () => createCustomProvider(config));
  }

  customProviders.clear();
  customFactories.clear();
  for (const [name, config] of nextProviders) {
    customProviders.set(name, config);
  }
  for (const [name, factory] of nextFactories) {
    customFactories.set(name, factory);
  }
}

/**
 * Get a custom provider instance by name.
 * Returns undefined if not found in custom registry.
 * Note: This will throw if the provider's API key env var is not set.
 */
export function getCustomProvider(name: string): KodaXBaseProvider | undefined {
  const factory = customFactories.get(name);
  return factory ? factory() : undefined;
}

/**
 * Check if a name refers to a custom provider.
 */
export function isCustomProviderName(name: string): boolean {
  return customProviders.has(name);
}

/**
 * Get all custom provider names without instantiation.
 */
export function getCustomProviderNames(): string[] {
  return [...customProviders.keys()];
}

/**
 * Get display info for all registered custom providers.
 * Reads metadata from stored config without instantiating providers,
 * so it won't throw for unconfigured providers.
 */
export function getCustomProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: string;
  capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
  custom: true;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: string;
    capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
    custom: true;
  }> = [];
  for (const [name, config] of customProviders) {
    const configured = !!process.env[config.apiKeyEnv];
    const reasoningProfile = resolveCustomProviderReasoningProfile(config);
    const modelIds = (config.models ?? []).map(entry =>
      typeof entry === 'string' ? entry : entry.id,
    );
    const models = config.model && modelIds.length
      ? [...new Set([config.model, ...modelIds])]
      : [config.model];
    result.push({
      name,
      model: config.model,
      models,
      configured,
      reasoningCapability: config.reasoningCapability
        ?? legacyCapabilityFromReasoningProfile(reasoningProfile)
        ?? 'none',
      capabilityProfile: cloneCapabilityProfile(
        config.capabilityProfile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
      ),
      custom: true,
    });
  }
  return result;
}

/**
 * Get available model IDs for a custom provider.
 * Reads from stored config without instantiation.
 * Returns undefined if not a custom provider.
 */
export function getCustomProviderModels(name: string): string[] | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  const modelIds = (config.models ?? []).map(entry =>
    typeof entry === 'string' ? entry : entry.id,
  );
  return config.model && modelIds.length
    ? [...new Set([config.model, ...modelIds])]
    : [config.model];
}

// ============== SDK Model Capability Exposure for Custom Providers (v0.7.43) ==============
//
// Mirrors the built-in counterparts in `registry.ts` but reads from the
// in-memory `customProviders` map populated by
// `registerConfiguredCustomProviders` at startup (from `~/.kodax/config.json`).
// No instantiation, no API key required.

function customDescriptorToFull(
  entry: string | KodaXModelDescriptor,
  protocol: KodaXCustomProviderConfig['protocol'],
): KodaXModelDescriptor {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  const reasoningProfile = resolveCustomModelReasoningProfile(entry, protocol);
  return reasoningProfile
    ? { ...entry, reasoningProfile }
    : entry;
}

/**
 * List all model descriptors for a custom provider. Default model first,
 * then alternatives. Returns undefined when the name doesn't match any
 * registered custom provider — caller can fall through to the built-in
 * `getProviderModelDescriptors`.
 */
export function getCustomProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  const defaultEntry: KodaXModelDescriptor = { id: config.model };
  const alternatives = (config.models ?? [])
    .map((entry) => customDescriptorToFull(entry, config.protocol))
    .filter((m) => m.id !== config.model);
  return [defaultEntry, ...alternatives];
}

/**
 * Effective per-model capability surface for a custom provider. Returns
 * undefined when the provider name is not a registered custom provider,
 * OR when the model id doesn't appear under that provider. The same
 * descriptor-then-provider cascade as the built-in counterpart.
 */
export function getCustomModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  const config = customProviders.get(providerName);
  if (!config) return undefined;
  const isDefault = modelId === config.model;
  const providerReasoningProfile = resolveCustomProviderReasoningProfile(config);
  const descriptor = isDefault
    ? ({ id: config.model } as KodaXModelDescriptor)
    : (config.models ?? [])
        .map((entry) => customDescriptorToFull(entry, config.protocol))
        .find((m) => m.id === modelId);
  if (!descriptor) return undefined;
  const effectiveReasoningProfile =
    descriptor.reasoningProfile ?? providerReasoningProfile;
  const effectiveReasoningCapability =
    descriptor.reasoningCapability ??
    legacyCapabilityFromReasoningProfile(effectiveReasoningProfile) ??
    config.reasoningCapability ??
    'none';
  return {
    provider: providerName,
    model: descriptor.id,
    displayName: descriptor.displayName ?? descriptor.id,
    supportsThinking: config.supportsThinking ??
      (effectiveReasoningCapability !== 'none' && effectiveReasoningCapability !== 'prompt-only'),
    reasoningCapability: effectiveReasoningCapability,
    reasoningProfile: effectiveReasoningProfile,
    contextWindow: descriptor.contextWindow ?? config.contextWindow,
    maxOutputTokens: descriptor.maxOutputTokens ?? config.maxOutputTokens,
    thinkingBudgetCap:
      descriptor.thinkingBudgetCap ?? config.thinkingBudgetCap,
    isDefault,
  };
}

/**
 * FEATURE_216 v0.7.45 — Look up `(apiKeyEnv, verifyStrategy)` for a
 * registered custom provider without instantiation. Mirrors the
 * built-in `KODAX_PROVIDER_SNAPSHOTS` lookup. Returns undefined when
 * the name is not registered, signaling fall-through.
 *
 * verifyStrategy precedence:
 *   1. Explicit `customProviders[name].verifyStrategy` (user-provided)
 *   2. Protocol-derived default (anthropic → count-tokens / openai → models-list)
 *
 * Matches the same precedence `createCustomProvider()` applies when
 * building the runtime `KodaXProviderConfig` — keeps the two paths
 * (resolver short-circuit vs in-class verifyCredential) consistent.
 */
export function getCustomProviderVerifyMetadata(
  name: string,
): { apiKeyEnv: string; verifyStrategy: KodaXVerifyStrategy } | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  const verifyStrategy: KodaXVerifyStrategy =
    config.verifyStrategy ??
    (config.protocol === 'anthropic' ? 'count-tokens' : 'models-list');
  return { apiKeyEnv: config.apiKeyEnv, verifyStrategy };
}

/**
 * Full capability listing for every registered custom provider / model.
 * Mirrors `listBuiltinModelCapabilities`. Default model first per provider.
 */
export function listCustomProviderModelCapabilities(): KodaXModelCapabilities[] {
  const result: KodaXModelCapabilities[] = [];
  for (const [name, config] of customProviders) {
    const defaultCaps = getCustomModelCapabilities(name, config.model);
    if (defaultCaps) result.push(defaultCaps);
    for (const entry of config.models ?? []) {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (id === config.model) continue;
      const caps = getCustomModelCapabilities(name, id);
      if (caps) result.push(caps);
    }
  }
  return result;
}
