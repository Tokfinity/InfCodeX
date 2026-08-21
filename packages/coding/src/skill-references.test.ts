import { describe, expect, it } from 'vitest';

import {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
  uniqueBareInlineSlashNames,
  uniqueInlineSkillNames,
} from './skill-references.js';

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
    expect(parseInlineSkillReferences('Path is /skill:foo/bar')).toEqual([]);
  });
});

describe('uniqueInlineSkillNames', () => {
  it('deduplicates names in textual order', () => {
    expect(
      uniqueInlineSkillNames('/workflow create using /skill:a then /skill:b then /skill:a'),
    ).toEqual(['a', 'b']);
  });
});

describe('parseBareInlineSlashReferences', () => {
  it('finds bare slash candidates without consuming /skill references', () => {
    expect(
      parseBareInlineSlashReferences('Use /feature-list-tracker and /skill:huashu-design.'),
    ).toEqual([
      { name: 'feature-list-tracker', raw: '/feature-list-tracker', start: 4, end: 25 },
    ]);
  });

  it('keeps namespaced bare slash candidates intact', () => {
    expect(
      parseBareInlineSlashReferences('Use /github:yeet before publishing.'),
    ).toEqual([
      { name: 'github:yeet', raw: '/github:yeet', start: 4, end: 16 },
    ]);
  });

  it('does not treat urls or path fragments as bare slash candidates', () => {
    expect(parseBareInlineSlashReferences('https://example.com/feature-list-tracker')).toEqual([]);
    expect(parseBareInlineSlashReferences('Path is dir/feature-list-tracker/file')).toEqual([]);
    expect(parseBareInlineSlashReferences('Path is /src/file.ts')).toEqual([]);
  });
});

describe('uniqueBareInlineSlashNames', () => {
  it('deduplicates bare slash candidates in textual order', () => {
    expect(
      uniqueBareInlineSlashNames('/workflow create using /a then /b then /a'),
    ).toEqual(['workflow', 'a', 'b']);
  });
});
