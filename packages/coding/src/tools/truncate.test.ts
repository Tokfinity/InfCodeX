import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSize,
  formatDiffPreview,
  TOOL_OUTPUT_DIR_ENV,
  trimBufferStartToUtf8Boundary,
  truncateHead,
  truncateLine,
  truncateTail,
} from './truncate.js';

describe('truncate helpers', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await Promise.all(
      tempPaths.splice(0).map(async (entry) => {
        await fs.rm(entry, { recursive: true, force: true });
      }),
    );
  });

  it('truncates head output by line count', () => {
    const result = truncateHead('a\nb\nc\nd', { maxLines: 2, maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.content).toBe('a\nb');
  });

  it('truncates tail output and keeps the end', () => {
    const result = truncateTail('a\nb\nc\nd', { maxLines: 2, maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('c\nd');
  });

  it('truncates tail on a UTF-8 boundary when a single line exceeds the byte limit', () => {
    const result = truncateTail(`前缀${'你'.repeat(8)}`, { maxLines: 5, maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    expect(result.content).not.toContain('\uFFFD');
  });

  it('reports when the first line exceeds the head byte limit', () => {
    const result = truncateHead(`你${'好'.repeat(40)}`, { maxLines: 10, maxBytes: 8 });
    expect(result.truncated).toBe(true);
    expect(result.firstLineExceedsLimit).toBe(true);
    expect(result.content).toBe('');
  });

  it('truncates long single lines', () => {
    const line = 'x'.repeat(40);
    const result = truncateLine(line, 10);
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toContain('[truncated]');
  });

  it('trims buffer starts to a UTF-8 boundary', () => {
    const buffer = Buffer.from('A你B', 'utf-8');
    const trimmed = trimBufferStartToUtf8Boundary(buffer, 2);
    expect(trimmed.toString('utf-8')).toBe('B');
  });

  it('returns a diff preview even when spill-file persistence fails', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-truncate-'));
    tempPaths.push(tempRoot);
    const invalidOutputDir = path.join(tempRoot, 'not-a-dir');
    await fs.writeFile(invalidOutputDir, 'occupied', 'utf-8');
    process.env[TOOL_OUTPUT_DIR_ENV] = invalidOutputDir;

    const preview = await formatDiffPreview({
      diff: Array.from({ length: 500 }, (_, index) => `+ line-${index}`).join('\n'),
      toolName: 'write',
      filePath: 'sample.ts',
      ctx: { backups: new Map(), executionCwd: tempRoot },
      maxLines: 10,
      maxBytes: 256,
    });

    expect(preview).toContain('Diff preview truncated');
    expect(preview).not.toContain('Full diff saved to:');
  });

  it('formats byte sizes', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(2048)).toBe('2.0KB');
  });
});
