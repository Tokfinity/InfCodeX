/**
 * Idle-yield primitives for FEATURE_155 (v0.7.39) — async chat-while-waiting.
 *
 * Replaces the blocking `await_child_task` semantics with a Claude-Code-style
 * "agent turn ends idle, runner waits for the next external event"
 * mechanism. When the agent has dispatched ≥1 children and has nothing else
 * to do, it outputs a brief status line (no tool calls), and Runner.run
 * returns. This module gives the task-engine layer the two utilities it
 * needs to interpret that exit and resume:
 *
 *   1. `detectIdleYield(...)` — synchronous predicate over the run's exit
 *      state. Returns true when the Worker turn ended without an
 *      `emit_handoff` AND there are still child tasks the Worker is
 *      expected to wait on. False on every other path (handoff complete,
 *      registry empty, run aborted, etc.) so legacy behaviour is
 *      untouched.
 *
 *   2. `waitForWakeEvent(...)` — async race between child-task
 *      completions and the FEATURE_115 MessageQueue. Returns the first
 *      event so the task-engine knows what to splice into the Worker's
 *      next-turn context. Cooperative with `AbortSignal` so REPL Esc
 *      tears it down promptly.
 *
 * **Phase A1 scope**: this file is pure utility code — no `runner-driven.ts`
 * call site touches it yet. Wiring lands in Slice A2 (drain trigger) and
 * Slice A3 (`runManagedTaskViaRunnerInner` outer loop). Keeping this in
 * isolation lets each slice stay reviewable on its own and lets us revert
 * the wiring without losing the foundation.
 *
 * Design ref: `docs/features/v0.7.39.md` §Phase A — idle-yield foundation.
 */

import type { MessageQueue, QueuedMessage } from '@kodax-ai/agent';

import type { KodaXChildExecutionResult } from '../../../types.js';
import type { KodaXMessage, KodaXContentBlock } from '@kodax-ai/llm';

/**
 * Env-flag gate for the runner-driven outer-loop wiring.
 *
 * **Slice C3 (v0.7.39) — flag retired as a runtime gate.** With
 * `await_child_task` removed (Slice C1) there is no working "v0.7.38
 * emulation" path: the prompt + banner always teach idle-yield, so
 * gating only the outer loop would leave a flag-OFF deployment with
 * agents that exit text-only but no resumer to wake them. The
 * function is therefore hard-coded to `true` and exists only for
 * import compatibility with the Slice A1/A2 callers and
 * historical-test references; the env var has no effect.
 */
export function isIdleYieldEnabled(): boolean {
  return true;
}

/**
 * Count the `tool_use` blocks on the last assistant message of a Runner
 * transcript. Used to populate `IdleYieldSnapshot.lastAssistantToolCallCount`
 * — a 0 count is the marker for the no-tool-calls exit branch
 * `Runner.run` uses to terminate its tool loop.
 */
export function countLastAssistantToolCalls(
  messages: readonly KodaXMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return 0;
    return (msg.content as readonly KodaXContentBlock[]).filter(
      (b) => (b as { type?: string }).type === 'tool_use',
    ).length;
  }
  return 0;
}

