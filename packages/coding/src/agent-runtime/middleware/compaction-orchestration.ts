/**
 * Compaction lifecycle orchestration — CAP-060 + CAP-062 + CAP-063
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-060-compaction-lifecycle-orchestration-intelligentcompact--circuit-breaker--events
 *   - docs/features/v0.7.29-capability-inventory.md#cap-062-graceful-compact-degradation-gating
 *   - docs/features/v0.7.29-capability-inventory.md#cap-063-pre-stream-validateandfixtoolhistory--oncompactedmessages-emission
 *
 * Class 1 (substrate). Three sequential phases of the compaction
 * lifecycle:
 *
 *   1. **`tryIntelligentCompact` (CAP-060)** — Runs `intelligentCompact`
 *      under a try/catch/finally with the four lifecycle events
 *      (`onCompactStart` / `onCompactStats` / `onCompact` / `onCompactEnd`),
 *      delegates post-compact attachment construction to CAP-061
 *      (`applyPostCompactAttachments`), and accounts for the circuit
 *      breaker counter:
 *      - SUCCESS that drops below trigger → reset counter to 0
 *      - PARTIAL SUCCESS still over trigger → increment counter
 *      - LLM threw → increment counter; fall through to graceful
 *      - CIRCUIT BREAKER TRIPPED (counter ≥ limit) → skip LLM, return
 *        identity so graceful degradation runs unconditionally
 *
 *   2. **`applyGracefulDegradationGate` (CAP-062)** — When
 *      `needsCompact` is true AND `estimateTokens(compacted) >
 *      triggerTokens × pruningGapRatio`, runs the deterministic
 *      `gracefulCompactDegradation` (CAP-028) and emits
 *      `onCompactStats` / `onCompact` if it actually pruned. Catches
 *      three branches:
 *      a. LLM threw (compacted === messages from catch)
 *      b. Circuit breaker tripped (else branch entered with no
 *         compacted-vs-messages diff)
 *      c. LLM partial success that left context still too high
 *
 *   3. **`commitCompactedHistory` (CAP-063)** — Always runs
 *      `validateAndFixToolHistory` (CAP-002) on the post-compaction
 *      messages, commits via `messages = compacted`, and emits
 *      `onCompactedMessages` only when `didCompactMessages` is true.
 *      Returns a fresh `contextTokenSnapshot` only when compaction
 *      actually fired (caller keeps the existing snapshot otherwise).
 *
 * **`runCompactionLifecycle`** is the umbrella that composes all three
 * for the agent.ts call site.
 *
 * Migration history: extracted from `agent.ts:605-744` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.4c.
 */

import type { KodaXBaseProvider, KodaXMessage } from '@kodax-ai/llm';
import {
  compact as intelligentCompact,
  emitKodaXDiagnostic,
  type CompactionConfig,
  type CompactionUpdate,
} from '@kodax-ai/agent';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from '../coding-compaction-prompts.js';
import type { KodaXContextTokenSnapshot, KodaXEvents } from '../../types.js';
import { estimateTokens } from '../../tokenizer.js';
import {
  createEstimatedContextTokenSnapshot,
} from '../../token-accounting.js';
import { validateAndFixToolHistory } from '@kodax-ai/agent';
import { gracefulCompactDegradation } from '@kodax-ai/agent';
import { applyPostCompactAttachments } from './post-compact-attachments.js';
import {
  consumeCompactionCooldown,
  createCompactionAntiThrashState,
  recordCompactionSavings,
  shouldSkipLlmCompaction,
  type CompactionAntiThrashConfig,
  type CompactionAntiThrashState,
} from './compaction-pressure.js';

export const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;

// ---------------------------------------------------------------------------
// CAP-060 — tryIntelligentCompact
// ---------------------------------------------------------------------------

export interface TryIntelligentCompactInput {
  readonly messages: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly compactConsecutiveFailures: number;
  readonly compactionConfig: CompactionConfig;
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
  readonly contextWindow: number;
  readonly systemPrompt: string;
  readonly currentTokens: number;
  readonly events: KodaXEvents;
  readonly compactionAntiThrash?: CompactionAntiThrashState;
  readonly compactionAntiThrashConfig?: CompactionAntiThrashConfig;
  readonly emitCompactionDiagnostics?: boolean;
  /** Defaults to {@link COMPACT_CIRCUIT_BREAKER_LIMIT}; tests may override. */
  readonly circuitBreakerLimit?: number;
}

export interface TryIntelligentCompactOutput {
  readonly compacted: KodaXMessage[];
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly didCompactMessages: boolean;
  readonly nextCompactConsecutiveFailures: number;
  readonly nextCompactionAntiThrash: CompactionAntiThrashState;
}

