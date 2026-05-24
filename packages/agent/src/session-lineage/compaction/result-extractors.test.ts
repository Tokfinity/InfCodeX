/**
 * FEATURE_185 (v0.7.42) — pure-parser tests for result-side extractors.
 */
import { describe, expect, it } from 'vitest';
import {
  extractGrepHits,
  extractGlobPaths,
  extractBashResult,
  HIT_PREVIEW_MAX_CHARS,
  MAX_HITS_PER_ENTRY,
  MAX_GLOB_PATHS_PER_ENTRY,
  BASH_TAIL_MAX_CHARS,
} from './result-extractors.js';

describe('extractGrepHits', () => {
  it('parses content-mode hits with Linux paths', () => {
    const raw = [
      'src/auth.ts:42: const token = generateToken();',
      'src/auth.ts:78: validateToken(token);',
      'src/login.ts:13: import { generateToken } from "./auth";',
    ].join('\n');
    const r = extractGrepHits(raw);
    expect(r?.resultMode).toBe('content');
    expect(r?.hits).toHaveLength(3);
    expect(r?.hits[0]).toEqual({
      path: 'src/auth.ts',
      line: 42,
      preview: 'const token = generateToken();',
    });
    expect(r?.hits[2]!.path).toBe('src/login.ts');
    expect(r?.hits[2]!.line).toBe(13);
  });

  it('parses content-mode hits with Windows absolute paths (drive-letter colon)', () => {
    const raw = [
      'C:\\Works\\KodaX\\packages\\coding\\src\\auth.ts:42: const token = generateToken();',
      'C:\\Works\\KodaX\\packages\\coding\\src\\login.ts:13: import { generateToken } from "./auth";',
    ].join('\n');
    const r = extractGrepHits(raw);
    expect(r?.resultMode).toBe('content');
    expect(r?.hits).toHaveLength(2);
    expect(r?.hits[0]!.path).toBe('C:\\Works\\KodaX\\packages\\coding\\src\\auth.ts');
    expect(r?.hits[0]!.line).toBe(42);
  });

  it('truncates each hit preview to HIT_PREVIEW_MAX_CHARS', () => {
    const longText = 'x'.repeat(HIT_PREVIEW_MAX_CHARS + 50);
    const raw = `src/long.ts:1: ${longText}`;
    const r = extractGrepHits(raw);
    expect(r?.hits[0]!.preview.length).toBeLessThanOrEqual(HIT_PREVIEW_MAX_CHARS);
    expect(r?.hits[0]!.preview.endsWith('…')).toBe(true);
  });

  it('caps total hits at MAX_HITS_PER_ENTRY', () => {
    const lines: string[] = [];
    for (let i = 1; i <= MAX_HITS_PER_ENTRY + 10; i++) {
      lines.push(`src/file.ts:${i}: line ${i}`);
    }
    const r = extractGrepHits(lines.join('\n'));
    expect(r?.hits).toHaveLength(MAX_HITS_PER_ENTRY);
  });

  it('detects truncation footer and strips it from hit parsing', () => {
    const raw = [
      'src/auth.ts:42: const token = generateToken();',
      '',
      '[Grep output truncated: showing 1 of 200 lines (24KB of 1MB). Narrow the pattern.]',
    ].join('\n');
    const r = extractGrepHits(raw);
    expect(r?.truncated).toBe(true);
    expect(r?.hits).toHaveLength(1);
    expect(r?.hits[0]!.line).toBe(42);
  });

  it('captures context-line entries (path-line- text format)', () => {
    const raw = [
      'src/auth.ts-41- // setup',
      'src/auth.ts:42: const token = generateToken();',
      'src/auth.ts-43- // cleanup',
    ].join('\n');
    const r = extractGrepHits(raw);
    expect(r?.hits).toHaveLength(3);
    expect(r?.hits[1]!.line).toBe(42);
  });

  it('parses count-mode results', () => {
    const r = extractGrepHits('42 matches');
    expect(r?.resultMode).toBe('count');
    expect(r?.matchCount).toBe(42);
    expect(r?.hits).toHaveLength(0);
  });

  it('parses empty-result strings', () => {
    const r = extractGrepHits('No matches for "foo"');
    expect(r?.resultMode).toBe('empty');
    expect(r?.hits).toHaveLength(0);
  });

  it('parses files_with_matches-mode results (path-per-line)', () => {
    const raw = [
      'src/auth.ts',
      'src/login.ts',
      'C:\\Works\\repo\\file.ts',
    ].join('\n');
    const r = extractGrepHits(raw);
    expect(r?.resultMode).toBe('files_with_matches');
    expect(r?.hits).toHaveLength(3);
    expect(r?.hits[0]).toEqual({ path: 'src/auth.ts', line: 0, preview: '' });
  });

  it('returns undefined for [Cleared:...] placeholder', () => {
    const r = extractGrepHits('[Cleared: grep src/auth.ts "token"]');
    expect(r).toBeUndefined();
  });

  it('returns undefined for [Pruned:...] placeholder', () => {
    const r = extractGrepHits('[Pruned: grep src/auth.ts]');
    expect(r).toBeUndefined();
  });

  it('returns undefined for [Tool Error] results', () => {
    const r = extractGrepHits('[Tool Error] grep: Pattern rejected as potentially unsafe.');
    expect(r).toBeUndefined();
  });

  it('returns undefined for non-string input', () => {
    expect(extractGrepHits(undefined)).toBeUndefined();
    expect(extractGrepHits(null)).toBeUndefined();
    expect(extractGrepHits(42)).toBeUndefined();
    expect(extractGrepHits({})).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractGrepHits('')).toBeUndefined();
    expect(extractGrepHits('   ')).toBeUndefined();
  });
});

