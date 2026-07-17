import { describe, expect, it, vi } from 'vitest';

import {
  AgentActorController,
  AgentBudgetExhaustedError,
  AgentControlError,
  AgentLimitReachedError,
  createAgentActorController,
  type AgentBudgetPort,
  type AgentActorSnapshot,
  type AgentActorStore,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from './index.js';

interface PendingExecution {
  readonly input: AgentExecutionInput;
  readonly resolve: (result: AgentExecutionResult) => void;
  readonly reject: (error: Error) => void;
}

class DeferredExecutor implements AgentTurnExecutor {
  readonly pending: PendingExecution[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return new Promise((resolve, reject) => this.pending.push({ input, resolve, reject }));
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('F270 actor tree and scheduler', () => {
  it('mints canonical recursive paths and keeps Actor and Turn state separate', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });

    const child = await controller.spawn('/root', { taskName: 'scout', objective: 'Inspect.' });
    const grandchild = await controller.spawn('/root/scout', {
      taskName: 'dependency-check', objective: 'Check dependencies.',
    });

    expect(child.actorPath).toBe('/root/scout');
    expect(grandchild.actorPath).toBe('/root/scout/dependency-check');
    expect(controller.get('/root', child.actorPath).actor).toMatchObject({
      state: 'running', currentTurnId: child.turnId,
    });
    expect(controller.get('/root', child.actorPath).turns[0]).toMatchObject({ state: 'running' });

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    expect(controller.get('/root', child.actorPath).actor.state).toBe('idle');
    expect(controller.get('/root', child.actorPath).turns[0]?.state).toBe('completed');
  });

  it('registers trusted Workflow protocol owners without consuming an Agent slot', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });

    const owner = await controller.createProtocolOwner('/root', 'run-1');

    expect(owner.callerPath).toBe('/root/workflow:run-1');
    expect(controller.list('/root')).toMatchObject({ activeNonRootTurns: 0 });
    expect(controller.get('/root', owner.callerPath).actor).toMatchObject({
      taskName: 'workflow:run-1', kind: 'workflow', state: 'idle', parentPath: '/root',
    });
    await expect(owner.spawn({ taskName: 'review', objective: 'Review.' })).resolves.toMatchObject({
      actorPath: '/root/workflow:run-1/review',
    });
    expect(controller.list('/root').activeNonRootTurns).toBe(1);
  });

  it('uses four total slots by default and leaves no ghost actor on saturation', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    await controller.spawn('/root', { taskName: 'c', objective: 'C' });

    await expect(controller.spawn('/root', { taskName: 'd', objective: 'D' })).rejects.toEqual(
      expect.objectContaining({
        code: 'agent_limit_reached',
        maxConcurrentThreads: 4,
        activeNonRootTurns: 3,
        availableNonRootSlots: 0,
        retryable: true,
      }),
    );
    expect(controller.list('/root').actors.some((actor) => actor.path === '/root/d')).toBe(false);

    executor.pending[0]?.resolve({ output: 'A done' });
    await settle();
    await expect(controller.spawn('/root', { taskName: 'd', objective: 'D' })).resolves.toMatchObject({
      actorPath: '/root/d',
    });
  });

  it('accepts root-only and high legal limits without clamping', async () => {
    const rootOnly = new AgentActorController({ maxConcurrentThreadsPerSession: 1 });
    await expect(rootOnly.spawn('/root', { taskName: 'blocked', objective: 'No slot.' }))
      .rejects.toBeInstanceOf(AgentLimitReachedError);

    const warn = vi.fn();
    const high = new AgentActorController({ maxConcurrentThreadsPerSession: 8, warn });
    expect(high.list('/root').maxConcurrentThreads).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps idle messages dormant and starts an admitted follow-up with history', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'reviewer', objective: 'First pass.' });
    executor.pending[0]?.resolve({ output: 'first' });
    await settle();

    await controller.send('/root', '/root/reviewer', 'Use the new evidence.');
    expect(executor.pending).toHaveLength(1);
    expect(controller.get('/root', '/root/reviewer').actor.state).toBe('idle');

    const followup = await controller.followup('/root', '/root/reviewer', 'Second pass.');
    expect(followup.delivery).toBe('started_turn');
    expect(executor.pending).toHaveLength(2);
    expect(executor.pending[1]?.input.priorTurns).toHaveLength(1);
    await expect(executor.pending[1]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Use the new evidence.', kind: 'message' },
    ]);
  });

  it('joins a running turn for follow-up without consuming another slot', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const first = await controller.spawn('/root', { taskName: 'reviewer', objective: 'First pass.' });

    const followup = await controller.followup('/root', '/root/reviewer', 'Also check tests.');

    expect(followup).toEqual({ delivery: 'current_turn', turn: first });
    expect(controller.list('/root').activeNonRootTurns).toBe(1);
    expect(executor.pending).toHaveLength(1);
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Also check tests.', kind: 'followup' },
    ]);
  });

  it('routes completion once to the direct parent rather than the root', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });

    executor.pending[1]?.resolve({ output: 'grandchild result' });
    await settle();

    const parentMailbox = controller.get('/root', '/root/parent').mailbox;
    expect(parentMailbox.filter((message) => message.content === 'grandchild result')).toHaveLength(1);
    expect(controller.get('/root', '/root').mailbox.some((message) => (
      message.content === 'grandchild result'
    ))).toBe(false);
  });

  it('separates lifecycle control from peer messaging authorization', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    await controller.spawn('/root/a', { taskName: 'a1', objective: 'A1' });

    await controller.send('/root/a', '/root/b', 'Peer evidence.');
    await expect(controller.followup('/root/a', '/root/b', 'Control peer.')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(controller.interrupt('/root', '/root/a/a1')).resolves.toBeUndefined();
    expect(controller.get('/root', '/root/a/a1').actor.state).toBe('idle');
  });

  it('enforces monotonic capabilities and forbids user authority below root', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      rootCapabilities: {
        tools: ['read', 'write'], filesystem: 'read', network: false,
        providers: ['mock'], canAskUser: true,
      },
    });
    await controller.spawn('/root', {
      taskName: 'reader', objective: 'Read.',
      capabilities: { tools: ['read'], filesystem: 'read', network: false, providers: ['mock'] },
    });
    expect(controller.get('/root', '/root/reader').actor.capabilities.canAskUser).toBe(false);
    await expect(controller.spawn('/root/reader', {
      taskName: 'writer', objective: 'Write.', capabilities: { filesystem: 'write' },
    })).rejects.toMatchObject({ code: 'invalid_capabilities' });
  });

  it('rejects budget admission without mutating actor identity or capacity', async () => {
    const budget: AgentBudgetPort = {
      async admit() {
        return {
          admitted: false,
          fact: { code: 'agent_budget_exhausted', retryable: false, reason: 'budget spent' },
        };
      },
    };
    const controller = await createAgentActorController({ budget });

    await expect(controller.spawn('/root', { taskName: 'costly', objective: 'Work.' }))
      .rejects.toBeInstanceOf(AgentBudgetExhaustedError);
    expect(controller.list('/root')).toMatchObject({ activeNonRootTurns: 0 });
    expect(controller.list('/root').actors.some((actor) => actor.path === '/root/costly')).toBe(false);
  });

  it('rejects unsafe names, sibling collisions, and invalid fork windows', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    for (const taskName of ['../escape', 'workflow-owner', 'root', 'has/slash', 'line\nbreak']) {
      await expect(controller.spawn('/root', { taskName, objective: 'No.' })).rejects.toBeInstanceOf(
        AgentControlError,
      );
    }
    await expect(controller.spawn('/root', {
      taskName: 'valid', objective: 'No.', forkTurns: 0,
    })).rejects.toMatchObject({ code: 'invalid_fork_turns' });
    await controller.spawn('/root', { taskName: 'valid', objective: 'Yes.' });
    await expect(controller.spawn('/root', { taskName: 'valid', objective: 'Again.' }))
      .rejects.toMatchObject({ code: 'name_collision' });
  });

  it('interrupts a turn without deleting the reusable actor identity', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'worker', objective: 'First.' });

    await controller.interrupt('/root', '/root/worker', 'change of plan');

    expect(controller.get('/root', '/root/worker')).toMatchObject({
      actor: { state: 'idle', turnIds: [expect.any(String)] },
      turns: [{ state: 'interrupted', error: 'change of plan' }],
    });
    await expect(controller.followup('/root', '/root/worker', 'Try again.')).resolves.toMatchObject({
      delivery: 'started_turn',
    });
  });

  it('binds caller authority so model-facing inputs cannot forge an actor path', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root', { taskName: 'peer', objective: 'Peer.' });
    const parent = controller.bind('/root/parent');

    await expect(parent.spawn({ taskName: 'child', objective: 'Child.' })).resolves.toMatchObject({
      actorPath: '/root/parent/child',
    });
    await expect(parent.interrupt('/root/peer')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(Object.isFrozen(parent)).toBe(true);
  });

  it('preserves revisions and aborts active executions when closing a subtree', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });
    const before = controller.get('/root', '/root/parent/child').actor.revision;

    await controller.close('/root', '/root/parent');

    const closed = controller.get('/root', '/root/parent/child').actor;
    expect(closed).toMatchObject({ state: 'closed', currentTurnId: undefined });
    expect(closed.revision).toBeGreaterThan(before);
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    expect(executor.pending[1]?.input.signal.aborted).toBe(true);
  });

  it('interrupts unfinished turns on shutdown without permanently closing reusable actors', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return snapshot; },
      async save(next) { snapshot = next; },
    };
    const firstExecutor = new DeferredExecutor();
    const first = await createAgentActorController({ executor: firstExecutor, store });
    await first.spawn('/root', { taskName: 'worker', objective: 'First pass.' });

    await first.shutdown('runtime stopped');

    expect(firstExecutor.pending[0]?.input.signal.aborted).toBe(true);
    expect(first.get('/root', '/root').actor.state).toBe('running');
    expect(first.get('/root', '/root/worker').actor.state).toBe('idle');
    expect(first.output('/root', '/root/worker')).toMatchObject({
      state: 'interrupted', error: 'runtime stopped',
    });

    const restartedExecutor = new DeferredExecutor();
    const restarted = await createAgentActorController({ executor: restartedExecutor, store });
    await expect(restarted.followup('/root', '/root/worker', 'Resume.')).resolves.toMatchObject({
      delivery: 'started_turn',
      turn: { actorPath: '/root/worker' },
    });
    expect(restartedExecutor.pending).toHaveLength(1);
  });

  it('restores abort handles when a durable mutation is rolled back', async () => {
    let failSave = false;
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save(_snapshot: AgentActorSnapshot) {
        if (failSave) throw new Error('disk unavailable');
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor, store });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    failSave = true;

    await expect(controller.interrupt('/root', '/root/worker')).rejects.toThrow('disk unavailable');
    expect(controller.get('/root', '/root/worker').actor.state).toBe('running');
    expect(executor.pending[0]?.input.signal.aborted).toBe(false);

    failSave = false;
    await controller.interrupt('/root', '/root/worker');
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
  });

  it('reports durable completion failures through the background error boundary', async () => {
    let failSave = false;
    const onBackgroundError = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save() {
        if (failSave) throw new Error('completion save failed');
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor, store, onBackgroundError });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    failSave = true;

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();

    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'completion save failed',
    }));
    expect(controller.get('/root', '/root/worker').actor.state).toBe('running');
  });

  it('publishes terminal events only after durable commit and isolates callback failures', async () => {
    const order: string[] = [];
    const onBackgroundError = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save() { order.push('saved'); },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError,
      onEventCommitted(event) {
        if (event.kind !== 'turn_completed') return;
        order.push('published');
        throw new Error('observer failed');
      },
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    order.length = 0;

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    await settle();

    expect(order).toEqual(['saved', 'published']);
    expect(controller.output('/root', '/root/worker')).toMatchObject({
      state: 'completed', output: 'done',
    });
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'observer failed',
    }));
  });
});
