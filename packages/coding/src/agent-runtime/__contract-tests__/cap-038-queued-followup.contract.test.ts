/**
 * Contract test for CAP-038: queued follow-up detection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *
 * Test obligations:
 * - CAP-QUEUED-FOLLOWUP-001: returns true when events has a queued follow-up pending
 * - CAP-QUEUED-FOLLOWUP-002 (FEATURE_159 v0.7.40): returns true when
 *   MessageQueue holds a main-thread `mode:'prompt'` user-priority entry
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/event-emitter.ts (extracted from
 * agent.ts:769-771 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: consulted at end-of-turn terminal decision
 * (4 call sites in agent.ts: success exit, COMPLETE signal, BLOCKED
 * signal, error path) PLUS the mid-turn-yield boundary in
 * `runner-driven.ts` (FEATURE_159 unification) to keep the loop running
 * when the host has a queued user input ready.
 *
 * FEATURE_159 v0.7.40: predicate now reads MessageQueue (the canonical
 * source of queued prompts) AS WELL AS `events.hasPendingInputs?.()`.
 * The events-path is kept for SDK consumers that implement custom
 * queueing without routing through MessageQueue. Strict `=== true`
 * comparison is still load-bearing on the events path.
 *
 * STATUS: ACTIVE since FEATURE_100 P2; widened in FEATURE_159 v0.7.40.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from '@kodax-ai/agent';

import type { KodaXEvents } from '../../types.js';
import { hasQueuedFollowUp } from '../event-emitter.js';

describe('CAP-038: hasQueuedFollowUp contract', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  describe('events.hasPendingInputs path (legacy, SDK-facing)', () => {
    it('CAP-QUEUED-FOLLOWUP-001a: events.hasPendingInputs returns true → true', () => {
      const events: KodaXEvents = { hasPendingInputs: () => true };
      expect(hasQueuedFollowUp(events)).toBe(true);
    });

    it('CAP-QUEUED-FOLLOWUP-001b: events.hasPendingInputs returns false + empty queue → false', () => {
      const events: KodaXEvents = { hasPendingInputs: () => false };
      expect(hasQueuedFollowUp(events)).toBe(false);
    });

    it('CAP-QUEUED-FOLLOWUP-001c: hasPendingInputs hook absent + empty queue → false', () => {
      expect(hasQueuedFollowUp({})).toBe(false);
    });

    it('CAP-QUEUED-FOLLOWUP-001d: strict `=== true` comparison rejects truthy non-boolean returns (host contract pins boolean)', () => {
      const events = {
        hasPendingInputs: () => 1 as unknown as boolean,
      } as unknown as KodaXEvents;
      // Queue is empty; non-strict-true value must NOT trigger continuation.
      expect(hasQueuedFollowUp(events)).toBe(false);
    });
  });

  // FEATURE_159 v0.7.40 — queue-aware predicate.
  describe('FEATURE_159 MessageQueue path (canonical)', () => {
    it('CAP-QUEUED-FOLLOWUP-002a: main-thread mode:"prompt" user-priority entry → true', () => {
      getMessageQueue().enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'queued prompt',
      });
      expect(hasQueuedFollowUp({})).toBe(true);
    });

    it('CAP-QUEUED-FOLLOWUP-002b: background-priority task-notification does NOT trigger (owned by idle-yield wake-drain, not mid-turn yield)', () => {
      getMessageQueue().enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: '<task-completed task_id="X"/>',
      });
      expect(hasQueuedFollowUp({})).toBe(false);
    });

    it('CAP-QUEUED-FOLLOWUP-002c: subagent-scoped (agentId set) entry does NOT trigger main-thread yield', () => {
      getMessageQueue().enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'sub-prompt',
        agentId: 'sub-1',
      });
      expect(hasQueuedFollowUp({})).toBe(false);
    });

    it('CAP-QUEUED-FOLLOWUP-002d: events.hasPendingInputs:false AND queue has prompt → still true (queue is canonical)', () => {
      getMessageQueue().enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'queued prompt',
      });
      const events: KodaXEvents = { hasPendingInputs: () => false };
      expect(hasQueuedFollowUp(events)).toBe(true);
    });
  });
});
