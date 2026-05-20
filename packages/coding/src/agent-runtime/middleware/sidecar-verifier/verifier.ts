/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier invoker + Stop hook factory.
 *
 * Phase D.1 of ADR-030 (claudecode-shape Main Agent + Sidecar Verifier).
 *
 * When the Main Agent terminates a turn text-only (no tool_use), the
 * agent-layer `RunOptions.stopHook` fires. This module:
 *
 *   1. Runs a second-pass LLM verification call (independent context,
 *      configurable model — usually a strong family) via
 *      `provider.stream` with a forced `emit_sidecar_verdict` tool call
 *   2. Maps the 3-state verdict ('accept' / 'revise' / 'blocked') to
 *      the agent-layer `StopHookResult` 3-state surface
 *      (undefined / string / {abort, reason})
 *   3. Honors a fail-open policy: timeout, provider error, missing tool
 *      call, or parse failure → default `'accept'` (do not block the
 *      happy path)
 *
 * **Model decoupling rationale**: a separate `provider` injection lets
 * the verifier run on a different (typically stronger) model than the
 * Main Agent. This is the architectural fix for the zhipu/glm51
 * intent-vs-action floor (memory: project_feature_167) — the floor is a
 * model property; route around it by not using zhipu for verification.
 *
 * Phase D.1 scope (this commit): substrate module only. The
 * `createSidecarVerifierStopHook` factory returns a `StopHookFn` but it
 * is NOT yet wired into `runner-driven.ts`'s `runOnce` RunOptions —
 * that wiring is Phase D.2 (atomic swap with C.1/C.2/C.3).
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D
 * - F178 stall-sidecar.ts — invocation / fuzzy-match / fail-open patterns
 *
 * DI-clean: provider injection is the only external surface. Tests
 * pass a fake provider returning canned `{textBlocks, toolBlocks}`.
 */

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { StopHookFn, StopHookResult } from '@kodax-ai/agent';

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
   *  resolution from a default-verifier-model registry. */
  readonly provider: KodaXBaseProvider;
  /** Verifier context built by the caller (`buildVerifierContext`). */
  readonly inputs: SidecarVerifierContextInputs;
  /** Timeout in ms. Default 15000 (verification is heavier than F178
   *  anomaly detection's 5s budget). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REPORT_TOOL_NAME = 'emit_sidecar_verdict';
const VALID_VERDICTS: readonly SidecarVerifierVerdictValue[] = ['accept', 'revise', 'blocked'];

/**
 * Levenshtein distance — duplicated from F178 stall-sidecar.ts for layer
 * cleanliness (sidecar-verifier should not depend on multi-instance/).
 * Same algorithm, ≤2 distance threshold.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

function findVerifierToolMatch(
  toolBlocks: readonly KodaXToolUseBlock[],
): { block: KodaXToolUseBlock; exact: boolean } | undefined {
  const exact = toolBlocks.find((b) => b.name === REPORT_TOOL_NAME);
  if (exact) return { block: exact, exact: true };

  let best: { block: KodaXToolUseBlock; distance: number } | undefined;
  for (const b of toolBlocks) {
    const d = editDistance(b.name, REPORT_TOOL_NAME);
    if (d <= 2 && (best === undefined || d < best.distance)) {
      best = { block: b, distance: d };
    }
  }
  return best ? { block: best.block, exact: false } : undefined;
}

function getToolInput(block: KodaXToolUseBlock): Record<string, unknown> {
  if (!block.input || typeof block.input !== 'object') return {};
  return block.input as Record<string, unknown>;
}

/**
 * Parse a `emit_sidecar_verdict` tool call into a typed verdict.
 * Returns the safe-default `accept` on any malformed input, with
 * a diagnostic trace tag.
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
 * Invoke the Sidecar Verifier against the supplied provider. Returns a
 * SidecarVerifierVerdict — always; never throws (internal errors map to
 * safe-default `accept` with diagnostic trace).
 *
 * Production wiring (Phase D.2): call this from inside the StopHookFn
 * returned by `createSidecarVerifierStopHook`. Tests can call it
 * directly with a fake provider.
 */
export async function invokeSidecarVerifier(
  options: SidecarVerifierInvokeOptions,
): Promise<SidecarVerifierVerdict> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userMessage = buildVerifierUserMessage(options.inputs);

  const messages: KodaXMessage[] = [
    { role: 'user', content: userMessage },
  ];

  const streamPromise = (async (): Promise<SidecarVerifierVerdict> => {
    let result;
    try {
      result = await options.provider.stream(
        messages,
        [VERIFIER_REPORT_TOOL],
        VERIFIER_SYSTEM_PROMPT,
        false,
      );
    } catch {
      return { verdict: 'accept', reason: '', trace: 'provider_error' };
    }

    const match = findVerifierToolMatch(result.toolBlocks ?? []);
    if (!match) {
      return { verdict: 'accept', reason: '', trace: 'no_tool_call' };
    }
    return parseVerifierToolCall(match.block, match.exact);
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SidecarVerifierVerdict>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ verdict: 'accept', reason: '', trace: 'timeout' });
    }, timeoutMs);
  });

  const verdict = await Promise.race([streamPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return verdict;
}

/**
 * Map a `SidecarVerifierVerdict` to the agent-layer `StopHookResult`
 * three-state surface:
 *   - 'accept'  → undefined        (defer to terminal path)
 *   - 'revise'  → string (reason)  (reanimate via synthetic user msg)
 *   - 'blocked' → {abort, reason}  (halt + surface to caller)
 *
 * Pure function — no I/O. Exported for tests and for Phase D.2 wiring.
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
   *  a default-verifier-model registry; tests pass a fake. */
  readonly provider: KodaXBaseProvider;
  /** Builds the context inputs from the StopHookContext + the caller's
   *  per-run state (file edit ledger, current-turn user queries, etc.).
   *  Phase D.2 supplies a concrete builder; Phase D.1 leaves this as
   *  an injection point. */
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
 * maps its verdict to the agent-layer 3-state result. Phase D.1
 * surfaces this for D.2 wiring — not yet attached to `runOnce`.
 *
 * The returned hook is a thin shim: it builds the verifier context via
 * the caller-supplied `buildContext`, awaits `invokeSidecarVerifier`,
 * notifies `onVerdict`, and maps to StopHookResult. Composition with
 * the extension `turn:complete` bridge (Phase B's
 * `createExtensionTurnCompleteStopHook`) is the caller's
 * responsibility at the RunOptions construction site.
 */
export function createSidecarVerifierStopHook(
  options: CreateSidecarVerifierStopHookOptions,
): StopHookFn {
  // Convert AgentMessage (agent-layer transcript) to KodaXMessage shape
  // for verifier context. The two types are structurally compatible at
  // the role + content level — agent layer uses `AgentMessage` (subset
  // of `KodaXMessage` without provider-specific extensions).
  return async (ctx): Promise<StopHookResult> => {
    const inputs = options.buildContext({
      transcript: ctx.transcript as readonly KodaXMessage[],
      lastAssistantText: ctx.lastAssistantText,
    });
    const verdict = await invokeSidecarVerifier({
      provider: options.provider,
      inputs,
      timeoutMs: options.timeoutMs,
    });
    options.onVerdict?.(verdict);
    return mapVerifierVerdictToStopHookResult(verdict);
  };
}
