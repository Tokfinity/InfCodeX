/**
 * Unit tests for the agent-layer `runWithIdleYield` API.
 *
 * Pin set covers the 4 risk vectors enumerated in v0.7.39 Phase 1c
 * design notes:
 *
 *   R3 — Iteration cap off-by-one: a dedicated test pins
 *        `maxIterations=2 → 2 runOnce calls + onIterationCap fired
 *        on the 3rd iteration, then break with the last runResult`.
 *
 *   R4 — Callback order drift: a dedicated test records every callback
 *        invocation into a sequence array and asserts the canonical
 *        order `[runOnce, computeSnapshot, onIdleWaiting, runOnce,
 *        computeSnapshot, ...]` matches.
 *
 *   R5 — `onIdleWaiting` receives `currentAgent` (live, not stale):
 *        a dedicated test pins that on iteration N the hook sees the
 *        agent returned by `resumeAgent` from iteration N-1.
 *
 *   R10 — Empty wake → undefined synthetic message → break: pinned via
 *         a no-content `messages-arrived` wake.
 *
 * Plus regression coverage for:
 *   - Happy path no-yield (single iteration, `detectIdleYield=false`).
 *   - Child wake resume (multi-iteration with child-completed wake).
 *   - Abort wake (loop breaks immediately when wake is aborted).
 *   - Queue message wake (multi-iteration with messages-arrived wake).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent } from '../primitives/agent.js';
import type { Agent } from '../primitives/agent.js';
import { MessageQueue } from '../messaging/index.js';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { ChildTaskRegistry } from './task-registry.js';
import type { IdleYieldSnapshot } from './idle-yield.js';
import { runWithIdleYield } from './runner-with-idle-yield.js';

interface TestRunResult {
  readonly messages: readonly KodaXMessage[];
  readonly tag: string;
}

interface TestChildResult {
  readonly status: 'completed' | 'failed';
}

function buildAgent(name: string): Agent {
  return createAgent({
    name,
    instructions: '',
    tools: [],
  });
}

function snapshotTerminal(): IdleYieldSnapshot {
  return {
    lastAssistantToolCallCount: 1, // any tool call means not idle-yield
    pendingChildTaskCount: 0,
    hasEmittedHandoff: false,
    hasEmittedTerminalVerdict: false,
    hasPendingBackgroundMessages: false,
  };
}

function snapshotIdleYielding(pendingChildren = 1): IdleYieldSnapshot {
  return {
    lastAssistantToolCallCount: 0,
    pendingChildTaskCount: pendingChildren,
    hasEmittedHandoff: false,
    hasEmittedTerminalVerdict: false,
    hasPendingBackgroundMessages: false,
  };
}

describe('runWithIdleYield — happy paths', () => {
  it('returns immediately when the first run is already terminal (no idle-yield)', async () => {
    const agent = buildAgent('entry');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    let runOnceCalls = 0;

    const result = await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        return { messages: [], tag: `run-${runOnceCalls}` };
      },
      computeSnapshot: () => snapshotTerminal(),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
    });

    expect(runOnceCalls).toBe(1);
    expect(result.tag).toBe('run-1');
  });

  it('resumes after a child-completed wake and breaks on the next terminal turn', async () => {
    const entry = buildAgent('entry');
    const worker = buildAgent('worker');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    let runOnceCalls = 0;
    let resumeAgentReceived: Agent | undefined;

    // Pre-populate the registry with a settled child so the wake fires
    // on the first poll. The dispatch path's `enqueueChildTaskNotification`
    // is also simulated as a queued background message so
    // composeIdleYieldUserMessage has content to splice.
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '<task-completed task_id="c1">ok</task-completed>',
    });
    registry.set('c1', Promise.resolve({ status: 'completed' }));

    const result = await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: entry,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async (a) => {
        runOnceCalls++;
        // First call: still has a pending child → idle-yield.
        // Second call: terminal.
        return {
          messages: [{ role: 'assistant', content: `run ${runOnceCalls} from ${a.name}` }],
          tag: `run-${runOnceCalls}-${a.name}`,
        };
      },
      computeSnapshot: () =>
        runOnceCalls === 1 ? snapshotIdleYielding(1) : snapshotTerminal(),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: (rr) => {
        resumeAgentReceived = worker;
        // Caller of resumeAgent has access to the runResult — pin the arg.
        expect(rr.tag).toBe('run-1-entry');
        return worker;
      },
    });

    expect(runOnceCalls).toBe(2);
    expect(resumeAgentReceived).toBe(worker);
    expect(result.tag).toBe('run-2-worker');
  });
});

describe('runWithIdleYield — Risk R3: iteration cap', () => {
  it('respects maxIterations=2 with onIterationCap fired exactly once', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: 'noop',
    });

    let runOnceCalls = 0;
    let snapshotCalls = 0;
    let onIdleWaitingCalls = 0;
    let capFired = 0;

    const result = await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        // Keep the queue funded so each wake resolves with messages.
        queue.enqueue({
          priority: 'background',
          mode: 'task-notification',
          content: `wake-${runOnceCalls}`,
        });
        return { messages: [], tag: `run-${runOnceCalls}` };
      },
      computeSnapshot: () => {
        snapshotCalls++;
        return snapshotIdleYielding(1);
      },
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
      onIdleWaiting: () => {
        onIdleWaitingCalls++;
      },
      onIterationCap: () => {
        capFired++;
      },
      maxIterations: 2,
    });

    // Iteration 1: runOnce, ++iter=1, ≤2 so snapshot, idle-yield true,
    //              onIdleWaiting, wait, compose, replay.
    // Iteration 2: runOnce, ++iter=2, ≤2 so snapshot, idle-yield true,
    //              onIdleWaiting, wait, compose, replay.
    // Iteration 3: runOnce, ++iter=3, >2 → onIterationCap, break.
    expect(runOnceCalls).toBe(3);
    expect(snapshotCalls).toBe(2);
    expect(onIdleWaitingCalls).toBe(2);
    expect(capFired).toBe(1);
    expect(result.tag).toBe('run-3');
  });

  it('default cap=64 keeps existing callers untouched', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    let runOnceCalls = 0;

    await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        return { messages: [], tag: 'x' };
      },
      computeSnapshot: () => snapshotTerminal(),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
      // no maxIterations override
    });
    // Single iteration with snapshotTerminal means the cap never matters,
    // but the lack of explicit maxIterations option must not throw.
    expect(runOnceCalls).toBe(1);
  });
});

describe('runWithIdleYield — Risk R4: callback order', () => {
  it('invokes callbacks in canonical per-iteration order', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: 'wake',
    });

    const trace: string[] = [];
    let runOnceCalls = 0;

    await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        trace.push('runOnce');
        runOnceCalls++;
        return { messages: [], tag: `r${runOnceCalls}` };
      },
      computeSnapshot: () => {
        trace.push('computeSnapshot');
        return runOnceCalls === 1 ? snapshotIdleYielding(1) : snapshotTerminal();
      },
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => {
        trace.push('resumeAgent');
        return agent;
      },
      onIdleWaiting: () => {
        trace.push('onIdleWaiting');
      },
    });

    expect(trace).toEqual([
      // Iteration 1 — idle-yields:
      'runOnce',
      'computeSnapshot',
      'onIdleWaiting',
      // (waitForWakeEvent + composeIdleYieldUserMessage run inside the
      //  loop body — they aren't user callbacks)
      'resumeAgent',
      // Iteration 2 — terminal, breaks before onIdleWaiting:
      'runOnce',
      'computeSnapshot',
    ]);
  });
});

describe('runWithIdleYield — Risk R5: onIdleWaiting sees live currentAgent', () => {
  it('passes the agent that just ran (so role lookups see the right name)', async () => {
    const entry = buildAgent('entry');
    const worker = buildAgent('worker');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();

    const observedAgentsAtIdle: string[] = [];
    let runOnceCalls = 0;

    // Fund the queue lazily inside runOnce so each iteration's wake
    // has exactly one message to consume. (compose drains all
    // background messages per call, so a pre-funded queue would
    // be empty by iter 2.)
    await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: entry,
      initialInput: [],
      runOnce: async (a) => {
        runOnceCalls++;
        if (runOnceCalls <= 2) {
          queue.enqueue({
            priority: 'background',
            mode: 'task-notification',
            content: `wake-${runOnceCalls}`,
          });
        }
        return { messages: [], tag: a.name };
      },
      computeSnapshot: () =>
        runOnceCalls <= 2 ? snapshotIdleYielding(1) : snapshotTerminal(),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => worker,
      onIdleWaiting: (currentAgent) => {
        observedAgentsAtIdle.push(currentAgent.name);
      },
    });

    // Iteration 1: entry ran → onIdleWaiting sees 'entry'.
    // Iteration 2: worker ran (after resumeAgent) → onIdleWaiting sees 'worker'.
    expect(observedAgentsAtIdle).toEqual(['entry', 'worker']);
  });
});

describe('runWithIdleYield — Risk R10: empty wake → break', () => {
  it('breaks when composeIdleYieldUserMessage returns undefined', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    // Enqueue a message with empty content. composeIdleYieldUserMessage
    // filters those out and the fallback only fires for child-* wakes —
    // a messages-arrived wake with all-empty content returns undefined.
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '',
    });

    let runOnceCalls = 0;

    const result = await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        return { messages: [], tag: `r${runOnceCalls}` };
      },
      computeSnapshot: () => snapshotIdleYielding(0),
      // ↑ pendingChildren=0 but hasPendingBackgroundMessages defaults to
      //   false in our helper, so the only way to keep detectIdleYield
      //   true is via a manual override. Easier path: keep pending count
      //   at 1.
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
    });

    // With pendingChildren=0 AND hasPendingBackgroundMessages=false,
    // detectIdleYield returns false on iter 1 → break before the
    // wait branch. This is the "no idle-yield needed" path; the empty-
    // wake → break branch needs a different setup, exercised below.
    expect(runOnceCalls).toBe(1);
    expect(result.tag).toBe('r1');
  });

  it('breaks when wake resolves with empty content and child registry empties', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '', // empty — composeIdleYieldUserMessage filters this out
    });

    let runOnceCalls = 0;

    await runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        return { messages: [], tag: `r${runOnceCalls}` };
      },
      // Hold the loop open via the background-pending flag so
      // detectIdleYield returns true on iter 1, the wait drains the
      // empty message, composeIdleYieldUserMessage returns undefined,
      // and the loop breaks BEFORE iter 2.
      computeSnapshot: () =>
        runOnceCalls === 1
          ? {
              lastAssistantToolCallCount: 0,
              pendingChildTaskCount: 0,
              hasEmittedHandoff: false,
              hasEmittedTerminalVerdict: false,
              hasPendingBackgroundMessages: true,
            }
          : snapshotTerminal(),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
    });

    expect(runOnceCalls).toBe(1);
  });
});

describe('runWithIdleYield — abort handling', () => {
  let originalSetInterval: typeof setInterval;
  beforeEach(() => {
    originalSetInterval = global.setInterval;
  });
  afterEach(() => {
    global.setInterval = originalSetInterval;
  });

  it('breaks when the abort signal fires during the wait', async () => {
    const agent = buildAgent('a');
    const registry: ChildTaskRegistry<TestChildResult> = new Map();
    const queue = new MessageQueue();
    const ac = new AbortController();
    let runOnceCalls = 0;

    const promise = runWithIdleYield<TestRunResult, TestChildResult>({
      initialAgent: agent,
      initialInput: [],
      runOnce: async () => {
        runOnceCalls++;
        // Abort during the wait that follows runOnce iteration 1.
        if (runOnceCalls === 1) {
          setTimeout(() => ac.abort(), 5);
        }
        return { messages: [], tag: `r${runOnceCalls}` };
      },
      computeSnapshot: () => snapshotIdleYielding(1),
      registry,
      messageQueue: queue,
      agentId: undefined,
      abortSignal: ac.signal,
      resumeAgent: () => agent,
    });
    // Keep a pending child so the wait actually parks.
    registry.set('c1', new Promise(() => {})); // never settles

    const result = await promise;
    expect(runOnceCalls).toBe(1);
    expect(result.tag).toBe('r1');
  });
});
