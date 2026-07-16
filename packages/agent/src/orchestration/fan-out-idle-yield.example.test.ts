/**
 * Example — minimal fan-out + idle-yield resume using ONLY the
 * `@kodax-ai/agent` orchestration primitives.
 *
 * Doubles as the FEATURE_120 v0.7.39 Step 0c ADR-021 verification:
 * proves the agent framework can drive a fan-out / chat-while-
 * waiting pattern without any inbound `@kodax-ai/coding` dependency.
 *
 * Imports below are intentionally restricted to `@kodax-ai/agent` +
 * `@kodax-ai/llm` — if a future change introduces a coding-side
 * import here, the lift has regressed and ADR-021 is violated.
 *
 * Scenario:
 *   - An "echo agent" dispatches two child tasks (mock executors
 *     that return after a short delay), receives their results via
 *     the idle-yield wake mechanic, and exits terminal.
 *   - The example uses a stub `runOnce` that drives the
 *     `IdleYieldSnapshot` state machine directly so we don't need
 *     a real LLM or Runner.run invocation.
 */
import { describe, expect, it } from 'vitest';

import { MessageQueue } from '../messaging/index.js';
import {
  _resetMessageQueueForTests,
  enqueueChildTaskNotification,
  getMessageQueue,
} from '../messaging/index.js';
import type { KodaXMessage } from '@kodax-ai/llm';

import { createAgent } from '../primitives/agent.js';

import { registerChildTask } from './task-registry.js';
import type { ChildTaskRegistry } from './task-registry.js';
import type { IdleYieldSnapshot } from './idle-yield.js';
import { runWithIdleYield } from './runner-with-idle-yield.js';

/** A trivial child-result shape — any agent flavor would define its own. */
interface DemoChildResult {
  readonly summary: string;
}

/** A trivial run-result — only `messages` is required by the wrapper. */
interface DemoRunResult {
  readonly messages: readonly KodaXMessage[];
  readonly turn: number;
}

describe('Example — agent-only fan-out + idle-yield resume', () => {
  it('drives two children + idle-yield wake without any coding-side dep', async () => {
    // Use the process-global queue so the example mirrors how a real
    // dispatch tool would enqueue notifications via
    // `enqueueChildTaskNotification`.
    _resetMessageQueueForTests();

    const agent = createAgent({ name: 'demo-fan-out', instructions: '', tools: [] });
    const registry: ChildTaskRegistry<DemoChildResult> = new Map();
    const queue: MessageQueue = getMessageQueue();

    let turn = 0;
    const transcript: string[] = [];

    // Spawn 2 children that resolve after a short delay. Each one
    // also calls `enqueueChildTaskNotification` BEFORE the promise
    // settles — exactly the contract the FEATURE_155 dispatch handler
    // implements in production.
    const childPromise = (id: string, summary: string, delay: number) =>
      new Promise<DemoChildResult>((resolve) => {
        setTimeout(() => {
          enqueueChildTaskNotification({ taskId: id, summary });
          resolve({ summary });
        }, delay);
      });

    registerChildTask(registry, 'c1', childPromise('c1', 'child-1 done', 5));
    registerChildTask(registry, 'c2', childPromise('c2', 'child-2 done', 10));

    const finalResult = await runWithIdleYield<DemoRunResult, DemoChildResult>({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'dispatch and idle-yield' }],
      // Stub runOnce — in a real consumer this would call Runner.run.
      // The stub steps the snapshot machine forward so we can pin the
      // wrapper's iteration behaviour deterministically.
      runOnce: async (a, input) => {
        turn++;
        transcript.push(`run #${turn} on ${a.name} with ${input.length} input(s)`);
        return { messages: [...input], turn };
      },
      // Snapshot state machine:
      //   Turn 1: idle-yield (children still pending).
      //   Turn 2: idle-yield if either registry or queue still has work.
      //   Turn 3: terminal once both children settle and the wake
      //           drain ran on turn 2 — `pendingChildTaskCount` is 0
      //           and `hasPendingBackgroundMessages` is false.
      computeSnapshot: (rr): IdleYieldSnapshot => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: registry.size,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: queue.has({
          agentId: undefined,
          maxPriority: 'background',
        }),
      }),
      registry,
      messageQueue: queue,
      agentId: undefined,
      resumeAgent: () => agent,
    });

    // The wrapper ran the demo agent N times where N is the number
    // of wake events needed to clear the registry + queue. The exact
    // count depends on whether both children settle in one wait or
    // separately; with a 5ms / 10ms delay split, the second child
    // typically resolves before the first wake's compose drains, so
    // turn 2's wake covers both, and turn 3 sees an empty registry +
    // empty queue → snapshot terminal → break.
    //
    // Either way: at least 2 turns (one to enter idle-yield, one to
    // exit), the transcript records every invocation, and the final
    // result is the last runResult.
    expect(turn).toBeGreaterThanOrEqual(2);
    expect(finalResult.turn).toBe(turn);
    expect(transcript[0]).toContain('run #1 on demo-fan-out');
    expect(registry.size).toBe(0); // all children cleaned up by registerChildTask
  });
});
