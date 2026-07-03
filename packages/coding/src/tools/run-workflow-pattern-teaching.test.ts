import { describe, expect, it } from 'vitest';

import { getToolDefinition } from './index.js';
import { buildWorkflowGenerationUserPrompt } from '../workflows/generator.js';

/**
 * FEATURE_246 — run_workflow pattern-COMBINATION teaching (Layer 1 structural guard).
 *
 * Behaviour taught: when AUTHORING a review/audit workflow, combine
 * fan-out-and-synthesize with adversarial-verification (a find -> verify
 * pipeline) instead of declaring a single pattern and verifying in a separate
 * pass. A dogfood /workflow review authored a single pattern then re-audited via
 * a separate dispatch_child_task; root cause was that the old description's
 * find->verify line was a bare API hint with no review framing.
 *
 * Why Layer 1, not a Layer 2 behavioural probe (per benchmark/EVAL_GUIDELINES.md
 * three-layer pyramid + cost discipline): eliciting the authored manifest needs
 * the model to actually emit run_workflow, but authoring requires scouting real
 * files first (scout-then-author — which the run_workflow description itself
 * mandates). Pilots on ark/v4flash AND ark/v4pro confirmed both re-scout the
 * filesystem (read/glob) rather than author from in-context scope, so a
 * single-turn probe cannot observe manifest.patterns. A faithful behavioural test
 * is Layer 3 (multi-turn against a real repo — anti-pattern 2 territory) and its
 * cost is not justified for an additive, low-risk teaching that removes nothing.
 * This test guards the teaching from silently regressing (reworded / dropped).
 */
describe('run_workflow pattern-combination teaching (review find->verify)', () => {
  it('Edit 1: run_workflow description teaches the review/audit find->verify combination', () => {
    const def = getToolDefinition('run_workflow');
    expect(def, 'run_workflow must be registered').toBeDefined();
    const description = def!.description;
    // Names the task category, both pattern ids, and the verify step.
    expect(description).toContain('review or audit');
    expect(description).toContain('fan-out-and-synthesize');
    expect(description).toContain('adversarial-verification');
    expect(description.toLowerCase()).toMatch(/verifier|verify|refute/);
    // Teaches declaring BOTH patterns together (multi-value patterns[]).
    expect(description).toMatch(/\['fan-out-and-synthesize',\s*'adversarial-verification'\]/);
    // Teaches the GENERAL composition principle, not only the review instance.
    expect(description.toLowerCase()).toMatch(/more than one|chain/);
  });

  it('teaches reading a declared outputSchema off result.structured, never the top-level result', () => {
    // Regression: an AMAW-authored reviewer panel declared outputSchema but read
    // result.summary/result.findings off the top-level result (undefined → empty
    // findings). The description must point declared fields at result.structured
    // and name the failure of reading them off the top-level result (ADR-033 §3 WHY).
    const def = getToolDefinition('run_workflow');
    const description = def!.description;
    expect(description).toContain('result.structured');
    expect(description).toContain('read your declared fields off result.structured');
    expect(description).toContain('never off the top-level result');
    expect(description.toLowerCase()).toMatch(/empty report|undefined/);
  });

  it('Edit 2: generator pattern guidance includes the review/audit combination bullet with a WHY', () => {
    const prompt = buildWorkflowGenerationUserPrompt('review the recent changes');
    expect(prompt).toContain('review or audit combines fan-out-and-synthesize with adversarial-verification');
    // ADR-033 §3: the anti-pattern bullet must carry its failure-mode WHY.
    expect(prompt.toLowerCase()).toMatch(/blind spot|refute it before synthesis/);
  });

  it('teaches the judgment clauses matched from Claude Code Workflow (T1/T2/T3/T8/T9/T13)', () => {
    const d = getToolDefinition('run_workflow')!.description.toLowerCase();
    expect(d, 'T1 pipeline-by-default / barrier discipline').toMatch(/as a barrier only when/);
    expect(d, 'T2 majority-refute threshold').toContain('majority cannot refute');
    expect(d, 'T3 distinct failure-mode angle per verifier').toContain('distinct failure-mode angle');
    expect(d, 'T9 scale fan-out to the request').toContain('match the effort to the request');
    expect(d, 'T8 no silent caps (with WHY)').toMatch(/silent cap/);
    expect(d, 'T13 named single-phase shapes').toContain('single-phase shapes');
  });
});
