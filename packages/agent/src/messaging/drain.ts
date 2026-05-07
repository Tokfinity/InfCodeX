/**
 * @kodax/agent/messaging/drain — mid-turn drain decision (FEATURE_115).
 *
 * Sleep-gated drain logic shared between any agent harness that wants to
 * pull queued messages between tool execution and the next LLM call.
 *
 * The default drain returns user-priority messages only, leaving background-
 * priority (subagent task-notifications, etc.) queued. When the previous
 * iteration ran a recognized YIELD_TOOL_NAMES tool — currently
 * `await_child_task` (FEATURE_119 Pattern B); a future explicit `sleep`
 * tool will also qualify — the drain widens to include background priority.
 * This matches Claude Code's `query.ts:1551-1566` pattern (Phase 0.6 study)
 * but uses an explicit yield-tool allow-list instead of a single hard-coded
 * `SLEEP_TOOL_NAME` so KodaX can extend the gate one tool at a time.
 *
 * The yield-tool list is intentionally minimal. Adding a new entry should
 * be a deliberate decision: only tools that semantically represent the
 * agent yielding control should unlock background-priority interruption,
 * because background drain can interleave subagent results into the main
 * conversation in unexpected places.
 */

import { getMessageQueue } from './queue.js';
import type { MessagePriority, QueuedMessage } from './types.js';

/** Tools that gate background-priority drain. */
export const YIELD_TOOL_NAMES: ReadonlySet<string> = new Set([
  // 'sleep' — reserved for the future explicit Sleep tool.
  'await_child_task', // FEATURE_119 Pattern B
]);

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
 * tools the agent invoked in the most recent iteration. Exposed so
 * callers can `peek` (without dequeueing) using the same decision logic.
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
