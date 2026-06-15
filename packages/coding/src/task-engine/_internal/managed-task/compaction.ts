/**
 * Compaction hook for the Runner-driven path — v0.7.26 parity.
 *
 * Legacy `agent.ts` (v0.7.22) ran `intelligentCompact` before every
 * provider.stream call: check `needsCompaction` → fire
 * `onCompactStart` → call `intelligentCompact` → fire
 * `onCompactStats` / `onCompact` / `onCompactEnd` → replace local
 * messages with the compacted view. The Runner-driven rewrite dropped
 * this entire pipeline; AMA sessions that exceed the compaction
 * threshold hit context window overflow and provider 400s.
 *
 * This module provides a full parity port:
 *   - loads compaction config from the repo root
 *   - tracks a per-run circuit breaker (same threshold as legacy)
 *   - delegates to `@kodax-ai/agent/compact` for the actual summarisation
 *   - fires the legacy event surface (`onCompactStart` / `onCompactStats`
 *     / `onCompact` / `onCompactEnd` / `onCompactedMessages`) so the
 *     REPL can render its "compacting…" UI and refresh its local
 *     transcript mirror
 *   - re-injects the post-compact artifact ledger summary AND the
 *     recent-file contents (legacy `buildPostCompactAttachments` +
 *     `buildFileContentMessages` + `injectPostCompactAttachments`) —
 *     landed in commit 16e4093 (M3 parity). Without this step, long
 *     sessions crossing the compaction threshold lose post-mutation
 *     file context and the LLM hallucinates stale file state. The
 *     token budget is the smaller of (freedTokens × budgetRatio) and
 *     POST_COMPACT_TOKEN_BUDGET, matching Claude Code's fixed-cap
 *     policy.
 *
 * v0.7.40 — three-phase parity with SA's `runCompactionLifecycle`
 * (`run-substrate.ts:603-632` + `compaction-orchestration.ts`):
 *
 *   1. `microcompact` — zero-LLM-cost cleanup every call (prunes old
 *      tool_results / image blocks past `maxAge=20` turns). SA path
 *      ran this every turn; AMA path was missing it entirely.
 *
 *   2. `intelligentCompact` — LLM-based summarisation (existing path).
 *      Trigger check now uses `resolveContextTokenCount(transcript,
 *      snapshot)` where `snapshot.currentTokens` carries the LAST
 *      LLM call's API-reported `usage.totalTokens` (system + tools +
 *      transcript). The pre-v0.7.40 hook compared
 *      `estimateTokens(transcript)` to the threshold, which
 *      systematically underestimated by the system+tools overhead
 *      (~20-35k after FEATURE_114's 4→2 role consolidation + FEATURE_161
 *      Worker prompt growth) and never triggered.
 *
 *   3. `gracefulCompactDegradation` — deterministic prune fallback
 *      when LLM compact threw / returned `compacted: false` / left
 *      context still above trigger × pruningGapRatio. SA path always
 *      ran this as the third phase of `runCompactionLifecycle`; AMA
 *      path was missing it, so a single failing LLM compact silently
 *      let context grow unbounded.
 *
 * Behaviour delta vs legacy (documented):
 *   - custom-instructions arg to `intelligentCompact` is `undefined`
 *     (the Runner path doesn't expose per-compaction overrides);
 *   - systemPrompt arg is `undefined` (the provider carries it).
 */

import {
  buildFileContentMessages,
  buildPostCompactAttachments,
  compact as intelligentCompact,
  DEFAULT_MICROCOMPACTION_CONFIG,
  DEFAULT_POST_COMPACT_CONFIG,
  gracefulCompactDegradation,
  injectPostCompactAttachments,
  microcompact,
  needsCompaction,
  POST_COMPACT_TOKEN_BUDGET,
  resolveContextWindow,
  type CompactionConfig,
  type CompactionUpdate,
} from '@kodax-ai/agent';
import type { AgentMessage } from '@kodax-ai/agent';

import { resolveProvider } from '../../../providers/index.js';
import { loadCompactionConfig } from '../../../compaction-config.js';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from '../../../agent-runtime/coding-compaction-prompts.js';
import type {
  KodaXContextTokenSnapshot,
  KodaXEvents,
  KodaXMessage,
  KodaXOptions,
} from '../../../types.js';
import { estimateTokens } from '../../../tokenizer.js';
import {
  createEstimatedContextTokenSnapshot,
  resolveContextTokenCount,
} from '../../../token-accounting.js';

const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;

export type RunnerCompactionHook = (
  transcript: readonly AgentMessage[],
) => Promise<readonly AgentMessage[] | undefined>;

