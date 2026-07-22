import { createHash } from 'node:crypto';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type {
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '../types.js';
import { COMPACTION_SUMMARY_PREFIX } from './compaction/compaction.js';
import { getSessionLineagePath } from './kodax-session-lineage.js';

export type KodaXSessionHistoryScope = 'compacted' | 'all';
export type KodaXSessionHistorySource = 'user' | 'assistant' | 'system' | 'tool' | 'child_task';

export interface KodaXSessionHistorySearchOptions {
  query: string;
  limit?: number;
  role?: KodaXMessage['role'];
  scope?: KodaXSessionHistoryScope;
}

export interface KodaXSessionHistoryHit {
  entryId: string;
  logicalId?: string;
  sourceEntryId?: string;
  timestamp: string;
  role: KodaXMessage['role'];
  source: KodaXSessionHistorySource;
  active: boolean;
  score: number;
  snippet: string;
  citation: string;
}

export interface KodaXSessionHistorySearchResult {
  revision: string;
  hits: KodaXSessionHistoryHit[];
}

export interface KodaXSessionHistoryReadOptions {
  entryId: string;
  revision?: string;
  offset?: number;
  maxChars?: number;
}

export type KodaXSessionHistoryReadResult =
  | { status: 'not_found'; revision: string; entryId: string }
  | { status: 'stale'; revision: string; entryId: string }
  | {
    status: 'ok';
    revision: string;
    entryId: string;
    content: string;
    offset: number;
    nextOffset: number | null;
    totalChars: number;
    redactedBlockCount: number;
    citation: string;
  };

interface VisibleMessage {
  text: string;
  redactedBlockCount: number;
  source: KodaXSessionHistorySource;
}

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_CHARS = 6_000;
const MAX_READ_CHARS = 12_000;
const SNIPPET_CHARS = 320;
const LEGACY_COMPACTION_SUMMARY_MARKER = COMPACTION_SUMMARY_PREFIX.trimEnd();
const MIN_METADATA_QUERY_LENGTH = 8;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function visibleToolResult(block: Extract<KodaXContentBlock, { type: 'tool_result' }>): string {
  if (typeof block.content === 'string') return block.content;
  return block.content
    .map((item) => item.type === 'text' ? item.text : `[image: ${item.path}]`)
    .join('\n');
}

function visibleMessage(message: KodaXMessage): VisibleMessage {
  if (typeof message.content === 'string') {
    return {
      text: message.content,
      redactedBlockCount: 0,
      source: message._taskResult || message._taskResults ? 'child_task' : message.role,
    };
  }

  const parts: string[] = [];
  let redactedBlockCount = 0;
  let hasToolEvidence = false;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'tool_use':
        hasToolEvidence = true;
        parts.push(`[tool_use ${block.name}] ${JSON.stringify(block.input)}`);
        break;
      case 'tool_result':
        hasToolEvidence = true;
        parts.push(`[tool_result ${block.tool_use_id}] ${visibleToolResult(block)}`);
        break;
      case 'image':
        parts.push(`[image: ${block.path}]`);
        break;
      case 'thinking':
      case 'redacted_thinking':
        redactedBlockCount += 1;
        break;
      case 'cache-boundary':
        break;
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  }
  return {
    text: parts.join('\n'),
    redactedBlockCount,
    source: message._taskResult || message._taskResults
      ? 'child_task'
      : hasToolEvidence ? 'tool' : message.role,
  };
}

function historyRevision(lineage: KodaXSessionLineage): string {
  const hash = createHash('sha256');
  hash.update(lineage.activeEntryId ?? '');
  for (const entry of lineage.entries) {
    hash.update('\0');
    hash.update(JSON.stringify(entry));
  }
  return `sha256:${hash.digest('hex')}`;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function lexicalTerms(value: string): string[] {
  const terms = normalized(value).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(terms.filter((term) => term.length > 1))];
}

function scoreText(
  text: string,
  metadata: string,
  query: string,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
): number {
  const haystack = normalized(text);
  const normalizedMetadata = normalized(metadata);
  const needle = normalized(query).trim();
  if (!needle) return 0;
  let score = haystack.includes(needle) ? 1_000 + Math.min(needle.length, 200) : 0;
  if (needle.length >= MIN_METADATA_QUERY_LENGTH && normalizedMetadata.includes(needle)) {
    score += 1_500 + Math.min(needle.length, 200);
  }
  let matchedTerms = 0;
  for (const term of queryTerms) {
    const inText = haystack.includes(term);
    if (!inText) continue;
    matchedTerms += 1;
    const frequency = documentFrequency.get(term) ?? documentCount;
    const inverseFrequency = Math.log((documentCount + 1) / (frequency + 1)) + 1;
    score += Math.round((20 + Math.min(term.length, 20)) * inverseFrequency);
  }
  if (queryTerms.length > 0) score += Math.round((matchedTerms / queryTerms.length) * 100);
  return score;
}

