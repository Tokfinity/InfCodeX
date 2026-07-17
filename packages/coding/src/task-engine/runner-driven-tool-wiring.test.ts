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

import { afterEach, describe, expect, it } from 'vitest';

import {
  type AmaRole,
  buildRunnerAgentChain,
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './runner-driven.js';
import {
  getToolDefinition,
  listToolDefinitions,
  MCP_TOOL_NAMES,
  registerTool,
} from '../tools/registry.js';
import { DEFERRED_TOOL_HINTS } from '../tools/deferred-tools.js';
import type { KodaXToolExecutionContext } from '../types.js';

const cleanupToolRegistrations: Array<() => void> = [];

afterEach(() => {
  while (cleanupToolRegistrations.length > 0) {
    cleanupToolRegistrations.pop()?.();
  }
});

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

  it('run_workflow is host-conditional for an explicit Workflow request', () => {
    expect(getAgentToolNames('worker', true, true)).toContain('run_workflow');
    expect(getAgentToolNames('worker', true, false)).not.toContain('run_workflow');
  });

  it('exposes the explicit Workflow activation policy only with a Workflow host', () => {
    const workflowDescription = (hasWorkflowHost: boolean): string => {
      const chain = buildRunnerAgentChain(makeCtx(true, hasWorkflowHost), makeRecorder());
      const workflow = (chain.worker.tools ?? []).find(
        (t) => (t as { name?: string }).name === 'run_workflow',
      ) as { description?: string } | undefined;
      return workflow?.description ?? '';
    };
    expect(workflowDescription(true)).toContain('Explicitly requested Workflow execution');
    expect(workflowDescription(false)).toBe('');
  });

  it('worker has no V1 emit tools (F193 V1 chain retired) and no emit_handoff (F190)', () => {
    const allNames = getAgentToolNames('worker');
    for (const banned of ['emit_scout_verdict', 'emit_contract', 'emit_handoff', 'emit_verdict']) {
      expect(allNames, `worker should not carry ${banned}`).not.toContain(banned);
    }
  });
});

