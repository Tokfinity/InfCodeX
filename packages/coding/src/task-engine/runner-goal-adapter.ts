/**
 * FEATURE_192 v0.7.44 — runner-driven goal lifecycle adapter.
 *
 * Encapsulates the wiring that turns a host-supplied `GoalRuntimeBinding`
 * (from `goal/runtime-wiring.ts`) into a pair of `beforeNextTurn` +
 * `stopHook` closures that the runner-driven outer loop can pass into
 * `Runner.run`. The factory composes three independent concerns at the
 * same lifecycle layer:
 *
 *   1. **FEATURE_164 base drain**: caller-supplied
 *      `baseBeforeNextTurn` performs the mid-turn user-prompt queue
 *      drain. Goal-agnostic; preserved verbatim.
 *
 *   2. **FEATURE_192 goal accounting + auto-continuation**: when a goal
 *      runtime binding is provided, `withGoalBeforeNextTurn` wraps the
 *      base drain with turn-end token-delta + wall-time accounting,
 *      and `withGoalStopHook` wraps the inner stop hook so a Worker
 *      text-only termination auto-reanimates with a continuation
 *      prompt when the goal is active. Both wraps are no-ops when
 *      `goalRuntime` is undefined (sync-dispatch / non-REPL test
 *      harness).
 *
 *   3. **FEATURE_123 per-turn flood counter reset**: the
 *      `sendMessageTurnCounter` lives on `baseCtx`; resetting it at
 *      every turn boundary belongs in the outermost `beforeNextTurn`
 *      composition (after the goal wrap fires its accounting but
 *      before the next turn observes a fresh counter).
 *
 * The factory also owns `turnStartMsRef` — the wall-clock anchor used
 * by `getTurnStartMs`. Hiding it inside the adapter scope ensures the
 * runner-driven caller cannot accidentally read a stale value mid-turn.
 *
 * Lift rationale: pre-extraction this composition lived inline at
 * `runner-driven.ts:1595-1677` (~80 LoC). Per CLAUDE.md "many small
 * files" principle and explicit user guidance to refactor when
 * runner-driven.ts inflates, this module owns the composition and
 * runner-driven keeps only a thin call site.
 */

import type { StopHookFn } from '@kodax-ai/agent';
import type { GoalRuntimeBinding } from '../goal/runtime-wiring.js';
import { verifyGoalCompletion, withGoalBeforeNextTurn, withGoalStopHook } from '../goal/index.js';
import type { GoalCompletionVerifier } from '../goal/sidecar-bind.js';
import type { KodaXMessage, KodaXTokenUsage } from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import type { ManagedMutationTracker } from '../types.js';
import { buildVerifierContext } from '../agent-runtime/middleware/sidecar-verifier/verifier-context-builder.js';
import { invokeSidecarVerifier } from '../agent-runtime/middleware/sidecar-verifier/verifier.js';

/** Shape of the token usage cell that the LLM adapter writes per call. */
interface TokenStateCell {
  readonly current: {
    readonly lastUsage?: KodaXTokenUsage | undefined;
  };
}

/** Shape of the per-turn flood counter (FEATURE_123). */
interface SendMessageTurnCounter {
  count: number;
}

/** Narrow shape for the tool-execution context — only the throttle slot is read. */
interface BaseCtxLike {
  readonly sendMessageTurnCounter?: SendMessageTurnCounter;
}

/** Narrowed `beforeNextTurn` ctx — matches both lifecycle composer's `BeforeNextTurnFnCtx` AND Runner's wider `{agent, transcript, iteration}` via structural subtyping. */
interface BeforeNextTurnCtx {
  readonly transcript: readonly KodaXMessage[];
  readonly iteration: number;
}

type BeforeNextTurnFn = (ctx: BeforeNextTurnCtx) => Promise<readonly KodaXMessage[]>;

export interface RunnerGoalAdapterDeps {
  /**
   * Host-supplied goal binding, or undefined for sync-dispatch / non-
   * REPL test harnesses. When undefined the adapter returns the base
   * drain + composed stop hook unchanged (still handles the
   * FEATURE_123 counter reset).
   */
  readonly goalRuntime: GoalRuntimeBinding | undefined;

  /**
   * The runner's per-call token usage cell, updated by the LLM
   * adapter. Read by `getTurnStartMs`/`getLatestUsage` to compute
   * turn-end accounting.
   */
  readonly tokenStateRef: TokenStateCell;

  /**
   * Tool-execution context. Adapter reads only `sendMessageTurnCounter`
   * to zero it at every turn boundary.
   */
  readonly baseCtx: BaseCtxLike;

  /**
   * FEATURE_164 mid-turn user-prompt drain — caller-supplied because
   * the drain semantics belong to the runner (uses `getMessageQueue`
   * + `options.events`). Adapter wraps it with goal accounting and
   * the counter reset.
   */
  readonly baseBeforeNextTurn: BeforeNextTurnFn;

  /**
   * The composed inner stop hook (sidecar verifier + extension
   * turn:complete bridge + any other stops). Adapter wraps it with
   * `withGoalStopHook` so a text-only termination can auto-reanimate
   * with a continuation prompt when a goal is active.
   */
  readonly composedStopHook: StopHookFn;

  /**
   * Mutable transcript snapshot ref. The adapter updates this at every
   * turn boundary (`turnCtx.transcript` inside `beforeNextTurn`) so the
   * real `verifyComplete` closure can read the latest transcript when
   * `update_goal({complete})` fires mid-turn. The snapshot is at most
   * one turn boundary stale relative to the model's claim, which is
   * sufficient for verification (the claim itself is part of the
   * current turn being verified).
   *
   * Optional — when omitted the verifier wire degrades gracefully
   * (verifyComplete falls back to the binding's REPL-supplied stub).
   */
  readonly transcriptRef?: { current: readonly KodaXMessage[] };

