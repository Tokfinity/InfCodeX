/**
 * Unified Provider Resolver
 *
 * Resolves provider instances by checking built-in registry first,
 * then custom providers. Built-in takes precedence on name collision.
 */

import type { KodaXBaseProvider } from './base.js';
import { KODAX_PROVIDERS, isProviderName } from './registry.js';
import { getCustomProvider, isCustomProviderName, getCustomProviderNames } from './custom-registry.js';
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
