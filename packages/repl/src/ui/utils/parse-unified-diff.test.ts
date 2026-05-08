/**
 * FEATURE_141 (v0.7.37) — Unified-diff parser tests.
 *
 * Locks the segment slicing contract that DiffHunk relies on. Inputs are
 * shaped after `packages/coding/src/tools/diff.ts:generateDiff` output
 * plus the `formatDiffPreview` wrapper that prepends "File edited: …
 * (+N -N)" preamble.
 */

import { describe, expect, it } from 'vitest';
import {
  containsUnifiedDiff,
  parseUnifiedDiff,
  type ParsedDiffSegment,
} from './parse-unified-diff.js';

describe('containsUnifiedDiff', () => {
  it('returns true for a minimal valid hunk header', () => {
    expect(containsUnifiedDiff('@@ -1,3 +1,4 @@')).toBe(true);
  });

  it('returns true for a hunk header embedded in surrounding text', () => {
    expect(containsUnifiedDiff('preamble\n@@ -1,3 +1,4 @@\n+added')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(containsUnifiedDiff('just a string')).toBe(false);
  });

  it('returns false for empty / whitespace input', () => {
    expect(containsUnifiedDiff('')).toBe(false);
    expect(containsUnifiedDiff('   ')).toBe(false);
  });

  it('rejects malformed hunk headers (missing leading @@)', () => {
    expect(containsUnifiedDiff('@@ -1,3 +1,4')).toBe(false);
    expect(containsUnifiedDiff('-1,3 +1,4 @@')).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  const segmentTypes = (segs: ParsedDiffSegment[]) => segs.map((s) => s.kind);

  it('returns a single text segment for input with no diff', () => {
    const result = parseUnifiedDiff('hello world');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'text', text: 'hello world' });
  });

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('parses a single-hunk diff with file headers as one diff segment', () => {
    const input = [
      '--- foo.ts',
      '+++ foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' const d = 5;',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    expect(segmentTypes(result)).toEqual(['diff']);
    const diff = result[0]! as ParsedDiffSegment & { kind: 'diff' };
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(1);
    expect(diff.filePath).toBe('foo.ts');
    expect(diff.text).toContain('@@ -1,3 +1,4 @@');
  });

  it('separates preamble text from diff content', () => {
    const input = [
      'File edited: packages/coding/src/foo.ts',
      '  (+2 lines, -1 lines)',
      '',
      '--- packages/coding/src/foo.ts',
      '+++ packages/coding/src/foo.ts',
      '@@ -42,3 +42,4 @@',
      ' function processInput(input) {',
      '-  return input.toLowerCase();',
      '+  if (!input) return "";',
      '+  return input.trim();',
      ' }',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    expect(segmentTypes(result)).toEqual(['text', 'diff']);
    expect((result[0]! as { text: string }).text).toContain('File edited:');
    expect((result[0]! as { text: string }).text).toContain('(+2 lines, -1 lines)');
    const diff = result[1]! as ParsedDiffSegment & { kind: 'diff' };
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(1);
    expect(diff.filePath).toBe('packages/coding/src/foo.ts');
  });

  it('handles a hunk header without --- / +++ file lines', () => {
    const input = [
      'preamble',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    expect(segmentTypes(result)).toEqual(['text', 'diff']);
    const diff = result[1]! as ParsedDiffSegment & { kind: 'diff' };
    expect(diff.filePath).toBeNull();
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
  });

  it('emits multiple diff segments for multi-file (multi_edit) result', () => {
    const input = [
      '--- a.ts',
      '+++ a.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
      '',
      '--- b.ts',
      '+++ b.ts',
      '@@ -1,1 +1,2 @@',
      ' p',
      '+q',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    // Two distinct diffs separated by an internal blank line. The blank
    // line currently lives at the tail of the first diff (matches our
    // "blank lines stay in diff" rule) — so we expect [diff, diff].
    expect(segmentTypes(result.filter((s) => s.kind === 'diff'))).toEqual(['diff', 'diff']);
    const fileNames = result
      .filter((s): s is ParsedDiffSegment & { kind: 'diff' } => s.kind === 'diff')
      .map((s) => s.filePath);
    expect(fileNames).toEqual(['a.ts', 'b.ts']);
  });

  it('emits trailing text after the last diff', () => {
    const input = [
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
      'tool finished successfully',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    expect(segmentTypes(result)).toEqual(['diff', 'text']);
    expect((result[1]! as { text: string }).text).toBe('tool finished successfully');
  });

  it('does not double-count --- and +++ header lines as removals/additions', () => {
    const input = [
      '--- foo.ts',
      '+++ foo.ts',
      '@@ -1,1 +1,2 @@',
      '-old',
      '+new',
      '+extra',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    const diff = result.find((s) => s.kind === 'diff') as ParsedDiffSegment & { kind: 'diff' };
    expect(diff.addedLines).toBe(2); // +new, +extra (not +++ foo.ts)
    expect(diff.removedLines).toBe(1); // -old (not --- foo.ts)
  });

  it('does not match a `---` line when no hunk follows (false-positive guard)', () => {
    const input = [
      'some text',
      '--- this looks like a file header',
      'but is just markdown',
      'no hunk follows',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    expect(segmentTypes(result)).toEqual(['text']);
    expect((result[0]! as { text: string }).text).toContain('--- this looks like a file header');
  });

  it('preserves context-line and blank-line content inside the diff', () => {
    const input = [
      '@@ -1,5 +1,5 @@',
      ' line1',
      '',
      ' line3',
      '-old',
      '+new',
    ].join('\n');

    const result = parseUnifiedDiff(input);
    const diff = result[0]! as ParsedDiffSegment & { kind: 'diff' };
    expect(diff.text.split('\n')).toContain('');
    expect(diff.text.split('\n')).toContain(' line1');
    expect(diff.text.split('\n')).toContain(' line3');
  });
});
