/**
 * @kodax-ai/agent/messaging — Message queue types
 *
 * FEATURE_115 (v0.7.36): agentId-scoped 2-tier priority queue infrastructure.
 *
 * Per ADR-021: messaging is a generic agent-platform primitive (not coding-
 * specific). Downstream consumers:
 *   - @kodax-ai/coding runner-driven mid-turn drain
 *   - @kodax-ai/repl InkREPL ESC soft-pause + text injection (FEATURE_111 absorbed)
 *   - subagent task-notification routing (FEATURE_119 await_child_task wakeup)
 *
 * Phase 0.6 study (`c:/tmp/claude-code-actual-usage.md`): Claude Code's
 * `'now'` priority has zero production usage; KodaX simplifies to 2 tiers.
 */

export type MessagePriority = 'user' | 'background';

export type MessageMode = 'prompt' | 'task-notification' | 'system-reminder';

export interface QueuedMessage {
  /** Stable id for tracing / dedup. Format: `msg-<sequence>`. */
  readonly id: string;
  readonly priority: MessagePriority;
  /**
   * Routing key:
   *   undefined = main thread / coordinator agent
   *   'agent-id-XYZ' = subagent / specific consumer
   *
   * Drain consumers MUST filter by agentId match — undefined matches only
   * undefined-agentId messages, not "any agent".
   */
  readonly agentId?: string;
  readonly mode: MessageMode;
  readonly content: string;
  /** Wall-clock timestamp (`Date.now()`) for tracing only — not used for ordering. */
  readonly enqueuedAt: number;
}

export interface DequeueFilter {
  /**
   * Only return messages with this agentId.
   * undefined matches messages with no agentId (main-thread messages only).
   */
  readonly agentId?: string;
  /**
   * Highest priority level included in the drain.
   *   'user'       → only user priority drained, background stays queued
   *   'background' → both user + background drained (Sleep-gated case)
   */
  readonly maxPriority: MessagePriority;
  /**
   * Optional cap on number of messages drained in this call.
   * Defaults to unlimited (drains all matching).
   */
  readonly limit?: number;
}

export interface EnqueueInput {
  readonly priority: MessagePriority;
  readonly mode: MessageMode;
  readonly content: string;
  readonly agentId?: string;
}