/**
 * Mutable ref handed in by `runner-driven.ts` so the hook can read the
 * latest API-reported context size. The adapter writes this ref after
 * every successful LLM stream completion via
 * `createCompletedTurnTokenSnapshot(messages, usage)`. When the snapshot
 * is `undefined` (no LLM call has completed yet on this run), the hook
 * falls back to raw `estimateTokens(transcript)` — same as the pre-v0.7.40
 * behaviour for the cold-start case.
 *
 * The hook also writes this ref after a successful compaction
 * (using `createEstimatedContextTokenSnapshot(compacted)`) so the
 * downstream delta corrections rebase to the compacted state instead
 * of the pre-compaction over-estimate.
 */
export interface ContextTokenSnapshotRef {
  current: KodaXContextTokenSnapshot | undefined;
}

export interface BuildManagedTaskCompactionHookOptions {
  /**
   * Optional snapshot ref. When provided, the hook's trigger check
   * uses API-accurate token accounting (matches SA path's
   * `resolveContextTokenCount(messages, snapshot)`). When omitted, the
   * hook falls back to raw `estimateTokens(transcript)` — preserves
   * backwards-compat with callers that don't yet wire the snapshot.
   */
  readonly contextTokenSnapshotRef?: ContextTokenSnapshotRef;
  /**
   * FEATURE_177 v0.7.42 — fires once after a compaction actually
   * modified `workingMessages` (i.e., the same condition that gates
   * `onCompactedMessages`). Used by `runner-driven.ts` to clear the
   * per-task `readFileStateCache`: the cache returns stubs that point
   * the LLM back at earlier `tool_result` blocks, but those blocks may
   * have been summarized away during compaction, so the stub would no
   * longer be actionable. Clearing forces the next Read to return real
   * content. Errors thrown by the callback are swallowed in the same
   * spirit as the existing `events?.onCompacted*` fire-and-forget
   * pattern so a buggy side-effect can't crash the compaction hook.
   */
  readonly onPostCompact?: () => void;
}

/**
 * Build a compaction hook for `Runner.run`. The hook is safe to call on
 * every iteration — it short-circuits cheaply when the transcript is
 * below the trigger threshold. Errors are swallowed by core's hook
 * dispatch; any failure here skips compaction for that iteration.
 */
