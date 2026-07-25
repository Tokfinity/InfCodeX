import { describe, expect, it } from 'vitest';

import { toKodaXInputArtifacts } from './input-artifacts.js';

describe('toKodaXInputArtifacts', () => {
  it('preserves image, video, and file metadata from queued input', () => {
    expect(toKodaXInputArtifacts([
      {
        kind: 'image',
        path: 'C:/tmp/shot.png',
        mediaType: 'image/png',
        source: 'clipboard',
        description: 'screen',
      },
      {
        kind: 'video',
        path: 'C:/tmp/demo.mp4',
        mediaType: 'video/mp4',
        name: 'demo',
        source: 'user-inline',
        description: 'recording',
      },
      {
        kind: 'file',
        path: 'C:/tmp/report.pdf',
        mediaType: 'application/pdf',
        mimeType: 'application/pdf',
        name: 'report.pdf',
        source: 'file-picker',
        description: 'report',
      },
    ])).toEqual([
      {
        kind: 'image',
        path: 'C:/tmp/shot.png',
        mediaType: 'image/png',
        source: 'clipboard',
        description: 'screen',
      },
      {
        kind: 'video',
        path: 'C:/tmp/demo.mp4',
        mediaType: 'video/mp4',
        name: 'demo',
        source: 'user-inline',
        description: 'recording',
      },
      {
        kind: 'file',
        path: 'C:/tmp/report.pdf',
        mediaType: 'application/pdf',
        mimeType: 'application/pdf',
        name: 'report.pdf',
        source: 'file-picker',
        description: 'report',
      },
    ]);
  });
});
