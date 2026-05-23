/**
 * FEATURE_168 (v0.7.40 hotfix) — AMA agent tool-wiring contract tests.
 *
 * Pins the runtime tool surface of each AMA role to the
 * `getAmaRoleExpectedToolNames(role)` derivation (registry minus
 * `AMA_BASELINE_EXCLUDE ∪ <ROLE>_EXTRA_EXCLUDE`).
 *
 * Why this file exists: before FEATURE_168 the per-role tool lists were
 * manually push'd into 5 `agent.tools` arrays in `runner-driven.ts`. Three
 * separate features (FEATURE_120 send_message/task_stop, FEATURE_161 4 of 8
 * repo-intel pull tools, FEATURE_168 4 web tools) silently dropped tools
 * from production AMA agents because no test asserted "the runtime
 * `agent.tools` array contains a schema entry with this name". Handler unit
 * tests, registry-registration tests, role-prompt tests, and CHILD_EXCLUDE
 * tests all passed despite the gap. This file closes that hole — any
 * future EXCLUDE-set change or registry addition shows up immediately as a
 * concrete test failure, not a silent production schema gap.
 *
 * Spot-check assertions (`includes` / `not.includes`) follow the
 * derivation-based assertion so the test surfaces BOTH (a) the full set
 * mismatch and (b) the specific class of tool that drifted (writes,
 * dispatch, web, repo-intel, etc.).
 *
 * FEATURE_184 (v0.7.45) Phase C.1: Evaluator removed from AmaRole and
 * the in-chain agent graph. The Evaluator security boundary describe block
 * is deleted; Sidecar Verifier carries its own architectural constraints.
 */

import { describe, expect, it } from 'vitest';

