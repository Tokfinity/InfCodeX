/**
 * FEATURE_185 (v0.7.42): Tool-result-side extractors.
 *
 * Existing `file-tracker.ts:buildArtifactEntry` only reads `tool_use.input`
 * — it captures query/scope but not the *result content* (where the actual
 * hits live). After microcompact / pruneToolResults replaces the tool_result
 * with `[Cleared: grep ...]`, the model can no longer see which path:line
 * matched, forcing it to re-grep — exactly what we want to avoid.
 *
 * This module supplies pure parsers for grep / code_search / glob results
 * that survive into ledger metadata. Ledger metadata is preserved across
 * microcompact / prune cycles (the placeholders only replace
 * tool_result.content, not the artifactLedger).
 *
 * Design constraints:
 *  - Pure functions, no I/O, no side effects.
 *  - Tolerant: unknown shapes → `undefined` (don't throw).
 *  - Placeholder-aware: result starting with `[Cleared:` / `[Pruned:` /
 *    `[Tool Error]` → `undefined` (no hits to extract).
 *  - Bounded: each entry caps hits at `MAX_HITS_PER_ENTRY` (50) so a single
 *    runaway grep can't consume the entire ledger budget; render-time budget
 *    caps further.
 */

/** Single hit captured from a search-tool result. */
export interface SearchHit {
  /** File path (absolute or repo-relative, as the tool emitted it). */
  readonly path: string;
  /** Line number (1-indexed). */
  readonly line: number;
  /** Matched-line preview, truncated to {@link HIT_PREVIEW_MAX_CHARS}. */
  readonly preview: string;
}

/** Parsed shape of a grep / code_search result string. */
export interface SearchResultExtraction {
  readonly hits: readonly SearchHit[];
  /** count-mode: `${N} matches` — populated when content has no hits but tool ran. */
  readonly matchCount?: number;
  /** True when the source result was truncated (saw the `[Grep output truncated:` tail). */
  readonly truncated?: boolean;
  /** Output mode inferred from the result shape. */
  readonly resultMode: 'content' | 'files_with_matches' | 'count' | 'empty' | 'unknown';
}

/** Parsed shape of a glob result string. */
export interface GlobResultExtraction {
  readonly paths: readonly string[];
  readonly truncated?: boolean;
}

/** Per-entry cap so a runaway search can't dominate the ledger budget. */
export const MAX_HITS_PER_ENTRY = 50;

/** Per-hit preview cap. */
export const HIT_PREVIEW_MAX_CHARS = 80;

/** Per-entry cap for glob paths. */
export const MAX_GLOB_PATHS_PER_ENTRY = 80;

const PLACEHOLDER_PREFIXES = ['[Cleared:', '[Pruned:', '[Tool Error]'];
const TRUNCATION_MARKER = '[Grep output truncated:';

/**
 * Internal: skip results that were already replaced with a placeholder
 * (microcompact / prune) or are tool errors. Returns null if the content
 * is unparseable for hit extraction.
 */
function rejectPlaceholder(rawResult: unknown): string | null {
  if (typeof rawResult !== 'string') return null;
  const trimmed = rawResult.trimStart();
  if (trimmed.length === 0) return null;
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null;
  }
  return rawResult;
}

/**
 * Parse a `grep` / `code_search` tool result into structured hits.
 *
 * Recognised shapes (from `packages/coding/src/tools/grep.ts`):
 *  - content mode:           `{path}:{line}: {text}` (or `{path}-{line}- {text}` for context lines)
 *  - files_with_matches:     one path per line, no `:line:` separator
 *  - count mode:             `${N} matches`
 *  - empty:                  `No matches for "..."` / `No matches for "..." in the requested range...`
 *
 * @returns `undefined` if the result is a placeholder / tool error /
 *          unrecognised shape; `SearchResultExtraction` otherwise.
 */
