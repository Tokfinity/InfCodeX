import {
  createAgentActorController,
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
}> {
  const controller = await createAgentActorController({ executor });
  return { ctx: { backups: new Map(), actorControl: controller.bind('/root') }, executor };
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
    const listed = JSON.parse(await executeTool('list_agents', {}, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
    };

    expect(spawned).toMatchObject({ ok: true, actorPath: '/root/reviewer' });
    expect(listed.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/root/reviewer' }),
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
});
