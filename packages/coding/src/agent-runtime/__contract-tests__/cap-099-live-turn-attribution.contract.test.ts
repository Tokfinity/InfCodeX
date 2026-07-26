/**
 * Contract test for CAP-099: live turn attribution.
 *
 * Test obligations:
 * - CAP-LIVE-TURN-001: shared wrapper stamps sessionId / seq / turnId /
 *   deliveryId / timestamp onto live callbacks.
 * - CAP-LIVE-TURN-002: explicit turn boundary events use the same sequence.
 *
 * Risk: HIGH — SDK hosts route streamed assistant events to user bubbles by
 * turn ownership; ordering-by-observation is too fragile for local UI notices.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createLiveTurnScope,
  emitTurnCompleted,
  emitTurnFailed,
  emitTurnStarted,
  withLiveTurnAttribution,
} from '../event-emitter.js';
import type { KodaXActivityEventMeta, KodaXEvents } from '../../types.js';

describe('CAP-099: live turn attribution', () => {
  it('mints 64-bit random turn and delivery ids by default', () => {
    const scope = createLiveTurnScope({
      sessionId: 'session-generated',
    });

    expect(scope.turnId).toMatch(/^turn_[0-9a-f]{16}$/);
    expect(scope.deliveryId).toMatch(/^delivery_[0-9a-f]{16}$/);
    expect(scope.nextMeta()).toMatchObject({
      contextId: 'session-generated',
      contextKind: 'root',
      contextRevision: 0,
    });
  });

  it('keeps child ownership stable and advances only that context on commit', () => {
    const onCompactStats = vi.fn();
    const onCompactedMessages = vi.fn();
    const onIterationStart = vi.fn();
    const scope = createLiveTurnScope({
      sessionId: 'session-context',
      contextId: 'session-context/child/reviewer',
      contextKind: 'child',
      parentContextId: 'session-context',
      agentId: 'reviewer',
    });
    const events = withLiveTurnAttribution({
      onCompactStats,
      onCompactedMessages,
      onIterationStart,
    }, scope);

    events.onCompactStats?.({ tokensBefore: 1_000, tokensAfter: 400 });
    events.onCompactedMessages?.([{ role: 'user', content: 'checkpoint' }]);
    events.onIterationStart?.(2, 10);

    expect(onCompactStats).toHaveBeenCalledWith(expect.objectContaining({
      contextId: 'session-context/child/reviewer',
      contextKind: 'child',
      parentContextId: 'session-context',
      agentId: 'reviewer',
      contextRevision: 0,
    }));
    expect(onCompactedMessages).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      expect.objectContaining({ contextRevision: 1 }),
    );
    expect(onIterationStart).toHaveBeenCalledWith(
      2,
      10,
      expect.objectContaining({ contextRevision: 1 }),
    );
  });

  it('rolls back the context revision when the compaction commit is rejected', async () => {
    const observedRevisions: number[] = [];
    const scope = createLiveTurnScope({ sessionId: 'session-rejected-compaction' });
    const rejected = withLiveTurnAttribution({
      onCompactedMessages: async (_messages, _update, meta) => {
        observedRevisions.push(meta?.contextRevision ?? -1);
        throw new Error('durability failed');
      },
    }, scope);

    await expect(rejected.onCompactedMessages?.([
      { role: 'user', content: 'checkpoint' },
    ])).rejects.toThrow('durability failed');

    const onIterationStart = vi.fn();
    withLiveTurnAttribution({ onIterationStart }, scope).onIterationStart?.(1, 1);
    expect(observedRevisions).toEqual([1]);
    expect(onIterationStart).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ contextRevision: 0 }),
    );
  });

  it('stamps live callbacks and turn boundaries with one session sequence', () => {
    const seenText: KodaXActivityEventMeta[] = [];
    const onTurnStarted = vi.fn();
    const onTurnCompleted = vi.fn();
    const baseEvents: KodaXEvents = {
      onTextDelta: (_text, meta) => {
        if (meta) seenText.push(meta);
      },
      onTurnStarted,
      onTurnCompleted,
    };
    const scope = createLiveTurnScope({
      sessionId: 'session-1',
      deliveryKind: 'initial',
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
    });
    const events = withLiveTurnAttribution(baseEvents, scope);

    emitTurnStarted(events, scope);
    events.onTextDelta?.('hello');
    emitTurnCompleted(events, scope, 'completed');

    expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'session-1',
      seq: 1,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      deliveryKind: 'initial',
      timestamp: expect.any(String),
    }));
    expect(seenText).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        seq: 2,
        turnId: 'turn-1',
        deliveryId: 'delivery-1',
        timestamp: expect.any(String),
      }),
    ]);
    expect(onTurnCompleted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'session-1',
      seq: 3,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      status: 'completed',
      timestamp: expect.any(String),
    }));

    const secondScope = createLiveTurnScope({
      sessionId: 'session-1',
      deliveryKind: 'queued',
      turnId: 'turn-2',
      deliveryId: 'delivery-2',
    });
    emitTurnStarted(events, secondScope);

    expect(onTurnStarted).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      seq: 4,
      turnId: 'turn-2',
      deliveryId: 'delivery-2',
      deliveryKind: 'queued',
    }));

    const secondEvents = withLiveTurnAttribution(events, secondScope);
    secondEvents.onTextDelta?.('again');

    expect(seenText.at(-1)).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      seq: 5,
      turnId: 'turn-2',
      deliveryId: 'delivery-2',
    }));
  });

  it('forwards prompt-cache diagnostics with live turn attribution', () => {
    const onPromptCacheDiagnostics = vi.fn();
    const scope = createLiveTurnScope({
      sessionId: 'session-cache-diagnostics',
      turnId: 'turn-cache-diagnostics',
      deliveryId: 'delivery-cache-diagnostics',
    });
    const events = withLiveTurnAttribution({ onPromptCacheDiagnostics }, scope);

    events.onPromptCacheDiagnostics?.({
      phase: 'request',
      requestId: 'request-1',
      requestedAt: '2026-07-26T00:00:00.000Z',
      provider: 'zai',
      model: 'glm-5.2',
      wireModel: 'glm-5.2',
      attempt: 1,
      systemPromptHash: 'system-hash',
      toolSchemaHash: 'tool-hash',
      messagePrefixHash: 'prefix-hash',
      messagePrefixCount: 2,
      requestMessagesHash: 'messages-hash',
      messageCount: 3,
      toolCount: 4,
    });

    expect(onPromptCacheDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
      sessionId: 'session-cache-diagnostics',
      turnId: 'turn-cache-diagnostics',
      deliveryId: 'delivery-cache-diagnostics',
      seq: 1,
    }));
  });

  it('uses the current scope for secondary activity events', () => {
    const todoMeta: KodaXActivityEventMeta[] = [];
    const iterationMeta: KodaXActivityEventMeta[] = [];
    const baseEvents: KodaXEvents = {
      onTodoUpdate: (_items, meta) => {
        if (meta) todoMeta.push(meta);
      },
      onIterationStart: (_iter, _maxIter, meta) => {
        if (meta) iterationMeta.push(meta);
      },
    };
    const firstScope = createLiveTurnScope({
      sessionId: 'session-secondary',
      deliveryKind: 'initial',
      turnId: 'turn-first',
      deliveryId: 'delivery-first',
    });
    const secondScope = createLiveTurnScope({
      sessionId: 'session-secondary',
      deliveryKind: 'queued',
      turnId: 'turn-second',
      deliveryId: 'delivery-second',
    });
    const scopeRef = { current: firstScope };
    const events = withLiveTurnAttribution(baseEvents, scopeRef);

    events.onIterationStart?.(1, 5);
    scopeRef.current = secondScope;
    events.onTodoUpdate?.([]);

    expect(iterationMeta).toEqual([
      expect.objectContaining({
        sessionId: 'session-secondary',
        seq: 1,
        turnId: 'turn-first',
        deliveryId: 'delivery-first',
      }),
    ]);
    expect(todoMeta).toEqual([
      expect.objectContaining({
        sessionId: 'session-secondary',
        seq: 2,
        turnId: 'turn-second',
        deliveryId: 'delivery-second',
      }),
    ]);
  });

  it('keeps independent sequence counters per session', () => {
    const sessionA = createLiveTurnScope({
      sessionId: 'session-a',
      turnId: 'turn-a',
      deliveryId: 'delivery-a',
    });
    const sessionB = createLiveTurnScope({
      sessionId: 'session-b',
      turnId: 'turn-b',
      deliveryId: 'delivery-b',
    });

    expect(sessionA.nextMeta()).toEqual(expect.objectContaining({
      sessionId: 'session-a',
      seq: 1,
    }));
    expect(sessionB.nextMeta()).toEqual(expect.objectContaining({
      sessionId: 'session-b',
      seq: 1,
    }));
    expect(sessionA.nextMeta()).toEqual(expect.objectContaining({
      sessionId: 'session-a',
      seq: 2,
    }));
  });

  it('continues the same session sequence after a long idle gap', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'));
      const first = createLiveTurnScope({
        sessionId: 'session-idle-resume',
        turnId: 'turn-before-idle',
        deliveryId: 'delivery-before-idle',
      });

      expect(first.nextMeta()).toEqual(expect.objectContaining({
        sessionId: 'session-idle-resume',
        seq: 1,
      }));

      vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
      const resumed = createLiveTurnScope({
        sessionId: 'session-idle-resume',
        turnId: 'turn-after-idle',
        deliveryId: 'delivery-after-idle',
      });

      expect(resumed.nextMeta()).toEqual(expect.objectContaining({
        sessionId: 'session-idle-resume',
        seq: 2,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits failed turn events with live metadata and serialized error details', () => {
    const onTurnFailed = vi.fn();
    const events: KodaXEvents = { onTurnFailed };
    const scope = createLiveTurnScope({
      sessionId: 'session-failed',
      deliveryKind: 'interrupt',
      turnId: 'turn-failed',
      deliveryId: 'delivery-failed',
    });
    const error = new Error('boom');
    error.name = 'CustomError';

    emitTurnFailed(events, scope, error);

    expect(onTurnFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'session-failed',
      seq: 1,
      turnId: 'turn-failed',
      deliveryId: 'delivery-failed',
      error: expect.objectContaining({
        name: 'CustomError',
        message: 'boom',
        stack: expect.any(String),
      }),
    }));
  });
});
