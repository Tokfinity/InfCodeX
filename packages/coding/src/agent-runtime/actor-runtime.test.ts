import {
  _resetMessageQueueForTests,
  getMessageQueue,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentExecutorPlaneBinding,
  type AgentTaskSnapshot,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXChildExecutionResult,
  KodaXActorHost,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import { executeChildAgents } from '../child-executor.js';
import {
  actorQueueId,
  CodingActorSession,
} from './actor-runtime.js';

vi.mock('../child-executor.js', () => ({
  executeChildAgents: vi.fn(),
}));

const executeChildAgentsMock = vi.mocked(executeChildAgents);

function completedChild(summary: string): KodaXChildExecutionResult {
  return {
    results: [{
      childId: '/root/worker',
      fanoutClass: 'evidence-scan',
      status: 'completed',
      disposition: 'valid',
      summary,
      evidenceRefs: [],
      contradictions: [],
    }],
    mergedFindings: [],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
  };
}

function externalTask(
  state: AgentTaskSnapshot['state'],
  progress?: AgentTaskSnapshot['progress'],
  artifacts?: AgentTaskSnapshot['artifacts'],
): AgentTaskSnapshot {
  return {
    taskId: 'external-turn',
    route: 'external',
    agentId: 'external:reviewer',
    objective: 'Review.',
    state,
    cancellation: 'none',
    registration: {
      agentId: 'external:reviewer',
      origin: 'external',
      executorId: 'fixture',
      protocol: 'http',
      configurationRevision: 'rev-1',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'none' },
    },
    idempotencyKey: 'external-turn',
    dispatchAttempt: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...(progress === undefined ? {} : { progress }),
    ...(state === 'completed' ? { output: 'external done' } : {}),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

function environment(): {
  readonly ctx: KodaXToolExecutionContext;
  readonly options: KodaXOptions;
} {
  return {
    ctx: {
      backups: new Map(),
      sessionId: 'session-1',
      parentAgentConfig: { provider: 'anthropic' },
    },
    options: { provider: 'anthropic', agentMode: 'ama' },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  _resetMessageQueueForTests();
  vi.clearAllMocks();
});

describe('F270 coding Actor runtime adapter', () => {
  it('keeps native turns on the coding executor when an external plane executor exists', async () => {
    executeChildAgentsMock.mockResolvedValue(completedChild('native result'));
    const externalExecutor: AgentTurnExecutor = {
      execute: vi.fn(async (): Promise<AgentExecutionResult> => ({ output: 'external result' })),
    };
    const session = new CodingActorSession({ executor: externalExecutor, sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await root.spawn({ taskName: 'worker', objective: 'Inspect.' });
    await settle();

    expect(externalExecutor.execute).not.toHaveBeenCalled();
    expect(executeChildAgentsMock).toHaveBeenCalledOnce();
    expect(root.output(turn.actorPath, turn.turnId).output).toBe('native result');
  });

  it.each([
    { name: 'session-scoped', sessionId: 'session-1' },
    { name: 'local unscoped', sessionId: undefined },
  ])('projects root child completion into the $name task-notification queue', async ({ sessionId }) => {
    executeChildAgentsMock.mockResolvedValue(completedChild('review complete'));
    const session = new CodingActorSession({ sessionId });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await root.spawn({ taskName: 'review', objective: 'Review the patch.' });
    await settle();

    expect(getMessageQueue().peek({
      agentId: actorQueueId(sessionId, '/root'),
      maxPriority: 'background',
      mode: 'task-notification',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringContaining(`<agent-completed`),
        taskResult: expect.objectContaining({
          source: 'child_task',
          taskId: turn.turnId,
          status: 'completed',
          summary: 'review complete',
        }),
      }),
    ]));
  });

  it('projects prior turns and dormant mailbox messages into the next native turn', async () => {
    executeChildAgentsMock
      .mockResolvedValueOnce(completedChild('first result'))
      .mockResolvedValueOnce(completedChild('second result'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    await root.spawn({ taskName: 'worker', objective: 'First objective.', forkTurns: 'all' });
    await settle();
    await root.send('/root/worker', 'New durable evidence.');
    await root.followup('/root/worker', 'Second objective.');
    await settle();

    const secondOptions = executeChildAgentsMock.mock.calls[1]?.[2];
    expect(secondOptions?.initialMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('First objective.') }),
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('first result') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('New durable evidence.') }),
    ]));
  });

  it('projects live native mailbox messages into the addressed runner queue', async () => {
    let release: ((value: KodaXChildExecutionResult) => void) | undefined;
    executeChildAgentsMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    await root.spawn({ taskName: 'worker', objective: 'Wait for evidence.' });
    await vi.waitFor(() => expect(executeChildAgentsMock).toHaveBeenCalledOnce());

    await root.send('/root/worker', 'Live evidence.');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(getMessageQueue().peek({
      agentId: actorQueueId('session-1', '/root/worker'),
      maxPriority: 'background',
      mode: 'prompt',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringMatching(/<agent-message id="msg_[^"]+"[^>]*>\nLive evidence\./u),
      }),
    ]));
    release?.(completedChild('done'));
    await settle();
  });

  it('projects native child progress into the Runtime-owned bounded turn view', async () => {
    executeChildAgentsMock.mockImplementation(async (_bundles, _ctx, childOptions) => {
      childOptions.onProgress?.('Reading packages/agent/src/actors/controller.ts');
      childOptions.onProgress?.('Running focused tests');
      return completedChild('done');
    });
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const reportToolProgress = vi.fn();
    ctx.reportToolProgress = reportToolProgress;
    const root = session.attach(ctx, options);

    const turn = await root.spawn({ taskName: 'worker', objective: 'Inspect.' });
    await vi.waitFor(() => {
      expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed');
    });

    expect(root.output(turn.actorPath, turn.turnId).progress).toEqual([
      expect.objectContaining({ kind: 'status', summary: 'Reading packages/agent/src/actors/controller.ts' }),
      expect.objectContaining({ kind: 'status', summary: 'Running focused tests' }),
    ]);
    expect(root.list().actors.find((actor) => actor.path === turn.actorPath)?.latestTurn)
      .toMatchObject({ summary: 'done' });
    expect(reportToolProgress).toHaveBeenNthCalledWith(
      1,
      '[agent /root/worker] Reading packages/agent/src/actors/controller.ts',
    );
    expect(reportToolProgress).toHaveBeenNthCalledWith(
      2,
      '[agent /root/worker] Running focused tests',
    );
  });

  it('projects deduplicated external progress into the same Runtime turn view', async () => {
    const tasks = {
      start: vi.fn(async () => externalTask('working', { message: 'Connecting' })),
      get: vi.fn()
        .mockResolvedValueOnce(externalTask('working', { message: 'Connecting' }))
        .mockResolvedValueOnce(externalTask('working', { percent: 60 }))
        .mockResolvedValueOnce(externalTask('completed', { message: 'Finalizing' })),
      sendInput: vi.fn(async () => externalTask('working', { percent: 60 })),
      cancel: vi.fn(async () => externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const onToolProgress = vi.fn();
    const onChildActivityEnd = vi.fn();
    ctx.agentExecutorPlane = binding;
    ctx.parentEvents = { onToolProgress, onChildActivityEnd };
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed'));

    expect(root.output(turn.actorPath, turn.turnId).progress).toEqual([
      expect.objectContaining({ summary: 'Connecting' }),
      expect.objectContaining({ summary: '60% complete' }),
      expect.objectContaining({ summary: 'Finalizing' }),
    ]);
    expect(onToolProgress).toHaveBeenCalledTimes(3);
    expect(onToolProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Finalizing' }),
      expect.objectContaining({
        childAgentId: '/root/reviewer',
        childAgentName: 'reviewer',
        liveOnly: true,
      }),
    );
    expect(onChildActivityEnd).toHaveBeenCalledOnce();
  });

  it('preserves structured external artifact metadata through agent_output', async () => {
    const tasks = {
      start: vi.fn(async () => externalTask('completed', undefined, [{
        name: 'report.pdf',
        uri: 'https://remote.example/report.pdf',
        mimeType: 'application/pdf',
        size: 42,
        hash: 'sha256:report',
        provenance: 'external:fixture',
        producingAgentId: 'external:reviewer',
        remoteTaskId: 'remote-1',
      }])),
      get: vi.fn(),
      sendInput: vi.fn(),
      cancel: vi.fn(),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed'));
    const output = root.output(turn.actorPath, turn.turnId) as unknown as {
      readonly artifactDetails?: readonly Record<string, unknown>[];
    };

    expect(output.artifactDetails).toEqual([{
      name: 'report.pdf',
      uri: 'https://remote.example/report.pdf',
      mimeType: 'application/pdf',
      size: 42,
      hash: 'sha256:report',
      provenance: 'external:fixture',
      producingAgentId: 'external:reviewer',
      remoteTaskId: 'remote-1',
    }]);
  });

  it('exposes permanent subtree close only through the trusted Actor host', async () => {
    const executor: AgentTurnExecutor = {
      execute: () => new Promise<AgentExecutionResult>(() => undefined),
    };
    const session = new CodingActorSession({ executor, sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    await root.spawn({ taskName: 'parent', objective: 'Parent.' });
    await session.bindActor('/root/parent').spawn({ taskName: 'child', objective: 'Child.' });
    const trustedHost: KodaXActorHost = session;

    expect('close' in root).toBe(false);
    await trustedHost.closeActor('/root/parent', 'session owner retired branch');

    expect(root.get('/root/parent').actor.state).toBe('closed');
    expect(root.get('/root/parent/child').actor.state).toBe('closed');
  });

  it('derives write authority from Actor capabilities instead of mutable metadata', async () => {
    executeChildAgentsMock.mockResolvedValue(completedChild('done'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    await root.spawn({
      taskName: 'worker',
      objective: 'Do not write.',
      capabilities: { filesystem: 'read' },
      metadata: { readOnly: false },
    });
    await settle();

    expect(executeChildAgentsMock.mock.calls[0]?.[0][0]).toMatchObject({ readOnly: true });
  });

  it('admits Actor turns against the shared managed-run budget', async () => {
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, {
      ...options,
      context: {
        managedWorkBudget: {
          totalBudget: 1,
          spentBudget: 1,
          currentHarness: 'H0_DIRECT',
        },
      },
    });

    await expect(root.spawn({ taskName: 'worker', objective: 'Over budget.' }))
      .rejects.toMatchObject({ code: 'agent_budget_exhausted' });
    expect(root.list().actors.some((actor) => actor.path === '/root/worker')).toBe(false);
  });
});
