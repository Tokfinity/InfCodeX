/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier invoker + Stop hook factory.
 *
 * Phase D.1 of ADR-030 (claudecode-shape Main Agent + Sidecar Verifier).
 *
 * When the Main Agent terminates a turn text-only (no tool_use), the
 * agent-layer `RunOptions.stopHook` fires. This module:
 *
 *   1. Runs a second-pass LLM verification call (independent context,
 *      configurable model — usually a strong family) with a forced
 *      `emit_sidecar_verdict` tool call
 *   2. Maps the 3-state verdict ('accept' / 'revise' / 'blocked') to
 *      the agent-layer `StopHookResult` 3-state surface
 *      (undefined / string / {abort, reason})
 *   3. Honors a fail-open policy: timeout, provider error, missing tool
 *      call, or parse failure → default `'accept'` (do not block the
 *      happy path)
 *
 * **FEATURE_215 (v0.7.49)**: the domain-neutral invocation skeleton
 * (stream → fuzzy-match → parse → timeout-race → fail-open) now lives in
 * `@kodax-ai/agent` as `invokeLlmJudge` / `createLlmJudgedStopHook`. This
 * module is a thin consumer: it injects the verifier-specific prompt,
 * report tool, verdict parser, default-verdict mapping, and verdict
 * landing. Per ADR-030 the concrete judging (prompt, file-edit evidence,
 * recorder bridge) stays here in coding.
 *
 * **Model selection**: by default the verifier **inherits the Main
 * Agent's provider+model** (see `verifier-provider-resolver.ts`). Users
 * who want cross-family verification can opt in via
 * `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL` env vars.
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D
 * - v0.7.49.md §FEATURE_215 — kernel extraction
 *
 * DI-clean: provider injection is the only external surface. Tests
 * pass a fake provider returning canned `{textBlocks, toolBlocks}`.
 */

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { StopHookFn, StopHookResult, LlmJudgeFailureReason } from '@kodax-ai/agent';
import { invokeLlmJudge, createLlmJudgedStopHook } from '@kodax-ai/agent';

import {
  VERIFIER_SYSTEM_PROMPT,
  VERIFIER_REPORT_TOOL,
  buildVerifierUserMessage,
} from './verifier-prompts.js';

/** Accepted verdict values. Pinned by `VERIFIER_REPORT_TOOL.input_schema`. */
export type SidecarVerifierVerdictValue = 'accept' | 'revise' | 'blocked';

/**
 * Diagnostic trace tag — explains why the verdict took its final shape.
 * Not forwarded to the Main Agent; surfaces in spans + tests.
 */
export type SidecarVerifierTrace =
  | 'verifier_ok'
  | 'fuzzy_tool_match'
  | 'no_tool_call'
  | 'invalid_verdict_value'
  | 'missing_reason'
  | 'provider_error'
  | 'timeout';

/**
 * Verifier's structured output. `verdict='accept'` is the safe-default:
 * any parse failure, timeout, provider error, or schema violation lands
 * here so the Main Agent's happy path is never blocked by a buggy
 * verifier.
 */
export interface SidecarVerifierVerdict {
  readonly verdict: SidecarVerifierVerdictValue;
  /**
   * For 'revise': becomes the synthetic user-message follow-up the Main
   * Agent sees. For 'blocked': shown to the user verbatim. For 'accept':
   * may be empty or carry a one-line note (currently unused by Stop hook
   * mapping).
   */
  readonly reason: string;
  /** Optional one-line how-to-fix hint. */
  readonly suggestedFix?: string;
  /** Diagnostic only — not forwarded to Main Agent. */
  readonly trace: SidecarVerifierTrace;
}

