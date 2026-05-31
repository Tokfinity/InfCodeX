/**
 * Hermetic shape tests for FEATURE_114 Slice 8b Scout TRIVIAL-EXEMPTION
 * dataset. Zero LLM cost. Locks down dataset invariants the eval relies
 * on, plus a Layer 1 drift guard against the runtime Scout role-prompt.
 */

import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'single_step_lookup_no_emit',
  'two_file_investigation_emits',
  'explain_how_x_works_emits',
];

describe('FEATURE_114 Slice 8b Scout trivial-exemption dataset shape', () => {
  it('exports exactly 3 cases — 2 positive (expectEmit=true) + 1 negative', () => {
    expect(CASES.length).toBe(3);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
    const positive = CASES.filter((c) => c.expectEmit);
    const negative = CASES.filter((c) => !c.expectEmit);
    expect(positive.length).toBe(2);
    expect(negative.length).toBe(1);
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });

  it('positive cases declare a sensible minObligations (≥2)', () => {
    const positives = CASES.filter((c) => c.expectEmit);
    for (const c of positives) {
      expect(c.minObligations).toBeDefined();
      expect(c.minObligations!).toBeGreaterThanOrEqual(2);
    }
  });

  it('negative cases do not declare minObligations', () => {
    const negatives = CASES.filter((c) => !c.expectEmit);
    for (const c of negatives) {
      expect(c.minObligations).toBeUndefined();
    }
  });
});

describe('FEATURE_114 Slice 8b variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.38', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.38');
      });

      it('system + user prompts are non-empty', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt.length).toBeGreaterThan(50);
        expect(variant?.userMessage.length).toBeGreaterThan(20);
      });

      it('system prompt advertises EMIT TIMING and TRIVIAL-EXEMPTION anchors', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt).toContain('EMIT TIMING');
        expect(variant?.systemPrompt).toContain('TRIVIAL-EXEMPTION');
        expect(variant?.systemPrompt).toContain('emit_scout_verdict');
        expect(variant?.systemPrompt).toContain('executionObligations');
      });
    });
  }
});

