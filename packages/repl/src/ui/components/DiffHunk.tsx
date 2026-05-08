/**
 * FEATURE_141 (v0.7.37) — Inline diff hunk renderer.
 *
 * Receives a single 'diff' segment from `parseUnifiedDiff` and emits an
 * Ink Box of coloured lines:
 *   - lines starting with `+` (but not `+++ `) → success/green
 *   - lines starting with `-` (but not `--- `) → error/red
 *   - lines starting with `@@ ... @@`           → dim/grey
 *   - lines starting with `--- ` / `+++ `       → dim/grey
 *   - context lines (` ` / blank)               → default
 *
 * v1 collapses long hunks: if `bodyLines > maxLines` we show the first
 * half + a "<N> lines collapsed" placeholder + the last half. Hunks
 * with bodyLines <= maxLines are shown in full. Extreme hunks
 * (bodyLines > extremeThreshold) get a summary-only fallback to avoid
 * scroll-storms.
 *
 * No interactivity — folding state is fixed at render time. Toggle /
 * expand controls are out of scope for v1 (matches design doc Phase
 * 2 acceptance criteria).
 */

import React from 'react';
import { Box, Text } from '../tui.js';
import { getTheme } from '../themes/index.js';
import type { Theme } from '../types.js';

export interface DiffHunkProps {
  text: string;
  addedLines: number;
  removedLines: number;
  filePath?: string | null;
  theme?: Theme;
  /** Max lines to display before collapsing the middle. Default 16. */
  maxLines?: number;
  /** Hunks larger than this get summary-only output. Default 200. */
  extremeThreshold?: number;
}

interface ClassifiedLine {
  text: string;
  kind: 'add' | 'remove' | 'hunk-header' | 'file-header' | 'context';
}

function classifyLine(line: string): ClassifiedLine {
  if (line.startsWith('+++ ')) return { text: line, kind: 'file-header' };
  if (line.startsWith('--- ')) return { text: line, kind: 'file-header' };
  if (line.startsWith('@@ ')) return { text: line, kind: 'hunk-header' };
  if (line.startsWith('+')) return { text: line, kind: 'add' };
  if (line.startsWith('-')) return { text: line, kind: 'remove' };
  return { text: line, kind: 'context' };
}

function colorFor(kind: ClassifiedLine['kind'], theme: Theme): string | undefined {
  switch (kind) {
    case 'add':
      return theme.colors.success;
    case 'remove':
      return theme.colors.error;
    case 'hunk-header':
    case 'file-header':
      return theme.colors.dim;
    case 'context':
    default:
      return undefined; // default text color
  }
}

/**
 * Memoized so re-rendering the same tool result row (e.g. after an
 * unrelated state change) does not re-walk the diff text.
 */
export const DiffHunk: React.FC<DiffHunkProps> = React.memo(({
  text,
  addedLines,
  removedLines,
  filePath,
  theme: themeProp,
  maxLines = 16,
  extremeThreshold = 200,
}) => {
  const theme = themeProp ?? getTheme('dark');
  const lines = text.split('\n');
  const classified = lines.map(classifyLine);
  const summaryLine = `(${addedLines > 0 ? `+${addedLines}` : '±0'} ${removedLines > 0 ? `-${removedLines}` : ''})`.trim();

  // Extreme-size guard: skip per-line render and emit a single placeholder.
  if (lines.length > extremeThreshold) {
    return (
      <Box flexDirection="column" marginLeft={4}>
        {filePath && (
          <Text dimColor>{filePath} {summaryLine}</Text>
        )}
        <Text dimColor>
          [diff too large to render inline — {lines.length} lines, {addedLines}+ / {removedLines}-]
        </Text>
      </Box>
    );
  }

  // Collapse-middle for medium-large hunks.
  let displayed: ClassifiedLine[];
  let collapsedCount = 0;
  if (lines.length > maxLines) {
    const half = Math.floor(maxLines / 2);
    const head = classified.slice(0, half);
    const tail = classified.slice(-half);
    collapsedCount = lines.length - head.length - tail.length;
    displayed = [...head, { text: '', kind: 'context' }, ...tail];
  } else {
    displayed = classified;
  }

  return (
    <Box flexDirection="column" marginLeft={4}>
      {filePath && (
        <Text dimColor>{filePath} {summaryLine}</Text>
      )}
      {displayed.map((line, idx) => {
        const isCollapseMarker = idx === Math.floor(maxLines / 2)
          && collapsedCount > 0
          && line.kind === 'context'
          && line.text === '';
        if (isCollapseMarker) {
          return (
            <Text key={`collapse-${idx}`} dimColor>
              ... {collapsedCount} lines collapsed ...
            </Text>
          );
        }
        const color = colorFor(line.kind, theme);
        return (
          <Text key={idx} color={color}>
            {line.text || ' '}
          </Text>
        );
      })}
    </Box>
  );
});

DiffHunk.displayName = 'DiffHunk';
