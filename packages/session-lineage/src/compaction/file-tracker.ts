/**
 * @kodax-ai/agent File Tracking — artifactLedger extraction.
 *
 * FEATURE_185 (v0.7.42) extends the previous input-only extractor to also
 * read each tool_use's matching tool_result, enriching `metadata` with parsed
 * hits / matchedPaths / exitCode / tail. Pipeline:
 *
 *   Round end (REPL: repl.ts:1279/1371)
 *     → extractArtifactLedger(result.messages)
 *     → tool_result still raw (top-of-loop microcompact hasn't run on these)
 *     → buildArtifactEntry parses result content into metadata
 *     → mergeArtifactLedger commits enrichment to context.artifactLedger
 *     → storage.save persists the enriched ledger
 *
 *   Top-of-loop microcompact (run-substrate.ts:621, iteration N+1)
 *     → clears tool_result.content older than maxAge to `[Cleared: ...]`
 *
 *   Compaction time (compaction.ts:257)
 *     → extractArtifactLedger(toProcess) re-runs on cleared messages
 *     → buildArtifactEntry's parsers refuse `[Cleared: ...]` → no fresh hits
 *     → mergeArtifactLedger preserves the round-end enrichment via
 *       per-key non-empty preference (see `mergeLedgerMetadata`).
 *
 * The metadata-aware merge is the keystone — without it, every compaction
 * would silently downgrade ledger entries to input-only. End-to-end
 * preservation is exercised by the "end-to-end enrichment survives
 * microcompact" tests in file-tracker.test.ts.
 */

import { randomUUID } from 'node:crypto';
import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
} from '@kodax-ai/llm';
import type { FileOperations } from './types.js';
import type { KodaXJsonValue, KodaXSessionArtifactLedgerEntry } from '@kodax-ai/agent';
import { extractGrepHits, extractGlobPaths, extractBashResult } from './result-extractors.js';

const LEDGER_MAX_ENTRIES = 256;
const PATH_LIKE_KEYS = [
  'path',
  'file',
  'files',
  'outputPath',
  'cwd',
  'target_path',
  'scenePath',
  'scriptPath',
  'resourcePath',
  'module',
  'entry',
  'url',
] as const;

function isToolUseBlock(block: KodaXContentBlock): block is KodaXToolUseBlock {
  return block.type === 'tool_use';
}

function isToolResultBlock(block: KodaXContentBlock): block is KodaXToolResultBlock {
  return block.type === 'tool_result';
}

/**
 * FEATURE_185 (v0.7.42): pull the raw text out of a tool_result block.
 * Returns undefined when content isn't a usable string (placeholder strings
 * are kept and the parsers themselves reject them — see
 * `rejectPlaceholder` in `result-extractors.ts`).
 */
function readToolResultText(block: KodaXToolResultBlock): string | undefined {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part && typeof part === 'object' && 'type' in part && part.type === 'text'
        && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        textParts.push((part as { text: string }).text);
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : undefined;
  }
  return undefined;
}

function isImageBlock(
  block: KodaXContentBlock,
): block is Extract<KodaXContentBlock, { type: 'image' }> {
  return block.type === 'image';
}

