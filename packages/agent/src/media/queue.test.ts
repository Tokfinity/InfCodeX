import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetActiveRootQueueRoutesForTests,
  _resetMessageQueueForTests,
  actorQueueId,
  getMessageQueue,
  registerActiveRootQueueRoute,
} from '../messaging/index.js';

import {
  KodaXMediaError,
  enqueueWithArtifacts,
} from './index.js';

describe('enqueueWithArtifacts', () => {
  afterEach(() => {
    _resetMessageQueueForTests();
    _resetActiveRootQueueRoutesForTests();
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

  it('keeps the legacy unscoped route when no Actor session is active', () => {
    enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'legacy follow-up',
    });

    expect(getMessageQueue().dequeue({
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);
  });

  it('automatically binds legacy helper calls to the only active Actor root', () => {
    const agentId = actorQueueId('session-a', '/root');
    const release = registerActiveRootQueueRoute(agentId);

    enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'scoped follow-up',
    });

    expect(getMessageQueue().dequeue({
      agentId,
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);
    release();
  });

  it('allows an explicit session route when multiple Actor roots are active', () => {
    const sessionA = actorQueueId('session-a', '/root');
    const sessionB = actorQueueId('session-b', '/root');
    const releaseA = registerActiveRootQueueRoute(sessionA);
    const releaseB = registerActiveRootQueueRoute(sessionB);

    enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'session B follow-up',
      sessionId: 'session-b',
    });

    expect(getMessageQueue().dequeue({
      agentId: sessionA,
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(0);
    expect(getMessageQueue().dequeue({
      agentId: sessionB,
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);
    releaseB();
    releaseA();
  });

  it('rejects an ambiguous legacy helper call instead of crossing sessions', () => {
    const releaseA = registerActiveRootQueueRoute(actorQueueId('session-a', '/root'));
    const releaseB = registerActiveRootQueueRoute(actorQueueId('session-b', '/root'));

    expect(() => enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'ambiguous follow-up',
    })).toThrow(/multiple Actor root sessions are active/i);
    expect(getMessageQueue().size()).toBe(0);
    releaseB();
    releaseA();
  });

  it('reference-counts repeated registration of the same Actor root', () => {
    const agentId = actorQueueId('session-a', '/root');
    const releaseFirst = registerActiveRootQueueRoute(agentId);
    const releaseSecond = registerActiveRootQueueRoute(agentId);
    releaseFirst();

    enqueueWithArtifacts({
      provider: 'kimi',
      model: 'k2.6',
      content: 'still scoped',
    });
    expect(getMessageQueue().dequeue({
      agentId,
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);

    releaseSecond();
  });
});
