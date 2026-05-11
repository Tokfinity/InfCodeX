import { describe, expect, it } from 'vitest';
import { createRolePrompt } from './role-prompt.js';
import { buildFallbackRoutingDecision } from '../../../reasoning.js';
import type { ManagedRolePromptContext } from './role-prompt-types.js';

const userQuestion = '你底层用的是什么模型？';

function buildContext(
  overrides: Partial<NonNullable<ManagedRolePromptContext['workspace']>> = {},
): ManagedRolePromptContext {
  return {
    originalTask: userQuestion,
    workspace: {
      executionCwd: 'C:\\Works\\GitWorks\\KodaX-author\\KodaX',
      platform: 'win32',
      osRelease: '10.0.19045',
      ...overrides,
    },
  };
}

function callScout(ctx: ManagedRolePromptContext): string {
  const decision = buildFallbackRoutingDecision(userQuestion);
  return createRolePrompt(
    'scout',
    userQuestion,
    decision,
    undefined,
    undefined,
    'kodax/role/scout',
    undefined,
    ctx,
    undefined,
    false,
  );
}

describe('createRolePrompt — runtime identity in workspace section', () => {
  it('emits Provider and Model lines when both are supplied', () => {
    const rendered = callScout(
      buildContext({ provider: 'ark-coding', model: 'glm-5.1' }),
    );
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).toContain('Model: glm-5.1');
  });

  it('places Provider/Model inside the ## Environment block (not elsewhere)', () => {
    const rendered = callScout(
      buildContext({ provider: 'kimi-code', model: 'kimi-for-coding' }),
    );
    const envIdx = rendered.indexOf('## Environment');
    const providerIdx = rendered.indexOf('Provider: kimi-code');
    const modelIdx = rendered.indexOf('Model: kimi-for-coding');
    const shellIdx = rendered.indexOf('Shell defaults:');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThan(envIdx);
    expect(modelIdx).toBeGreaterThan(envIdx);
    // Sanity: runtime fact comes before the shell-defaults guidance,
    // matching the proximity assumption in the role-prompt source.
    expect(providerIdx).toBeLessThan(shellIdx);
    expect(modelIdx).toBeLessThan(shellIdx);
  });

  it('omits Provider line when provider is absent', () => {
    const rendered = callScout(buildContext({ model: 'glm-5.1' }));
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).toContain('Model: glm-5.1');
  });

  it('omits Model line when model is absent', () => {
    const rendered = callScout(buildContext({ provider: 'ark-coding' }));
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).not.toMatch(/^Model:/m);
  });

  it('emits neither when workspace lacks both fields (legacy callers unaffected)', () => {
    const rendered = callScout(buildContext());
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).not.toMatch(/^Model:/m);
    // Sanity: the rest of the workspace block still renders.
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Platform: Windows');
  });

  it('emits identity facts for non-Scout roles too (Generator)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const rendered = createRolePrompt(
      'generator',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/generator',
      undefined,
      buildContext({ provider: 'zhipu-coding', model: 'glm-5' }),
      undefined,
      false,
    );
    expect(rendered).toContain('Provider: zhipu-coding');
    expect(rendered).toContain('Model: glm-5');
  });
});

// FEATURE_107 (v0.7.32): Generator reasoning-discipline now hardcoded as default
// after P6 eval confirmed it's harmless on low-context tasks across 6 aliases.
// Originally an env-gated experiment (KODAX_GENERATOR_REASONING_DISCIPLINE);
// promoted to always-on prompt fragment.
describe('FEATURE_107 — Generator reasoning discipline (Claude Code verbatim)', () => {
  function renderGenerator(): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    return createRolePrompt(
      'generator',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/generator',
      undefined,
      buildContext({ provider: 'p', model: 'm' }),
      undefined,
      false,
    );
  }

  it('Generator prompt includes the discipline block by default (no env hook)', () => {
    const rendered = renderGenerator();
    // v3 core sentences (Claude Code verbatim with emit_handoff swap)
    expect(rendered).toContain('diagnose why before switching tactics');
    expect(rendered).toContain('check your assumptions');
    expect(rendered).toContain('Don\'t retry the identical action blindly');
    expect(rendered).toContain('don\'t abandon a viable approach after a single failure');
    expect(rendered).toContain('Reserve emit_handoff status="blocked"');
    expect(rendered).toContain('genuine impasses after investigation');
    expect(rendered).toContain('not as a first response to friction');
  });

  it('Earlier-iteration artifacts (v1/v2) are not present', () => {
    const rendered = renderGenerator();
    expect(rendered).not.toContain('_debug.test.ts');
    expect(rendered).not.toContain('three consecutive');
    expect(rendered).not.toContain('Forbidden anti-patterns');
    expect(rendered).not.toContain('targeted piece of evidence');
  });

  it('Discipline block does NOT bleed into non-Generator roles (Scout / Planner / Evaluator)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['scout', 'planner', 'evaluator'] as const) {
      const rendered = createRolePrompt(
        role,
        userQuestion,
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        buildContext({ provider: 'p', model: 'm' }),
        undefined,
        false,
      );
      expect(rendered, `role=${role}`).not.toContain('Don\'t retry the identical action blindly');
    }
  });
});

