/**
 * FEATURE_178 (v0.7.42) — L2 sidecar invoker (anti-loop, LLM-judged).
 *
 * Companion to the L1 rule-based stall detector
 * (`./stall-detector.ts`). When L1 fires, this module asks the main
 * agent's provider to do a second-pass judgment using a tightly-scoped
 * SYSTEM_PROMPT + a forced tool call to `report_stall_judgment`. The
 * sidecar's job is *precision on legitimate repeats* — purely-rule
 * detectors would nudge legitimate iterative workflows out of their
 * normal pattern.
 *
 * **Validated by FEATURE_178 eval** (`1909d5d2`):
 *   - 149/150 PASS on the canonical 5-alias panel
 *   - 0% audit disagreement (Claude self-judge)
 *   - Decision matrix: SHIP-SIDECAR-ALL
 *
 * **Design choices** (carried over from eval):
 *   - **Same provider as the main agent**. No separate config —
 *     whichever LLM the user has selected for KodaX serves as its own
 *     sidecar. Validated per-alias; the eval confirmed all 5 canonical
 *     alias clear the SHIP gate.
 *   - **Forced tool call** (`report_stall_judgment`). The sidecar emits
 *     exactly one tool call; no narration. Production parses the tool
 *     input — easier to validate than free-form text.
 *   - **Third-person transcript embedding**. The transcript is rendered
 *     into a *user-message text body* (not passed as priorMessages) so
 *     the sidecar doesn't mis-attribute the main agent's past actions as
 *     its own.
 *
 * **Runtime safety belt** (production-only — eval didn't need these):
 *   - **5s timeout**. Bounds the wall-clock cost of every L1 fire.
 *     Timeout returns `{isStuck:false}` so the agent loop proceeds with
 *     no nudge — fail-open on safety, fail-closed on suppression.
 *   - **Defensive parsing**. Sidecar models in eval occasionally emitted
 *     tool name typos (`report_stall_jundgment` from mmx P3 run=2) and
 *     string-typed `isStuck` ("true"/"false"). Fuzzy tool-name match
 *     (edit distance ≤ 2) and string→boolean coercion absorb these
 *     without dropping the verdict.
 *   - **Provider error → no nudge**. Any thrown error from the provider
 *     stream is caught and converted to `{isStuck:false}`.
 *
 * **FEATURE_215 (v0.7.49)**: the domain-neutral invocation skeleton
 * (stream → fuzzy-match → parse → timeout-race → fail-open) moved to
 * `@kodax-ai/agent` as `invokeLlmJudge`. This module is now a thin
 * consumer: it injects the stall-specific parser + default-verdict
 * mapping. `editDistance` / `findFuzzyToolMatch` are re-exported from the
 * agent kernel (single source of truth — no more copy-paste); the
 * stall-specific `normalizeIsStuck` stays local.
 *
 * Killswitch — global feature kill is owned by `stall-detector.ts`
 * (`KODAX_STALL_DETECT=0`).
 *
 * DI-clean: provider injection is the only external surface. Tests pass
 * a fake provider that returns canned `{textBlocks, toolBlocks}` results.
 */

