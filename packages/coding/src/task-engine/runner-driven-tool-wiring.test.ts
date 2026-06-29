/**
 * FEATURE_168 (v0.7.40 hotfix) — AMA agent tool-wiring contract tests.
 *
 * Pins the runtime tool surface of each AMA role to the
 * `getAmaRoleExpectedToolNames(role)` derivation (registry minus
 * `AMA_BASELINE_EXCLUDE ∪ <ROLE>_EXTRA_EXCLUDE`).
 *
 * Why this file exists: before FEATURE_168 the per-role tool lists were
 * manually push'd into agent.tools arrays in runner-driven.ts. Three separate
 * features (FEATURE_120 send_message/task_stop, FEATURE_161 4 of 8 repo-intel
 * pull tools, FEATURE_168 4 web tools) silently dropped tools from production
 * AMA agents because no test asserted "the runtime agent.tools array contains
 * a schema entry with this name". This file closes that hole.
 *
 * FEATURE_184 (v0.7.42) Phase C.1: Evaluator removed from AmaRole.
 * FEATURE_193 (v0.7.43): V1 chain (Scout/Planner/Generator) retired —
 * only Worker remains. The scout/planner/generator role wiring tests were
 * deleted alongside the V1 chain agent declarations.
 */

import { describe, expect, it } from 'vitest';

import {
  type AmaRole,
  buildRunnerAgentChain,
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './runner-driven.js';
import { listToolDefinitions, MCP_TOOL_NAMES } from '../tools/registry.js';
import type { KodaXToolExecutionContext } from '../types.js';

// FEATURE_246: the standard workflow-capable Worker is the AMAW (or AMA
// /workflow-command-elevated) Worker, whose ctx carries a workflowHost. run_workflow
// is host-conditional now — visible only when the host is wired — so the default
// test ctx includes one. A separate test pins the no-host (plain AMA) surface.
function makeCtx(hasCapabilityRuntime = true, hasWorkflowHost = true): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
    ...(hasCapabilityRuntime
      ? { extensionRuntime: {} as KodaXToolExecutionContext['extensionRuntime'] }
      : {}),
    ...(hasWorkflowHost
      ? { workflowHost: {} as KodaXToolExecutionContext['workflowHost'] }
      : {}),
  };
}

function makeRecorder() {
  return {} as Parameters<typeof buildRunnerAgentChain>[1];
}

function getAgentToolNames(
  role: AmaRole,
  hasCapabilityRuntime = true,
  hasWorkflowHost = true,
): readonly string[] {
  const chain = buildRunnerAgentChain(makeCtx(hasCapabilityRuntime, hasWorkflowHost), makeRecorder());
  if (role !== 'worker') {
    throw new Error(`FEATURE_193: role '${role}' retired with V1 chain`);
  }
  return (chain.worker.tools ?? [])
    .map((t) => (t as { name: string }).name)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

describe('FEATURE_168 — AMA agent tool wiring (per-role full set)', () => {
  it(`worker.tools === getAmaRoleExpectedToolNames('worker')`, () => {
    const actual = getAgentToolNames('worker');
    const expected = getAmaRoleExpectedToolNames('worker');
    expect(actual).toEqual(expected);
  });

  it('worker hides MCP tools when no extension runtime is bound', () => {
    const actual = getAgentToolNames('worker', false);
    const expected = getAmaRoleExpectedToolNames('worker', false);
    expect(actual).toEqual(expected);
    for (const mcpTool of MCP_TOOL_NAMES) {
      expect(actual, `worker should hide ${mcpTool} without extension runtime`).not.toContain(mcpTool);
    }
  });

  it('worker exposes MCP tools when an extension runtime is bound', () => {
    const actual = getAgentToolNames('worker', true);
    for (const mcpTool of MCP_TOOL_NAMES) {
      expect(actual, `worker should expose ${mcpTool} with extension runtime`).toContain(mcpTool);
    }
  });

  it('FEATURE_246: run_workflow is host-conditional — present with a workflow host (amaw / elevated AMA command turn), absent without one (plain AMA)', () => {
    expect(getAgentToolNames('worker', true, true)).toContain('run_workflow');
    expect(getAgentToolNames('worker', true, false)).not.toContain('run_workflow');
  });

  it('worker has no V1 emit tools (F193 V1 chain retired) and no emit_handoff (F190)', () => {
    const allNames = getAgentToolNames('worker');
    for (const banned of ['emit_scout_verdict', 'emit_contract', 'emit_handoff', 'emit_verdict']) {
      expect(allNames, `worker should not carry ${banned}`).not.toContain(banned);
    }
  });
});

describe('FEATURE_168 — coordinator-class tools (send_message, task_stop) are wired', () => {
  it('worker has send_message + task_stop in schema (FEATURE_120 v0.7.39 wiring fix)', () => {
    const names = getAgentToolNames('worker');
    expect(names).toContain('send_message');
    expect(names).toContain('task_stop');
  });

  it('worker has task_output for child status snapshots', () => {
    const names = getAgentToolNames('worker');
    expect(names).toContain('task_output');
  });
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
    'relationship_scan',
  ] as const;

  it('worker has all repo-intel pull tools (Worker prompt FEATURE_161+ teaches them)', () => {
    const names = getAgentToolNames('worker');
    for (const pullTool of PULL_TOOLS) {
      expect(names, `worker missing ${pullTool}`).toContain(pullTool);
    }
  });
});

describe('FEATURE_168 — web/search tools (FEATURE_168 Tier D wiring fix)', () => {
  const WEB_TOOLS = ['web_search', 'web_fetch', 'code_search', 'semantic_lookup'] as const;

  it('worker has web/search tools', () => {
    const names = getAgentToolNames('worker');
    for (const webTool of WEB_TOOLS) {
      expect(names, `worker missing ${webTool}`).toContain(webTool);
    }
  });
});

describe('FEATURE_168 — registry orphan check (no registered tool falls off Worker)', () => {
  it('every non-specialized registry tool appears in the Worker role', () => {
    const allRegistered = listToolDefinitions().map((d) => d.name);
    const specializedPaths = getAmaRoleEffectiveExclude('worker'); // worker has only BASELINE
    const nonSpecialized = allRegistered.filter((name) => !specializedPaths.has(name));

    const workerTools = new Set<string>(getAgentToolNames('worker'));

    const orphans = nonSpecialized.filter((name) => !workerTools.has(name));
    expect(orphans, 'tools registered but exposed to no AMA role').toEqual([]);
  });
});
