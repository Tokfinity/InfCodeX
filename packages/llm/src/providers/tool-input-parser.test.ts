/**
 * Unit tests for the shared tool_use input salvage helper.
 *
 * Strategy:
 *  - Stage-by-stage coverage: strict path, salvage path, garbage path, empty path
 *  - Real-world regression samples from DeepSeek V4 bench (flash + pro,
 *    captured 2026-04-25 at max_tokens 800 / 4000 / 8000) — these are
 *    the actual byte sequences observed when `finish_reason: length`
 *    truncates a streaming tool_use during a `write` payload
 *  - Boundary discipline: array values, primitives, multi-byte unicode
 *    truncation, JSON escape sequences mid-payload
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseToolInputWithSalvage, parseToolInputWithSalvageTracked } from './tool-input-parser.js';

describe('parseToolInputWithSalvage', () => {
  afterEach(() => {
    delete process.env.KODAX_DEBUG_TOOL_STREAM;
    vi.restoreAllMocks();
  });

  describe('strict parse path (complete JSON)', () => {
    it('parses a complete simple object', () => {
      expect(parseToolInputWithSalvage('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
    });

    it('parses a complete object with nested structures', () => {
      const raw = '{"path":"/tmp/x","content":"hello","meta":{"lines":42,"tags":["a","b"]}}';
      expect(parseToolInputWithSalvage(raw)).toEqual({
        path: '/tmp/x',
        content: 'hello',
        meta: { lines: 42, tags: ['a', 'b'] },
      });
    });

    it('parses strings containing escaped quotes and newlines', () => {
      const raw = '{"content":"line1\\nline2 with \\"quoted\\" word"}';
      expect(parseToolInputWithSalvage(raw)).toEqual({
        content: 'line1\nline2 with "quoted" word',
      });
    });
  });

  describe('salvage path (truncated JSON)', () => {
    it('recovers prefix when truncated mid-string (real DeepSeek V4 flash sample)', () => {
      // Captured 2026-04-25 from deepseek-v4-flash at max_tokens=800,
      // finish_reason=length. Full content was ~1665 chars; this is the
      // structural shape of the truncation tail.
      const truncated =
        '{"path":"slides/agent-membase-bizagentos-fusion.html","content":"<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head>\\n<meta charset=\\"UTF-8\\">\\n  transition: opacity 0.5s ease, transform 0.5s ease;\\n';
      const out = parseToolInputWithSalvage(truncated);
      expect(out.path).toBe('slides/agent-membase-bizagentos-fusion.html');
      expect(typeof out.content).toBe('string');
      expect((out.content as string)).toContain('<!DOCTYPE html>');
      expect((out.content as string)).toContain('transform 0.5s ease');
    });

    it('recovers prefix when truncated containing unicode dashes (real DeepSeek V4 pro sample)', () => {
      // Captured 2026-04-25 from deepseek-v4-pro at max_tokens=8000.
      // Contains em-dash (U+2011 ‑) and en-dash (U+2013 –) — verify
      // partial-json handles multi-byte chars without corruption.
      const truncated =
        '{"path":"x.html","content":"<td>SSD‑backed DiskANN</td><td>5–20ms</td><td>Up to 500M vectors</td><td>NVMe';
      const out = parseToolInputWithSalvage(truncated);
      expect(out.path).toBe('x.html');
      expect((out.content as string)).toContain('SSD‑backed');
      expect((out.content as string)).toContain('5–20ms');
    });

    it('recovers when truncated immediately after a key colon', () => {
      const out = parseToolInputWithSalvage('{"path":"/tmp/x","content":');
      expect(out.path).toBe('/tmp/x');
      // partial-json drops the dangling unset value
      expect(out).not.toHaveProperty('content');
    });

    it('recovers when truncated mid-array element', () => {
      const out = parseToolInputWithSalvage('{"items":["a","b","ccc');
      expect(Array.isArray(out.items)).toBe(true);
      const items = out.items as string[];
      expect(items[0]).toBe('a');
      expect(items[1]).toBe('b');
      // partial-json closes the open string; the partial third element is preserved
      expect(items[2]).toBe('ccc');
    });

    it('recovers when truncated immediately after an opening brace', () => {
      const out = parseToolInputWithSalvage('{');
      expect(out).toEqual({});
    });
  });

  describe('garbage / empty fallback', () => {
    it('returns {} for completely unparseable input', () => {
      expect(parseToolInputWithSalvage('not even json at all }}}')).toEqual({});
    });

    it('returns {} for empty string', () => {
      expect(parseToolInputWithSalvage('')).toEqual({});
    });

    it('returns {} for undefined', () => {
      expect(parseToolInputWithSalvage(undefined)).toEqual({});
    });

    it('returns {} for null', () => {
      expect(parseToolInputWithSalvage(null)).toEqual({});
    });
  });

  describe('non-object JSON values', () => {
    it('returns {} for top-level array (tool_use input must be object-shaped)', () => {
      // Strict parse succeeds but the result is an array — the caller
      // contract is `Record<string, unknown>` so we coerce to {}.
      expect(parseToolInputWithSalvage('[1,2,3]')).toEqual({});
    });

    it('returns {} for top-level primitive', () => {
      expect(parseToolInputWithSalvage('42')).toEqual({});
      expect(parseToolInputWithSalvage('"just a string"')).toEqual({});
      expect(parseToolInputWithSalvage('true')).toEqual({});
      expect(parseToolInputWithSalvage('null')).toEqual({});
    });
  });

  describe('tracked variant: salvaged flag', () => {
    it('strict complete JSON → salvaged:false', () => {
      expect(parseToolInputWithSalvageTracked('{"a":1}')).toEqual({ value: { a: 1 }, salvaged: false });
    });

    it('empty / undefined / null → salvaged:false (not a truncation)', () => {
      expect(parseToolInputWithSalvageTracked('')).toEqual({ value: {}, salvaged: false });
      expect(parseToolInputWithSalvageTracked(undefined)).toEqual({ value: {}, salvaged: false });
      expect(parseToolInputWithSalvageTracked(null)).toEqual({ value: {}, salvaged: false });
    });

    it('strict-parse success coerced to {} (array/primitive) → salvaged:false', () => {
      // strict JSON.parse succeeded; the {} is a shape coercion, NOT salvage.
      expect(parseToolInputWithSalvageTracked('[1,2,3]')).toEqual({ value: {}, salvaged: false });
      expect(parseToolInputWithSalvageTracked('42')).toEqual({ value: {}, salvaged: false });
    });

    it('truncated mid-string → salvaged:true with recovered prefix', () => {
      const out = parseToolInputWithSalvageTracked('{"path":"/tmp/x","content":"<html><h1>partial');
      expect(out.salvaged).toBe(true);
      expect(out.value.path).toBe('/tmp/x');
      expect((out.value.content as string)).toContain('<html><h1>partial');
    });

    it('total garbage → salvaged:true with {} value', () => {
      expect(parseToolInputWithSalvageTracked('not even json at all }}}')).toEqual({ value: {}, salvaged: true });
    });

    it('parseToolInputWithSalvage delegates to tracked .value (back-compat)', () => {
      expect(parseToolInputWithSalvage('{"a":1}')).toEqual(parseToolInputWithSalvageTracked('{"a":1}').value);
    });
  });

  describe('debug logging', () => {
    it('warns once when salvage path is taken with KODAX_DEBUG_TOOL_STREAM set', () => {
      process.env.KODAX_DEBUG_TOOL_STREAM = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseToolInputWithSalvage('{"a":"unterminated');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('Tool Block Salvaged');
    });

    it('stays silent on strict-parse path even with debug flag set', () => {
      process.env.KODAX_DEBUG_TOOL_STREAM = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseToolInputWithSalvage('{"a":1}');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