export function extractGrepHits(rawResult: unknown): SearchResultExtraction | undefined {
  const content = rejectPlaceholder(rawResult);
  if (content === null) return undefined;

  // count mode: `${N} matches`
  const countMatch = /^(\d+)\s+matches\s*$/m.exec(content);
  if (countMatch && !content.includes(':') && !content.includes('No matches')) {
    return {
      hits: [],
      matchCount: parseInt(countMatch[1]!, 10),
      resultMode: 'count',
    };
  }

  // no-matches
  if (/^No matches for /.test(content)) {
    return { hits: [], resultMode: 'empty' };
  }

  // Strip the truncation footer block (if present) before parsing lines.
  let body = content;
  let truncated = false;
  const truncationIdx = body.indexOf(TRUNCATION_MARKER);
  if (truncationIdx >= 0) {
    truncated = true;
    body = body.slice(0, truncationIdx).trimEnd();
  }

  const lines = body.split('\n');
  const hits: SearchHit[] = [];
  let sawPathColonLine = false;

  for (const line of lines) {
    if (hits.length >= MAX_HITS_PER_ENTRY) break;
    if (line.length === 0) continue;
    const parsed = parseGrepLine(line);
    if (parsed) {
      sawPathColonLine = true;
      hits.push(parsed);
    }
  }

  if (hits.length > 0) {
    return { hits, resultMode: 'content', truncated };
  }

  // No `path:line:` rows — could be files_with_matches mode (path per line) or unknown.
  if (!sawPathColonLine) {
    const paths = lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('['))
      .filter(looksLikePath);

    if (paths.length > 0) {
      // Treat as files_with_matches: store as hits with line=0 sentinel.
      const sliced = paths.slice(0, MAX_HITS_PER_ENTRY);
      return {
        hits: sliced.map((p) => ({ path: p, line: 0, preview: '' })),
        resultMode: 'files_with_matches',
        truncated,
      };
    }
  }

  return { hits: [], resultMode: 'unknown', truncated };
}

/**
 * Parse a single grep content-mode line: `{path}:{line}: {text}`.
 * Returns `null` if the line doesn't match the expected shape.
 *
 * Windows paths contain `:` (e.g. `C:\foo:42: text`), so the regex uses
 * lazy `.+?` then anchors on `:(\d+):` — the regex engine's backtracking
 * extends `.+?` until the digits+separator stick. Linux paths have no
 * embedded `:` so the same regex works for both.
 *
 * Context-mode lines use `-` instead of `:` as the separator and are
 * also captured (the line is still informative even if it's not the
 * exact match line — but we mark them by parsing both).
 */
function parseGrepLine(line: string): SearchHit | null {
  // Try `:` separator (match line) first.
  let m = /^(.+?):(\d+):\s?(.*)$/.exec(line);
  if (!m) {
    // Try `-` separator (context line).
    m = /^(.+?)-(\d+)-\s?(.*)$/.exec(line);
  }
  if (!m) return null;
  const path = m[1]!;
  const lineNum = parseInt(m[2]!, 10);
  const preview = truncatePreview(m[3] ?? '');
  if (!Number.isFinite(lineNum) || lineNum <= 0) return null;
  return { path, line: lineNum, preview };
}

function truncatePreview(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= HIT_PREVIEW_MAX_CHARS) return trimmed;
  return trimmed.slice(0, HIT_PREVIEW_MAX_CHARS - 1) + '…';
}

/**
 * Heuristic — true if the line looks like a filesystem path. Used to
 * disambiguate files_with_matches output from unrelated tool messages.
 */
function looksLikePath(line: string): boolean {
  if (line.length === 0) return false;
  if (line.startsWith('[')) return false; // tool messages
  // Has at least one path separator OR a file extension.
  return line.includes('/') || line.includes('\\') || /\.\w{1,8}$/.test(line);
}

/**
 * Parse a `glob` tool result. Glob in KodaX returns one path per line
 * (or a multi-line list). Tolerates leading/trailing whitespace and
 * a truncation footer.
 */
export function extractGlobPaths(rawResult: unknown): GlobResultExtraction | undefined {
  const content = rejectPlaceholder(rawResult);
  if (content === null) return undefined;

  let body = content;
  let truncated = false;
  const truncIdx = body.indexOf(TRUNCATION_MARKER);
  if (truncIdx >= 0) {
    truncated = true;
    body = body.slice(0, truncIdx).trimEnd();
  }

  const paths = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('['))
    .filter(looksLikePath)
    .slice(0, MAX_GLOB_PATHS_PER_ENTRY);

  if (paths.length === 0) return undefined;
  return { paths, truncated };
}
