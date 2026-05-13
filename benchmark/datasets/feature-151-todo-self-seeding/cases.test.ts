/**
 * Hermetic shape tests for FEATURE_151 prompt-behavior dataset.
 * Zero LLM cost. Locks down dataset invariants the eval relies on.
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'multi_step_audit_init',
  'rename_3_files_init',
  'trivial_typo_no_init',
  'info_request_no_init',
];

describe('FEATURE_151 todo-self-seeding dataset shape', () => {
  it('exports exactly 4 cases — 2 positive (expectInit=true) + 2 negative (expectInit=false)', () => {
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
});

describe('FEATURE_151 todo-self-seeding variants', () => {
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

      it('system prompt mentions op:init contract', () => {
        const [variant] = buildPromptVariants(caseId);
        // The system prompt must teach the LLM about op:'init' so the
        // eval is testing the role-prompt content, not vocabulary.
        expect(variant?.systemPrompt).toContain('op: "init"');
      });
    });
  }
});

describe('FEATURE_151 todo-self-seeding judges', () => {
  it('positive cases have judges that fail when op:init is absent', () => {
    const judges = buildJudges('multi_step_audit_init');
    expect(judges.length).toBeGreaterThan(0);
    // Probe: an output without op:'init' should fail the first judge.
    const result = judges[0]?.judge(
      "I'll start auditing packages/llm/ now. First I'll look at provider adapters...",
    );
    expect(result?.passed).toBe(false);
  });

  it('positive cases have judges that pass when op:init is present with enough items', () => {
    const judges = buildJudges('rename_3_files_init');
    expect(judges.length).toBeGreaterThan(0);
    const sampleOutput = `I'll commit a plan first.

todo_update({
  op: "init",
  items: [
    { id: "todo_1", content: "Locate getCwd in src/cli.ts", activeForm: "Locating in cli.ts" },
    { id: "todo_2", content: "Locate getCwd in src/utils.ts", activeForm: "Locating in utils.ts" },
    { id: "todo_3", content: "Locate getCwd in src/repl.ts", activeForm: "Locating in repl.ts" }
  ]
})`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(result.passed, `judge "${j.name}" should pass on multi-item op:init`).toBe(true);
    }
  });

  it('negative cases have judges that pass when op:init is absent', () => {
    const judges = buildJudges('info_request_no_init');
    const result = judges[0]?.judge(
      'The git status command shows the current state of your working directory and staging area.',
    );
    expect(result?.passed).toBe(true);
  });

  it('negative cases have judges that fail when op:init is present', () => {
    const judges = buildJudges('trivial_typo_no_init');
    const result = judges[0]?.judge(
      'todo_update({ op: "init", items: [{id: "todo_1", content: "Fix typo"}] })',
    );
    expect(result?.passed).toBe(false);
  });
});
