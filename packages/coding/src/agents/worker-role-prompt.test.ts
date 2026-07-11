/**
 * FEATURE_114 v0.7.36 — Worker role-prompt builder tests.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkerInstructions,
  WORKER_AGENT_NAME,
} from './worker-role-prompt.js';
// FEATURE_193 v0.7.43: isHarnessV2Enabled import removed (V1 flag retired)
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

// FEATURE_193 v0.7.43: isHarnessV2Enabled describe block deleted (V1 flag retired — V2 is always default)

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

  // FEATURE_188 v0.7.42 (ADR-034 + ADR-033 §1) — dispatch rules use
  // qualitative criteria instead of quantitative thresholds. Pin the
  // post-conversion wording + assert the pre-conversion thresholds are
  // gone, so a future revert is loud.
  it('dispatchRules use qualitative wording (no quantitative thresholds in RULE A/B/C)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // Positive: post-FEATURE_188 qualitative wording present.
    expect(out).toContain('multiple independent investigations');
    expect(out).toContain('a while');
    expect(out).toContain('multiple modules');
    // Negative: pre-FEATURE_188 thresholds are gone from RULE A/B/C.
    expect(out).not.toContain('≥3 independent investigations');
    expect(out).not.toContain('≥45 seconds');
    expect(out).not.toContain('≥3 modules');
  });

  // FEATURE_188 v0.7.42 — RULE C dropped the "Worktrees are isolated;
  // merge happens at Evaluator review time" sentence. After FEATURE_184
  // (ADR-030) deleted the Evaluator role and FEATURE_188 (ADR-034) dropped
  // the auto-worktree, that sentence was a false reassurance.
  it('RULE C does NOT claim Worktree isolation (Evaluator + auto-worktree dropped)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('Worktrees are isolated');
    expect(out).not.toContain('Evaluator review time');
  });

  // FEATURE_177 v0.7.45 → REVERTED in v0.7.42 (commit TBD):
  // Worker prompt RULE D dropped after Layer 2 panel C5 kimi -60pp triggered
  // the pre-registered REVERT threshold (>20pp cross-case regression on RULE C
  // write fan-out). Runtime `task_output` tool stays ON for SDK consumers;
  // only the prompt teaching is dropped. Eval kept as permanent regression
  // sweep at tests/feature-177-task-output.eval.ts. Lesson recorded in
  // ADR (TBD) — claudecode-style qualitative dispatch prompt design.
  it('does NOT emit RULE D after FEATURE_177 REVERT (task_output only appears as anti-misuse guidance)', () => {
    delete process.env.KODAX_TASK_OUTPUT_PROMPT;
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('RULE D');
    // Issue 144 (v0.7.57): `task_output` IS now referenced — but only to
    // forbid `block:true` misuse and scope it to `block:false` decisions,
    // never re-taught as a proactive RULE-D peek/poll pattern (which had
    // regressed RULE C write fan-out). Pin the framing so a future edit
    // cannot smuggle RULE D back under a different name.
    expect(out).toContain('WAITING IS IDLE-YIELD, NOT A BLOCKING PEEK');
    expect(out).not.toMatch(/use\s+`?task_output`?\s+to\s+(peek|poll)/i);
  });

  it('FEATURE_191 A.4: dispatchRules emits SPECIALIST ROUTING guidance as the last bullet (qualitative, no enumerated names)', () => {
    // ADR-035 R14 hard constraint — A.4 must append at the end of the
    // dispatchRules array (not insert mid-array) to avoid mid-tier
    // model attention-anchor regressions per the FEATURE_189 B.5 DEFER
    // lesson. The sentence must be qualitative single-concept per
    // ADR-033 §1 / §2 / §3 / §4 / §5: no enumerated agent names, no ✗
    // anti-pattern, no FEATURE_xxx version tag in LLM-facing surface.
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('SPECIALIST ROUTING');
    expect(out).toContain('subagent_type=<name>');
    expect(out).toContain('registered specialist');

    // ADR-033 §1 — no enumerated agent names in the sentence
    expect(out).not.toMatch(/SPECIALIST ROUTING[^\n]*db-reviewer/);
    expect(out).not.toMatch(/SPECIALIST ROUTING[^\n]*e2e-runner/);
    expect(out).not.toMatch(/SPECIALIST ROUTING[^\n]*python-reviewer/);

    // ADR-033 §3 — no ✗ anti-pattern in this sentence
    const specialistLineMatch = out.match(/-\s*SPECIALIST ROUTING:[^\n]*/);
    expect(specialistLineMatch).not.toBeNull();
    expect(specialistLineMatch![0]).not.toContain('✗');

    // ADR-033 §5 — no version tag (FEATURE_xxx vX.Y.Z) in the sentence
    expect(specialistLineMatch![0]).not.toMatch(/FEATURE_\d+/);

    // Position constraint — appears AFTER the impact_estimate bullet
    // (last pre-existing dispatchRules element).
    const impactIdx = out.indexOf('impact_estimate');
    const specialistIdx = out.indexOf('SPECIALIST ROUTING');
    expect(impactIdx).toBeGreaterThan(-1);
    expect(specialistIdx).toBeGreaterThan(impactIdx);
  });

  it('FEATURE_177 KODAX_TASK_OUTPUT_PROMPT env flag is no longer wired (REVERT)', () => {
    process.env.KODAX_TASK_OUTPUT_PROMPT = '1';
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // Flag has no effect: no RULE D regardless of the flag. The only
    // task_output reference is the Issue 144 anti-block-peek rule, not a
    // flag-gated proactive peek teaching.
    expect(out).not.toContain('RULE D');
    expect(out).not.toMatch(/use\s+`?task_output`?\s+to\s+(peek|poll)/i);
    delete process.env.KODAX_TASK_OUTPUT_PROMPT;
  });

  it('does NOT emit the retired FEATURE_148 anti-immediate-await block (its target tool was deleted in Slice C1)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('DO NOT IMMEDIATELY AWAIT');
    expect(out).not.toContain('FEATURE_148');
    expect(out).not.toContain('await_child_task');
  });

  it('emits the TERMINATION section (text-only canonical exit, post-F190)', () => {
    // FEATURE_190 (v0.7.43) replaced the legacy EVALUATOR HANDOFF block
    // with positive text-only termination guidance. F184 v0.7.45 retired
    // the in-chain Evaluator; the Sidecar Verifier Stop-hook now runs
    // out-of-band and the Worker terminates by simply omitting tool_use
    // on its final assistant message.
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('TERMINATION');
    expect(out).toContain('text-only summary');
    expect(out).toContain('Sidecar Verifier');
    // Regression pins — these must NOT appear post-F190:
    expect(out).not.toContain('EVALUATOR HANDOFF');
    expect(out).not.toContain('CANNOT bypass the Evaluator');
    expect(out).not.toContain('emit_handoff');
  });

  // FAN-OUT PLAN GRANULARITY — claudecode-style 3-bullet rewrite
  // (FEATURE_188 ADR-033 hygiene continuation, v0.7.42 judge-validated).
  // Panel `tests/feature-plan-first-claudecode.eval.ts` (5 alias × 2 case
  // × 3 variant × 5 runs = 150 cells + 900 audit calls) showed C4
  // baseline 18-line block 0/25 dispatch vs 3-bullet 7/25 dispatch
  // (judge view). 57% character reduction, all 5 ADR-033 principles
  // applied. Pin the 3 load-bearing signals so future edits can't drop
  // them silently — but no enumerated label or worked-example assertions
  // (those are exactly what ADR-033 §4 / §5 say should NOT be pinned).
  it('emits the FAN-OUT PLAN GRANULARITY section (claudecode 3-bullet)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('FAN-OUT PLAN GRANULARITY');
    // Qualitative trigger (no quantitative threshold per ADR-033 §1).
    expect(out).toMatch(/several children in parallel/);
    // One-todo-per-child contract (qualitative single-sentence per ADR-033 §2).
    expect(out).toContain('One todo per child');
    // Status transition: in_progress on dispatch, completed on task-completed.
    expect(out).toContain('in_progress');
    expect(out).toContain('<task-completed>');
    // Late-discovered-child handling (no LATE-DISCOVERED CHILD label per ADR-033 §4).
    expect(out).toMatch(/mid fan-out|another child/);
  });

  it('orders Slice I after dispatch rules and before TERMINATION (post-F190)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    const dispatchIdx = out.indexOf('DISPATCH RULES');
    const fanOutIdx = out.indexOf('FAN-OUT PLAN GRANULARITY');
    const terminationIdx = out.indexOf('TERMINATION');
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(fanOutIdx).toBeGreaterThan(dispatchIdx);
    expect(terminationIdx).toBeGreaterThan(fanOutIdx);
  });

  // FEATURE_161 v0.7.41 — REPO INTELLIGENCE TOOLS section. Pin presence
  // of the section + key pull-tool names + the "when to prefer" /
  // "when to stick with read/grep" branches. Eval-validated wording
  // (see tests/repointel-tool-adoption.eval.ts) — a future prompt edit
  // that drops any of these signals must re-run the panel eval.
  it('emits the REPO INTELLIGENCE TOOLS section (FEATURE_161)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('REPO INTELLIGENCE TOOLS');
    expect(out).toContain('FEATURE_161');
    // Key pull-tool names must be advertised by name.
    expect(out).toContain('`relationship_scan');
    expect(out).toContain('`module_context');
    expect(out).toContain('`symbol_context');
    expect(out).toContain('`impact_estimate');
    expect(out).toContain('`process_context');
    expect(out).toContain('`repo_overview');
    expect(out).toContain('`changed_scope');
    expect(out).toContain('`changed_diff_bundle');
    expect(out).toContain('`changed_diff(');
    expect(out).toContain('`lsp_workspace_symbols');
    expect(out).toContain('`lsp_incoming_calls');
    // FEATURE_250 — code_search / semantic_lookup teaching. These two are
    // deferred (hint-swapped) on the managed path; naming them here (with the
    // "ranked vs grep" / "concept vs exact-string" distinction) restored floor
    // aliases (mmx/m27 75%→100%) on ambiguous search tasks — see
    // tests/deferred-tool-hard-case-teaching.eval.ts. Dropping either name
    // must re-run that panel.
    expect(out).toContain('`code_search(');
    expect(out).toContain('`semantic_lookup(');
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

  it('keeps the system prompt byte-identical regardless of the resume-after-revise flag (retrospective moved to the sidecar reanimate message)', () => {
    // FEATURE_116 follow-up: the revise-failure retrospective now rides the
    // Sidecar Verifier's synthetic user message (mapVerifierVerdictToStopHookResult),
    // so the Worker system prompt stays byte-stable across revise cycles and the
    // Anthropic system cache block is reused instead of busted every reanimate.
    const resumed = buildWorkerInstructions(baseDecision, undefined, true);
    const fresh = buildWorkerInstructions(baseDecision, undefined, false);
    expect(resumed).toBe(fresh);
    expect(resumed).not.toContain('previous attempt at this task failed');
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

  it('does not allow a final summary while dispatched children are pending', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PENDING CHILDREN ARE NOT FINAL');
    expect(out).toContain('Do not write a final review/report/summary from partial child evidence');
    expect(out).toContain('every dispatched child has produced its matching `<task-completed>` block');
  });

  it('does NOT mention await_child_task anywhere (tool was deleted in Slice C1)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).not.toContain('await_child_task');
  });

  it('FAN-OUT plan granularity guidance points in_progress trigger at dispatch_child_task', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // claudecode 3-bullet rewrite (v0.7.42): "just before its
    // `dispatch_child_task` call" (no "corresponding" prefix per
    // ADR-033 §2 single-concept simplification).
    expect(out).toContain("just before its `dispatch_child_task`");
    expect(out).toContain('<task-completed>');
  });

  it('keeps the structural gates intact (PLAN-FIRST, SCOPE COMMITMENT, TERMINATION, FAN-OUT PLAN GRANULARITY)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('PLAN-FIRST CONTRACT');
    expect(out).toContain('SCOPE COMMITMENT');
    expect(out).toContain('FAN-OUT PLAN GRANULARITY');
    expect(out).toContain('TERMINATION');
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

  it('teaches intentional FEATURE_259 model tier routing and compact child briefs', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    expect(out).toContain('MODEL HINT');
    expect(out).toMatch(/"fast"/);
    expect(out).toMatch(/"deep"/);
    expect(out).toMatch(/Configured `fast`\/`deep` tiers route through FEATURE_102/);
    expect(out).not.toMatch(/no-op today/);
    expect(out).toMatch(/substantive children/);
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
    // v0.7.42 — the schema-split note + additive semantics is the
    // structural pin; op:'init' as a fan-out re-seed path is gone.
    expect(out).toMatch(/v0\.7\.42 schema split/);
    // ADR-033 §4 — additive semantics now expressed via "existing items
    // must be preserved" (single concept) rather than "purely additive" label.
    expect(out).toMatch(/existing items must be preserved/);
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

  it('FAN-OUT PLAN GRANULARITY handles the late N+1th child (claudecode 3-bullet)', () => {
    const out = buildWorkerInstructions(baseDecision, undefined, false);
    // Mid-fan-out additive child — qualitative one-sentence guidance
    // (no LATE-DISCOVERED CHILD label per ADR-033 §4, no worked-example
    // syntax pin per ADR-033 §1).
    expect(out).toMatch(/mid fan-out you decide to dispatch another child.*add the matching todo before the new dispatch/);
  });

  it('no longer carries the revise-failure retrospective in the system prompt (moved to the sidecar reanimate message)', () => {
    // The retrospective's todo_create guidance now lives in REVISE_RETROSPECTIVE
    // on the sidecar reanimate message (verifier.ts) — verified there instead.
    const out = buildWorkerInstructions(baseDecision, undefined, true);
    expect(out).not.toContain('previous attempt at this task failed');
    expect(out).not.toMatch(/use `todo_create` to add the new step/);
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
