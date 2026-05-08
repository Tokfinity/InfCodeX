/**
 * @kodax-ai/agent/messaging/queue — 2-tier agentId-scoped FIFO message queue.
 *
 * FEATURE_115 (v0.7.36).
 *
 * Invariants:
 *   - In-priority FIFO: messages of the same priority drain in enqueue order.
 *   - Cross-priority precedence: 'user' drains before 'background', regardless
 *     of enqueue order.
 *   - agentId routing: messages addressed to agentId X are only visible to
 *     consumers filtering for that exact agentId. undefined ≠ "any agent" —
 *     it specifically matches main-thread messages.
 *   - Not persistent: process restart loses queue state, by design (matches
 *     TodoStore semantics).
 *
 * The queue is process-global by default (`getMessageQueue()`); the class is
 * also exported for tests / isolated downstream use.
 */

import type {
  DequeueFilter,
  EnqueueInput,
  MessagePriority,
  QueuedMessage,
} from './types.js';

/**
 * Smaller rank = higher precedence (drains first).
 *
 * Semantics of `maxPriority` filter (intentionally inclusive of the named
 * priority and any higher-precedence one):
 *   maxPriority='user'       → rank ≤ 0 → only user priority included.
 *   maxPriority='background' → rank ≤ 1 → user + background both included
 *                                          (Sleep-gated case).
 */
const PRIORITY_RANK: Record<MessagePriority, number> = {
  user: 0,
  background: 1,
};

function priorityWithinMax(
  target: MessagePriority,
  max: MessagePriority,
): boolean {
  return PRIORITY_RANK[target] <= PRIORITY_RANK[max];
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];
  private nextSeq = 1;

  /** Returns the assigned id of the enqueued message. */
  enqueue(input: EnqueueInput): string {
    const id = `msg-${this.nextSeq++}`;
    const message: QueuedMessage = {
      id,
      priority: input.priority,
      mode: input.mode,
      content: input.content,
      agentId: input.agentId,
      enqueuedAt: Date.now(),
    };
    this.messages = [...this.messages, message];
    return id;
  }

  /**
   * Drain matching messages, ordered by priority (user > background) then
   * FIFO within each priority. Removes drained messages from the queue.
   */
  dequeue(filter: DequeueFilter): QueuedMessage[] {
    const candidates: { originalIndex: number; message: QueuedMessage }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (!message) continue;
      if (
        message.agentId === filter.agentId &&
        priorityWithinMax(message.priority, filter.maxPriority)
      ) {
        candidates.push({ originalIndex: i, message });
      }
    }

    candidates.sort((a, b) => {
      // Smaller rank = higher precedence → ascending sort puts user first.
      const priorityDelta =
        PRIORITY_RANK[a.message.priority] - PRIORITY_RANK[b.message.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return a.originalIndex - b.originalIndex;
    });

    const limit = filter.limit;
    const taken =
      typeof limit === 'number' && candidates.length > limit
        ? candidates.slice(0, limit)
        : candidates;

    const takenIndices = new Set(taken.map((t) => t.originalIndex));
    this.messages = this.messages.filter((_, i) => !takenIndices.has(i));

    return taken.map((t) => t.message);
  }

  /**
   * Peek at matching messages without removing them. Returns messages in
   * the same priority + FIFO order that `dequeue(filter)` would return,
   * so callers can inspect what the next drain would yield.
   */
  peek(filter: DequeueFilter): QueuedMessage[] {
    const candidates: { originalIndex: number; message: QueuedMessage }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (!message) continue;
      if (
        message.agentId === filter.agentId &&
        priorityWithinMax(message.priority, filter.maxPriority)
      ) {
        candidates.push({ originalIndex: i, message });
      }
    }

    candidates.sort((a, b) => {
      const priorityDelta =
        PRIORITY_RANK[a.message.priority] - PRIORITY_RANK[b.message.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return a.originalIndex - b.originalIndex;
    });

    const limit = filter.limit;
    const sliced =
      typeof limit === 'number' && candidates.length > limit
        ? candidates.slice(0, limit)
        : candidates;
    return sliced.map((c) => c.message);
  }

  /** Total queue size across all priorities / agents. */
  size(): number {
    return this.messages.length;
  }

  /** Count of messages matching the filter. */
  count(filter: DequeueFilter): number {
    return this.peek(filter).length;
  }

  /** True iff at least one message matches the filter. */
  has(filter: DequeueFilter): boolean {
    return this.count(filter) > 0;
  }

  /** Remove all queued messages — used in tests / process abort scenarios. */
  clear(): void {
    this.messages = [];
  }
}

let processGlobalQueue: MessageQueue | undefined;

/**
 * Returns the process-global MessageQueue singleton, creating it lazily on
 * first call. Use this for production wiring; instantiate `MessageQueue`
 * directly in tests / isolated subsystems where a shared instance would
 * cause cross-test pollution.
 */
export function getMessageQueue(): MessageQueue {
  if (!processGlobalQueue) {
    processGlobalQueue = new MessageQueue();
  }
  return processGlobalQueue;
}

/**
 * Test-only reset hook. Production code MUST NOT call this. Underscored
 * prefix follows the same convention as `_resetInvariantRegistry` /
 * `_resetAdmittedAgentBindings` / `_resetAdmissionMetrics`.
 */
export function _resetMessageQueueForTests(): void {
  processGlobalQueue = undefined;
}