/**
 * CAP-060: LLM-based intelligent compaction with circuit breaker and
 * lifecycle event emission. When `needsCompact` is false OR the
 * circuit breaker is tripped, returns identity (`compacted = messages`,
 * counter unchanged) so the caller routes directly to the graceful
 * degradation gate.
 */
export async function tryIntelligentCompact(
  input: TryIntelligentCompactInput,
): Promise<TryIntelligentCompactOutput> {
  const limit = input.circuitBreakerLimit ?? COMPACT_CIRCUIT_BREAKER_LIMIT;
  const circuitBreakerTripped = input.compactConsecutiveFailures >= limit;
  const antiThrash = input.compactionAntiThrash ?? createCompactionAntiThrashState();

  if (!input.needsCompact || circuitBreakerTripped) {
    return {
      compacted: input.messages,
      compactionUpdate: undefined,
      didCompactMessages: false,
      nextCompactConsecutiveFailures: input.compactConsecutiveFailures,
      nextCompactionAntiThrash: antiThrash,
    };
  }

  if (shouldSkipLlmCompaction(antiThrash)) {
    const nextAntiThrash = consumeCompactionCooldown(antiThrash);
    if (input.emitCompactionDiagnostics) {
      input.events.onContextCompactionSkipped?.({
        reason: 'low_savings_cooldown',
        currentTokens: input.currentTokens,
        contextWindow: input.contextWindow,
        triggerPercent: input.compactionConfig.triggerPercent,
        cooldownTurnsRemaining: nextAntiThrash.cooldownTurnsRemaining,
        lowSavingsStreak: nextAntiThrash.lowSavingsStreak,
      });
    }
    return {
      compacted: input.messages,
      compactionUpdate: undefined,
      didCompactMessages: false,
      nextCompactConsecutiveFailures: input.compactConsecutiveFailures,
      nextCompactionAntiThrash: nextAntiThrash,
    };
  }

  let compacted: KodaXMessage[] = input.messages;
  let compactionUpdate: CompactionUpdate | undefined;
  let didCompactMessages = false;
  let nextFailures = input.compactConsecutiveFailures;
  let nextCompactionAntiThrash = antiThrash;

  input.events.onCompactStart?.();
  try {
    const result = await intelligentCompact(
      input.messages,
      input.compactionConfig,
      input.provider,
      input.contextWindow,
      undefined, // customInstructions
      input.systemPrompt,
      input.currentTokens,
      CODING_SUMMARY_PROMPT,
      CODING_UPDATE_SUMMARY_PROMPT,
      input.model,
    );

    if (result.compacted) {
      compacted = result.messages;

      // CAP-061: post-compact attachment construction + injection.
      // FEATURE_072: `postCompactAttachmentsForLineage` is also routed
      // via `compactionUpdate.postCompactAttachments` for REPL-side
      // native storage on the CompactionEntry.
      let postCompactAttachmentsForLineage: readonly KodaXMessage[] = [];
      if (result.artifactLedger && result.artifactLedger.length > 0) {
        const attached = await applyPostCompactAttachments({
          compacted,
          artifactLedger: result.artifactLedger,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        });
        compacted = attached.compacted;
        postCompactAttachmentsForLineage = attached.postCompactAttachmentsForLineage;
      }

      didCompactMessages = true;
      // Only reset the counter when compaction actually reduced
      // context below trigger. "Partial success" (pruning only with
      // silent summary failure) would otherwise keep the counter at
      // zero forever and prevent graceful degradation from ever running.
      const triggerTokens = input.contextWindow * (input.compactionConfig.triggerPercent / 100);
      const postCompactTokens = estimateTokens(compacted);
      const savings = recordCompactionSavings(
        antiThrash,
        {
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        },
        input.compactionAntiThrashConfig,
      );
      nextCompactionAntiThrash = savings.state;

      // Compaction observability reaches every output mode through the
      // lifecycle events emitted below (`onCompactStats` / `onCompact`): the
      // Ink TUI renders an inline "Context auto-compacted" notice, the plain
      // CLI prints a dim line, and `--json` emits a `compact.finish` record.
      // This raw diagnostic trace is debug-only, gated behind
      // `KODAX_DEBUG_COMPACTION`. Real compaction failures below are reported
      // unconditionally through diagnostics. Rationale: the REPL
      // renderer runs with `patchConsole: false`, so a bare `console.*` write
      // bypasses the render engine, lands below the live region, and desyncs
      // the cell frame — corrupting the interactive screen.
      if (process.env.KODAX_DEBUG_COMPACTION) {
        emitKodaXDiagnostic({
          source: 'coding:compaction',
          level: 'debug',
          message: 'Compaction triggered.',
          detail: {
            contextWindow: input.contextWindow,
            triggerPercent: input.compactionConfig.triggerPercent,
            triggerTokens: Math.floor(triggerTokens),
            tokensBefore: result.tokensBefore,
            tokensAfter: postCompactTokens,
            reduction: result.tokensBefore - postCompactTokens,
          },
        });
      }
      if (savings.enteredCooldown && process.env.KODAX_DEBUG_COMPACTION) {
        emitKodaXDiagnostic({
          source: 'coding:compaction',
          level: 'debug',
          message: 'Compaction low-savings cooldown entered.',
          detail: {
            savingsRatio: savings.savingsRatio,
            cooldownTurnsRemaining: savings.state.cooldownTurnsRemaining,
          },
        });
      }
      if (postCompactTokens < triggerTokens) {
        nextFailures = 0;
      } else {
        // Counter increment is load-bearing (drives the circuit breaker) and
        // stays unconditional; only the diagnostic line is debug-gated.
        nextFailures = input.compactConsecutiveFailures + 1;
        if (process.env.KODAX_DEBUG_COMPACTION) {
          emitKodaXDiagnostic({
            source: 'coding:compaction',
            level: 'debug',
            message: 'Compaction partial success remained above trigger.',
            detail: {
              postCompactTokens,
              triggerTokens: Math.floor(triggerTokens),
              attempt: nextFailures,
              limit,
            },
          });
        }
      }

      compactionUpdate = {
        anchor: result.anchor,
        artifactLedger: result.artifactLedger,
        memorySeed: result.memorySeed,
        postCompactAttachments:
          postCompactAttachmentsForLineage.length > 0
            ? postCompactAttachmentsForLineage
            : undefined,
      };
      input.events.onCompactStats?.({
        tokensBefore: result.tokensBefore,
        tokensAfter: postCompactTokens,
      });
      input.events.onCompact?.(result.tokensBefore);
    } else {
      compacted = result.messages;
    }
  } catch (error) {
    // Error is handled, not swallowed: the counter increment drives the
    // circuit breaker and we fall through to deterministic graceful
    // degradation below. Report the real failure through diagnostics; raw
    // console output remains forbidden because it can corrupt Ink rendering.
    nextFailures = input.compactConsecutiveFailures + 1;
    emitKodaXDiagnostic({
      source: 'coding:compaction',
      level: 'error',
      message: `Compaction LLM summary failed (attempt ${nextFailures}/${limit}).`,
      detail: error,
    });
    // Fall through to graceful degradation: return messages identity.
    compacted = input.messages;
  } finally {
    input.events.onCompactEnd?.();
  }

  return {
    compacted,
    compactionUpdate,
    didCompactMessages,
    nextCompactConsecutiveFailures: nextFailures,
    nextCompactionAntiThrash,
  };
}

