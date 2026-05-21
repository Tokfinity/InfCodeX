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
  // v0.7.39 Slice C3 — `KODAX_IDLE_YIELD` flag retired (idle-yield is
  // always-on). `await_child_task` was deleted in Slice C1, so the
  // OFF branch wording would point at a non-existent tool — the
  // prompt builder no longer emits it. These tests pin the steady-
  // state contract that survives the flag retirement.

  it('emits the plan-first contract section', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    // v0.7.42 — opening commit goes through a batch of `todo_create`
    // calls (claudecode V2 parity, no whole-list write surface).
    expect(out).toMatch(/FIRST tool calls MUST be a batch of `todo_create`/);
  });

  it('emits the SCOPE COMMITMENT block (FEATURE_106 port)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('SCOPE COMMITMENT');
  });

  it('emits dispatch RULE A/B/C', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('RULE A');
    expect(out).toContain('RULE B');
    expect(out).toContain('RULE C');
  });

  // FEATURE_177 v0.7.45 → REVERTED in v0.7.42 (commit TBD):
  // Worker prompt RULE D dropped after Layer 2 panel C5 kimi -60pp triggered
  // the pre-registered REVERT threshold (>20pp cross-case regression on RULE C
  // write fan-out). Runtime `task_output` tool stays ON for SDK consumers;
  // only the prompt teaching is dropped. Eval kept as permanent regression
  // sweep at tests/feature-177-task-output.eval.ts. Lesson recorded in
  // ADR (TBD) — claudecode-style qualitative dispatch prompt design.
  it('does NOT emit RULE D after FEATURE_177 REVERT', () => {
    delete process.env.KODAX_TASK_OUTPUT_PROMPT;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('RULE D');
    expect(out).not.toContain('task_output');
  });

  it('FEATURE_177 KODAX_TASK_OUTPUT_PROMPT env flag is no longer wired (REVERT)', () => {
    process.env.KODAX_TASK_OUTPUT_PROMPT = '1';
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('RULE D');
    expect(out).not.toContain('task_output');
    delete process.env.KODAX_TASK_OUTPUT_PROMPT;
  });

  it('does NOT emit the retired FEATURE_148 anti-immediate-await block (its target tool was deleted in Slice C1)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).not.toContain('FEATURE_148');
    expect(out).not.toContain('await_child_task');
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
    // Mechanical contract: ≥3 children → ONE todo_create per child's objective.
    expect(out).toContain('≥3 children');
    // v0.7.42 — wording shifted from "ONE item per child" (op:init items
    // array) to "ONE per child" (one todo_create call per child).
    expect(out).toMatch(/ONE (todo_create|item|per) /);
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

  // FEATURE_161 v0.7.41 — REPO INTELLIGENCE TOOLS section. Pin presence
  // of the section + the 8 pull-tool names + the "when to prefer" /
  // "when to stick with read/grep" branches. Eval-validated wording
  // (see tests/repointel-tool-adoption.eval.ts) — a future prompt edit
  // that drops any of these signals must re-run the panel eval.
  it('emits the REPO INTELLIGENCE TOOLS section (FEATURE_161)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('REPO INTELLIGENCE TOOLS');
    expect(out).toContain('FEATURE_161');
    // All 8 pull-tool names must be advertised by name.
    expect(out).toContain('`module_context');
    expect(out).toContain('`symbol_context');
    expect(out).toContain('`impact_estimate');
    expect(out).toContain('`process_context');
    expect(out).toContain('`repo_overview');
    expect(out).toContain('`changed_scope');
    expect(out).toContain('`changed_diff_bundle');
    expect(out).toContain('`changed_diff(');
    // Decision-aid branches (the "when to use what" structure that
    // moved 4/6 panel aliases from <80% to ≥80% pull-tool first-tool
    // selection — F7 lift is wording-dependent).
    expect(out).toContain('WHEN TO PREFER REPO-INTEL TOOLS');
    expect(out).toContain('WHEN TO STICK WITH read/grep');
  });

  it('orders REPO INTELLIGENCE TOOLS after MUTATION DISCIPLINE and before DISPATCH RULES', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    const mutationIdx = out.indexOf('MUTATION DISCIPLINE');
    const repoIntelIdx = out.indexOf('REPO INTELLIGENCE TOOLS');
    const dispatchIdx = out.indexOf('DISPATCH RULES');
    expect(mutationIdx).toBeGreaterThanOrEqual(0);
    expect(repoIntelIdx).toBeGreaterThan(mutationIdx);
    expect(dispatchIdx).toBeGreaterThan(repoIntelIdx);
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

// FEATURE_155 (v0.7.39 Slice C3) — idle-yield is always-on. The
// `KODAX_IDLE_YIELD` flag was retired alongside `await_child_task`
// (Slice C1) because there is no working "v0.7.38 emulation" path.
// These tests pin the always-on prompt contract so a future edit
// can't silently regress it.
describe('buildWorkerInstructions — FEATURE_155 idle-yield (always-on, Slice C3)', () => {
  it('dispatch section uses the idle-yield model', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('idle-yield model');
    expect(out).toContain('IDLE-YIELD (the wait mechanic)');
    expect(out).toContain('end your turn with ONE short status sentence and NO tool calls');
    expect(out).toContain('<task-completed task_id=');
  });

  it('does NOT mention await_child_task anywhere (tool was deleted in Slice C1)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('await_child_task');
  });

  it('FAN-OUT plan granularity guidance points in_progress trigger at dispatch_child_task', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('just before the corresponding `dispatch_child_task`');
    expect(out).toContain('<task-completed task_id="…">');
  });

  it('keeps the structural gates intact (PLAN-FIRST, SCOPE COMMITMENT, EVALUATOR HANDOFF, FAN-OUT PLAN GRANULARITY)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    expect(out).toContain('SCOPE COMMITMENT');
    expect(out).toContain('FAN-OUT PLAN GRANULARITY');
    expect(out).toContain('EVALUATOR HANDOFF');
  });
});

