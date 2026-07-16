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
  /** Number of hits retained in this bounded ledger extraction. */
  readonly capturedCount?: number;
  /** Number of visible hits omitted by the ledger's own bound. */
  readonly omittedCount?: number;
  /** Lossless artifact created by the tool-result capacity owner, when present. */
  readonly artifactPath?: string;
  /** Output mode inferred from the result shape. */
  readonly resultMode: 'content' | 'files_with_matches' | 'count' | 'empty' | 'unknown';
}

/** Parsed shape of a glob result string. */
export interface GlobResultExtraction {
  readonly paths: readonly string[];
  readonly truncated?: boolean;
  readonly capturedCount?: number;
  readonly omittedCount?: number;
  readonly artifactPath?: string;
}

/** Stable recovery information embedded in an incomplete tool result. */
export interface ToolResultRecovery {
  readonly marker: string;
  readonly artifactPath?: string;
}

/** Per-entry cap so a runaway search can't dominate the ledger budget. */
export const MAX_HITS_PER_ENTRY = 50;

/** Per-hit preview cap. */
export const HIT_PREVIEW_MAX_CHARS = 80;

/** Per-entry cap for glob paths. */
export const MAX_GLOB_PATHS_PER_ENTRY = 80;

/** FEATURE_185 (v0.7.42): per-bash-entry tail cap in characters. */
export const BASH_TAIL_MAX_CHARS = 240;

const PLACEHOLDER_PREFIXES = ['[Cleared:', '[Pruned:', '[Tool Error]'];
const TRUNCATION_MARKER = '[Grep output truncated:';
const INCOMPLETE_MARKER = '[KODAX_RESULT_INCOMPLETE.';
const SAVED_OUTPUT_LABEL = 'Full output saved to:';

/**
 * Parse the generic recovery marker without importing the coding package.
 * The marker is an inter-package text contract because provider-facing
 * tool-result blocks cannot currently carry private structured metadata.
 */
export function extractToolResultRecovery(rawResult: unknown): ToolResultRecovery | undefined {
  if (typeof rawResult !== 'string') return undefined;
  const markerStart = rawResult.indexOf(INCOMPLETE_MARKER);
  if (markerStart < 0) return undefined;
  const markerLineEnd = rawResult.indexOf('\n', markerStart);
  const markerSearchEnd = markerLineEnd >= 0 ? markerLineEnd : rawResult.length;
  const markerEnd = rawResult.lastIndexOf(']', markerSearchEnd - 1);
  if (markerEnd < 0) return undefined;

  const marker = rawResult.slice(markerStart, markerEnd + 1);
  const labelStart = marker.indexOf(SAVED_OUTPUT_LABEL);
  if (labelStart < 0) return { marker };

  const pathAndSuffix = marker.slice(labelStart + SAVED_OUTPUT_LABEL.length).trimStart();
  // Capacity artifacts currently use a generated `.txt` filename. Prefer the
  // last such suffix so dots/spaces inside parent directories remain intact;
  // retain a sentence-boundary fallback for older/custom markers.
  const generatedPath = /^(.*\.txt)\.(?:\s|$)/.exec(pathAndSuffix)?.[1];
  const sentenceBoundary = pathAndSuffix.indexOf('. ');
  const fallbackEnd = sentenceBoundary >= 0
    ? sentenceBoundary
    : pathAndSuffix.endsWith('.')
      ? pathAndSuffix.length - 1
      : pathAndSuffix.length;
  const artifactPath = (generatedPath ?? pathAndSuffix.slice(0, fallbackEnd)).trim();
  return artifactPath ? { marker, artifactPath } : { marker };
}

/** Keep an incomplete result recoverable after its preview is cleared/pruned. */
export function preserveToolResultRecovery(
  rawResult: unknown,
  placeholder: string,
  metadata?: Record<string, unknown>,
): string {
  const recovery = extractToolResultRecovery(rawResult);
  const hasStructuredRecovery = metadata?.truncated === true || metadata?.capacityFallback === true;
  const structuredPath = hasStructuredRecovery
    && typeof metadata?.outputPath === 'string'
    && metadata.outputPath.trim().length > 0
    ? metadata.outputPath
    : undefined;
  const artifactPath = structuredPath ?? recovery?.artifactPath;
  if (!artifactPath && !recovery) return placeholder;
  const marker = artifactPath
    ? `[KODAX_RESULT_INCOMPLETE. Full output saved to: ${artifactPath}.]`
    : recovery!.marker;
  return `${placeholder}\n${marker}`;
}

