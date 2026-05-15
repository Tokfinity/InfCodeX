/**
 * Idle-yield primitives — unit tests.
 *
 * Originally shipped as
 * `packages/coding/src/task-engine/_internal/managed-task/idle-yield.test.ts`
 * (FEATURE_155 Slice A1, v0.7.39). Lifted to `@kodax-ai/agent`'s
 * `orchestration/` in v0.7.39 FEATURE_120 Step 0b together with the
 * implementation (ADR-021).
 *
 * The tests pin the semantics that the runner outer loop depends on:
 *
 *   - `detectIdleYield`: a pure 4-condition predicate (the
 *     `hasEmittedTerminalVerdict` + `hasPendingBackgroundMessages`
 *     fields were added in the v0.7.38 FEATURE_155 hotfix follow-up
 *     chain — Bug B/D and Bug E respectively). Tests cover every
 *     boundary so flipping any single condition independently fails
 *     the suite.
 *
 *   - `waitForWakeEvent`: child-Promise / queue-poll / abort race.
 *     Tests cover each arm winning, cleanup-on-resolution,
 *     abort-safety (Bug F regression pin — explicit
 *     `removeEventListener` on non-abort wakes), and the ordering
 *     invariants that matter when multiple wake sources fire
 *     near-simultaneously.
 *
 * Fixture note: the original `buildChildResult` used coding-flavor
 * `TestChildResult`. The lifted suite uses a structurally
 * equivalent local `TestChildResult` so the agent layer keeps zero
 * inbound deps on coding (ADR-021). The shape mirrors coding's so the
 * `result.results[0]?.status` reads in the wake-event assertion stay
 * unchanged.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { MessageQueue } from '../messaging/index.js';
import type { QueuedMessage } from '../messaging/index.js';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  composeIdleYieldUserMessage,
  countLastAssistantToolCalls,
  detectIdleYield,
  detectMissingTerminalVerdict,
  isIdleYieldEnabled,
  waitForWakeEvent,
  type WakeEvent,
} from './idle-yield.js';

/**
 * Local minimal stand-in for `@kodax-ai/coding`'s
 * `TestChildResult`. Tests inspect `result.results[0]?.status`
 * to confirm the child-completed branch carries the right payload —
 * mirror that shape exactly. Other fields of the production type are
 * unused by the tests and intentionally omitted.
 */
interface TestChildResult {
  readonly results: ReadonlyArray<{
    readonly id: string;
    readonly status: 'completed' | 'failed';
    readonly summary: string;
  }>;
  readonly mergedFindings: readonly unknown[];
}

function buildChildResult(
  status: 'completed' | 'failed' = 'completed',
): TestChildResult {
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
  it('returns true when all idle-yield conditions hold', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(true);
  });

  it('returns false when emit_handoff was emitted (Evaluator path owns next step)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when registry empty AND no background messages (real terminal stop)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when last assistant turn made tool calls (Runner not idle)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 3,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when pendingChildTaskCount is negative AND no background messages (defensive: malformed snapshot)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: -1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  // v0.7.38 FEATURE_155 hotfix — Bug B regression. After the Evaluator
  // emits a terminal verdict (`accept` / `blocked`), the outer loop
  // must STOP idle-yielding even if children are still in flight —
  // otherwise post-verdict child notifications would drive degenerate
  // LLM turns up to `IDLE_YIELD_MAX_ITERATIONS=64`. `revise` is NOT
  // terminal (chain re-runs) and is wired in the caller, not here.
  it('returns false when a terminal verdict has been emitted (accept/blocked)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: true,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  // v0.7.38 FEATURE_155 hotfix follow-up #2 — fast-child race
  // regression. When a child completes faster than the surrounding
  // Runner.run iteration, the dispatch IIFE's
  // `.finally(() => registry.delete(childId))` runs in the same
  // microtask burst as the IIFE's `enqueueChildTaskNotification` —
  // and the cleanup runs BEFORE the outer loop's
  // `detectIdleYield` snapshot. Without the
  // `hasPendingBackgroundMessages` gate, the snapshot sees
  // `pendingChildTaskCount=0`, the loop breaks, and the
  // already-enqueued banner is stranded in the background queue.
  it('returns true when registry empty BUT background queue has banners (fast-child race)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(true);
  });

  it('hasPendingBackgroundMessages does NOT override the handoff/verdict gates', () => {
    // Even if a banner is queued, a Worker handoff or a terminal
    // Evaluator verdict still wins — the chain has already moved on,
    // background notifications no longer matter for the Worker's
    // current decision loop.
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(false);
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: true,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(false);
  });
});