describe('F270 — canonical Agent collaboration tools are wired', () => {
  it('worker exposes the unified Actor control surface', () => {
    const names = getAgentToolNames('worker');
    for (const name of [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
      'agent_output',
    ]) {
      expect(names).toContain(name);
    }
    for (const retired of ['dispatch_child_task', 'task_stop', 'task_output']) {
      expect(names).not.toContain(retired);
    }
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

describe('FEATURE_250 — managed-path progressive disclosure (deferred hint-swap)', () => {
  const MCP_SET = new Set<string>([...MCP_TOOL_NAMES]);

  function workerTools(): Array<{ name: string; description?: string }> {
    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    return (chain.worker.tools ?? []) as Array<{ name: string; description?: string }>;
  }
  function workerTool(name: string): { name: string; description?: string } | undefined {
    return workerTools().find((t) => t.name === name);
  }

  it('every deferred non-mcp tool on the worker shows its one-line searchHint (not the full description)', () => {
    const deferredPresent = workerTools().filter(
      (t) => DEFERRED_TOOL_HINTS[t.name] !== undefined && !MCP_SET.has(t.name),
    );
    // repo-intel (6) + web/code (4) are always wired to the worker, so the
    // deferred-on-worker set is non-trivial.
    expect(deferredPresent.length).toBeGreaterThanOrEqual(10);
    for (const t of deferredPresent) {
      expect(t.description, `${t.name} should be hint-swapped to its searchHint`).toBe(
        DEFERRED_TOOL_HINTS[t.name],
      );
    }
  });

  it('the searchHint is a strict shrink of the full description (real token savings)', () => {
    // Sanity that the swap actually reduces bytes — not a no-op.
    for (const name of ['module_context', 'web_fetch', 'code_search']) {
      const hint = DEFERRED_TOOL_HINTS[name]!;
      const full = getToolDefinition(name)?.description ?? '';
      expect(hint.length, `${name} hint should be shorter than full`).toBeLessThan(full.length);
      expect(workerTool(name)?.description).toBe(hint);
    }
  });

  it('mcp_* tools stay resident with their full description (NOT hint-swapped — mutation risk / uneval\'d)', () => {
    for (const name of MCP_TOOL_NAMES) {
      const tool = workerTool(name);
      expect(tool, `worker missing mcp tool ${name}`).toBeTruthy();
      expect(tool!.description, `${name} must NOT be hint-swapped`).not.toBe(DEFERRED_TOOL_HINTS[name]);
      expect(tool!.description).toBe(getToolDefinition(name)?.description);
    }
  });

  it('tool_search is wired (the fetch path for deferred schemas) with its own full description', () => {
    const tool = workerTool('tool_search');
    expect(tool, 'worker missing tool_search').toBeTruthy();
    expect(tool!.description).toBe(getToolDefinition('tool_search')?.description);
  });

  it('portable bridge meta-tools are executable on the managed path', async () => {
    cleanupToolRegistrations.push(registerTool({
      name: 'managed_bridge_target',
      description: 'Managed bridge test target.',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      handler: async (input) => `managed-target:${String(input.value)}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    }));

    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    const tools = (chain.worker.tools ?? []) as Array<{
      name: string;
      execute?: (input: Record<string, unknown>, ctx: { agent: typeof chain.worker; toolCallId: string }) => Promise<{ content: string | readonly unknown[] }>;
    }>;
    const describeTool = tools.find((tool) => tool.name === 'tool_describe');
    const callTool = tools.find((tool) => tool.name === 'tool_call');

    expect(describeTool?.execute, 'worker missing executable tool_describe').toBeTypeOf('function');
    expect(callTool?.execute, 'worker missing executable tool_call').toBeTypeOf('function');

    const describeResult = await describeTool!.execute!(
      { name: 'managed_bridge_target' },
      { agent: chain.worker, toolCallId: 'describe-1' },
    );
    expect(String(describeResult.content)).toContain('"name":"managed_bridge_target"');
    expect(String(describeResult.content)).toContain('Managed bridge test target.');

    const callResult = await callTool!.execute!(
      { name: 'managed_bridge_target', input: { value: 'ok' } },
      { agent: chain.worker, toolCallId: 'call-1' },
    );
    expect(callResult.content).toBe('managed-target:ok');
  });

  it('managed tool_describe preserves every requested schema without character caps', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `managed_full_schema_${index}`);
    for (const [index, name] of names.entries()) {
      cleanupToolRegistrations.push(registerTool({
        name,
        description: index === 8
          ? `large-start-${'detail '.repeat(2_400)}large-end`
          : `schema ${index}`,
        input_schema: { type: 'object', properties: {} },
        handler: async () => 'ok',
        sideEffect: 'readonly',
        toClassifierInput: () => '',
      }));
    }

    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    const describeTool = (chain.worker.tools ?? []).find((tool) => tool.name === 'tool_describe') as {
      execute?: (input: Record<string, unknown>, ctx: { agent: typeof chain.worker; toolCallId: string }) => Promise<{ content: string | readonly unknown[] }>;
    } | undefined;
    const result = await describeTool!.execute!(
      { names },
      { agent: chain.worker, toolCallId: 'describe-full' },
    );
    const content = String(result.content);

    expect(content).toContain('"name":"managed_full_schema_8"');
    expect(content).toContain('large-start-');
    expect(content).toContain('large-end');
    expect(content).not.toContain('tool_describe output truncated');
  });

  it('non-deferred tools keep their full description (e.g. bash)', () => {
    expect(workerTool('bash')?.description).toBe(getToolDefinition('bash')?.description);
  });

  it('input_schema is UNCHANGED by the hint-swap (tool stays directly callable off the hint)', () => {
    for (const name of ['module_context', 'web_fetch']) {
      const tool = workerTool(name) as { input_schema?: unknown } | undefined;
      expect(tool?.input_schema).toEqual(getToolDefinition(name)?.input_schema);
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
