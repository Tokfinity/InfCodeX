/**
 * Generic outer loop for async fan-out + idle-yield resume.
 *
 * FEATURE_120 v0.7.39 Step 0c. Wraps the `while (true) { Runner.run; if
 * (detectIdleYield) waitForWakeEvent + compose + resume; else break }`
 * control flow so that any agent flavor consuming `@kodax-ai/agent` as
 * a standalone framework can adopt the FEATURE_155 chat-while-waiting
 * pattern without re-implementing the loop and re-discovering the
 * v0.7.38 Bug A-G hotfix invariants.
 *
 * The wrapper does NOT take ownership of any agent-flavor-specific
 * state — recorder access, role mapping, status-bar emission,
 * checkpoint cleanup, chain-reset-on-resume — those flow in through
 * callbacks. The wrapper owns only the universal pieces:
 *
 *   1. Iteration cap (default 64) — defensive against prompt bugs.
 *   2. Per-iteration `runOnce` invocation (callee owns Runner.run
 *      options closure + error-path cleanup chain).
 *   3. Snapshot computation via callback, then `detectIdleYield` gate.
 *   4. Optional `onIdleWaiting` hook fired AFTER the gate passes but
 *      BEFORE the wake wait.
 *   5. `waitForWakeEvent` with the registry / queue / abort plumbing.
 *   6. `composeIdleYieldUserMessage` to splice synthetic input.
 *   7. `resumeAgent` callback to pick the agent for the next iteration.
 *
 * Order is significant — see Risk R4 in v0.7.39 Phase 1c design notes.
 * Tests in `runner-with-idle-yield.test.ts` pin every boundary.
 *
 * The wrapper has zero inbound dependency on coding-flavor types; all
 * agent-flavor specifics flow through `TRunResult` / `TChildResult` /
 * the callbacks (ADR-021).
 */

import type { Agent } from '../primitives/agent.js';
import type { AgentMessage } from '../primitives/agent.js';
import { attachRunnerRecoveryTranscript } from '../primitives/runner.js';
import type { MessageQueue } from '../messaging/index.js';

import { composeIdleYieldUserMessage, type EnvelopeAggregateEnforcer } from './idle-yield.js';
import { detectIdleYield } from './idle-yield.js';
import { waitForWakeEvent } from './idle-yield.js';
import type { IdleYieldSnapshot } from './idle-yield.js';

/** Default iteration cap matches the legacy `IDLE_YIELD_MAX_ITERATIONS` constant. */
export const DEFAULT_IDLE_YIELD_MAX_ITERATIONS = 64;

/**
 * Minimal shape requirement on the run result the caller's `runOnce`
 * returns. The wrapper reads `messages` to replay the transcript into
 * the next iteration after a wake; everything else on the result is
 * opaque pass-through.
 */
export interface RunWithIdleYieldRunResult {
  readonly messages: readonly AgentMessage[];
}

export interface RunWithIdleYieldOptions<
  TRunResult extends RunWithIdleYieldRunResult,
