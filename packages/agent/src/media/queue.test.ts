import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from '../messaging/index.js';

import {
  KodaXMediaError,
  enqueueWithArtifacts,
} from './index.js';

describe('enqueueWithArtifacts', () => {
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('validates and preserves queued image artifacts', () => {
    const id = enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'compare this',
      inputArtifacts: [
        {
          kind: 'image',
          path: '/tmp/shot.png',
          mediaType: 'image/png',
          source: 'clipboard',
        },
      ],
    });

    expect(id).toBe('msg-1');
    const drained = getMessageQueue().dequeue({
      maxPriority: 'user',
      mode: 'prompt',
    });
    expect(drained[0]?.inputArtifacts).toEqual([
      {
        kind: 'image',
        path: '/tmp/shot.png',
        mediaType: 'image/png',
        source: 'clipboard',
      },
    ]);
  });

  it('rejects unsupported file artifacts before enqueueing', () => {
    expect(() => enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'read this file',
      inputArtifacts: [
        {
          kind: 'file',
          path: '/tmp/report.pdf',
          mediaType: 'application/pdf',
        },
      ],
    })).toThrow(KodaXMediaError);

    expect(getMessageQueue().size()).toBe(0);
  });
});
