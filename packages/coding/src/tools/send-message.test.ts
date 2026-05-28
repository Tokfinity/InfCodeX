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
      '<peer-message from="child-a" seen_by="child-a">\nI touched auth/middleware.ts — heads up\n</peer-message>',
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
      '<child-notification from="child-a" seen_by="child-a">\nauth migration is half-done\n</child-notification>',
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
    expect(drained[0]?.content).toMatch(/^<child-notification from="gc-1" seen_by="gc-1">/);
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
      expect(m?.content).toMatch(/^<peer-broadcast from="child-a" seen_by="child-a">/);
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
    expect(peerA[0]?.content).toMatch(/^<peer-broadcast from="worker" seen_by="worker">/);

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
    expect(aOnWorker[0]?.content).toMatch(/^<peer-broadcast from="gc-1" seen_by="gc-1">/);
    expect(b[0]?.content).toMatch(/^<peer-broadcast from="gc-1" seen_by="gc-1">/);
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

// ---------- FEATURE_123 v0.7.44 — per-turn flood throttle ----------

describe('toolSendMessage — per-turn flood throttle', () => {
  it('child cap = 5 outbound enqueues per turn (6th targeted send rejected)', async () => {
    const counter = { count: 0 };
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
      sendMessageTurnCounter: counter,
    });
    // 5 successful peer sends to child-b
    for (let i = 0; i < 5; i++) {
      const r = await toolSendMessage({ to: 'child-b', content: `msg ${i}` }, ctx);
      expect(r).toMatch(/^Peer message sent/);
    }
    expect(counter.count).toBe(5);
    // 6th rejected
    const r6 = await toolSendMessage({ to: 'child-b', content: 'msg 6' }, ctx);
    expect(r6).toMatch(/^\[Tool Error\]/);
    expect(r6).toMatch(/per-turn send_message limit reached/);
    expect(r6).toMatch(/cap 5/);
    expect(counter.count).toBe(5); // counter not incremented on reject
  });

  it('Worker cap = 20 outbound enqueues per turn (21st targeted send rejected)', async () => {
    const counter = { count: 0 };
    const childIds = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(childIds),
      currentAgentId: undefined,
      sendMessageTurnCounter: counter,
    });
    for (let i = 0; i < 20; i++) {
      const r = await toolSendMessage({ to: `c${i}`, content: 'hi' }, ctx);
      expect(r).toMatch(/^Message sent/);
    }
    expect(counter.count).toBe(20);
    const r21 = await toolSendMessage({ to: 'c20', content: 'overflow' }, ctx);
    expect(r21).toMatch(/^\[Tool Error\]/);
    expect(r21).toMatch(/per-turn send_message limit reached/);
    expect(r21).toMatch(/cap 20/);
  });

  it('broadcast charges N recipients against the counter in one call', async () => {
    const counter = { count: 0 };
    const ctx = makeCtx({
      // 5 siblings (excluding self) + Worker = 6 recipients > 5-cap
      childTaskRegistry: makeRegistry(['child-a', 'b', 'c', 'd', 'e', 'f']),
      currentAgentId: 'child-a',
      sendMessageTurnCounter: counter,
    });
    const r = await toolSendMessage({ to: '*', content: 'storm' }, ctx);
    expect(r).toMatch(/^\[Tool Error\]/);
    expect(r).toMatch(/per-turn send_message limit reached/);
    // No enqueues happened — throttle blocked pre-fanout
    expect(counter.count).toBe(0);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('mixes peer + broadcast charges against the same counter', async () => {
    const counter = { count: 0 };
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'b', 'c']),
      currentAgentId: 'child-a',
      sendMessageTurnCounter: counter,
    });
    // 2 peer sends + 1 broadcast (3 recipients) = 5 charges = exactly at cap
    await toolSendMessage({ to: 'b', content: 'one' }, ctx);
    await toolSendMessage({ to: 'c', content: 'two' }, ctx);
    const br = await toolSendMessage({ to: '*', content: 'three' }, ctx);
    expect(br).toMatch(/^Broadcast sent/);
    expect(counter.count).toBe(5);
    // Next single send overflows
    const r4 = await toolSendMessage({ to: 'b', content: 'four' }, ctx);
    expect(r4).toMatch(/per-turn send_message limit reached/);
  });

  it('throttle bypassed when counter is undefined (sync-mode dispatch)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'b']),
      currentAgentId: 'child-a',
      sendMessageTurnCounter: undefined,
    });
    // 10 sends — would exceed child cap = 5 with throttle on
    for (let i = 0; i < 10; i++) {
      const r = await toolSendMessage({ to: 'b', content: `m${i}` }, ctx);
      expect(r).toMatch(/^Peer message sent/);
    }
  });

  it('counter increment is observable across calls (caller resets via runner-driven beforeNextTurn)', async () => {
    const counter = { count: 0 };
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'b']),
      currentAgentId: 'child-a',
      sendMessageTurnCounter: counter,
    });
    await toolSendMessage({ to: 'b', content: 'one' }, ctx);
    expect(counter.count).toBe(1);
    await toolSendMessage({ to: 'b', content: 'two' }, ctx);
    expect(counter.count).toBe(2);
    // Simulate a turn boundary reset (runner-driven does this)
    counter.count = 0;
    await toolSendMessage({ to: 'b', content: 'three' }, ctx);
    expect(counter.count).toBe(1);
  });
});

