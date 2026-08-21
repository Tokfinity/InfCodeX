/**
 * @kodax-ai/agent/messaging/drain — mid-turn drain decision (FEATURE_115).
 *
 * Mid-turn drain pulls queued messages between tool execution and the
 * next LLM call. Default ceiling is `user` priority — user input
 * interrupts the agent loop; background-priority messages
 * (subagent task-notifications) wait for the next safe boundary.
 *
 * **FEATURE_273 v0.7.74 — mailbox-yield gate.** Ordinary tools drain
 * user-priority traffic between LLM turns: real user prompts and urgent
 * Actor follow-ups retain distinct delivery modes. An explicit
 * `wait_agent` call widens the next safe-boundary drain to background
 * priority so Agent messages and completion envelopes are delivered
 * without exposing Actor progress events to the model.
 */

import { getMessageQueue } from './queue.js';
import type { MessagePriority, QueuedMessage } from './types.js';

/**
 * Tools that gate background-priority drain. Only tools that
 * semantically yield for mailbox evidence belong here; ordinary tools
 * must not interleave background Agent results into the next request.
 */
export const YIELD_TOOL_NAMES: ReadonlySet<string> = new Set(['wait_agent']);

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
 * FEATURE_273 widens to `'background'` only after `wait_agent`.
 * Otherwise background messages remain for idle-yield or a later
 * explicit wait boundary.
 */
export function midTurnDrainPriority(
  lastTurnToolNames: readonly string[],
): MessagePriority {
  const yielded = lastTurnToolNames.some((name) => YIELD_TOOL_NAMES.has(name));
  return yielded ? 'background' : 'user';
}

/**
 * Build the predicate used by Runtime-owned queue drains.
 *
 * A host-owned prompt is a head-of-line barrier for later user prompts in the
 * same Agent scope: the host must first expand and execute that explicit
 * command. Non-prompt Runtime traffic (for example an Agent completion) may
 * still pass the barrier so a waiting run cannot deadlock behind host work.
 */
export function createRuntimeDeliveryPredicate(
  snapshot: readonly QueuedMessage[],
  agentId?: string,
): (message: QueuedMessage) => boolean {
  const deliverablePromptIds = new Set<string>();
  let reachedHostPrompt = false;

  for (const message of snapshot) {
    if (
      message.agentId !== agentId
      || message.priority !== 'user'
      || message.mode !== 'prompt'
    ) {
      continue;
    }
    if (message.delivery === 'host') {
      reachedHostPrompt = true;
    } else if (!reachedHostPrompt) {
      deliverablePromptIds.add(message.id);
    }
  }

  return (message) => {
    if (message.delivery === 'host') return false;
    if (message.priority !== 'user' || message.mode !== 'prompt') return true;
    return deliverablePromptIds.has(message.id);
  };
}

/**
 * Drain queued messages destined for `agentId` (main-thread by default)
 * up to the priority ceiling decided by yield gating. Returns the drained
 * messages in `dequeue` order (priority-first FIFO).
 */
export function maybeDrainMidTurn(
  input: MaybeDrainMidTurnInput,
): QueuedMessage[] {
  const maxPriority = midTurnDrainPriority(input.lastTurnToolNames);
  const queue = getMessageQueue();
  return queue.dequeue({
    agentId: input.agentId,
    maxPriority,
    limit: input.limit,
    predicate: createRuntimeDeliveryPredicate(queue.getSnapshot(), input.agentId),
  });
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
