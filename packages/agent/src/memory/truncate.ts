/**
 * FEATURE_124 (v0.7.43) — MEMORY.md entrypoint truncation.
 *
 * Mirrors claudecode `src/memdir/memdir.ts` `truncateEntrypointContent`
 * (caps + warning text) byte-for-byte semantically — verified by
 * truncate.test.ts text-mirror assertion against the claudecode-shape
 * warning string. Mirroring the caps + warning is intentional: it pins
 * the same context-budget invariant (≤25KB SP overhead from MEMORY.md)
 * across both agents and inherits claudecode's empirical line/byte
 * tuning without re-deriving thresholds.
 *
 * Two-stage truncation:
 *   1. If `lineCount > MAX_ENTRYPOINT_LINES`, slice the array to that
 *      many lines and re-join.
 *   2. If the resulting (or original, when no line truncation) string is
 *      still > MAX_ENTRYPOINT_BYTES, find the last newline at or before
 *      the byte cap and slice there. Falls back to a hard byte slice if
 *      no newline is found within the cap (one giant line worse-case).
 *
 * Warning is appended only when at least one cap fired. Warning text
 * mirrors claudecode line 87-97; the test asserts the literal string.
 */

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

export interface EntrypointTruncation {
  /** Truncated content with claudecode-shape WARNING line appended (if any cap fired). */
  readonly content: string;
  /** Original line count BEFORE truncation. */
  readonly lineCount: number;
  /** Original byte count BEFORE truncation. */
  readonly byteCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a
 * claudecode-shape WARNING when truncated. Pass-through when within caps.
 *
 * Input MAY be trimmed of leading/trailing whitespace before measurement
 * (matches claudecode). Returns a `content` string ready for direct SP
 * injection.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim();
  const contentLines = trimmed.length === 0 ? [] : trimmed.split('\n');
  const lineCount = contentLines.length;
  const byteCount = Buffer.byteLength(trimmed, 'utf-8');

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  // Original byte count is the failure indicator — measuring post-line
  // truncation would understate the warning when long lines fit under
  // the line cap but blow the byte cap.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed;

  if (Buffer.byteLength(truncated, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    truncated = sliceToByteCap(truncated, MAX_ENTRYPOINT_BYTES);
  }

  return {
    content: truncated + '\n\n' + formatTruncationWarning({
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }),
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/**
 * Format the claudecode-shape WARNING line, picking the reason based
 * on which cap fired. Test pins the literal text.
 */
function formatTruncationWarning(params: {
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}): string {
  const { lineCount, byteCount, wasLineTruncated, wasByteTruncated } = params;
  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`;
  return `> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

/**
 * Slice a UTF-8 string to a byte cap on a newline boundary when
 * possible. Falls back to a hard byte slice (one giant line worst-case)
 * if no newline appears at or before the cap. The returned string is
 * guaranteed to be valid UTF-8 (Buffer slicing on a newline preserves
 * codepoint boundaries; the hard-slice fallback uses Buffer.toString
 * which replaces partial codepoints with U+FFFD).
 */
function sliceToByteCap(input: string, byteCap: number): string {
  const buffer = Buffer.from(input, 'utf-8');
  if (buffer.length <= byteCap) return input;

  // Find the last \n byte at or before byteCap. Buffer is a byte view
  // so we can search byte-wise without codepoint surprises.
  const NEWLINE = 0x0a;
  let cutAt = -1;
  for (let i = byteCap - 1; i >= 0; i--) {
    if (buffer[i] === NEWLINE) {
      cutAt = i;
      break;
    }
  }
  if (cutAt > 0) {
    return buffer.subarray(0, cutAt).toString('utf-8');
  }
  // No newline within cap — hard slice. toString handles partial UTF-8
  // codepoints at the boundary by substituting U+FFFD.
  return buffer.subarray(0, byteCap).toString('utf-8');
}

/**
 * Format bytes as `X.X KB` for the warning message. Mirrors claudecode
 * `formatFileSize` semantics — KB is base-1000 (not KiB / 1024).
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}