  /**
   * Mutation tracker for file-edit summary. Reused from the F184 stop-
   * hook path — same mutation tracker is fed to both verifiers so a
   * goal-complete claim sees the same fileEdit context as a text-only
   * termination would.
   */
  readonly mutationTracker?: ManagedMutationTracker;

  /**
   * Resolved verifier provider/model (same shape the F184 stop-hook
   * path uses). When both are present, the adapter installs a real
   * F184-backed `verifyComplete` on the binding via
   * `goalRuntime.installVerifyComplete`. When either is missing
   * (verifier disabled / no provider resolvable) the binding keeps
   * the REPL-supplied stub.
   */
  readonly verifierProvider?: KodaXBaseProvider;
  readonly verifierModel?: string;
}

export interface RunnerGoalAdapter {
  readonly beforeNextTurn: BeforeNextTurnFn;
  readonly stopHook: StopHookFn;
}

/**
 * Build the runner-driven goal lifecycle adapter.
 *
 * Composition (outer → inner):
 *   beforeNextTurn = counter-reset-and-clock-advance
 *                  ∘ withGoalBeforeNextTurn (if goalRuntime)
 *                  ∘ baseBeforeNextTurn
 *   stopHook       = withGoalStopHook (if goalRuntime)
 *                  ∘ composedStopHook
 *
 * Side-effects: maintains a private `turnStartMsRef` that the goal
 * lifecycle ctx reads via closure. After every `beforeNextTurn` fires,
 * advances the ref so the NEXT turn's wall-time delta starts from
 * "now after the queue drain", not from adapter construction.
 */
export function buildRunnerGoalAdapter(
  deps: RunnerGoalAdapterDeps,
): RunnerGoalAdapter {
  const {
    goalRuntime,
    tokenStateRef,
    baseCtx,
    baseBeforeNextTurn,
    composedStopHook,
    transcriptRef,
    mutationTracker,
    verifierProvider,
    verifierModel,
  } = deps;

  // Wall-clock anchor — private to the adapter; goal lifecycle ctx
  // closes over it via the getTurnStartMs accessor.
  const turnStartMsRef = { current: Date.now() };

  const goalLifecycleCtx = goalRuntime
    ? {
        ...goalRuntime.lifecycleCtx,
        getLatestUsage: () => tokenStateRef.current.lastUsage,
        getTurnStartMs: () => turnStartMsRef.current,
      }
    : undefined;

  // F184-backed verifyComplete installation. When the host supplied a
  // goalRuntime AND we have all the verifier inputs in scope, build the
  // real verifier closure and swap it into the binding via the
  // pluggable slot. The closure captures `transcriptRef` BY REFERENCE,
  // so any mid-run update by the beforeNextTurn handler below is
  // observed when the model fires `update_goal({complete})`.
  //
  // When any input is missing (no goalRuntime / no verifier provider /
  // no transcript ref) the binding keeps the REPL-supplied stub
  // (`async () => ({ok: true})`). Stub semantics are documented in
  // sidecar-bind.ts as "fail-open per F184 convention" — same path
  // F184 takes when the resolver can't find a provider.
  if (goalRuntime && verifierProvider && transcriptRef) {
    const realInvokeVerifier: GoalCompletionVerifier = (verifierOptions) =>
      invokeSidecarVerifier(verifierOptions);
    goalRuntime.installVerifyComplete(async (goal) => {
      const builtCtx = buildVerifierContext({
        transcript: transcriptRef.current,
        // No `lastAssistantText` at tool-call time — the model emitted
        // tool calls, not text. The verifier infers the claim from the
        // synthetic objective query that `verifyGoalCompletion`
        // prepends, plus the transcript window.
        lastAssistantText: '',
        mutationTracker,
      });
      return verifyGoalCompletion({
        goal,
        recentTranscript: builtCtx.recentTranscript,
        lastAssistantText: builtCtx.lastAssistantText,
        currentTurnUserQueries: builtCtx.currentTurnUserQueries,
        fileEditSummary: builtCtx.fileEditSummary,
        invokeVerifier: realInvokeVerifier,
        providerInvocation: {
          provider: verifierProvider,
          model: verifierModel,
        },
      });
    });
  }

  const wrappedBeforeNextTurn = goalLifecycleCtx
    ? withGoalBeforeNextTurn(goalLifecycleCtx, baseBeforeNextTurn, {
        enabled: true,
      })
    : baseBeforeNextTurn;

  const beforeNextTurn: BeforeNextTurnFn = async (turnCtx) => {
    // Update the transcript snapshot ref BEFORE delegating to the
    // wrapped base. The snapshot becomes available to verifyComplete
    // from this point forward; subsequent tool calls in the next
    // iteration will see the new value via closure capture.
    if (transcriptRef) {
      transcriptRef.current = turnCtx.transcript;
    }
    const result = await wrappedBeforeNextTurn(turnCtx);
    // Advance the wall-clock anchor for the next turn's accounting.
    turnStartMsRef.current = Date.now();
    // FEATURE_123 v0.7.44 — reset the per-turn send_message flood
    // throttle counter at every turn boundary. Counter lives on
    // baseCtx (the substrate's tool-exec context, allocated once
    // per runtime by `buildToolExecutionContext`).
    if (baseCtx.sendMessageTurnCounter) {
      baseCtx.sendMessageTurnCounter.count = 0;
    }
    return result;
  };

  const stopHook: StopHookFn = goalLifecycleCtx
    ? withGoalStopHook(goalLifecycleCtx, composedStopHook, { enabled: true })
    : composedStopHook;

  return { beforeNextTurn, stopHook };
}
