/**
 * FEATURE_114 v0.7.36 — Worker role-prompt builder tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWorkerInstructions,
  isHarnessV2Enabled,
  WORKER_AGENT_NAME,
} from './worker-role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../types.js';

const baseDecision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'PLANNED route — V2',
  requiresBrainstorm: false,
};

describe('isHarnessV2Enabled', () => {
  beforeEach(() => {
    delete process.env.KODAX_HARNESS_V2;
  });
  afterEach(() => {
    delete process.env.KODAX_HARNESS_V2;
  });

  it('returns false by default (no env var set)', () => {
    expect(isHarnessV2Enabled()).toBe(false);
  });

  it('returns true when env is exactly "true"', () => {
    process.env.KODAX_HARNESS_V2 = 'true';
    expect(isHarnessV2Enabled()).toBe(true);
  });

  it('is case-insensitive — TRUE is also true', () => {
    process.env.KODAX_HARNESS_V2 = 'TRUE';
    expect(isHarnessV2Enabled()).toBe(true);
  });

  it('returns false for "1" / "yes" / other truthy-looking values', () => {
    for (const value of ['1', 'yes', 'on', 'enabled']) {
      process.env.KODAX_HARNESS_V2 = value;
      expect(isHarnessV2Enabled()).toBe(false);
    }
  });
});

describe('buildWorkerInstructions', () => {
  it('emits the plan-first contract section', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    expect(out).toContain('FIRST tool call MUST be `todo_update`');
  });

  it('emits the SCOPE COMMITMENT block (FEATURE_106 port)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('SCOPE COMMITMENT');
  });

  it('emits dispatch RULE A/B/C and Pattern B notes', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('RULE A');
    expect(out).toContain('RULE B');
    expect(out).toContain('RULE C');
    expect(out).toContain('Pattern B');
  });

  it('emits the FEATURE_148 anti-immediate-await rule', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).toContain('FEATURE_148');
    // Concrete user-facing rephrase that ties the rule to a real workflow:
    expect(out).toContain('dispatch X, then DO Y, then await X');
  });

  it('emits the Evaluator handoff section (structural gate preserved)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('EVALUATOR HANDOFF');
    expect(out).toContain('emit_handoff');
    expect(out).toContain('CANNOT bypass the Evaluator');
  });

  it('includes a revise-failure retrospective when flagged', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, true);
    expect(out).toContain('previous attempt at this task failed');
  });

  it('omits the retrospective when not a resume after revise', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('previous attempt at this task failed');
  });

  it('echoes the routing decision summary', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('Primary task: edit');
    expect(out).toContain('Risk: medium');
  });
});

describe('WORKER_AGENT_NAME', () => {
  it('is the canonical kebab-case identifier', () => {
    expect(WORKER_AGENT_NAME).toBe('kodax-worker');
  });
});