describe('extractGlobPaths', () => {
  it('parses one-path-per-line result', () => {
    const raw = [
      'src/auth.ts',
      'src/login.ts',
      'src/session.ts',
    ].join('\n');
    const r = extractGlobPaths(raw);
    expect(r?.paths).toHaveLength(3);
    expect(r?.paths[0]).toBe('src/auth.ts');
    expect(r?.truncated).toBeFalsy();
  });

  it('caps paths at MAX_GLOB_PATHS_PER_ENTRY', () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_GLOB_PATHS_PER_ENTRY + 30; i++) {
      lines.push(`src/file${i}.ts`);
    }
    const r = extractGlobPaths(lines.join('\n'));
    expect(r?.paths).toHaveLength(MAX_GLOB_PATHS_PER_ENTRY);
  });

  it('detects truncation footer', () => {
    const raw = [
      'src/auth.ts',
      'src/login.ts',
      '',
      '[Grep output truncated: showing 2 of 200 lines.]',
    ].join('\n');
    const r = extractGlobPaths(raw);
    expect(r?.truncated).toBe(true);
    expect(r?.paths).toHaveLength(2);
  });

  it('returns undefined for placeholder result', () => {
    expect(extractGlobPaths('[Cleared: glob "**/*.ts"]')).toBeUndefined();
  });

  it('returns undefined for empty result', () => {
    expect(extractGlobPaths('')).toBeUndefined();
    expect(extractGlobPaths(undefined)).toBeUndefined();
  });

  it('skips lines that do not look like paths', () => {
    const raw = [
      'src/auth.ts',
      'foo bar baz',  // not a path
      'src/login.ts',
    ].join('\n');
    const r = extractGlobPaths(raw);
    expect(r?.paths).toHaveLength(2);
    expect(r?.paths).toEqual(['src/auth.ts', 'src/login.ts']);
  });
});