// FEATURE_144 (v0.7.35.1): AMA worker capability-context parity. Each
// role MUST receive the 6 SA-path sections that v0.7.26 FEATURE_084
// dropped during the Runner-driven migration: mcp-capability-context,
// skills-addendum, project-agents (AGENTS.md / CLAUDE.md), tool-
// construction, git-context, project-snapshot.
//
// The runner pre-computes these via `buildCapabilityContextSections()`
// once per AMA entry and threads the joined block onto
// `ManagedRolePromptContext.capabilityContextBlock`. This test asserts
// (a) the block is rendered when present, (b) it lives between the
// workspace section and the decision summary so capability truth sits
// next to runtime truth, (c) it is omitted cleanly when absent, and
// (d) the 5 sections that ride on other Runner paths are NOT in this
// block (they would otherwise duplicate).
describe('FEATURE_144 — AMA worker capability-context parity', () => {
  function renderRole(
    role: 'scout' | 'planner' | 'generator' | 'evaluator',
    capabilityContextBlock: string | undefined,
  ): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const base = buildContext({ provider: 'p', model: 'm' });
    const ctx: ManagedRolePromptContext = {
      ...base,
      capabilityContextBlock,
    };
    return createRolePrompt(
      role,
      userQuestion,
      decision,
      undefined,
      undefined,
      `kodax/role/${role}`,
      undefined,
      ctx,
      undefined,
      false,
    );
  }

  const roles = ['scout', 'planner', 'generator', 'evaluator'] as const;

  it('renders capabilityContextBlock for every role when present', () => {
    const block = [
      '## MCP Capability Provider',
      'Use mcp_search before mcp_call.',
      '',
      '## Project Agents',
      'PROJECT RULE: prefer immutability.',
      '',
      'Working git context here.',
    ].join('\n');
    for (const role of roles) {
      const rendered = renderRole(role, block);
      expect(rendered, `role=${role}`).toContain('## MCP Capability Provider');
      expect(rendered, `role=${role}`).toContain('## Project Agents');
      expect(rendered, `role=${role}`).toContain('PROJECT RULE: prefer immutability.');
      expect(rendered, `role=${role}`).toContain('Working git context here.');
    }
  });

  it('positions capability block between workspaceSection and decisionSummary', () => {
    const block = '## MCP Capability Provider\nFROZEN_MCP_MARKER';
    for (const role of roles) {
      const rendered = renderRole(role, block);
      const envIdx = rendered.indexOf('## Environment');
      const capIdx = rendered.indexOf('FROZEN_MCP_MARKER');
      const decisionIdx = rendered.indexOf('Primary task:');
      expect(envIdx, `role=${role}: workspaceSection present`).toBeGreaterThanOrEqual(0);
      expect(capIdx, `role=${role}: capability block present`).toBeGreaterThan(envIdx);
      expect(decisionIdx, `role=${role}: decisionSummary present`).toBeGreaterThan(capIdx);
    }
  });

  it('emits no capability block when undefined (legacy callers unaffected)', () => {
    for (const role of roles) {
      const rendered = renderRole(role, undefined);
      // Workspace + decision summary still present; no orphan blank gap
      // means the filter() chain dropped the undefined entry cleanly.
      expect(rendered).toContain('## Environment');
      expect(rendered).toContain('Primary task:');
      // Sentinel: no MCP / project-agents content leaks in when the
      // parent didn't pre-compute one.
      expect(rendered).not.toContain('## MCP Capability Provider');
    }
  });

  it('emits no capability block when empty / whitespace-only string', () => {
    for (const role of roles) {
      const renderedEmpty = renderRole(role, '');
      const renderedWs = renderRole(role, '   \n\t  \n');
      // Both should match the undefined behavior — whitespace-only blocks
      // would otherwise inject a noisy empty section between workspace
      // and decision summary.
      expect(renderedEmpty).toContain('## Environment');
      expect(renderedWs).toContain('## Environment');
      expect(renderedEmpty).toContain('Primary task:');
      expect(renderedWs).toContain('Primary task:');
    }
  });
});