function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET_CHARS) return text;
  const index = normalized(text).indexOf(normalized(query).trim());
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function activeEntryIds(lineage: KodaXSessionLineage): Set<string> {
  return new Set(getSessionLineagePath(lineage).map((entry) => entry.id));
}

function isSyntheticCheckpoint(message: KodaXMessage): boolean {
  if (message._source === 'compaction-checkpoint') return true;
  return typeof message.content === 'string'
    && message.content.trimStart().startsWith(LEGACY_COMPACTION_SUMMARY_MARKER);
}

function isCompactedPlaceholder(message: KodaXMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim() === '[compacted]';
  return message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text.trim() === '[compacted]';
}

function historyEvidence(message: KodaXMessage): VisibleMessage | null {
  if (message.role === 'system' || isSyntheticCheckpoint(message) || isCompactedPlaceholder(message)) {
    return null;
  }
  const visible = visibleMessage(message);
  return visible.text.trim().length > 0 ? visible : null;
}

export function searchSessionHistory(
  lineage: KodaXSessionLineage,
  options: KodaXSessionHistorySearchOptions,
): KodaXSessionHistorySearchResult {
  const revision = historyRevision(lineage);
  const query = options.query.trim();
  if (!query) return { revision, hits: [] };

  const activeIds = activeEntryIds(lineage);
  const entryOrder = new Map(lineage.entries.map((entry, index) => [entry.id, index]));
  const scope = options.scope ?? 'compacted';
  const queryTerms = lexicalTerms(query);
  const candidates = lineage.entries.flatMap((entry) => {
    if (entry.type !== 'message') return [];
    // Historical recovery is an evidence plane for user, assistant, tool, and
    // child-task content. Host instructions and synthetic checkpoints are
    // intentionally excluded so they cannot crowd out or disclose evidence.
    const visible = historyEvidence(entry.message);
    if (!visible) return [];
    const active = activeIds.has(entry.id);
    if (scope === 'compacted' && active) return [];
    if (options.role && entry.message.role !== options.role) return [];
    return [{
      entry,
      active,
      visible,
      metadata: [entry.id, entry.logicalId, entry.sourceEntryId].filter(Boolean).join(' '),
    }];
  });
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    const count = candidates.reduce(
      (total, candidate) => total + (normalized(candidate.visible.text).includes(term) ? 1 : 0),
      0,
    );
    documentFrequency.set(term, count);
  }
  const hits: KodaXSessionHistoryHit[] = [];
  for (const { entry, active, visible, metadata } of candidates) {
    const score = scoreText(
      visible.text,
      metadata,
      query,
      queryTerms,
      documentFrequency,
      candidates.length,
    );
    if (score <= 0) continue;
    hits.push({
      entryId: entry.id,
      logicalId: entry.logicalId,
      sourceEntryId: entry.sourceEntryId,
      timestamp: entry.timestamp,
      role: entry.message.role,
      source: visible.source,
      active,
      score,
      snippet: snippet(visible.text, query),
      citation: `session-history:${entry.id}`,
    });
  }

  hits.sort((left, right) => right.score - left.score
    || right.timestamp.localeCompare(left.timestamp)
    || (entryOrder.get(right.entryId) ?? 0) - (entryOrder.get(left.entryId) ?? 0)
    || left.entryId.localeCompare(right.entryId));
  return {
    revision,
    hits: hits.slice(0, boundedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)),
  };
}

export function readSessionHistoryEntry(
  lineage: KodaXSessionLineage,
  options: KodaXSessionHistoryReadOptions,
): KodaXSessionHistoryReadResult {
  const revision = historyRevision(lineage);
  if (options.revision && options.revision !== revision) {
    return { status: 'stale', revision, entryId: options.entryId };
  }
  const entry = lineage.entries.find(
    (candidate): candidate is KodaXSessionMessageEntry =>
      candidate.type === 'message' && candidate.id === options.entryId,
  );
  if (!entry) return { status: 'not_found', revision, entryId: options.entryId };

  const visible = historyEvidence(entry.message);
  if (!visible) return { status: 'not_found', revision, entryId: options.entryId };
  const offset = boundedInteger(options.offset, 0, 0, visible.text.length);
  const maxChars = boundedInteger(options.maxChars, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
  const end = Math.min(visible.text.length, offset + maxChars);
  return {
    status: 'ok',
    revision,
    entryId: entry.id,
    content: visible.text.slice(offset, end),
    offset,
    nextOffset: end < visible.text.length ? end : null,
    totalChars: visible.text.length,
    redactedBlockCount: visible.redactedBlockCount,
    citation: `session-history:${entry.id}`,
  };
}
