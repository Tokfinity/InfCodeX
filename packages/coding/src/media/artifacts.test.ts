import { describe, expect, it } from 'vitest';

import { buildPromptMessageContent } from '../agent-runtime/prompt-content.js';
import {
  createFileArtifactFromPath,
  createImageArtifactFromPath,
  createVideoArtifactFromPath,
  inferImageMediaType,
  inferVideoMediaType,
} from './artifacts.js';
import { KodaXMediaError } from './errors.js';

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

  it.each([
    ['movie.mp4', 'video/mp4'],
    ['movie.mov', 'video/quicktime'],
    ['movie.webm', 'video/webm'],
    ['movie.txt', undefined],
  ] as const)('infers %s as %s', (filePath, expected) => {
    expect(inferVideoMediaType(filePath)).toBe(expected);
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

  it('creates file and video artifacts with stable non-image contracts', () => {
    expect(createFileArtifactFromPath('/tmp/report.pdf', {
      mediaType: 'application/pdf',
      name: 'report.pdf',
      source: 'drag-drop',
    })).toEqual({
      kind: 'file',
      path: '/tmp/report.pdf',
      mediaType: 'application/pdf',
      name: 'report.pdf',
      source: 'drag-drop',
    });

    expect(createVideoArtifactFromPath('/tmp/demo.webm', {
      source: 'file-picker',
      description: 'screen recording',
    })).toEqual({
      kind: 'video',
      path: '/tmp/demo.webm',
      mediaType: 'video/webm',
      source: 'file-picker',
      description: 'screen recording',
    });
  });

  it('rejects video artifact construction when media type cannot be inferred', () => {
    expect(() => createVideoArtifactFromPath('/tmp/demo.bin')).toThrow(KodaXMediaError);
  });

  it('rejects file artifact construction when mediaType and mimeType disagree', () => {
    expect(() => createFileArtifactFromPath('/tmp/report.pdf', {
      mediaType: 'application/pdf',
      mimeType: 'text/plain',
    })).toThrow(KodaXMediaError);
  });
});
