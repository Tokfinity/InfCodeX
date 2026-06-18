/**
 * LLM adapter — bridges the runner-driven AMA chain to the KodaX provider
 * stream surface.
 *
 * Hosts `buildRunnerLlmAdapter` (the per-run factory that returns a
 * `(messages, agent) => RunnerLlmResult` adapter consumed by `Runner.run`)
 * plus the C1-parity helpers (`agentNameToManagedRole`,
 * `flattenNormalizedForEmitterInput`) that drive the fenced-block fallback
 * path. The adapter owns: system-message folding, throttle reminder
 * injection, per-role reasoning ladder resolution, the second-tier
 * retry/recovery loop, max_tokens L4 escalation + L5 continuation, the
 * P2b write-turn cap, cost accounting, iteration events, and tool-call
 * fence-fallback synthesis.
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~1340–2187 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXRedactedThinkingBlock,
  KodaXRetryAfterEvent,
  KodaXThinkingBlock,
  KodaXTokenUsage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { KODAX_ESCALATED_MAX_OUTPUT_TOKENS } from '@kodax-ai/llm';
import type { Agent, RunnerLlmResult } from '@kodax-ai/agent';
import { resolveProvider } from '../../../providers/index.js';
import {
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_MAX_EMPTY_COMPLETION_RETRIES,
  KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS,
  MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS,
} from '../../../constants.js';
import {
  bucketProviderPayloadSize,
  cleanupIncompleteToolCalls,
  describeTransientProviderRetry,
  emitResilienceDebug,
  estimateProviderPayloadBytes,
  validateAndFixToolHistory,
} from '../../../agent.js';
import {
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  classifyResilienceError,
  resolveResilienceConfig,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from '../../../resilience/index.js';
import { waitForRetryDelay } from '../../../retry-handler.js';
import {
  createCostTracker,
  formatCostReport,
  getSummary as getCostSummary,
  recordRetry as recordCostRetry,
  recordUsage as recordCostUsage,
  type CostTracker,
} from '../../../agent-runtime/middleware/cost-tracker.js';
import { estimateTokens } from '../../../tokenizer.js';
import {
  reasoningModeToDepth,
  resolveReasoningMode,
  resolveRoleReasoning,
  type ReasoningRole,
} from '../../../reasoning.js';
import type {
  KodaXEvents,
  KodaXOptions,
  KodaXReasoningMode,
} from '../../../types.js';
import {
  emitProviderRateLimit,
  emitStreamEnd,
} from '../../../agent-runtime/event-emitter.js';
import {
  MANAGED_CONTROL_PLANE_MARKERS,
  sanitizeManagedStreamingText,
} from './sanitize.js';
import type { ContextTokenSnapshotRef } from './compaction.js';
import type { TodoStore } from '../../todo-store.js';
import {
  buildTodoReminderText,
  detectAgentTransition,
  resetTodoReminderState,
  shouldFireTodoReminder,
  tickTodoReminder,
  type TodoReminderState,
} from '../../todo-throttle-reminder.js';

/**
 * Cumulative token state captured by the LLM adapter across a full
 * runner chain, exposed back to `runManagedTaskViaRunner` so it can
 * populate `result.contextTokenSnapshot`. The REPL UI uses the snapshot
 * to refresh its token counter after every run.
 */
export interface RunnerAdapterTokenState {
  totalTokens: number;
  lastUsage?: KodaXTokenUsage;
  source: 'api' | 'estimate';
}

// FEATURE_193 (v0.7.43) deep V1 cleanup: `agentNameToManagedRole` +
// `flattenNormalizedForEmitterInput` deleted. They were C1-parity helpers
// for the fenced-block fallback path that synthesized a tool call when
// the LLM emitted a `kodax-task-*` block without calling the corresponding
// `emit_*` tool. V1 chain retirement removed every reachable agent name
// (SCOUT/PLANNER/GENERATOR) the mapping recognized, so `agentNameToManagedRole`
// always returned `undefined` and the synthesize block short-circuited
// before either helper ran. The Sidecar Verifier (FEATURE_184) drives
// verdicts out-of-band and does not need the V2 worker to fall through
// to the fence-synthesizer.