function prepareResult(rawResult: unknown): {
  readonly content: string;
  readonly recovery?: ToolResultRecovery;
} | undefined {
  const content = rejectPlaceholder(rawResult);
  if (content === null) return undefined;
  const recovery = extractToolResultRecovery(content);
  return {
    content: recovery ? content.replace(recovery.marker, '').trimEnd() : content,
    ...(recovery ? { recovery } : {}),
  };
}

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
  const prepared = prepareResult(rawResult);
  if (!prepared) return undefined;
  const { content, recovery } = prepared;

  // count mode: `${N} matches`
  const countMatch = /^(\d+)\s+matches\s*$/m.exec(content);
  if (countMatch && !content.includes(':') && !content.includes('No matches')) {
    return {
      hits: [],
      matchCount: parseInt(countMatch[1]!, 10),
      truncated: recovery !== undefined,
      ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
      resultMode: 'count',
    };
  }

  // no-matches
  if (/^No matches for /.test(content)) {
    return {
      hits: [],
      truncated: recovery !== undefined,
      ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
      resultMode: 'empty',
    };
  }

  // Strip the truncation footer block (if present) before parsing lines.
  let body = content;
  let truncated = recovery !== undefined;
  const truncationIdx = body.indexOf(TRUNCATION_MARKER);
  if (truncationIdx >= 0) {
    truncated = true;
    body = body.slice(0, truncationIdx).trimEnd();
  }

  const lines = body.split('\n');
  const hits: SearchHit[] = [];
  let parsedHitCount = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    const parsed = parseGrepLine(line);
    if (parsed) {
      parsedHitCount++;
      if (hits.length < MAX_HITS_PER_ENTRY) hits.push(parsed);
    }
  }

  if (hits.length > 0) {
    const omittedCount = parsedHitCount - hits.length;
    return {
      hits,
      resultMode: 'content',
      truncated: truncated || omittedCount > 0,
      capturedCount: hits.length,
      ...(omittedCount > 0 ? { omittedCount } : {}),
      ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
    };
  }

  // No `path:line:` rows — could be files_with_matches mode (path per line) or unknown.
  if (parsedHitCount === 0) {
    const paths = lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('['))
      .filter(looksLikePath);

    if (paths.length > 0) {
      // Treat as files_with_matches: store as hits with line=0 sentinel.
      const sliced = paths.slice(0, MAX_HITS_PER_ENTRY);
      const omittedCount = paths.length - sliced.length;
      return {
        hits: sliced.map((p) => ({ path: p, line: 0, preview: '' })),
        resultMode: 'files_with_matches',
        truncated: truncated || omittedCount > 0,
        capturedCount: sliced.length,
        ...(omittedCount > 0 ? { omittedCount } : {}),
        ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
      };
    }
  }

  return {
    hits: [],
    resultMode: 'unknown',
    truncated,
    ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
  };
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

/** FEATURE_185 (v0.7.42): parsed shape of a `bash` tool result. */
export interface BashResultExtraction {
  /** Exit code (`Exit: N` line) — `null` when process killed before exit. */
  readonly exitCode?: number | null;
  /** Last {@link BASH_TAIL_MAX_CHARS} characters of stdout/stderr (excluding header). */
  readonly tail?: string;
  /** True when the result contained `[Cancelled]` marker. */
  readonly cancelled?: boolean;
  /** True when the result contained `[Timeout]` marker. */
  readonly timeout?: boolean;
  /** True when stdout/stderr capture exceeded the bash tool's internal limit. */
  readonly captureCapped?: boolean;
}

