/**
 * Unit tests — FEATURE_167 (v0.7.41) Evaluator verdict retry config.
 *
 * Pin three invariants:
 *
 *   1. `resolveEvaluatorVerdictRetryCap` returns 1 for zhipu family,
 *      2 for everything else (including unknown / undefined).
 *
 *   2. `EVALUATOR_VERDICT_RETRY_PROMPT` is the exact byte sequence the
 *      Layer 2 probe dataset used. Drift between runtime + dataset
 *      makes probe data non-transferable (see EVAL_GUIDELINES
 *      reproducibility clause); this test catches drift at CI time.
 *
 *   3. Telemetry shape is non-optional in places that matter — the
 *      `EvaluatorFallbackSynthesizedInfo` field set must include
 *      `retriesAttempted`, `cap`, `userFacingText`, `reason` so SDK
 *      consumers can build dashboards / alerts without optional-chaining.
 */

import { describe, expect, it } from 'vitest';

import {
  EVALUATOR_VERDICT_RETRY_CAPS_BY_FAMILY,
  EVALUATOR_VERDICT_RETRY_CAP_DEFAULT,
  EVALUATOR_VERDICT_RETRY_PROMPT,
  resolveEvaluatorVerdictRetryCap,
  type EvaluatorFallbackSynthesizedInfo,
} from './evaluator-verdict-retry.js';

describe('FEATURE_167 — resolveEvaluatorVerdictRetryCap', () => {
  it('returns default cap 2 for unknown alias', () => {
    expect(resolveEvaluatorVerdictRetryCap('some/random-model')).toBe(2);
  });

  it('returns default cap 2 when alias is undefined', () => {
    expect(resolveEvaluatorVerdictRetryCap(undefined)).toBe(2);
  });

  it('returns default cap 2 when alias is empty string', () => {
    expect(resolveEvaluatorVerdictRetryCap('')).toBe(2);
  });

  it('returns cap 1 for zhipu/glm51', () => {
    expect(resolveEvaluatorVerdictRetryCap('zhipu/glm51')).toBe(1);
  });

  it('returns cap 1 for zhipu/glm45', () => {
    expect(resolveEvaluatorVerdictRetryCap('zhipu/glm45')).toBe(1);
  });

  it('returns cap 1 for zhipu-coding/glm-5.1 (hyphen-separated family form)', () => {
    // Production logs use both `zhipu/glm51` and `zhipu-coding/glm-5.1`.
    // The cap must apply to the family regardless of separator style.
    expect(resolveEvaluatorVerdictRetryCap('zhipu-coding/glm-5.1')).toBe(1);
  });

  it('is case-insensitive on the family match', () => {
    expect(resolveEvaluatorVerdictRetryCap('ZHIPU/glm51')).toBe(1);
    expect(resolveEvaluatorVerdictRetryCap('Zhipu-Coding/glm5')).toBe(1);
  });

  it('returns default cap for aliases that incidentally contain "zhipu" mid-string', () => {
    // Match is anchored at the start, not substring — a hypothetical
    // alias like `kimi-zhipu-tuned` is NOT zhipu family.
    expect(resolveEvaluatorVerdictRetryCap('kimi-zhipu-tuned')).toBe(2);
  });

  it('default cap export is 2', () => {
    expect(EVALUATOR_VERDICT_RETRY_CAP_DEFAULT).toBe(2);
  });

  it('zhipu entry in caps-by-family map is 1', () => {
    expect(EVALUATOR_VERDICT_RETRY_CAPS_BY_FAMILY['zhipu/']).toBe(1);
  });
});

describe('FEATURE_167 — EVALUATOR_VERDICT_RETRY_PROMPT byte-equality', () => {
  // The Layer 2 probe dataset
  // (benchmark/datasets/feature-167-evaluator-verdict-fallback/cases.ts)
  // contains a verbatim snapshot of this prompt. If the runtime
  // constant drifts, the probe data becomes non-transferable: future
  // RC runs would measure a different prompt than the one that gated
  // SHIP. This test pins the exact bytes against a snapshot here.
  //
  // To update: change BOTH this snapshot AND the dataset constant in
  // ONE commit, and re-run the probe.
  const PROBE_PINNED_SNAPSHOT = [
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

  it('runtime constant matches the Layer 2 probe snapshot byte-for-byte', () => {
    expect(EVALUATOR_VERDICT_RETRY_PROMPT).toBe(PROBE_PINNED_SNAPSHOT);
  });

  it('is non-empty', () => {
    expect(EVALUATOR_VERDICT_RETRY_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions emit_verdict tool name verbatim (sanity check for refactors)', () => {
    expect(EVALUATOR_VERDICT_RETRY_PROMPT).toContain('emit_verdict');
  });

  it('mentions the three valid status values', () => {
    expect(EVALUATOR_VERDICT_RETRY_PROMPT).toContain('"accept"');
    expect(EVALUATOR_VERDICT_RETRY_PROMPT).toContain('"revise"');
    expect(EVALUATOR_VERDICT_RETRY_PROMPT).toContain('"blocked"');
  });
});

describe('FEATURE_167 — EvaluatorFallbackSynthesizedInfo shape', () => {
  it('compiles with all required fields populated', () => {
    // Type-only assertion via structural literal. If any required field
    // is removed from the interface, this stops compiling — keeping the
    // telemetry contract stable across SDK consumer dashboards.
    const info: EvaluatorFallbackSynthesizedInfo = {
      retriesAttempted: 2,
      cap: 2,
      modelAlias: 'kimi',
      userFacingText: 'Review complete. No issues.',
      reason: 'Evaluator failed to emit a terminal verdict after 2 retries.',
    };
    expect(info.retriesAttempted).toBe(2);
    expect(info.cap).toBe(2);
    expect(info.userFacingText).toContain('Review complete');
    expect(info.reason).toContain('failed to emit');
  });

  it('accepts modelAlias: undefined (dispatch path may not surface it)', () => {
    const info: EvaluatorFallbackSynthesizedInfo = {
      retriesAttempted: 1,
      cap: 1,
      modelAlias: undefined,
      userFacingText: 'text',
      reason: 'reason',
    };
    expect(info.modelAlias).toBeUndefined();
  });
});
