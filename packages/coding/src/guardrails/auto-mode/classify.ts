/**
 * Auto-Mode Classifier Orchestrator — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Wires the classifier prompt + sideQuery + output parser into a single
 * `classify(...)` call. Caller supplies the rules, transcript, and the
 * tool-call action being classified; gets back a `ClassifyDecision`.
 *
 * Failure → decision mapping:
 *
 *   sideQuery.stopReason   parsedOutput   → ClassifyDecision
 *   ───────────────────────────────────────────────────────
 *   end_turn / max_tokens  block          → block (with reason)
 *   end_turn / max_tokens  allow          → allow
 *   end_turn / max_tokens  unparseable    → block (fail-closed)
 *   end_turn / max_tokens  + tool_use     → block (contract violation)
 *                          (sideQuery returns stopReason='error' here)
 *   timeout                —              → escalate (user confirms)
 *   aborted                —              → escalate (treated as caller-abort)
 *   error                  —              → escalate (5xx / 429 / network)
 *
 * Why fail-closed on unparseable but escalate on timeout/error:
 *   Unparseable = model spoke but didn't follow the contract → likely
 *     trying to bypass; treating as block is conservative and safe.
 *   Timeout/error = transient; blocking would punish the user for our
 *     infra hiccup. Escalating to a confirm dialog preserves user
 *     agency without putting safety on the line.
 */

import type { CostTracker, SideQueryDiagnostics } from '@kodax-ai/llm';
import { KodaXBaseProvider, sideQuery } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';

import { buildClassifierPrompt } from './classifier-prompt.js';
import { parseClassifierOutput } from './parse-output.js';
import type { AutoRules } from './rules.js';
import type { ToolCallSignal } from './signals.js';
import { stripAssistantText } from './transcript-strip.js';
import {
  redactClassifierProjection,
  type ClassifierToolProjectionResolver,
} from '../../tools/classifier-projection.js';

export interface ClassifyOptions {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly rules: AutoRules;
  readonly claudeMd?: string;
  readonly transcript: readonly KodaXMessage[];
  readonly action: string;
  /** Resolve canonical per-tool projections for safe historical context. */
  readonly getToolProjection?: ClassifierToolProjectionResolver;
  /**
   * FEATURE_158 (v0.7.39): static-analysis signals forwarded to the
   * classifier prompt. Empty / undefined preserves the FEATURE_092 prompt
   * shape (no `<signals>` block emitted). When supplied, the classifier
   * sees signals between `<transcript>` and `<action>` as informational
   * input — not verdicts.
   */
  readonly signals?: readonly ToolCallSignal[];
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly costTracker?: CostTracker;
  /**
   * Optional setter — invoked once after `sideQuery` returns when the
   * classifier successfully recorded its token usage. The CostTracker is
   * immutable, so `sideQuery` produces a fresh tracker copy with the new
   * record; without this setter the recorded call is silently dropped.
   * Wired by the AutoModeToolGuardrail so the agent's tracker accumulates
   * classifier calls under role='auto_mode'.
   */
  readonly setCostTracker?: (next: CostTracker) => void;
}

interface ClassifyDecisionDetails {
  readonly reason: string;
  /** Structured request metadata only; never includes prompt or response text. */
  readonly diagnostics?: SideQueryDiagnostics;
}

export type ClassifyDecision =
  | ({ readonly kind: 'allow' } & ClassifyDecisionDetails)
  | ({ readonly kind: 'block' } & ClassifyDecisionDetails)
  | ({ readonly kind: 'escalate' } & ClassifyDecisionDetails);

/**
 * The deadline includes connection setup, provider-side queueing, inference,
 * and any Retry-After/backoff handled by the provider adapter. Keep it bounded
 * so infrastructure failure degrades to an explicit user decision.
 */
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 20_000;
/** The classifier returns two short XML tags; a coding-turn-sized budget is wasteful. */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 256;
/** Very large shell/script projections cannot be safely truncated and auto-approved. */
export const MAX_CLASSIFIER_ACTION_BYTES = 16 * 1024;
/** Defense in depth for rules, signals, and all serialized prompt sections. */
export const MAX_CLASSIFIER_PROMPT_BYTES = 32 * 1024;
const QUERY_SOURCE = 'auto_mode';

