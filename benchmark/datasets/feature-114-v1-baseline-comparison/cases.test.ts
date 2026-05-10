/**
 * Hermetic shape tests for FEATURE_114 V1 baseline comparison dataset.
 * Zero LLM cost. Locks down dataset invariants + drift guard against
 * runtime Scout role-prompt source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from './cases.js';

describe('FEATURE_114 V1 baseline comparison dataset shape', () => {
  it('exports exactly 1 case (single-purpose Slice 7 decision input)', () => {
    expect(CASES.length).toBe(1);
    expect(CASES[0]?.id).toBe('multi_step_v1_scout');
  });

  it('has exactly one variant labelled v1-baseline', () => {
    const variants = buildPromptVariants('multi_step_v1_scout');
    expect(variants.length).toBe(1);
    expect(variants[0]?.id).toBe('v1-baseline');
  });

  it('user message matches Slice 6 multi_step_no_fanout_seeds_plan byte-for-byte', () => {
    const [variant] = buildPromptVariants('multi_step_v1_scout');
    // Apples-to-apples comparison requires identical user message — only
    // the system prompt should differ between V1 baseline and V2 Slice 6.
    expect(variant?.userMessage).toBe(
      'In `packages/core/src/timeout.ts`, find the function `withTimeout` ' +
        'and add a guard that throws if the timeout is negative. After the ' +
        'edit, run the build to verify the change typechecks. Plan first.',
    );
  });

  it('system prompt advertises V1 Scout anchors (QUALITY FRAMEWORK / EMIT TIMING)', () => {
    const [variant] = buildPromptVariants('multi_step_v1_scout');
    expect(variant?.systemPrompt).toContain('QUALITY FRAMEWORK');
    expect(variant?.systemPrompt).toContain('EMIT TIMING');
    expect(variant?.systemPrompt).toContain('emit_scout_verdict');
    expect(variant?.systemPrompt).toContain('executionObligations');
  });

  it('system prompt does NOT contain V2 Worker anchors (ensures clean V1 isolation)', () => {
    const [variant] = buildPromptVariants('multi_step_v1_scout');
    // The whole point of this dataset is to test V1 path in isolation —
    // accidentally leaking V2 Worker text would invalidate the
    // comparison. Pin the absence of V2-specific section headings.
    expect(variant?.systemPrompt).not.toContain('PLAN-FIRST CONTRACT (FEATURE_114');
    expect(variant?.systemPrompt).not.toContain('EVALUATOR HANDOFF');
    expect(variant?.systemPrompt).not.toContain('You are the Worker');
  });
});

describe('FEATURE_114 V1 baseline comparison judges', () => {
  it('passes when emit_scout_verdict + ≥2 obligations present', () => {
    const judges = buildJudges('multi_step_v1_scout');
    const sampleOutput = `emit_scout_verdict({
      confirmed_harness:"H0_DIRECT",
      summary:"add negative-timeout guard + verify build",
      scope:["packages/core/src/timeout.ts"],
      executionObligations:[
        "Add negative-timeout guard at withTimeout entry",
        "Run build to verify the change typechecks"
      ]
    })`;
    for (const j of judges) {
      expect(j.judge(sampleOutput).passed).toBe(true);
    }
  });

  it('passes on confirmed_harness markdown form (anti-pattern 7 fix)', () => {
    const judges = buildJudges('multi_step_v1_scout');
    const sampleOutput = `## Scout Verdict
\`\`\`json
{
  "confirmed_harness": "H0_DIRECT",
  "executionObligations": [
    "Add negative-timeout guard at withTimeout entry",
    "Run build to verify the change typechecks"
  ]
}
\`\`\``;
    for (const j of judges) {
      expect(j.judge(sampleOutput).passed).toBe(true);
    }
  });

  it('fails when verdict absent', () => {
    const judges = buildJudges('multi_step_v1_scout');
    const result = judges[0]?.judge(
      'I will plan first. Step 1: add the guard. Step 2: run build.',
    );
    expect(result?.passed).toBe(false);
  });
});

describe('FEATURE_114 V1 baseline comparison drift guard — runtime Scout anchors', () => {
  // Layer 1 protection — fail BEFORE spending money if the V1 Scout
  // role-prompt source has been renamed / removed since this snapshot
  // was taken.
  const RUNTIME_PROMPT_PATH = join(
    'packages',
    'coding',
    'src',
    'task-engine',
    '_internal',
    'managed-task',
    'role-prompt.ts',
  );

  it('runtime role-prompt.ts contains QUALITY FRAMEWORK anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('QUALITY FRAMEWORK');
  });

  it('runtime role-prompt.ts contains EMIT TIMING anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('EMIT TIMING');
  });

  it('runtime role-prompt.ts contains emit_scout_verdict anchor', () => {
    const source = readFileSync(RUNTIME_PROMPT_PATH, 'utf8');
    expect(source).toContain('emit_scout_verdict');
  });
});