describe('FEATURE_114 Slice 8b judges', () => {
  it('single_step_lookup_no_emit — pass when emit_scout_verdict absent', () => {
    const judges = buildJudges('single_step_lookup_no_emit');
    const result = judges[0]?.judge(
      'I will read line 42 of timeout.ts. read({path:"packages/core/src/timeout.ts", offset:42, limit:1})',
    );
    expect(result?.passed).toBe(true);
  });

  it('single_step_lookup_no_emit — fail when emit_scout_verdict present', () => {
    const judges = buildJudges('single_step_lookup_no_emit');
    const result = judges[0]?.judge(
      'emit_scout_verdict({confirmed_harness:"H0_DIRECT", ...})',
    );
    expect(result?.passed).toBe(false);
  });

  it('two_file_investigation_emits — pass when emit + ≥2 obligations present', () => {
    const judges = buildJudges('two_file_investigation_emits');
    const sampleOutput = `I will plan first.

emit_scout_verdict({
  confirmed_harness:"H0_DIRECT",
  summary:"Compare withTimeout impls",
  scope:["packages/core/src/timeout.ts","packages/agent/src/utils/timeout.ts"],
  review_files_or_areas:["packages/core","packages/agent"],
  executionObligations:[
    "Read packages/core/src/timeout.ts and note error handling, default timeout, cancellation",
    "Read packages/agent/src/utils/timeout.ts and note same dimensions"
  ]
})`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on emit + ≥2 obligations`,
      ).toBe(true);
    }
  });

  it('two_file_investigation_emits — pass on confirmed_harness without literal emit_scout_verdict (anti-pattern 7 fix)', () => {
    // Real models commonly emit the structured verdict as `## Scout Verdict`
    // markdown + JSON or `<emit_scout_verdict>` XML — without literally
    // typing the tool-name token inside a JSON block. The IDENTIFYING field
    // of the verdict is `confirmed_harness`; that's the unambiguous semantic
    // signal of "model committed the routing decision". Keep the relaxed
    // regex from regressing back to a strict literal-token match.
    const judges = buildJudges('two_file_investigation_emits');
    const sampleOutput = `## Scout Verdict

\`\`\`json
{
  "confirmed_harness": "H0_DIRECT",
  "summary": "Compare withTimeout implementations across two packages",
  "scope": ["packages/core/src/timeout.ts", "packages/agent/src/utils/timeout.ts"],
  "review_files_or_areas": [],
  "executionObligations": [
    "Read packages/core/src/timeout.ts to note error handling, default timeout, cancellation",
    "Read packages/agent/src/utils/timeout.ts and capture the same dimensions"
  ]
}
\`\`\``;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on confirmed_harness markdown form`,
      ).toBe(true);
    }
  });

  it('two_file_investigation_emits — pass on string-form executionObligations (anti-pattern 7 fix)', () => {
    // ds/v4pro emits inline string form ~30% of the time: a single
    // comma-separated string instead of a quoted-string array. Both shapes
    // carry the same ≥N obligation signal and must pass.
    const judges = buildJudges('two_file_investigation_emits');
    const sampleOutput = `<emit_scout_verdict>
  confirmed_harness="H0_DIRECT"
  summary="Compare withTimeout implementations"
  scope="packages/core/src/timeout.ts, packages/agent/src/utils/timeout.ts"
  executionObligations="Read packages/core/src/timeout.ts, Read packages/agent/src/utils/timeout.ts, Compare error handling and timeout defaults"
</emit_scout_verdict>`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on string-form executionObligations`,
      ).toBe(true);
    }
  });

  it('two_file_investigation_emits — fail when emit absent', () => {
    const judges = buildJudges('two_file_investigation_emits');
    const result = judges[0]?.judge(
      'I will read both files now. read({path:"packages/core/src/timeout.ts"})',
    );
    expect(result?.passed).toBe(false);
  });

  it('two_file_investigation_emits — fail when emit present but only 1 obligation', () => {
    const judges = buildJudges('two_file_investigation_emits');
    const sampleOutput = `emit_scout_verdict({
  confirmed_harness:"H0_DIRECT",
  executionObligations:["Read both files and compare"]
})`;
    const obligationsJudge = judges.find((j) =>
      j.name.includes('executionObligations'),
    );
    expect(obligationsJudge?.judge(sampleOutput).passed).toBe(false);
  });

  it('explain_how_x_works_emits — pass on emit + ≥2 obligations', () => {
    const judges = buildJudges('explain_how_x_works_emits');
    const sampleOutput = `emit_scout_verdict({
  confirmed_harness:"H0_DIRECT",
  summary:"Explain cache invalidation flow",
  executionObligations:[
    "Read cache emitter to find invalidation event source",
    "Read cache subscriber to find consumer and propagation"
  ]
})`;
    for (const j of judges) {
      expect(
        j.judge(sampleOutput).passed,
        `judge "${j.name}" should pass on cross-file explain emit`,
      ).toBe(true);
    }
  });
});

// RETIRED 2026-05-31 (v0.7.45) — the "runtime Scout role-prompt anchors" drift
// guard tested anchors (TRIVIAL-EXEMPTION / EMIT TIMING / executionObligations)
// in `_internal/managed-task/role-prompt.ts` that FEATURE_193 deleted in v0.7.43
// (`ef82e99c` — V1 prompts + emit-tools deletion, single-Worker cutover). The
// V1 Scout role no longer exists, so a source-side mirror of its prompt has
// nothing live to pin — the assertions were failing on deleted code, not real
// drift. The dataset-shape / variant / judge tests above are kept as-is. The
// broader FEATURE_114 Scout eval is orphaned by the V1 retirement and is a
// candidate for full removal in a later cleanup pass.
