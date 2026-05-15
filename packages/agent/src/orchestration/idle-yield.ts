/**
 * Idle-yield primitives — async chat-while-waiting orchestration core.
 *
 * Originally shipped as `packages/coding/src/task-engine/_internal/
 * managed-task/idle-yield.ts` (v0.7.39 Slices A1-C3, FEATURE_155). The
 * v0.7.38 hotfix follow-up chain (Bug A-G) landed inside the same file.
 * v0.7.39 FEATURE_120 Step 0 (this slice) lifts the module to
 * `@kodax-ai/agent`'s `orchestration/` so any agent-flavor consumer
 * outside KodaX's coding stack can reuse the same async fan-out
 * wait-and-resume mechanic (ADR-021).
 *
 * The lifted module is **generic over the child-task result type**
 * (`TChildResult`). Coding's `KodaXChildExecutionResult` shape stays in
 * `@kodax-ai/coding`; only `taskId` + `error` are read here. The
 * `result` field is opaque — `composeIdleYieldUserMessage` never
 * inspects it (the fallback banner uses only `taskId` / error message).
 *
 * Replaces the blocking `await_child_task` semantics with a Claude-Code-
 * style "agent turn ends idle, runner waits for the next external event"
 * mechanism. When the agent has dispatched ≥1 children and has nothing
 * else to do, it outputs a brief status line (no tool calls), and
 * Runner.run returns. This module gives the runner layer the utilities
 * it needs to interpret that exit and resume:
 *
 *   1. `detectIdleYield(...)` — synchronous predicate over the run's exit
 *      state. Returns true when the agent turn ended without an
 *      `emit_handoff` AND there are still child tasks the agent is
 *      expected to wait on. False on every other path so legacy
 *      semantics stay untouched.
 *
 *   2. `waitForWakeEvent(...)` — async race between child-task
 *      completions and the MessageQueue. Returns the first event so the
 *      runner layer knows what to splice into the next-turn context.
 *      Cooperative with `AbortSignal` so REPL Esc tears it down promptly.
 *
 *   3. `composeIdleYieldUserMessage(...)` — given a resolved
 *      `WakeEvent`, builds the synthetic user message that the runner
 *      should splice into the next `Runner.run` input.
 *
 * Bug A-G hotfix invariants preserved verbatim from the v0.7.38
 * release:
 *
 *   - Bug B / D / `hasEmittedTerminalVerdict` field: outer loop gates
 *     on terminal Evaluator verdict, NOT on legacy
 *     `managedProtocolPayloadRef.verdict`. The agent layer carries
 *     the boolean as a snapshot field; callers compute it.
 *   - Bug E / `hasPendingBackgroundMessages` field: fast-child race
 *     recovery — keep the loop alive when either the registry OR the
 *     queue still has undelivered work.
 *   - Bug F / abort listener cleanup: explicit
 *     `removeEventListener` in `settle()` even on non-abort wakes.
 *   - Bug A registry cleanup: NOT this module's responsibility — owned
 *     by `registerChildTask` in `task-registry.ts`.
 */

import type { KodaXMessage, KodaXContentBlock } from '@kodax-ai/llm';

import type { MessageQueue, QueuedMessage } from '../messaging/index.js';
import type { ChildTaskRegistry } from './task-registry.js';

