import { describe, expect, it } from 'vitest';
import { parseCommand, parseInlineSkillReferences } from './commands.js';

describe('parseCommand', () => {
  it('supports colon-style inline arguments for regular commands', () => {
    expect(parseCommand('/reasoning:auto')).toEqual({
      command: 'reasoning',
      args: ['auto'],
    });
  });

  it('preserves existing /skill:name behavior', () => {
    expect(parseCommand('/skill:smart-context compact now')).toEqual({
      command: 'skill',
      args: ['compact', 'now'],
      skillInvocation: { name: 'smart-context' },
    });
  });

  it('parses direct slash skill names as ordinary command candidates', () => {
    expect(parseCommand('/smart-context compact now')).toEqual({
      command: 'smart-context',
      args: ['compact', 'now'],
    });
  });
});

describe('parseInlineSkillReferences (FEATURE_143 v0.7.36)', () => {
  it('returns [] for empty / non-string input', () => {
    expect(parseInlineSkillReferences('')).toEqual([]);
    expect(parseInlineSkillReferences('   ')).toEqual([]);
    expect(parseInlineSkillReferences(undefined as unknown as string)).toEqual([]);
  });

  it('returns [] when input is plain prose (no slash-skill references)', () => {
    expect(parseInlineSkillReferences('Please review the current diff')).toEqual([]);
  });

  it('defers to parseCommand for leading /skill:NAME (no inline match)', () => {
    expect(parseInlineSkillReferences('/skill:smart-context check this')).toEqual([]);
    expect(parseInlineSkillReferences('  /skill:foo')).toEqual([]);
  });

  it('captures a single mid-line /skill:NAME reference with offsets', () => {
    const input = 'Use /skill:feature-list-tracker to log this work';
    const matches = parseInlineSkillReferences(input);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      name: 'feature-list-tracker',
      raw: '/skill:feature-list-tracker',
      start: 4,
    });
  });

  it('captures multiple references in textual order', () => {
    const input = 'First /skill:a then /skill:b and /skill:c';
    const matches = parseInlineSkillReferences(input);
    expect(matches.map((m) => m.name)).toEqual(['a', 'b', 'c']);
  });

  it('does NOT match URL-style or path-style /skill: occurrences', () => {
    expect(
      parseInlineSkillReferences('See https://example.com/skill:foo for ref'),
    ).toEqual([]);
    expect(parseInlineSkillReferences('Path is dir/skill:foo/bar')).toEqual([]);
  });

  it('accepts dashes, dots, and underscores in skill names', () => {
    const matches = parseInlineSkillReferences(
      'Try /skill:smart-context.v2 or /skill:my_skill_name',
    );
    expect(matches.map((m) => m.name)).toEqual([
      'smart-context.v2',
      'my_skill_name',
    ]);
  });
});
