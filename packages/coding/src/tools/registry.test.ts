import { describe, expect, it } from 'vitest';
import {
  executeTool,
  getAllRegisteredTools,
  getTool,
  getRequiredToolParams,
  getToolDefinition,
  isToolFileMutation,
  isToolMutation,
  isToolPlanModeAllowed,
  listBuiltinToolDefinitions,
  registerTool,
} from './index.js';
import type { KodaXToolExecutionContext } from '../types.js';

const TEST_CONTEXT: KodaXToolExecutionContext = {
  backups: new Map(),
  executionCwd: process.cwd(),
};

describe('tool registry', () => {
  it('FEATURE_075: exit_plan_mode plan description enforces structural length budget', () => {
    // LLM-first defense against oversized plans that blow past terminal
    // height. Scroll in the approval dialog is the mechanical fallback.
    // FEATURE_189 Batch 4 audit kept the quantitative anchors here: 3-judge
    // pilot showed dropping "40 lines / 3 depth / 1 sentence per bullet"
    // triggers verbosity drift (multi-paragraph bullets / >5000 chars). The
    // anchor is load-bearing for this tool description.
    const def = getToolDefinition('exit_plan_mode');
    const planSchema = (def?.input_schema as {
      properties?: { plan?: { description?: string } };
    } | undefined)?.properties?.plan;
    const desc = planSchema?.description ?? '';

    expect(desc).toMatch(/40 lines/);
    expect(desc).toMatch(/3 bullet-depth|3 levels|3 depth/i);
    expect(desc).toMatch(/one sentence|1 sentence|single sentence/i);
    expect(desc).toMatch(/phases|split/i);
  });

  it('FEATURE_191 A.1: dispatch_child_task schema exposes optional subagent_type field', () => {
    // User-Authored Custom Agents — Worker selects a registered specialist
    // by name to route the child through that agent's instructions/tools.
    // Optional so existing dispatch sites (no subagent_type) remain
    // byte-identical with v0.7.42 baseline.
    const def = getToolDefinition('dispatch_child_task');
    const props = (def?.input_schema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: readonly string[];
    } | undefined)?.properties;
    const required = (def?.input_schema as { required?: readonly string[] } | undefined)?.required ?? [];

    expect(props).toBeDefined();
    expect(props?.subagent_type).toBeDefined();
    expect(props?.subagent_type?.type).toBe('string');
    expect(required).not.toContain('subagent_type');
    // Qualitative description per ADR-033 §1 — no enumerated agent names,
    // no ✗ anti-pattern, no FEATURE_xxx version tag in LLM-facing surface.
    expect(props?.subagent_type?.description).toBeTruthy();
    expect(props?.subagent_type?.description).not.toMatch(/✗|FEATURE_\d/);
  });

  it('FEATURE_191 A.0: KodaXChildContextBundle declares optional specialistName field', () => {
    // Type-level guard — the bundle must carry specialistName from
    // toolDispatchChildTask through executeChildAgents to
    // executeReadChild/executeWriteChild. Compile-time check via
    // structural assignment in TypeScript; runtime smoke verifies the
    // field accepts a string.
    const bundle: import('../types.js').KodaXChildContextBundle = {
      id: 'test',
      fanoutClass: 'read' as import('../types.js').KodaXAmaFanoutClass,
      objective: 'noop',
      evidenceRefs: [],
      constraints: [],
      readOnly: true,
      specialistName: 'db-reviewer',
    };
    expect(bundle.specialistName).toBe('db-reviewer');
  });

  it('FEATURE_191 A.0b: AgentContent declares optional description field', () => {
    // Compile-time check via structural assignment; runtime asserts the
    // object accepts the field. Aligns with FEATURE_089 minimal-agent
    // pattern (only `instructions` required).
    const content: import('../construction/types.js').AgentContent = {
      instructions: 'noop',
      description: 'Reviews DB migrations for safety',
    };
    expect(content.description).toBe('Reviews DB migrations for safety');
  });

  it('derives required params from the active tool schema', () => {
    expect(getRequiredToolParams('read')).toEqual(['path']);
    expect(getRequiredToolParams('ask_user_question')).toEqual(['question']);
    expect(getRequiredToolParams('web_search')).toEqual(['query']);
    expect(getRequiredToolParams('code_search')).toEqual(['query']);
    expect(getRequiredToolParams('semantic_lookup')).toEqual(['query']);
    expect(getRequiredToolParams('mcp_search')).toEqual([]);
    expect(getRequiredToolParams('mcp_describe')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_call')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_read_resource')).toEqual(['id']);
    expect(getRequiredToolParams('changed_diff')).toEqual(['path']);
    expect(getRequiredToolParams('changed_diff_bundle')).toEqual(['paths']);
    expect(getRequiredToolParams('insert_after_anchor')).toEqual(['path', 'anchor', 'content']);
  });

  it('supports same-name override and restore via disposer', async () => {
    const originalHandler = getTool('read');
    const dispose = registerTool({
      name: 'read',
      description: 'Test override',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: async (input) => `override:${String(input.path)}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    });

    await expect(
      executeTool('read', { path: '/tmp/demo.txt' }, TEST_CONTEXT),
    ).resolves.toBe('override:/tmp/demo.txt');

    dispose();

    expect(getTool('read')).toBe(originalHandler);
  });
});

// v0.7.42 — tool sideEffect metadata + plan-mode-allowed predicate.
//
// Closes gap 2 (KodaX Space): every built-in tool now declares
// `sideEffect` and (optionally) `planModeAllowed`, so SDK consumers can
// build dynamic blocklists instead of hardcoding tool-name `Set`s that
// silently drift.
describe('v0.7.42 — tool sideEffect metadata', () => {
  it('every built-in tool declares a sideEffect', () => {
    const builtins = listBuiltinToolDefinitions();
    expect(builtins.length).toBeGreaterThan(20); // sanity: shouldn't shrink
    for (const tool of builtins) {
      expect(
        tool.sideEffect,
        `built-in tool "${tool.name}" is missing sideEffect`,
      ).toBeDefined();
      expect(
        ['readonly', 'mutates-fs', 'mutates-shell', 'mutates-network', 'mutates-state'],
      ).toContain(tool.sideEffect);
    }
  });

  it('classifies read/glob/grep as readonly', () => {
    for (const name of ['read', 'glob', 'grep', 'code_search', 'todo_list', 'todo_get']) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(tool?.sideEffect, `${name} sideEffect`).toBe('readonly');
    }
  });

  it('classifies write/edit/multi_edit/insert_after_anchor/undo as mutates-fs', () => {
    for (const name of ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo']) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(tool?.sideEffect, `${name} sideEffect`).toBe('mutates-fs');
    }
  });

  it('classifies bash as mutates-shell (its own category)', () => {
    const bash = listBuiltinToolDefinitions().find((t) => t.name === 'bash');
    expect(bash?.sideEffect).toBe('mutates-shell');
  });

  it('classifies web_fetch + mcp_call as mutates-network', () => {
    const webFetch = listBuiltinToolDefinitions().find((t) => t.name === 'web_fetch');
    const mcpCall = listBuiltinToolDefinitions().find((t) => t.name === 'mcp_call');
    expect(webFetch?.sideEffect).toBe('mutates-network');
    expect(mcpCall?.sideEffect).toBe('mutates-network');
  });

  it('marks plan-loop tools planModeAllowed: true', () => {
    const planLoopTools = [
      'exit_plan_mode',
      'task_stop',
      'task_output',
      'todo_update',
      'todo_create',
      'todo_list',
      'todo_get',
      'ask_user_question',
    ];
    for (const name of planLoopTools) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should be planModeAllowed: true`,
      ).toBe(true);
    }
  });

  it('marks network-query tools planModeAllowed: true (research-during-plan)', () => {
    const queryTools = ['web_search', 'mcp_search', 'mcp_describe', 'mcp_read_resource', 'mcp_get_prompt'];
    for (const name of queryTools) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should be planModeAllowed: true (network query)`,
      ).toBe(true);
    }
  });

  it('does NOT mark mutating network/FS tools planModeAllowed', () => {
    const blockedInPlan = ['web_fetch', 'mcp_call', 'write', 'edit', 'multi_edit', 'worktree_create'];
    for (const name of blockedInPlan) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should NOT be planModeAllowed`,
      ).not.toBe(true);
    }
  });
});

