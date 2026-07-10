import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../child-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../child-executor.js')>();
  return {
    ...actual,
    executeChildAgents: vi.fn(async (bundles: readonly { readonly id: string; readonly objective: string }[]) => ({
      results: bundles.map((bundle) => ({
        childId: bundle.id,
        fanoutClass: 'evidence-scan' as const,
        status: 'completed' as const,
        disposition: 'valid' as const,
        summary: 'local-ok',
        evidenceRefs: [],
        contradictions: [],
      })),
      mergedFindings: bundles.map((bundle) => ({
        childId: bundle.id,
        objective: bundle.objective,
        evidence: ['local-ok'],
        artifacts: [],
      })),
      mergedArtifacts: [],
      totalTokensUsed: 3,
      cancelledChildren: [],
    })),
  };
});

import {
  createAgentExecutorPlane,
  createMemoryAgentExecutorPlaneStore,
  createReferenceAgentExecutorFactory,
  _resetMessageQueueForTests,
} from '@kodax-ai/agent';

import type { ExternalAgentRegistration } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolDispatchChildTask } from './dispatch-child-tasks.js';
import { toolListDispatchableAgents } from './list-dispatchable-agents.js';
import { toolSendMessage } from './send-message.js';
import { toolTaskOutput } from './task-output.js';
import { toolTaskStop } from './task-stop.js';
import { getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';

function registration(
  agentId: string,
  config: Readonly<Record<string, unknown>>,
): ExternalAgentRegistration {
  return {
    agentId,
    displayName: agentId,
    enabled: true,
    executorId: 'reference-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: `sha256:${agentId}`,
    executorConfig: config,
    skills: ['risk-review'],
    capabilities: {
      streaming: 'supported',
      durableTasks: 'supported',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'read', workspace: 'proposal' },
  };
}

async function consume(
  generator: AsyncGenerator<{ readonly message: string }, string, void>,
): Promise<string> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

async function createContext(): Promise<KodaXToolExecutionContext> {
  const plane = await createAgentExecutorPlane({
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'reference-http',
      protocol: 'http',
    })],
    policy: async () => ({ allowed: true }),
    store: createMemoryAgentExecutorPlaneStore(),
  });
  await plane.registrations.upsert(registration('external:risk', {
    output: 'risk-ok',
    artifactName: 'risk.json',
    artifactUri: 'https://remote.example/risk.json',
    artifactHash: 'sha256:risk',
    totalTokens: 7,
  }));
  await plane.registrations.upsert(registration('external:interactive', {
    inputRequired: true,
    inputPrefix: 'answer:',
  }));
  return {
    backups: new Map(),
    managedProtocolRole: 'worker',
    childTaskRegistry: new Map(),
    childAbortControllers: new Map(),
    childProgressSnapshots: new Map(),
    agentExecutorPlane: {
      plane,
      context: { actorId: 'actor-1', projectId: 'project-1', parentTaskId: 'parent-1' },
    },
  };
}

afterEach(() => {
  _resetMessageQueueForTests();
});

describe('FEATURE_258 Worker external-agent bridge', () => {
  it('keeps discovery out of the model-visible tool surface when no plane is bound', () => {
    const names = ['read', 'list_dispatchable_agents'];
    expect(getActiveToolDefinitions(names).map((tool) => tool.name)).toEqual(['read']);
    expect(getActiveToolDefinitions(
      names,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      true,
    ).map((tool) => tool.name)).toEqual(expect.arrayContaining(names));
  });

  it('lists and dispatches the same canonical external agent ID', async () => {
    const ctx = await createContext();
    const listed = await toolListDispatchableAgents({}, ctx);
    expect(listed).toContain('external:risk');
    expect(listed).toContain('native:kodax-child');

    const response = await consume(toolDispatchChildTask({
      id: 'external-child-1',
      objective: 'Review risk',
      agent_id: 'external:risk',
    }, ctx));
    expect(response).toContain('task_id:external-child-1');
    const completed = await ctx.agentExecutorPlane!.plane.tasks.wait('external-child-1', 1_000);
    expect(completed.output).toBe('risk-ok');

    const output = await toolTaskOutput({ task_id: 'external-child-1', block: true }, ctx);
    expect(output).toContain('<status>completed</status>');
    expect(output).toContain('risk-ok');
    expect(output).toContain('<artifacts>');
    expect(output).toContain('external:risk');
    expect(output).toContain('<usage>{"totalTokens":7}</usage>');
  });

  it('routes send_message and task_stop through the external task ledger', async () => {
    const ctx = await createContext();
    await consume(toolDispatchChildTask({
      id: 'external-interactive-1',
      objective: 'Ask for input',
      agent_id: 'external:interactive',
    }, ctx));
    expect((await ctx.agentExecutorPlane!.plane.tasks.get('external-interactive-1')).state)
      .toBe('input-required');

    expect(await toolSendMessage({ to: 'external-interactive-1', content: '42' }, ctx))
      .toContain('Message sent');
    expect((await ctx.agentExecutorPlane!.plane.tasks.wait('external-interactive-1', 1_000)).output)
      .toBe('answer:42');

    await consume(toolDispatchChildTask({
      id: 'external-stop-1',
      objective: 'Wait for input',
      agent_id: 'external:interactive',
    }, ctx));
    expect(await toolTaskStop({ task_id: 'external-stop-1', reason: 'done' }, ctx))
      .toContain('confirmed');
    expect((await ctx.agentExecutorPlane!.plane.tasks.get('external-stop-1')).state)
      .toBe('canceled');
  });

  it('returns a correctable error when both selectors are supplied', async () => {
    const ctx = await createContext();
    const response = await consume(toolDispatchChildTask({
      objective: 'invalid',
      agent_id: 'external:risk',
      subagent_type: 'db-reviewer',
    }, ctx));
    expect(response).toMatch(/Tool Error.*agent_id.*subagent_type/i);
    expect(await ctx.agentExecutorPlane!.plane.tasks.list()).toEqual([]);
  });

  it('mirrors the named native path into the same ledger without changing its executor', async () => {
    const ctx = await createContext();
    const response = await consume(toolDispatchChildTask({
      id: 'native-child-1',
      objective: 'Inspect locally',
      agent_id: 'native:kodax-child',
    }, ctx));
    expect(response).toContain('task_id:native-child-1');
    const promise = ctx.childTaskRegistry?.get('native-child-1');
    if (promise) await promise;
    const task = await ctx.agentExecutorPlane!.plane.tasks.get('native-child-1');
    expect(task).toMatchObject({
      route: 'local',
      agentId: 'native:kodax-child',
      state: 'completed',
      output: 'local-ok',
    });
  });
});
