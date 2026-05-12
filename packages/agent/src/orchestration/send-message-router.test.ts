/**
 * Unit tests for `routeMessage` — the generic cross-agent send-message
 * router primitive (FEATURE_120 v0.7.39 Phase 2a).
 *
 * Contract pinned by these tests:
 *   1. Known target → `{ok: true, messageId}`; queue gains exactly one
 *      message addressed to `to` carrying the given priority/mode/content.
 *   2. Unknown target → `{ok: false, reason: 'unknown-target', to}`;
 *      queue is untouched.
 *   3. Priority + mode + content + agentId are forwarded verbatim — the
 *      router does NOT wrap or rewrite the payload (callers own framing).
 *   4. messageId is the value returned by `MessageQueue.enqueue`.
 *   5. Multiple sends to the same agent stack as separate queue entries
 *      (no dedup); ordering follows enqueue order.
 *   6. Messages addressed to other agents are not perturbed by a route
 *      that fails the registry check.
 */

import { describe, expect, it } from 'vitest';

import { MessageQueue } from '../messaging/queue.js';

import { routeMessage } from './send-message-router.js';

interface RegistryValue {
  readonly placeholder: true;
}

describe('routeMessage — happy path', () => {
  it('returns ok + enqueues exactly one message for a known target', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-a', { placeholder: true }],
    ]);

    const result = routeMessage({
      to: 'child-a',
      priority: 'user',
      mode: 'prompt',
      content: 'hello child-a',
      registry,
      queue,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^msg-\d+$/);
    }

    expect(queue.size()).toBe(1);
    const drained = queue.dequeue({ agentId: 'child-a', maxPriority: 'background' });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      agentId: 'child-a',
      priority: 'user',
      mode: 'prompt',
      content: 'hello child-a',
    });
  });

  it('forwards background priority + system-reminder mode verbatim', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-b', { placeholder: true }],
    ]);

    routeMessage({
      to: 'child-b',
      priority: 'background',
      mode: 'system-reminder',
      content: '<reminder>graceful exit</reminder>',
      registry,
      queue,
    });

    const drained = queue.dequeue({ agentId: 'child-b', maxPriority: 'background' });
    expect(drained[0]).toMatchObject({
      priority: 'background',
      mode: 'system-reminder',
      content: '<reminder>graceful exit</reminder>',
    });
  });

  it('returns the messageId from MessageQueue.enqueue', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-c', { placeholder: true }],
    ]);

    // Enqueue a noise message first to advance the seq counter.
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'noise' });

    const result = routeMessage({
      to: 'child-c',
      priority: 'user',
      mode: 'prompt',
      content: 'real',
      registry,
      queue,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Noise consumed `msg-1`; routed message gets `msg-2`.
      expect(result.messageId).toBe('msg-2');
    }
  });
});

describe('routeMessage — unknown target', () => {
  it('returns unknown-target + leaves queue untouched', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-a', { placeholder: true }],
    ]);

    const result = routeMessage({
      to: 'child-NOPE',
      priority: 'user',
      mode: 'prompt',
      content: 'shouldnt arrive',
      registry,
      queue,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-target');
      expect(result.to).toBe('child-NOPE');
    }
    expect(queue.size()).toBe(0);
  });

  it('does not perturb messages addressed to other agents on a failed route', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-a', { placeholder: true }],
    ]);

    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      agentId: 'child-a',
      content: 'pre-existing for child-a',
    });

    const result = routeMessage({
      to: 'child-MISSING',
      priority: 'user',
      mode: 'prompt',
      content: 'will fail',
      registry,
      queue,
    });

    expect(result.ok).toBe(false);
    expect(queue.size()).toBe(1);
    const drained = queue.dequeue({ agentId: 'child-a', maxPriority: 'user' });
    expect(drained[0]?.content).toBe('pre-existing for child-a');
  });
});

describe('routeMessage — stacking + ordering', () => {
  it('stacks multiple sends to the same agent in enqueue order', () => {
    const queue = new MessageQueue();
    const registry = new Map<string, RegistryValue>([
      ['child-d', { placeholder: true }],
    ]);

    routeMessage({
      to: 'child-d',
      priority: 'user',
      mode: 'prompt',
      content: 'first',
      registry,
      queue,
    });
    routeMessage({
      to: 'child-d',
      priority: 'user',
      mode: 'prompt',
      content: 'second',
      registry,
      queue,
    });
    routeMessage({
      to: 'child-d',
      priority: 'user',
      mode: 'prompt',
      content: 'third',
      registry,
      queue,
    });

    const drained = queue.dequeue({ agentId: 'child-d', maxPriority: 'user' });
    expect(drained.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });
});
