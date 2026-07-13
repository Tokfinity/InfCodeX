import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgent, type ToolGuardrail } from '@kodax-ai/agent';
import { registerTool } from '@kodax-ai/coding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRuntimeAgentBindingService,
  type RuntimeAgentBindingHost,
  type RuntimeExecutionToolPolicy,
} from './runtime-agent-binding.js';
import type { RuntimeStartRunInput } from './sdk-runtime.js';

let home: string;
let workspace: string;
let starts: RuntimeStartRunInput[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'kodax-runtime-agent-'));
  workspace = path.join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  starts = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function policy(overrides: Partial<RuntimeExecutionToolPolicy> = {}): RuntimeExecutionToolPolicy {
  return {
    workspace: 'write',
    process: 'deny',
    network: { mode: 'deny' },
    tools: [],
    mcp: {},
    skillScripts: {},
    subagents: 'deny',
    ...overrides,
  };
}

function writeAgent(input: { readonly tools: string; readonly skills: string }): void {
  const dir = path.join(home, '.kodax', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'office-agent.md'), [
    '---',
    'name: office-agent',
    'description: Completes office tasks',
    `tools: ${input.tools}`,
    `skills: ${input.skills}`,
    'model: bound-model',
    'effort: high',
    '---',
    'You are a general office agent.',
  ].join('\n'));
}

function writeSkill(): void {
  const dir = path.join(home, '.kodax', 'skills', 'office-reports');
  mkdirSync(path.join(dir, 'references'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: office-reports',
    'description: Create office reports',
    '---',
    'Follow the reporting workflow.',
  ].join('\n'));
  writeFileSync(path.join(dir, 'references', 'format.md'), 'Pinned format.');
  writeFileSync(path.join(dir, 'scripts', 'render.mjs'), 'process.stdout.write("rendered")');
}

function host(): RuntimeAgentBindingHost {
  return {
    configHome: path.join(home, '.kodax'),
    managedWorkspaceRoot: path.join(home, 'kodax_a2a_server_workspace'),
    defaultProvider: 'test-provider',
    defaultModel: 'test-model',
    sessions: {
      async load(sessionId) {
        return { id: sessionId, title: '', workspaceRoot: workspace };
      },
    },
    runs: {
      async start(input) {
        starts.push(input);
        return {
          runId: 'run-1',
          sessionId: input.sessionId,
          result: Promise.resolve({ runId: 'run-1', sessionId: input.sessionId, phase: 'completed' }),
        };
      },
    },
  };
}

describe('FEATURE_267 Runtime local Agent binding', () => {
  it('pins a user Markdown Agent, selected Skills, tools, and run options', async () => {
    writeAgent({ tools: '[read, grep, write, skill]', skills: '[office-reports]' });
    writeSkill();
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });

    expect(binding.effectiveTools).toEqual(['grep', 'read', 'skill', 'write']);
    expect(binding.effectiveSkills).toMatchObject([{
      name: 'office-reports',
      source: 'user',
    }]);
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Create a report.' },
    });

    const options = starts[0]?.options;
    expect(options?.modelOverride).toBe('bound-model');
    expect(options?.effort).toBe('high');
    expect(options?.context?.systemPromptOverride).toBe('You are a general office agent.');
    expect(options?.context?.skillsPrompt).toContain('office-reports');
    expect(options?.context?.toolVisibilityPolicy?.({
      name: 'bash', sideEffect: 'mutates-shell', planModeAllowed: false,
    })).toBe(false);
    expect(options?.events?.beforeToolExecute).toBeTypeOf('function');
    await expect(options?.events?.beforeToolExecute?.('read', { path: 'report.md' }))
      .resolves.toBe(true);
  });

  it('blocks path escape and secret-bearing reads at call time', async () => {
    writeAgent({ tools: '[read]', skills: '[]' });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy({ workspace: 'read' }),
    });
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Read files.' },
    });
    const guardrail = starts[0]?.options?.guardrails?.[0] as ToolGuardrail;
    const agent = createAgent({ name: 'test', instructions: '' });

    await expect(guardrail.beforeTool?.({
      id: '1', name: 'read', input: { path: path.join(workspace, '..', 'outside.txt') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: '2', name: 'read', input: { path: path.join(workspace, '.env') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: '3', name: 'read', input: { path: path.join(workspace, 'report.txt') },
    }, { agent })).resolves.toEqual({ action: 'allow' });
  });

  it('blocks existing and not-yet-created paths that escape through a workspace link', async () => {
    const outside = path.join(home, 'outside');
    const linked = path.join(workspace, 'linked');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    writeAgent({ tools: '[read, write]', skills: '[]' });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Inspect and write files.' },
    });
    const guardrail = starts[0]?.options?.guardrails?.[0] as ToolGuardrail;
    const agent = createAgent({ name: 'test', instructions: '' });

    await expect(guardrail.beforeTool?.({
      id: 'linked-read', name: 'read', input: { path: path.join(linked, 'secret.txt') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: 'linked-write', name: 'write', input: { path: path.join(linked, 'new.txt'), content: 'x' },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
  });

  it('rejects non-native tools that lack an explicit remote contract', async () => {
    const unregister = registerTool({
      name: 'unsafe-office-tool',
      description: 'Unclassified tool',
      input_schema: { type: 'object', properties: {}, required: [] },
      sideEffect: 'mutates-state',
      toClassifierInput: () => '',
      handler: async () => 'ok',
    });
    try {
      writeAgent({ tools: '[unsafe-office-tool]', skills: '[]' });
      const service = createRuntimeAgentBindingService(host());
      const owner = await service.openOwnerSession();
      await expect(service.bindLocal({
        ownerSessionId: owner.ownerSessionId,
        ref: { source: 'markdown:user', name: 'office-agent' },
        workspace: { mode: 'fixed', root: workspace },
        toolPolicy: policy({ tools: ['unsafe-office-tool'] }),
      })).rejects.toThrow(/remote contract/i);
    } finally {
      unregister();
    }
  });

  it('admits exact Skill scripts through a run-scoped isolated broker', async () => {
    writeAgent({ tools: '[skill, run_skill_script]', skills: '[office-reports]' });
    writeSkill();
    const runner = { run: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined) };
    const testHost = host();
    const createSkillScriptRunner = vi.fn(async () => runner);
    const service = createRuntimeAgentBindingService({ ...testHost, createSkillScriptRunner });
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy({
        process: 'isolated',
        skillScripts: { 'office-reports': ['scripts/render.mjs'] },
      }),
    });

    expect(binding.effectiveTools).toEqual(['run_skill_script', 'skill']);
    expect(createSkillScriptRunner).toHaveBeenCalledWith(expect.objectContaining({
      admissions: { 'office-reports': ['scripts/render.mjs'] },
    }));
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Render the report.' },
    });
    expect(starts[0]?.options?.context?.skillScriptRunner).toBe(runner);
    await service.closeOwnerSession(owner.ownerSessionId);
    expect(runner.dispose).toHaveBeenCalledOnce();
  });

  it('rejects malformed process and script authority for direct SDK callers', async () => {
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    await expect(service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'managed' },
      toolPolicy: policy({ skillScripts: { reports: ['scripts/render.py'] } }),
    })).rejects.toThrow(/enabled together/i);
  });
});
