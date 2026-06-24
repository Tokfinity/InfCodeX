import { describe, expect, it } from 'vitest';

import type { KodaXInputArtifact } from '../types.js';
import {
  KodaXMediaError,
  validateInputArtifactsForModel,
} from './index.js';

describe('validateInputArtifactsForModel', () => {
  it('accepts supported image artifacts', () => {
    const artifacts: KodaXInputArtifact[] = [
      {
        kind: 'image',
        path: '/tmp/shot.png',
        mediaType: 'image/png',
        source: 'clipboard',
      },
    ];
    expect(() => validateInputArtifactsForModel(artifacts, {
      provider: 'kimi',
      model: 'k2.6',
    })).not.toThrow();
  });

  it('rejects text-only providers before send', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'image',
        path: '/tmp/shot.png',
        mediaType: 'image/png',
      },
    ], {
      provider: 'codex-cli',
    })).toThrow(KodaXMediaError);

    try {
      validateInputArtifactsForModel([
        {
          kind: 'image',
          path: '/tmp/shot.png',
          mediaType: 'image/png',
        },
      ], {
        provider: 'codex-cli',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('MODEL_INPUT_UNSUPPORTED');
    }
  });

  it('rejects unsupported image media types', () => {
    expect(() => validateInputArtifactsForModel([
      {
        kind: 'image',
        path: '/tmp/shot.bmp',
        mediaType: 'image/bmp',
      } as unknown as KodaXInputArtifact,
    ], {
      provider: 'kimi',
      model: 'k2.6',
    })).toThrow(KodaXMediaError);
  });

  it('fails closed for future video artifacts until runtime send path exists', () => {
    try {
      validateInputArtifactsForModel([
        {
          kind: 'video',
          path: '/tmp/movie.mp4',
          mediaType: 'video/mp4',
        } as unknown as KodaXInputArtifact,
      ], {
        provider: 'minimax-coding',
        model: 'MiniMax-M3',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(KodaXMediaError);
      expect((error as KodaXMediaError).code).toBe('MODEL_INPUT_UNSUPPORTED');
      expect((error as KodaXMediaError).detail).toContain('provider-native-unwired');
      return;
    }
    throw new Error('Expected validation to reject video artifacts');
  });
});