function createLedgerId(): string {
  return `artifact_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFirstString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pickPathLikeTarget(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_LIKE_KEYS) {
    const value = readFirstString(input, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseCommandTarget(command: string): { action: string; target: string } {
  const normalized = compactWhitespace(command);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? 'command';
  const target = tokens.slice(1).find((token) => {
    if (!token || token.startsWith('-')) {
      return false;
    }
    if (token.includes('=') && !token.includes('/') && !token.includes('.')) {
      return false;
    }
    return true;
  }) ?? action;

  return { action, target };
}

function toLedgerMetadata(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, KodaXJsonValue> | undefined {
  const metadata: Record<string, KodaXJsonValue> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || (Array.isArray(value)
        && value.every((item) =>
          item === null
          || typeof item === 'string'
          || typeof item === 'number'
          || typeof item === 'boolean'))
    ) {
      metadata[key] = value as KodaXJsonValue;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function createLedgerEntry(
  kind: KodaXSessionArtifactLedgerEntry['kind'],
  sourceTool: string,
  action: string | undefined,
  target: string,
  summary: string,
  metadata?: Record<string, KodaXJsonValue>,
): KodaXSessionArtifactLedgerEntry {
  return {
    id: createLedgerId(),
    kind,
    sourceTool,
    action,
    target,
    displayTarget: target,
    summary,
    timestamp: new Date().toISOString(),
    metadata,
  };
}

function buildArtifactEntry(
  block: KodaXToolUseBlock,
  resultContent?: string,
): KodaXSessionArtifactLedgerEntry | null {
  const input = block.input as Record<string, unknown>;

  if (block.name === 'read') {
    const target = readString(input, 'path');
    return target
      ? createLedgerEntry('file_read', block.name, 'read', target, `Read ${target}`)
      : null;
  }

  if (block.name === 'write' || block.name === 'edit') {
    const target = readString(input, 'path');
    return target
      ? createLedgerEntry(
        'file_modified',
        block.name,
        block.name,
        target,
        `${block.name === 'write' ? 'Wrote' : 'Edited'} ${target}`,
      )
      : null;
  }

  if (block.name === 'glob') {
    const pattern = readString(input, 'pattern') ?? readString(input, 'glob');
    const scope = readString(input, 'path') ?? '.';
    if (!pattern) return null;
    const metadata = toLedgerMetadata(input, ['pattern']) ?? {};
    // FEATURE_185 (v0.7.42): result-side enrichment — survive compaction by
    // capturing matched paths in ledger metadata. The metadata Record persists
    // past microcompact (which only clears tool_result.content) so the model
    // can still see "what glob matched" after the raw output is replaced
    // with `[Cleared: glob ...]`.
    const extracted = resultContent !== undefined ? extractGlobPaths(resultContent) : undefined;
    if (extracted) {
      metadata.matchedPaths = [...extracted.paths] as KodaXJsonValue;
      if (extracted.truncated) metadata.truncated = true;
    }
    return createLedgerEntry(
      'path_scope',
      block.name,
      'glob',
      scope,
      `Glob ${pattern} in ${scope}`,
      Object.keys(metadata).length > 0 ? metadata : undefined,
    );
  }

  if (block.name === 'grep' || block.name === 'code_search' || block.name === 'web_search') {
    const query = readString(input, 'pattern') ?? readString(input, 'query');
    const scope = readString(input, 'path') ?? readString(input, 'provider') ?? 'default';
    if (!query) return null;
    const metadata = toLedgerMetadata(input, ['path', 'provider', 'provider_id']) ?? {};
    // FEATURE_185 (v0.7.42): result-side enrichment. Same rationale as glob —
    // path:line + 80-char preview survives compaction in ledger metadata so
    // the model can recall "grep found auth.ts:42 / login.ts:56" without
    // re-running the search. Skipped for web_search (different result shape).
    if (block.name !== 'web_search' && resultContent !== undefined) {
      const extracted = extractGrepHits(resultContent);
      if (extracted) {
        if (extracted.hits.length > 0) {
          metadata.hits = extracted.hits.map((h) => ({
            path: h.path,
            line: h.line,
            preview: h.preview,
          })) as KodaXJsonValue;
        }
        if (extracted.matchCount !== undefined) metadata.matchCount = extracted.matchCount;
        if (extracted.truncated) metadata.truncated = true;
        if (extracted.resultMode !== 'unknown') metadata.resultMode = extracted.resultMode;
      }
    }
    return createLedgerEntry(
      'search_scope',
      block.name,
      block.name,
      query,
      `${block.name} ${query} (${scope})`,
      Object.keys(metadata).length > 0 ? metadata : undefined,
    );
  }

  if (block.name === 'semantic_lookup') {
    const query = readString(input, 'query') ?? readString(input, 'symbol');
    const scope = readString(input, 'module') ?? readString(input, 'target_path') ?? 'workspace';
    return query
      ? createLedgerEntry(
        'search_scope',
        block.name,
        'semantic_lookup',
        query,
        `Semantic lookup ${query} (${scope})`,
        toLedgerMetadata(input, ['module', 'target_path']),
      )
      : null;
  }

  if (block.name === 'web_fetch') {
    const url = readString(input, 'url');
    return url
      ? createLedgerEntry(
        'path_scope',
        block.name,
        'fetch',
        url,
        `Fetched ${url}`,
        toLedgerMetadata(input, ['format', 'provider_id', 'capability_id']),
      )
      : null;
  }

  if (block.name === 'bash') {
    const command = readString(input, 'command');
    if (!command) {
      return null;
    }
    const parsed = parseCommandTarget(command);
    const metadata = toLedgerMetadata(input, ['timeout']) ?? {};
    // FEATURE_185 (v0.7.42): result-side enrichment for bash. Capture
    // exit_code + tail so the model can recall "npm test exited 1 with
    // FAIL auth.test.ts" without re-running. Cancellation / timeout
    // flags surface as boolean metadata so render-time can disambiguate
    // "didn't run yet" from "ran but was killed".
    if (resultContent !== undefined) {
      const extracted = extractBashResult(resultContent);
      if (extracted) {
        if (extracted.exitCode !== undefined) {
          metadata.exitCode = extracted.exitCode as KodaXJsonValue;
        }
        if (extracted.tail !== undefined && extracted.tail.length > 0) {
          metadata.tail = extracted.tail;
        }
        if (extracted.cancelled) metadata.cancelled = true;
        // FEATURE_185 (v0.7.42): use `timedOut` not `timeout` to avoid
        // colliding with the existing input-side `timeout` field (which
        // holds the configured timeout-in-seconds; collision would either
        // erase the configured value or surface a numeric flag).
        if (extracted.timeout) metadata.timedOut = true;
        if (extracted.captureCapped) metadata.captureCapped = true;
      }
    }
    return createLedgerEntry(
      'command_scope',
      block.name,
      parsed.action,
      parsed.target,
      `Ran ${parsed.action} on ${parsed.target}`,
      Object.keys(metadata).length > 0 ? metadata : undefined,
    );
  }

  const target = pickPathLikeTarget(input);
  if (!target) {
    return null;
  }

  return createLedgerEntry(
    'path_scope',
    block.name,
    block.name,
    target,
    `${block.name} ${target}`,
  );
}

function buildImageArtifactEntry(
  block: Extract<KodaXContentBlock, { type: 'image' }>,
): KodaXSessionArtifactLedgerEntry {
  return createLedgerEntry(
    'image_input',
    'user-input',
    'attach',
    block.path,
    `Attached image ${block.path}`,
    block.mediaType ? { mediaType: block.mediaType } : undefined,
  );
}

function ledgerDedupKey(entry: KodaXSessionArtifactLedgerEntry): string {
  return [
    entry.kind,
    entry.sourceTool ?? '',
    entry.action ?? '',
    entry.target,
  ].join('::');
}

export function extractFileOps(messages: KodaXMessage[]): FileOperations {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (!isToolUseBlock(block)) {
        continue;
      }

      const input = block.input as Record<string, unknown>;
      if (block.name === 'read' && typeof input.path === 'string') {
        readFiles.add(input.path);
      } else if ((block.name === 'write' || block.name === 'edit') && typeof input.path === 'string') {
        modifiedFiles.add(input.path);
      }
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
  };
}

export function mergeFileOps(
  ops1: FileOperations,
  ops2: FileOperations,
): FileOperations {
  return {
    readFiles: [...new Set([...ops1.readFiles, ...ops2.readFiles])],
    modifiedFiles: [...new Set([...ops1.modifiedFiles, ...ops2.modifiedFiles])],
  };
}

export function extractArtifactLedger(
  messages: KodaXMessage[],
): KodaXSessionArtifactLedgerEntry[] {
  // FEATURE_185 (v0.7.42): pre-pass — build a tool_use_id → tool_result content
  // map so `buildArtifactEntry` can enrich search/glob entries with parsed
  // hits/paths from the corresponding tool_result block. The map is built in
  // a single scan; cost is linear in total block count.
  const toolResultsById = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolResultBlock(block)) continue;
      const text = readToolResultText(block);
      if (text !== undefined) {
        toolResultsById.set(block.tool_use_id, text);
      }
    }
  }

  const entries: KodaXSessionArtifactLedgerEntry[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (isImageBlock(block) && msg.role === 'user') {
        entries.push(buildImageArtifactEntry(block));
        continue;
      }

      if (!isToolUseBlock(block)) {
        continue;
      }

      const resultContent = toolResultsById.get(block.id);
      const entry = buildArtifactEntry(block, resultContent);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return mergeArtifactLedger([], entries);
}

export function mergeArtifactLedger(
  existing: KodaXSessionArtifactLedgerEntry[],
  next: KodaXSessionArtifactLedgerEntry[],
): KodaXSessionArtifactLedgerEntry[] {
  const merged = new Map<string, KodaXSessionArtifactLedgerEntry>();

  for (const entry of [...existing, ...next]) {
    const key = ledgerDedupKey(entry);
    const prior = merged.get(key);
    merged.set(key, {
      ...entry,
      // FEATURE_185 (v0.7.42): preserve enrichment across re-extractions.
      // When the same tool call is re-extracted later (e.g. compaction time
      // after microcompact replaced the tool_result with `[Cleared: ...]`),
      // the new entry's metadata lacks `hits`/`matchedPaths` because the
      // parser correctly refuses placeholder content. Without this merge,
      // the new (poor) metadata would overwrite the earlier (rich) entry
      // and the enrichment would be lost — defeating the whole point.
      metadata: mergeLedgerMetadata(prior?.metadata, entry.metadata),
    });
  }

  return Array.from(merged.values()).slice(-LEDGER_MAX_ENTRIES);
}

/**
 * FEATURE_185 (v0.7.42): metadata-aware merge.
 *
 * Strategy: take the union of keys; for each key, prefer the *non-empty* value
 * from either side, with the new entry winning on ties. "Non-empty" here means:
 * defined, non-null, and (for arrays) length > 0.
 *
 * This lets an early extraction (when raw tool_result was still inline) seed
 * `hits` / `matchedPaths` / `tail` / `exit_code` into the ledger, and a later
 * re-extraction (when the result has been cleared) keeps them rather than
 * stomping with undefined.
 */
function mergeLedgerMetadata(
  prior: Record<string, KodaXJsonValue> | undefined,
  next: Record<string, KodaXJsonValue> | undefined,
): Record<string, KodaXJsonValue> | undefined {
  if (!prior && !next) return undefined;
  if (!prior) return next ? { ...next } : undefined;
  if (!next) return { ...prior };

  const out: Record<string, KodaXJsonValue> = { ...prior };
  for (const [k, v] of Object.entries(next)) {
    if (isNonEmptyMetadataValue(v)) {
      out[k] = v;
    } else if (!(k in out)) {
      // New key but empty value — still record so callers see the key exists.
      out[k] = v;
    }
    // else: next value is empty AND prior has a (possibly rich) value → keep prior.
  }
  return out;
}

function isNonEmptyMetadataValue(v: KodaXJsonValue): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}
