import {
  _resetMessageQueueForTests,
  getMessageQueue,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXChildExecutionResult,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import { executeChildAgents } from '../child-executor.js';
import { actorQueueId, CodingActorSession } from './actor-runtime.js';

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
      expect.objectContaining({ content: expect.stringContaining('Live evidence.') }),
    ]));
    release?.(completedChild('done'));
    await settle();
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