// FEATURE_114 v0.7.36 Slice 2 — Worker role prompt entry wire.
// The 'worker' branch of `createRolePrompt` collapses the legacy
// scout/planner/generator chain into a single primary agent that
// drives plan + execution behind the KODAX_HARNESS_V2 flag. These
// tests assert the wiring (not Worker prompt wording — that lives in
// `worker-role-prompt.ts` and is covered by its own tests when the
// V2 runner ships in Slice 3):
//   1. Worker emits the canonical workspace / capability / overlay /
//      decisionSummary / contract context layers (FEATURE_144 +
//      FEATURE_086 parity).
//   2. Worker uses `emit_handoff` (matches Generator wire format so
//      the protocol-emitters pipeline plugs in unchanged).
//   3. Worker prompt actually splices `buildWorkerInstructions`
//      (plan-first contract / scope commitment / dispatch RULE A/B/C
//      / handoff fragments).
//   4. `isResumeAfterReviseFailure` flag is threaded through to the
//      Worker fragment (revise-retry retrospective sentence).
describe('FEATURE_114 Slice 2 — worker role prompt entry wire', () => {
  function renderWorker(
    overrides: Partial<ManagedRolePromptContext> = {},
  ): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      ...overrides,
    };
    return createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
    );
  }

  it('emits the canonical context layers (workspace / decisionSummary / shared closing rule)', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Primary task:');
    expect(rendered).toContain('Workspace discipline:');
    expect(rendered).toContain('Preserve any exact machine-readable closing contract');
  });

  it('routes Worker through emit_handoff (parity with Generator wire format)', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('"emit_handoff"');
    // Sanity: not the Scout / Planner / Evaluator emit names — the
    // Worker switch case must NOT regress to a paste-from-Scout default.
    expect(rendered).not.toContain('"emit_scout_verdict"');
    expect(rendered).not.toContain('"emit_contract"');
    expect(rendered).not.toContain('"emit_verdict"');
  });

  it('splices buildWorkerInstructions content (plan-first + scope commitment + dispatch + handoff fragments)', () => {
    const rendered = renderWorker();
    // Pinned tokens from `buildWorkerInstructions` — if the entry
    // wire breaks, these disappear and the V2 path silently falls
    // back to a context-only prompt with no planning guidance.
    expect(rendered).toContain('PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36)');
    expect(rendered).toContain('SCOPE COMMITMENT (FEATURE_106 hard rule)');
    expect(rendered).toContain('MUTATION DISCIPLINE');
    expect(rendered).toContain('DISPATCH RULES');
    expect(rendered).toContain('EVALUATOR HANDOFF');
    expect(rendered).toContain('You are the Worker — KodaX\'s single primary agent');
  });

  it('threads isResumeAfterReviseFailure into the Worker retrospective fragment', () => {
    const fresh = renderWorker();
    const resume = renderWorker({ isResumeAfterReviseFailure: true });
    // Fresh-run prompt should NOT carry the retrospective sentence.
    expect(fresh).not.toContain('A previous attempt at this task failed under Evaluator review');
    // Resume prompt MUST carry it (drives the LLM to read failed-item
    // notes before retrying with the same approach).
    expect(resume).toContain('A previous attempt at this task failed under Evaluator review');
    expect(resume).toContain('failed under Evaluator review');
  });

  it('does not leak Scout/Planner/Generator/Evaluator-specific prompt fragments', () => {
    const rendered = renderWorker();
    // FEATURE_106 Scout EMIT TIMING / TRIVIAL-EXEMPTION block belongs
    // only to Scout; would confuse the Worker which emits handoffs.
    expect(rendered).not.toContain('EMIT TIMING (CRITICAL — read this carefully)');
    // Planner contract payload shape is generator-handoff-equivalent
    // for Worker — make sure we did not paste the planner block in.
    expect(rendered).not.toContain('Contract payload shape (pass to emit_contract)');
    // Evaluator verdict shape ditto.
    expect(rendered).not.toContain('Verdict payload shape (pass to emit_verdict)');
  });

  it('renders capability + repo intelligence parity (FEATURE_144 / FEATURE_086 still apply to Worker)', () => {
    const rendered = renderWorker({
      capabilityContextBlock: '## MCP Capability Provider\nFROZEN_MCP_MARKER',
    });
    const envIdx = rendered.indexOf('## Environment');
    const capIdx = rendered.indexOf('FROZEN_MCP_MARKER');
    const decisionIdx = rendered.indexOf('Primary task:');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(envIdx);
    expect(decisionIdx).toBeGreaterThan(capIdx);
  });
});

