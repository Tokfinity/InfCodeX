/**
 * Tests for FEATURE_115 v0.7.36 mid-turn drain decision.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  YIELD_TOOL_NAMES,
  enqueueChildTaskNotification,
  maybeDrainMidTurn,
  midTurnDrainPriority,
} from './drain.js';
import { _resetMessageQueueForTests, getMessageQueue } from './queue.js';

describe('midTurnDrainPriority', () => {
  it('returns "user" by default (no yield tool ran)', () => {
    expect(midTurnDrainPriority([])).toBe('user');
    expect(midTurnDrainPriority(['read', 'edit', 'bash'])).toBe('user');
  });

  it('returns "background" when await_child_task ran', () => {
    expect(midTurnDrainPriority(['await_child_task'])).toBe('background');
    expect(midTurnDrainPriority(['read', 'await_child_task', 'bash'])).toBe(
      'background',
    );
  });

  it('YIELD_TOOL_NAMES contains await_child_task', () => {
    expect(YIELD_TOOL_NAMES.has('await_child_task')).toBe(true);
  });
});

describe('maybeDrainMidTurn', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('drains only user priority when no yield tool ran', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'u' });
    queue.enqueue({ priority: 'background', mode: 'task-notification', content: 'b' });

    const drained = maybeDrainMidTurn({ lastTurnToolNames: ['read'] });
    expect(drained.map((m) => m.content)).toEqual(['u']);
    expect(queue.size()).toBe(1); // background remains
  });

  it('drains both priorities when await_child_task ran', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'u' });
    queue.enqueue({ priority: 'background', mode: 'task-notification', content: 'b' });

    const drained = maybeDrainMidTurn({
      lastTurnToolNames: ['await_child_task'],
    });
    expect(drained.map((m) => m.content)).toEqual(['u', 'b']);
    expect(queue.size()).toBe(0);
  });

  it('respects agentId scoping', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'sub',
      agentId: 'sub-1',
    });

    // Main agent (agentId undefined) only sees its own messages.
    const drainedMain = maybeDrainMidTurn({ lastTurnToolNames: [] });
    expect(drainedMain.map((m) => m.content)).toEqual(['main']);

    // Subagent only sees its own.
    const drainedSub = maybeDrainMidTurn({
      lastTurnToolNames: [],
      agentId: 'sub-1',
    });
    expect(drainedSub.map((m) => m.content)).toEqual(['sub']);
  });

  it('respects limit cap', () => {
    const queue = getMessageQueue();
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ priority: 'user', mode: 'prompt', content: `m${i}` });
    }

    const drained = maybeDrainMidTurn({ lastTurnToolNames: [], limit: 2 });
    expect(drained.map((m) => m.content)).toEqual(['m0', 'm1']);
    expect(queue.size()).toBe(3);
  });

  it('returns [] when nothing matches', () => {
    expect(maybeDrainMidTurn({ lastTurnToolNames: [] })).toEqual([]);
  });
});

describe('enqueueChildTaskNotification', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('enqueues with priority="background" + mode="task-notification"', () => {
    const id = enqueueChildTaskNotification({
      taskId: 'child-001',
      summary: 'all tests pass',
    });
    expect(id).toMatch(/^msg-\d+$/);

    const peeked = getMessageQueue().peek({ maxPriority: 'background' });
    expect(peeked).toHaveLength(1);
    expect(peeked[0]?.priority).toBe('background');
    expect(peeked[0]?.mode).toBe('task-notification');
    expect(peeked[0]?.content).toContain('<task-completed task_id="child-001">');
    expect(peeked[0]?.content).toContain('all tests pass');
  });

  it('routes to parentAgentId when supplied', () => {
    enqueueChildTaskNotification({
      parentAgentId: 'main-agent',
      taskId: 'child-002',
      summary: 'work done',
    });
    const queue = getMessageQueue();
    expect(
      queue.peek({ agentId: 'main-agent', maxPriority: 'background' }),
    ).toHaveLength(1);
    // Default-undefined target should NOT see it.
    expect(queue.peek({ maxPriority: 'background' })).toEqual([]);
  });

  it('user-priority drain (default) does NOT pick up task-notifications', () => {
    enqueueChildTaskNotification({
      taskId: 'child-003',
      summary: 'background only',
    });
    expect(maybeDrainMidTurn({ lastTurnToolNames: [] })).toEqual([]);
    // Still queued as background.
    expect(getMessageQueue().count({ maxPriority: 'background' })).toBe(1);
  });

  it('Sleep-gated drain (await_child_task ran) picks up the notification', () => {
    enqueueChildTaskNotification({
      taskId: 'child-004',
      summary: 'finally',
    });
    const drained = maybeDrainMidTurn({
      lastTurnToolNames: ['await_child_task'],
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.mode).toBe('task-notification');
  });
});