// FEATURE_167 v0.7.41 — Evaluator missed-verdict B1 trigger predicate.
//
// `detectMissingTerminalVerdict` fires when:
//   - last assistant turn made NO tool calls (no `emit_verdict`,
//     no `emit_handoff`),
//   - AND a prior `emit_handoff` already happened
//     (so an Evaluator role owns the turn — Worker→Evaluator chain
//     has activated),
//   - AND no terminal verdict has been emitted yet,
//   - AND no children are still pending (`pendingChildTaskCount===0`),
//   - AND no background banners are queued.
//
// The 4 invariants below cover the gate per condition. The last
// describe block pins the disjointness invariant with
// `detectIdleYield` — no snapshot can satisfy both predicates,
// because the two paths represent mutually exclusive runner states.
describe('detectMissingTerminalVerdict', () => {
  it('returns true at the canonical B1 trigger snapshot', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(true);
  });

  it('returns false when last assistant turn made tool calls (turn not yet idle — could be mid-stream)', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 1,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when no handoff was emitted (Evaluator role not active yet)', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when a terminal verdict has already been emitted (run terminating cleanly)', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: true,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when child tasks are still pending (idle-yield owns this state)', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when background banners are queued (idle-yield owns this state)', () => {
    expect(
      detectMissingTerminalVerdict({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(false);
  });

  // Pin disjointness: when missing-verdict fires, idle-yield must NOT,
  // and vice versa. The two predicates partition the "Runner exits with
  // 0 tool calls on assistant turn" subspace cleanly. If a future change
  // introduces overlap, B1 retry would race idle-yield resume.
  describe('disjointness with detectIdleYield', () => {
    it('canonical B1 snapshot does NOT satisfy detectIdleYield', () => {
      const snapshot = {
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: true,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      };
      expect(detectMissingTerminalVerdict(snapshot)).toBe(true);
      expect(detectIdleYield(snapshot)).toBe(false);
    });

    it('canonical idle-yield snapshot does NOT satisfy detectMissingTerminalVerdict', () => {
      const snapshot = {
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      };
      expect(detectIdleYield(snapshot)).toBe(true);
      expect(detectMissingTerminalVerdict(snapshot)).toBe(false);
    });

    it('fast-child-race idle-yield snapshot does NOT satisfy detectMissingTerminalVerdict', () => {
      // Banner queued, registry empty, no handoff yet — idle-yield
      // territory, never B1.
      const snapshot = {
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      };
      expect(detectIdleYield(snapshot)).toBe(true);
      expect(detectMissingTerminalVerdict(snapshot)).toBe(false);
    });
  });
});

describe('waitForWakeEvent', () => {
  let queue: MessageQueue;
  beforeEach(() => {
    queue = new MessageQueue();
  });

  it("resolves with 'child-completed' when a child Promise settles successfully first", async () => {
    let resolveChild!: (value: TestChildResult) => void;
    const childPromise = new Promise<TestChildResult>((res) => {
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
    const childPromise = new Promise<TestChildResult>((_res, rej) => {
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    let resolveChild!: (v: TestChildResult) => void;
    const registry = new Map([
      [
        'task-fast',
        new Promise<TestChildResult>((r) => (resolveChild = r)),
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
    const registry = new Map<string, Promise<TestChildResult>>();
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
    const registry = new Map<string, Promise<TestChildResult>>();
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

  // v0.7.38 FEATURE_155 hotfix follow-up #2 — abort listener cleanup.
  // Before this fix the wake-on-non-abort path left the abort
  // listener attached. Over an outer loop running 64 idle-yield
  // iterations on the SAME long-lived signal that's the difference
  // between 1 listener and 64. AbortSignal is an EventTarget so
  // there's no MaxListeners warning — the leak was silent.
  // We assert by counting listeners (Node's AbortSignal extends
  // EventTarget but the underlying EventEmitter is private; on
  // recent Node we can probe via the legacy listener-tracking
  // helper from `events`).
  it('removes the abort listener when wake fires on a non-abort path', async () => {
    const registry = new Map<string, Promise<TestChildResult>>();
    const controller = new AbortController();
    const { getEventListeners } = await import('events');
    const beforeCount = getEventListeners(controller.signal, 'abort').length;

    // Drive 5 sequential idle-yield cycles on the SAME signal. Each
    // wakes via the queue arm (not abort), so the abort listener
    // must be removed by `settle()` each time, leaving the signal
    // listener count unchanged at the end.
    for (let i = 0; i < 5; i++) {
      const wakePromise = waitForWakeEvent({
        registry,
        messageQueue: queue,
        agentId: undefined,
        pollIntervalMs: 5,
        abortSignal: controller.signal,
      });
      queue.enqueue({ priority: 'user', mode: 'prompt', content: `msg-${i}` });
      const event = await wakePromise;
      expect(event.kind).toBe('messages-arrived');
    }

    const afterCount = getEventListeners(controller.signal, 'abort').length;
    expect(afterCount).toBe(beforeCount);
  });

  it('cleans up the poll interval on abort (no leaked timer between tests)', async () => {
    // We assert this indirectly: the abort path should resolve
    // synchronously after settling, and a subsequent enqueue/dequeue
    // cycle on the same queue must not consume anything (no stray
    // interval still running from a previous waiter).
    const registry = new Map<string, Promise<TestChildResult>>();
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
  // FEATURE_159 v0.7.40: helper now takes an explicit mode so tests can
  // exercise both the task-notification (synthetic-hidden) AND prompt
  // (user-visible) sides of the mode-split.
  function queuedMessage(
    content: string,
    priority: 'user' | 'background' = 'background',
    mode: QueuedMessage['mode'] = 'task-notification',
  ): QueuedMessage {
    return {
      id: 'qm-' + Math.random().toString(36).slice(2, 8),
      priority,
      mode,
      content,
      enqueuedAt: Date.now(),
    } as QueuedMessage;
  }

  it('returns empty array when wake is "aborted" (caller should have broken out earlier)', async () => {
    const result = await composeIdleYieldUserMessage({ kind: 'aborted' }, () => []);
    expect(result).toEqual([]);
  });

  // FEATURE_159: task-notification + late-drain banner from
  // `messages-arrived` wake → one synthetic message (preserves prior
  // hidden-banner contract for pure-banner wakes).
  it('messages-arrived (banners only): emits one synthetic message with all banner content', async () => {
    const drainCalls: number[] = [];
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('hello from queue', 'user', 'task-notification')],
      },
      () => {
        drainCalls.push(1);
        return [queuedMessage('<task-completed task_id="late"/>', 'background', 'task-notification')];
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!._synthetic).toBe(true);
    expect(result[0]!.content).toContain('hello from queue');
    expect(result[0]!.content).toContain('<task-completed task_id="late"/>');
    // Late drain should be appended AFTER the wake-event content.
    expect((result[0]!.content as string).indexOf('hello from queue')).toBeLessThan(
      (result[0]!.content as string).indexOf('<task-completed'),
    );
    expect(drainCalls.length).toBe(1);
  });

  it('child-completed: pulls the canonical <task-completed> banner from the drained queue (synthetic)', async () => {
    const result = await composeIdleYieldUserMessage(
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
    expect(result).toHaveLength(1);
    expect(result[0]!._synthetic).toBe(true);
    expect(result[0]!.content).toContain('child-X');
    expect(result[0]!.content).toContain('found 3 imports');
  });

  it('child-completed with empty queue: synthesizes a defensive fallback banner (synthetic)', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'child-completed',
        taskId: 'child-orphan',
        result: { results: [], mergedFindings: [] },
      },
      () => [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!._synthetic).toBe(true);
    expect(result[0]!.content).toContain('child-orphan');
    expect(result[0]!.content).toContain('(child task completed; no summary available)');
  });

  it('child-failed with empty queue: synthesizes a banner carrying the error message (synthetic)', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'child-failed',
        taskId: 'child-crashed',
        error: new Error('exec failed: SIGTERM'),
      },
      () => [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!._synthetic).toBe(true);
    expect(result[0]!.content).toContain('child-crashed');
    expect(result[0]!.content).toContain('failed: exec failed: SIGTERM');
  });

  it('does not call the drain callback for "aborted" wake (no queue mutation on abort)', async () => {
    let drainCalled = false;
    await composeIdleYieldUserMessage({ kind: 'aborted' }, () => {
      drainCalled = true;
      return [];
    });
    expect(drainCalled).toBe(false);
  });

  it('marks the synthesized banner _synthetic so the REPL hides it from the user', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('foo', 'user', 'task-notification')],
      },
      () => [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!._synthetic).toBe(true);
  });

  it('joins multiple banner fragments with a blank-line separator', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [
          queuedMessage('first', 'user', 'task-notification'),
          queuedMessage('second', 'user', 'task-notification'),
        ],
      },
      () => [queuedMessage('third')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('first\n\nsecond\n\nthird');
  });

  // FEATURE_121 (v0.7.40): enforceAggregate callback hook
  it('enforceAggregate: when omitted, fragments are joined verbatim (backward compat)', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('a'), queuedMessage('b')],
      },
      () => [queuedMessage('c')],
    );
    expect(result[0]!.content).toBe('a\n\nb\n\nc');
  });

  it('enforceAggregate: when provided, transforms banner fragments before joining', async () => {
    const calls: ReadonlyArray<readonly string[]>[] = [];
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('big-1'), queuedMessage('big-2')],
      },
      () => [],
      (fragments) => {
        calls.push([fragments]);
        return fragments.map((f) => `[shrunk]${f}`);
      },
    );
    expect(result[0]!.content).toBe('[shrunk]big-1\n\n[shrunk]big-2');
    expect(calls.length).toBe(1);
  });

  it('enforceAggregate: supports async transform (returns Promise<string[]>)', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('alpha'), queuedMessage('beta')],
      },
      () => [],
      async (fragments) => {
        await Promise.resolve();
        return fragments.map((f) => f.toUpperCase());
      },
    );
    expect(result[0]!.content).toBe('ALPHA\n\nBETA');
  });

  it('enforceAggregate: if it returns empty array, compose returns empty array', async () => {
    const result = await composeIdleYieldUserMessage(
      {
        kind: 'messages-arrived',
        messages: [queuedMessage('x')],
      },
      () => [],
      () => [],
    );
    expect(result).toEqual([]);
  });

  // FEATURE_159 (v0.7.40) — mode-split behavior. Prompt-mode messages
  // surface as REAL user input (visible in transcript); only
  // task-notification / system-reminder modes stay synthetic.
  describe('FEATURE_159 mode-split', () => {
    it('prompt-only wake: emits one real user message (NOT synthetic)', async () => {
      const result = await composeIdleYieldUserMessage(
        {
          kind: 'messages-arrived',
          messages: [queuedMessage('user typed this', 'user', 'prompt')],
        },
        () => [],
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe('user');
      expect(result[0]!._synthetic).toBeUndefined();
      expect(result[0]!.content).toBe('user typed this');
    });

    it('mixed prompt + task-notification: emits two messages (synthetic banner FIRST, then real user)', async () => {
      const result = await composeIdleYieldUserMessage(
        {
          kind: 'messages-arrived',
          messages: [
            queuedMessage('<task-completed task_id="X">done</task-completed>', 'background', 'task-notification'),
            queuedMessage('user follow-up question', 'user', 'prompt'),
          ],
        },
        () => [],
      );
      expect(result).toHaveLength(2);
      // Banner first — agent reads it as "tail of prior turn".
      expect(result[0]!._synthetic).toBe(true);
      expect(result[0]!.content).toContain('<task-completed task_id="X">');
      // User prompt second — appears as real user bubble in transcript.
      expect(result[1]!._synthetic).toBeUndefined();
      expect(result[1]!.content).toBe('user follow-up question');
    });

    it('multiple prompts join with --- separator so chunked typing reads as one user turn with structure', async () => {
      const result = await composeIdleYieldUserMessage(
        {
          kind: 'messages-arrived',
          messages: [
            queuedMessage('first thought', 'user', 'prompt'),
            queuedMessage('second thought', 'user', 'prompt'),
          ],
        },
        () => [],
      );
      expect(result).toHaveLength(1);
      expect(result[0]!._synthetic).toBeUndefined();
      expect(result[0]!.content).toBe('first thought\n\n---\n\nsecond thought');
    });

    it('enforceAggregate applies ONLY to synthetic banners, NEVER to user prompts', async () => {
      let calls = 0;
      const result = await composeIdleYieldUserMessage(
        {
          kind: 'messages-arrived',
          messages: [
            queuedMessage('huge banner payload', 'background', 'task-notification'),
            queuedMessage('my exact prompt', 'user', 'prompt'),
          ],
        },
        () => [],
        (fragments) => {
          calls++;
          return fragments.map((f) => `[shrunk]${f}`);
        },
      );
      expect(calls).toBe(1); // called once, only for synthetic side
      expect(result).toHaveLength(2);
      expect(result[0]!._synthetic).toBe(true);
      expect(result[0]!.content).toContain('[shrunk]huge banner payload');
      // User prompt untouched — never silently truncated.
      expect(result[1]!._synthetic).toBeUndefined();
      expect(result[1]!.content).toBe('my exact prompt');
    });

    it('system-reminder mode is treated like task-notification (stays synthetic)', async () => {
      const result = await composeIdleYieldUserMessage(
        {
          kind: 'messages-arrived',
          messages: [queuedMessage('SR: reminder body', 'background', 'system-reminder')],
        },
        () => [],
      );
      expect(result).toHaveLength(1);
      expect(result[0]!._synthetic).toBe(true);
    });
  });
});
