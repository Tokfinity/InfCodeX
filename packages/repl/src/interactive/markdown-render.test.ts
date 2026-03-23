import { describe, expect, it } from 'vitest';
import { getHighlightKeywordPattern, renderMarkdown } from './markdown-render.js';

describe('markdown-render', () => {
  it('returns language-specific keyword patterns', () => {
    expect(getHighlightKeywordPattern('python')?.test('def handler():')).toBe(true);
    expect(getHighlightKeywordPattern('bash')?.test('if [ -f foo ]; then')).toBe(true);
    expect(getHighlightKeywordPattern('unknown')).toBeNull();
  });

  it('renders fenced code blocks with a language header', () => {
    const output = renderMarkdown('```python\ndef handler():\n  return 1\n```');

    expect(output).toContain('[python]');
    expect(output).toContain('handler');
  });
});
