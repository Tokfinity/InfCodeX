/**
 * FEATURE_124 (v0.7.43) — truncate.ts unit tests.
 *
 * Verifies the 4 truncation cases (no-trunc / line / byte / both) +
 * claudecode-shape warning text mirror + UTF-8 boundary safety.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from './truncate.js';

describe('truncateEntrypointContent', () => {
  it('returns content unchanged when within both caps', () => {
    const raw = '- [Entry 1](e1.md) — hook\n- [Entry 2](e2.md) — hook';
    const result = truncateEntrypointContent(raw);
    expect(result.content).toBe(raw);
    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(false);
  });

  it('trims leading/trailing whitespace', () => {
    const raw = '\n\n  body  \n\n';
    const result = truncateEntrypointContent(raw);
    expect(result.content).toBe('body');
  });

  it('truncates to MAX_ENTRYPOINT_LINES when line cap exceeded', () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRYPOINT_LINES + 50; i++) {
      lines.push(`- [Entry ${i}](e${i}.md) — hook`);
    }
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.wasLineTruncated).toBe(true);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.lineCount).toBe(MAX_ENTRYPOINT_LINES + 50);

    const lineCountInContent = result.content.split('\n');
    // 200 truncated lines + 2 blank-separator lines + 1 WARNING line = 203
    // Verify the truncation kept the first MAX_ENTRYPOINT_LINES lines.
    expect(lineCountInContent[0]).toBe('- [Entry 0](e0.md) — hook');
    expect(lineCountInContent[MAX_ENTRYPOINT_LINES - 1]).toBe(
      `- [Entry ${MAX_ENTRYPOINT_LINES - 1}](e${MAX_ENTRYPOINT_LINES - 1}.md) — hook`,
    );
    expect(result.content).toContain('WARNING');
    expect(result.content).toContain(`${MAX_ENTRYPOINT_LINES + 50} lines`);
  });

  it('truncates to byte cap when only byte cap exceeded (long single lines)', () => {
    // 30 lines, each ~1000 bytes = 30KB → byte-cap fires, line-cap doesn't.
    const longLine = '- [Entry](e.md) — ' + 'X'.repeat(950);
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(longLine);
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(true);
    // Truncated content excluding warning should be ≤ byte cap.
    const warningSep = '\n\n> WARNING:';
    const sepIdx = result.content.indexOf(warningSep);
    expect(sepIdx).toBeGreaterThan(0);
    const bodyOnly = result.content.slice(0, sepIdx);
    expect(Buffer.byteLength(bodyOnly, 'utf-8')).toBeLessThanOrEqual(
      MAX_ENTRYPOINT_BYTES,
    );
    expect(result.content).toContain('index entries are too long');
  });

  it('reports BOTH reasons when line cap AND byte cap fire', () => {
    const longLine = '- [Entry](e.md) — ' + 'X'.repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRYPOINT_LINES + 50; i++) lines.push(longLine);
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.wasLineTruncated).toBe(true);
    expect(result.wasByteTruncated).toBe(true);
    expect(result.content).toContain('lines and');
  });

  it('warning text mirrors claudecode-shape literal', () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRYPOINT_LINES + 1; i++) {
      lines.push(`- [E${i}](e${i}.md)`);
    }
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.content).toContain(
      'Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.',
    );
    expect(result.content).toContain(`(limit: ${MAX_ENTRYPOINT_LINES})`);
  });

  it('byte-cap slice cuts on newline boundary', () => {
    // Many short lines past the byte cap.
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRYPOINT_LINES - 1; i++) {
      lines.push('X'.repeat(150)); // ~150 bytes per line × 199 lines = 29850 bytes
    }
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.wasByteTruncated).toBe(true);
    expect(result.wasLineTruncated).toBe(false);

    const warningSep = '\n\n> WARNING:';
    const bodyOnly = result.content.slice(0, result.content.indexOf(warningSep));
    // Body must end on a non-fragmented line (no trailing partial X).
    expect(bodyOnly.endsWith('X'.repeat(150))).toBe(true);
  });

  it('handles empty input', () => {
    const result = truncateEntrypointContent('');
    expect(result.content).toBe('');
    expect(result.lineCount).toBe(0);
    expect(result.byteCount).toBe(0);
    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(false);
  });

  it('handles single line at exactly the byte cap (no truncation)', () => {
    const line = 'X'.repeat(MAX_ENTRYPOINT_BYTES);
    const result = truncateEntrypointContent(line);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.content).toBe(line);
  });

  it('UTF-8 multi-byte chars counted correctly (no false-positive truncation)', () => {
    // 100 lines of 100 Chinese chars each. Each char ~3 bytes in UTF-8.
    // 100 × 100 × 3 = ~30000 bytes → byte-cap fires correctly.
    const cnLine = '记'.repeat(100);
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(cnLine);
    const raw = lines.join('\n');
    const result = truncateEntrypointContent(raw);

    expect(result.byteCount).toBeGreaterThan(MAX_ENTRYPOINT_BYTES);
    expect(result.wasByteTruncated).toBe(true);
    // No replacement-char (U+FFFD) — boundary slice landed on \n.
    expect(result.content).not.toContain('�');
  });
});
