/**
 * Event-emitter helpers — CAP-035 + CAP-038 + CAP-053 + CAP-058
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-035-tool-name-visibility-classification
 *   - docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *   - docs/features/v0.7.29-capability-inventory.md#cap-053-emititerationend-helper-eventsoniterationend--token-snapshot-rebase
 *   - docs/features/v0.7.29-capability-inventory.md#cap-058-eventsoniterationstart-event
 *
 * Predicates and event-fan-out helpers used by the SA loop:
 *
 *   - `isVisibleToolName` (CAP-035): predicate for whether a given tool
 *     call should be surfaced to the host (REPL, IDE extension, AMA
 *     observer) via `onToolUseStart` / `onToolResult`. Managed-protocol
 *     tools (e.g. `emit_managed_protocol`) are infrastructure-level
 *     signals the host should not echo back — they belong to the harness,
 *     not to the user-visible work transcript.
 *
 *   - `hasQueuedFollowUp` (CAP-038): consulted at end-of-turn terminal
 *     decision points to keep the loop running when the host has a
 *     queued user input ready. The optional-chained call to
 *     `events.hasPendingInputs?.()` ensures hosts that don't implement
 *     this hook (the default) simply return `false` — no behavioural
 *     change for non-REPL embedders.
 *
 *   - `emitIterationStart` (CAP-058): fires `events.onIterationStart`
 *     with `iter+1` (1-based for display) and `maxIter`. Caller must
 *     have already fired the `turn:start` extension event — this helper
 *     is the user-visible counterpart that runs immediately after.
 *
 *   - `emitIterationEnd` (CAP-053): rebases the context-token snapshot
 *     against the latest messages buffer, then fires
 *     `events.onIterationEnd` carrying the rebased snapshot. Returns
 *     the new snapshot so the caller can reassign its mutable holder.
 *     The rebase is load-bearing — it's the only place where streaming
 *     usage deltas accumulated during the turn are reconciled with the
 *     persistent message-count baseline before the next turn begins.
 *
 * Migration history:
 *   - `isVisibleToolName` extracted from `agent.ts:882-884` during the
 *     FEATURE_100 P2 baseline batch.
 *   - `hasQueuedFollowUp` extracted from `agent.ts:769-771` during
 *     FEATURE_100 P2 (CAP-031/032/037/038 batch).
 *   - `emitIterationStart` / `emitIterationEnd` extracted from
 *     `agent.ts:511-528` and `agent.ts:577` during FEATURE_100 P3.1.
 */

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../types.js';
import type { KodaXMessage } from '@kodax-ai/llm';
import { getMessageQueue } from '@kodax-ai/agent';
import { isManagedProtocolToolName } from '../managed-protocol.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';

/**
 * FEATURE_151 (v0.7.38) Slice E — `todo_update` and `todo_list` are
 * scaffolding for the user-visible TodoListSurface. The user already
 * sees plan progress through that surface; surfacing every individual
 * tool call (especially during a multi-step task where the Generator
 * fires `op:'update'` 2-4 times per round) is pure transcript noise.
 *
 * Mirrors Claude Code's stance: `TodoWriteTool` / `TaskCreateTool` /
 * `TaskUpdateTool` / `TaskListTool` all set `shouldDefer: true +
 * renderToolUseMessage() => null + userFacingName() => ''`, hiding the
 * call entirely from the user transcript.
 */
const HIDDEN_TODO_TOOL_NAMES: ReadonlySet<string> = new Set([
  'todo_update',
  'todo_list',
]);

export function isVisibleToolName(name: string): boolean {
  return (
    !isManagedProtocolToolName(name)
    && !HIDDEN_TODO_TOOL_NAMES.has(name)
  );
}