describe('extractBashResult', () => {
  it('parses exit code 0 and trailing stdout tail', () => {
    const raw = [
      'Command: npm test',
      'Exit: 0',
      'Test Files  7 passed (7)',
      '     Tests  123 passed (123)',
      '  Duration  8.95s',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBe(0);
    expect(r?.tail).toContain('123 passed');
    expect(r?.cancelled).toBeUndefined();
    expect(r?.timeout).toBeUndefined();
  });

  it('parses non-zero exit code (failed command)', () => {
    const raw = [
      'Command: npm run lint',
      'Exit: 1',
      'Error: ESLint found 3 problems',
      'src/foo.ts:42:5  error  unused-vars',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBe(1);
    expect(r?.tail).toContain('ESLint found 3 problems');
    expect(r?.tail).toContain('unused-vars');
  });

  it('handles negative exit codes', () => {
    const raw = 'Command: failing\nExit: -1\nsome output';
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBe(-1);
  });

  it('parses null exit code (process killed before exit)', () => {
    const raw = 'Command: long-running\nExit: null\noutput before kill';
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBeNull();
  });

  it('strips Command and Exit header lines from tail', () => {
    const raw = [
      'Command: echo hello',
      'Exit: 0',
      'hello',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.tail).toBe('hello');
    expect(r?.tail).not.toContain('Command:');
    expect(r?.tail).not.toContain('Exit:');
  });

  it('truncates the tail to BASH_TAIL_MAX_CHARS, taking the trailing slice', () => {
    const longBody = 'a'.repeat(BASH_TAIL_MAX_CHARS + 200);
    const raw = `Command: long\nExit: 0\n${longBody}END_MARKER`;
    const r = extractBashResult(raw);
    expect(r?.tail!.length).toBeLessThanOrEqual(BASH_TAIL_MAX_CHARS);
    expect(r?.tail!.startsWith('…')).toBe(true);
    expect(r?.tail!.endsWith('END_MARKER')).toBe(true);
  });

  it('flags cancelled commands', () => {
    const r = extractBashResult('[Cancelled] Operation cancelled by user');
    expect(r?.cancelled).toBe(true);
    expect(r?.timeout).toBeUndefined();
    expect(r?.exitCode).toBeUndefined();
  });

  it('flags timeout commands', () => {
    const raw = [
      'Command: long-running',
      '[Timeout] Command interrupted after 30s',
      'Partial output (tail):',
      'still processing...',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.timeout).toBe(true);
    expect(r?.tail).toContain('Partial output');
  });

  it('flags captureCapped when stdout exceeded internal buffer', () => {
    const raw = [
      'Command: huge-output',
      'Exit: 0',
      'large output content...',
      '[stdout capture capped: earlier 5.2MB omitted]',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.captureCapped).toBe(true);
    expect(r?.exitCode).toBe(0);
  });

  it('handles background-mode result (no Exit line)', () => {
    const raw = [
      'Command started in background.',
      'PID: 12345',
      'Output: /tmp/kodax-bg-abc123.log',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBeUndefined();
    expect(r?.tail).toContain('PID:');
  });

  it('returns undefined for placeholders', () => {
    expect(extractBashResult('[Cleared: bash npm test]')).toBeUndefined();
    expect(extractBashResult('[Pruned: bash]')).toBeUndefined();
    expect(extractBashResult('[Tool Error] bash: unable to launch')).toBeUndefined();
  });

  it('returns undefined for non-string / empty input', () => {
    expect(extractBashResult(undefined)).toBeUndefined();
    expect(extractBashResult(null)).toBeUndefined();
    expect(extractBashResult({})).toBeUndefined();
    expect(extractBashResult('')).toBeUndefined();
    expect(extractBashResult('   ')).toBeUndefined();
  });

  it('captures stderr-only command output via tail', () => {
    const raw = [
      'Command: failing-cmd',
      'Exit: 1',
      '',
      '[stderr]',
      'error: something went wrong',
      'check log for details',
    ].join('\n');
    const r = extractBashResult(raw);
    expect(r?.exitCode).toBe(1);
    expect(r?.tail).toContain('[stderr]');
    expect(r?.tail).toContain('something went wrong');
  });
});
