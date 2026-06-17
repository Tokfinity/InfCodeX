import { describe, expect, it } from 'vitest';

import { parseInlineSkillReferences, uniqueInlineSkillNames } from './skill-references.js';

describe('parseInlineSkillReferences', () => {
  it('returns no references for empty input', () => {
    expect(parseInlineSkillReferences('')).toEqual([]);
    expect(parseInlineSkillReferences('   ')).toEqual([]);
  });

  it('finds inline skill references in request text', () => {
    expect(
      parseInlineSkillReferences('Use /skill:huashu-design and /skill:feature-list-tracker.'),
    ).toEqual([
      { name: 'huashu-design', raw: '/skill:huashu-design', start: 4, end: 24 },
      { name: 'feature-list-tracker', raw: '/skill:feature-list-tracker', start: 29, end: 56 },
    ]);
  });

  it('finds leading skill references in workflow request text', () => {
    expect(
      parseInlineSkillReferences('/skill:feature-list-tracker add feature'),
    ).toEqual([
      { name: 'feature-list-tracker', raw: '/skill:feature-list-tracker', start: 0, end: 27 },
    ]);
  });

  it('does not treat urls or path fragments as skill references', () => {
    expect(parseInlineSkillReferences('https://example.com/skill:foo')).toEqual([]);
    expect(parseInlineSkillReferences('Path is dir/skill:foo/bar')).toEqual([]);
  });
});

describe('uniqueInlineSkillNames', () => {
  it('deduplicates names in textual order', () => {
    expect(
      uniqueInlineSkillNames('/workflow create using /skill:a then /skill:b then /skill:a'),
    ).toEqual(['a', 'b']);
  });
});
