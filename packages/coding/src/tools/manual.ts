/**
 * FEATURE_218 — `kodax_manual` read-only tool.
 *
 * Thin wrapper over the deterministic self-knowledge resolver. Read-only:
 * never reads user secrets, never writes files, never runs shell. For
 * "what is my current value" questions it points at the path to check rather
 * than reading it (that stays with the file tools + permission boundary).
 */

import type { KodaXToolExecutionContext } from '../types.js';
import { resolveKodaXManual } from '../self-knowledge/resolver.js';

export async function toolKodaxManual(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const topic = typeof input.topic === 'string' ? input.topic : undefined;
  const query = typeof input.query === 'string' ? input.query : undefined;

  // FEATURE_221: merge any SDK-consumer-injected topics + product re-brand +
  // base-topic seed control (curate / full-replace).
  const result = resolveKodaXManual(
    { topic, query },
    {
      extraTopics: ctx.selfManual?.topics,
      productName: ctx.selfManual?.productName,
      baseTopics: ctx.selfManual?.baseTopics,
    },
  );

  const parts: string[] = [`# ${result.title}`, '', result.content];
  if (result.sources.length > 0) {
    parts.push('', `Sources: ${result.sources.map((s) => s.path).join(', ')}`);
  }
  if (result.nextTopics.length > 0) {
    parts.push(`Related topics (pass as "topic"): ${result.nextTopics.join(', ')}`);
  }
  return parts.join('\n');
}
