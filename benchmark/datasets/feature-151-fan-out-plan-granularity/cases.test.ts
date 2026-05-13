/**
 * Hermetic shape tests for FEATURE_151 Slice I (v0.7.38) fan-out plan
 * granularity dataset. Zero LLM cost. Locks down dataset invariants the
 * eval relies on — mirrors `feature-151-todo-self-seeding/cases.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'review_3_modules',
  'audit_5_packages',
  'single_lookup',
  'single_grep',
];

describe('FEATURE_151 Slice I fan-out-plan-granularity dataset shape', () => {
  it('exports exactly 4 cases — 2 positive (expectInit=true) + 2 negative', () => {
    expect(CASES.length).toBe(4);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
    const positive = CASES.filter((c) => c.expectInit);
    const negative = CASES.filter((c) => !c.expectInit);
    expect(positive.length).toBe(2);
    expect(negative.length).toBe(2);
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });

  it('positive cases declare a sensible minItems (≥3 per design)', () => {
    const positives = CASES.filter((c) => c.expectInit);
    for (const c of positives) {
      expect(c.minItems).toBeDefined();
      expect(c.minItems!).toBeGreaterThanOrEqual(3);
    }
  });

  it('negative cases do not declare minItems', () => {
    const negatives = CASES.filter((c) => !c.expectInit);
    for (const c of negatives) {
      expect(c.minItems).toBeUndefined();
    }
  });
});

describe('FEATURE_151 Slice I variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.38', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.38');
      });

      it('system + user prompts are non-empty and well-formed', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt.length).toBeGreaterThan(50);
        expect(variant?.userMessage.length).toBeGreaterThan(20);
      });

      it('system prompt mentions FAN-OUT PLAN GRANULARITY contract', () => {
        const [variant] = buildPromptVariants(caseId);
        // The system prompt must contain the section under test, otherwise
        // the eval would only validate the baseline plan-first contract,
        // not Slice I specifically.
        expect(variant?.systemPrompt).toContain('FAN-OUT PLAN GRANULARITY');
        expect(variant?.systemPrompt).toContain('ONE item per child');
      });

      it('system prompt documents the dispatch_child_task tool', () => {
        const [variant] = buildPromptVariants(caseId);
        // Tool documentation must be present so the LLM has the option
        // surface needed to choose fan-out at all.
        expect(variant?.systemPrompt).toContain('dispatch_child_task');
        expect(variant?.systemPrompt).toContain('todo_update');
      });
    });
  }
});

describe('FEATURE_151 Slice I judges', () => {
  it('positive cases — judges fail when op:init is absent', () => {
    const judges = buildJudges('review_3_modules');
    expect(judges.length).toBeGreaterThan(0);
    const result = judges[0]?.judge(
      "I'll start dispatching child agents for each package. First, packages/llm...",
    );
    expect(result?.passed).toBe(false);
  });

  it('positive cases — judges pass when op:init present with enough items', () => {
    const judges = buildJudges('audit_5_packages');
    expect(judges.length).toBeGreaterThan(0);
    const sampleOutput = `I'll commit a 5-item plan first, then dispatch.

todo_update({
  op: "init",
  items: [
    { id: "todo_1", content: "Audit packages/llm", activeForm: "Auditing packages/llm" },
    { id: "todo_2", content: "Audit packages/agent", activeForm: "Auditing packages/agent" },
    { id: "todo_3", content: "Audit packages/coding", activeForm: "Auditing packages/coding" },
    { id: "todo_4", content: "Audit packages/repl", activeForm: "Auditing packages/repl" },
    { id: "todo_5", content: "Audit packages/skills", activeForm: "Auditing packages/skills" }
  ]
})`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on 5-item op:init`,
      ).toBe(true);
    }
  });

  it('positive cases — fewer-than-minItems triggers fail on the count judge', () => {
    const judges = buildJudges('audit_5_packages');
    // Only 3 items in op:init, but min is 5 for audit_5_packages.
    const sampleOutput = `todo_update({
  op: "init",
  items: [
    { id: "todo_1", content: "Audit one" },
    { id: "todo_2", content: "Audit two" },
    { id: "todo_3", content: "Audit three" }
  ]
})`;
    // First judge (mentions_op_init) should still pass.
    expect(judges[0]?.judge(sampleOutput).passed).toBe(true);
    // Second judge (mentions_at_least_5_items) should fail.
    expect(judges[1]?.judge(sampleOutput).passed).toBe(false);
  });

  it('negative cases — judges pass when op:init is absent', () => {
    const judges = buildJudges('single_lookup');
    const result = judges[0]?.judge(
      'I\'ll grep for getCwd in src/. ```\ngrep -rn "getCwd" src/\n```',
    );
    expect(result?.passed).toBe(true);
  });

  it('negative cases — judges fail when op:init present on trivial task', () => {
    const judges = buildJudges('single_grep');
    const result = judges[0]?.judge(
      'todo_update({ op: "init", items: [{id: "todo_1", content: "Grep for TODO"}] })',
    );
    expect(result?.passed).toBe(false);
  });
});
