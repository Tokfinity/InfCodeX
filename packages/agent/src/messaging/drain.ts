/**
 * @kodax-ai/agent/messaging/drain — mid-turn drain decision (FEATURE_115).
 *
 * Mid-turn drain pulls queued messages between tool execution and the
 * next LLM call. Default ceiling is `user` priority — user input
 * interrupts the agent loop; background-priority messages
 * (subagent task-notifications) wait for the next safe boundary.
 *
 * **FEATURE_155 v0.7.39 Slice C2 — yield-tool gate retired.** Before
 * v0.7.39 the drain widened to background priority when the agent had
 * just called `await_child_task` (FEATURE_119 Pattern B). With idle-
 * yield (the default since Slice B1.D), `await_child_task` is gone and
 * the runner's outer loop in
 * `coding/src/task-engine/_internal/managed-task/idle-yield.ts` owns
 * background-priority dequeue at the no-tool-calls exit. The mid-turn
 * drain therefore stays at `user` priority — that's the only path
 * where it makes sense to interrupt the agent without violating the
 * tool_use/tool_result pairing contract. `YIELD_TOOL_NAMES` and the
 * `lastTurnToolNames` parameter remain on the public surface as a
 * placeholder for any FUTURE yield tool (e.g. an explicit `sleep`),
 * but the set is empty so the gate is currently a no-op.
 */

import { getMessageQueue } from './queue.js';
import type { MessagePriority, QueuedMessage } from './types.js';
import type { KodaXTaskResultMetadata, KodaXTaskResultSource } from '@kodax-ai/llm';

/**
 * Tools that gate background-priority drain. Empty under FEATURE_155
 * idle-yield (v0.7.39+) — see file header. Adding an entry should
 * remain a deliberate decision: only tools that semantically
 * represent the agent yielding control should unlock background
 * priority, because background drain can interleave subagent
 * results into the main conversation in unexpected places.
 */
export const YIELD_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

export interface MaybeDrainMidTurnInput {
  /** Tool names invoked during the most recent iteration's tool_use blocks. */
  readonly lastTurnToolNames: readonly string[];
  /** Current agent's id (`undefined` for the main thread). */
  readonly agentId?: string;
  /** Optional cap on the number of drained messages. */
  readonly limit?: number;
}

/**
 * Returns the priority ceiling that mid-turn drain should use given the
 * tools the agent invoked in the most recent iteration.
 *
 * Under FEATURE_155 idle-yield (`YIELD_TOOL_NAMES` empty by default),
 * this always returns `'user'` — background-priority messages are
 * picked up by the runner-driven outer loop's `waitForWakeEvent` at
 * the no-tool-calls exit, not by the mid-turn drain.
 */
export function midTurnDrainPriority(
  lastTurnToolNames: readonly string[],
): MessagePriority {
  const yielded = lastTurnToolNames.some((name) => YIELD_TOOL_NAMES.has(name));
  return yielded ? 'background' : 'user';
}

/**
 * Drain queued messages destined for `agentId` (main-thread by default)
 * up to the priority ceiling decided by Sleep gating. Returns the drained
 * messages in `dequeue` order (priority-first FIFO).
 */
export function maybeDrainMidTurn(
  input: MaybeDrainMidTurnInput,
): QueuedMessage[] {
  const maxPriority = midTurnDrainPriority(input.lastTurnToolNames);
  return getMessageQueue().dequeue({
    agentId: input.agentId,
    maxPriority,
    limit: input.limit,
  });
}

export interface EnqueueChildTaskNotificationInput {
  /**
   * agentId of the parent / coordinator that should receive the
   * notification. `undefined` targets the main thread.
   */
  readonly parentAgentId?: string;
  /** Stable identifier of the completed child task (e.g. `child-...`). */
  readonly taskId: string;
  /** Human-readable summary appended after the task id banner. */
  readonly summary: string;
  readonly source?: KodaXTaskResultSource;
  readonly runId?: string;
  readonly status?: KodaXTaskResultMetadata['status'];
  readonly title?: string;
  readonly artifactRefs?: readonly string[];
}

/**
 * Enqueue a `task-notification` message destined for the parent / main
 * thread when a backgrounded child task finishes (FEATURE_119 Pattern B).
 *
 * Goes in at `priority: 'background'`. Under FEATURE_155 idle-yield
 * (v0.7.39+), the runner's outer loop drains background priority at
 * the no-tool-calls exit (`waitForWakeEvent` →
 * `composeIdleYieldUserMessage`), so the notification surfaces in
 * the agent's next-turn user message as a `<task-completed
 * task_id="…">…</task-completed>` block. Pre-v0.7.39 a `yield tool`
 * (`await_child_task`) gated mid-turn drain to background priority —
 * that path is gone with the tool.
 *
 * Returns the enqueued message id (matches `MessageQueue.enqueue` contract).
 */
export function enqueueChildTaskNotification(
  input: EnqueueChildTaskNotificationInput,
): string {
  const banner = `<task-completed task_id="${input.taskId}">\n${input.summary}\n</task-completed>`;
  const taskResult: KodaXTaskResultMetadata = {
    type: 'task_result',
    source: input.source ?? 'child_task',
    taskId: input.taskId,
    status: input.status ?? 'completed',
    summary: input.summary,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.artifactRefs !== undefined ? { artifactRefs: [...input.artifactRefs] } : {}),
  };
  return getMessageQueue().enqueue({
    priority: 'background',
    mode: 'task-notification',
    agentId: input.parentAgentId,
    content: banner,
    taskResult,
  });
}