// ---------------------------------------------------------------------------
// CAP-062 — applyGracefulDegradationGate
// ---------------------------------------------------------------------------

export interface GracefulDegradationGateInput {
  readonly compacted: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly contextWindow: number;
  readonly compactionConfig: CompactionConfig;
  readonly currentTokens: number;
  readonly events: KodaXEvents;
}

export interface GracefulDegradationGateOutput {
  readonly compacted: KodaXMessage[];
  readonly didCompactMessages: boolean;
}

/**
 * CAP-062: graceful degradation gate. Triggers when
 * `needsCompact` AND `estimateTokens(compacted) > triggerTokens × pruningGapRatio`
 * (default `pruningGapRatio = 0.8`). Catches three real-world cases:
 *   (a) LLM compact threw,
 *   (b) circuit breaker tripped,
 *   (c) LLM compact "partial success" left context still high.
 * Gating by remaining tokens rather than reference equality catches
 * case (c), which is the root cause of monotonic context growth
 * observed in 0.7.18+.
 */
export function applyGracefulDegradationGate(
  input: GracefulDegradationGateInput,
): GracefulDegradationGateOutput {
  if (!input.needsCompact) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  const triggerTokens = input.contextWindow * (input.compactionConfig.triggerPercent / 100);
  const gapRatio = input.compactionConfig.pruningGapRatio ?? 0.8;
  const stillOverTrigger = estimateTokens(input.compacted) > triggerTokens * gapRatio;
  if (!stillOverTrigger) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  const degraded = gracefulCompactDegradation(
    input.compacted,
    input.contextWindow,
    input.compactionConfig,
  );
  if (degraded === input.compacted) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  // Pruning happened — emit and surface didCompactMessages so commit
  // step (CAP-063) fires `onCompactedMessages`.
  input.events.onCompactStats?.({
    tokensBefore: input.currentTokens,
    tokensAfter: estimateTokens(degraded),
  });
  input.events.onCompact?.(estimateTokens(degraded));
  return { compacted: degraded, didCompactMessages: true };
}

// ---------------------------------------------------------------------------
// CAP-063 — commitCompactedHistory
// ---------------------------------------------------------------------------

