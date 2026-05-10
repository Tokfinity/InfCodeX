/**
 * Hermetic shape tests for FEATURE_114 Slice 6 V2 baseline dataset.
 * Zero LLM cost. Locks down dataset invariants the eval relies on, plus
 * a drift guard against `worker-role-prompt.ts` (anchor-string parity).
 *
 * Mirrors `feature-151-fan-out-plan-granularity/cases.test.ts`.
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
  'plan_complete_emits_handoff',
  'multi_step_no_fanout_seeds_plan',
  'trivial_lookup_no_handoff',
];

describe('FEATURE_114 v0.7.36 V2 baseline dataset shape', () => {
  it('exports exactly 3 cases — 2 positive + 1 negative', () => {
    expect(CASES.length).toBe(3);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
    const positiveHandoff = CASES.filter((c) => c.expectHandoff);
    const positiveInit = CASES.filter((c) => c.expectInit);
    const negative = CASES.filter((c) => !c.expectHandoff && !c.expectInit);
    expect(positiveHandoff.length).toBe(1);
    expect(positiveInit.length).toBe(1);
    expect(negative.length).toBe(1);
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });

  it('multi-step positive case declares minItems ≥2', () => {
    const c = CASES.find((c) => c.id === 'multi_step_no_fanout_seeds_plan');
    expect(c?.minItems).toBeDefined();
    expect(c!.minItems!).toBeGreaterThanOrEqual(2);
  });

  it('cases other than multi-step do not declare minItems', () => {
    for (const c of CASES) {
      if (c.id === 'multi_step_no_fanout_seeds_plan') continue;
      expect(c.minItems).toBeUndefined();
    }
  });
});

describe('FEATURE_114 V2 baseline variants', () => {
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

      it('system prompt advertises EVALUATOR HANDOFF and PLAN-FIRST CONTRACT', () => {
        const [variant] = buildPromptVariants(caseId);
        // Both anchors must be present so the LLM has the surface to
        // pick the correct move under any of the 3 cases.
        expect(variant?.systemPrompt).toContain('EVALUATOR HANDOFF');
        expect(variant?.systemPrompt).toContain('PLAN-FIRST CONTRACT');
        expect(variant?.systemPrompt).toContain('emit_handoff');
        expect(variant?.systemPrompt).toContain('todo_update');
      });
    });
  }

  it('plan_complete_emits_handoff sets up prior conversation with completed plan', () => {
    const [variant] = buildPromptVariants('plan_complete_emits_handoff');
    expect(variant?.priorMessages?.length ?? 0).toBeGreaterThanOrEqual(4);
    // Last assistant turn in priorMessages should reflect the second item
    // having been completed via deterministic evaluator pass — that's the
    // signal the LLM uses to recognize "plan done".
    const priorText = variant?.priorMessages
      ?.map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(priorText).toContain('completed');
  });
});

describe('FEATURE_114 V2 baseline judges', () => {
  it('plan_complete_emits_handoff — pass when emit_handoff present', () => {
    const judges = buildJudges('plan_complete_emits_handoff');
    const result = judges[0]?.judge(
      'I will hand off now: emit_handoff({summary:"Validation added", artifacts:["packages/core/src/config.ts"]})',
    );
    expect(result?.passed).toBe(true);
  });

  it('plan_complete_emits_handoff — fail when emit_handoff absent', () => {
    const judges = buildJudges('plan_complete_emits_handoff');
    const result = judges[0]?.judge(
      'All items are done. The validation guard has been added successfully.',
    );
    expect(result?.passed).toBe(false);
  });

  it('multi_step_no_fanout_seeds_plan — pass on 2-item op:init without dispatch', () => {
    const judges = buildJudges('multi_step_no_fanout_seeds_plan');
    const sampleOutput = `todo_update({op:"init", items:[
      {id:"todo_1", content:"Read timeout.ts"},
      {id:"todo_2", content:"Add negative-timeout guard", evaluator:"build"}
    ]})`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on 2-item op:init without dispatch`,
      ).toBe(true);
    }
  });

  it('multi_step_no_fanout_seeds_plan — pass on numeric-id items (anti-pattern 7 fix)', () => {
    // Real models commonly emit `id:"1"`, `id:"2"` — the WORKED EXAMPLE
    // in the prompt uses `todo_1` style but most models default to bare
    // numbers. The original regex required the `todo_` prefix and
    // produced a false-negative across all 4 aliases on the first run
    // (ZERO pass on 60 calls). This pin keeps the relaxed regex from
    // regressing back to a strict prefix match.
    const judges = buildJudges('multi_step_no_fanout_seeds_plan');
    const sampleOutput = `todo_update({
  op: "init",
  items: [
    { id: "1", content: "Read withTimeout function" },
    { id: "2", content: "Add negative-timeout guard", evaluator: "build" }
  ]
})`;
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on numeric-id items`,
      ).toBe(true);
    }
  });

  it('multi_step_no_fanout_seeds_plan — fail when dispatch_child_task appears', () => {
    const judges = buildJudges('multi_step_no_fanout_seeds_plan');
    const sampleOutput = `todo_update({op:"init", items:[
      {id:"todo_1", content:"Read timeout.ts"},
      {id:"todo_2", content:"Add guard"}
    ]})

    dispatch_child_task({id:"c1", objective:"add guard", readOnly:false})`;
    const dispatchJudge = judges.find(
      (j) => j.name === 'does_not_mention_dispatch_child_task',
    );
    expect(dispatchJudge?.judge(sampleOutput).passed).toBe(false);
  });

  it('trivial_lookup_no_handoff — pass on direct read without plan/handoff', () => {
    const judges = buildJudges('trivial_lookup_no_handoff');
    const sampleOutput = 'read({path:"packages/core/src/config.ts", offset:42, limit:1})';
    for (const j of judges) {
      const result = j.judge(sampleOutput);
      expect(
        result.passed,
        `judge "${j.name}" should pass on direct read with no plan`,
      ).toBe(true);
    }
  });

  it('trivial_lookup_no_handoff — fail when emit_handoff appears', () => {
    const judges = buildJudges('trivial_lookup_no_handoff');
    const handoffJudge = judges.find((j) => j.name === 'does_not_emit_handoff');
    const result = handoffJudge?.judge(
      'emit_handoff({summary:"line 42 read", artifacts:[]})',
    );
    expect(result?.passed).toBe(false);
  });

  it('trivial_lookup_no_handoff — fail when todo_update / op:init appears', () => {
    const judges = buildJudges('trivial_lookup_no_handoff');
    const initJudge = judges.find((j) => j.name === 'does_not_call_op_init');
    expect(
      initJudge?.judge('todo_update({op:"init", items:[]})').passed,
    ).toBe(false);
  });
});

describe('FEATURE_114 V2 baseline drift guard — runtime prompt anchors', () => {
  // Layer 1 protection: if the runtime worker-role-prompt source removes the
  // anchor strings the eval depends on, fail here BEFORE spending money on
  // a Layer 2 run that would have measured a desynced prompt.
  // Path is relative to monorepo root (pwd at vitest run time).
  const RUNTIME_PROMPT_PATH = join(
    'packages',
    'coding',
    'src',
    'agents',
    'worker-role-prompt.ts',
  );

  it('runtime worker-role-prompt.ts contains EVALUATOR HANDOFF anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('EVALUATOR HANDOFF');
  });

  it('runtime worker-role-prompt.ts contains emit_handoff anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('emit_handoff');
  });

  it('runtime worker-role-prompt.ts contains PLAN-FIRST CONTRACT anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('PLAN-FIRST CONTRACT');
  });
});
