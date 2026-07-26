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
import type { TodoStatus } from '../../../types.js';
import {
  COLLABORATION_PATTERN_CATALOG,
  type CollaborationPatternId,
} from '../../../orchestration/pattern-catalog.js';
import type { PatternTrace } from '../../../orchestration/pattern-trace.js';

import {
  VERIFIER_SYSTEM_PROMPT,
  VERIFIER_REPORT_TOOL,
  buildVerifierUserMessage,
} from './verifier-prompts.js';

/** Accepted verdict values. Pinned by `VERIFIER_REPORT_TOOL.input_schema`. */
export type SidecarVerifierVerdictValue = 'accept' | 'revise' | 'blocked';
export type SidecarStrategyReasonCode =
  | 'missing_requirement'
  | 'contradicted_evidence'
  | 'unsupported_claim'
  | 'unresolved_high_risk'
  | 'verification_degraded';

export interface SidecarQualitySignals {
  readonly riskLevel?: string;
  readonly needsIndependentQA?: boolean;
  readonly assuranceIntent?: string;
  readonly reviewScale?: string;
  readonly requiresBrainstorm?: boolean;
}

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
  /** Optional focused advice; Root remains free to choose another response. */
  readonly reasonCode?: SidecarStrategyReasonCode;
  readonly recommendedPattern?: CollaborationPatternId;
  readonly targetEvidenceRefs?: readonly string[];
  /** Diagnostic only — not forwarded to Main Agent. */
  readonly trace: SidecarVerifierTrace;
}

export interface SidecarVerifierContextInputs {
  /** Real (non-synthetic) user intent for the CURRENT turn — kept in full. */
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
  readonly omittedFileEditCount?: number;
  /** Structured completion evidence already delivered to the root transcript. */
  readonly taskEvidence?: readonly SidecarTaskEvidence[];
  readonly omittedTaskEvidenceCount?: number;
  /** Compact Todo state; descriptions and opaque metadata are intentionally excluded. */
  readonly planEvidence?: readonly SidecarPlanEvidence[];
  readonly omittedPlanEvidenceCount?: number;
  /** Tool names plus success/error only — raw tool output never crosses this boundary. */
  readonly toolOutcomeEvidence?: readonly SidecarToolOutcomeEvidence[];
  readonly omittedToolOutcomeEvidenceCount?: number;
  /** The exact text the Main Agent emitted as its final answer. */
  readonly lastAssistantText: string;
  /**
   * FEATURE_247 (R3) — rendered profile/task verification criteria appended to
   * the verifier user message. Present only when a profile-default or per-task
   * verification standard was supplied, so an absent contract adds no profile-
   * specific section.
   */
  readonly additionalCriteria?: string;
  /** Existing routing facts, supplied only after the ordinary Sidecar gate fires. */
  readonly qualitySignals?: SidecarQualitySignals;
  /** Runtime-derived collaboration facts. Never a quality receipt. */
  readonly patternTrace?: PatternTrace;
}

export interface SidecarTaskEvidence {
  readonly source: 'workflow' | 'child_task';
  readonly taskId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly title?: string;
  readonly summary?: string;
  readonly artifactRefs: readonly string[];
  readonly omittedArtifactRefCount: number;
}

export interface SidecarPlanEvidence {
  readonly id: string;
  readonly subject: string;
  readonly status: TodoStatus;
  readonly owner?: string;
  readonly note?: string;
}

export interface SidecarToolOutcomeEvidence {
  readonly toolName: string;
  readonly outcome: 'ok' | 'error';
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
  /** Caller cancellation signal; forwarded to the verifier provider call. */
  readonly abortSignal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REPORT_TOOL_NAME = 'emit_sidecar_verdict';
const VALID_VERDICTS: readonly SidecarVerifierVerdictValue[] = ['accept', 'revise', 'blocked'];
const VALID_REASON_CODES: readonly SidecarStrategyReasonCode[] = [
  'missing_requirement',
  'contradicted_evidence',
  'unsupported_claim',
  'unresolved_high_risk',
  'verification_degraded',
];
const VALID_PATTERN_IDS = new Set<CollaborationPatternId>(
  COLLABORATION_PATTERN_CATALOG.map((definition) => definition.id),
);

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
  const recommendation = verdict === 'accept'
    ? {}
    : parseStrategyRecommendation(input);