export interface SidecarVerifierContextInputs {
  /** All user-role messages emitted during the CURRENT turn — kept in full. */
  readonly currentTurnUserQueries: readonly string[];
  /** Rolling window of recent transcript messages (recommend last 24). */
  readonly recentTranscript: readonly KodaXMessage[];
  /**
   * Summary of file edits performed THIS turn — paths + truncated diff
   * hints. Critical: verifier must see WHAT the agent changed, not just
   * what the agent CLAIMED it changed. Without this, prompt drift
   * ("done!" with no actual edits) is invisible.
   */
  readonly fileEditSummary: readonly { readonly path: string; readonly diffHint: string }[];
  /** The exact text the Main Agent emitted as its final answer. */
  readonly lastAssistantText: string;
}

export interface SidecarVerifierInvokeOptions {
  /** Provider used for the verifier call. Often a stronger model than
   *  the Main Agent's. Injection target = test fakes + production
   *  resolution from `verifier-provider-resolver.ts`. */
  readonly provider: KodaXBaseProvider;
  /** Specific model id on the provider. When omitted, the provider's
   *  registered default model is used. Production wiring passes the
   *  resolved model string from `resolveVerifierProvider()`. */
  readonly model?: string;
  /** Verifier context built by the caller (`buildVerifierContext`). */
  readonly inputs: SidecarVerifierContextInputs;
  /** Timeout in ms. Default 15000 (verification is heavier than F178
   *  anomaly detection's 5s budget). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REPORT_TOOL_NAME = 'emit_sidecar_verdict';
const VALID_VERDICTS: readonly SidecarVerifierVerdictValue[] = ['accept', 'revise', 'blocked'];

function getToolInput(block: KodaXToolUseBlock): Record<string, unknown> {
  if (!block.input || typeof block.input !== 'object') return {};
  return block.input as Record<string, unknown>;
}

/**
 * Parse an `emit_sidecar_verdict` tool call into a typed verdict.
 * Returns the safe-default `accept` on any malformed input, with a
 * diagnostic trace tag. Never returns undefined — a malformed call is a
 * valid (accept) verdict, not a kernel parse failure.
 */
function parseVerifierToolCall(
  block: KodaXToolUseBlock,
  exact: boolean,
): SidecarVerifierVerdict {
  const input = getToolInput(block);
  const rawVerdict = typeof input.verdict === 'string' ? input.verdict.trim().toLowerCase() : '';
  if (!VALID_VERDICTS.includes(rawVerdict as SidecarVerifierVerdictValue)) {
    return {
      verdict: 'accept',
      reason: '',
      trace: 'invalid_verdict_value',
    };
  }
  const verdict = rawVerdict as SidecarVerifierVerdictValue;

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  // revise / blocked without a reason is useless — degrade to accept.
  if ((verdict === 'revise' || verdict === 'blocked') && !reason) {
    return {
      verdict: 'accept',
      reason: '',
      trace: 'missing_reason',
    };
  }

  const suggestedFix = typeof input.suggestedFix === 'string' && input.suggestedFix.trim()
    ? input.suggestedFix.trim()
    : undefined;

  return {
    verdict,
    reason,
    suggestedFix,
    trace: exact ? 'verifier_ok' : 'fuzzy_tool_match',
  };
}

/**
 * Safe-default verdict factory for the kernel's fail-open paths. Maps
 * each `LlmJudgeFailureReason` to an `accept` verdict carrying the
 * verifier's diagnostic trace tag. (`parse_failure` cannot occur for the
 * verifier — `parseVerifierToolCall` always returns a verdict — but is
 * mapped to `no_tool_call` defensively.)
 */
function verifierDefaultVerdict(reason: LlmJudgeFailureReason): SidecarVerifierVerdict {
  const trace: SidecarVerifierTrace =
    reason === 'provider_error' ? 'provider_error'
    : reason === 'timeout' ? 'timeout'
    : 'no_tool_call';
  return { verdict: 'accept', reason: '', trace };
}

/**
 * Invoke the Sidecar Verifier against the supplied provider. Returns a
 * SidecarVerifierVerdict — always; never throws (internal errors map to
 * safe-default `accept` with diagnostic trace).
 *
 * Thin consumer of `@kodax-ai/agent`'s `invokeLlmJudge` (FEATURE_215):
 * builds the verifier user message, then injects the verifier prompt /
 * report tool / parser / default-verdict mapping.
 */
export async function invokeSidecarVerifier(
  options: SidecarVerifierInvokeOptions,
): Promise<SidecarVerifierVerdict> {
  const userMessage = buildVerifierUserMessage(options.inputs);
  return invokeLlmJudge<SidecarVerifierVerdict>({
    provider: options.provider,
    model: options.model,
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    reportTool: VERIFIER_REPORT_TOOL,
    userMessage,
    reportToolName: REPORT_TOOL_NAME,
    parseToolCall: parseVerifierToolCall,
    defaultVerdict: verifierDefaultVerdict,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Map a `SidecarVerifierVerdict` to the agent-layer `StopHookResult`
 * three-state surface:
 *   - 'accept'  → undefined        (defer to terminal path)
 *   - 'revise'  → string (reason)  (reanimate via synthetic user msg)
 *   - 'blocked' → {abort, reason}  (halt + surface to caller)
 *
 * Pure function — no I/O. Exported for tests and for D.2 wiring.
 */
export function mapVerifierVerdictToStopHookResult(
  verdict: SidecarVerifierVerdict,
): StopHookResult {
  switch (verdict.verdict) {
    case 'accept':
      return undefined;
    case 'revise':
      return verdict.reason;
    case 'blocked':
      return { abort: true, reason: verdict.reason };
  }
}

export interface CreateSidecarVerifierStopHookOptions {
  /** Provider used for the verifier call. Production resolves this from
   *  `verifier-provider-resolver.ts`; tests pass a fake. */
  readonly provider: KodaXBaseProvider;
  /** Specific model id on the provider. When omitted, the provider's
   *  registered default model is used. */
  readonly model?: string;
  /** Builds the context inputs from the StopHookContext + the caller's
   *  per-run state (file edit ledger, current-turn user queries, etc.). */
  readonly buildContext: (ctx: {
    readonly transcript: readonly KodaXMessage[];
    readonly lastAssistantText: string;
  }) => SidecarVerifierContextInputs;
  /** Timeout override; default 15000ms. */
  readonly timeoutMs?: number;
  /** Observability sink — called once per Stop hook invocation with the
   *  raw verdict so callers can emit spans / log / metrics. Optional. */
  readonly onVerdict?: (verdict: SidecarVerifierVerdict) => void;
}

/**
 * Factory: returns a StopHookFn that invokes the Sidecar Verifier and
 * maps its verdict to the agent-layer 3-state result.
 *
 * Thin consumer of `@kodax-ai/agent`'s `createLlmJudgedStopHook`
 * (FEATURE_215): builds the verifier context via the caller-supplied
 * `buildContext`, renders it to the verifier user message, and injects
 * the verifier prompt / parser / mapping / onVerdict. Composition with
 * the extension `turn:complete` bridge is the caller's responsibility at
 * the RunOptions construction site.
 */
export function createSidecarVerifierStopHook(
  options: CreateSidecarVerifierStopHookOptions,
): StopHookFn {
  return createLlmJudgedStopHook<SidecarVerifierVerdict>({
    provider: options.provider,
    model: options.model,
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    reportTool: VERIFIER_REPORT_TOOL,
    reportToolName: REPORT_TOOL_NAME,
    // Convert AgentMessage (agent-layer transcript) to KodaXMessage shape
    // for verifier context. The two types are structurally compatible at
    // the role + content level.
    buildUserMessage: (ctx) => buildVerifierUserMessage(options.buildContext({
      transcript: ctx.transcript as readonly KodaXMessage[],
      lastAssistantText: ctx.lastAssistantText,
    })),
    parseToolCall: parseVerifierToolCall,
    defaultVerdict: verifierDefaultVerdict,
    mapVerdict: mapVerifierVerdictToStopHookResult,
    onVerdict: options.onVerdict,
    timeoutMs: options.timeoutMs,
  });
}