// FEATURE_120 v0.7.39 — Worker child steering. These tests pin the
// section that teaches the Worker when (and when NOT) to call
// `send_message` / `task_stop` and how to use the `model_hint` field
// on `dispatch_child_task`. The behavioral validation lives in
// `tests/child-steering.eval.ts` (Phase 5b); these are structural
// pins so a future prompt edit doesn't silently drop the section.
describe('buildWorkerInstructions — FEATURE_120 child steering (v0.7.39 Phase 5a)', () => {
  it('emits the ASYNC CHILD STEERING section with both tools', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('ASYNC CHILD STEERING');
    expect(out).toContain('FEATURE_120');
    expect(out).toContain('send_message(to=task_id');
    expect(out).toContain('task_stop(task_id');
  });

  it('teaches the spam guard (0-1 send_message per child) + atomic-tool semantics', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toMatch(/typical pattern is 0-1 send_message/i);
    // Atomic-tool semantics — no hard kill mid-run.
    expect(out).toMatch(/no hard kill of a 90s `npm test`/i);
  });

  it('explicit anti-patterns: do-not-chat with send_message, do-not-premature-stop', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toMatch(/DO NOT use it to chat with the child/);
    expect(out).toMatch(/DO NOT task_stop a child just because it is slow but progressing/);
  });

  it('points out the sync-mode no-op gate so the LLM does not retry on [Tool Error]', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toMatch(/sync-mode dispatch/);
    expect(out).toMatch(/KODAX_ASYNC_DISPATCH=0/);
  });

  it('teaches the model_hint field (no-op routing) so prompt-eval data accumulates', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('MODEL HINT');
    expect(out).toMatch(/"fast"/);
    expect(out).toMatch(/"deep"/);
    expect(out).toMatch(/no-op today/);
    expect(out).toMatch(/FEATURE_102/);
  });

  it('orders child steering after dispatch rules and before fan-out plan granularity', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    const dispatchIdx = out.indexOf('DISPATCH RULES');
    const steeringIdx = out.indexOf('ASYNC CHILD STEERING');
    const fanOutIdx = out.indexOf('FAN-OUT PLAN GRANULARITY');
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(steeringIdx).toBeGreaterThan(dispatchIdx);
    expect(fanOutIdx).toBeGreaterThan(steeringIdx);
  });
});

