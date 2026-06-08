/**
 * FEATURE_218 — deterministic resolver for the self-knowledge manual.
 *
 * Matching order: exact topic id → alias contains → query token overlap →
 * unknown falls back to the index (never fabricates). Output is byte-capped
 * and prefixed with an anti-confusion scope anchor (KodaX vs Claude Code /
 * Codex CLI) on every topic answer.
 */

import { MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';
import type {
  KodaXManualTopic,
  KodaXManualTopicId,
  ResolveKodaXManualInput,
  ResolveKodaXManualResult,
} from './types.js';

/** Hard caps — bounded output is a load-bearing requirement (no unbounded items). */
export const MANUAL_TOPIC_MAX_BYTES = 4096;
export const MANUAL_INDEX_MAX_BYTES = 2048;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n…(truncated; ask for a narrower topic)';
  const budget = maxBytes - byteLength(marker);
  // Trim by characters until under budget (UTF-8 safe enough for prose).
  let out = text;
  while (byteLength(out) > budget && out.length > 0) {
    out = out.slice(0, Math.max(0, out.length - 16));
  }
  return out + marker;
}

/** Anti-confusion anchor — KodaX product, not Claude Code / Codex CLI. */
function scopeAnchor(topicId: KodaXManualTopicId): string {
  return (
    `(KodaX ${topicId} manual — about KodaX itself, not Claude Code or Codex CLI. ` +
    `KodaX config lives in ~/.kodax/config.json + KODAX_* env vars.)`
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter((t) => t.length > 0);
}

function findByExactId(value: string): KodaXManualTopic | undefined {
  return (MANUAL_TOPIC_IDS as readonly string[]).includes(value)
    ? MANUAL_REGISTRY[value as KodaXManualTopicId]
    : undefined;
}

function findByAlias(value: string): KodaXManualTopic | undefined {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  for (const id of MANUAL_TOPIC_IDS) {
    const topic = MANUAL_REGISTRY[id];
    if (topic.aliases.some((a) => a.toLowerCase() === needle)) return topic;
  }
  return undefined;
}

/** Simple token-overlap score; no embeddings. Returns 0 when nothing overlaps. */
function scoreTopic(topic: KodaXManualTopic, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(
    tokenize([topic.id, topic.title, topic.summary, ...topic.aliases].join(' ')),
  );
  let hits = 0;
  for (const t of queryTokens) if (haystack.has(t)) hits += 1;
  return hits;
}

function rankByQuery(query: string): KodaXManualTopic[] {
  const queryTokens = tokenize(query);
  return MANUAL_TOPIC_IDS.map((id) => MANUAL_REGISTRY[id])
    .map((topic) => ({ topic, score: scoreTopic(topic, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.topic);
}

function buildTopicResult(topic: KodaXManualTopic): ResolveKodaXManualResult {
  const content = truncateToBytes(
    `${scopeAnchor(topic.id)}\n\n${topic.body}`,
    MANUAL_TOPIC_MAX_BYTES,
  );
  return {
    matchedTopic: topic.id,
    title: topic.title,
    content,
    sources: topic.sources,
    nextTopics: topic.nextTopics,
  };
}

function buildIndexResult(suggested?: readonly KodaXManualTopic[]): ResolveKodaXManualResult {
  const lead =
    suggested && suggested.length > 0
      ? `No exact KodaX manual topic matched. Closest topics:`
      : `KodaX manual topics (call kodax_manual with one of these as "topic"):`;
  const list = (suggested && suggested.length > 0 ? suggested : MANUAL_TOPIC_IDS.map((id) => MANUAL_REGISTRY[id]))
    .map((t) => `- ${t.id}: ${t.summary}`)
    .join('\n');
  const nextTopics = (suggested ?? []).slice(0, 3).map((t) => t.id);
  return {
    matchedTopic: 'index',
    title: 'KodaX Manual — Index',
    content: truncateToBytes(`${lead}\n\n${list}`, MANUAL_INDEX_MAX_BYTES),
    sources: [],
    nextTopics,
  };
}

export function resolveKodaXManual(input: ResolveKodaXManualInput): ResolveKodaXManualResult {
  const topicHint = input.topic?.trim();
  if (topicHint) {
    const exact = findByExactId(topicHint) ?? findByAlias(topicHint);
    if (exact) return buildTopicResult(exact);
    // Topic hint given but unknown → index with closest-by-token suggestions.
    return buildIndexResult(rankByQuery(topicHint).slice(0, 3));
  }

  const query = input.query?.trim();
  if (query) {
    const ranked = rankByQuery(query);
    if (ranked.length > 0 && ranked[0]) return buildTopicResult(ranked[0]);
    return buildIndexResult();
  }

  // No topic, no query → full index.
  return buildIndexResult();
}