/** Snapshot of the Worker run's exit state, computed by the task-engine. */
export interface IdleYieldSnapshot {
  /**
   * The last assistant message's tool-call count from the Runner.run
   * transcript. Worker idle-yield is signalled when this is 0 (Runner
   * exited via the no-tool-calls branch, not via a tool-driven
   * handoff).
   */
  readonly lastAssistantToolCallCount: number;
  /**
   * Number of child tasks still in the registry when Runner.run
   * returned. Reads `ctx.childTaskRegistry.size` at the boundary.
   * Idle-yield only fires when this is > 0 — otherwise there's
   * nothing to wait for and the Worker stop is a real terminal
   * event (which the existing Worker-prompt contract treats as a
   * spec violation, separate from idle-yield).
   */
  readonly pendingChildTaskCount: number;
  /**
   * True if the run's `managedProtocolPayload.handoff` has been
   * populated with an `emit_handoff` payload. False = the run
   * ended without Worker calling emit_handoff. Idle-yield
   * REQUIRES this to be false; otherwise the Evaluator path
   * already owns the next step.
   */
  readonly hasEmittedHandoff: boolean;
  /**
   * v0.7.38 FEATURE_155 hotfix — true if the run's
   * `managedProtocolPayload.verdict` has been populated with a
   * terminal Evaluator verdict (`accept` / `blocked`; `revise`
   * triggers a chain re-run, not idle-yield continuation).
   * Without this gate the outer loop would keep re-entering
   * `Runner.run` after the Evaluator already emitted a terminal
   * verdict — wasting LLM turns on post-verdict child notifications.
   * Idle-yield REQUIRES this to be false; same reasoning as
   * `hasEmittedHandoff` but for the Evaluator side of the chain.
   */
  readonly hasEmittedTerminalVerdict: boolean;
  /**
   * v0.7.38 FEATURE_155 hotfix follow-up — true if the
   * background-priority message queue still has undelivered
   * `<task-completed>` banners destined for the Worker. Set this
   * alongside `pendingChildTaskCount` because of the **fast-child
   * race**: the dispatch IIFE calls
   * `enqueueChildTaskNotification` BEFORE its promise resolves, and
   * the registry's `.finally(delete)` cleanup runs in the same
   * microtask burst. When a child completes faster than the
   * surrounding Runner.run iteration (e.g. a sub-second probe vs a
   * multi-second LLM call), the registry entry is removed BEFORE
   * the outer loop reads `pendingChildTaskCount` — making the
   * snapshot see `0`, breaking the loop, and orphaning the banner
   * in the background queue. With this field, the loop stays in
   * the wait state whenever there's still something to deliver,
   * regardless of which arm (registry or queue) carries it.
   *
   * Drained only by the outer loop's
   * `composeIdleYieldUserMessage` call AFTER `waitForWakeEvent`
   * returns. The mid-turn drain (FEATURE_115) caps at `user`
   * priority post-FEATURE_155, so this is the **only** consumer of
   * background-priority messages — losing it strands the banner.
   */
  readonly hasPendingBackgroundMessages: boolean;
}

/**
 * Pure predicate. True when the Worker turn ended via the
 * "no tool calls + still has pending children" path that idle-yield
 * is designed to handle.
 *
 * The four conjunction terms are deliberately independent — caller
 * can mix in additional gating (e.g. a feature flag) without rewriting
 * this. Returning false here means "treat the run as terminal /
 * delegate to legacy semantics" and is the safe default.
 */
export function detectIdleYield(snapshot: IdleYieldSnapshot): boolean {
  if (snapshot.lastAssistantToolCallCount > 0) return false;
  if (snapshot.hasEmittedHandoff) return false;
  if (snapshot.hasEmittedTerminalVerdict) return false;
  // Either a pending child OR an undelivered background banner keeps
  // us in the wait state — see `hasPendingBackgroundMessages` docs
  // for the fast-child race rationale.
  if (snapshot.pendingChildTaskCount <= 0
      && !snapshot.hasPendingBackgroundMessages) return false;
  return true;
}

/** Discriminated union surfacing the reason a wake completed. */
export type WakeEvent =
  | {
      readonly kind: 'child-completed';
      readonly taskId: string;
      readonly result: KodaXChildExecutionResult;
    }
  | {
      readonly kind: 'child-failed';
      readonly taskId: string;
      readonly error: Error;
    }
  | {
      readonly kind: 'messages-arrived';
      readonly messages: readonly QueuedMessage[];
    }
  | { readonly kind: 'aborted' };

