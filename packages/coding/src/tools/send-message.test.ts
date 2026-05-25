/**
 * Unit tests for `toolSendMessage`.
 *
 * Covers the FEATURE_120 Worker → child path AND the FEATURE_123
 * v0.7.44 peer-routing extensions:
 *   - Worker → child task_id (priority='user', <coordinator-instruction>)
 *   - child  → child task_id (priority='background', <peer-message from=A>)
 *   - child  → Worker        (priority='background', <child-notification from=A>)
 *   - any    → broadcast '*' (priority='background', <peer-broadcast from=…>)
 *   - self-targeted send rejected
 *   - broadcast cap enforced
 *   - send_message NO LONGER in CHILD_EXCLUDE_TOOLS_BASE
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext, KodaXChildExecutionResult } from '../types.js';
import type { ChildTaskRegistry } from '@kodax-ai/agent';

import { CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';

import { toolSendMessage } from './send-message.js';

function makeCtx(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/repo',
    executionCwd: '/tmp/repo',
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeRegistry(
  taskIds: readonly string[],
): ChildTaskRegistry<KodaXChildExecutionResult> {
  const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
  for (const id of taskIds) {
    registry.set(id, new Promise(() => {}));
  }
  return registry;
}

beforeEach(() => {
  _resetMessageQueueForTests();
});

// ---------- Worker → child (FEATURE_120 baseline preserved) ----------

describe('toolSendMessage — Worker → child task_id', () => {
  it('enqueues a coordinator-instruction at user priority + prompt mode', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: undefined,
    });

    const result = await toolSendMessage(
      { to: 'child-a', content: 'also check the auth module' },
      ctx,
    );

    expect(result).toMatch(/^Message sent to child-a/);

    const drained = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      agentId: 'child-a',
      priority: 'user',
      mode: 'prompt',
    });
    expect(drained[0]?.content).toBe(
      '<coordinator-instruction>\nalso check the auth module\n</coordinator-instruction>',
    );
  });

  it('preserves multi-line content inside the tag', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-b']),
      currentAgentId: undefined,
    });

    await toolSendMessage(
      { to: 'child-b', content: 'line 1\nline 2\nline 3' },
      ctx,
    );

    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'user',
    });
    expect(drained[0]?.content).toBe(
      '<coordinator-instruction>\nline 1\nline 2\nline 3\n</coordinator-instruction>',
    );
  });
});

// ---------- Input validation ----------

describe('toolSendMessage — input validation', () => {
  it('rejects missing to', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ content: 'hi' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/to/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects empty to', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: '   ', content: 'hi' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects missing content', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: 'child-a' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/content/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects empty content', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: 'child-a', content: '   ' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(getMessageQueue().size()).toBe(0);
  });
});

// ---------- Whitelist invariant (FEATURE_123 inversion of FEATURE_120) ----------

describe('toolSendMessage — child whitelist', () => {
  it('is NOT in CHILD_EXCLUDE_TOOLS_BASE (FEATURE_123: children may send_message)', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).not.toContain('send_message');
  });
});

// ---------- Error paths (unknown task_id, missing registry) ----------

describe('toolSendMessage — error paths', () => {
  it('rejects unknown task_id', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: undefined,
    });
    const result = await toolSendMessage(
      { to: 'child-NOPE', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Unknown task_id/i);
    expect(result).toMatch(/child-NOPE/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects when childTaskRegistry is unavailable on a targeted send', async () => {
    const ctx = makeCtx({ childTaskRegistry: undefined });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/async dispatch|registry/i);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects self-send (1-hop cycle guard)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'note to self' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/yourself/i);
    expect(getMessageQueue().size()).toBe(0);
  });
});

// ---------- FEATURE_123: child → child peer ----------

describe('toolSendMessage — child → child peer (FEATURE_123)', () => {
  it('enqueues a peer-message at background priority, framing carries sender id', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });

    const result = await toolSendMessage(
      { to: 'child-b', content: 'I touched auth/middleware.ts — heads up' },
      ctx,
    );
    expect(result).toMatch(/^Peer message sent to child-b from child-a/);

    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      agentId: 'child-b',
      priority: 'background',
      mode: 'prompt',
    });
    expect(drained[0]?.content).toBe(
      '<peer-message from="child-a">\nI touched auth/middleware.ts — heads up\n</peer-message>',
    );
  });

  it('peer messages do not drain at user-only priority (Sleep-gated)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });

    await toolSendMessage({ to: 'child-b', content: 'hi peer' }, ctx);
    const userOnly = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'user',
    });
    expect(userOnly).toHaveLength(0);
  });

  it('rejects peer message to unknown task_id', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: 'child-a',
    });
    const result = await toolSendMessage(
      { to: 'child-ghost', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Unknown task_id/i);
    expect(getMessageQueue().size()).toBe(0);
  });
});

// ---------- FEATURE_123: child → Worker ----------

describe("toolSendMessage — child → Worker (to='worker')", () => {
  it('enqueues a child-notification at background priority on the worker channel (agentId=undefined)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: 'child-a',
      parentAgentId: undefined,
    });

    const result = await toolSendMessage(
      { to: 'worker', content: 'auth migration is half-done' },
      ctx,
    );
    expect(result).toMatch(/^Message sent to worker/);

    const drained = getMessageQueue().dequeue({
      agentId: undefined,
      maxPriority: 'background',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      priority: 'background',
      mode: 'task-notification',
    });
    expect(drained[0]?.agentId).toBeUndefined();
    expect(drained[0]?.content).toBe(
      '<child-notification from="child-a">\nauth migration is half-done\n</child-notification>',
    );
  });

  it('routes to the immediate parent agentId when caller is a grand-child', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'gc-1']),
      currentAgentId: 'gc-1',
      parentAgentId: 'child-a',
    });

    await toolSendMessage(
      { to: 'worker', content: 'reporting back to my parent' },
      ctx,
    );
    const drained = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.content).toMatch(/^<child-notification from="gc-1">/);
  });

  it("rejects when Worker itself sends to='worker' (no parent)", async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: undefined,
    });
    const result = await toolSendMessage(
      { to: 'worker', content: 'hi self' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/top of the agent tree/i);
    expect(getMessageQueue().size()).toBe(0);
  });
});

// ---------- FEATURE_123: broadcast `to: '*'` ----------

describe("toolSendMessage — broadcast `to: '*'`", () => {
  it('child broadcast goes to all siblings + the parent Worker (sender excluded)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b', 'child-c']),
      currentAgentId: 'child-a',
    });

    const result = await toolSendMessage(
      { to: '*', content: 'I found a conflict in db/migrations' },
      ctx,
    );
    expect(result).toMatch(/^Broadcast sent from child-a/);
    expect(result).toMatch(/3 target/);

    // 2 siblings + 1 parent = 3 enqueues
    const peerB = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    const peerC = getMessageQueue().dequeue({
      agentId: 'child-c',
      maxPriority: 'background',
    });
    const worker = getMessageQueue().dequeue({
      agentId: undefined,
      maxPriority: 'background',
    });
    expect(peerB).toHaveLength(1);
    expect(peerC).toHaveLength(1);
    expect(worker).toHaveLength(1);

    for (const m of [peerB[0], peerC[0], worker[0]]) {
      expect(m?.priority).toBe('background');
      expect(m?.content).toMatch(/^<peer-broadcast from="child-a">/);
      expect(m?.content).toMatch(/db\/migrations/);
    }
    // sender NOT enqueued to itself
    const sender = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    expect(sender).toHaveLength(0);
  });

  it('Worker broadcast goes to all children only (no self-Worker enqueue)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: undefined,
    });

    const result = await toolSendMessage(
      { to: '*', content: 'system update incoming' },
      ctx,
    );
    expect(result).toMatch(/2 target/);

    const peerA = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    const peerB = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    expect(peerA).toHaveLength(1);
    expect(peerB).toHaveLength(1);
    expect(peerA[0]?.content).toMatch(/^<peer-broadcast from="worker">/);

    // Worker did NOT enqueue to itself
    const worker = getMessageQueue().dequeue({
      agentId: undefined,
      maxPriority: 'background',
    });
    expect(worker).toHaveLength(0);
  });

  it('rejects broadcast when there are no recipients', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry([]),
      currentAgentId: undefined,
    });
    const result = await toolSendMessage(
      { to: '*', content: 'anyone?' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/zero recipients/i);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects broadcast over the 20-target cap', async () => {
    // 21 siblings + Worker (self) = 21 distinct recipients > 20
    const ids = Array.from({ length: 21 }, (_, i) => `c${i}`);
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(ids),
      currentAgentId: undefined,
    });
    const result = await toolSendMessage(
      { to: '*', content: 'too many' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/exceeds cap 20/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('grand-child broadcast deduplicates parent (one enqueue on worker channel, none on peer channel)', async () => {
    // Tree: Worker dispatched child-a; child-a dispatched gc-1. Grand-
    // child gc-1 broadcasts. Without de-dup, child-a would receive the
    // broadcast twice — once as a sibling, once on the worker channel.
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b', 'gc-1']),
      currentAgentId: 'gc-1',
      parentAgentId: 'child-a',
    });

    const result = await toolSendMessage(
      { to: '*', content: 'gc1 broadcasting' },
      ctx,
    );
    // Recipients: child-b (sibling), child-a (parent via worker
    // channel). gc-1 itself excluded. Total = 2.
    expect(result).toMatch(/2 target/);

    const aOnPeer = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
      mode: 'prompt',
    });
    const aOnWorker = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
      mode: 'task-notification',
    });
    const b = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    expect(aOnPeer).toHaveLength(0);
    expect(aOnWorker).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(aOnWorker[0]?.content).toMatch(/^<peer-broadcast from="gc-1">/);
    expect(b[0]?.content).toMatch(/^<peer-broadcast from="gc-1">/);
  });

  it('rejects broadcast when registry is absent', async () => {
    const ctx = makeCtx({ childTaskRegistry: undefined });
    const result = await toolSendMessage(
      { to: '*', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/sibling registry/i);
    expect(getMessageQueue().size()).toBe(0);
  });
});
