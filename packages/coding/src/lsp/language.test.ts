import { describe, expect, it } from 'vitest';
import { LANGUAGE_EXTENSIONS, languageIdForPath } from './language.js';

describe('languageIdForPath', () => {
  it('maps the TypeScript/JavaScript family', () => {
    expect(languageIdForPath('a.ts')).toBe('typescript');
    expect(languageIdForPath('a.mts')).toBe('typescript');
    expect(languageIdForPath('a.cts')).toBe('typescript');
    expect(languageIdForPath('a.tsx')).toBe('typescriptreact');
    expect(languageIdForPath('a.js')).toBe('javascript');
    expect(languageIdForPath('a.mjs')).toBe('javascript');
    expect(languageIdForPath('a.jsx')).toBe('javascriptreact');
  });

  it('maps the Phase B/C languages', () => {
    expect(languageIdForPath('a.py')).toBe('python');
    expect(languageIdForPath('a.go')).toBe('go');
    expect(languageIdForPath('a.rs')).toBe('rust');
    expect(languageIdForPath('a.java')).toBe('java');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageIdForPath('A.TS')).toBe('typescript');
    expect(languageIdForPath('Main.PY')).toBe('python');
  });

  it('returns undefined for unknown or extension-less paths', () => {
    expect(languageIdForPath('a.txt')).toBeUndefined();
    expect(languageIdForPath('Makefile')).toBeUndefined();
    expect(languageIdForPath('noext')).toBeUndefined();
  });

  it('resolves a full path, not just a bare name', () => {
    expect(languageIdForPath('/abs/src/deep/mod.ts')).toBe('typescript');
  });

  it('exposes a frozen extension table', () => {
    expect(Object.isFrozen(LANGUAGE_EXTENSIONS)).toBe(true);
  });
});