> {
  /** Agent that executes the first iteration of the loop. */
  readonly initialAgent: Agent;
  /** Initial input messages for the first `Runner.run`. */
  readonly initialInput: readonly AgentMessage[];
  /**
   * Per-iteration Runner invocation. Caller closes over its Runner
   * options (llm, guardrails, toolObserver, maxToolLoopIterations,
   * abortSignal, compactionHook, error-path cleanup). The wrapper
   * passes the current `agent` and `input` and awaits the result.
   *
   * **Error-path note**: if `runOnce` rejects, the rejection
   * propagates out of `runWithIdleYield` verbatim — wrapper does not
   * swallow. Caller's `.catch` (if any) must run inside the
   * `runOnce` closure to keep cleanup ordering observable.
   */
  readonly runOnce: (
    agent: Agent,
    input: readonly AgentMessage[],
  ) => Promise<TRunResult>;
  /**
   * Compute the `IdleYieldSnapshot` after each `runOnce` returns.
   * Caller has access to the full run result + any external state
   * via closure (recorder, registry size, queue inspection).
   */
  readonly computeSnapshot: (runResult: TRunResult) => IdleYieldSnapshot;
  /**
   * Live child-task registry. Passed verbatim to `waitForWakeEvent`'s
   * `registry` arm. Mutations to this map between iterations are
   * visible to the next wake.
   */
  /** Process-global message queue. Passed verbatim to `waitForWakeEvent`. */
  readonly messageQueue: MessageQueue;
  /**
   * AgentId scope for the queue arm. `undefined` matches main-thread
   * messages (the default scope a parent agent's dispatch handler
   * targets).
   */
  readonly agentId: string | undefined;
  /** Optional cancellation. Tears the loop down on the next wait boundary. */
  readonly abortSignal?: AbortSignal;
  /**
   * Choose the agent for the next iteration after a wake. Caller has
   * access to the just-finished run result; coding-flavor consumers
   * typically return their `chain.worker` regardless of the result.
   */
  readonly resumeAgent: (runResult: TRunResult) => Agent;
  /**
   * Optional hook fired AFTER `detectIdleYield` returns true but BEFORE
   * `waitForWakeEvent` parks. Used by coding for FEATURE_156 status-bar
   * emission. The `currentAgent` arg is the agent that just ran (so
   * role lookups read the right name on every iteration).
   */
  readonly onIdleWaiting?: (
    currentAgent: Agent,
    runResult: TRunResult,
  ) => void;
  /**
   * FEATURE_213 (v0.7.45) — fired with the user-typed prompt(s) drained on
   * an idle-yield wake (the `mode:'prompt'` fragments spliced into the resume
   * input). The wake path splices these into the agent transcript directly, so
   * unlike the mid-turn `beforeNextTurn` drain there is no other surface that
   * tells the UI about them — without this hook a follow-up typed while waiting
   * for a sub-agent reaches the agent (it answers) but never appears in the
   * transcript. Coding wires this to the same `onMidTurnUserMessages` UI sink.
   */
  readonly onResumedUserPrompts?: (
    contents: readonly string[],
    queuedMessageIds: readonly string[],
  ) => void;
  /**
   * Optional attribution hook for real user prompts spliced during an
   * idle-yield resume. The agent layer stays transport-agnostic; callers that
   * expose live turn IDs can stamp the generated prompt message here.
   */
  readonly resolveResumeTurnId?: () => string | undefined;
  /**
   * Optional hook fired when the iteration cap is hit. Coding does not
   * currently log here (matches v0.7.38 behavior — silent break) but
   * the hook exists so SDK consumers can record the prompt-bug signal.
   */
  readonly onIterationCap?: () => void;
  /**
   * Defensive ceiling on outer-loop iterations. Default 64 matches the
   * legacy `IDLE_YIELD_MAX_ITERATIONS` constant. Set lower in tests to
   * exercise the cap branch quickly.
   */
  readonly maxIterations?: number;
  /**
   * Current contract: the host receives the completed transcript and any
   * same-request user prompt, then admits the complete synthetic banner batch
   * once against physical model capacity. Enqueue-time fixed caps are not used.
   *
   * FEATURE_121 (v0.7.40): optional aggregate budget enforcer for the
   * synthetic user message built from drained background banners. When
   * provided, it transforms the fragment array before they're joined
   * (per-banner per-`<task-completed>` summary chunks remain unchanged
   * by this wrapper — that's the caller's responsibility at enqueue
   * time via `applyToolResultGuardrail`). The aggregate hook only kicks
   * in when N banners' total exceeds the limit set by the coding-layer
   * implementation (default 200KB per claudecode parity).
   *
   * Type is `string[] → string[] | Promise<string[]>` so the agent
   * layer carries no `@kodax-ai/coding` symbols. See
   * `EnvelopeAggregateEnforcer` in idle-yield.ts.
   */
  readonly envelopeAggregateEnforcer?: EnvelopeAggregateEnforcer;
}

