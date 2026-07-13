/**
 * Coding-runtime adapter: registers an `McpCapabilityProvider` (from
 * `@kodax-ai/agent`) against the coding-specific `KodaXExtensionRuntime`.
 *
 * FEATURE_082 (v0.7.24): split out of the old
 * `capabilities/providers/mcp/provider.ts`. The provider class now lives in
 * `@kodax-ai/agent` and stays free of any coding runtime dependency; this file
 * is the thin bridge that wires the provider into the coding extension
 * runtime.
 */

import { McpCapabilityProvider, type McpProviderOptions } from '@kodax-ai/agent';
import type { McpServersConfig } from '@kodax-ai/agent';
import type { KodaXExtensionRuntime } from '../../extensions/runtime.js';

export async function registerConfiguredMcpCapabilityProvider(
  runtime: KodaXExtensionRuntime,
  servers: McpServersConfig | undefined,
  options: McpProviderOptions = {},
): Promise<McpCapabilityProvider | undefined> {
  const provider = new McpCapabilityProvider(servers, options);
  if (!provider.hasActiveServers()) {
    return undefined;
  }

  runtime.registerCapabilityProvider(provider, {
    source: {
      kind: 'runtime',
      id: 'runtime:capability:mcp',
      label: 'MCP Capability Provider',
    },
  });
  await provider.prewarm();
  return provider;
}

/** Prewarm a complete candidate before atomically replacing the active MCP provider. */
export async function replaceConfiguredMcpCapabilityProvider(
  runtime: KodaXExtensionRuntime,
  servers: McpServersConfig | undefined,
  options: McpProviderOptions = {},
): Promise<McpCapabilityProvider | undefined> {
  const provider = new McpCapabilityProvider(servers, options);
  if (!provider.hasActiveServers()) {
    await runtime.replaceCapabilityProvider('mcp', undefined);
    return undefined;
  }
  try {
    await provider.prewarm({ failOnError: true });
  } catch (error: unknown) {
    try {
      await provider.dispose();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'MCP replacement candidate failed preparation and cleanup.',
      );
    }
    throw error;
  }
  await runtime.replaceCapabilityProvider('mcp', provider, {
    source: {
      kind: 'runtime',
      id: 'runtime:capability:mcp',
      label: 'MCP Capability Provider',
    },
  });
  return provider;
}