  return {
    verdict,
    reason,
    suggestedFix,
    ...recommendation,
    trace: exact ? 'verifier_ok' : 'fuzzy_tool_match',
  };
}

function parseStrategyRecommendation(
  input: Readonly<Record<string, unknown>>,
): Pick<
  SidecarVerifierVerdict,
  'reasonCode' | 'recommendedPattern' | 'targetEvidenceRefs'
> {
  const reasonCode = typeof input.reasonCode === 'string'
    && VALID_REASON_CODES.includes(input.reasonCode as SidecarStrategyReasonCode)
    ? input.reasonCode as SidecarStrategyReasonCode
    : undefined;
  const recommendedPattern = typeof input.recommendedPattern === 'string'
    && VALID_PATTERN_IDS.has(input.recommendedPattern as CollaborationPatternId)
    ? input.recommendedPattern as CollaborationPatternId
    : undefined;
  const refs = Array.isArray(input.targetEvidenceRefs)
    && input.targetEvidenceRefs.length <= 20
    && input.targetEvidenceRefs.every(
      (ref) => typeof ref === 'string' && ref.trim().length > 0 && ref.length <= 512,
    )
    ? input.targetEvidenceRefs.map((ref) => (ref as string).trim())
    : undefined;
  return {
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(recommendedPattern === undefined ? {} : { recommendedPattern }),
    ...(refs === undefined ? {} : { targetEvidenceRefs: refs }),
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
    abortSignal: options.abortSignal,
  });
}

/**
 * Retry guidance appended to a revise verdict's reanimate message. Moved here
 * from the Worker system prompt (FEATURE_116 follow-up): keeping it in the
 * system prompt busted the Anthropic system cache block on every reanimate.
 * Riding the synthetic user message instead keeps the system prompt byte-stable
 * across revise cycles while the Worker still sees the same retry instruction.
 */
export const REVISE_RETROSPECTIVE =
  'A previous attempt at this task failed Sidecar Verifier review. Treat the prior `todo_update` items marked `failed` as ground truth — the same approach will not pass twice. Read the failure note before retrying. If the retry requires a fundamentally different step (not a fix of the failed one), use `todo_create` to add the new step rather than overloading the failed item with a different objective.';

/**
 * Map a `SidecarVerifierVerdict` to the agent-layer `StopHookResult`
 * three-state surface:
 *   - 'accept'  → undefined                        (defer to terminal path)
 *   - 'revise'  → {reanimate, source}              (reanimate via synthetic
 *                 user msg, attributed to the sidecar so the REPL/SDK render
 *                 it distinctly; carries the reason + retry retrospective)
 *   - 'blocked' → {abort, reason}                  (halt + surface to caller)
 *
 * Pure function — no I/O. Exported for tests and for D.2 wiring.
 */
function renderStrategyRecommendation(verdict: SidecarVerifierVerdict): string {
  const parts: string[] = [];
  if (verdict.reasonCode) parts.push(`reason=${verdict.reasonCode}`);
  if (verdict.recommendedPattern) parts.push(`pattern=${verdict.recommendedPattern}`);
  if (verdict.targetEvidenceRefs && verdict.targetEvidenceRefs.length > 0) {
    parts.push(`targets=${verdict.targetEvidenceRefs.join(',')}`);
  }
  return parts.length === 0
    ? ''
    : `\n\nAdvisory strategy recommendation (Root chooses the response): ${parts.join(' ')}`;
}

export function mapVerifierVerdictToStopHookResult(
  verdict: SidecarVerifierVerdict,
): StopHookResult {
  switch (verdict.verdict) {
    case 'accept':
      return undefined;
    case 'revise':
      return {
        reanimate: `${verdict.reason}${renderStrategyRecommendation(verdict)}\n\n${REVISE_RETROSPECTIVE}`,
        source: 'sidecar-verifier',
      };
    case 'blocked':
      return {
        abort: true,
        reason: `${verdict.reason}${renderStrategyRecommendation(verdict)}`,
      };
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