/**
 * Env-flag gate for the runner outer-loop wiring.
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

/** Snapshot of the agent run's exit state, computed by the runner layer. */
export interface IdleYieldSnapshot {
  /**
   * The last assistant message's tool-call count from the Runner.run
   * transcript. Idle-yield is signalled when this is 0 (Runner
   * exited via the no-tool-calls branch, not via a tool-driven
   * handoff).
   */
  readonly lastAssistantToolCallCount: number;
  /**
   * Number of child tasks still in the registry when Runner.run
   * returned. Reads `registry.size` at the boundary. Idle-yield only
   * fires when this is > 0 OR `hasPendingBackgroundMessages` is true
   * — otherwise there's nothing to wait for and the stop is a real
   * terminal event.
   */
  readonly pendingChildTaskCount: number;
  /**
   * True if the run's managed-protocol payload has been populated
   * with a handoff (typically `emit_handoff` for the worker→evaluator
   * boundary). False = the run ended without a handoff. Idle-yield
   * REQUIRES this to be false; otherwise the handoff target already
   * owns the next step.
   */
  readonly hasEmittedHandoff: boolean;
  /**
   * v0.7.38 FEATURE_155 Bug B+D hotfix — true if the run's managed-
   * protocol payload has been populated with a terminal verdict
   * (`accept` / `blocked`; `revise` triggers a chain re-run, not
   * idle-yield continuation). Without this gate the outer loop would
   * keep re-entering `Runner.run` after a terminal verdict — wasting
   * LLM turns on post-verdict child notifications. Idle-yield
   * REQUIRES this to be false; same reasoning as `hasEmittedHandoff`
   * but for the verdict side.
   */
  readonly hasEmittedTerminalVerdict: boolean;
  /**
   * v0.7.38 FEATURE_155 Bug E hotfix — true if the background-priority
   * message queue still has undelivered banners destined for the
   * caller agent. Set this alongside `pendingChildTaskCount` because
   * of the **fast-child race**: the dispatch IIFE may enqueue a
   * notification BEFORE its promise resolves, and the registry's
   * `.finally(delete)` cleanup runs in the same microtask burst.
   * When a child completes faster than the surrounding Runner.run
   * iteration (e.g. a sub-second probe vs a multi-second LLM call),
   * the registry entry is removed BEFORE the outer loop reads
   * `pendingChildTaskCount` — making the snapshot see `0`, breaking
   * the loop, and orphaning the banner in the background queue.
   * With this field, the loop stays in the wait state whenever
   * there's still something to deliver, regardless of which arm
   * (registry or queue) carries it.
   *
   * Drained only by the outer loop's `composeIdleYieldUserMessage`
   * call AFTER `waitForWakeEvent` returns. The mid-turn drain caps
   * at `user` priority post-FEATURE_155, so this is the **only**
   * consumer of background-priority messages — losing it strands
   * the banner.
   */
  readonly hasPendingBackgroundMessages: boolean;
}

/**
 * Pure predicate. True when the agent turn ended via the
 * "no tool calls + still has pending children" path that idle-yield
 * is designed to handle.
 *
 * The conjunction terms are deliberately independent — caller can mix
 * in additional gating (e.g. a feature flag) without rewriting this.
 * Returning false here means "treat the run as terminal / delegate to
 * legacy semantics" and is the safe default. The current term set is:
 * `lastAssistantToolCallCount`, `hasEmittedHandoff`,
 * `hasEmittedTerminalVerdict`, and (`pendingChildTaskCount` OR
 * `hasPendingBackgroundMessages`) — the last pair forms the wait-or-
 * resume gate (fast-child race recovery; see field docs).
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

/**
 * FEATURE_167 (v0.7.41) — terminal-verdict-missing predicate.
 *
 * Companion to `detectIdleYield`, gating the OPPOSITE half of the
 * outer-loop exit decision: when the inner Runner.run loop exits
 * with no tool calls AFTER a handoff has fired but BEFORE the
 * Evaluator has emitted a terminal verdict, the run is structurally
 * INCOMPLETE — the audit step is missing. `detectIdleYield` correctly
 * returns false in this state (the gate at line 174 short-circuits on
 * `hasEmittedHandoff`), so the outer loop currently terminates with
 * `recorder.verdict === undefined`. Downstream `deriveFinalStatus`
 * then falls back to `signal:'COMPLETE'`, falsely reporting success
 * for a failed audit (production session 20260515_185354).
 *
 * This predicate identifies that exact missing-verdict state so the
 * outer loop can branch into a retry path (inject a "call emit_verdict"
 * prompt and re-invoke the Evaluator) before falling through to a
 * synthesized fallback verdict.
 *
 * **Disjoint from `detectIdleYield`** by construction:
 *
 *   - `detectIdleYield` requires `!hasEmittedHandoff`
 *   - `detectMissingTerminalVerdict` requires `hasEmittedHandoff`
 *
 * Both also require `lastAssistantToolCallCount === 0`. Both gate on
 * `!hasEmittedTerminalVerdict`. The two predicates partition the
 * "Evaluator turn just exited text-only" space cleanly — no run can
 * satisfy both.
 *
 * **Pending children take precedence over verdict retry.** Predicate
 * is intentionally `pendingChildTaskCount <= 0 && !hasPendingBackgroundMessages`
 * so that if Evaluator dispatched audit children and is correctly
 * idle-yielding for them (FEATURE_155 Bug C discipline), the
 * verdict-missing retry does NOT fire — `detectIdleYield` handles
 * that path instead. Only when there's nothing left to wait on does
 * the verdict-missing branch take over.
 */
