import { describe, expect, it } from 'vitest';

import { createAgentExecutorPlane, createMemoryAgentExecutorPlaneStore } from './executor-plane.js';
import { createReferenceAgentExecutorFactory } from './reference-executor.js';
import type { ExternalAgentRegistration } from './types.js';

function registration(
  agentId: string,
  executorConfig: Readonly<Record<string, unknown>>,
): ExternalAgentRegistration {
  return {
    agentId,
    displayName: agentId,
    enabled: true,
    executorId: 'reference-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: `sha256:${agentId}`,
    executorConfig,
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

describe('FEATURE_258 reference external executor', () => {
  it('proves dispatch -> events -> output and idempotent start', async () => {
    let remoteCounter = 0;
    const plane = await createAgentExecutorPlane({
      factories: [createReferenceAgentExecutorFactory({
        executorId: 'reference-http',
        protocol: 'http',
        createRemoteTaskId: () => `remote-${++remoteCounter}`,
      })],
      policy: async () => ({ allowed: true }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration('external:echo', { output: 'reference-result' }));

    const first = await plane.tasks.start({
      taskId: 'local-1',
      agentId: 'external:echo',
      objective: 'echo',
      idempotencyKey: 'idem-shared',
      context: { actorId: 'actor-1' },
    });
    const completed = await plane.tasks.wait(first.taskId, 1_000);
    expect(completed.state).toBe('completed');
    expect(completed.output).toBe('reference-result');

    const second = await plane.tasks.start({
      taskId: 'local-2',
      agentId: 'external:echo',
      objective: 'echo again',
      idempotencyKey: 'idem-shared',
      context: { actorId: 'actor-1' },
    });
    expect(second.remoteTaskId).toBe(first.remoteTaskId);
    expect(remoteCounter).toBe(1);
  });

  it('proves input-required -> sendInput -> completed and confirmed cancel', async () => {
    const plane = await createAgentExecutorPlane({
      factories: [createReferenceAgentExecutorFactory({
        executorId: 'reference-http',
        protocol: 'http',
      })],
      policy: async () => ({ allowed: true }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration('external:interactive', {
      inputRequired: true,
      inputPrefix: 'answer:',
    }));

    const started = await plane.tasks.start({
      agentId: 'external:interactive',
      objective: 'ask',
      context: { actorId: 'actor-1' },
    });
    expect((await plane.tasks.get(started.taskId)).state).toBe('input-required');
    await plane.tasks.sendInput(started.taskId, { content: '42' });
    const completed = await plane.tasks.wait(started.taskId, 1_000);
    expect(completed.output).toBe('answer:42');

    const cancellable = await plane.tasks.start({
      taskId: 'cancel-me',
      agentId: 'external:interactive',
      objective: 'ask again',
      context: { actorId: 'actor-1' },
    });
    const canceled = await plane.tasks.cancel(cancellable.taskId, 'not needed');
    expect(canceled.state).toBe('canceled');
    expect(canceled.cancellation).toBe('confirmed');
  });
});
