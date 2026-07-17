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

// FEATURE_193 v0.7.43: callScout renamed to callWorker and role changed from 'scout' to 'worker' (V1 chain retired)
function callWorker(ctx: ManagedRolePromptContext): string {
  const decision = buildFallbackRoutingDecision(userQuestion);
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

describe('createRolePrompt — runtime identity in workspace section', () => {
  it('emits Provider and Model lines when both are supplied', () => {
    const rendered = callWorker(
      buildContext({ provider: 'ark-coding', model: 'glm-5.2' }),
    );
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).toContain('Model: glm-5.2');
  });

  it('places Provider/Model inside the ## Environment block (not elsewhere)', () => {
    const rendered = callWorker(
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
    const rendered = callWorker(buildContext({ model: 'glm-5.2' }));
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).toContain('Model: glm-5.2');
  });

  it('omits Model line when model is absent', () => {
    const rendered = callWorker(buildContext({ provider: 'ark-coding' }));
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).not.toMatch(/^Model:/m);
  });

  it('emits neither when workspace lacks both fields (legacy callers unaffected)', () => {
    const rendered = callWorker(buildContext());
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).not.toMatch(/^Model:/m);
    // Sanity: the rest of the workspace block still renders.
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Platform: Windows');
  });

  it('emits Session Scratch Directory and scratch discipline when supplied', () => {
    const scratchDir = 'C:\\Works\\GitWorks\\KodaX-author\\KodaX\\.agent\\tmp\\sessions\\session-1';
    const rendered = callWorker(buildContext({ scratchDir }));

    expect(rendered).toContain(`Session Scratch Directory: ${scratchDir}`);
    expect(rendered).toContain(`write it under the Session Scratch Directory above: ${scratchDir}`);
    expect(rendered).toContain('Do not write directly in the shared `.agent/tmp/` root.');
  });

  // FEATURE_193 v0.7.43: emits identity facts for non-Scout roles (Generator) it deleted (V1 generator role retired)
});