/**
 * Run the agent chain with idle-yield resume.
 *
 * On each iteration:
 *   1. Invoke `runOnce(currentAgent, currentInput)`.
 *   2. Increment the iteration counter. If it exceeds
 *      `maxIterations`, call `onIterationCap?.()` and break.
 *   3. Compute the snapshot via `computeSnapshot(runResult)`.
 *   4. If `detectIdleYield(snapshot)` is false (run terminal or
 *      handoff/verdict already emitted), break.
 *   5. Fire `onIdleWaiting?.(currentAgent, runResult)`.
 *   6. Park in `waitForWakeEvent({registry, messageQueue, agentId, abortSignal})`.
 *   7. If wake is `aborted`, break.
 *   8. Build synthetic user message via `composeIdleYieldUserMessage`.
 *      If undefined (truly empty wake), break.
 *   9. Replay: `currentInput = [...runResult.messages, syntheticUserMessage]`,
 *      `currentAgent = resumeAgent(runResult)`, loop.
 *
 * Returns the last `runResult` (the one that broke the loop).
 *
 * Bug A-G hotfix invariants preserved:
 *   - Bug A (registry cleanup): owned by `registerChildTask` —
 *     unaffected by this wrapper.
 *   - Bug B/D (terminal-verdict + handoff gates): caller's
 *     `computeSnapshot` must populate `hasEmittedTerminalVerdict`
 *     and `hasEmittedHandoff` from the canonical recorder source.
 *   - Bug E (fast-child race): caller's `computeSnapshot` must read
 *     `hasPendingBackgroundMessages` alongside the registry size.
 *   - Bug F (abort listener leak): owned by `waitForWakeEvent` —
 *     unaffected by this wrapper.
 */
export async function runWithIdleYield<
  TRunResult extends RunWithIdleYieldRunResult,
>(opts: RunWithIdleYieldOptions<TRunResult>): Promise<TRunResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_IDLE_YIELD_MAX_ITERATIONS;

  let currentAgent: Agent = opts.initialAgent;
  let currentInput: readonly AgentMessage[] = opts.initialInput;
  let runResult: TRunResult;
  let iterations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    runResult = await opts.runOnce(currentAgent, currentInput);

    // Defensive iteration cap — matches the legacy
    // `IDLE_YIELD_MAX_ITERATIONS=64` ceiling at coding's outer loop.
    // Pre-increment semantics: on the (max+1)th iteration the cap
    // fires AFTER runOnce returns but BEFORE snapshot/detect — so a
    // legitimate run that completes at the cap on iteration N still
    // sees its result returned without entering an extra wait.
    if (++iterations > maxIterations) {
      opts.onIterationCap?.();
      break;
    }

    const snapshot = opts.computeSnapshot(runResult);
    if (!detectIdleYield(snapshot)) break;

    opts.onIdleWaiting?.(currentAgent, runResult);

    const wakeEvent = await waitForWakeEvent({
      messageQueue: opts.messageQueue,
      agentId: opts.agentId,
      abortSignal: opts.abortSignal,
    });
    if (wakeEvent.kind === 'aborted') break;

    // FEATURE_159 (v0.7.40) — `composeIdleYieldUserMessage` now returns
    // an array; mode-split may emit two separate messages (synthetic
    // banner + real user prompt). Empty array = wake yielded no
    // content; treat as terminal exit (same as the legacy `undefined`
    // path).
    let resumeMessages: readonly AgentMessage[];
    try {
      resumeMessages = await composeIdleYieldUserMessage(
      wakeEvent,
      () =>
        opts.messageQueue.dequeue({
          agentId: opts.agentId,
          maxPriority: 'background',
        }),
      opts.envelopeAggregateEnforcer,
      // FEATURE_213 — surface the user-typed prompt(s) drained on this wake to
      // the UI, so a follow-up typed while waiting for a sub-agent appears in
      // the transcript (it otherwise only reaches the agent input below).
      opts.onResumedUserPrompts,
      opts.resolveResumeTurnId,
        runResult.messages,
      );
    } catch (error) {
      if (error instanceof Error) {
        const recoverableTranscript = runResult.messages[0]?.role === 'system'
          ? runResult.messages.slice(1)
          : runResult.messages;
        attachRunnerRecoveryTranscript(error, recoverableTranscript);
      }
      throw error;
    }
    if (resumeMessages.length === 0) break;

    currentInput = [...runResult.messages, ...resumeMessages];
    currentAgent = opts.resumeAgent(runResult);
  }

  return runResult;
}