/**
 * CAP-038 + FEATURE_159 (v0.7.40) — queue-aware queued-follow-up
 * predicate.
 *
 * Pre-FEATURE_159: only consulted `events.hasPendingInputs?.()` — the
 * REPL implemented this hook to expose its React `pendingInputs` array.
 * That coupling required the REPL to mirror its array into the agent-
 * side MessageQueue (legacy `syncPendingInputsToQueue`) so other
 * substrate consumers could see the same queued input.
 *
 * Post-FEATURE_159: MessageQueue is the canonical source of queued
 * user prompts. We OR-in a queue probe for `mode:'prompt'`
 * main-thread user-priority entries — so any origin (REPL,
 * idle-yield wake-resumed prompts, SDK consumer that enqueues
 * directly) triggers the same yield. The `events.hasPendingInputs?.()`
 * fallback is kept for SDK consumers that implement custom
 * queueing without routing through MessageQueue (BC-preserved).
 */
export function hasQueuedFollowUp(events: KodaXEvents): boolean {
  if (events.hasPendingInputs?.() === true) return true;
  return getMessageQueue().has({
    agentId: undefined,
    maxPriority: 'user',
    mode: 'prompt',
  });
}

/**
 * Fire `onSessionStart` — CAP-003. Single shared site so SA (substrate
 * frame entry) and AMA (`runManagedTaskViaRunner`) emit through the
 * same surface. Future contract changes (richer payload, ordering
 * invariants) only need updating here.
 */
export function emitSessionStart(
  events: KodaXEvents,
  payload: { provider: string; sessionId: string },
): void {
  events.onSessionStart?.(payload);
}

/**
 * Fire `onStreamEnd` — CAP-004. Shared between SA's per-turn stream
 * finalization and AMA's per-worker-turn stream finalization.
 */
export function emitStreamEnd(events: KodaXEvents): void {
  events.onStreamEnd?.();
}

/**
 * Fire `onComplete` — CAP-005. Shared terminal signal across all
 * non-error terminals (success / interrupt / managed-protocol exit).
 * Mutually exclusive with `emitError` per CAP-084.
 */
export function emitComplete(events: KodaXEvents): void {
  events.onComplete?.();
}

/**
 * Fire `onError` — CAP-006. Shared catch-branch signal. Mutually
 * exclusive with `emitComplete` per CAP-084.
 */
export function emitError(events: KodaXEvents, error: Error): void {
  events.onError?.(error);
}

/**
 * Fire `onProviderRateLimit` — CAP-007. Distinct from generic
 * `onRetry`: only fires when the resilience classifier returns
 * `reasonCode === 'rate_limit'`. SA dispatches via the provider stream
 * handler bridge (`stream-handler-wiring.ts`); AMA dispatches inline
 * during its own retry decision pipeline. Both now emit through this
 * helper so the (attempt, maxRetries, delayMs) tuple shape is locked.
 */
export function emitProviderRateLimit(
  events: KodaXEvents,
  attempt: number,
  maxRetries: number,
  delayMs: number,
): void {
  events.onProviderRateLimit?.(attempt, maxRetries, delayMs);
}

/**
 * Fire the user-facing `onIterationStart` event. `iter` is 0-based at
 * the call site; this helper translates to the 1-based display value.
 */
export function emitIterationStart(
  events: KodaXEvents,
  iter: number,
  maxIter: number,
): void {
  events.onIterationStart?.(iter + 1, maxIter);
}

/**
 * Rebase the context-token snapshot and fire `onIterationEnd`. Returns
 * the rebased snapshot so the caller can reassign its holder. Pass
 * `snapshotOverride` when an upstream step (compaction, post-compact
 * attachments) has already produced a fresher baseline.
 */
export function emitIterationEnd(
  events: KodaXEvents,
  params: {
    iter: number;
    maxIter: number;
    messages: readonly KodaXMessage[];
    currentSnapshot: KodaXContextTokenSnapshot;
    snapshotOverride?: KodaXContextTokenSnapshot;
  },
): KodaXContextTokenSnapshot {
  const rebased = rebaseContextTokenSnapshot(
    params.messages as KodaXMessage[],
    params.snapshotOverride ?? params.currentSnapshot,
  );
  events.onIterationEnd?.({
    iter: params.iter,
    maxIter: params.maxIter,
    tokenCount: rebased.currentTokens,
    tokenSource: rebased.source,
    usage: rebased.usage,
    contextTokenSnapshot: rebased,
  });
  return rebased;
}