import {
  type AmaRole,
  buildRunnerAgentChain,
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './runner-driven.js';
import { listToolDefinitions } from '../tools/registry.js';
import {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from '../agents/protocol-emitters.js';
import type { KodaXToolExecutionContext } from '../types.js';

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

function makeRecorder() {
  return {} as Parameters<typeof buildRunnerAgentChain>[1];
}

function getAgentToolNames(role: AmaRole): readonly string[] {
  const chain = buildRunnerAgentChain(makeCtx(), makeRecorder());
  const agent = chain[role];
  return (agent.tools ?? [])
    .map((t) => (t as { name: string }).name)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

// Emit tools are NOT registry-borne — they are constructed per-run by
// `wrapEmitterWithRecorder` in `buildRunnerAgentChain`. Subtract them
// when comparing the agent's full tools list against the registry-derived
// expected set.
//
// FEATURE_190 (v0.7.43) Phase 3: Generator and Worker are terminal under
// F184 — text-only termination triggers Sidecar Verifier out-of-band, no
// emit tool. Only Scout and Planner have a per-run emit tool.
const ROLE_EMIT_TOOL_NAME: Partial<Record<AmaRole, string>> = {
  scout: EMIT_SCOUT_VERDICT_TOOL_NAME,
  planner: EMIT_CONTRACT_TOOL_NAME,
};

function getAgentRegistryToolNames(role: AmaRole): readonly string[] {
  const emitName = ROLE_EMIT_TOOL_NAME[role];
  if (emitName === undefined) return getAgentToolNames(role);
  return getAgentToolNames(role).filter((name) => name !== emitName);
}

describe('FEATURE_168 — AMA agent tool wiring (per-role full set)', () => {
  const roles: readonly AmaRole[] = ['scout', 'planner', 'generator', 'worker'];

  for (const role of roles) {
    it(`${role}.tools (excluding emit tool) === getAmaRoleExpectedToolNames('${role}')`, () => {
      const actual = getAgentRegistryToolNames(role);
      const expected = getAmaRoleExpectedToolNames(role);
      expect(actual).toEqual(expected);
    });
  }

  it('scout/planner include emit tool exactly once; generator/worker have no emit tool (F190 Phase 3)', () => {
    for (const role of roles) {
      const allNames = getAgentToolNames(role);
      const emitName = ROLE_EMIT_TOOL_NAME[role];
      if (emitName === undefined) {
        // Generator / Worker: no emit tool in the surface.
        for (const banned of [EMIT_SCOUT_VERDICT_TOOL_NAME, EMIT_CONTRACT_TOOL_NAME, 'emit_handoff', 'emit_verdict']) {
          expect(allNames, `${role} should not carry ${banned}`).not.toContain(banned);
        }
      } else {
        const occurrences = allNames.filter((name) => name === emitName).length;
        expect(occurrences, `${role} should emit ${emitName} once`).toBe(1);
      }
    }
  });
});

describe('FEATURE_168 — coordinator-class tools (send_message, task_stop) are wired', () => {
  it.each(['scout', 'generator', 'worker'] as const)(
    '%s has send_message + task_stop in schema (FEATURE_120 v0.7.39 wiring fix)',
    (role) => {
      const names = getAgentToolNames(role);
      expect(names).toContain('send_message');
      expect(names).toContain('task_stop');
    },
  );

  it.each(['planner'] as const)(
    '%s does NOT have send_message / task_stop (coordinator-only, planner excluded)',
    (role) => {
      const names = getAgentToolNames(role);
      expect(names).not.toContain('send_message');
      expect(names).not.toContain('task_stop');
    },
  );
});

describe('FEATURE_168 — repo-intel pull tools (FEATURE_161 v0.7.41 wiring fix)', () => {
  const PULL_TOOLS = [
    'repo_overview',
    'changed_scope',
    'changed_diff',
    'changed_diff_bundle',
    'module_context',
    'symbol_context',
    'process_context',
    'impact_estimate',
  ] as const;

  it.each(['scout', 'planner', 'generator', 'worker'] as const)(
    '%s has all 8 repo-intel pull tools (Worker prompt FEATURE_161 teaches them)',
    (role) => {
      const names = getAgentToolNames(role);
      for (const pullTool of PULL_TOOLS) {
        expect(names, `${role} missing ${pullTool}`).toContain(pullTool);
      }
    },
  );
});

describe('FEATURE_168 — web/search tools (FEATURE_168 Tier D wiring fix)', () => {
  const WEB_TOOLS = ['web_search', 'web_fetch', 'code_search', 'semantic_lookup'] as const;

  it.each(['scout', 'planner', 'generator', 'worker'] as const)(
    '%s has web/search tools',
    (role) => {
      const names = getAgentToolNames(role);
      for (const webTool of WEB_TOOLS) {
        expect(names, `${role} missing ${webTool}`).toContain(webTool);
      }
    },
  );
});

describe('FEATURE_168 — Planner security boundary (read-only inspection)', () => {
  const FORBIDDEN_FOR_PLANNER = [
    'bash',
    'write',
    'edit',
    'multi_edit',
    'insert_after_anchor',
    'undo',
    'dispatch_child_task',
    'send_message',
    'task_stop',
    'worktree_create',
    'worktree_remove',
    'exit_plan_mode',
    'ask_user_question',
  ] as const;

  it.each(FORBIDDEN_FOR_PLANNER)('Planner is excluded from %s', (toolName) => {
    const names = getAgentToolNames('planner');
    expect(names).not.toContain(toolName);
  });

  it('Planner retains contract-drafting surface', () => {
    const names = getAgentToolNames('planner');
    expect(names).toContain('read');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('todo_update');
    expect(names).toContain('todo_list');
    // FEATURE_170 (v0.7.41) — Planner also gets todo_create for plan
    // refinement during contract drafting.
    expect(names).toContain('todo_create');
    // v0.7.42 — todo_get is the staleness-refresh / pick-up surface
    // (mirrors claudecode V2 TaskGet). Planner uses it before mutating an
    // item via todo_update when it's uncertain about current state.
    expect(names).toContain('todo_get');
  });
});

describe('FEATURE_168 — registry orphan check (no registered tool falls off every role)', () => {
  it('every non-specialized registry tool appears in at least one AMA role', () => {
    const allRegistered = listToolDefinitions().map((d) => d.name);
    const specializedPaths = getAmaRoleEffectiveExclude('worker'); // worker has only BASELINE
    const nonSpecialized = allRegistered.filter((name) => !specializedPaths.has(name));

    const roleUnion = new Set<string>();
    for (const role of ['scout', 'planner', 'generator', 'worker'] as const) {
      for (const name of getAgentToolNames(role)) {
        roleUnion.add(name);
      }
    }

    const orphans = nonSpecialized.filter((name) => !roleUnion.has(name));
    expect(orphans, 'tools registered but exposed to no AMA role').toEqual([]);
  });
});
