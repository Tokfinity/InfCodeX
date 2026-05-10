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

describe('isHarnessV2Enabled (v0.7.38 Slice 7 — V2 is now default)', () => {
  beforeEach(() => {
    delete process.env.KODAX_HARNESS_V2;
  });
  afterEach(() => {
    delete process.env.KODAX_HARNESS_V2;
  });

  it('returns true by default (no env var set) — V2 is the default in v0.7.38+', () => {
    expect(isHarnessV2Enabled()).toBe(true);
  });

  it('returns false ONLY when env is exactly "false" (V1 opt-out)', () => {
    process.env.KODAX_HARNESS_V2 = 'false';
    expect(isHarnessV2Enabled()).toBe(false);
  });

  it('opt-out is case-insensitive — FALSE / False also disable V2', () => {
    for (const value of ['FALSE', 'False']) {
      process.env.KODAX_HARNESS_V2 = value;
      expect(isHarnessV2Enabled()).toBe(false);
    }
  });

  it('returns true for "true" / "TRUE" / "1" / "yes" — anything other than "false" leaves V2 active', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'enabled', '']) {
      process.env.KODAX_HARNESS_V2 = value;
      expect(isHarnessV2Enabled()).toBe(true);
    }
  });
});

describe('buildWorkerInstructions', () => {
  // v0.7.39 Slice B1.D — default flipped. The tests in this block
  // pin baseline structure that holds in BOTH branches (PLAN-FIRST
  // / SCOPE COMMITMENT / RULE A-C / EVALUATOR HANDOFF / FAN-OUT
  // PLAN GRANULARITY / routing-decision echo). Branch-specific
  // wording (Pattern B vs IDLE-YIELD, FEATURE_148 anti-await vs
  // idle-yield deprecation note) is covered by the dedicated
  // `FEATURE_155 idle-yield gating` describe below — this block
  // only asserts what's invariant across both flag values.
  let prevIdleYield: string | undefined;
  beforeEach(() => {
    prevIdleYield = process.env.KODAX_IDLE_YIELD;
  });
  afterEach(() => {
    if (prevIdleYield === undefined) delete process.env.KODAX_IDLE_YIELD;
    else process.env.KODAX_IDLE_YIELD = prevIdleYield;
  });

  it('emits the plan-first contract section', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    expect(out).toContain('FIRST tool call MUST be `todo_update`');
  });

  it('emits the SCOPE COMMITMENT block (FEATURE_106 port)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('SCOPE COMMITMENT');
  });

  it('emits dispatch RULE A/B/C in either flag branch (idle-yield default keeps RULE A-C)', () => {
    // Default (idle-yield ON since v0.7.39 Slice B1.D).
    delete process.env.KODAX_IDLE_YIELD;
    const onOut = buildWorkerInstructions(baseDecision, undefined, false);
    expect(onOut).toContain('RULE A');
    expect(onOut).toContain('RULE B');
    expect(onOut).toContain('RULE C');
    // Explicit opt-out — legacy v0.7.38 wording with Pattern B note.
    process.env.KODAX_IDLE_YIELD = 'false';
    const offOut = buildWorkerInstructions(baseDecision, undefined, false);
    expect(offOut).toContain('RULE A');
    expect(offOut).toContain('RULE B');
    expect(offOut).toContain('RULE C');
    expect(offOut).toContain('Pattern B');
  });

  it('emits the FEATURE_148 anti-immediate-await rule on the legacy opt-out path only', () => {
    // FEATURE_148 anti-pattern is retired in the idle-yield default;
    // it survives only on the explicit opt-out path so users on
    // KODAX_IDLE_YIELD=false still see the v0.7.38 guidance.
    process.env.KODAX_IDLE_YIELD = 'false';
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).toContain('FEATURE_148');
    expect(out).toContain('dispatch X, then DO Y, then await X');
  });

  it('emits the Evaluator handoff section (structural gate preserved)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('EVALUATOR HANDOFF');
    expect(out).toContain('emit_handoff');
    expect(out).toContain('CANNOT bypass the Evaluator');
  });

  // FEATURE_151 Slice I (v0.7.38) — fan-out plan granularity guidance.
  // Pin presence of the section + its key signals so a future prompt edit
  // doesn't silently drop the fan-out → N-item-per-child contract that
  // closes the review fan-out visibility gap.
  it('emits the FAN-OUT PLAN GRANULARITY section (Slice I)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('FAN-OUT PLAN GRANULARITY');
    expect(out).toContain('FEATURE_151 Slice I');
    // Mechanical contract: ≥3 children → ONE item per child's objective.
    expect(out).toContain('≥3 children');
    expect(out).toContain('ONE item per child');
    // Anti-pattern call-out — plan list IS the user's progress dashboard.
    expect(out).toContain('plan list IS the user');
    // Tied to dispatch RULE A / RULE C (same trigger surface).
    expect(out).toMatch(/RULE A or RULE C/);
  });

  it('orders Slice I after dispatch rules and before Evaluator handoff', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    const dispatchIdx = out.indexOf('DISPATCH RULES');
    const fanOutIdx = out.indexOf('FAN-OUT PLAN GRANULARITY');
    const handoffIdx = out.indexOf('EVALUATOR HANDOFF');
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(fanOutIdx).toBeGreaterThan(dispatchIdx);
    expect(handoffIdx).toBeGreaterThan(fanOutIdx);
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

// FEATURE_155 (v0.7.39 Slice B1) — idle-yield prompt gating. Default
// is now ON (Slice B1.D) after the Layer 2 eval SHIP gate hit
// (≥3/5 aliases ≥80% adoption). KODAX_IDLE_YIELD=false reverts the
// prompt + banner to the v0.7.38 byte-equivalent wording. Pin both
// branches so a future edit can't silently drop a contract from
// either path.
describe('buildWorkerInstructions — FEATURE_155 idle-yield gating', () => {
  let prevIdleYield: string | undefined;
  beforeEach(() => {
    prevIdleYield = process.env.KODAX_IDLE_YIELD;
  });
  afterEach(() => {
    if (prevIdleYield === undefined) delete process.env.KODAX_IDLE_YIELD;
    else process.env.KODAX_IDLE_YIELD = prevIdleYield;
  });

  it('opt-out (KODAX_IDLE_YIELD=false): emits the FEATURE_148 anti-immediate-await block + the legacy await_child_task wording', () => {
    process.env.KODAX_IDLE_YIELD = 'false';
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('await_child_task');
    expect(out).toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).toContain('FEATURE_148');
    expect(out).not.toContain('IDLE-YIELD');
  });

  it('default (idle-yield ON): dispatch section uses the idle-yield model and the FEATURE_148 anti-await block is retired', () => {
    delete process.env.KODAX_IDLE_YIELD;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('idle-yield model');
    expect(out).toContain('IDLE-YIELD (preferred wait mechanic)');
    expect(out).toContain('end your turn with ONE short status sentence and NO tool calls');
    expect(out).toContain('<task-completed task_id=');
    // FEATURE_148 anti-pattern is gone under idle-yield.
    expect(out).not.toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).not.toContain('FEATURE_148');
    // Explicit deprecation of await_child_task.
    expect(out).toContain('DO NOT call `await_child_task` to wait');
  });

  it('default (idle-yield ON): FAN-OUT plan granularity guidance points in_progress trigger at dispatch_child_task, not await_child_task', () => {
    delete process.env.KODAX_IDLE_YIELD;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('just before the corresponding `dispatch_child_task`');
    expect(out).not.toContain('just before the corresponding `await_child_task`');
    expect(out).toContain('<task-completed task_id="…">');
  });

  it('opt-out: FAN-OUT plan granularity guidance retains the await_child_task in_progress trigger', () => {
    process.env.KODAX_IDLE_YIELD = 'false';
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('just before the corresponding `await_child_task`');
  });

  it('default (idle-yield ON): dispatch RULE B no longer says "Reclaim with await_child_task" (idle-yield handles waits)', () => {
    delete process.env.KODAX_IDLE_YIELD;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('RULE B');
    expect(out).not.toContain('Reclaim the result with `await_child_task');
  });

  it('default (idle-yield ON) keeps the structural gates intact (PLAN-FIRST, SCOPE COMMITMENT, EVALUATOR HANDOFF, FAN-OUT PLAN GRANULARITY)', () => {
    delete process.env.KODAX_IDLE_YIELD;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    expect(out).toContain('SCOPE COMMITMENT');
    expect(out).toContain('FAN-OUT PLAN GRANULARITY');
    expect(out).toContain('EVALUATOR HANDOFF');
  });
});
