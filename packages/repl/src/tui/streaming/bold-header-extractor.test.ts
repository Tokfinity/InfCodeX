/**
 * FEATURE_202 (v0.7.45) — bold-header-extractor tests.
 */
import { describe, expect, it } from 'vitest';

import { extractBoldHeader } from './bold-header-extractor.js';

describe('extractBoldHeader', () => {
  it('extracts the first closed **bold** pair', () => {
    expect(extractBoldHeader('**Analyzing dependencies** then I will...')).toEqual({
      header: 'Analyzing dependencies',
    });
  });

  it('returns the FIRST header when multiple are present', () => {
    expect(extractBoldHeader('**First topic** and later **Second topic**')).toEqual({
      header: 'First topic',
    });
  });

  it('returns empty when the ** pair is still unclosed', () => {
    expect(extractBoldHeader('**Analyzing dep')).toEqual({});
  });

  it('returns empty when there is no bold at all', () => {
    expect(extractBoldHeader('Let me think about this problem carefully.')).toEqual({});
  });

  it('trims whitespace inside the header', () => {
    expect(extractBoldHeader('**  Choosing approach  ** ...')).toEqual({
      header: 'Choosing approach',
    });
  });

  it('ignores an empty **** pair', () => {
    expect(extractBoldHeader('****  body')).toEqual({});
  });

  it('does not match a bold spanning a newline (not a topic header)', () => {
    expect(extractBoldHeader('**line one\nline two**')).toEqual({});
  });
});
