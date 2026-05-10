/**
 * Idle-yield primitives — unit tests (FEATURE_??? Phase A Slice A1, v0.7.39).
 *
 * Phase A1 ships these utilities in isolation — no production caller wires
 * them in yet. The tests pin the semantics that Slice A2/A3 depend on:
 *
 *   - `detectIdleYield`: a pure 3-condition predicate. Tests cover every
 *     boundary so flipping any single condition independently fails the
 *     suite. This is the contract the wiring layer (Slice A3) reads.
 *
 *   - `waitForWakeEvent`: child-Promise / queue-poll / abort race. Tests
 *     cover each arm winning, cleanup-on-resolution, abort-safety, and
 *     the ordering invariants that matter when multiple wake sources
 *     fire near-simultaneously.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { MessageQueue } from '@kodax-ai/agent';

import type { KodaXChildExecutionResult } from '../../../types.js';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { QueuedMessage } from '@kodax-ai/agent';

import {
  composeIdleYieldUserMessage,
  countLastAssistantToolCalls,
  detectIdleYield,
  isIdleYieldEnabled,
  waitForWakeEvent,
  type WakeEvent,
} from './idle-yield.js';

function buildChildResult(
  status: 'completed' | 'failed' = 'completed',
): KodaXChildExecutionResult {
  return {
    results: [
      {
        id: 'child-1',
        status,
        summary: status === 'completed' ? 'OK' : 'fail',
      },
    ],
    mergedFindings: [],
  };
}

describe('detectIdleYield', () => {
  it('returns true when all three idle-yield conditions hold', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
      }),
    ).toBe(true);
  });

  it('returns false when emit_handoff was emitted (Evaluator path owns next step)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: true,
      }),
    ).toBe(false);
  });

  it('returns false when registry has no pending children (real terminal stop)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
      }),
    ).toBe(false);
  });

  it('returns false when last assistant turn made tool calls (Runner not idle)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 3,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
      }),
    ).toBe(false);
  });

  it('returns false when pendingChildTaskCount is negative (defensive: malformed snapshot)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: -1,
        hasEmittedHandoff: false,
      }),
    ).toBe(false);
  });
});

describe('waitForWakeEvent', () => {
  let queue: MessageQueue;
  beforeEach(() => {
    queue = new MessageQueue();
  });

  it("resolves with 'child-completed' when a child Promise settles successfully first", async () => {
    let resolveChild!: (value: KodaXChildExecutionResult) => void;
    const childPromise = new Promise<KodaXChildExecutionResult>((res) => {
      resolveChild = res;
    });
    const registry = new Map([['task-A', childPromise]]);

    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });

    resolveChild(buildChildResult('completed'));
    const event = await wakePromise;
    expect(event.kind).toBe('child-completed');
    if (event.kind === 'child-completed') {
      expect(event.taskId).toBe('task-A');
      expect(event.result.results[0]?.status).toBe('completed');
    }
  });

  it("resolves with 'child-failed' when a child Promise rejects first", async () => {
    let rejectChild!: (reason: Error) => void;
    const childPromise = new Promise<KodaXChildExecutionResult>((_res, rej) => {
      rejectChild = rej;
    });
    // Suppress unhandled-rejection warning when we settle ahead of the await.
    childPromise.catch(() => undefined);
    const registry = new Map([['task-B', childPromise]]);

    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });

    rejectChild(new Error('child crashed'));
    const event = await wakePromise;
    expect(event.kind).toBe('child-failed');
    if (event.kind === 'child-failed') {
      expect(event.taskId).toBe('task-B');
      expect(event.error.message).toBe('child crashed');
    }
  });

  it("resolves with 'messages-arrived' when a queue message arrives first", async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });

    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'hello while you wait',
    });
    const event = await wakePromise;
    expect(event.kind).toBe('messages-arrived');
    if (event.kind === 'messages-arrived') {
      expect(event.messages.length).toBe(1);
      expect(event.messages[0]?.content).toBe('hello while you wait');
      expect(event.messages[0]?.priority).toBe('user');
    }
  });

  it('drains the dequeued messages from the queue (at-most-once delivery)', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'first' });
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '<task-completed task_id="x"/>',
    });

    const event = await waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });
    expect(event.kind).toBe('messages-arrived');
    if (event.kind === 'messages-arrived') {
      // Both messages drained — caller now owns them.
      expect(event.messages.length).toBe(2);
    }
    // Queue is empty after wake.
    expect(queue.size()).toBe(0);
  });

  it("user-priority messages drain before background-priority on the same wake", async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: 'bg',
    });
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'usr' });

    const event = await waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });
    if (event.kind === 'messages-arrived') {
      expect(event.messages[0]?.priority).toBe('user');
      expect(event.messages[1]?.priority).toBe('background');
    } else {
      throw new Error('expected messages-arrived');
    }
  });

  it("resolves with 'aborted' when the abort signal fires before any other event", async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const controller = new AbortController();
    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
      abortSignal: controller.signal,
    });

    controller.abort();
    const event = await wakePromise;
    expect(event.kind).toBe('aborted');
  });

  it('resolves immediately when the abort signal is already aborted at entry', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const controller = new AbortController();
    controller.abort();
    const event = await waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
      abortSignal: controller.signal,
    });
    expect(event.kind).toBe('aborted');
  });

  it('child-completed wins when a child settles before queue poll fires', async () => {
    let resolveChild!: (v: KodaXChildExecutionResult) => void;
    const registry = new Map([
      [
        'task-fast',
        new Promise<KodaXChildExecutionResult>((r) => (resolveChild = r)),
      ],
    ]);
    // 10s poll interval makes the queue arm essentially never fire in
    // this test — the only path to resolution is the child arm. This
    // pins ordering: child must win even when there's a queue message
    // queued AFTER child resolution but before next poll tick.
    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 10_000,
    });
    resolveChild(buildChildResult('completed'));
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'late msg' });
    const event = await wakePromise;
    expect(event.kind).toBe('child-completed');
    // Late message stays in queue for the next wake.
    expect(queue.size()).toBe(1);
  });

  it('only the first settling event wins (subsequent fires are ignored)', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const events: WakeEvent[] = [];
    const wakePromise = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });
    wakePromise.then((e) => events.push(e));

    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'first' });
    await wakePromise;

    // Enqueue another message — but the waiter has already settled.
    // The wakePromise.then handler should fire only once.
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'second' });
    // Wait for any possible delayed callbacks.
    await new Promise((r) => setTimeout(r, 30));

    expect(events.length).toBe(1);
    // The second message was NOT consumed by this wake — still queued.
    expect(queue.size()).toBe(1);
  });

  it('respects agentId filter — messages addressed to other agents are not consumed', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'for-other',
      agentId: 'other-agent',
    });
    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'for-main',
      // agentId omitted → matches main-thread (undefined) consumers.
    });

    const event = await waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
    });
    if (event.kind !== 'messages-arrived') throw new Error('wrong kind');
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]?.content).toBe('for-main');
    // 'for-other' stays in queue — different agentId consumer would drain it.
    expect(queue.size()).toBe(1);
  });

  it('cleans up the poll interval on abort (no leaked timer between tests)', async () => {
    // We assert this indirectly: the abort path should resolve
    // synchronously after settling, and a subsequent enqueue/dequeue
    // cycle on the same queue must not consume anything (no stray
    // interval still running from a previous waiter).
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const controller = new AbortController();
    const first = waitForWakeEvent({
      registry,
      messageQueue: queue,
      agentId: undefined,
      pollIntervalMs: 5,
      abortSignal: controller.signal,
    });
    controller.abort();
    expect((await first).kind).toBe('aborted');

    // After abort, enqueue something. If the prior interval leaked,
    // it would still drain the message even though the waiter
    // resolved. Verify the message stays.
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'no-leak' });
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.size()).toBe(1);
  });
});

describe('isIdleYieldEnabled (Slice C3 — env-flag gate retired in v0.7.39)', () => {
  // The env-flag gate was retired together with `await_child_task`
  // (Slice C1) — there is no working "v0.7.38 emulation" path now,
  // so the function is hard-coded to true regardless of env. The
  // export survives only for import-compat with Slice A1/A2 callers.
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.KODAX_IDLE_YIELD;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.KODAX_IDLE_YIELD;
    else process.env.KODAX_IDLE_YIELD = prev;
  });

  it('returns true regardless of env value (flag retired, idle-yield is always-on)', () => {
    for (const value of [undefined, '', 'true', 'TRUE', '1', 'false', 'FALSE', 'False', 'no', 'yes']) {
      if (value === undefined) delete process.env.KODAX_IDLE_YIELD;
      else process.env.KODAX_IDLE_YIELD = value;
      expect(isIdleYieldEnabled()).toBe(true);
    }
  });
});

describe('countLastAssistantToolCalls', () => {
  it('returns 0 for an empty transcript', () => {
    expect(countLastAssistantToolCalls([])).toBe(0);
  });

  it('returns 0 when last assistant message is a plain text string', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ];
    expect(countLastAssistantToolCalls(messages)).toBe(0);
  });

  it('returns 0 when last assistant message has only text blocks', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'just text' }],
      },
    ];
    expect(countLastAssistantToolCalls(messages)).toBe(0);
  });

  it('returns the number of tool_use blocks on the last assistant message', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking…' },
          { type: 'tool_use', id: 'a', name: 'read', input: {} },
          { type: 'tool_use', id: 'b', name: 'grep', input: {} },
        ],
      },
    ];
    expect(countLastAssistantToolCalls(messages)).toBe(2);
  });

  it('skips trailing user / system messages and counts the most recent assistant', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }],
      },
    ];
    // Last assistant turn (1 tool_use), even though `messages.at(-1)` is user.
    expect(countLastAssistantToolCalls(messages)).toBe(1);
  });

  it('returns 0 when no assistant message exists', () => {
    const messages: KodaXMessage[] = [{ role: 'user', content: 'orphan' }];
    expect(countLastAssistantToolCalls(messages)).toBe(0);
  });
});

describe('composeIdleYieldUserMessage', () => {
  function queuedMessage(content: string, priority: 'user' | 'background' = 'background'): QueuedMessage {
    return {
      id: 'qm-' + Math.random().toString(36).slice(2, 8),
      priority,
      mode: 'task-notification',
      content,
      enqueuedAt: Date.now(),
    } as QueuedMessage;
  }

  it('returns undefined when wake is "aborted" (caller should have broken out earlier)', () => {
    const result = composeIdleYieldUserMessage({ kind: 'aborted' }, () => []);
    expect(result).toBeUndefined();
  });

  it('messages-arrived: passes the QueuedMessage content through verbatim and concatenates trailing drain', () => {
    const drainCalls: number[] = [];
    const result = composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('hello from queue', 'user')],
      },
      () => {
        drainCalls.push(1);
        return [queuedMessage('<task-completed task_id="late"/>', 'background')];
      },
    );
    expect(result).toBeDefined();
    expect(result!.role).toBe('user');
    expect(result!._synthetic).toBe(true);
    expect(result!.content).toContain('hello from queue');
    expect(result!.content).toContain('<task-completed task_id="late"/>');
    // Late drain should be appended AFTER the wake-event content.
    expect((result!.content as string).indexOf('hello from queue')).toBeLessThan(
      (result!.content as string).indexOf('<task-completed'),
    );
    expect(drainCalls.length).toBe(1);
  });

  it('child-completed: pulls the canonical <task-completed> banner from the drained queue', () => {
    const result = composeIdleYieldUserMessage(
      {
        kind: 'child-completed',
        taskId: 'child-X',
        result: { results: [], mergedFindings: [] },
      },
      () => [
        queuedMessage(
          '<task-completed task_id="child-X">\nfound 3 imports\n</task-completed>',
        ),
      ],
    );
    expect(result).toBeDefined();
    expect(result!.content).toContain('child-X');
    expect(result!.content).toContain('found 3 imports');
  });

  it('child-completed with empty queue: synthesizes a defensive fallback banner', () => {
    const result = composeIdleYieldUserMessage(
      {
        kind: 'child-completed',
        taskId: 'child-orphan',
        result: { results: [], mergedFindings: [] },
      },
      () => [],
    );
    expect(result).toBeDefined();
    expect(result!.content).toContain('child-orphan');
    expect(result!.content).toContain('(child task completed; no summary available)');
  });

  it('child-failed with empty queue: synthesizes a banner carrying the error message', () => {
    const result = composeIdleYieldUserMessage(
      {
        kind: 'child-failed',
        taskId: 'child-crashed',
        error: new Error('exec failed: SIGTERM'),
      },
      () => [],
    );
    expect(result).toBeDefined();
    expect(result!.content).toContain('child-crashed');
    expect(result!.content).toContain('failed: exec failed: SIGTERM');
  });

  it('does not call the drain callback for "aborted" wake (no queue mutation on abort)', () => {
    let drainCalled = false;
    composeIdleYieldUserMessage({ kind: 'aborted' }, () => {
      drainCalled = true;
      return [];
    });
    expect(drainCalled).toBe(false);
  });

  it('marks the synthesized message _synthetic so the REPL hides it from the user', () => {
    const result = composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('foo', 'user')],
      },
      () => [],
    );
    expect(result?._synthetic).toBe(true);
  });

  it('joins multiple fragments with a blank-line separator', () => {
    const result = composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('first', 'user'), queuedMessage('second', 'user')],
      },
      () => [queuedMessage('third')],
    );
    expect(result?.content).toBe('first\n\nsecond\n\nthird');
  });
});