export async function buildManagedTaskCompactionHook(
  options: KodaXOptions,
  hookOptions: BuildManagedTaskCompactionHookOptions = {},
): Promise<RunnerCompactionHook | undefined> {
  const provider = resolveProvider(options.provider ?? 'anthropic');
  const activeModel = options.modelOverride ?? options.model;
  // Resolve the provider's per-model window first so loadCompactionConfig's
  // adaptive triggerPercent bucket matches the active model. Without this, a
  // task started on ark-coding/deepseek-v4-pro (1M) would inherit
  // ark-coding/glm-5.1's bucket (200K → 60%) and fire compaction
  // ~150K tokens too early. SDK (`options.compaction`) and user-config
  // overrides still win.
  const providerWindow =
    provider.getEffectiveContextWindow?.(activeModel) ?? provider.getContextWindow();
  const compactionConfig: CompactionConfig = await loadCompactionConfig(
    providerWindow,
    options.compaction,
  );
  if (!compactionConfig.enabled) {
    return undefined;
  }
  // Single source of truth (CAP-056): the same cascade the per-turn SA path
  // (`resolvePerTurnProvider`) and the status-bar indicator
  // (`resolveEffectiveCompactionInfo`) use, so AMA compaction triggers on
  // the same window the user sees. `resolveContextWindow` honours
  // `compactionConfig.contextWindow` (SDK / user override) first, then the
  // provider's per-model window — replacing the hand-rolled cascade that
  // could drift from those two consumers.
  const contextWindow = resolveContextWindow(compactionConfig, provider, activeModel);
  const events = options.events;
  const snapshotRef = hookOptions.contextTokenSnapshotRef;
  const onPostCompact = hookOptions.onPostCompact;

  let consecutiveFailures = 0;

  return async (transcript) => {
    // The Runner transcript carries an assistant/user/system mix that
    // maps 1:1 onto the KodaXMessage shape intelligentCompact expects.
    const inboundMessages = transcript as unknown as readonly KodaXMessage[];

    // Phase 1: microcompact (free, every call). Mirrors SA path
    // `run-substrate.ts:603`. Returns the input reference when nothing
    // was prunable, so this is effectively zero-cost on quiet turns.
    const microcompacted = microcompact(
      inboundMessages,
      DEFAULT_MICROCOMPACTION_CONFIG,
    ) as readonly KodaXMessage[];
    const microcompactChanged = microcompacted !== inboundMessages;
    let workingMessages: KodaXMessage[] = [...microcompacted] as KodaXMessage[];

    // Circuit breaker gates Phase 2/3 (LLM compact + graceful) only —
    // microcompact (Phase 1) is always allowed because it's
    // LLM-independent and can't fail in the same way.
    const circuitBreakerTripped =
      consecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT;

    // Compute current context size using the API-reported snapshot when
    // available. Critical bugfix (v0.7.40): pre-v0.7.40 the hook used
    // `estimateTokens(transcript)` which counts only message bytes and
    // ignores system + tools schema overhead. After FEATURE_114 (4→2
    // role consolidation) the Worker system prompt grew to 20-35k
    // tokens, so the transcript-only estimate systematically
    // underestimated by that much. With a 200K window's 60% trigger =
    // 120K, the actual API context could sit at 130-150k while the
    // hook saw ~95-115k and never fired. The snapshot-based path
    // matches SA's `resolveContextTokenCount` and triggers on the same
    // metric the status bar displays.
    const currentTokens = snapshotRef?.current
      ? resolveContextTokenCount(workingMessages, snapshotRef.current)
      : estimateTokens(workingMessages);

    const needsCompact = needsCompaction(
      workingMessages,
      compactionConfig,
      contextWindow,
      currentTokens,
    );

    if (!needsCompact) {
      // Below threshold — but microcompact may still have done some
      // free pruning. Return the microcompacted view when it differs
      // so Runner picks up the new transcript.
      if (microcompactChanged) {
        // FEATURE_177 v0.7.42 — microcompact replaces tool_result
        // contents older than maxAge turns with `[Cleared: ...]`
        // stubs. Without this hook firing, the per-task
        // readFileStateCache would keep returning "refer to your
        // earlier read" stubs pointing at tool_results whose actual
        // content has been wiped — the LLM would have no access to
        // either the cached file content or the disk content. Fire
        // onPostCompact (clears the cache) so the next Read goes to
        // disk and the new tool_result carries real content the LLM
        // can act on. Errors swallowed — same fire-and-forget posture
        // as the full-compaction branch below.
        if (onPostCompact) {
          try {
            onPostCompact();
          } catch {
            // intentionally ignored
          }
        }
        return workingMessages as readonly AgentMessage[];
      }
      return undefined;
    }

    // Phase 2: LLM-based intelligent compact. Skipped when the circuit
    // breaker is tripped (3 consecutive failures); falls through to
    // graceful degradation either way.
    let llmCompacted = false;
    let llmThrew = false;
    let compactionUpdate: CompactionUpdate | undefined;
    let tokensBeforeForEvent = currentTokens;

    if (!circuitBreakerTripped) {
      events?.onCompactStart?.();
      try {
        const result = await intelligentCompact(
          workingMessages,
          compactionConfig,
          provider,
          contextWindow,
          undefined, // customInstructions — none for Runner-driven path
          undefined, // systemPrompt — provider carries its own system text
          currentTokens,
          CODING_SUMMARY_PROMPT,
          CODING_UPDATE_SUMMARY_PROMPT,
        );
        tokensBeforeForEvent = result.tokensBefore;

        if (result.compacted) {
          workingMessages = result.messages as KodaXMessage[];
          llmCompacted = true;

          // M3 parity (v0.7.26) — post-compact file + artifact ledger
          // reinjection. When the compaction result carries an
          // `artifactLedger`, build the ledger summary + recent file
          // attachments and re-inject. Without this, long AMA sessions
          // that hit compaction lose critical file context.
          let postCompactAttachments: readonly KodaXMessage[] | undefined;
          if (result.artifactLedger && result.artifactLedger.length > 0) {
            const freedTokens = Math.max(0, result.tokensBefore - result.tokensAfter);
            const attachments = buildPostCompactAttachments(
              result.artifactLedger,
              freedTokens,
            );
            const totalPostCompactBudget = Math.min(
              Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
              POST_COMPACT_TOKEN_BUDGET,
            );
            const fileBudget = Math.max(0, totalPostCompactBudget - attachments.totalTokens);
            const fileMessages = fileBudget > 0
              ? await buildFileContentMessages(result.artifactLedger, fileBudget)
              : [];
            const fullAttachments = {
              ...attachments,
              fileMessages,
              totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
            };
            if (fullAttachments.totalTokens > 0) {
              workingMessages = injectPostCompactAttachments(
                workingMessages,
                fullAttachments,
              );
              postCompactAttachments = [
                ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
                ...fullAttachments.fileMessages,
              ];
            }
          }

          compactionUpdate = result.artifactLedger
            ? {
              anchor: result.anchor,
              artifactLedger: result.artifactLedger,
              memorySeed: result.memorySeed,
              postCompactAttachments,
            }
            : undefined;

          // Reset the counter only when LLM compaction actually brought
          // context below trigger. "Partial success" (same pruning
          // that left context above threshold) keeps the counter
          // climbing toward the breaker. Matches legacy agent.ts:1810.
          const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
          if (result.tokensAfter < triggerTokens) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures += 1;
          }
        } else {
          consecutiveFailures += 1;
        }
      } catch {
        consecutiveFailures += 1;
        llmThrew = true;
        // Fall through to graceful degradation. Don't return yet.
      } finally {
        events?.onCompactEnd?.();
      }
    }

    // Phase 3: graceful degradation. Mirrors SA path
    // `compaction-orchestration.ts:applyGracefulDegradationGate`.
    // Triggers when the LLM compact failed / returned no diff / left
    // context still above `triggerTokens × pruningGapRatio`. This is
    // the determinstic backstop that prevents context from growing
    // unbounded when the LLM keeps refusing to summarise.
    //
    // Uses the SAME snapshot-aware accounting as the trigger check
    // (Phase 2) so the gate's "still over" decision is based on API
    // total tokens (system + tools + transcript), not transcript-only
    // estimate. Without this parity, the gate could systematically
    // miss the threshold for the same reason the legacy hook missed
    // it (the system + tools overhead bug).
    const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
    const gapRatio = compactionConfig.pruningGapRatio ?? 0.8;
    const postLlmTokens = snapshotRef?.current
      ? resolveContextTokenCount(workingMessages, snapshotRef.current)
      : estimateTokens(workingMessages);
    const stillOverTrigger = postLlmTokens > triggerTokens * gapRatio;

    let degraded = false;
    if (stillOverTrigger) {
      const pruned = gracefulCompactDegradation(
        workingMessages,
        contextWindow,
        compactionConfig,
      ) as KodaXMessage[];
      if (pruned !== workingMessages) {
        workingMessages = pruned;
        degraded = true;
      }
    }

    const anyCompactionHappened =
      microcompactChanged || llmCompacted || degraded;
    if (!anyCompactionHappened) {
      // Nothing changed — neither micro nor LLM nor graceful made a
      // diff. Return undefined so Runner doesn't rebuild the transcript
      // identity. When `llmThrew` is true we still return undefined
      // (the failure counter was already incremented above).
      return undefined;
    }

    // Surface stats / event hooks ONLY when LLM or graceful actually
    // changed messages — microcompact-only changes are silent (matches
    // SA path's `commitCompactedHistory`: `onCompactedMessages` fires
    // only when `didCompactMessages` is true, and the SA path's
    // microcompact never emits compaction events either).
    if (llmCompacted || degraded) {
      const finalTokens = estimateTokens(workingMessages);
      events?.onCompactStats?.({
        tokensBefore: tokensBeforeForEvent,
        tokensAfter: finalTokens,
      });
      events?.onCompact?.(tokensBeforeForEvent);
      events?.onCompactedMessages?.(workingMessages, compactionUpdate);
      // FEATURE_177 v0.7.42 — fire post-compact side-effect (clears
      // the read-file-state cache; see `runner-driven.ts` setup).
      // Errors swallowed so a buggy side-effect can't break the
      // compaction hook itself.
      if (onPostCompact) {
        try {
          onPostCompact();
        } catch {
          // intentionally ignored
        }
      }
    } else if (microcompactChanged && onPostCompact) {
      // FEATURE_177 v0.7.42 — needsCompact-but-LLM-threw-and-graceful-
      // didn't-prune edge: microcompact still cleared old tool_results
      // (≥20 turns) to `[Cleared: ...]` stubs. Fire onPostCompact so
      // the readFileStateCache drops entries pointing at those now-
      // cleared blocks. Without this, the cache would keep returning
      // "refer to your earlier read" stubs whose target tool_result is
      // a `[Cleared: ...]` placeholder — the LLM gets no content from
      // either the cache or the transcript.
      try {
        onPostCompact();
      } catch {
        // intentionally ignored
      }
    }

    // Rebase the snapshot to the compacted state so the next
    // `resolveContextTokenCount` delta-correction starts from a fresh
    // baseline. Without this, subsequent hook calls would compute
    // `(stale-api-total) + (small-compacted-transcript - large-baseline)`
    // which under-counts and never re-triggers compaction.
    if (snapshotRef && (llmCompacted || degraded)) {
      snapshotRef.current = createEstimatedContextTokenSnapshot(workingMessages);
    }

    return workingMessages as readonly AgentMessage[];
  };
}
