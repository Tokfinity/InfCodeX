/**
 * Unified Provider Resolver
 *
 * Resolves provider instances by checking built-in registry first,
 * then custom providers. Built-in takes precedence on name collision.
 */

import type { KodaXModelDescriptor } from '../types.js';
import type { KodaXBaseProvider } from './base.js';
import {
  KODAX_PROVIDERS,
  KODAX_PROVIDER_SNAPSHOTS,
  isProviderName,
  type KodaXModelCapabilities,
  getProviderModelDescriptors,
  getModelCapabilities,
  listBuiltinModelCapabilities,
} from './registry.js';
import {
  getCustomProvider,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
} from './custom-registry.js';
import {
  getRuntimeModelProvider,
  getRuntimeModelProviderNames,
  isRuntimeModelProviderName,
} from './runtime-registry.js';

/**
 * Resolve a provider by name. Built-in providers take precedence over custom.
 * @throws Error if provider is not found in either registry.
 */
export function resolveProvider(name: string): KodaXBaseProvider {
  // Built-in first
  if (isProviderName(name)) {
    return KODAX_PROVIDERS[name]();
  }
  // Runtime-registered model providers next
  const runtimeProvider = getRuntimeModelProvider(name);
  if (runtimeProvider) {
    return runtimeProvider;
  }
  // Custom second
  const custom = getCustomProvider(name);
  if (custom) {
    return custom;
  }
  const available = getAvailableProviderNames();
  throw new Error(`Unknown provider: ${name}. Available: ${available.join(', ')}`);
}

/**
 * Check if a name refers to any known provider (built-in or custom).
 */
export function isKnownProvider(name: string): boolean {
  return isProviderName(name) || isRuntimeModelProviderName(name) || isCustomProviderName(name);
}

/**
 * Get all available provider names (built-in + custom).
 */
export function getAvailableProviderNames(): string[] {
  const builtIn = Object.keys(KODAX_PROVIDERS);
  const runtimeNames = getRuntimeModelProviderNames();
  const customNames = getCustomProviderNames();
  // Deduplicate (built-in takes precedence)
  return [...new Set([...builtIn, ...runtimeNames, ...customNames])];
}

// ============== SDK Model Capability Dispatchers (v0.7.43) ==============
//
// Unified entry points routing built-in vs custom-provider lookups
// transparently. SDK consumers (KodaX Space etc.) call these — they
// don't need to know whether a provider is built-in or registered
// from `~/.kodax/config.json`. No API key required for either path.

/**
 * Model descriptors for any registered provider (built-in or custom).
 * Default model first, then alternatives. Empty array if name unknown.
 */
export function resolveProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] {
  if (isProviderName(name)) {
    return getProviderModelDescriptors(name);
  }
  return getCustomProviderModelDescriptors(name) ?? [];
}

/**
 * Effective capabilities for a single provider/model pair. Built-in
 * lookup first, then custom. Returns undefined when neither has it.
 */
export function resolveModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  if (isProviderName(providerName)) {
    return getModelCapabilities(providerName, modelId);
  }
  return getCustomModelCapabilities(providerName, modelId);
}

/**
 * Every model capability KodaX knows about — built-in + custom — in
 * a single flat list. Built-in providers come first (in `KODAX_PROVIDERS`
 * declaration order), then custom providers (in registration order).
 * Within each provider, default model first.
 *
 * Use for popout UIs that need a single source for a model picker.
 * No filtering by `configured` — consumers can subset themselves by
 * checking `process.env[snapshot.apiKeyEnv]` if they care.
 */
export function listAllModelCapabilities(): KodaXModelCapabilities[] {
  return [
    ...listBuiltinModelCapabilities(),
    ...listCustomProviderModelCapabilities(),
  ];
}