export interface WaitForWakeEventOptions {
  /**
   * Live ChildTaskRegistry snapshot. The waiter wraps each entry's
   * promise so the FIRST settling child wins the race.
   *
   * **NOTE**: the waiter does NOT delete entries on settlement — the
   * registry's normal cleanup path (FEATURE_119 dispatch handler's
   * .then/.catch) owns deletion. Wrapping doesn't double-consume.
   */
  readonly registry: ReadonlyMap<string, Promise<KodaXChildExecutionResult>>;
  /** FEATURE_115 process-global queue surface. */
  readonly messageQueue: MessageQueue;
  /**
   * AgentId filter for queue dequeues. Use `undefined` to match
   * main-thread messages (the Worker's standard queue scope).
   */
  readonly agentId: string | undefined;
  /**
   * Optional cancellation. When fired, the waiter resolves with
   * `{ kind: 'aborted' }` and tears down its poll timer.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Queue poll interval. The MessageQueue is poll-based; this is the
   * granularity at which user input becomes visible to the waiter.
   * 100 ms keeps perceived REPL responsiveness < 1 frame at 60 fps
   * for the human eye and stays well below typical LLM-call latency.
   * Tests can pass smaller values (e.g. 10 ms) to keep them fast.
   */
  readonly pollIntervalMs?: number;
}

/**
 * Race child completions against MessageQueue arrivals. Returns the
 * first wake event. Guarantees:
 *
 *   - Cleanup: the poll timer is cleared on resolution regardless of
 *     which arm wins.
 *   - At-most-once dequeue: when the queue arm wins, the messages it
 *     drained are returned to the caller AND removed from the queue
 *     (the caller is now responsible for splicing them into the
 *     Worker's next-turn context).
 *   - Abort-safe: if `abortSignal` fires before any other event, the
 *     waiter resolves with `{ kind: 'aborted' }`. Already-settled
 *     child promises are NOT cancelled — the registry's owner handles
 *     them on the next turn.
 *
 * Caller responsibilities:
 *   - Pass the EXACT registry snapshot (not a copy) so subsequent
 *     dispatches the Worker performs after wake are visible to the
 *     next `waitForWakeEvent` call.
 *   - Splice the returned messages / child result into the Worker's
 *     next Runner.run input. The waiter does not itself construct
 *     synthetic user-message bytes — that's the runner-driven
 *     wiring layer's job (Slice A3).
 */
export function waitForWakeEvent(
  options: WaitForWakeEventOptions,
): Promise<WakeEvent> {
  const { registry, messageQueue, agentId, abortSignal, pollIntervalMs = 100 } =
    options;

  return new Promise<WakeEvent>((resolve) => {
    let settled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    // v0.7.38 hotfix follow-up #2 — abort listener leak. Without
    // tracking & removing on wake, every idle-yield iteration on the
    // same long-lived `abortSignal` (one per outer-loop turn, capped at
    // IDLE_YIELD_MAX_ITERATIONS=64 per run) leaves a dead listener
    // attached. `{once:true}` only auto-removes when the listener
    // actually fires; if the wake wins the race (the common case),
    // the listener stays. AbortSignal is an EventTarget (no MaxListeners
    // warning), so the leak was silent. Capture the bound handler now
    // and remove it explicitly in `settle()`.
    const abortHandler = (): void => {
      settle({ kind: 'aborted' });
    };
    const settle = (event: WakeEvent): void => {
      if (settled) return;
      settled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      abortSignal?.removeEventListener('abort', abortHandler);
      resolve(event);
    };

    if (abortSignal?.aborted) {
      settle({ kind: 'aborted' });
      return;
    }

    // Child arm — wrap each registry entry. We do NOT mutate the
    // registry here; the dispatch path's IIFE attaches a
    // `.finally(() => registry.delete(childId))` so settled entries
    // disappear before the next `waitForWakeEvent` call iterates.
    // Without that cleanup an already-settled promise's `.then` fires
    // synchronously in the microtask queue and resolves this wake with
    // a spurious `child-completed` event — the FEATURE_155 v0.7.38
    // hotfix landed the dispatch-side fix.
    for (const [taskId, promise] of registry.entries()) {
      promise.then(
        (result) => {
          settle({ kind: 'child-completed', taskId, result });
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          settle({ kind: 'child-failed', taskId, error });
        },
      );
    }

    // Queue arm — poll. The MessageQueue is currently poll-based
    // (no event-emitter surface yet); 100 ms is the perception
    // budget. If queue ever grows a `wait()` API we can swap this
    // for a single await without changing the public WakeEvent
    // contract.
    intervalId = setInterval(() => {
      if (settled) return;
      const messages = messageQueue.dequeue({
        agentId,
        maxPriority: 'background',
      });
      if (messages.length > 0) {
        settle({ kind: 'messages-arrived', messages });
      }
    }, pollIntervalMs);

    // Abort arm — tear down on Esc / parent-cancel. Note: `{once:true}`
    // is still useful as belt-and-suspenders (auto-remove on abort
    // fire) but the explicit removeEventListener in `settle()` is the
    // load-bearing cleanup for the common non-abort path.
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    // Edge: registry was already empty AND queue had a pending
    // message at construction time. The poll arm would still
    // fire on first tick; nothing additional needed. If both
    // registry and queue are empty AND no abort fires, the
    // waiter blocks indefinitely — by design (caller must
    // either dispatch a child or queue a message to wake it).
  });
}