import type {
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { LlmJudgeFailureReason } from '@kodax-ai/agent';
import { invokeLlmJudge, editDistance, findFuzzyToolMatch } from '@kodax-ai/agent';

// Re-export the domain-neutral fuzzy-match helpers from the agent kernel
// so existing `./sidecar.js` import sites (incl. tests) keep working.
// FEATURE_215 made these the single source of truth in `@kodax-ai/agent`.
export { editDistance, findFuzzyToolMatch };

/**
 * The set of suggested-tool names the sidecar is allowed to reference.
 *
 * FEATURE_190 (v0.7.43): `emit_handoff` removed — the tool is being
 * deleted as part of the F184 cleanup tail. F178 eval evidence transfers
 * because the eval probes `isStuck` accuracy, not which specific tool
 * the sidecar may suggest. See `prompts.ts` header for the broader
 * exception policy.
 */
export const ALLOWED_SUGGESTED_TOOLS: readonly string[] = [
  'read',
  'edit',
  'write',
  'multi_edit',
  'grep',
  'glob',
  'bash',
  'interrupt_agent',
];

/**
 * Sidecar's verdict shape — pinned by the FEATURE_178 eval `cases.ts`
 * `REPORT_TOOL` schema (matches `expectedIsStuck` field on each case).
 *
 * `isStuck=false` is the safe-default: any parse failure, timeout,
 * provider error, or schema violation lands here so the main loop is
 * never blocked by the sidecar. `nudge` is only populated on a clean
 * `isStuck=true` verdict.
 */
export interface SidecarVerdict {
  readonly isStuck: boolean;
  /** The model's one-sentence rationale (≤200 chars when well-formed). */
  readonly reason?: string;
  /**
   * The specific tool name the model suggests calling next. Always one
   * of `ALLOWED_SUGGESTED_TOOLS` after defensive parsing; empty string
   * is normalized to undefined.
   */
  readonly suggestedTool?: string;
  /**
   * Concrete nudge text the main agent would see as a synthetic user
   * message. Only set when `isStuck=true`. ≤600 chars by sidecar
   * contract; production does not re-truncate (the eval validated this
   * upper bound).
   */
  readonly nudge?: string;
  /**
   * Why the verdict took its final shape. Diagnostic field — not
   * forwarded to the main agent. Tags:
   *   - `'sidecar_ok'`: clean parse, used the model's verdict
   *   - `'no_tool_call'`: model didn't emit report_stall_judgment
   *   - `'fuzzy_tool_match'`: matched a near-spelling (e.g. typo)
   *   - `'coerced_string_bool'`: isStuck arrived as "true"/"false" string
   *   - `'invalid_suggested_tool'`: suggestedTool not in registry
   *   - `'provider_error'`: stream threw
   *   - `'timeout'`: provider didn't return in time
   */
  readonly trace: SidecarVerdictTrace;
}

export type SidecarVerdictTrace =
  | 'sidecar_ok'
  | 'no_tool_call'
  | 'fuzzy_tool_match'
  | 'coerced_string_bool'
  | 'invalid_suggested_tool'
  | 'provider_error'
  | 'timeout';

export interface StallSidecarOptions {
  /** Provider used to call the sidecar — defaults to the main agent's,
   *  may be cross-family overridden via FEATURE_187 Phase B env vars. */
  readonly provider: KodaXBaseProvider;

  /**
   * Specific model id on the provider. When omitted, the provider's
   * registered default model is used. FEATURE_187 Phase B production
   * wiring passes the model resolved by `resolveStallSidecarProvider()`.
   */
  readonly model?: string;

  /**
   * The pre-rendered user-message body for the sidecar. Caller builds
   * this by combining the L1 stall signal envelope with the rendered
   * third-person transcript (see `buildSidecarUserMessage` in the
   * prompts module).
   */
  readonly userMessage: string;

  /** SYSTEM_PROMPT pinned by the F178 eval — caller supplies. */
  readonly systemPrompt: string;

  /** `report_stall_judgment` tool definition pinned by the F178 eval. */
  readonly reportTool: KodaXToolDefinition;

  /** Timeout in ms before sidecar gives up. Default 5000. */
  readonly timeoutMs?: number;
}

/**
 * Defensive isStuck normalization. Some sidecar models in the F178 eval
 * (mmx P3 run=2) returned `isStuck:"true"` as a JSON string rather than
 * a boolean. The semantic verdict was correct; only the encoding was
 * off. We coerce so a single-character JSON quirk doesn't drop the
 * verdict to safe-default.
 *
 * Returns:
 *   - boolean true/false on a real boolean OR the literal strings
 *     "true" / "false" (case-insensitive, trimmed)
 *   - undefined on anything else (caller falls back to safe-default)
 */
export function normalizeIsStuck(
  raw: unknown,
): { value: boolean; coerced: boolean } | undefined {
  if (typeof raw === 'boolean') return { value: raw, coerced: false };
  if (typeof raw === 'string') {
    const norm = raw.trim().toLowerCase();
    if (norm === 'true') return { value: true, coerced: true };
    if (norm === 'false') return { value: false, coerced: true };
  }
  return undefined;
}

/** Internal helper — pull the tool's `input` object, defensively. */
function getToolInput(block: KodaXToolUseBlock): Record<string, unknown> {
  if (!block.input || typeof block.input !== 'object') return {};
  return block.input as Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const REPORT_TOOL_NAME = 'report_stall_judgment';

/**
 * Parse a `report_stall_judgment` tool call into a SidecarVerdict.
 * Returns undefined when `isStuck` cannot be parsed — the kernel maps
 * that to the safe-default (trace `no_tool_call`), matching the original
 * inline behavior.
 */
function parseStallToolCall(
  block: KodaXToolUseBlock,
  exact: boolean,
): SidecarVerdict | undefined {
  const input = getToolInput(block);
  const isStuckNorm = normalizeIsStuck(input.isStuck);
  if (isStuckNorm === undefined) {
    return undefined;
  }

  const reason = typeof input.reason === 'string' ? input.reason : undefined;
  const rawSuggested = typeof input.suggestedTool === 'string'
    ? input.suggestedTool.trim()
    : '';
  const suggestedTool = rawSuggested && ALLOWED_SUGGESTED_TOOLS.includes(rawSuggested)
    ? rawSuggested
    : undefined;
  const rawNudge = typeof input.nudge === 'string' ? input.nudge.trim() : '';
  const nudge = isStuckNorm.value && rawNudge ? rawNudge : undefined;

  // Trace precedence: if both fuzzy match AND coerced bool fire, the
  // fuzzy-match trace is reported (more semantically interesting than
  // a single-char JSON typo).
  let trace: SidecarVerdictTrace = 'sidecar_ok';
  if (!exact) trace = 'fuzzy_tool_match';
  else if (isStuckNorm.coerced) trace = 'coerced_string_bool';
  else if (isStuckNorm.value && rawSuggested && !suggestedTool) {
    trace = 'invalid_suggested_tool';
  }

  return {
    isStuck: isStuckNorm.value,
    reason,
    suggestedTool,
    nudge,
    trace,
  };
}

/**
 * Safe-default verdict factory for the kernel's fail-open paths. A
 * `parse_failure` (unparseable `isStuck`) is mapped to `no_tool_call`,
 * preserving the pre-FEATURE_215 inline behavior.
 */
function stallDefaultVerdict(reason: LlmJudgeFailureReason): SidecarVerdict {
  const trace: SidecarVerdictTrace =
    reason === 'provider_error' ? 'provider_error'
    : reason === 'timeout' ? 'timeout'
    : 'no_tool_call';
  return { isStuck: false, trace };
}

/**
 * Invoke the L2 sidecar against the supplied provider. Returns a
 * SidecarVerdict — always; never throws.
 *
 * Thin consumer of `@kodax-ai/agent`'s `invokeLlmJudge` (FEATURE_215):
 * injects the stall report tool name / parser / default-verdict mapping.
 */
export async function invokeStallSidecar(
  options: StallSidecarOptions,
): Promise<SidecarVerdict> {
  return invokeLlmJudge<SidecarVerdict>({
    provider: options.provider,
    model: options.model,
    systemPrompt: options.systemPrompt,
    reportTool: options.reportTool,
    userMessage: options.userMessage,
    reportToolName: REPORT_TOOL_NAME,
    parseToolCall: parseStallToolCall,
    defaultVerdict: stallDefaultVerdict,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
