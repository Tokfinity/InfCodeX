import { describe, expect, it } from 'vitest';

import {
  createImageArtifactFromPath,
  getModelInputCapabilities,
} from '@kodax-ai/kodax/media';

describe('@kodax-ai/kodax/media SDK subpath', () => {
  it('exports artifact helpers and model input capabilities', () => {
    expect(createImageArtifactFromPath('/tmp/shot.webp')).toEqual({
      kind: 'image',
      path: '/tmp/shot.webp',
      mediaType: 'image/webp',
    });

    expect(getModelInputCapabilities({
      provider: 'minimax-coding',
      model: 'MiniMax-M3',
    }).image.status).toBe('supported');
  });
});
