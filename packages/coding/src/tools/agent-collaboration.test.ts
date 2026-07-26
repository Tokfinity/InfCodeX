import {
  _resetMessageQueueForTests,
  createAgentActorController,
  getMessageQueue,
  type AgentActorController,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { KodaXToolExecutionContext } from '../types.js';
import { actorQueueId } from '../agent-runtime/actor-queue.js';
import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
} from '../construction/agent-resolver.js';
import { executeTool, getToolDefinition } from './registry.js';
import { commitActorNotificationReceipts } from './agent-collaboration.js';

function committedToolResultMessage(content: string): KodaXMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'test-call',
      content,
    }],
  };
}

interface PendingExecution {
  readonly input: AgentExecutionInput;
  readonly resolve: (result: AgentExecutionResult) => void;
}

class DeferredExecutor implements AgentTurnExecutor {
  readonly pending: PendingExecution[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return new Promise((resolve) => this.pending.push({ input, resolve }));
  }
}

async function context(
  executor = new DeferredExecutor(),
  sessionId?: string,
): Promise<{
  readonly ctx: KodaXToolExecutionContext;
  readonly executor: DeferredExecutor;
  readonly controller: AgentActorController;
}> {
  const controller = await createAgentActorController({ executor });
  return {
    ctx: {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      actorTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    executor,
    controller,
  };
}

describe('F270 canonical collaboration tools', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetMessageQueueForTests();
    _resetAgentResolverForTesting();
  });

  it('offers only the canonical model-visible names', () => {
    for (const name of [
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent',
      'interrupt_agent', 'list_agents', 'agent_output',
    ]) {
      expect(getToolDefinition(name), name).toBeDefined();
    }
    for (const retired of ['dispatch_child_task', 'task_stop', 'task_output']) {
      expect(getToolDefinition(retired), retired).toBeUndefined();
    }
  });

  it('spawns a named actor with structured metadata and lists the canonical path', async () => {
    const { ctx, executor } = await context();

    const spawned = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'reviewer',
      objective: 'Review the actor boundary.',
      read_only: true,
      scope: 'packages/agent',
      evidence_refs: ['file:packages/agent/src/index.ts'],
      fork_turns: 'none',
    }, ctx)) as Record<string, unknown>;
    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'Reading actor types' });
    const listed = JSON.parse(await executeTool('list_agents', {}, ctx)) as {
      readonly actors: readonly {
        readonly path: string;
        readonly latestTurn?: { readonly recentActivity: readonly { readonly summary: string }[] };
      }[];
    };

    expect(spawned).toMatchObject({ ok: true, actorPath: '/root/reviewer' });
    expect(listed.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/root/reviewer',
        latestTurn: expect.objectContaining({
          recentActivity: [expect.objectContaining({ summary: 'Reading actor types' })],
        }),
      }),
    ]));
    expect(executor.pending[0]?.input.turn.metadata).toMatchObject({
      readOnly: true,
      scope: 'packages/agent',
      evidenceRefs: ['file:packages/agent/src/index.ts'],
    });
  });

  it('validates quality_strategy and stamps the trusted owner Turn reference', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'review-auth',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
      targetEvidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
    };

    const spawned = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'strategy-reviewer',
      objective: 'Review the actor boundary.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;

    expect(spawned).toMatchObject({ ok: true });
    expect(executor.pending[0]?.input.turn.metadata?.qualityStrategy).toEqual({
      ...qualityStrategy,
      ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
    });

    const invalid = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'invalid-strategy',
      objective: 'Try an invented pattern.',
      quality_strategy: { ...qualityStrategy, pattern: 'majority-vote' },
    }, ctx)) as Record<string, unknown>;
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'agent_control_failed' },
    });
  });

  it('rejects unknown and unreadable strategy targets before creating an Actor', async () => {
    const { ctx } = await context();
    const base = {
      schemaVersion: 1,
      stageId: 'invalid-target',
      pattern: 'adversarial-verification',
      role: 'challenger',
      laneRelation: 'opposition',
    };
    const unknown = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'unknown-target',
      objective: 'Must not start.',
      quality_strategy: {
        ...base,
        targetEvidenceRefs: ['tool-result:not-visible'],
      },
    }, ctx)) as Record<string, unknown>;
    const missing = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'missing-target',
      objective: 'Must not start.',
      quality_strategy: {
        ...base,
        targetEvidenceRefs: ['file:packages/coding/src/does-not-exist.ts'],
      },
    }, ctx)) as Record<string, unknown>;

    expect(unknown).toMatchObject({ ok: false });
    expect(missing).toMatchObject({ ok: false });
    expect(ctx.actorControl?.list().actors.map((actor) => actor.path))
      .not.toEqual(expect.arrayContaining(['/root/unknown-target', '/root/missing-target']));
  });

  it('preserves running same-strategy follow-up and rejects a strategy switch before delivery', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'coverage-round-1',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
    };
    await executeTool('spawn_agent', {
      task_name: 'coverage-lane',
      objective: 'Inspect one bounded scope.',
      quality_strategy: qualityStrategy,
    }, ctx);

    const same = JSON.parse(await executeTool('followup_task', {
      target: 'coverage-lane',
      objective: 'Also inspect the adjacent test.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;
    expect(same).toMatchObject({ ok: true, delivery: 'current_turn' });

    const switched = JSON.parse(await executeTool('followup_task', {
      target: 'coverage-lane',
      objective: 'Become a challenger.',
      quality_strategy: {
        ...qualityStrategy,
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: ['finding:coverage candidate'],
      },
    }, ctx)) as Record<string, unknown>;
    expect(switched).toMatchObject({
      ok: false,
      error: { code: 'invalid_message' },
    });
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Also inspect the adjacent test.', kind: 'followup' },
    ]);
  });

  it('lets an idle actor start a new attributed stage', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', {
      task_name: 'reusable',
      objective: 'Generate a candidate.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'candidate-1',
        pattern: 'generate-and-filter',
        role: 'generator',
      },
    }, ctx);
    executor.pending[0]?.resolve({ output: 'candidate' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    ctx.actorTurnRef = { actorPath: '/root', turnId: 'root-turn-2' };
    const followup = JSON.parse(await executeTool('followup_task', {
      target: 'reusable',
      objective: 'Challenge the candidate.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'challenge-1',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: ['finding:candidate'],
      },
    }, ctx)) as Record<string, unknown>;

    expect(followup).toMatchObject({ ok: true, delivery: 'started_turn' });
    expect(executor.pending[1]?.input.turn.metadata?.qualityStrategy).toMatchObject({
      stageId: 'challenge-1',
      ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-2' },
    });
  });

  it('does not reopen a terminal stage id for the same owner Turn', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'closed-stage',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
    };
    await executeTool('spawn_agent', {
      task_name: 'first-lane',
      objective: 'Complete the first lane.',
      quality_strategy: qualityStrategy,
    }, ctx);
    executor.pending[0]?.resolve({ output: 'done' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const reopened = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'late-lane',
      objective: 'Try to reopen it.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;

    expect(reopened).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_message',
        message: expect.stringContaining('closed'),
      },
    });
  });

  it('returns a stable structured capacity fact without creating a ghost actor', async () => {
    const { ctx } = await context();
    for (const taskName of ['a', 'b', 'c']) {
      await executeTool('spawn_agent', { task_name: taskName, objective: taskName }, ctx);
    }

    const rejected = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'd', objective: 'D',
    }, ctx)) as Record<string, unknown>;
    const listed = JSON.parse(await executeTool('list_agents', {}, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
    };

    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'agent_limit_reached',
        maxConcurrentThreads: 4,
        activeNonRootTurns: 3,
        availableNonRootSlots: 0,
        retryable: true,
      },
    });
    expect(listed.actors.some((actor) => actor.path === '/root/d')).toBe(false);
  });

  it('exposes mailbox-driven wait without raw Actor event controls', () => {
    const definition = getToolDefinition('wait_agent');

    expect(definition?.input_schema.properties).toEqual({
      timeout_ms: expect.objectContaining({ type: 'number' }),
    });
    expect(definition?.description).toContain('mailbox');
    expect(definition?.description).not.toContain('return_on');
  });

  it('does not wake the parent model for progress and wakes once mailbox input arrives', async () => {
    const sessionId = 'session-mailbox-wait';
    const { ctx, executor } = await context(new DeferredExecutor(), sessionId);
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Inspect.' }, ctx);

    let settled = false;
    const waiting = executeTool('wait_agent', {
      timeout_ms: 10_000,
      return_on: 'event',
      after_sequence: 0,
    }, ctx).then((value) => {
      settled = true;
      return JSON.parse(value) as Record<string, unknown>;
    });
    for (let index = 0; index < 100; index += 1) {
      await executor.pending[0]?.input.reportProgress({
        kind: 'tool',
        summary: `Progress ${index}`,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    getMessageQueue().enqueue({
      agentId: actorQueueId(sessionId, '/root'),
      priority: 'background',
      mode: 'system-reminder',
      content: '<system-reminder>Reconcile the plan.</system-reminder>',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    getMessageQueue().enqueue({
      agentId: actorQueueId(sessionId, '/root'),
      priority: 'background',
      mode: 'task-notification',
      content: '<agent-completed turn_id="turn-1">done</agent-completed>',
    });

    await expect(waiting).resolves.toEqual({ ok: true, status: 'mailbox' });
  });

  it('lists and spawns a local constructed specialist without an external executor plane', async () => {
    registerConstructedAgent({
      kind: 'agent',
      name: 'repo-explorer',
      version: '1.0.0',
      createdAt: '2026-07-22T00:00:00.000Z',
      content: {
        instructions: 'Explore repositories without modifying them.',
        description: 'Read-only repository explorer',
      },
      testedAt: '2026-07-22T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    }, { source: 'built-in' });
    const { ctx, executor } = await context();

    const listed = JSON.parse(await executeTool('list_dispatchable_agents', {}, ctx)) as {
      readonly agents?: readonly { readonly agent_id: string; readonly origin: string }[];
    };
    const specialist = listed.agents?.find((agent) => agent.origin === 'constructed');
    expect(specialist?.agent_id).toContain('repo-explorer');

    const shortAlias = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'short-alias',
      objective: 'Inspect the repository.',
      agent_id: 'repo-explorer',
    }, ctx)) as Record<string, unknown>;
    expect(shortAlias).toMatchObject({ ok: true, actorPath: '/root/short-alias' });
    expect(executor.pending[0]?.input.actor.kind).toBe('constructed');
    expect(executor.pending[0]?.input.turn.metadata).toMatchObject({
      agentId: 'repo-explorer',
      specialistName: 'repo-explorer',
    });

    const canonical = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'canonical-id',
      objective: 'Inspect another boundary.',
      agent_id: specialist?.agent_id,
    }, ctx)) as Record<string, unknown>;
    expect(canonical).toMatchObject({ ok: true, actorPath: '/root/canonical-id' });
    expect(executor.pending[1]?.input.actor.kind).toBe('constructed');
  });

  it('filters and paginates only the caller-visible actor projection', async () => {
    const { ctx } = await context();
    for (const taskName of ['a', 'b', 'c']) {
      await executeTool('spawn_agent', { task_name: taskName, objective: taskName }, ctx);
    }

    const first = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/',
      state: 'running',
      limit: 2,
    }, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
      readonly hasMore?: boolean;
      readonly nextAfterPath?: string;
    };
    const second = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/',
      state: 'running',
      limit: 2,
      after_path: first.nextAfterPath,
    }, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
      readonly hasMore?: boolean;
    };

    expect(first).toMatchObject({
      hasMore: true,
      nextAfterPath: '/root/b',
      actors: [{ path: '/root/a' }, { path: '/root/b' }],
    });
    expect(second).toMatchObject({ hasMore: false, actors: [{ path: '/root/c' }] });
  });

  it('applies list filters after authorization without leaking a peer descendant count', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'caller', objective: 'Caller.' });
    await controller.spawn('/root', { taskName: 'peer', objective: 'Peer.' });
    await controller.spawn('/root/peer', { taskName: 'private-child', objective: 'Private.' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/caller'),
    };

    const listed = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/peer/private-child',
    }, ctx)) as Record<string, unknown>;

    expect(listed).toMatchObject({ ok: true, matchedActorCount: 0, actors: [] });
  });

  it('rejects model wait windows outside the Runtime-owned bounds', async () => {
    const { ctx } = await context();

    const listResult = JSON.parse(
      await executeTool('list_agents', { limit: 51 }, ctx),
    ) as Record<string, unknown>;
    const waitResult = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 9_999,
    }, ctx)) as Record<string, unknown>;
    const longWaitResult = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 3_600_001,
    }, ctx)) as Record<string, unknown>;

    expect(listResult).toMatchObject({
      ok: false,
      error: { message: 'limit must be an integer between 1 and 50.' },
    });
    expect(waitResult).toMatchObject({
      ok: false,
      error: { message: 'timeout_ms must be an integer between 10000 and 3600000.' },
    });
    expect(longWaitResult).toMatchObject({
      ok: false,
      error: { message: 'timeout_ms must be an integer between 10000 and 3600000.' },
    });
  });

  it('cannot escalate a read-only Actor to a write child', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', {
      taskName: 'reader',
      objective: 'Read only.',
      capabilities: { filesystem: 'read' },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/reader'),
    };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'writer',
      objective: 'Attempt a write.',
      read_only: false,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_capabilities' },
    });
    expect(controller.list('/root').actors.some((actor) => (
      actor.path === '/root/reader/writer'
    ))).toBe(false);
  });

  it('keeps send_message dormant and uses followup_task to start the next turn', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', { task_name: 'reviewer', objective: 'First.' }, ctx);
    executor.pending[0]?.resolve({ output: 'first' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await executeTool('send_message', { to: 'reviewer', content: 'New evidence.' }, ctx);
    expect(executor.pending).toHaveLength(1);
    const followup = JSON.parse(await executeTool('followup_task', {
      target: 'reviewer', objective: 'Second.',
    }, ctx)) as Record<string, unknown>;

    expect(followup).toMatchObject({ ok: true, delivery: 'started_turn' });
    expect(executor.pending).toHaveLength(2);
    await expect(executor.pending[1]?.input.drainMailbox()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'New evidence.' }),
    ]));
  });

  it('uses Runtime message ids for forwarding and keeps the model schema free of seen_by', async () => {
    const { ctx } = await context();
    const definition = getToolDefinition('send_message');
    expect(definition?.input_schema.properties).toHaveProperty('forwarded_message_id');
    expect(definition?.input_schema.properties).not.toHaveProperty('seen_by');
    expect(definition?.input_schema.properties).toHaveProperty('classification');

    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);
    const aControl = ctx.actorControl?.get('/root/a');
    expect(aControl).toBeDefined();

    const sent = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Fresh evidence.', classification: 'sensitive',
    }, ctx)) as Record<string, unknown>;
    expect(sent).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect(ctx.actorControl?.get('/root/a').mailbox.at(-1)).toMatchObject({
      classification: 'sensitive',
      lineage: ['/root'],
    });
  });

  it('enforces the root per-turn send cap before mutating any mailbox', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    ctx.sendMessageTurnCounter = { count: 19 };

    const accepted = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Last accepted message.',
    }, ctx)) as Record<string, unknown>;
    const mailboxSize = ctx.actorControl?.get('/root/a').mailbox.length;
    const rejected = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Storm message.',
    }, ctx)) as Record<string, unknown>;

    expect(accepted).toMatchObject({ ok: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 20, sent: 20 },
    });
    expect(ctx.actorControl?.get('/root/a').mailbox).toHaveLength(mailboxSize ?? -1);
  });

  it('rejects an over-budget broadcast before delivering to any recipient', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);
    ctx.sendMessageTurnCounter = { count: 19 };
    const aSize = ctx.actorControl?.get('/root/a').mailbox.length;
    const bSize = ctx.actorControl?.get('/root/b').mailbox.length;

    const rejected = JSON.parse(await executeTool('send_message', {
      to: '*', content: 'Do not partially deliver.',
    }, ctx)) as Record<string, unknown>;

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 20, sent: 19 },
    });
    expect(ctx.actorControl?.get('/root/a').mailbox).toHaveLength(aSize ?? -1);
    expect(ctx.actorControl?.get('/root/b').mailbox).toHaveLength(bSize ?? -1);
    expect(ctx.sendMessageTurnCounter.count).toBe(19);
  });

  it('broadcasts once per visible recipient and returns Runtime message ids', async () => {
    const { ctx } = await context();
    ctx.sendMessageTurnCounter = { count: 0 };
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);

    const delivered = JSON.parse(await executeTool('send_message', {
      to: '*', content: 'Shared evidence.',
    }, ctx)) as { readonly messageIds?: readonly string[] } & Record<string, unknown>;

    expect(delivered).toMatchObject({
      ok: true,
      delivery: 'broadcast',
      recipients: ['/root/a', '/root/b'],
    });
    expect(delivered.messageIds).toHaveLength(2);
    expect(ctx.actorControl?.get('/root/a').mailbox.at(-1)?.content).toBe('Shared evidence.');
    expect(ctx.actorControl?.get('/root/b').mailbox.at(-1)?.content).toBe('Shared evidence.');
    expect(ctx.sendMessageTurnCounter?.count).toBe(2);
  });

  it('uses the smaller per-turn send cap for non-root Agents', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/a'),
      sendMessageTurnCounter: { count: 4 },
    };

    const accepted = JSON.parse(await executeTool('send_message', {
      to: 'b', content: 'Last child message.',
    }, ctx)) as Record<string, unknown>;
    const rejected = JSON.parse(await executeTool('send_message', {
      to: 'b', content: 'Child storm message.',
    }, ctx)) as Record<string, unknown>;

    expect(accepted).toMatchObject({ ok: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 5, sent: 5 },
    });
  });

  it('reports an interrupted wait when the owning root round is canceled', async () => {
    const { ctx } = await context();
    const abort = new AbortController();
    ctx.abortSignal = abort.signal;
    abort.abort('new user input');
    const result = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, status: 'interrupted' });
  });

  it('returns immediately for pre-existing scoped user input without consuming it', async () => {
    const { ctx } = await context(new DeferredExecutor(), 'session-1');
    const queue = getMessageQueue();
    queue.enqueue({
      agentId: 'actor:session-1:/root',
      priority: 'user',
      mode: 'prompt',
      content: 'answer the user first',
    });

    const result = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, status: 'user_input_pending' });
    expect(queue.peek({
      agentId: 'actor:session-1:/root',
      maxPriority: 'user',
      mode: 'prompt',
    }).map((message) => message.content)).toEqual(['answer the user first']);
  });

  it('wakes when scoped user input arrives after the Actor waiter is registered', async () => {
    const { ctx } = await context(new DeferredExecutor(), 'session-1');
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);
    await Promise.resolve();

    getMessageQueue().enqueue({
      agentId: 'actor:session-1:/root',
      priority: 'user',
      mode: 'prompt',
      content: 'queued while waiting',
    });

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toMatchObject({
      ok: true,
      status: 'user_input_pending',
    });
  });

  it('mailbox wait returns only an acknowledgement and completion commits once', async () => {
    const executor = new DeferredExecutor();
    const sessionId = 'session-terminal';
    const queueAgentId = `actor:${sessionId}:/root`;
    const controller = await createAgentActorController({
      executor,
      onMessageCommitted: (message) => {
        if (message.kind !== 'completion' || message.recipientPath !== '/root' || !message.turnId) return;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'background',
          mode: 'task-notification',
          content: `<agent-completed turn_id="${message.turnId}">${message.content}</agent-completed>`,
          taskResult: {
            type: 'task_result',
            source: 'child_task',
            taskId: message.turnId,
            status: 'completed',
            summary: message.content,
          },
        });
      },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      sessionId,
    };
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    let settled = false;
    const waiting = executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx).then((value) => {
      settled = true;
      return JSON.parse(value) as Record<string, unknown>;
    });

    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'First read.' });
    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'Second read.' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    executor.pending[0]?.resolve({ output: 'terminal evidence' });

    const result = await waiting;
    expect(result).toEqual({ ok: true, status: 'mailbox' });
    expect(result).not.toHaveProperty('events');
    expect(result).not.toHaveProperty('terminalOutputs');
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    await commitActorNotificationReceipts(ctx, [
      committedToolResultMessage(JSON.stringify(result)),
    ]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    const notification = getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })[0];
    expect(notification?.taskResult).toBeDefined();
    await commitActorNotificationReceipts(ctx, [{
      role: 'user',
      content: notification?.content ?? '',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: notification?.taskResult,
    }]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(0);
  });

  it('an explicit Actor message wakes the parent while the child remains active', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Coordinate.' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/parent'),
      sessionId: 'session-nested-terminal',
    };
    await executeTool('spawn_agent', { task_name: 'child', objective: 'Inspect.' }, ctx);
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);
    await Promise.resolve();
    getMessageQueue().enqueue({
      agentId: actorQueueId('session-nested-terminal', '/root/parent'),
      priority: 'background',
      mode: 'agent-message',
      content: '<agent-message>Important evidence.</agent-message>',
    });

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toEqual({
      ok: true,
      status: 'mailbox',
    });
    expect(controller.output('/root', '/root/parent/child').state).toBe('running');
  });

  it('agent_output consumes the matching terminal banner only after commit', async () => {
    const executor = new DeferredExecutor();
    const sessionId = 'session-output';
    const queueAgentId = `actor:${sessionId}:/root`;
    const controller = await createAgentActorController({
      executor,
      onMessageCommitted: (message) => {
        if (message.kind !== 'completion' || message.recipientPath !== '/root' || !message.turnId) return;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'background',
          mode: 'task-notification',
          content: message.content,
          taskResult: {
            type: 'task_result',
            source: 'child_task',
            taskId: message.turnId,
            status: 'completed',
            summary: message.content,
          },
        });
      },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      sessionId,
    };
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    executor.pending[0]?.resolve({ output: 'terminal evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    const outputText = await executeTool('agent_output', { target: 'worker' }, ctx);
    const output = JSON.parse(outputText) as {
      readonly output?: string;
    };
    expect(output.output).toBe('terminal evidence');
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    await commitActorNotificationReceipts(ctx, [committedToolResultMessage(outputText)]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(0);
  });

  it('acknowledges a host-delivered child result after its synthetic message commits', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;
    const turnId = ctx.actorControl?.get('/root/worker').actor.currentTurnId;
    executor.pending[0]?.resolve({ output: 'terminal evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await commitActorNotificationReceipts(ctx, [{
      role: 'user',
      content: '<agent-completed>terminal evidence</agent-completed>',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: {
        type: 'task_result',
        source: 'child_task',
        taskId: turnId ?? '',
        status: 'completed',
        summary: 'terminal evidence',
      },
    }]);

    expect(ctx.actorControl?.eventSnapshot(cursor).some((event) => (
      event.turnId === turnId
    ))).toBe(false);
  });

  it('retains raw event replay and long-poll semantics on the Runtime client', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;
    await ctx.actorControl?.send('/root/worker', 'First update.');
    await ctx.actorControl?.send('/root/worker', 'Second update.');

    const events = ctx.actorControl?.eventSnapshot(cursor) ?? [];
    expect(events).toHaveLength(2);
    await expect(ctx.actorControl?.wait(cursor, 0)).resolves.toEqual(events[0]);
  });

  it('interrupts an invalidated actor branch without permanently closing its identities', async () => {
    const { ctx, controller } = await context();
    await executeTool('spawn_agent', { task_name: 'parent', objective: 'Parent.' }, ctx);
    await controller.bind('/root/parent').spawn({ taskName: 'child', objective: 'Child.' });

    const result = JSON.parse(await executeTool('interrupt_agent', {
      target: 'parent',
      scope: 'subtree',
      reason: 'premise invalidated',
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, scope: 'subtree' });
    expect(controller.output('/root', '/root/parent')).toMatchObject({ state: 'interrupted' });
    expect(controller.output('/root', '/root/parent/child')).toMatchObject({ state: 'interrupted' });
    expect(controller.get('/root', '/root/parent').actor.state).toBe('idle');
  });

  it('reports a mailbox wait timeout without consulting Actor events', async () => {
    vi.useFakeTimers();
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toEqual({
      ok: true,
      status: 'wait_expired',
    });
  });
});
