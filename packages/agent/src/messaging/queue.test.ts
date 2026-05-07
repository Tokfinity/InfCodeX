/**
 * Tests for FEATURE_115 (v0.7.36) — agentId-scoped 2-tier priority queue.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MessageQueue,
  _resetMessageQueueForTests,
  getMessageQueue,
} from './queue.js';

describe('MessageQueue', () => {
  describe('enqueue + dequeue basics', () => {
    it('returns empty array when queue is empty', () => {
      const q = new MessageQueue();
      expect(q.dequeue({ maxPriority: 'background' })).toEqual([]);
    });

    it('drains in FIFO order within same priority', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });
      const drained = q.dequeue({ maxPriority: 'user' });
      expect(drained.map((m) => m.content)).toEqual(['a', 'b', 'c']);
      expect(q.size()).toBe(0);
    });

    it('returns assigned id from enqueue (msg-<seq> format)', () => {
      const q = new MessageQueue();
      const id1 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const id2 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      expect(id1).toBe('msg-1');
      expect(id2).toBe('msg-2');
    });

    it('removes drained messages from queue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(q.size()).toBe(1);
      q.dequeue({ maxPriority: 'user' });
      expect(q.size()).toBe(0);
    });

    it('records enqueuedAt timestamp', () => {
      const q = new MessageQueue();
      const before = Date.now();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user' });
      const after = Date.now();
      expect(drained[0]?.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(drained[0]?.enqueuedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('priority ordering (user > background)', () => {
    it('user priority drains before background regardless of enqueue order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-1' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-1' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-2' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-2' });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual([
        'user-1',
        'user-2',
        'bg-1',
        'bg-2',
      ]);
    });

    it('maxPriority=user only drains user, leaves background in queue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });

      const drained = q.dequeue({ maxPriority: 'user' });
      expect(drained.map((m) => m.content)).toEqual(['user']);
      expect(q.size()).toBe(1);

      const remaining = q.dequeue({ maxPriority: 'background' });
      expect(remaining.map((m) => m.content)).toEqual(['bg']);
    });

    it('maxPriority=background drains both tiers in user-first order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });
      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['user', 'bg']);
    });
  });

  describe('agentId routing', () => {
    it('main thread (filter agentId=undefined) only drains undefined-agentId messages', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'sub',
        agentId: 'sub-1',
      });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['main']);
      expect(q.size()).toBe(1);
    });

    it('subagent only drains its own messages', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'for-sub-1',
        agentId: 'sub-1',
      });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'for-sub-2',
        agentId: 'sub-2',
      });

      const drained = q.dequeue({ agentId: 'sub-1', maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['for-sub-1']);
      expect(q.size()).toBe(2);
    });

    it('different agents do not see each other messages even at user priority', () => {
      const q = new MessageQueue();
      q.enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'for-sub-1',
        agentId: 'sub-1',
      });
      const drainedSub2 = q.dequeue({
        agentId: 'sub-2',
        maxPriority: 'user',
      });
      expect(drainedSub2).toEqual([]);
      expect(q.size()).toBe(1);
    });
  });

  describe('limit', () => {
    it('limit caps drain count, leaves leftover in original FIFO order', () => {
      const q = new MessageQueue();
      for (let i = 0; i < 5; i++) {
        q.enqueue({ priority: 'user', mode: 'prompt', content: `m${i}` });
      }
      const first = q.dequeue({ maxPriority: 'user', limit: 2 });
      expect(first.map((m) => m.content)).toEqual(['m0', 'm1']);
      expect(q.size()).toBe(3);

      const rest = q.dequeue({ maxPriority: 'user' });
      expect(rest.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);
    });

    it('limit cap of 0 drains nothing', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user', limit: 0 });
      expect(drained).toEqual([]);
      expect(q.size()).toBe(1);
    });

    it('limit larger than available returns all matching', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user', limit: 10 });
      expect(drained.map((m) => m.content)).toEqual(['a']);
    });
  });

  describe('peek / count / has', () => {
    it('peek returns matching without removing', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const peeked = q.peek({ maxPriority: 'user' });
      expect(peeked.map((m) => m.content)).toEqual(['a']);
      expect(q.size()).toBe(1);
    });

    it('peek returns user-first priority order matching dequeue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-1' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-1' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-2' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-2' });

      // peek must yield the same order dequeue would (user-first FIFO),
      // so a caller can `peek` to decide whether to actually drain.
      const peeked = q.peek({ maxPriority: 'background' });
      expect(peeked.map((m) => m.content)).toEqual([
        'user-1',
        'user-2',
        'bg-1',
        'bg-2',
      ]);
      expect(q.size()).toBe(4);
    });

    it('peek with limit takes the first N in priority order, not insertion order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });

      const peeked = q.peek({ maxPriority: 'background', limit: 1 });
      expect(peeked.map((m) => m.content)).toEqual(['user']);
    });

    it('count returns matching count', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'b' });
      expect(q.count({ maxPriority: 'user' })).toBe(1);
      expect(q.count({ maxPriority: 'background' })).toBe(2);
    });

    it('has returns false on empty, true after enqueue', () => {
      const q = new MessageQueue();
      expect(q.has({ maxPriority: 'background' })).toBe(false);
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(q.has({ maxPriority: 'user' })).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all messages across all priorities/agents', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'b',
        agentId: 'sub-1',
      });
      q.clear();
      expect(q.size()).toBe(0);
    });
  });

  describe('mode tagging', () => {
    it('preserves prompt / task-notification / system-reminder modes', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'p' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'tn' });
      q.enqueue({ priority: 'background', mode: 'system-reminder', content: 'sr' });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.mode)).toEqual([
        'prompt',
        'task-notification',
        'system-reminder',
      ]);
    });
  });
});

describe('getMessageQueue (process-global singleton)', () => {
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('returns the same instance on repeated calls', () => {
    const q1 = getMessageQueue();
    const q2 = getMessageQueue();
    expect(q1).toBe(q2);
  });

  it('persists state across getMessageQueue() calls', () => {
    getMessageQueue().enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'persistent',
    });
    expect(getMessageQueue().size()).toBe(1);
  });

  it('_resetMessageQueueForTests creates a fresh instance on next call', () => {
    const before = getMessageQueue();
    before.enqueue({ priority: 'user', mode: 'prompt', content: 'old' });
    _resetMessageQueueForTests();
    const after = getMessageQueue();
    expect(after).not.toBe(before);
    expect(after.size()).toBe(0);
  });
});
