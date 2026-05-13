/**
 * Hermetic shape tests for FEATURE_121 v0.7.40 envelope-spillover
 * dispatch-bullet dataset. Zero LLM cost. Locks down dataset invariants
 * the eval relies on — mirrors `feature-151-fan-out-plan-granularity/cases.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  READ_DETECTOR,
  INLINE_DETECTOR,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'preview_sufficient',
  'detail_required',
  'inline_no_spillover',
];

describe('FEATURE_121 envelope-spillover dataset shape', () => {
  it('exports exactly 3 cases — 1 positive (expectRead=true) + 2 negative', () => {
    expect(CASES.length).toBe(3);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
    const positive = CASES.filter((c) => c.expectRead);
    const negative = CASES.filter((c) => !c.expectRead);
    expect(positive.length).toBe(1);
    expect(negative.length).toBe(2);
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });
});

describe('FEATURE_121 variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.40', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.40');
      });

      it('system + user prompts are non-empty and well-formed', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt.length).toBeGreaterThan(100);
        expect(variant?.userMessage.length).toBeGreaterThan(50);
      });

      it('system prompt embeds the LARGE CHILD OUTPUT bullet under test', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt).toContain('LARGE CHILD OUTPUT (FEATURE_121 v0.7.40)');
        expect(variant?.systemPrompt).toContain('Tool output truncated');
        expect(variant?.systemPrompt).toContain('Do NOT blindly Read every spillover path');
      });

      it('system prompt pins the ACTION: output contract', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt).toContain('ACTION: Read(');
        expect(variant?.systemPrompt).toContain('ACTION: respond_inline');
      });
    });
  }

  it('preview_sufficient user message includes spillover marker AND a brief-question ask', () => {
    const [variant] = buildPromptVariants('preview_sufficient');
    expect(variant?.userMessage).toContain('Tool output truncated');
    expect(variant?.userMessage).toContain('Full output saved to:');
    expect(variant?.userMessage).toMatch(/One sentence/i);
  });

  it('detail_required user message includes spillover marker AND an exhaustive-detail ask', () => {
    const [variant] = buildPromptVariants('detail_required');
    expect(variant?.userMessage).toContain('Tool output truncated');
    expect(variant?.userMessage).toMatch(/COMPLETE list/i);
  });

  it('inline_no_spillover user message does NOT include a spillover marker', () => {
    const [variant] = buildPromptVariants('inline_no_spillover');
    expect(variant?.userMessage).not.toContain('Tool output truncated');
    expect(variant?.userMessage).not.toContain('Full output saved to:');
  });
});

describe('FEATURE_121 judges', () => {
  it('detail_required — judges pass on a well-formed ACTION: Read line', () => {
    const judges = buildJudges('detail_required');
    const sample =
      'ACTION: Read("/tmp/kodax/tool-results/2026-05-13T06-00-abc123.txt")\n' +
      'User wants every issue with paths and line numbers; preview only shows 4 of 29 findings.';
    for (const j of judges) {
      expect(j.judge(sample).passed, `judge "${j.name}" should pass`).toBe(true);
    }
  });

  it('detail_required — fails when Worker emits respond_inline instead of Read', () => {
    const judges = buildJudges('detail_required');
    const sample =
      'ACTION: respond_inline\n' +
      'The preview shows 4 issues, I will summarize those.';
    // emits_action_read AND does_not_emit_respond_inline both fail; only
    // the read_target_is_spillover_path judge fails on "no match".
    expect(judges.some((j) => !j.judge(sample).passed)).toBe(true);
  });

  it('preview_sufficient — passes on a well-formed ACTION: respond_inline line', () => {
    const judges = buildJudges('preview_sufficient');
    const sample =
      'ACTION: respond_inline\n' +
      'Preview already states none are critical; one-sentence ask is satisfied.';
    for (const j of judges) {
      expect(j.judge(sample).passed, `judge "${j.name}" should pass`).toBe(true);
    }
  });

  it('preview_sufficient — fails when Worker emits ACTION: Read despite preview being sufficient', () => {
    const judges = buildJudges('preview_sufficient');
    const sample =
      'ACTION: Read("/tmp/kodax/tool-results/2026-05-13T06-00-abc123.txt")\n' +
      'Reading the spillover file just in case.';
    // does_not_emit_action_read should fail (a Read line on a preview-
    // sufficient case is the regression we are defending against).
    const failing = judges.filter((j) => !j.judge(sample).passed);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some((j) => j.name.includes('does_not_emit_action_read'))).toBe(true);
  });

  it('inline_no_spillover — passes on respond_inline', () => {
    const judges = buildJudges('inline_no_spillover');
    const sample = 'ACTION: respond_inline\nNo spillover marker; preview is the full result.';
    for (const j of judges) {
      expect(j.judge(sample).passed).toBe(true);
    }
  });

  it('inline_no_spillover — fails when Worker blanket-Reads a non-existent path', () => {
    const judges = buildJudges('inline_no_spillover');
    const sample = 'ACTION: Read("/tmp/kodax/tool-results/anywhere.txt")\nBlanket reading.';
    expect(judges.some((j) => !j.judge(sample).passed)).toBe(true);
  });
});

describe('FEATURE_121 detector regexes', () => {
  it('READ_DETECTOR matches single-line ACTION: Read with quoted absolute path', () => {
    expect(READ_DETECTOR.test('ACTION: Read("/tmp/foo.txt")')).toBe(true);
    expect(READ_DETECTOR.test("ACTION: Read('/tmp/foo.txt')")).toBe(true);
    // No quotes accepted — defensive against models that drop them.
    expect(READ_DETECTOR.test('ACTION: Read(/tmp/foo.txt)')).toBe(true);
  });

  it('READ_DETECTOR is case-insensitive on the ACTION keyword', () => {
    expect(READ_DETECTOR.test('action: Read("/tmp/foo.txt")')).toBe(true);
    expect(READ_DETECTOR.test('Action: read("/tmp/foo.txt")')).toBe(true);
  });

  it('INLINE_DETECTOR matches the respond_inline marker', () => {
    expect(INLINE_DETECTOR.test('ACTION: respond_inline')).toBe(true);
    expect(INLINE_DETECTOR.test('action: respond_inline')).toBe(true);
  });

  it('detectors do NOT match free-form prose mentioning Read or respond_inline', () => {
    // Anti-pattern 7 §1 defense: chain-of-thought "I should not call Read"
    // must NOT trigger the Read detector. The ACTION: prefix + parens
    // requirement isolates the contract from prose.
    expect(READ_DETECTOR.test('I should NOT call Read on this path.')).toBe(false);
    expect(READ_DETECTOR.test('Reading the preview tells me everything.')).toBe(false);
    expect(INLINE_DETECTOR.test('I will respond inline based on the preview.')).toBe(false);
  });
});
