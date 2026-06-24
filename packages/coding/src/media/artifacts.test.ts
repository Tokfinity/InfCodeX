import { describe, expect, it } from 'vitest';

import { buildPromptMessageContent } from '../agent-runtime/prompt-content.js';
import {
  createImageArtifactFromPath,
  inferImageMediaType,
} from './artifacts.js';

describe('media artifacts', () => {
  it.each([
    ['diagram.png', 'image/png'],
    ['diagram.jpg', 'image/jpeg'],
    ['diagram.jpeg', 'image/jpeg'],
    ['diagram.webp', 'image/webp'],
    ['diagram.gif', 'image/gif'],
    ['diagram.bmp', undefined],
  ] as const)('infers %s as %s', (filePath, expected) => {
    expect(inferImageMediaType(filePath)).toBe(expected);
  });

  it('creates an image artifact with optional Space provenance', () => {
    const artifact = createImageArtifactFromPath('C:/space/session/shot.JPG', {
      source: 'clipboard',
      description: 'clipboard screenshot',
    });
    expect(artifact).toEqual({
      kind: 'image',
      path: 'C:/space/session/shot.JPG',
      mediaType: 'image/jpeg',
      source: 'clipboard',
      description: 'clipboard screenshot',
    });
  });

  it('keeps source optional and preserves prompt image order', () => {
    const first = createImageArtifactFromPath('/tmp/a.png');
    const second = createImageArtifactFromPath('/tmp/b.webp', {
      source: 'drag-drop',
    });

    expect(first.source).toBeUndefined();
    expect(buildPromptMessageContent('compare', [first, second])).toEqual([
      { type: 'text', text: 'compare' },
      { type: 'image', path: '/tmp/a.png', mediaType: 'image/png' },
      { type: 'image', path: '/tmp/b.webp', mediaType: 'image/webp' },
    ]);
  });
});
