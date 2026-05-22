/**
 * FEATURE_124 (v0.7.43) — frontmatter.ts unit tests.
 *
 * Contract verification: parser NEVER throws + degraded tolerance for
 * every malformed input shape we expect to see in production
 * (corrupted YAML, unknown type, multiple ---, missing frontmatter, etc.).
 */

import { describe, expect, it } from 'vitest';

import {
  parseMemoryFile,
  parseMemoryType,
  parseScalarFields,
} from './frontmatter.js';

describe('parseMemoryType', () => {
  it('accepts the 4 canonical types', () => {
    expect(parseMemoryType('user')).toBe('user');
    expect(parseMemoryType('feedback')).toBe('feedback');
    expect(parseMemoryType('project')).toBe('project');
    expect(parseMemoryType('reference')).toBe('reference');
  });

  it('returns undefined for unknown / mistyped values', () => {
    expect(parseMemoryType('User')).toBeUndefined(); // case-sensitive
    expect(parseMemoryType('feedbacks')).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
    expect(parseMemoryType(null)).toBeUndefined();
    expect(parseMemoryType(42)).toBeUndefined();
    expect(parseMemoryType({ type: 'user' })).toBeUndefined();
  });
});

describe('parseScalarFields', () => {
  it('parses bare key: value lines', () => {
    const result = parseScalarFields('name: Hello\ntype: user');
    expect(result).toEqual({ name: 'Hello', type: 'user' });
  });

  it('strips single quotes', () => {
    const result = parseScalarFields("name: 'Hello: world'");
    expect(result.name).toBe('Hello: world');
  });

  it('strips double quotes', () => {
    const result = parseScalarFields('name: "Hello: world"');
    expect(result.name).toBe('Hello: world');
  });

  it('skips comment lines', () => {
    const result = parseScalarFields('# comment\nname: Bob\n# another');
    expect(result).toEqual({ name: 'Bob' });
  });

  it('skips lines without a colon', () => {
    const result = parseScalarFields('garbage\nname: Bob\nmore garbage');
    expect(result).toEqual({ name: 'Bob' });
  });

  it('skips invalid keys', () => {
    const result = parseScalarFields('123key: value\n!nope: x\nvalid_key: ok');
    expect(result).toEqual({ valid_key: 'ok' });
  });

  it('handles empty values as undefined (omitted from result)', () => {
    const result = parseScalarFields('name:\nempty:   \ndescription: ok');
    expect(result).toEqual({ description: 'ok' });
  });

  it('handles \\r\\n line endings', () => {
    const result = parseScalarFields('name: Bob\r\ntype: user\r\n');
    expect(result).toEqual({ name: 'Bob', type: 'user' });
  });
});

describe('parseMemoryFile', () => {
  it('parses a well-formed memory file', () => {
    const raw = [
      '---',
      'name: No mock DB',
      'description: Q1 incident',
      'type: feedback',
      '---',
      '',
      'Body line 1',
      'Body line 2',
    ].join('\n');

    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter).toEqual({
      name: 'No mock DB',
      description: 'Q1 incident',
      type: 'feedback',
    });
    expect(parsed.body).toBe('Body line 1\nBody line 2');
  });

  it('handles missing frontmatter — all fields undefined, body = full input', () => {
    const raw = 'Just plain markdown\nNo frontmatter at all.';
    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter).toEqual({
      name: undefined,
      description: undefined,
      type: undefined,
    });
    expect(parsed.body).toBe(raw);
  });

  it('handles unknown type as undefined (degraded tolerance)', () => {
    const raw = [
      '---',
      'name: Stale',
      'type: wrongtype',
      '---',
      'body',
    ].join('\n');
    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter.name).toBe('Stale');
    expect(parsed.frontmatter.type).toBeUndefined();
  });

  it('handles only opening --- with no closing → treated as no frontmatter', () => {
    const raw = '---\nname: Broken\nnotype';
    const parsed = parseMemoryFile(raw);
    // The regex requires a closing ---, so this whole thing is body.
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.body).toBe(raw);
  });

  it('NEVER throws on garbage frontmatter content', () => {
    const garbage = '---\n{ this is not yaml at all $$$\n---\nbody';
    expect(() => parseMemoryFile(garbage)).not.toThrow();
    const parsed = parseMemoryFile(garbage);
    // No parseable scalar fields → all undefined, body is preserved.
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.frontmatter.type).toBeUndefined();
    expect(parsed.body).toBe('body');
  });

  it('handles a triple --- block inside body (only matches first frontmatter)', () => {
    const raw = [
      '---',
      'name: Outer',
      'type: feedback',
      '---',
      'Body before',
      '---',
      'name: Nested',
      '---',
      'Body after',
    ].join('\n');
    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter.name).toBe('Outer');
    expect(parsed.frontmatter.type).toBe('feedback');
    expect(parsed.body).toContain('Body before');
    expect(parsed.body).toContain('Body after');
  });

  it('handles \\r\\n line endings in frontmatter and body', () => {
    const raw = '---\r\nname: Win\r\ntype: user\r\n---\r\nBody on Windows';
    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter.name).toBe('Win');
    expect(parsed.frontmatter.type).toBe('user');
    expect(parsed.body).toBe('Body on Windows');
  });

  it('handles empty file', () => {
    const parsed = parseMemoryFile('');
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.body).toBe('');
  });

  it('handles frontmatter-only file (no body)', () => {
    const raw = '---\nname: Only\ntype: user\n---\n';
    const parsed = parseMemoryFile(raw);
    expect(parsed.frontmatter.name).toBe('Only');
    expect(parsed.body).toBe('');
  });
});
