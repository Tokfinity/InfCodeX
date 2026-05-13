import { describe, expect, it } from 'vitest';
import parseKeypress, { extractBracketedPaste } from './parse-keypress.js';

describe('FEATURE_134 — bracketed paste detection', () => {
  describe('extractBracketedPaste', () => {
    it('returns null for plain text', () => {
      expect(extractBracketedPaste('hello world')).toBeNull();
    });

    it('returns null when no end marker present', () => {
      expect(extractBracketedPaste('\x1b[200~partial paste')).toBeNull();
    });

    it('returns null when sequence does not start with paste-start marker', () => {
      expect(extractBracketedPaste('xxx\x1b[200~content\x1b[201~')).toBeNull();
    });

    it('unwraps a complete bracketed paste envelope', () => {
      const wrapped = '\x1b[200~hello world\x1b[201~';
      expect(extractBracketedPaste(wrapped)).toBe('hello world');
    });

    it('unwraps an empty bracketed paste envelope (macOS Cmd+V with binary clipboard)', () => {
      const wrapped = '\x1b[200~\x1b[201~';
      expect(extractBracketedPaste(wrapped)).toBe('');
    });

    it('unwraps content containing newlines and special characters', () => {
      const wrapped = '\x1b[200~line1\nline2\t/path/to/file.png\x1b[201~';
      expect(extractBracketedPaste(wrapped)).toBe('line1\nline2\t/path/to/file.png');
    });

    it('does NOT unwrap when the end marker appears before paste content (defensive)', () => {
      // ESC[201~ appearing inside the paste content would terminate early —
      // this is the intended terminal behavior; we mirror it.
      const wrapped = '\x1b[200~before\x1b[201~after';
      expect(extractBracketedPaste(wrapped)).toBe('before');
    });
  });

  describe('parseKeypress paste path', () => {
    it('parses a complete bracketed paste as a single "paste" keypress', () => {
      const wrapped = '\x1b[200~/home/user/screenshot.png\x1b[201~';
      const result = parseKeypress(wrapped);
      expect(result.name).toBe('paste');
      expect(result.isPaste).toBe(true);
      expect(result.text).toBe('/home/user/screenshot.png');
      expect(result.sequence).toBe(wrapped);
      expect(result.isPrintable).toBe(false);
      // Modifiers default to false.
      expect(result.ctrl).toBe(false);
      expect(result.meta).toBe(false);
      expect(result.shift).toBe(false);
    });

    it('parses an empty bracketed paste (macOS Cmd+V empty paste signal)', () => {
      const result = parseKeypress('\x1b[200~\x1b[201~');
      expect(result.name).toBe('paste');
      expect(result.isPaste).toBe(true);
      expect(result.text).toBe('');
    });

    it('falls through to normal CSI parsing for unrelated escape sequences', () => {
      // ESC[A is the "up arrow" CSI sequence — must not be mistaken as paste.
      const result = parseKeypress('\x1b[A');
      expect(result.name).toBe('up');
      expect(result.isPaste).toBeUndefined();
    });

    it('falls through to plain text for printable characters', () => {
      const result = parseKeypress('a');
      expect(result.name).toBe('a');
      expect(result.isPaste).toBeUndefined();
    });

    it('treats incomplete paste (no end marker in chunk) as a fallthrough — v1 known limitation', () => {
      // v0.7.40 v1 scope: multi-chunk pastes (where the END marker arrives
      // in a later stdin 'data' event) are NOT buffered. The chunk falls
      // through to normal parsing. Documented in FEATURE_134 test guide.
      const result = parseKeypress('\x1b[200~partial-paste-no-end');
      expect(result.isPaste).toBeUndefined();
      // The fragment isn't a valid keypress either — falls into the
      // generic CSI fallthrough path.
      expect(result.name).not.toBe('paste');
    });

    it('paste containing absolute Windows path is preserved verbatim', () => {
      const wrapped = '\x1b[200~C:\\Users\\iceto\\Pictures\\screenshot.png\x1b[201~';
      const result = parseKeypress(wrapped);
      expect(result.text).toBe('C:\\Users\\iceto\\Pictures\\screenshot.png');
    });

    it('paste containing multiple paths separated by spaces is preserved verbatim', () => {
      const wrapped = '\x1b[200~/path/one.png /path/two.png\x1b[201~';
      const result = parseKeypress(wrapped);
      expect(result.text).toBe('/path/one.png /path/two.png');
    });
  });
});