// FEATURE_121 v0.7.40 — Envelope spillover guidance. Pin the dispatch-
// rules bullet that teaches the Worker how to handle the spillover
// marker emitted by `applyToolResultGuardrail('child_task_summary', …)`
// when a child report exceeds the ~50KB inline envelope budget. This is
// the Layer 1 ($0) unit test per EVAL_GUIDELINES §三层实验金字塔; the
// behavioral validation lives in `tests/child-task-envelope-spillover.eval.ts`.
// FEATURE_170 v0.7.41 — Worker prompt teaches the per-item Todo V2 API
// (todo_create insert + todo_update patch/deleted/cancelled). Pin the
// 4-bullet split inside PLAN-FIRST CONTRACT + the late-discovered-child
// addendum inside FAN-OUT PLAN GRANULARITY + the SCOPE COMMITMENT
// rewording. These are structural pins; behavioral eval is gated on
// FEATURE_104 (release-time).
describe('buildWorkerInstructions — FEATURE_170 Todo V2 API (v0.7.41)', () => {
  it('teaches todo_create for mid-task insertion (NOT op:init)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('INSERT ONE NEW STEP mid-task: `todo_create');
    expect(out).toContain('FEATURE_170 v0.7.41');
    // v0.7.42 — the schema-split note + "purely additive" semantics is
    // the structural pin; op:'init' as a fan-out re-seed path is gone.
    expect(out).toMatch(/v0\.7\.42 schema split/);
    expect(out).toMatch(/purely additive/);
  });

  it('teaches todo_update patch fields without changing status', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('EDIT ONE STEP');
    // v0.7.42 — patch field list now includes subject (was content) +
    // description (new).
    expect(out).toContain('subject?, description?, activeForm?, evaluator?, metadata?');
  });

  it('teaches the deleted vs cancelled distinction', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('status:"deleted"');
    expect(out).toContain('status:"cancelled"');
    // The user-visible difference (breadcrumb vs no breadcrumb) is the
    // load-bearing signal that lets the LLM pick correctly.
    expect(out).toMatch(/no breadcrumb/);
    expect(out).toMatch(/STRIKETHROUGH ONE STEP \(keep visible breadcrumb\)/);
  });

  it('SCOPE COMMITMENT routes belated obligations through todo_create (not slip into a later step)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('SCOPE COMMITMENT');
    expect(out).toMatch(/call `todo_create.*to add the new item explicitly/);
  });

  it('FAN-OUT PLAN GRANULARITY teaches todo_create for the late N+1th child', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('LATE-DISCOVERED CHILD');
    // v0.7.42 — schema split: subject (required) + description (optional).
    expect(out).toContain('todo_create({subject:"..."');
    // Positive pin — late-discovered children go through additive todo_create.
    expect(out).toMatch(/todo_create.*BEFORE the new `dispatch_child_task`/);
  });

  it('revise-failure retrospective points new fundamentally-different steps at todo_create', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, true);
    expect(out).toContain('previous attempt at this task failed');
    expect(out).toMatch(/use `todo_create` to add the new step/);
  });
});

// v0.7.42 — Step 5: PLAN-LIST HYGIENE section teaches staleness refresh
// (todo_get before todo_update on uncertain items) + dedup (todo_list /
// throttle reminder scan before todo_create). Pinned here as structural
// assertions so later prompt edits cannot silently drop the guidance;
// behavioral eval lands in FEATURE_104 Layer 2 panel.
describe('buildWorkerInstructions — v0.7.42 plan-list hygiene (Step 5)', () => {
  it('teaches todo_get before todo_update for uncertain items (staleness guard)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-LIST HYGIENE');
    expect(out).toContain('staleness');
    expect(out).toMatch(/BEFORE `todo_update`.*call `todo_get/);
    // The "why" — auto-handlers flipping state between turns — is the
    // load-bearing rationale. Without it the model can argue "the patch
    // was idempotent so no harm done", which misses the no-op surprise.
    expect(out).toMatch(/auto-handlers can flip statuses between your turns/);
  });

  it('teaches dedup scan before todo_create (todo_list / throttle reminder)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('dedup');
    expect(out).toMatch(/BEFORE `todo_create`.*scan the existing plan list/);
    // The initial-batch exemption keeps the rule from blocking the
    // legitimate "first plan commitment on an empty list" case.
    expect(out).toMatch(/INITIAL PLAN COMMITMENT.*exempt from the dedup check/);
  });

  it('clarifies parent-vs-leaf is NOT a duplicate (avoids over-eager dedup)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // Without the heuristic the model may collapse legitimate per-step
    // leaves under a single parent label and lose progress granularity.
    expect(out).toMatch(/parent-level summary.*leaf/);
  });
});

describe('buildWorkerInstructions — FEATURE_121 envelope spillover (v0.7.40)', () => {
  it('emits the LARGE CHILD OUTPUT dispatch-rules bullet tagged with the feature/version', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('LARGE CHILD OUTPUT (FEATURE_121 v0.7.40)');
  });

  it('teaches the spillover marker shape so Worker can recognize it in `<task-completed>` blocks', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // The marker text mirrors `buildToolResultHint` for child_task_summary.
    expect(out).toContain('Tool output truncated');
    expect(out).toContain('Full output saved to:');
    expect(out).toContain('Use the Read tool to view full output');
  });

  it('teaches preview-first reading order (avoid blind spillover reads)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // Positive — preview-first.
    expect(out).toMatch(/preview is usually enough/i);
    expect(out).toMatch(/read it first/i);
    // Negative — explicit anti-pattern call-out.
    expect(out).toMatch(/Do NOT blindly Read every spillover path/);
    expect(out).toMatch(/wastes context/i);
  });

  it('lives inside the dispatch rules section (idle-yield context, not a standalone block)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    const dispatchIdx = out.indexOf('DISPATCH RULES');
    const spilloverIdx = out.indexOf('LARGE CHILD OUTPUT');
    const fanOutIdx = out.indexOf('FAN-OUT PLAN GRANULARITY');
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(spilloverIdx).toBeGreaterThan(dispatchIdx);
    // The spillover bullet belongs with the other dispatch RULEs — must
    // appear before the next major section (fan-out granularity).
    expect(spilloverIdx).toBeLessThan(fanOutIdx);
  });
});
