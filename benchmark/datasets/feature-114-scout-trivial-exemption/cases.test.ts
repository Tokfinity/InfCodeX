/**
 * Hermetic shape tests for FEATURE_114 Slice 8b Scout TRIVIAL-EXEMPTION
 * dataset. Zero LLM cost. Locks down dataset invariants the eval relies
 * on, plus a Layer 1 drift guard against the runtime Scout role-prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('FEATURE_114 Slice 8b drift guard — runtime Scout role-prompt anchors', () => {
  // Layer 1 protection: if the runtime Scout role-prompt source removes or
  // renames the anchor strings the eval depends on, fail here BEFORE
  // spending money on a Layer 2 run that would have measured a desynced
  // prompt. Slice 8a's role-prompt.test.ts already pins the exact wording
  // line-by-line; this is the dataset-side mirror so the eval-snapshot
  // and the source stay tied.
  const RUNTIME_PROMPT_PATH = join(
    'packages',
    'coding',
    'src',
    'task-engine',
    '_internal',
    'managed-task',
    'role-prompt.ts',
  );

  it('runtime role-prompt.ts contains TRIVIAL-EXEMPTION anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('TRIVIAL-EXEMPTION');
  });

  it('runtime role-prompt.ts contains EMIT TIMING anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('EMIT TIMING');
  });

  it('runtime role-prompt.ts contains emit_scout_verdict anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('emit_scout_verdict');
  });

  it('runtime role-prompt.ts contains executionObligations anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('executionObligations');
  });
});
