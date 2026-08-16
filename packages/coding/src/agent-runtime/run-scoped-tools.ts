/**
 * Run-scoped tool materialization — Host Tools first-class visibility.
 *
 * A run-bound capability source (e.g. a daemon Host Tool lease) exposes its
 * tools through `ExtensionRuntimeContract.listRunTools`. These helpers bridge
 * those definitions into the existing tool surface WITHOUT the process-global
 * TOOL_REGISTRY, so concurrent runs with different leases never shadow each
 * other:
 *
 *   - tool-table assembly appends run-scoped names plus their model
 *     definitions (schema materialization);
 *   - `applyToolVisibilityPolicy` and the registry metadata predicates accept
 *     a run-scoped definition map as a fallback resolver, keeping fail-closed
 *     semantics for names resolvable nowhere;
 *   - dispatch routes a run-scoped tool call to
 *     `executeCapability('mcp', capabilityId)`, reusing the reverse bridge's
 *     timeout/idempotency/invocation state machine; results render through the
 *     same retrieval pipeline as `mcp_call`.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  ExtensionRuntimeContract,
  RunScopedToolDefinition,
} from '../extensions/runtime-contract.js';
import { finalizeRetrievalResult } from '../tools/retrieval.js';
import type { KodaXToolExecutionContext } from '../types.js';

export function listRunScopedTools(
  runtime: ExtensionRuntimeContract | null | undefined,
  providerId = 'mcp',
): readonly RunScopedToolDefinition[] {
  return runtime?.listRunTools?.(providerId) ?? [];
}

export function runScopedToolMap(
  definitions: readonly RunScopedToolDefinition[],
): ReadonlyMap<string, RunScopedToolDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export function lookupRunScopedTool(
  runtime: ExtensionRuntimeContract | null | undefined,
  name: string,
  providerId = 'mcp',
): RunScopedToolDefinition | undefined {
  return listRunScopedTools(runtime, providerId).find((definition) => definition.name === name);
}

export function toModelToolDefinition(definition: RunScopedToolDefinition): KodaXToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema as KodaXToolDefinition['input_schema'],
  };
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function combineDistinctContent(
  content: unknown,
  structuredContent: unknown,
): string | undefined {
  const primary = stringifyValue(content);
  const structured = stringifyValue(structuredContent);
  if (!primary) return structured;
  if (!structured || structured === primary) return primary;
  return `${primary}\n\nStructured content:\n${structured}`;
}

export async function executeRunScopedTool(
  ctx: KodaXToolExecutionContext,
  definition: RunScopedToolDefinition,
  input: Record<string, unknown>,
): Promise<string> {
  if (!ctx.extensionRuntime) {
    return `[Tool Error] ${definition.name}: Tool is not active in the current runtime.`;
  }
  try {
    const result = await ctx.extensionRuntime.executeCapability(
      'mcp',
      definition.capabilityId,
      input,
    );
    return await finalizeRetrievalResult({
      tool: 'mcp_call',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Executed MCP tool ${definition.capabilityId}.`,
      content: combineDistinctContent(result.content, result.structuredContent),
      items: [],
      metadata: { capabilityKind: result.kind },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] ${definition.name}: ${message}`;
  }
}
