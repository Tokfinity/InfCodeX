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
});