// ---------- FEATURE_123 (v0.7.44 follow-up): seen_by multi-hop cycle list ----------

describe('toolSendMessage — seen_by multi-hop cycle list', () => {
  it('peer wrapper embeds chain with caller auto-appended (fresh send)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });
    await toolSendMessage({ to: 'child-b', content: 'hi' }, ctx);
    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    expect(drained[0]?.content).toBe(
      '<peer-message from="child-a" seen_by="child-a">\nhi\n</peer-message>',
    );
  });

  it('forward auto-appends caller — wrapper carries the full chain', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b', 'child-c']),
      currentAgentId: 'child-b',
    });
    await toolSendMessage(
      { to: 'child-c', content: 'A said to look at X', seen_by: ['child-a'] },
      ctx,
    );
    const drained = getMessageQueue().dequeue({
      agentId: 'child-c',
      maxPriority: 'background',
    });
    expect(drained[0]?.content).toBe(
      '<peer-message from="child-b" seen_by="child-a,child-b">\nA said to look at X\n</peer-message>',
    );
  });

  it('rejects forward when target is already in seen_by (2-hop A→B→A cycle)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-b',
    });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'pinging back', seen_by: ['child-a'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Cycle detected/);
    expect(result).toMatch(/child-a/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects forward when target is already in seen_by (3-hop A→B→C→A cycle)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b', 'child-c']),
      currentAgentId: 'child-c',
    });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'forwarding back', seen_by: ['child-a', 'child-b'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Cycle detected/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects to="worker" when worker sentinel is already in seen_by', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a']),
      currentAgentId: 'child-a',
    });
    const result = await toolSendMessage(
      { to: 'worker', content: 'looping back', seen_by: ['worker'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Cycle detected/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects forward when chain depth exceeds MAX_FORWARD_DEPTH (5)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['a', 'b', 'c', 'd', 'e', 'f']),
      currentAgentId: 'f',
    });
    // Chain ["a","b","c","d","e"] (5 prior) + self "f" = 6 > 5 cap
    const result = await toolSendMessage(
      { to: 'a', content: 'too deep', seen_by: ['a', 'b', 'c', 'd', 'e'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/chain length/i);
    expect(result).toMatch(/exceeds cap 5/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('broadcast silently filters siblings already in seen_by (no re-circulation)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b', 'child-c', 'child-d']),
      currentAgentId: 'child-c',
    });
    await toolSendMessage(
      { to: '*', content: 'forwarding finding', seen_by: ['child-a', 'child-b'] },
      ctx,
    );
    // child-a + child-b already saw the chain → filtered out.
    // Only child-d (sibling) and worker (parent) should receive.
    const aMsgs = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    const bMsgs = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    const dMsgs = getMessageQueue().dequeue({
      agentId: 'child-d',
      maxPriority: 'background',
    });
    const workerMsgs = getMessageQueue().dequeue({
      agentId: undefined,
      maxPriority: 'background',
    });
    expect(aMsgs).toHaveLength(0);
    expect(bMsgs).toHaveLength(0);
    expect(dMsgs).toHaveLength(1);
    expect(workerMsgs).toHaveLength(1);
    expect(dMsgs[0]?.content).toBe(
      '<peer-broadcast from="child-c" seen_by="child-a,child-b,child-c">\nforwarding finding\n</peer-broadcast>',
    );
  });

  it('broadcast errors when every recipient is already in seen_by (chain exhausted)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-b',
    });
    const result = await toolSendMessage(
      // Only sibling is child-a (already in chain) + worker (also in chain).
      { to: '*', content: 'nowhere to go', seen_by: ['child-a', 'worker'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/zero novel recipients/i);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('ignores non-string entries in incoming seen_by (defensive parse)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });
    await toolSendMessage(
      {
        to: 'child-b',
        content: 'hi',
        seen_by: ['valid', 42, null, '   ', { junk: true }, 'also-valid'],
      },
      ctx,
    );
    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    expect(drained[0]?.content).toBe(
      '<peer-message from="child-a" seen_by="valid,also-valid,child-a">\nhi\n</peer-message>',
    );
  });

  it('Worker coordinator path also enforces cycle reject when target is in seen_by', async () => {
    // Edge case from independent review: Branch 3 cycle guard runs
    // BEFORE the isCoordinatorPath branching, so it applies to the
    // Worker→child path too. If the Worker passes seen_by containing
    // the target, the call must be rejected even though the wrapper
    // is <coordinator-instruction> (which itself does not carry seen_by).
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: undefined, // Worker
    });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'looping', seen_by: ['child-a'] },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Cycle detected/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('non-array seen_by parameter is ignored (fresh chain)', async () => {
    const ctx = makeCtx({
      childTaskRegistry: makeRegistry(['child-a', 'child-b']),
      currentAgentId: 'child-a',
    });
    await toolSendMessage(
      { to: 'child-b', content: 'hi', seen_by: 'not-an-array' as unknown },
      ctx,
    );
    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'background',
    });
    // Non-array seen_by → treated as empty → just self.
    expect(drained[0]?.content).toBe(
      '<peer-message from="child-a" seen_by="child-a">\nhi\n</peer-message>',
    );
  });
});