/**
 * Parse a `bash` tool result emitted by `packages/coding/src/tools/bash.ts`.
 *
 * Result shape on success:
 *   `Command: {cmd}\nExit: {code}\n{stdout}[\n[stderr]\n{stderr}]`
 *
 * Result shape on timeout (settle from setTimeout branch):
 *   `Command: {cmd}\n[Timeout] Command interrupted after {N}s ...`
 *
 * Result shape on abort:
 *   `[Cancelled] Operation cancelled by user`
 *
 * Background mode emits a different shape (PID + output file path) which
 * carries no exit-code semantics; we treat it as an empty result.
 *
 * @returns `undefined` if the input is a placeholder / non-string;
 *          a populated `BashResultExtraction` otherwise (even on
 *          cancelled/timeout — those flags ARE the result signal).
 */
export function extractBashResult(rawResult: unknown): BashResultExtraction | undefined {
  const prepared = prepareResult(rawResult);
  if (!prepared) return undefined;
  const { content } = prepared;

  const out: {
    -readonly [K in keyof BashResultExtraction]: BashResultExtraction[K];
  } = {};

  if (/\[Cancelled\]/.test(content)) {
    out.cancelled = true;
  }
  if (/\[Timeout\]\s+Command interrupted/.test(content)) {
    out.timeout = true;
  }
  if (/\[stdout capture capped:/.test(content)
    || /\[Output capture capped/.test(content)) {
    out.captureCapped = true;
  }

  // Background-mode result has no Exit line; treat as empty signal.
  if (/^Command started in background\./.test(content)) {
    return Object.keys(out).length > 0 ? out : { tail: buildTail(content) };
  }

  // Exit: N (or `null` when process killed before exit naturally).
  const exitMatch = /^Exit:\s+(-?\d+|null)\s*$/m.exec(content);
  if (exitMatch) {
    const v = exitMatch[1]!;
    out.exitCode = v === 'null' ? null : parseInt(v, 10);
  }

  const tail = buildTail(content);
  if (tail) out.tail = tail;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Internal: pick the most informative tail slice from a bash result.
 *
 * Strategy: strip the leading header (`Command:` + `Exit:` lines) so the
 * tail doesn't waste bytes restating what's already in ledger metadata
 * (target/action/exitCode). What remains is stdout + optional [stderr]
 * + capture-cap markers — the actual diagnostic surface. Take the last
 * {@link BASH_TAIL_MAX_CHARS} characters. Trim whitespace and collapse
 * empty leading lines.
 */
function buildTail(content: string): string {
  const lines = content.split(/\r?\n/);
  // Skip leading header lines: `Command: ...` / `Exit: ...` / `[Timeout]` opener.
  let startIdx = 0;
  while (startIdx < lines.length) {
    const line = lines[startIdx]!;
    if (/^Command:\s/.test(line)
      || /^Exit:\s/.test(line)
      || /^\[Timeout\]\s+Command interrupted/.test(line)
      || line.trim() === '') {
      startIdx++;
      continue;
    }
    break;
  }
  const body = lines.slice(startIdx).join('\n').trimEnd();
  if (body.length === 0) return '';
  if (body.length <= BASH_TAIL_MAX_CHARS) return body;
  // Take the trailing slice — most informative for failed commands.
  return '…' + body.slice(-(BASH_TAIL_MAX_CHARS - 1));
}

/**
 * Parse a `glob` tool result. Glob in KodaX returns one path per line
 * (or a multi-line list). Tolerates leading/trailing whitespace and
 * a truncation footer.
 */
export function extractGlobPaths(rawResult: unknown): GlobResultExtraction | undefined {
  const prepared = prepareResult(rawResult);
  if (!prepared) return undefined;
  const { content, recovery } = prepared;

  let body = content;
  let truncated = recovery !== undefined;
  const truncIdx = body.indexOf(TRUNCATION_MARKER);
  if (truncIdx >= 0) {
    truncated = true;
    body = body.slice(0, truncIdx).trimEnd();
  }

  const allPaths = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('['))
    .filter(looksLikePath);
  const paths = allPaths.slice(0, MAX_GLOB_PATHS_PER_ENTRY);

  if (paths.length === 0) return undefined;
  const omittedCount = allPaths.length - paths.length;
  return {
    paths,
    truncated: truncated || omittedCount > 0,
    capturedCount: paths.length,
    ...(omittedCount > 0 ? { omittedCount } : {}),
    ...(recovery?.artifactPath ? { artifactPath: recovery.artifactPath } : {}),
  };
}
