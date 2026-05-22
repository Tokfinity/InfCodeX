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
 *     its own. This was an eval-pilot finding — passing assistant
 *     messages directly caused "I read the file" first-person framing.
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
 *     stream is caught and converted to `{isStuck:false}`. We trade
 *     missed-detection for not blocking the main loop on transient
 *     network / rate-limit errors in the sidecar layer.
 *
 * Killswitch — global feature kill is owned by `stall-detector.ts`
 * (`KODAX_STALL_DETECT=0`). If the L1 detector is disabled, this
 * sidecar is never invoked because no stall signals are produced.
 *
 * DI-clean: provider injection is the only external surface. Tests pass
 * a fake provider that returns canned `{textBlocks, toolBlocks}` results.
 */

import type {
  KodaXMessage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { KodaXBaseProvider } from '@kodax-ai/llm';

/** The set of suggested-tool names the sidecar is allowed to reference. */
export const ALLOWED_SUGGESTED_TOOLS: readonly string[] = [
  'read',
  'edit',
  'write',
  'multi_edit',
  'grep',
  'glob',
  'bash',
  'task_stop',
  'emit_handoff',
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
   * wiring passes the model resolved by `resolveStallSidecarProvider()`
   * so the `KODAX_STALL_MODEL` env override takes effect at the
   * `provider.stream` call (without this thread the override would be
   * cosmetic — provider name changes but model stays at provider
   * default).
   */
  readonly model?: string;

  /**
   * The pre-rendered user-message body for the sidecar. Caller builds
   * this by combining the L1 stall signal envelope with the rendered
   * third-person transcript (see `buildSidecarUserMessage` in the
   * prompts module — added in commit 3/4 alongside production wiring).
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
 * Levenshtein edit distance between two strings. Short, no regex.
 * Used by `findFuzzyToolMatch` to absorb typos like
 * `report_stall_jundgment` → `report_stall_judgment` that surfaced in
 * the F178 eval (mmx P3 run=2).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find the tool_use block whose name matches `expectedToolName` exactly
 * or within edit distance 2. Returns undefined when no candidate is
 * close enough.
 */
export function findFuzzyToolMatch(
  toolBlocks: readonly KodaXToolUseBlock[],
  expectedToolName: string,
): { block: KodaXToolUseBlock; exact: boolean } | undefined {
  const exact = toolBlocks.find((b) => b.name === expectedToolName);
  if (exact) return { block: exact, exact: true };

  let best: { block: KodaXToolUseBlock; distance: number } | undefined;
  for (const b of toolBlocks) {
    const d = editDistance(b.name, expectedToolName);
    if (d <= 2 && (best === undefined || d < best.distance)) {
      best = { block: b, distance: d };
    }
  }
  return best ? { block: best.block, exact: false } : undefined;
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
 * Invoke the L2 sidecar against the supplied provider. Returns a
 * SidecarVerdict — always; never throws (any internal error is
 * converted to `{isStuck:false, trace:'provider_error'|'timeout'}`).
 */
export async function invokeStallSidecar(
  options: StallSidecarOptions,
): Promise<SidecarVerdict> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const messages: KodaXMessage[] = [
    { role: 'user', content: options.userMessage },
  ];

  const streamPromise = (async (): Promise<SidecarVerdict> => {
    let result;
    try {
      result = await options.provider.stream(
        messages,
        [options.reportTool],
        options.systemPrompt,
        false,
        options.model ? { modelOverride: options.model } : undefined,
      );
    } catch {
      return { isStuck: false, trace: 'provider_error' };
    }

    const match = findFuzzyToolMatch(result.toolBlocks ?? [], REPORT_TOOL_NAME);
    if (!match) {
      return { isStuck: false, trace: 'no_tool_call' };
    }

    const input = getToolInput(match.block);
    const isStuckNorm = normalizeIsStuck(input.isStuck);
    if (isStuckNorm === undefined) {
      return { isStuck: false, trace: 'no_tool_call' };
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
    if (!match.exact) trace = 'fuzzy_tool_match';
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
  })();

  // Timeout race — safe-default verdict on timeout.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SidecarVerdict>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ isStuck: false, trace: 'timeout' });
    }, timeoutMs);
  });

  const verdict = await Promise.race([streamPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return verdict;
}