/**
 * True when a successfully-returned provider turn carries nothing
 * actionable — no text, no tool calls, and no thinking. Distinct from a
 * stream-incomplete error (which throws before reaching here) and from a
 * canonical text-only termination (text present, no tool — the FEATURE_190
 * V2 exit path). See KODAX_MAX_EMPTY_COMPLETION_RETRIES for why the
 * adapter re-streams instead of returning such a turn to the runner.
 */
function isEmptyCompletion(raw: {
  textBlocks?: readonly { text: string }[];
  toolBlocks?: readonly KodaXToolUseBlock[];
  thinkingBlocks?: readonly unknown[];
}): boolean {
  const text = (raw.textBlocks ?? []).map((b) => b.text).join('').trim();
  const toolCount = raw.toolBlocks?.length ?? 0;
  const thinkingCount = raw.thinkingBlocks?.length ?? 0;
  return text.length === 0 && toolCount === 0 && thinkingCount === 0;
}

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
  tokenStateRef?: { current: RunnerAdapterTokenState },
  /**
   * FEATURE_078: optional callback that returns Scout's current
   * `downstream_reasoning_hint` (L3 input). Called once per per-role
   * adapter invocation so the resolver sees the hint as soon as the
   * Scout payload is populated. Returning `undefined` bypasses L3 and
   * falls back to L2 (`agent.reasoning.default`) clamped by L1
   * (user ceiling). The callback closes over the AMA frame's recorder.
   */
  getScoutReasoningHint?: () => KodaXReasoningMode | undefined,
  /**
   * v0.7.40 — optional API-accurate context-size snapshot ref. The
   * adapter writes this ref after each successful LLM stream so the
   * AMA compaction hook (`buildManagedTaskCompactionHook`) can read
   * `usage.totalTokens` + delta-adjusted message growth instead of
   * the transcript-only estimate. Without this wiring, the hook
   * systematically underestimated context by the system + tools
   * schema overhead (~20-35k after FEATURE_114 4→2 role
   * consolidation) and never triggered compaction. See
   * `_internal/managed-task/compaction.ts` for the consumer side.
   */
  contextTokenSnapshotRef?: ContextTokenSnapshotRef,
  /**
   * FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder hook. When
   * provided, the adapter:
   *   1. detects agent transitions and resets the counter on each one
   *   2. checks `shouldFireTodoReminder` before each provider call;
   *      if it fires, appends the `<system-reminder>` text to `system`
   *      so the model sees it before its next response
   *   3. ticks the counter forward (one round = one adapter call)
   * Omitting either argument disables the reminder logic entirely
   * (older callers / unit-test fixtures).
   */
  todoStore?: TodoStore,
  todoReminderState?: TodoReminderState,
  /**
   * Per-run iteration counter holder shared with the idle-yield outer
   * loop. The counter must live in the SAME scope as the Runner's tool
   * loop it reports against: the caller resets `current` to 0 at the top
   * of every `runOnce` (each fresh `Runner.run`), so the value the
   * adapter reports stays aligned with the Runner's per-invocation
   * iteration index and `iter <= maxIter` holds even across idle-yield
   * resumes. Omitting it (tests / direct invocations) falls back to a
   * local per-adapter counter — same shape, just not reset across runs.
   */
  iterationStateRef?: { current: number },
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  // FEATURE_072 parity: the REPL's token-count indicator reads
  // `onIterationEnd` to refresh after each worker LLM turn. The iteration
  // index is reported as the `iter` of `onIterationStart`/`onIterationEnd`;
  // its denominator (`maxIter`) is the real per-invocation Runner cap
  // (`MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS`), not a stale constant — so
  // the SDK callback reflects the ceiling the Runner actually enforces.
  const localIterationState = { current: 0 };
  const iterationState = iterationStateRef ?? localIterationState;
  const MAX_ITER_HINT = MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS;

  // Cost tracker — one per session; `recordUsage` is called after every
  // provider.stream usage payload. REPL /cost reads through
  // `events.getCostReport.current`.
  let costTracker: CostTracker = createCostTracker();
  if (options.events?.getCostReport) {
    options.events.getCostReport.current = () =>
      formatCostReport(getCostSummary(costTracker));
  }
  const activeModel = options.modelOverride ?? options.model;

  return async (messages, agent) => {
    // Strip every leading contiguous system message and concatenate their
    // content. v0.7.22-style flows pushed a single agent-instructions system
    // prompt and nothing else, so taking only `messages[0]` was enough. The
    // Runner-driven path stacks [compaction-summary, post-compact-ledger,
    // post-compact-file-content, ...] after compaction+inject, and after a
    // handoff `replaceSystemMessage` only swaps [0] — the rest stay leading
    // system entries. Keeping only the first one would strand agent role
    // instructions (Scout/Planner/Generator/Evaluator) behind the summary and
    // still leak secondary system messages into the transcript, which the
    // provider layer now merges but which would otherwise confuse strict
    // proxies that reject any non-leading system message.
    let cut = 0;
    while (cut < messages.length && messages[cut]?.role === 'system') {
      cut += 1;
    }
    const systemParts: string[] = [];
    for (let i = 0; i < cut; i += 1) {
      const content = messages[i]!.content;
      const text = typeof content === 'string' ? content : '';
      if (text.trim().length > 0) {
        systemParts.push(text);
      }
    }
    let system = systemParts.join('\n\n');
    const transcript = messages.slice(cut);

    // FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder. Detect
    // agent transitions to reset the counter (per-task scope, but a
    // role swap is a natural reset point — Scout → Planner → Generator
    // → Evaluator each represent a fresh attempt at making progress on
    // the list). Then, if the threshold has been hit and we're armed,
    // append the reminder text to `system` so the model reads it
    // alongside its role instructions on this exact turn. Finally,
    // tick the counter forward — one adapter call = one round.
    if (todoStore && todoReminderState) {
      if (detectAgentTransition(todoReminderState, agent.name)) {
        resetTodoReminderState(todoReminderState);
      }
      if (shouldFireTodoReminder(todoReminderState, todoStore)) {
        const reminder = buildTodoReminderText(todoStore);
        system = system.length > 0 ? `${system}\n\n${reminder}` : reminder;
      }
      tickTodoReminder(todoReminderState);
    }

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    // FEATURE_078 (v0.7.29): resolve per-role reasoning through the L1-L4
    // chain rather than reading `agent.reasoning?.default` directly:
    //   L1 (user ceiling)   ← `--reasoning <mode>` / options.reasoningMode
    //   L2 (agent default)  ← agent.reasoning.default + .max
    //   L3 (scout hint)     ← Scout's downstream_reasoning_hint, if any
    //   L4 (revise escalate) — handled later by escalateThinkingDepth
    // Pre-FEATURE_078 path was L2 only; that path is preserved when no
    // user ceiling override + no scout hint is in play (resolver collapses).
    const userCeiling = resolveReasoningMode(options);
    const scoutHint = getScoutReasoningHint?.();
    // FEATURE_193 (v0.7.43): V1 chain retired — Worker is the sole agent
    // exercised in the AMA Runner chain. The SCOUT/PLANNER/GENERATOR
    // arms of this resolution always missed in V2 production and folded
    // to `'sa'`; the explicit literal here matches that behaviour with
    // zero functional change.
    const role: ReasoningRole = 'sa';
    const reasoningMode = resolveRoleReasoning(role, userCeiling, agent.reasoning, scoutHint);
    const providerReasoning: KodaXReasoningRequest | undefined =
      reasoningMode === 'off'
        ? { enabled: false, mode: 'off' }
        : {
            enabled: true,
            mode: reasoningMode,
            depth: reasoningModeToDepth(reasoningMode),
          };

    iterationState.current += 1;
    options.events?.onIterationStart?.(iterationState.current, MAX_ITER_HINT);

    // FEATURE_164 (v0.7.41) — mid-iteration yield retired here.
    //
    // The legacy v0.7.26 F1 parity check used to fire `hasQueuedFollowUp`
    // at this exact boundary and `return { text:'', toolCalls:[] }` to
    // force Runner.run to exit the loop. v0.7.40 FEATURE_159 made it
    // worse by routing the predicate through MessageQueue directly —
    // any user-typed prompt entering the queue mid-Q1 triggered the
    // empty-turn yield, polluting the transcript with `{type:'text',
    // text:''}` placeholder, surfacing `[No response text was produced
    // for this round]` in the REPL, and feeding the model an empty
    // assistant turn before the next user message.
    //
    // Replacement: claudecode-style mid-turn injection via the agent
    // package's `beforeNextTurn` hook (see the Runner.run wiring in
    // `runManagedTaskViaRunnerInner`). The hook drains queued user
    // prompts AFTER tool execution and BEFORE the next LLM call,
    // splicing them as real user messages into the transcript — Worker
    // keeps running, the LLM sees the new prompts in its next turn,
    // and no empty assistant turn ever reaches the transcript.

    let streamResult: {
      textBlocks?: readonly { text: string }[];
      toolBlocks?: readonly KodaXToolUseBlock[];
      thinkingBlocks?: readonly (
        | KodaXThinkingBlock
        | KodaXRedactedThinkingBlock
      )[];
      usage?: KodaXTokenUsage;
    };
    if (overrideStream) {
      streamResult = await overrideStream(transcript, wireTools, system);
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      const providerName = options.provider ?? provider.name ?? 'anthropic';
      // Shard 6d-P: restore the legacy second-tier retry/recovery loop
      // (agent.ts:1955-2198). Without this, any transient stream error
      // (network/terminated/stream-incomplete/idle-timeout) aborts the
      // whole managed run on the first failure — no retry, no
      // `onProviderRecovery` event, and the REPL's onError handler ends
      // up printing the raw error via console.log which Ink places below
      // the user prompt instead of inline with the worker output.
      //
      // Mirrors the legacy loop: classify → decide → onProviderRecovery →
      // optional non-streaming fallback → executeRecovery (prune
      // incomplete tool_use turns) → waitForRetryDelay → retry.
      const resilienceCfg = resolveResilienceConfig(providerName);
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs;
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;
      const boundaryTracker = new StableBoundaryTracker();
      const supportsFallback = typeof provider.supportsNonStreamingFallback === 'function'
        ? provider.supportsNonStreamingFallback()
        : false;
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback: resilienceCfg.enableNonStreamingFallback && supportsFallback,
      });
      // P2b write-turn cap retired in v0.7.42. The 2026-04 bench
      // (9622a909) proved RST is time-based on zhipu-coding (308s
      // server kill window), not payload-size-based on any provider —
      // so the correct defense layer is `streamMaxDurationMs` + non-
      // streaming fallback (configured per-provider in registry.ts),
      // not a `max_output_tokens` shrink on the write-turn boundary.
      // The L4 escalation + L5 continuation paths below handle any
      // remaining max_tokens cases regardless of provider.
      let providerMessages: KodaXMessage[] = [...transcript];
      // Clean incomplete tool calls and validate tool history before
      // every provider call (CAP-002). Both helpers come from
      // `agent-runtime/history-cleanup.ts` and are shared with the
      // SA-mode substrate (see catch-terminals.ts:runCatchCleanup).
      providerMessages = cleanupIncompleteToolCalls(providerMessages);
      providerMessages = validateAndFixToolHistory(providerMessages);
      let attempt = 0;
      let raw!: Awaited<ReturnType<typeof provider.stream>>;
      // FEATURE_085 parity for the Scout/Runner path: mirror the main
      // agent loop's max_tokens escalation (cd213e4). When a capped-budget
      // turn returns stop_reason:max_tokens we retry the SAME stream call
      // once with KODAX_ESCALATED_MAX_OUTPUT_TOKENS (64K). At most one
      // escalation per adapter invocation — if 64K still hits the cap,
      // we surface the partial result so the Runner's outer loop can see
      // it and decide next steps. Full L5 continuation (meta "break into
      // smaller pieces") is handled by prompt-level guidance in system.ts
      // + write/edit tool descriptions rather than framework plumbing
      // through the Runner turn boundary.
      let hasEscalatedForCurrentAdapterCall = false;
      // Independent budget (separate from the resilience error budget and
      // the max_tokens escalation) for re-streaming a fully-empty turn.
      let emptyCompletionRetries = 0;
      while (true) {
        attempt += 1;
        boundaryTracker.beginRequest(
          providerName,
          activeModel ?? provider.getModel?.() ?? 'unknown',
          providerMessages,
          attempt,
          false,
        );
        telemetryBoundary(boundaryTracker.snapshot());

        const retryTimeoutController = new AbortController();
        let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          retryTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
        }, API_HARD_TIMEOUT_MS);
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(
              new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
            );
          }, API_IDLE_TIMEOUT_MS);
        }
        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          if (idleTimer) clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(
                new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
              );
            }, API_IDLE_TIMEOUT_MS);
          }
        };
        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, system);
        emitResilienceDebug('[resilience:request]', {
          provider: providerName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
        });

        // Wire the boundary tracker into the stream callbacks — the
        // coordinator inspects these markers to decide whether a failure
        // happened before the first delta, mid-stream, post-tool, etc.
        const streamOptions = {
          modelOverride: activeModel,
          onTextDelta: (text: string) => {
            boundaryTracker.markTextDelta(text);
            resetIdleTimer();
            // M2 parity (v0.7.26) — scrub managed control-plane markers
            // and incomplete managed fences from the streamed delta
            // before surfacing to `events.onTextDelta`. Without this,
            // mid-turn `[managed-task] ...` / `<scout_verdict>` tags
            // briefly appear in REPL live output even though they're
            // stripped from the final turn text. Matches legacy
            // behaviour where managed-worker streams routed through
            // `sanitizeManagedStreamingText` before the REPL saw them.
            // The sanitize call trims — only apply it when we actually
            // detect a marker in this delta to preserve mid-token
            // whitespace in the common clean-delta case.
            const hasMarker = text.includes('```')
              || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
            const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
            if (outText.length === 0) return;
            options.events?.onTextDelta?.(outText);
          },
          onThinkingDelta: (text: string) => {
            boundaryTracker.markThinkingDelta(text);
            resetIdleTimer();
            options.events?.onThinkingDelta?.(text);
          },
          onThinkingEnd: (thinking: string) => {
            options.events?.onThinkingEnd?.(thinking);
          },
          onToolInputDelta: options.events?.onToolInputDelta,
          onRateLimit: (rateAttempt: number, maxRetries: number, delayMs: number) => {
            resetIdleTimer();
            if (options.events) {
              emitProviderRateLimit(options.events, rateAttempt, maxRetries, delayMs);
            }
          },
          onRetryAfter: (event: KodaXRetryAfterEvent) => {
            resetIdleTimer();
            costTracker = recordCostRetry(costTracker, {
              provider: event.provider,
              waitMs: event.waitMs,
              reason: event.reason,
              source: event.source,
            });
            options.events?.onRetryAfter?.(event);
          },
        };

        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            streamOptions,
            retrySignal,
          );
          // max_tokens escalation: if the capped budget hit the cap and
          // we haven't yet escalated this adapter call, stage
          // KODAX_ESCALATED_MAX_OUTPUT_TOKENS for the next iteration and
          // re-enter the loop. Skipped when the user explicitly set
          // KODAX_MAX_OUTPUT_TOKENS or the effective budget already meets
          // the escalated threshold. Mirrors agent.ts:2264-2284.
          if (
            raw.stopReason === 'max_tokens'
            && !hasEscalatedForCurrentAdapterCall
            && !process.env.KODAX_MAX_OUTPUT_TOKENS
            && provider.getEffectiveMaxOutputTokens(activeModel) < KODAX_ESCALATED_MAX_OUTPUT_TOKENS
          ) {
            hasEscalatedForCurrentAdapterCall = true;
            provider.setMaxOutputTokensOverride(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
            options.events?.onRetry?.(
              `Output budget reached, escalating to ${KODAX_ESCALATED_MAX_OUTPUT_TOKENS} tokens and retrying the same turn`,
              1,
              1,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Escalation is a same-turn re-issue (change max_tokens, replay same messages),
            // not an error recovery. Reverse the `attempt += 1` at the top of the loop so
            // this iteration does not consume a slot from `resilienceCfg.maxRetries`. The
            // next iteration's attempt will be the same as this one, and subsequent real
            // errors still get the full retry budget.
            attempt -= 1;
            continue;
          }
          // Empty-completion retry: a finish_reason-complete turn with no
          // text, no tool calls, and no thinking is a degraded response
          // (common on budget OpenAI-compat providers under load / right
          // after a 429). Handing it back would hit the runner's no-tool
          // terminal branch and end the task silently. Re-stream the same
          // turn a bounded number of times. Mirrors the L1 escalation's
          // `attempt -= 1` so this does not consume the resilience error
          // budget. Timers are cleared before the backoff await so the
          // idle/hard timeout cannot abort the controller mid-wait. A
          // genuine text-only termination (text present) is untouched, and
          // the `max_tokens` stop reason is excluded so the escalation + L5
          // ladder above keeps sole ownership of that path.
          if (
            isEmptyCompletion(raw)
            && raw.stopReason !== 'max_tokens'
            && emptyCompletionRetries < KODAX_MAX_EMPTY_COMPLETION_RETRIES
            && !options.abortSignal?.aborted
          ) {
            emptyCompletionRetries += 1;
            options.events?.onRetry?.(
              `Provider returned an empty turn, retrying ${emptyCompletionRetries}/${KODAX_MAX_EMPTY_COMPLETION_RETRIES}`,
              emptyCompletionRetries,
              KODAX_MAX_EMPTY_COMPLETION_RETRIES,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            attempt -= 1;
            await waitForRetryDelay(
              KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS * emptyCompletionRetries,
              options.abortSignal,
            );
            continue;
          }
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (
            error.name === 'AbortError'
              && retryTimeoutController.signal.aborted
              && !options.abortSignal?.aborted
          ) {
            const reason = (retryTimeoutController.signal as { reason?: { message?: string } })
              .reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax-ai/llm');
            error = new KodaXNetworkError(reason, true);
          }

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          options.events?.onProviderRecovery?.({
            stage: decision.failureStage,
            errorClass: decision.reasonCode,
            attempt,
            maxAttempts: resilienceCfg.maxRetries,
            delayMs: decision.delayMs,
            recoveryAction: decision.action,
            ladderStep: decision.ladderStep,
            fallbackUsed: decision.shouldUseNonStreaming,
            serverRetryAfterMs: decision.serverRetryAfterMs,
          });
          // Dedicated rate-limit event so REPL can render a distinct 429
          // banner (separate from the generic retry UI).
          if (decision.reasonCode === 'rate_limit' && options.events) {
            emitProviderRateLimit(
              options.events,
              attempt,
              resilienceCfg.maxRetries,
              decision.delayMs,
            );
          }
          if (!options.events?.onProviderRecovery && decision.action !== 'manual_continue') {
            options.events?.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming && typeof provider.complete === 'function') {
            const fallbackTimeoutController = new AbortController();
            const fallbackSignal = options.abortSignal
              ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
              : fallbackTimeoutController.signal;
            const fallbackHardTimer = setTimeout(() => {
              fallbackTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
            }, API_HARD_TIMEOUT_MS);
            try {
              if (idleTimer) clearTimeout(idleTimer);
              if (hardTimer) clearTimeout(hardTimer);
              hardTimer = undefined;
              idleTimer = undefined;
              boundaryTracker.beginRequest(
                providerName,
                activeModel ?? provider.getModel?.() ?? 'unknown',
                providerMessages,
                attempt,
                true,
              );
              telemetryBoundary(boundaryTracker.snapshot());
              raw = await provider.complete(
                providerMessages,
                [...wireTools],
                system,
                providerReasoning,
                {
                  modelOverride: activeModel,
                  onTextDelta: (text: string) => {
                    boundaryTracker.markTextDelta(text);
                    options.events?.onTextDelta?.(text);
                  },
                  onThinkingDelta: (text: string) => {
                    boundaryTracker.markThinkingDelta(text);
                    options.events?.onThinkingDelta?.(text);
                  },
                  onThinkingEnd: (thinking: string) => {
                    options.events?.onThinkingEnd?.(thinking);
                  },
                  signal: fallbackSignal,
                },
                fallbackSignal,
              );
              break;
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            } finally {
              clearTimeout(fallbackHardTimer);
            }
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) and must
          // bypass the regular retry-budget gate. It's gated by its own
          // `thinkingSanitizationUsed` latch inside the coordinator, so
          // it can fire at most once per request chain regardless of how
          // many normal retries already happened. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Don't bill an attempt slot for the sanitize step — same
            // rationale as the L1 escalation reversal at line ~2546.
            attempt -= 1;
            await waitForRetryDelay(decision.delayMs, options.abortSignal);
            continue;
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            // Preserve in-flight providerMessages on the thrown error so the
            // outer wrapper's session-snapshot save can persist real history
            // instead of `[]`. Non-enumerable so JSON-serializing telemetry
            // does not dump conversation history into logs. The outer catch
            // uses Array.isArray as a guard.
            Object.defineProperty(error, '__kodaxRecoveredMessages', {
              value: providerMessages,
              enumerable: false,
            });
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;

          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          hardTimer = undefined;
          idleTimer = undefined;
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      // M6 parity (v0.7.26) — L5 continuation ladder. When L1 escalation
      // is exhausted and the model still hit max_tokens mid-text (no
      // tool blocks, has text), inject a synthetic user "Continue from
      // where you left off" message and re-stream up to
      // KODAX_MAX_MAXTOKENS_RETRIES times, accumulating text +
      // thinkingBlocks across turns. Mirrors legacy agent.ts:2316-2334.
      // Without this, long Generator replies that blow through the
      // escalated 64K cap get truncated silently — the assistant stops
      // mid-sentence and the Runner exits with a partial answer.
      let l5Retries = 0;
      let accumulatedText = (raw.textBlocks ?? []).map((b) => b.text).join('');
      type ThinkingBlock = KodaXThinkingBlock | KodaXRedactedThinkingBlock;
      const accumulatedThinking: ThinkingBlock[] | undefined = raw.thinkingBlocks
        ? [...raw.thinkingBlocks]
        : undefined;
      while (
        raw.stopReason === 'max_tokens'
        && (raw.toolBlocks?.length ?? 0) === 0
        && accumulatedText.trim().length > 0
        && l5Retries < KODAX_MAX_MAXTOKENS_RETRIES
      ) {
        l5Retries += 1;
        options.events?.onTextDelta?.('\n\n[max_tokens reached, continuing...]\n\n');
        // Push the partial assistant turn + synthetic user continuation
        // onto the outgoing transcript. The provider will see the full
        // mid-thought state and pick up seamlessly.
        //
        // Thinking blocks accumulated so far must ride along on the
        // synthetic assistant turn. Without them, providers in strict
        // thinking-mode (deepseek V4) reject the next replay with
        // "reasoning_content must be passed back to the API" — the
        // synthetic turn would be a thinking-less assistant message in
        // a thinking-enabled request, which violates their per-turn
        // contract. Mirrors what agent.ts:2294 does for the legacy
        // path: thinking + text + tool_use stack on the assistant
        // message in history.
        const assistantContent: KodaXContentBlock[] = [
          ...(accumulatedThinking ?? []),
          { type: 'text', text: accumulatedText },
        ];
        providerMessages = [
          ...providerMessages,
          { role: 'assistant', content: assistantContent } as KodaXMessage,
          {
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. '
                + 'Pick up mid-thought if that is where the cut happened. '
                + 'Break remaining work into smaller pieces.',
            }],
          } as KodaXMessage,
        ];
        options.events?.onRetry?.(
          `max_tokens mid-text, appending continuation ${l5Retries}/${KODAX_MAX_MAXTOKENS_RETRIES}`,
          l5Retries,
          KODAX_MAX_MAXTOKENS_RETRIES,
        );
        const l5Signal = options.abortSignal ?? undefined;
        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            {
              modelOverride: activeModel,
              onTextDelta: (text: string) => {
                const hasMarker = text.includes('```')
                  || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
                const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
                if (outText.length === 0) return;
                options.events?.onTextDelta?.(outText);
              },
              onThinkingDelta: (text: string) => {
                options.events?.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking: string) => {
                options.events?.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: options.events?.onToolInputDelta,
              onRateLimit: (rateAttempt: number, maxRetries: number, delayMs: number) => {
                if (options.events) {
                  emitProviderRateLimit(options.events, rateAttempt, maxRetries, delayMs);
                }
              },
              onRetryAfter: (event: KodaXRetryAfterEvent) => {
                costTracker = recordCostRetry(costTracker, {
                  provider: event.provider,
                  waitMs: event.waitMs,
                  reason: event.reason,
                  source: event.source,
                });
                options.events?.onRetryAfter?.(event);
              },
            },
            l5Signal,
          );
        } catch {
          // L5 retries are best-effort — any failure here falls back to
          // the partial result we already have.
          break;
        }
        const nextText = (raw.textBlocks ?? []).map((b) => b.text).join('');
        if (nextText) accumulatedText += nextText;
        if (raw.thinkingBlocks && accumulatedThinking) {
          accumulatedThinking.push(...raw.thinkingBlocks);
        }
        // Exit early on tool calls or natural stop.
        if ((raw.toolBlocks?.length ?? 0) > 0 || raw.stopReason !== 'max_tokens') {
          break;
        }
      }

      streamResult = {
        textBlocks: accumulatedText ? [{ text: accumulatedText }] : raw.textBlocks,
        toolBlocks: raw.toolBlocks,
        thinkingBlocks: accumulatedThinking ?? raw.thinkingBlocks,
        usage: raw.usage,
      };
    }

    // Update cumulative token state for the final contextTokenSnapshot.
    if (tokenStateRef && streamResult.usage) {
      const current = tokenStateRef.current;
      tokenStateRef.current = {
        totalTokens: streamResult.usage.totalTokens ?? current.totalTokens,
        lastUsage: streamResult.usage,
        source: 'api',
      };
    }

    // v0.7.40 — refresh the API-accurate snapshot ref so the AMA
    // compaction hook can compute `resolveContextTokenCount(transcript,
    // snapshot)` on its next call. `messages` here is the adapter's
    // input (the transcript at LLM-call time); subsequent Runner
    // appends (assistant + tool_results) become the delta on top of
    // this baseline. Mirrors SA path's `createCompletedTurnTokenSnapshot`
    // in `run-substrate.ts`. Inlined rather than imported to keep the
    // snapshot-construction logic colocated with its single consumer.
    if (contextTokenSnapshotRef && streamResult.usage) {
      const baselineEstimatedTokens = estimateTokens(messages as KodaXMessage[]);
      const apiTotal = streamResult.usage.totalTokens;
      if (typeof apiTotal === 'number' && Number.isFinite(apiTotal) && apiTotal >= 0) {
        contextTokenSnapshotRef.current = {
          currentTokens: apiTotal,
          baselineEstimatedTokens,
          source: 'api',
          usage: streamResult.usage,
        };
      }
    }

    // Record turn usage into the cost tracker so `/cost` reflects AMA spend.
    if (streamResult.usage) {
      const providerName = options.provider ?? 'anthropic';
      costTracker = recordCostUsage(costTracker, {
        provider: providerName,
        model: options.modelOverride ?? options.model ?? 'unknown',
        inputTokens: streamResult.usage.inputTokens,
        outputTokens: streamResult.usage.outputTokens,
        cacheReadTokens: streamResult.usage.cachedReadTokens,
        cacheWriteTokens: streamResult.usage.cachedWriteTokens,
      });
    }

    // onStreamEnd fires after the provider finishes the current turn's
    // stream. The Runner-driven adapter funnels every turn through this
    // single return-path so the event fires once per stream.
    if (options.events) emitStreamEnd(options.events);

    // Fire onIterationEnd so the REPL token-count indicator can refresh
    // after each worker turn. `scope: 'worker'` mirrors the FEATURE_072
    // tagging — every Runner-driven iteration runs inside a worker role,
    // never the top-level REPL agent.
    if (options.events?.onIterationEnd) {
      const usage = streamResult.usage;
      const tokenCount = usage?.totalTokens ?? usage?.outputTokens ?? 0;
      options.events.onIterationEnd({
        iter: iterationState.current,
        maxIter: MAX_ITER_HINT,
        tokenCount,
        tokenSource: usage ? 'api' : 'estimate',
        usage,
        scope: 'worker',
      });
    }

    const text = (streamResult.textBlocks ?? []).map((b) => b.text).join('');
    const toolCalls = (streamResult.toolBlocks ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    }));

    // FEATURE_193 (v0.7.43) deep V1 cleanup: the C1-parity fenced-block
    // fallback (synthesize tool_call when LLM emits a `kodax-task-*` block
    // without calling the matching `emit_*` tool) used to live here. With
    // V1 chain retired, only `'evaluator'` (Sidecar Verifier) remains as
    // a valid emit role, and verdicts are driven out-of-band by Sidecar
    // Verifier — the Worker's terminal turn never needs the fence-to-
    // tool-call synthesis. `agentNameToManagedRole` only matched the V1
    // SCOUT/PLANNER/GENERATOR agent names, so the entire branch was a
    // dead short-circuit in V2 production.

    // Forward thinking blocks so
    // `buildAssistantMessageFromLlmResult` can prepend them to the
    // assistant content. Required for Anthropic extended thinking —
    // provider returns 400 if prior assistant turns with tool_use are
    // missing the thinking block in history.
    const thinkingBlocks = streamResult.thinkingBlocks;
    return { text, toolCalls, thinkingBlocks };
  };
}