// FEATURE_193 v0.7.43: FEATURE_107 Generator reasoning discipline describe deleted (V1 generator role retired)

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
  // FEATURE_193 v0.7.43: renderRole role type trimmed from scout|planner|generator to worker (V1 chain retired)
  function renderRole(
    role: 'worker',
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

  // FEATURE_193 v0.7.43: roles array trimmed from ['scout','planner','generator'] to ['worker'] (V1 chain retired)
  // FEATURE_184 (v0.7.45) Phase C.3: 'evaluator' removed — in-chain Evaluator retired.
  const roles = ['worker'] as const;

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
//   2. Worker terminates text-only (FEATURE_190 v0.7.43 Phase 3: the
//      legacy `emit_handoff` tool was deleted; Sidecar Verifier runs
//      out-of-band).
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

  it('decisionSummary is de-harnessed and the Worker self-judges via EXECUTION GUIDANCE (ADR-043)', () => {
    const rendered = renderWorker();
    // Semantic routing fields stay (they help; see decisionSummary eval).
    expect(rendered).toContain('Primary task:');
    expect(rendered).toContain('Risk:');
    // The collapsed/vestige harness-tier classification lines were removed (P1.6).
    expect(rendered).not.toContain('Harness:');
    expect(rendered).not.toContain('Topology ceiling:');
    // The Worker self-judges its approach from the static guidance (H3) instead.
    expect(rendered).toContain('EXECUTION GUIDANCE');
  });

  it('teaches language continuity across Actor-event resumes', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('Language continuity: Match the primary natural language');
    expect(rendered).toContain('Actor-event resume summaries');
    expect(rendered).toContain('Tool outputs, code identifiers, and quoted evidence may remain');
  });

  it('does NOT route Worker through emit_handoff (FEATURE_190: text-only termination)', () => {
    // FEATURE_190 (v0.7.43) — Worker is excluded from PROTOCOL EMISSION
    // teaching and from the kodax-task-handoff fenced-block fallback.
    // Worker terminates text-only and Sidecar Verifier runs out-of-band.
    const rendered = renderWorker();
    expect(rendered).not.toContain('"emit_handoff"');
    expect(rendered).not.toContain('PROTOCOL EMISSION — MUST be in the SAME response');
    expect(rendered).not.toContain('kodax-task-handoff');
    // Sanity: also not the other role-specific emit names.
    expect(rendered).not.toContain('"emit_scout_verdict"');
    expect(rendered).not.toContain('"emit_contract"');
    expect(rendered).not.toContain('"emit_verdict"');
  });

  it('splices buildWorkerInstructions content and canonical Agent policies', () => {
    const rendered = renderWorker();
    // Pinned tokens from `buildWorkerInstructions` — if the entry
    // wire breaks, these disappear and the V2 path silently falls
    // back to a context-only prompt with no planning guidance.
    expect(rendered).toContain('PLAN-FIRST CONTRACT:');
    expect(rendered).toContain('SCOPE COMMITMENT:');
    expect(rendered).toContain('MUTATION DISCIPLINE');
    expect(rendered).toContain('AGENT COLLABORATION:');
    expect(rendered).toContain(
      'Use sub-agents when parallel work would materially improve speed or quality.',
    );
    expect(rendered).toContain(
      'Use `run_workflow` only when the user explicitly requests a Workflow or names a Workflow.',
    );
    expect(rendered).toContain('its body is the authoritative terminal result');
    expect(rendered).toContain('After `AgentLimitReached`');
    // FEATURE_190 (v0.7.43): legacy `EVALUATOR HANDOFF` replaced by
    // positive text-only termination block.
    expect(rendered).toContain('TERMINATION');
    expect(rendered).toContain('Sidecar Verifier');
    expect(rendered).not.toContain('EVALUATOR HANDOFF');
    expect(rendered).toContain('You are the Worker — KodaX\'s single primary agent');
  });

  it('no longer threads isResumeAfterReviseFailure into the Worker prompt (retrospective moved to the sidecar reanimate message post-F116)', () => {
    const fresh = renderWorker();
    const resume = renderWorker({ isResumeAfterReviseFailure: true });
    // Neither prompt carries the retrospective now — it rides the Sidecar
    // Verifier's synthetic user message (mapVerifierVerdictToStopHookResult),
    // so the system prompt stays byte-stable across revise cycles for cache reuse.
    expect(fresh).not.toContain('Sidecar Verifier review');
    expect(resume).not.toContain('A previous attempt at this task failed Sidecar Verifier review');
    expect(resume).not.toContain('Evaluator review');
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

// FEATURE_193 v0.7.43: FEATURE_114 Slice 8a Scout TRIVIAL-EXEMPTION boundary pin describe deleted (V1 scout role retired)

// v0.7.38 FEATURE_155 hotfix — Bug C: Evaluator wait-for-children discipline.
// FEATURE_184 (v0.7.45) Phase C.3: in-chain Evaluator retired. The prompt
// content tests (CHILD-TASK WAIT DISCIPLINE etc.) are removed because
// createRolePrompt('evaluator', ...) now falls through to the default branch.
// The isolation test ("does NOT leak") is preserved as a sentinel to ensure
// the wait-discipline section stays confined to the Sidecar Verifier context.
describe('createRolePrompt — wait-discipline isolation (FEATURE_155 / FEATURE_184)', () => {
  // FEATURE_193 v0.7.43: loop trimmed from ['scout','planner','generator','worker'] to ['worker'] (V1 chain retired)
  it('CHILD-TASK WAIT DISCIPLINE does NOT appear in Worker prompt', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['worker'] as const) {
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

// FEATURE_125 (v0.7.41) — Team Mode prompt block injection. The runner-
// driven adapter renders `=== Other active KodaX sessions ===` per LLM
// round via `buildOtherInstancesPromptBlock(discoverInstances())` and
// passes it via `rolePromptContext.teamModeSection`. The role-prompt
// builder must surface it on every active managed-task role.
// FEATURE_184 (v0.7.45) Phase C.3: 'evaluator' removed — in-chain
// Evaluator retired; Sidecar Verifier does not use createRolePrompt.
describe('FEATURE_125 — teamModeSection wiring across roles', () => {
  const SAMPLE_BLOCK = [
    '=== Other active KodaX sessions ===',
    '',
    'You are not alone — the user has 1 other KodaX session running:',
    '',
    '- pid 42 @ /repo (started 1 min ago)',
    '  Phase: running_tool',
    '  Intent: "refactoring auth"',
  ].join('\n');

  // FEATURE_193 v0.7.43: role type trimmed from scout|planner|generator|worker to worker (V1 chain retired)
  function renderWithTeamBlock(role: 'worker'): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      teamModeSection: SAMPLE_BLOCK,
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

  // FEATURE_193 v0.7.43: loop trimmed from ['scout','planner','generator','worker'] to ['worker'] (V1 chain retired)
  for (const role of ['worker'] as const) {
    it(`role=${role} includes the team-mode block when supplied`, () => {
      const rendered = renderWithTeamBlock(role);
      expect(rendered).toContain('=== Other active KodaX sessions ===');
      expect(rendered).toContain('pid 42 @ /repo');
      expect(rendered).toContain('Intent: "refactoring auth"');
    });

    it(`role=${role} places the team-mode block in the orientation header (before the original task)`, () => {
      const rendered = renderWithTeamBlock(role);
      const blockIdx = rendered.indexOf('=== Other active KodaX sessions ===');
      const taskIdx = rendered.indexOf('Original user request:');
      expect(blockIdx).toBeGreaterThanOrEqual(0);
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      expect(blockIdx).toBeLessThan(taskIdx);
    });
  }

  // FEATURE_193 v0.7.43: 'scout' → 'worker' (V1 chain retired)
  it('omits the block entirely when teamModeSection is undefined (solo session)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const rendered = createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      buildContext({ provider: 'p', model: 'm' }),
      undefined,
      false,
    );
    expect(rendered).not.toContain('Other active KodaX sessions');
  });

  it('omits the block when teamModeSection is whitespace-only', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      teamModeSection: '   \n  \n',
    };
    const rendered = createRolePrompt(
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
    expect(rendered).not.toContain('Other active KodaX sessions');
  });
});

describe('F270 — explicit Workflow activation policy', () => {
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

  it('exposes proactive Agent collaboration without complexity-driven Workflow orchestration', () => {
    const rendered = renderWorker();
    expect(rendered).toContain(
      'Use sub-agents when parallel work would materially improve speed or quality.',
    );
    expect(rendered).toContain(
      'Use `run_workflow` only when the user explicitly requests a Workflow or names a Workflow.',
    );
    expect(rendered).not.toContain('ORCHESTRATION DEFAULT');
    expect(rendered).not.toContain('PLAN-TIME COMMITMENT');
    expect(rendered).not.toContain('dispatch_child_task');
  });

  it('teaches Actor completion and capacity recovery semantics', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('<agent-completed path="..." turn_id="..." state="completed">');
    expect(rendered).toContain('use the inline result directly');
    expect(rendered).toContain('Do not call `agent_output` speculatively');
    expect(rendered).toContain('do not retry `spawn_agent` while the reported capacity is still full');
  });
});
