import {
  createAgentActorController,
  type AgentActorController,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { executeTool, getToolDefinition } from './registry.js';

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

async function context(executor = new DeferredExecutor()): Promise<{
  readonly ctx: KodaXToolExecutionContext;
  readonly executor: DeferredExecutor;
  readonly controller: AgentActorController;
}> {
  const controller = await createAgentActorController({ executor });
  return { ctx: { backups: new Map(), actorControl: controller.bind('/root') }, executor, controller };
}

describe('F270 canonical collaboration tools', () => {
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

  it('rejects observation requests above the Runtime-owned bounds', async () => {
    const { ctx } = await context();

    const listResult = JSON.parse(
      await executeTool('list_agents', { limit: 51 }, ctx),
    ) as Record<string, unknown>;
    const waitResult = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 0,
      max_events: 21,
    }, ctx)) as Record<string, unknown>;

    expect(listResult).toMatchObject({
      ok: false,
      error: { message: 'limit must be an integer between 1 and 50.' },
    });
    expect(waitResult).toMatchObject({
      ok: false,
      error: { message: 'max_events must be an integer between 1 and 20.' },
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
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;

    const result = JSON.parse(await executeTool('wait_agent', {
      after_sequence: cursor,
      timeout_ms: 1,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, status: 'interrupted' });
  });

  it('returns a bounded event batch without skipping the remaining committed events', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;
    await ctx.actorControl?.send('/root/worker', 'First update.');
    await ctx.actorControl?.send('/root/worker', 'Second update.');

    const first = JSON.parse(await executeTool('wait_agent', {
      after_sequence: cursor,
      timeout_ms: 0,
      max_events: 1,
    }, ctx)) as {
      readonly events?: readonly { readonly sequence: number; readonly actorPath: string }[];
      readonly nextSequence?: number;
      readonly hasMore?: boolean;
      readonly updatedActors?: readonly string[];
    };
    const second = JSON.parse(await executeTool('wait_agent', {
      after_sequence: first.nextSequence,
      timeout_ms: 0,
      max_events: 8,
    }, ctx)) as {
      readonly events?: readonly { readonly sequence: number }[];
      readonly hasMore?: boolean;
    };

    expect(first).toMatchObject({
      events: [expect.objectContaining({ actorPath: '/root/worker' })],
      updatedActors: ['/root/worker'],
      hasMore: true,
    });
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
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

  it('distinguishes a committed actor event from an expired wait', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;

    const expired = JSON.parse(await executeTool('wait_agent', {
      after_sequence: cursor,
      timeout_ms: 0,
    }, ctx)) as Record<string, unknown>;
    const waiting = executeTool('wait_agent', {
      after_sequence: cursor,
      timeout_ms: 1_000,
    }, ctx);
    await Promise.resolve();
    await ctx.actorControl?.send('/root/worker', 'Wake the waiter.');
    const event = JSON.parse(await waiting) as Record<string, unknown>;

    expect(expired).toMatchObject({ ok: true, status: 'wait_expired' });
    expect(event).toMatchObject({
      ok: true,
      status: 'event',
      nextSequence: expect.any(Number),
      event: expect.objectContaining({ kind: 'message_delivered' }),
    });
  });
});
