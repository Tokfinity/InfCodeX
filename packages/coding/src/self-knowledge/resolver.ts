/**
 * FEATURE_218 — deterministic resolver for the self-knowledge manual.
 * FEATURE_221 — extended to merge SDK-consumer-injected topics over the KodaX
 * base (override by id) and to re-brand the scope anchor with a product name.
 *
 * Matching order: exact topic id → alias contains → query token overlap →
 * unknown falls back to the index (never fabricates). Output is byte-capped
 * and prefixed with an anti-confusion scope anchor on every topic answer.
 */

import { MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';
import type {
  KodaXManualSource,
  KodaXManualTopicInput,
  ResolveKodaXManualInput,
  ResolveKodaXManualOptions,
  ResolveKodaXManualResult,
} from './types.js';

/** Hard caps — bounded output is a load-bearing requirement (no unbounded items). */
export const MANUAL_TOPIC_MAX_BYTES = 4096;
export const MANUAL_INDEX_MAX_BYTES = 2048;

const DEFAULT_PRODUCT_NAME = 'KodaX';

/** Common internal shape the matcher operates on (base + injected topics). */
interface ManualEntry {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly body: string;
  readonly sources: readonly KodaXManualSource[];
  readonly nextTopics: readonly string[];
}

function normalizeInjected(t: KodaXManualTopicInput): ManualEntry {
  return {
    id: t.id,
    title: t.title,
    aliases: t.aliases ?? [],
    summary: t.summary,
    body: t.body,
    sources: t.sources ?? [],
    nextTopics: t.nextTopics ?? [],
  };
}

/** Ordered base + injected entries; injected override base by id, then append. */
function buildEntries(extraTopics?: readonly KodaXManualTopicInput[]): {
  ids: string[];
  byId: Map<string, ManualEntry>;
} {
  const byId = new Map<string, ManualEntry>();
  const ids: string[] = [];
  for (const id of MANUAL_TOPIC_IDS) {
    byId.set(id, MANUAL_REGISTRY[id]);
    ids.push(id);
  }
  for (const t of extraTopics ?? []) {
    if (!byId.has(t.id)) ids.push(t.id);
    byId.set(t.id, normalizeInjected(t));
  }
  return { ids, byId };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n…(truncated; ask for a narrower topic)';
  const budget = maxBytes - byteLength(marker);
  let out = text;
  while (byteLength(out) > budget && out.length > 0) {
    out = out.slice(0, Math.max(0, out.length - 16));
  }
  return out + marker;
}

/** Anti-confusion anchor — this product, not Claude Code / Codex CLI. */
function scopeAnchor(topicId: string, productName: string): string {
  return (
    `(${productName} ${topicId} manual — about ${productName} itself, not Claude Code or Codex CLI. ` +
    `KodaX config lives in ~/.kodax/config.json + KODAX_* env vars.)`
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter((t) => t.length > 0);
}

function findByExactId(ids: readonly string[], byId: Map<string, ManualEntry>, value: string): ManualEntry | undefined {
  return ids.includes(value) ? byId.get(value) : undefined;
}

function findByAlias(ids: readonly string[], byId: Map<string, ManualEntry>, value: string): ManualEntry | undefined {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  for (const id of ids) {
    const topic = byId.get(id)!;
    if (topic.aliases.some((a) => a.toLowerCase() === needle)) return topic;
  }
  return undefined;
}

function scoreTopic(topic: ManualEntry, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize([topic.id, topic.title, topic.summary, ...topic.aliases].join(' ')));
  let hits = 0;
  for (const t of queryTokens) if (haystack.has(t)) hits += 1;
  return hits;
}

function rankByQuery(ids: readonly string[], byId: Map<string, ManualEntry>, query: string): ManualEntry[] {
  const queryTokens = tokenize(query);
  return ids
    .map((id) => byId.get(id)!)
    .map((topic) => ({ topic, score: scoreTopic(topic, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.topic);
}

function buildTopicResult(topic: ManualEntry, productName: string): ResolveKodaXManualResult {
  const content = truncateToBytes(`${scopeAnchor(topic.id, productName)}\n\n${topic.body}`, MANUAL_TOPIC_MAX_BYTES);
  return {
    matchedTopic: topic.id,
    title: topic.title,
    content,
    sources: topic.sources,
    nextTopics: topic.nextTopics,
  };
}

function buildIndexResult(
  ids: readonly string[],
  byId: Map<string, ManualEntry>,
  productName: string,
  suggested?: readonly ManualEntry[],
): ResolveKodaXManualResult {
  const lead =
    suggested && suggested.length > 0
      ? `No exact ${productName} manual topic matched. Closest topics:`
      : `${productName} manual topics (call kodax_manual with one of these as "topic"):`;
  const list = (suggested && suggested.length > 0 ? suggested : ids.map((id) => byId.get(id)!))
    .map((t) => `- ${t.id}: ${t.summary}`)
    .join('\n');
  const nextTopics = (suggested ?? []).slice(0, 3).map((t) => t.id);
  return {
    matchedTopic: 'index',
    title: `${productName} Manual — Index`,
    content: truncateToBytes(`${lead}\n\n${list}`, MANUAL_INDEX_MAX_BYTES),
    sources: [],
    nextTopics,
  };
}

export function resolveKodaXManual(
  input: ResolveKodaXManualInput,
  options?: ResolveKodaXManualOptions,
): ResolveKodaXManualResult {
  const productName = options?.productName?.trim() || DEFAULT_PRODUCT_NAME;
  const { ids, byId } = buildEntries(options?.extraTopics);

  const topicHint = input.topic?.trim();
  if (topicHint) {
    const exact = findByExactId(ids, byId, topicHint) ?? findByAlias(ids, byId, topicHint);
    if (exact) return buildTopicResult(exact, productName);
    return buildIndexResult(ids, byId, productName, rankByQuery(ids, byId, topicHint).slice(0, 3));
  }

  const query = input.query?.trim();
  if (query) {
    const ranked = rankByQuery(ids, byId, query);
    if (ranked.length > 0 && ranked[0]) return buildTopicResult(ranked[0], productName);
    return buildIndexResult(ids, byId, productName);
  }

  return buildIndexResult(ids, byId, productName);
}
