/**
 * Idle-yield primitives for FEATURE_??? (v0.7.39) — async chat-while-waiting.
 *
 * Replaces the blocking `await_child_task` semantics with a Claude-Code-style
 * "Worker turn ends idle, runner waits for the next external event"
 * mechanism. After this lands, when the Worker has dispatched ≥1 children
 * and has nothing else to do, it outputs a brief status line (no tool
 * calls), and Runner.run returns. This module gives the task-engine layer
 * the two utilities it needs to interpret that exit and resume:
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
}

/**
 * Pure predicate. True when the Worker turn ended via the
 * "no tool calls + still has pending children" path that idle-yield
 * is designed to handle.
 *
 * The three conjunction terms are deliberately independent — caller
 * can mix in additional gating (e.g. a feature flag) without rewriting
 * this. Returning false here means "treat the run as terminal /
 * delegate to legacy semantics" and is the safe default.
 */
export function detectIdleYield(snapshot: IdleYieldSnapshot): boolean {
  if (snapshot.lastAssistantToolCallCount > 0) return false;
  if (snapshot.hasEmittedHandoff) return false;
  if (snapshot.pendingChildTaskCount <= 0) return false;
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
    const settle = (event: WakeEvent): void => {
      if (settled) return;
      settled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      resolve(event);
    };

    if (abortSignal?.aborted) {
      settle({ kind: 'aborted' });
      return;
    }

    // Child arm — wrap each registry entry. Crucially we do NOT mutate
    // the registry: the dispatch path's existing .then/.catch handlers
    // own cleanup. We just observe.
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

    // Abort arm — tear down on Esc / parent-cancel. Use {once:true}
    // so the listener removes itself; preserves AbortController
    // semantics for callers that reuse the controller.
    abortSignal?.addEventListener(
      'abort',
      () => {
        settle({ kind: 'aborted' });
      },
      { once: true },
    );

    // Edge: registry was already empty AND queue had a pending
    // message at construction time. The poll arm would still
    // fire on first tick; nothing additional needed. If both
    // registry and queue are empty AND no abort fires, the
    // waiter blocks indefinitely — by design (caller must
    // either dispatch a child or queue a message to wake it).
  });
}
