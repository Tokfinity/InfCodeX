import { describe, expect, it } from 'vitest';

import {
  AgentStartUncertainError,
  createAgentExecutorPlane,
  createMemoryAgentExecutorPlaneStore,
} from './executor-plane.js';
import type {
  AgentDispatchPolicy,
  AgentExecutor,
  AgentExecutorFactory,
  AgentExecutorFactoryContext,
  AgentExecutorTaskReference,
  AgentExecutorTaskSnapshot,
  AgentTaskStartInput,
  ExternalAgentRegistration,
} from './types.js';

const CAPABILITIES = {
  streaming: 'supported',
  durableTasks: 'supported',
  inputRequired: 'supported',
  cancellation: 'supported',
  artifacts: 'supported',
} as const;

const EFFECTS = {
  remote: 'read',
  workspace: 'proposal',
} as const;

function registration(
  patch: Partial<ExternalAgentRegistration> = {},
): ExternalAgentRegistration {
  return {
    agentId: 'external:risk-reviewer',
    displayName: 'Risk Reviewer',
    description: 'Reviews customer risk.',
    enabled: true,
    executorId: 'fake-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:endpoint-a',
    credentialRef: 'credential:risk',
    skills: ['risk-review'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: CAPABILITIES,
    effects: EFFECTS,
    health: { status: 'healthy', checkedAt: '2026-07-10T00:00:00.000Z' },
    ...patch,
  };
}

function taskInput(
  patch: Partial<AgentTaskStartInput> = {},
): AgentTaskStartInput {
  return {
    agentId: 'external:risk-reviewer',
    objective: 'Assess account risk',
    context: { actorId: 'actor-1', projectId: 'project-1', parentTaskId: 'parent-1' },
    readOnly: true,
    ...patch,
  };
}

function allowAllPolicy(): AgentDispatchPolicy {
  return async () => ({ allowed: true });
}

class FakeExecutor implements AgentExecutor {
  readonly starts: AgentTaskStartInput[] = [];
  readonly sent: string[] = [];
  snapshot: AgentExecutorTaskSnapshot = {
    state: 'working',
    progress: { message: 'started', percent: 10 },
  };
  startError: Error | undefined;
  cancelError: Error | undefined;

  async start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference> {
    this.starts.push(input);
    if (this.startError) throw this.startError;
    return { idempotencyKey: input.idempotencyKey!, remoteTaskId: 'remote-1' };
  }

  async *events(): AsyncIterable<never> {
    return;
  }

  async get(): Promise<AgentExecutorTaskSnapshot> {
    return this.snapshot;
  }

  async sendInput(_reference: AgentExecutorTaskReference, input: { readonly content: string }): Promise<void> {
    this.sent.push(input.content);
  }

  async cancel(): Promise<AgentExecutorTaskSnapshot> {
    if (this.cancelError) throw this.cancelError;
    return this.snapshot;
  }

  async reconcile(): Promise<AgentExecutorTaskSnapshot> {
    return this.snapshot;
  }

  async dispose(): Promise<void> {}
}

function factory(executor: FakeExecutor): AgentExecutorFactory {
  return {
    executorId: 'fake-http',
    protocol: 'http',
    async create(
      _registration: ExternalAgentRegistration,
      _context: AgentExecutorFactoryContext,
    ) {
      return executor;
    },
  };
}

describe('FEATURE_258 AgentExecutorPlane', () => {
  it('registers, filters, dispatches and freezes the selected registration revision', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_ref, use) {
          return use('credential-secret');
        },
      },
      store: createMemoryAgentExecutorPlaneStore(),
      createTaskId: () => 'agent-task-1',
      createIdempotencyKey: () => 'idem-1',
    });

    await plane.registrations.upsert(registration());
    const listed = await plane.listDispatchable({
      actorId: 'actor-1',
      projectId: 'project-1',
      requiredSkills: ['risk-review'],
      requiredCapabilities: { cancellation: true },
      readOnly: true,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.descriptor.agentId).toBe('external:risk-reviewer');
    expect(JSON.stringify(listed)).not.toContain('credential-secret');

    const started = await plane.tasks.start(taskInput());
    expect(started.taskId).toBe('agent-task-1');
    expect(started.parentTaskId).toBe('parent-1');
    expect(started.registration.configurationRevision).toBe('rev-1');
    expect(started.remoteTaskId).toBe('remote-1');

    await plane.registrations.upsert(registration({ configurationRevision: 'rev-2' }));
    expect((await plane.tasks.get('agent-task-1')).registration.configurationRevision).toBe('rev-1');
    expect(executor.starts).toHaveLength(1);
    expect(executor.starts[0]?.idempotencyKey).toBe('idem-1');
  });

  it('fails closed before start for policy, credential, health, capability and read-only mismatches', async () => {
    const executor = new FakeExecutor();
    const denied = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: async () => ({ allowed: false, reasons: ['policy denied'] }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await denied.registrations.upsert(registration({ credentialRef: undefined }));
    expect(await denied.listDispatchable({ actorId: 'actor-1' })).toEqual([]);
    await expect(denied.tasks.start(taskInput())).rejects.toThrow(/policy denied/i);

    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      health: { status: 'unhealthy', checkedAt: '2026-07-10T00:00:00.000Z' },
      capabilities: { ...CAPABILITIES, cancellation: 'unsupported' },
      effects: { remote: 'write', workspace: 'proposal' },
    }));
    const preflight = await plane.preflight({
      agentId: 'external:risk-reviewer',
      query: {
        actorId: 'actor-1',
        readOnly: true,
        requiredCapabilities: { cancellation: true },
      },
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.reasons.join(' ')).toMatch(/credential|unhealthy|cancellation|read-only/i);
    expect(executor.starts).toHaveLength(0);
  });

  it('keeps cancel requested separate from confirmed, unsupported and failed', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const started = await plane.tasks.start(taskInput());
    executor.snapshot = { state: 'working' };
    expect((await plane.tasks.cancel(started.taskId, 'stop')).cancellation).toBe('requested');

    executor.snapshot = { state: 'canceled' };
    expect((await plane.tasks.cancel(started.taskId, 'stop')).cancellation).toBe('confirmed');

    const unsupported = await plane.registrations.upsert(registration({
      agentId: 'external:no-cancel',
      configurationRevision: 'rev-1',
      credentialRef: undefined,
      capabilities: { ...CAPABILITIES, cancellation: 'unsupported' },
    }));
    executor.snapshot = { state: 'working' };
    const unsupportedTask = await plane.tasks.start(taskInput({ agentId: unsupported.agentId }));
    expect((await plane.tasks.cancel(unsupportedTask.taskId, 'stop')).cancellation).toBe('unsupported');

    executor.cancelError = new Error('remote cancellation failed');
    const failed = await plane.tasks.start(taskInput({ taskId: 'cancel-failed' }));
    expect((await plane.tasks.cancel(failed.taskId, 'stop')).cancellation).toBe('failed');
  });

  it('reconciles an ambiguous start without issuing a second start', async () => {
    const executor = new FakeExecutor();
    executor.startError = new AgentStartUncertainError('response lost');
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
      createTaskId: () => 'uncertain-task',
      createIdempotencyKey: () => 'uncertain-idem',
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const started = await plane.tasks.start(taskInput());
    expect(started.state).toBe('unknown');
    expect(executor.starts).toHaveLength(1);

    executor.snapshot = { state: 'completed', output: 'recovered' };
    const recovered = await plane.tasks.reconcile(started.taskId);
    expect(recovered.state).toBe('completed');
    expect(recovered.output).toBe('recovered');
    expect(executor.starts).toHaveLength(1);
  });

  it('redacts credential content from failures and mirrors local tasks into the same ledger', async () => {
    const executor = new FakeExecutor();
    const secretFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(_registration, context) {
        return {
          ...executor,
          async start(input) {
            return context.withCredential('credential:risk', async (secret) => {
              throw new Error(`upstream rejected ${secret}`);
            });
          },
        } as AgentExecutor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [secretFactory],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_ref, use) {
          return use('TOP-SECRET');
        },
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration());
    const failed = await plane.tasks.start(taskInput({ taskId: 'redacted-task' }));
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('[REDACTED]');
    expect(JSON.stringify(failed)).not.toContain('TOP-SECRET');

    await plane.tasks.recordLocal({
      taskId: 'local-task',
      agentId: 'native:kodax-child',
      objective: 'Inspect files',
      parentTaskId: 'parent-1',
      configurationRevision: 'native-v1',
    });
    await plane.tasks.updateLocal('local-task', { state: 'completed', output: 'done' });
    const all = await plane.tasks.list({ parentTaskId: 'parent-1' });
    expect(all.map((task) => [task.taskId, task.route, task.state])).toContainEqual([
      'local-task',
      'local',
      'completed',
    ]);
  });

  it('fails closed when an executor asks to materialize an artifact', async () => {
    const executor = new FakeExecutor();
    let factoryContext: AgentExecutorFactoryContext | undefined;
    const artifactFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(_registration, context) {
        factoryContext = context;
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [artifactFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput());

    expect(factoryContext).toBeDefined();
    await expect(factoryContext!.authorizeArtifact({
      name: 'report.pdf',
      uri: 'https://remote.example/report.pdf',
    })).rejects.toThrow(/not authorized/i);

    const allowedPlane = await createAgentExecutorPlane({
      factories: [artifactFactory],
      policy: allowAllPolicy(),
      artifactPolicy: ({ artifact }) => ({ allowed: artifact.hash === 'sha256:trusted' }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await allowedPlane.registrations.upsert(registration({ credentialRef: undefined }));
    await allowedPlane.tasks.start(taskInput({ taskId: 'artifact-task' }));
    expect(factoryContext).toBeDefined();
    await expect(factoryContext!.authorizeArtifact({
      name: 'trusted.pdf',
      hash: 'sha256:trusted',
    })).resolves.toBeUndefined();
  });
});