// FEATURE_114 v0.7.36 Slice 8a — Scout TRIVIAL-EXEMPTION boundary pin.
//
// Goal: regression-gate the Scout EMIT TIMING + TRIVIAL-EXEMPTION wording
// so accidental edits do not silently widen the exemption boundary
// (which is FEATURE_097 root cause #3 — "Scout treats too many tasks
// as trivial").
//
// Per `benchmark/EVAL_GUIDELINES.md` anti-pattern 5 ("prompt iteration
// with large-scale experiments"), this slice does NOT pre-emptively
// rewrite the prompt. The Scout wording is already strong (single-step
// boundary, review/audit ≥2 files clause, EMIT TIMING anchor); a
// data-driven decision on whether to strengthen further is the
// Slice 8b Layer 2 probe (`tests/scout-trivial-exemption.eval.ts`,
// pending API budget authorization). These Layer 1 unit tests pin
// the current contract so the probe baseline is stable.
//
// Slice 8b probe design (pending, NOT run by this file):
//   Categories (5 probes each, mock user task + history):
//     A. Single-step lookups → Scout MUST exit without emit
//     B. ≥2-file investigations phrased as questions → MUST emit EARLY
//     C. "Explain how X works" with multi-file scope → MUST emit EARLY
//   Pre-registered threshold: ≥80% mean across 2 alias families per
//   category. Drop below threshold → strengthen; above → leave as is.
describe('FEATURE_114 Slice 8a — Scout TRIVIAL-EXEMPTION boundary pin', () => {
  function renderScoutPrompt(overrides: Partial<NonNullable<ManagedRolePromptContext['workspace']>> = {}): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    return createRolePrompt(
      'scout',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/scout',
      undefined,
      buildContext({ provider: 'p', model: 'm', ...overrides }),
      undefined,
      false,
    );
  }

  it('EMIT TIMING block is present (timing anchor — call EARLY, before main work)', () => {
    const rendered = renderScoutPrompt();
    expect(rendered).toContain('EMIT TIMING (CRITICAL — read this carefully)');
    // Pin the timing anchor — "EARLY — within the first 1-2 scoping turns".
    expect(rendered).toMatch(/EARLY.*within the first 1-2 scoping turns/);
    // Pin the contract framing — emit_scout_verdict is a PLAN COMMITMENT,
    // not a final report.
    expect(rendered).toContain('PLAN COMMITMENT, not a final report');
    expect(rendered).toContain('what you PLAN TO DO next, NOT what you have already done');
  });

  it('ANTI-PATTERN block calls out late emit + post-hoc obligations', () => {
    const rendered = renderScoutPrompt();
    expect(rendered).toContain('ANTI-PATTERN (do NOT do this)');
    expect(rendered).toContain('Call emit_scout_verdict at the END');
    // The correct flow line — pin the canonical sequence so a future
    // edit can't drop the explicit transition guidance.
    expect(rendered).toContain('commit plan EARLY → execute → todo_update at each step');
  });

  it('TRIVIAL-EXEMPTION boundary is single-step ONLY (typo / single-line edit / single-action lookup / one-sentence answer)', () => {
    const rendered = renderScoutPrompt();
    expect(rendered).toContain('TRIVIAL-EXEMPTION (narrow, do not abuse)');
    // Pin the exact boundary phrase — "exactly ONE distinct execution
    // step". The prompt source joins lines with `\n  ` (line
    // continuation), so the phrase spans a line break — match with a
    // whitespace-tolerant regex. Loosening this (e.g. "≤ 2 steps")
    // would silently widen the exemption and is the FEATURE_097 root
    // cause #3 regression we explicitly guard against.
    expect(rendered).toMatch(/exactly ONE distinct\s+execution step/);
    expect(rendered).toContain('a single typo fix');
    expect(rendered).toContain('a single-line edit');
    expect(rendered).toContain('a single-action');
    expect(rendered).toContain('a one-sentence answer');
  });

  it('EVERYTHING-ELSE clause: review/audit/investigation ≥2 files MUST emit EARLY (the FEATURE_097 #3 protection)', () => {
    const rendered = renderScoutPrompt();
    // Pin the load-bearing must-emit clause that catches review-style
    // tasks LLMs are most likely to misclassify as trivial. Removing
    // any of these phrases re-opens the exemption loophole. The
    // phrase spans a line break in the source (`including review /`
    // → `\n  audit / investigation`), match with whitespace tolerance.
    expect(rendered).toContain('EVERYTHING ELSE');
    expect(rendered).toMatch(/review \/\s+audit \/ investigation tasks that touch ≥2 files/);
    expect(rendered).toContain('even when the harness ends up being H0_DIRECT');
    expect(rendered).toContain('MUST');
    expect(rendered).toMatch(/emit_scout_verdict EARLY with executionObligations populated/);
    // The post-emit handoff: continue as H0 executor + call todo_update
    // at each step transition. Spans a line break — match with
    // whitespace tolerance.
    expect(rendered).toMatch(/continue as the H0 executor and call todo_update at each step transition/);
  });

  it('TRIVIAL-EXEMPTION block belongs to Scout only (does NOT leak into Planner / Generator / Evaluator)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['planner', 'generator', 'evaluator'] as const) {
      const rendered = createRolePrompt(
        role,
        userQuestion,
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        buildContext({ provider: 'p', model: 'm' }),
        undefined,
        false,
      );
      expect(rendered, `role=${role}`).not.toContain('TRIVIAL-EXEMPTION');
      expect(rendered, `role=${role}`).not.toContain('EMIT TIMING (CRITICAL');
    }
  });

  it('block ordering: EMIT TIMING comes after EXECUTION OBLIGATIONS, anchor before SCOPE COMMITMENT context', () => {
    // The Scout prompt builds the TRIVIAL-EXEMPTION argument in
    // sequence: SCOPE COMMITMENT (when to escalate) → EXECUTION
    // OBLIGATIONS (how to populate) → EMIT TIMING (when to call). A
    // future edit that reorders these could break the rhetorical
    // structure that drives early emission. Pin the order.
    const rendered = renderScoutPrompt();
    const scopeIdx = rendered.indexOf('SCOPE COMMITMENT (hard rule)');
    const execIdx = rendered.indexOf('EXECUTION OBLIGATIONS:');
    const emitIdx = rendered.indexOf('EMIT TIMING (CRITICAL');
    expect(scopeIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThan(scopeIdx);
    expect(emitIdx).toBeGreaterThan(execIdx);
  });
});

