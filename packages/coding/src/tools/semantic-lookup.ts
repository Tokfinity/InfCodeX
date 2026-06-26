import {
  readRepoIntelligenceToolWaitMs,
  semanticLookup,
} from '../repo-intelligence/runtime.js';
import type { SemanticLookupKind } from '../repo-intelligence/semantic-lookup-query.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

export async function toolSemanticLookup(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const rawKind = readOptionalString(input, 'kind') ?? 'auto';
    const kind = ['auto', 'symbol', 'module', 'process'].includes(rawKind)
      ? rawKind as SemanticLookupKind
      : 'auto';
    const limit = clampLimit(input.limit);
    const result = await semanticLookup(ctx, {
      query,
      kind,
      limit,
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
      maxWaitMs: readRepoIntelligenceToolWaitMs(),
    });
    const isWarming = result.capability?.status === 'warming';

    return finalizeRetrievalResult({
      tool: 'semantic_lookup',
      query,
      scope: 'workspace',
      trust: 'workspace',
      freshness: 'snapshot',
      summary: isWarming
        ? 'Repository intelligence index is still warming; retry semantic_lookup shortly for full structural matches. Use read, grep, glob, and LSP tools for immediate exploration.'
        : result.items.length > 0
        ? `Found ${result.items.length} semantic match(es) for "${query}" in repository intelligence.`
        : `No semantic matches for "${query}" in repository intelligence.`,
      items: result.items,
      artifacts: result.artifacts,
      metadata: {
        kind,
        generatedAt: result.generatedAt,
        sourceFileCount: result.sourceFileCount,
        capability: result.capabilityEngine ?? 'light',
        capabilityStatus: result.capability?.status,
        warnings: result.capability?.warnings.join(' | '),
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] semantic_lookup: ${message}`;
  }
}