export function detectMissingTerminalVerdict(
  snapshot: IdleYieldSnapshot,
): boolean {
  if (snapshot.lastAssistantToolCallCount > 0) return false;
  if (!snapshot.hasEmittedHandoff) return false;
  if (snapshot.hasEmittedTerminalVerdict) return false;
  // Defer to idle-yield when there's pending wait work.
  if (snapshot.pendingChildTaskCount > 0) return false;
  if (snapshot.hasPendingBackgroundMessages) return false;
  return true;
}

/**
 * Discriminated union surfacing the reason a wake completed.
 *
 * Generic over `TChildResult` so coding-flavor consumers can carry
 * their `KodaXChildExecutionResult` shape through `child-completed`
 * wakes without the agent layer naming the type. This module only
 * reads `taskId` (for the fallback banner) and `error` — `result` is
 * opaque pass-through.
 */
export type WakeEvent<TChildResult = unknown> =
  | {
      readonly kind: 'child-completed';
      readonly taskId: string;
      readonly result: TChildResult;
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

export interface WaitForWakeEventOptions<TChildResult = unknown> {
  /**
   * Live ChildTaskRegistry snapshot. The waiter wraps each entry's
   * promise so the FIRST settling child wins the race.
   *
   * **NOTE**: the waiter does NOT delete entries on settlement — the
   * registry's normal cleanup path (`registerChildTask`'s built-in
   * `.finally` chain) owns deletion. Wrapping doesn't double-consume.
   */
  readonly registry: ChildTaskRegistry<TChildResult>;
  /** Process-global message queue surface (FEATURE_115 substrate). */
  readonly messageQueue: MessageQueue;
  /**
   * AgentId filter for queue dequeues. Use `undefined` to match
   * main-thread messages (the standard queue scope).
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
 *     agent's next-turn context).
 *   - Abort-safe: if `abortSignal` fires before any other event, the
 *     waiter resolves with `{ kind: 'aborted' }`. Already-settled
 *     child promises are NOT cancelled — the registry's owner handles
 *     them on the next turn.
 *
 * Caller responsibilities:
 *   - Pass the EXACT registry snapshot (not a copy) so subsequent
 *     dispatches the agent performs after wake are visible to the
 *     next `waitForWakeEvent` call.
 *   - Splice the returned messages / child result into the agent's
 *     next Runner.run input. The waiter does not itself construct
 *     synthetic user-message bytes — that's the runner-layer's job.
 */
export function waitForWakeEvent<TChildResult = unknown>(
  options: WaitForWakeEventOptions<TChildResult>,
): Promise<WakeEvent<TChildResult>> {
  const { registry, messageQueue, agentId, abortSignal, pollIntervalMs = 100 } =
    options;

  return new Promise<WakeEvent<TChildResult>>((resolve) => {
    let settled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    // v0.7.38 FEATURE_155 Bug F hotfix — abort listener leak. Without
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
    const settle = (event: WakeEvent<TChildResult>): void => {
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
    // registry here; `registerChildTask` attaches a
    // `.finally(() => registry.delete(childId))` so settled entries
    // disappear before the next `waitForWakeEvent` call iterates.
    // Without that cleanup an already-settled promise's `.then` fires
    // synchronously in the microtask queue and resolves this wake with
    // a spurious `child-completed` event — the FEATURE_155 v0.7.38
    // Bug A hotfix landed the dispatch-side fix.
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
 * Compose the synthetic user message spliced after an agent idle-yield
 * resume. The runner outer loop calls this with the resolved
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
 *     minimal one from the wake event so the agent still observes
 *     the resolution rather than silently looping again.
 *
 *   - `aborted`: caller is expected to break out before reaching this
 *     helper. If reached anyway, returns `undefined` so the outer
 *     loop treats it as a terminal exit.
 *
 * Returns `undefined` when the wake yields no spliceable content —
 * the outer loop treats that as a real terminal exit.
 */
/**
 * FEATURE_121 (v0.7.40) — Envelope aggregate budget enforcer.
 *
 * Pure `string[] → string[]` transform applied to drained envelope
 * fragments before they're joined into a single synthetic user
 * message. The coding layer provides the implementation that knows
 * how to spill oversized fragments to disk and replace them with
 * preview + path markers (see `@kodax-ai/coding`
 * `createEnvelopeAggregateBudgetEnforcer`). The agent layer only
 * sees this opaque function type — **no `@kodax-ai/coding` symbols
 * may leak into this signature**, otherwise ADR-021 layer
 * independence breaks and `@kodax/agent` cannot build standalone.
 */
export type EnvelopeAggregateEnforcer = (
  fragments: readonly string[],
) => readonly string[] | Promise<readonly string[]>;

/**
 * FEATURE_159 (v0.7.40) — mode-split synthetic.
 *
 * Pre-FEATURE_159: every wake-drained message was wrapped in a single
 * `_synthetic: true` user message. This was correct for child-task
 * notifications (the agent needs to see them; the human doesn't), but
 * WRONG for user-typed prompts that arrived via chat-while-waiting —
 * those got hidden from the transcript so users couldn't see their own
 * messages echoed in the conversation history.
 *
 * Post-FEATURE_159: fragments are partitioned by `msg.mode`. Two
 * separate messages may be emitted:
 *   1. Synthetic banner (`_synthetic: true`) — concatenates
 *      `task-notification` + `system-reminder` content. Hidden from
 *      REPL display; the agent sees it as context. Spliced FIRST so it
 *      reads as the "tail of the prior turn" before the new prompt.
 *   2. Real user message (no `_synthetic`) — concatenates `prompt`
 *      content from chat-while-waiting. Renders as a normal user
 *      bubble in transcript. Spliced AFTER the banner so the chain
 *      reads naturally as "previous turn outputs → user follow-up".
 *
 * Aggregate budget enforcer applies ONLY to the synthetic banner
 * fragments (the side that can carry child-task envelopes of arbitrary
 * size). User prompts pass through unchanged — the user's intent must
 * never be silently truncated.
 *
 * Return type changed from `KodaXMessage | undefined` to
 * `readonly KodaXMessage[]` (possibly empty). Callers must spread the
 * result into their next-iteration input.
 */
export async function composeIdleYieldUserMessage<TChildResult = unknown>(
  wakeEvent: WakeEvent<TChildResult>,
  drainBackgroundQueue: () => readonly QueuedMessage[],
  enforceAggregate?: EnvelopeAggregateEnforcer,
): Promise<readonly KodaXMessage[]> {
  const promptFragments: string[] = [];
  const syntheticFragments: string[] = [];

  const intake = (msg: QueuedMessage): void => {
    if (typeof msg.content !== 'string' || msg.content.length === 0) return;
    if (msg.mode === 'prompt') {
      promptFragments.push(msg.content);
    } else {
      // 'task-notification' / 'system-reminder' / future synthetic modes.
      syntheticFragments.push(msg.content);
    }
  };

  if (wakeEvent.kind === 'messages-arrived') {
    for (const msg of wakeEvent.messages) intake(msg);
  }

  if (wakeEvent.kind !== 'aborted') {
    const drained = drainBackgroundQueue();
    for (const msg of drained) intake(msg);
  }

  // Defensive fallback — child-* wake with empty queue. Only shape
  // that can reach this branch is a misbehaving dispatch path that
  // resolved the promise without enqueuing; surface a minimal banner
  // (synthetic, not user-visible) so the agent still observes the
  // resolution rather than silently looping again.
  if (promptFragments.length === 0 && syntheticFragments.length === 0) {
    if (wakeEvent.kind === 'child-completed') {
      syntheticFragments.push(
        `<task-completed task_id="${wakeEvent.taskId}">\n(child task completed; no summary available)\n</task-completed>`,
      );
    } else if (wakeEvent.kind === 'child-failed') {
      syntheticFragments.push(
        `<task-completed task_id="${wakeEvent.taskId}">\nfailed: ${wakeEvent.error.message}\n</task-completed>`,
      );
    }
  }

  const messages: KodaXMessage[] = [];

  if (syntheticFragments.length > 0) {
    // Aggregate budget enforcer applies only here — task-notification
    // envelopes are the side that can balloon into MB of child output.
    const enforced = enforceAggregate
      ? await enforceAggregate(syntheticFragments)
      : syntheticFragments;
    if (enforced.length > 0) {
      messages.push({
        role: 'user',
        content: enforced.join('\n\n'),
        // Hidden in REPL display — agent-only context.
        _synthetic: true,
      });
    }
  }

  if (promptFragments.length > 0) {
    messages.push({
      role: 'user',
      // No `_synthetic` flag — this IS the user's typed input echoed
      // into the transcript as a normal user bubble. Multiple drained
      // prompts (rare: user typed N before wake) are joined with the
      // same `\n\n---\n\n` separator the REPL's `popAllEditable` uses,
      // so the agent sees a structured boundary between them.
      content: promptFragments.join('\n\n---\n\n'),
    });
  }

  return messages;
}
