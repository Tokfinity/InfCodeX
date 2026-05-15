/**
 * FEATURE_167 (v0.7.41) — Evaluator terminal-verdict fallback.
 *
 * Canonical retry-prompt + cap policy used by the runner-driven outer
 * loop when Evaluator exits a turn without calling `emit_verdict`.
 *
 * ## Background
 *
 * Production session 20260515_185354 exposed a structural functional
 * bug: V2 AMA Worker→Evaluator handoff succeeds, Evaluator emits
 * text-only response (no tool call), runner.ts:558 exits the inner
 * loop on empty toolCalls, outer `detectIdleYield` sees
 * `hasEmittedHandoff=true` so it doesn't resume, run terminates with
 * `recorder.verdict === undefined`. Then `deriveFinalStatus`
 * (runner-driven.ts:4146) falls back to `signal:'COMPLETE'` — the
 * audit failed but the system reports SUCCESS.
 *
 * ## Probe data (2026-05-15, 5 alias × 5 run)
 *
 * - C1 (Evaluator first-turn emit_verdict baseline):     20% overall
 *     - zhipu/glm51: 0/5 (intent-vs-action floor)
 *     - kimi:        0/5 (verifies-then-verdicts; probe single-turn artifact)
 *     - ds/v4pro:    2/5 (40%)
 *     - ds/v4flash:  1/5 (20%)
 *     - mmx/m27:     2/5 (40%)
 *
 * - C2 (B1 retry recovery rate after prompt injection):  64% overall
 *     - zhipu/glm51: 0/5 (intent floor unrecoverable)
 *     - kimi:        5/5 (100%)
 *     - ds/v4pro:    4/5 (80%)
 *     - ds/v4flash:  3/5 (60%)
 *     - mmx/m27:     4/5 (80%)
 *
 * - C3 (fenced-block emission rate):                     0/25 (0%)
 *     - B0 (fenced parser activation) SKIPPED — no model emits fences.
 *
 * ## Cap policy (pre-registered SHIP matrix special case)
 *
 * Default cap is 2 retries. zhipu/* family gets cap 1 because the
 * intent-vs-action floor is structurally unrecoverable (memory
 * [[project_zhipu_send_message_floor]]) — second retry would waste an
 * LLM turn for no benefit, B2 fallback catches it.
 *
 * ## Prompt source-of-truth coupling
 *
 * `EVALUATOR_VERDICT_RETRY_PROMPT` is the canonical string. The probe
 * driver dataset (`benchmark/datasets/feature-167-evaluator-verdict-
 * fallback/cases.ts`) holds a verbatim snapshot for reproducibility.
 * The unit test `evaluator-verdict-retry.test.ts` asserts byte-for-byte
 * equality between the runtime constant and the dataset snapshot to
 * catch drift. Any change to this string MUST trigger a probe re-run
 * before shipping.
 */

/**
 * Retry prompt injected as a user-role message when Evaluator exits a
 * turn without emit_verdict. Probe-pinned 2026-05-15.
 */
export const EVALUATOR_VERDICT_RETRY_PROMPT = [
  'Your previous response ended without calling the `emit_verdict` tool ' +
    'and without a valid ```kodax-task-verdict``` fenced block. The run ' +
    'cannot terminate without a structured verdict.',
  '',
  'Call `emit_verdict` now with this shape:',
  '  emit_verdict({',
  '    status: "accept" | "revise" | "blocked",',
  '    reason: "<one-line reason>",',
  '    user_answer: "<final user-facing answer, multi-line ok>"',
  '  })',
  '',
  'Do NOT respond with text only. Do NOT repeat the review summary in ' +
    'prose — put the consolidated review in `user_answer` and call the tool.',
].join('\n');

/**
 * Default retry cap. Two retries balance "give the model a real chance
 * to recover" against "don't burn budget on a structurally stuck model".
 * Probe C2 data showed kimi recovers 100% by retry 1; ds/v4pro and
 * mmx/m27 plateau around 80% within 1-2 retries.
 */
export const EVALUATOR_VERDICT_RETRY_CAP_DEFAULT = 2;

/**
 * Per-family cap overrides. Aliases matching a key prefix get the
 * specified cap instead of the default. Probe C2 data showed
 * `zhipu/glm51` at 0/5 even with retry — second retry is wasted budget.
 *
 * Future tuning: if a new alias family reproduces the zhipu intent
 * floor under controlled probe conditions, add it here with cap 1.
 * Removing an entry returns the family to default cap 2.
 */
export const EVALUATOR_VERDICT_RETRY_CAPS_BY_FAMILY: Readonly<
  Record<string, number>
> = Object.freeze({
  'zhipu/': 1,
});

/**
 * Resolve the per-run retry cap for the active model alias. When the
 * alias is unknown / undefined, returns the default cap.
 *
 * Matching is by prefix (`'zhipu/'`) so all zhipu sub-models (glm51,
 * glm45, etc.) share the cap. Substring match instead of strict equality
 * because alias strings vary: `zhipu/glm51`, `zhipu-coding/glm-5.1`,
 * `zhipu/glm5.1` all appear in production logs.
 */
export function resolveEvaluatorVerdictRetryCap(
  modelAlias: string | undefined,
): number {
  if (!modelAlias) return EVALUATOR_VERDICT_RETRY_CAP_DEFAULT;
  const normalized = modelAlias.toLowerCase();
  for (const [familyPrefix, cap] of Object.entries(
    EVALUATOR_VERDICT_RETRY_CAPS_BY_FAMILY,
  )) {
    if (normalized.startsWith(familyPrefix.toLowerCase())) return cap;
    // Also match aliases that use a hyphen instead of a slash in the
    // family separator (e.g. `zhipu-coding/glm-5.1`). The slash variant
    // is already handled by the prefix match above; only the hyphen
    // variant needs this fallback.
    const family = familyPrefix.replace(/\/$/, '');
    if (normalized.startsWith(`${family}-`)) return cap;
  }
  return EVALUATOR_VERDICT_RETRY_CAP_DEFAULT;
}

/**
 * Telemetry payload for the `events.onEvaluatorFallbackSynthesized`
 * event. Fires AFTER `recorder.verdict` is written but BEFORE
 * `formatDeterministicEvaluatorResult` builds the final `KodaXResult`,
 * so consumers see the synth event in causal order before the result.
 */
export interface EvaluatorFallbackSynthesizedInfo {
  /**
   * Number of retries that were attempted before falling back. `0` means
   * the very first detection of `verdict missing` led to fallback with
   * no retry (only possible if `cap === 0`, which we don't allow — but
   * keeping the field non-optional to keep the telemetry shape stable).
   */
  readonly retriesAttempted: number;
  /** The cap value resolved for this run's model alias. */
  readonly cap: number;
  /**
   * The model alias the run used, if known. `undefined` when the run
   * dispatcher didn't surface the alias to the outer loop.
   */
  readonly modelAlias: string | undefined;
  /**
   * The last assistant text the Evaluator produced (the text-only
   * response that triggered B2). Stored verbatim so post-hoc audit can
   * see what the model said when it failed to terminate.
   */
  readonly userFacingText: string;
  /** Stable reason string written into the synthesized verdict. */
  readonly reason: string;
}