describe('v0.7.42 — query API for SDK embedders', () => {
  it('getAllRegisteredTools returns every active registration sorted by name', () => {
    const all = getAllRegisteredTools();
    expect(all.length).toBeGreaterThan(20);
    const names = all.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('bash');
  });

  it('isToolPlanModeAllowed: readonly tools permitted', () => {
    expect(isToolPlanModeAllowed('read')).toBe(true);
    expect(isToolPlanModeAllowed('glob')).toBe(true);
    expect(isToolPlanModeAllowed('grep')).toBe(true);
  });

  it('isToolPlanModeAllowed: explicit planModeAllowed:true overrides non-readonly', () => {
    expect(isToolPlanModeAllowed('exit_plan_mode')).toBe(true);
    expect(isToolPlanModeAllowed('todo_update')).toBe(true);
    expect(isToolPlanModeAllowed('task_stop')).toBe(true);
    expect(isToolPlanModeAllowed('web_search')).toBe(true);
  });

  it('isToolPlanModeAllowed: mutating tools without override blocked', () => {
    expect(isToolPlanModeAllowed('write')).toBe(false);
    expect(isToolPlanModeAllowed('edit')).toBe(false);
    expect(isToolPlanModeAllowed('multi_edit')).toBe(false);
    expect(isToolPlanModeAllowed('bash')).toBe(false);
    expect(isToolPlanModeAllowed('worktree_create')).toBe(false);
    expect(isToolPlanModeAllowed('dispatch_child_task')).toBe(false);
    expect(isToolPlanModeAllowed('web_fetch')).toBe(false);
    expect(isToolPlanModeAllowed('mcp_call')).toBe(false);
  });

  it('isToolPlanModeAllowed: unknown tools fail-closed (blocked)', () => {
    expect(isToolPlanModeAllowed('this_tool_does_not_exist')).toBe(false);
    expect(isToolPlanModeAllowed('')).toBe(false);
  });

  it('isToolFileMutation: only mutates-fs tools', () => {
    expect(isToolFileMutation('write')).toBe(true);
    expect(isToolFileMutation('edit')).toBe(true);
    expect(isToolFileMutation('multi_edit')).toBe(true);
    expect(isToolFileMutation('insert_after_anchor')).toBe(true);
    expect(isToolFileMutation('undo')).toBe(true);
    expect(isToolFileMutation('worktree_create')).toBe(true);

    expect(isToolFileMutation('read')).toBe(false);
    expect(isToolFileMutation('bash')).toBe(false); // mutates-shell, not mutates-fs
    expect(isToolFileMutation('web_search')).toBe(false);
    expect(isToolFileMutation('dispatch_child_task')).toBe(false);
  });

  it('isToolMutation: anything non-readonly returns true', () => {
    expect(isToolMutation('write')).toBe(true);
    expect(isToolMutation('bash')).toBe(true);
    expect(isToolMutation('web_fetch')).toBe(true);
    expect(isToolMutation('dispatch_child_task')).toBe(true);
    expect(isToolMutation('exit_plan_mode')).toBe(true); // mutates-state

    expect(isToolMutation('read')).toBe(false);
    expect(isToolMutation('grep')).toBe(false);
    expect(isToolMutation('todo_list')).toBe(false);

    // Unknown: fail-closed (assume mutating)
    expect(isToolMutation('totally_unknown_tool')).toBe(true);
  });
});
