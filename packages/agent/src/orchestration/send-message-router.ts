/**
 * Generic cross-agent send-message router primitive.
 *
 * FEATURE_120 v0.7.39 Phase 2a (ADR-021). Coordinator-style agents need
 * to dispatch instructions to running peer/child agents whose execution
 * is gated by an agentId-scoped `MessageQueue`. This module owns the
 * minimal "validate target exists, enqueue addressed message, report
 * outcome" trio so the @kodax-ai/agent package can ship the substrate
 * without inheriting any coding-flavor framing.
 *
 * Caller responsibilities (NOT done here):
 *   - Content framing (e.g., `<coordinator-instruction>` tag wrapping)
 *     — this is a tool-layer / flavor concern.
 *   - Priority choice — the caller decides whether a route is
 *     `'user'` (interrupts) or `'background'` (queued for next yield).
 *   - Mode choice — `'prompt'` for new instructions,
 *     `'system-reminder'` for advisory metadata, etc.
 *   - Sentinel target handling (e.g., broadcast `'*'`) — the router
 *     rejects them as `unknown-target` because they aren't registry
 *     keys; callers can intercept upstream if they need fan-out
 *     semantics.
 *
 * What this primitive owns:
 *   - Existence check against a `ReadonlyMap<string, unknown>`
 *     registry — the value type is opaque; we only care about key
 *     membership.
 *   - Enqueue via `MessageQueue.enqueue` with `agentId` set to `to`.
 *   - Structured result so callers can render success / error UX
 *     without re-parsing strings.
 */

import type { MessageQueue } from '../messaging/queue.js';
import type { MessageMode, MessagePriority } from '../messaging/types.js';

export interface RouteMessageOptions {
  /** Target agentId. Must exist as a key in `registry`. */
  readonly to: string;
  /** Priority class — `'user'` interrupts, `'background'` waits. */
  readonly priority: MessagePriority;
  /** Message mode — caller selects based on intent. */
  readonly mode: MessageMode;
  /**
   * Pre-formatted message body. The router does NOT wrap this — any
   * framing (e.g. tags) must be applied by the caller before invoking.
   */
  readonly content: string;
  /**
   * Registry the target must appear in. The value type is opaque; the
   * router only calls `.has(to)`. Pass a `ChildTaskRegistry<T>` for the
   * standard child-task case, or any other `ReadonlyMap<string, ?>`.
   */
  readonly registry: ReadonlyMap<string, unknown>;
  /** Queue to enqueue into when the target is known. */
  readonly queue: MessageQueue;
}

export type RouteMessageResult =
  | { readonly ok: true; readonly messageId: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown-target';
      readonly to: string;
    };

/**
 * Validate that `to` is registered, then enqueue an addressed message.
 *
 * Returns `{ok: true, messageId}` on success; `{ok: false, reason:
 * 'unknown-target', to}` when the target is missing from `registry`.
 * On failure the queue is not mutated.
 *
 * Synchronous because `MessageQueue.enqueue` is synchronous — the
 * routing decision is a pure function of registry membership.
 */
export function routeMessage(opts: RouteMessageOptions): RouteMessageResult {
  if (!opts.registry.has(opts.to)) {
    return { ok: false, reason: 'unknown-target', to: opts.to };
  }
  const messageId = opts.queue.enqueue({
    priority: opts.priority,
    mode: opts.mode,
    agentId: opts.to,
    content: opts.content,
  });
  return { ok: true, messageId };
}