export async function classify(opts: ClassifyOptions): Promise<ClassifyDecision> {
  if (utf8Bytes(opts.action) > MAX_CLASSIFIER_ACTION_BYTES) {
    return {
      kind: 'escalate',
      reason: `classifier input budget exceeded (action is larger than ${MAX_CLASSIFIER_ACTION_BYTES} bytes)`,
    };
  }
  const action = redactClassifierProjection(opts.action);

  const prompt = buildClassifierPrompt({
    rules: opts.rules,
    claudeMd: opts.claudeMd,
    // Enforce the boundary at the classifier API itself so future callers
    // cannot accidentally bypass the session-history cap.
    transcript: stripAssistantText(opts.transcript, {
      getToolProjection: opts.getToolProjection,
    }),
    action,
    signals: opts.signals,
  });
  if (classifierPromptBytes(prompt.system, prompt.messages) > MAX_CLASSIFIER_PROMPT_BYTES) {
    return {
      kind: 'escalate',
      reason: `classifier input budget exceeded (prompt is larger than ${MAX_CLASSIFIER_PROMPT_BYTES} bytes)`,
    };
  }

  const result = await sideQuery({
    provider: opts.provider,
    model: opts.model,
    system: prompt.system,
    messages: prompt.messages,
    maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
    querySource: QUERY_SOURCE,
    costTracker: opts.costTracker,
  });

  if (opts.setCostTracker && result.costTracker !== undefined && result.costTracker !== opts.costTracker) {
    opts.setCostTracker(result.costTracker);
  }

  switch (result.stopReason) {
    case 'end_turn':
    case 'max_tokens': {
      const decision = parseClassifierOutput(result.text);
      if (decision.kind === 'unparseable') {
        return {
          kind: 'block',
          reason: 'classifier output was unparseable (fail-closed)',
          diagnostics: result.diagnostics,
        };
      }
      return { ...decision, diagnostics: result.diagnostics };
    }

    case 'timeout':
      return {
        kind: 'escalate',
        reason: `classifier timeout (${formatSideQueryDiagnostics(
          result.diagnostics,
          opts.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
        )})`,
        diagnostics: result.diagnostics,
      };

    case 'aborted':
      // Caller-abort means the user cancelled the entire tool-call evaluation
      // (Ctrl-C upstream). Returning escalate would show a confirm dialog to a
      // user who has already requested cancellation. Re-throw an AbortError so
      // the caller's abort chain propagates cleanly.
      throw new DOMException('classify aborted', 'AbortError');

    case 'error':
    default: {
      const errMsg = result.error?.message ?? 'unknown error';
      // Tool-use contract violation comes through as 'error' with a recognizable
      // message; map to block instead of escalate (the model is misbehaving,
      // not the network).
      if (/tool_use/i.test(errMsg)) {
        return {
          kind: 'block',
          reason: `classifier returned tool_use block (contract violation)`,
          diagnostics: result.diagnostics,
        };
      }
      return {
        kind: 'escalate',
        reason: `classifier error: ${errMsg}`,
        diagnostics: result.diagnostics,
      };
    }
  }
}

function formatSideQueryDiagnostics(
  value: SideQueryDiagnostics | undefined,
  fallbackTimeoutMs: number,
): string {
  if (!value) return `${fallbackTimeoutMs}ms exceeded`;
  return [
    `provider=${value.provider}`,
    `model=${value.model}`,
    `timeoutMs=${value.timeoutMs}`,
    `elapsedMs=${value.elapsedMs}`,
    `retries=${value.retryCount}`,
    `retryWaitMs=${value.retryWaitMs}`,
    `phase=${value.terminalPhase}`,
  ].join(', ');
}

function classifierPromptBytes(system: string, messages: readonly KodaXMessage[]): number {
  return utf8Bytes(system) + utf8Bytes(JSON.stringify(messages));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
