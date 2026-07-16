import { normalizeMcpCapabilityId } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';

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

function combineDistinctContent(content: unknown, structuredContent: unknown): string | undefined {
  const primary = stringifyValue(content);
  const structured = stringifyValue(structuredContent);
  if (!primary) return structured;
  if (!structured || structured === primary) return primary;
  return `${primary}\n\nStructured content:\n${structured}`;
}

function omitRepeatedMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key !== 'providerId' && key !== 'capabilityId'),
  );
}

export async function toolMcpCall(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_call requires an active extension runtime.');
    }

    const id = readOptionalString(input, 'id');
    if (!id) {
      throw new Error('id is required.');
    }
    const capabilityId = normalizeMcpCapabilityId(id);

    const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : {};

    const result = await ctx.extensionRuntime.executeCapability('mcp', capabilityId, args);
    return finalizeRetrievalResult({
      tool: 'mcp_call',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Executed MCP tool ${capabilityId}.`,
      content: combineDistinctContent(result.content, result.structuredContent),
      items: [],
      metadata: {
        capabilityKind: result.kind,
        ...omitRepeatedMetadata(result.metadata),
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_call: ${message}`;
  }
}
