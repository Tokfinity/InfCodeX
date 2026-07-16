/**
 * FEATURE_141 (v0.7.37) — Unified-diff parser for transcript tool result text.
 *
 * Tool results from edit / multi_edit / write embed unified-diff text in
 * the format produced by `packages/coding/src/tools/diff.ts:generateDiff`:
 *
 *   File edited: <path>
 *     (+N lines, -N lines)
 *
 *   --- <path>
 *   +++ <path>
 *   @@ -42,7 +42,9 @@
 *      function processInput(input: string) {
 *   -    return input.toLowerCase();
 *   +    if (!input) return '';
 *   +    return input.trim();
 *      }
 *
 * The REPL transcript needs to slice this into a [prefix text] + [diff
 * blocks] + [suffix text] sequence so a `<DiffHunk>` Ink component can
 * colour the `+` / `-` / `@@` lines independently from surrounding plain
 * text.
 *
 * This module is parser-only: it returns segments. Rendering is in
 * `components/DiffHunk.tsx` (Phase 2.2).
 */

export type ParsedDiffSegment =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; text: string; addedLines: number; removedLines: number; filePath: string | null };

/**
 * Anchor regex — matches a unified-diff hunk header on its own line.
 * Examples:
 *   `@@ -1,7 +1,9 @@`
 *   `@@ -42 +42,3 @@`
 *   `@@ -1,3 +1,4 @@ context tail`
 */
const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/;
const FILE_HEADER_REGEX = /^---\s+(.+)$/;

/**
 * Split a unified diff text into a sequence of (text, diff) segments.
 *
 * Algorithm:
 *   - Walk lines linearly.
 *   - When entering a "diff region" (line matches `--- <path>` or `^@@ ... @@`),
 *     accumulate lines until we exit (a non-diff line that is not `+` / `-` /
 *     ` ` / `@@ ` / `--- ` / `+++ ` / blank inside-diff).
 *   - Emit the preceding text run as a text segment, then the diff region.
 *
 * Returns a single text segment for inputs with no recognizable diff.
 *
 * Robust against:
 *   - Diff appearing after preamble text ("File edited: foo.ts\n\n" + diff)
 *   - Multiple separate diffs (multi_edit with several files)
 *   - Trailing text after the last diff
 *   - Whitespace before the diff (gets attached to the prefix text segment)
 */
export function parseUnifiedDiff(input: string): ParsedDiffSegment[] {
  if (!input) return [];
  const lines = input.split('\n');
  const segments: ParsedDiffSegment[] = [];

  let textBuffer: string[] = [];
  let diffBuffer: string[] = [];
  let inDiff = false;
  let pendingFilePath: string | null = null;
  let currentFilePath: string | null = null;
  let added = 0;
  let removed = 0;

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join('\n');
    if (text.length > 0) {
      segments.push({ kind: 'text', text });
    }
    textBuffer = [];
  };

  const flushDiff = () => {
    if (diffBuffer.length === 0) return;
    segments.push({
      kind: 'diff',
      text: diffBuffer.join('\n'),
      addedLines: added,
      removedLines: removed,
      filePath: currentFilePath,
    });
    diffBuffer = [];
    added = 0;
    removed = 0;
    currentFilePath = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inDiff) {
      // Look for diff entry: `--- <path>` followed by `+++ ...` or a hunk header.
      const fileMatch = FILE_HEADER_REGEX.exec(line);
      if (fileMatch) {
        // Speculative entry: peek ahead for `+++` or `@@` within next 3 lines.
        const lookaheadLimit = Math.min(i + 3, lines.length - 1);
        let confirmed = false;
        for (let j = i + 1; j <= lookaheadLimit; j++) {
          if (lines[j]?.startsWith('+++ ') || HUNK_HEADER_REGEX.test(lines[j] ?? '')) {
            confirmed = true;
            break;
          }
        }
        if (confirmed) {
          flushText();
          inDiff = true;
          pendingFilePath = fileMatch[1] ?? null;
          currentFilePath = pendingFilePath;
          diffBuffer.push(line);
          continue;
        }
      }
      if (HUNK_HEADER_REGEX.test(line)) {
        // Hunk header without preceding `--- <path>` — still a diff start.
        flushText();
        inDiff = true;
        diffBuffer.push(line);
        continue;
      }
      textBuffer.push(line);
      continue;
    }

    // We are inside a diff region. First check if this line starts a NEW
    // file diff (`--- <path>` followed by `+++` or `@@`) — multi_edit
    // emits back-to-back file diffs separated only by a blank line.
    const newFileMatch = FILE_HEADER_REGEX.exec(line);
    if (newFileMatch) {
      const lookaheadLimit = Math.min(i + 3, lines.length - 1);
      let confirmed = false;
      for (let j = i + 1; j <= lookaheadLimit; j++) {
        if (lines[j]?.startsWith('+++ ') || HUNK_HEADER_REGEX.test(lines[j] ?? '')) {
          confirmed = true;
          break;
        }
      }
      if (confirmed) {
        // Close the current diff segment, then start a new one. The
        // blank line preceding this header (if any) was already pushed
        // into the previous diff buffer — that is fine, it just renders
        // as trailing whitespace.
        flushDiff();
        currentFilePath = newFileMatch[1] ?? null;
        diffBuffer.push(line);
        continue;
      }
    }

    const firstChar = line[0];
    if (
      firstChar === '+'
      || firstChar === '-'
      || firstChar === ' '
      || firstChar === '@'
      || line === ''
    ) {
      // Track add/remove counts (skip the `+++` / `---` file headers themselves).
      if (firstChar === '+' && !line.startsWith('+++ ')) added++;
      if (firstChar === '-' && !line.startsWith('--- ')) removed++;
      diffBuffer.push(line);
      continue;
    }

    // Line that doesn't start with diff prefix → diff region ended.
    flushDiff();
    inDiff = false;
    pendingFilePath = null;
    textBuffer.push(line);
  }

  // End of input — flush whichever buffer is open.
  flushDiff();
  flushText();

  return segments;
}

/**
 * Convenience: returns true iff the input contains at least one
 * recognizable diff hunk header. Useful as a fast gate before invoking
 * the full parser.
 */
export function containsUnifiedDiff(input: string): boolean {
  if (!input) return false;
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(input);
}