// v0.7.38 FEATURE_155 hotfix — Bug C: Evaluator must wait for child
// tasks to settle before emit_verdict, and the verdict's user_answer
// must restate the consolidated review (not collapse to a one-line
// ack). Structural test pins both anchors in the Evaluator prompt so
// a future edit can't silently drop the contract. A Layer 2 behavioural
// eval is the follow-up (tracked in FEATURE_LIST under FEATURE_155
// pending work) — this structural test is the minimum gate for the
// hotfix release.
describe('createRolePrompt — Evaluator wait-for-children + final-answer contract (v0.7.38 FEATURE_155 hotfix)', () => {
  function renderEvaluatorPrompt(): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    return createRolePrompt(
      'evaluator',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/evaluator',
      undefined,
      buildContext({ provider: 'p', model: 'm' }),
      undefined,
      false,
    );
  }

  it('teaches the Evaluator to wait for ALL dispatched children before emit_verdict', () => {
    const rendered = renderEvaluatorPrompt();
    expect(rendered).toContain('CHILD-TASK WAIT DISCIPLINE');
    expect(rendered).toContain('wait for ALL of them to return before calling `emit_verdict`');
    expect(rendered).toContain('end your turn with ONE short status sentence and NO tool calls');
    expect(rendered).toContain('<task-completed task_id="…">…</task-completed>');
  });

  it('requires the final user_answer to restate the consolidated review (not a one-line ack)', () => {
    const rendered = renderEvaluatorPrompt();
    expect(rendered).toContain('the `user_answer` field MUST restate the consolidated review');
    expect(rendered).toContain('do NOT collapse it to a one-line acknowledgement');
  });

  it('crashed children still count as settled so the Evaluator doesn\'t block forever', () => {
    const rendered = renderEvaluatorPrompt();
    expect(rendered).toContain('failed:');
    expect(rendered).toContain('count it as settled and continue');
  });

  it('wait-discipline block belongs to Evaluator only (does NOT leak into Worker / Generator / Scout / Planner)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['scout', 'planner', 'generator', 'worker'] as const) {
      const rendered = createRolePrompt(
        role,
        userQuestion,
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        buildContext({ provider: 'p', model: 'm' }),
        undefined,
        false,
      );
      expect(rendered, `role=${role}`).not.toContain('CHILD-TASK WAIT DISCIPLINE');
    }
  });
});
