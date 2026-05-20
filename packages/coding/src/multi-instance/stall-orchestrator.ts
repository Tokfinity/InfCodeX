/**
 * FEATURE_178 (v0.7.42) — runtime orchestrator wiring L1 detector → L2
 * sidecar → nudge injection.
 *
 * Building block consumed by `runner-driven.ts` (commit 4/4). Separated
 * from the runner so its lifecycle / state shape is unit-testable in
 * isolation.
 *
 * **Flow** (one tool call):
 *   1. `recordToolUse(call)` records the assistant tool_use into the
 *      detector (L1). On a stall signal, snapshots the recent transcript
 *      buffer and fires the sidecar invocation as a non-awaited Promise.
 *   2. The Promise resolves with a `SidecarVerdict`. If `isStuck=true`,
 *      the nudge text is stored in `pendingNudgeRef`.
 *   3. `consumePendingNudge()` is called by the next tool call's
 *      `beforeTool` gate. If a nudge is queued, it's returned as the
 *      block string — synthesizing the nudge as the tool_result text
 *      the model sees. The redundant tool dispatch is suppressed for
 *      that one round; the model rethinks based on the nudge.
 *   4. `recordToolResult(call, content)` records the tool_result into
 *      the transcript buffer so the next sidecar invocation has up-to-
 *      date evidence.
 *   5. `reset()` clears all state — called on compaction post-hook
 *      alongside detector reset.
 *
 * **One-cycle latency**: we let the FIRST repeated call run because
 * `recordToolUse` returns sync (no awaiting in `onToolCall`). The
 * sidecar verdict arrives later, in time for the NEXT tool call's
 * `beforeTool` gate to consume. This bounds the wall-clock cost to one
 * extra round — acceptable since the F177 cache already serves cheap
 * stubs for the repeat.
 *
 * **Why not block in beforeTool**: blocking the first redundant tool
 * with an awaited sidecar call would add up to 5s to that call's
 * latency. With async fire-and-forget the cost is amortised — the
 * sidecar runs in parallel with the tool, and only the NEXT call sees
 * the verdict-driven block.
 */

import type {
  KodaXMessage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { KodaXBaseProvider } from '@kodax-ai/llm';

import {
  invokeStallSidecar,
  type SidecarVerdict,
} from './stall-sidecar.js';
import { buildSidecarUserMessage } from './stall-sidecar-prompts.js';
import type { StallDetector, StallSignal } from './stall-detector.js';

/**
 * How many recent tool turns the orchestrator keeps for the sidecar
 * transcript. 8 turns = 16 messages (tool_use + tool_result pair per
 * turn). The F178 eval cases used 4-12 turns of history — 8 sits
 * comfortably in that range without bloating the sidecar prompt.
 */
export const TRANSCRIPT_WINDOW = 16;

export interface StallOrchestratorOptions {
  readonly detector: StallDetector;
  readonly provider: KodaXBaseProvider;
  readonly systemPrompt: string;
  readonly reportTool: KodaXToolDefinition;
  /** Sidecar timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /**
   * Optional verdict callback for observability — fires every time a
   * sidecar verdict resolves (whether isStuck true or false). Used by
   * integration tests; production wiring can leave this unset.
   */
  readonly onVerdict?: (signal: StallSignal, verdict: SidecarVerdict) => void;
}

export interface StallOrchestrator {
  /**
   * Record a tool_use into the detector + transcript buffer. If the
   * detector fires a stall signal, kicks off the sidecar invocation
   * (non-awaited). Returns true when a stall signal was emitted (the
   * caller does not need to act on it — the orchestrator handles
   * verdict storage internally).
   */
  recordToolUse(call: { name: string; id: string; input: Record<string, unknown> }): boolean;

  /**
   * Record the tool_result string for a tool_use already passed to
   * `recordToolUse`. Used to enrich the transcript buffer the sidecar
   * sees.
   */
  recordToolResult(call: { id: string }, content: string): void;

  /**
   * Consume any pending nudge string. Returns the nudge once, then
   * clears it — so the next tool call sees `undefined` unless a fresh
   * stall verdict arrived. Called by `beforeTool` gate.
   */
  consumePendingNudge(): string | undefined;

  /**
   * Drop all state. Called on compaction post-hook alongside
   * detector.reset() and readFileStateCache.clear().
   */
  reset(): void;

  /** Diagnostic / test accessor. */
  readonly debug: {
    readonly transcriptSize: () => number;
    readonly hasPendingNudge: () => boolean;
    readonly pendingSidecarPromises: () => readonly Promise<unknown>[];
  };
}

export function createStallOrchestrator(
  options: StallOrchestratorOptions,
): StallOrchestrator {
  const transcript: KodaXMessage[] = [];
  let pendingNudge: string | undefined;
  const pendingPromises: Promise<unknown>[] = [];

  function pushTranscript(message: KodaXMessage): void {
    transcript.push(message);
    if (transcript.length > TRANSCRIPT_WINDOW) {
      transcript.splice(0, transcript.length - TRANSCRIPT_WINDOW);
    }
  }

  function snapshotTranscript(): readonly KodaXMessage[] {
    return transcript.map((m) => ({ ...m }));
  }

  return {
    recordToolUse(call) {
      const useBlock: KodaXToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      };
      pushTranscript({ role: 'assistant', content: [useBlock] });

      const signal = options.detector.recordToolUse(call.name, call.input);
      if (signal.kind !== 'stall') return false;

      const snapshot = snapshotTranscript();
      const userMessage = buildSidecarUserMessage({
        signalEnvelope: signal.envelope,
        recentMessages: snapshot,
      });

      const promise = invokeStallSidecar({
        provider: options.provider,
        userMessage,
        systemPrompt: options.systemPrompt,
        reportTool: options.reportTool,
        timeoutMs: options.timeoutMs,
      })
        .then((verdict) => {
          options.onVerdict?.(signal, verdict);
          if (verdict.isStuck && verdict.nudge) {
            pendingNudge = verdict.nudge;
          }
        })
        .catch(() => {
          // invokeStallSidecar already swallows all errors and returns
          // safe-default verdicts. Defensive belt-and-suspenders catch
          // here in case the contract ever changes.
        });
      pendingPromises.push(promise);
      return true;
    },

    recordToolResult(call, content) {
      pushTranscript({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            content,
          },
        ],
      });
    },

    consumePendingNudge() {
      const nudge = pendingNudge;
      pendingNudge = undefined;
      return nudge;
    },

    reset() {
      transcript.length = 0;
      pendingNudge = undefined;
      // Don't clear pendingPromises — let them resolve naturally; their
      // resolution handlers no-op once `pendingNudge` is the new (empty)
      // ref. New stalls produced after reset will re-arm correctly.
    },

    debug: {
      transcriptSize: () => transcript.length,
      hasPendingNudge: () => pendingNudge !== undefined,
      pendingSidecarPromises: () => [...pendingPromises],
    },
  };
}
