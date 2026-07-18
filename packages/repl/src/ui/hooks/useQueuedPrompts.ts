/**
 * FEATURE_159 (v0.7.40) — `useQueuedPrompts` hook.
 *
 * Subscribes a React component to the agent-side MessageQueue and
 * returns the filtered slice of user-priority prompts for one queue scope —
 * the same slice REPL renders as "Queue N" / "Queued follow-ups: N".
 *
 * Implementation contract:
 *   - Single source of truth = `MessageQueue`. The hook does not mirror
 *     state into React — it subscribes and returns the queue's frozen
 *     snapshot (filtered).
 *   - `useSyncExternalStore` handles consistency across concurrent
 *     React renders. The hook obeys React 18's tearing-prevention
 *     guarantees because `getSnapshot()` returns a reference-stable
 *     frozen array.
 *   - The filter excludes subagent-scoped messages (`agentId !== undefined`)
 *     and background-priority entries (task-notifications). Adding new
 *     surfaces (e.g. queued bash commands when KodaX gains a bash-mode
 *     escape) means adding a separate hook with a different filter, not
 *     overloading this one.
 *
 * Why a separate hook instead of just reading `streamingState.pendingInputs`:
 *   - `streamingState.pendingInputs` is a derived mirror maintained by
 *     `StreamingContext`'s queue subscription. New components / non-Ink
 *     consumers (SDK callers wrapped in React) can use this hook
 *     directly without taking a dependency on StreamingContext.
 *   - Per-call filter is fast (queue size ≤ MAX_PENDING_INPUTS = 5 for
 *     prompts in practice); useMemo / re-filter is acceptable.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  getMessageQueue,
  type QueuedMessage,
} from "@kodax-ai/agent";

function isQueuedPromptForAgent(
  message: QueuedMessage,
  agentId: string | undefined,
): boolean {
  return (
    message.agentId === agentId &&
    message.priority === "user" &&
    message.mode === "prompt"
  );
}

/**
 * Cached filtered snapshot. We can't return a fresh `filter(...)` from
 * `getSnapshot()` on every read — React 18's `useSyncExternalStore`
 * requires reference-stable snapshots when nothing changed. We compute
 * the filtered slice lazily, keyed on the underlying queue snapshot's
 * identity (which IS reference-stable per FEATURE_159 Phase 1).
 */
let lastQueueSnapshot: readonly QueuedMessage[] | null = null;
const filteredSnapshots = new Map<string | undefined, readonly QueuedMessage[]>();

function getQueueSliceSnapshot(agentId: string | undefined): readonly QueuedMessage[] {
  const current = getMessageQueue().getSnapshot();
  if (current !== lastQueueSnapshot) {
    lastQueueSnapshot = current;
    filteredSnapshots.clear();
  }
  const cached = filteredSnapshots.get(agentId);
  if (cached !== undefined) return cached;
  const filtered = Object.freeze(
    current.filter((message) => isQueuedPromptForAgent(message, agentId)),
  );
  filteredSnapshots.set(agentId, filtered);
  return filtered;
}

/**
 * Subscribe to one agent/session user-priority prompt slice of the
 * MessageQueue. Returns a stable snapshot — safe to use as a `useEffect`
 * dep or pass to a memoized child.
 */
export function useQueuedPrompts(agentId?: string): readonly QueuedMessage[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => getMessageQueue().subscribe(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => getQueueSliceSnapshot(agentId), [agentId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Variant returning just the content strings — convenience for the
 * common case where the consumer doesn't care about ids / timestamps.
 */
export function useQueuedPromptContents(agentId?: string): readonly string[] {
  const prompts = useQueuedPrompts(agentId);
  // useMemo isn't worth the dependency cost; prompts is already
  // reference-stable across no-op renders so .map() identity rotates
  // only when the slice itself changed.
  return prompts.map((m) => m.content);
}

/**
 * Test-only reset hook for the module-level filtered-snapshot cache.
 * Production code must not call this. Used by tests that reset the
 * process-global MessageQueue singleton between cases.
 */
export function _resetQueuedPromptsCacheForTests(): void {
  lastQueueSnapshot = null;
  filteredSnapshots.clear();
}