export interface CommitCompactedHistoryInput {
  readonly compacted: KodaXMessage[];
  readonly didCompactMessages: boolean;
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly events: KodaXEvents;
}

export interface CommitCompactedHistoryOutput {
  readonly messages: KodaXMessage[];
  /**
   * New snapshot when compaction fired this turn; `undefined` when
   * nothing changed so the caller keeps its existing snapshot.
   */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot | undefined;
}

/**
 * CAP-063: pre-stream `validateAndFixToolHistory` + `onCompactedMessages`
 * emission. Always validates the post-compaction history (orphan
 * tool_uses removed via CAP-002), commits via the returned `messages`,
 * and emits `onCompactedMessages` only when compaction fired.
 */
export function commitCompactedHistory(
  input: CommitCompactedHistoryInput,
): CommitCompactedHistoryOutput {
  // Always validate before sending to API — prevents "tool_call_id
  // is not found" errors caused by corrupted history.
  const validated = validateAndFixToolHistory(input.compacted);
  if (!input.didCompactMessages) {
    return { messages: validated, contextTokenSnapshot: undefined };
  }
  const snapshot = createEstimatedContextTokenSnapshot(validated);
  input.events.onCompactedMessages?.(validated, input.compactionUpdate);
  return { messages: validated, contextTokenSnapshot: snapshot };
}

// ---------------------------------------------------------------------------
// Umbrella — runCompactionLifecycle
// ---------------------------------------------------------------------------

export interface CompactionLifecycleInput {
  readonly messages: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly compactConsecutiveFailures: number;
  readonly compactionConfig: CompactionConfig;
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
  readonly contextWindow: number;
  readonly systemPrompt: string;
  readonly currentTokens: number;
  readonly events: KodaXEvents;
  readonly compactionAntiThrash?: CompactionAntiThrashState;
  readonly compactionAntiThrashConfig?: CompactionAntiThrashConfig;
  readonly emitCompactionDiagnostics?: boolean;
  readonly circuitBreakerLimit?: number;
}

export interface CompactionLifecycleOutput {
  readonly messages: KodaXMessage[];
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly didCompactMessages: boolean;
  readonly nextCompactConsecutiveFailures: number;
  readonly nextCompactionAntiThrash: CompactionAntiThrashState;
  /**
   * Fresh snapshot when compaction fired; `undefined` otherwise so
   * the caller keeps its existing per-turn snapshot.
   */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot | undefined;
}

/**
 * Compose the three compaction phases into one call for the agent.ts
 * dispatch site. Phase ordering is load-bearing:
 *   1. `tryIntelligentCompact` — LLM compact (or skip on circuit
 *      breaker / `!needsCompact`)
 *   2. `applyGracefulDegradationGate` — deterministic prune fallback
 *      (handles all three "still too big" cases)
 *   3. `commitCompactedHistory` — validate + commit + event emission
 */
export async function runCompactionLifecycle(
  input: CompactionLifecycleInput,
): Promise<CompactionLifecycleOutput> {
  const llmPhase = await tryIntelligentCompact({
    messages: input.messages,
    needsCompact: input.needsCompact,
    compactConsecutiveFailures: input.compactConsecutiveFailures,
    compactionConfig: input.compactionConfig,
    provider: input.provider,
    model: input.model,
    contextWindow: input.contextWindow,
    systemPrompt: input.systemPrompt,
    currentTokens: input.currentTokens,
    events: input.events,
    compactionAntiThrash: input.compactionAntiThrash,
    compactionAntiThrashConfig: input.compactionAntiThrashConfig,
    emitCompactionDiagnostics: input.emitCompactionDiagnostics,
    circuitBreakerLimit: input.circuitBreakerLimit,
  });
  const degradationPhase = applyGracefulDegradationGate({
    compacted: llmPhase.compacted,
    needsCompact: input.needsCompact,
    contextWindow: input.contextWindow,
    compactionConfig: input.compactionConfig,
    currentTokens: input.currentTokens,
    events: input.events,
  });
  const didCompactMessages =
    llmPhase.didCompactMessages || degradationPhase.didCompactMessages;
  const commitPhase = commitCompactedHistory({
    compacted: degradationPhase.compacted,
    didCompactMessages,
    compactionUpdate: llmPhase.compactionUpdate,
    events: input.events,
  });
  return {
    messages: commitPhase.messages,
    compactionUpdate: llmPhase.compactionUpdate,
    didCompactMessages,
    nextCompactConsecutiveFailures: llmPhase.nextCompactConsecutiveFailures,
    nextCompactionAntiThrash: llmPhase.nextCompactionAntiThrash,
    contextTokenSnapshot: commitPhase.contextTokenSnapshot,
  };
}
