import { describe, expect, it, vi } from 'vitest';

import {
  createAgentExecutorPlane,
  createMemoryAgentExecutorPlaneStore,
  createReferenceAgentExecutorFactory,
} from '@kodax-ai/agent';
import type { ExternalAgentRegistration } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';
import { createCodingWorkflowBackend } from './agent-adapter.js';

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

async function context(): Promise<KodaXToolExecutionContext> {
  const plane = await createAgentExecutorPlane({
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'reference-http',
      protocol: 'http',
    })],
    policy: async () => ({ allowed: true }),
    store: createMemoryAgentExecutorPlaneStore(),
  });
  await plane.registrations.upsert(registration('external:workflow', { output: 'workflow-ok' }));
  await plane.registrations.upsert(registration('external:workflow-input', {
    inputRequired: true,
    inputPrefix: 'continued:',
  }));
  return {
    backups: new Map(),
    childTaskRegistry: new Map(),
    childAbortControllers: new Map(),
    childProgressSnapshots: new Map(),
    agentExecutorPlane: {
      plane,
      context: { actorId: 'actor-1', projectId: 'project-1' },
    },
  };
}

describe('FEATURE_258 Workflow external target', () => {
  it('routes target through the shared plane without invoking the local child executor', async () => {
    const ctx = await context();
    const runChild = vi.fn(async () => {
      throw new Error('local child executor must not run');
    });
    const backend = createCodingWorkflowBackend({
      ctx,
      runId: 'workflow-run-1',
      childOptions: {
        maxIterationsPerChild: 10,
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
        parentOptions: {},
      },
      runChild,
      generateId: () => 'workflow-external-1',
    });

    const handle = await backend.spawn({
      name: 'risk',
      prompt: 'Review risk',
      readOnly: true,
      target: { agentId: 'external:workflow', expectedConfigurationRevision: 'rev-1' },
    });
    const result = await backend.wait(handle.taskId);
    expect(result).toMatchObject({
      taskId: 'workflow-external-1',
      name: 'risk',
      status: 'completed',
      finalText: 'workflow-ok',
    });
    expect(runChild).not.toHaveBeenCalled();
    expect(await ctx.agentExecutorPlane!.plane.tasks.get(handle.taskId)).toMatchObject({
      workflowId: 'workflow-run-1',
      agentId: 'external:workflow',
    });
  });

  it('keeps identity across input and cancel and rejects conflicting local routing', async () => {
    const ctx = await context();
    let counter = 0;
    const backend = createCodingWorkflowBackend({
      ctx,
      runId: 'workflow-run-2',
      childOptions: {
        maxIterationsPerChild: 10,
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
        parentOptions: {},
      },
      generateId: () => `workflow-external-${++counter}`,
    });
    const interactive = await backend.spawn({
      name: 'interactive',
      prompt: 'Ask',
      target: { agentId: 'external:workflow-input' },
    });
    expect((await backend.output(interactive.taskId)).status).toBe('running');
    await backend.send(interactive.taskId, '42');
    expect((await backend.wait(interactive.taskId)).finalText).toBe('continued:42');

    const stopped = await backend.spawn({
      name: 'stop',
      prompt: 'Wait',
      target: { agentId: 'external:workflow-input' },
    });
    await backend.stop(stopped.taskId, 'done');
    expect((await backend.wait(stopped.taskId)).status).toBe('stopped');

    await expect(backend.spawn({
      name: 'conflict',
      prompt: 'Invalid',
      subagentType: 'db-reviewer',
      target: { agentId: 'external:workflow' },
    })).rejects.toThrow(/target.*subagentType/i);
  });
});