/**
 * Compose the synthetic user message spliced after a Worker idle-yield
 * resume. The runner-driven outer loop calls this with the resolved
 * `WakeEvent` plus a function that drains any pending background
 * messages (typically `() => getMessageQueue().dequeue(...)`).
 *
 *   - `messages-arrived` wake: the queue arm already drained the
 *     QueuedMessage(s); pass their content through verbatim. Then
 *     drain anything that arrived between settle and this call (a
 *     tight race with the dispatch handler's enqueue is possible) and
 *     concatenate.
 *
 *   - `child-completed` / `child-failed` wake: the dispatch handler's
 *     in-IIFE `enqueueChildTaskNotification` is a precondition of the
 *     promise settling, so the queue holds the canonical
 *     `<task-completed>` banner. Drain to capture it. If for any
 *     reason the banner is missing (defensive — a misbehaving
 *     dispatch path that resolved without enqueuing), synthesize a
 *     minimal one from the wake event so the Worker still observes
 *     the resolution rather than silently looping again.
 *
 *   - `aborted`: caller is expected to break out before reaching this
 *     helper. If reached anyway, returns `undefined` so the outer
 *     loop treats it as a terminal exit.
 *
 * Returns `undefined` when the wake yields no spliceable content —
 * the outer loop treats that as a real terminal exit.
 */
export function composeIdleYieldUserMessage(
  wakeEvent: WakeEvent,
  drainBackgroundQueue: () => readonly QueuedMessage[],
): KodaXMessage | undefined {
  const fragments: string[] = [];

  if (wakeEvent.kind === 'messages-arrived') {
    for (const msg of wakeEvent.messages) {
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        fragments.push(msg.content);
      }
    }
  }

  if (wakeEvent.kind !== 'aborted') {
    const drained = drainBackgroundQueue();
    for (const msg of drained) {
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        fragments.push(msg.content);
      }
    }
  }

  // Defensive fallback — child-* wake with empty queue. Only shape
  // that can reach this branch is a misbehaving dispatch path that
  // resolved the promise without enqueuing; surface a minimal banner
  // so Worker still sees the result instead of silently looping
  // again.
  if (fragments.length === 0) {
    if (wakeEvent.kind === 'child-completed') {
      fragments.push(
        `<task-completed task_id="${wakeEvent.taskId}">\n(child task completed; no summary available)\n</task-completed>`,
      );
    } else if (wakeEvent.kind === 'child-failed') {
      fragments.push(
        `<task-completed task_id="${wakeEvent.taskId}">\nfailed: ${wakeEvent.error.message}\n</task-completed>`,
      );
    }
  }

  if (fragments.length === 0) return undefined;

  return {
    role: 'user',
    content: fragments.join('\n\n'),
    // Hidden in REPL display — the Worker only ever sees this in its
    // transcript, the human never reads it. Without this flag the
    // REPL would render the synthetic banner as a user message bubble.
    _synthetic: true,
  };
}
