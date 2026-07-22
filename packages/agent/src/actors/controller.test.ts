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

  it('completes an artifact-only turn with a non-empty parent notification', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'artifact', objective: 'Create it.' });

    executor.pending[0]?.resolve({ output: '', artifacts: ['artifact://report'] });
    await settle();

    expect(controller.output('/root', child.actorPath, child.turnId)).toMatchObject({
      state: 'completed',
      artifacts: ['artifact://report'],
      artifactDetails: [{ name: 'artifact://report' }],
    });
    expect(controller.get('/root', '/root').mailbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderPath: child.actorPath, content: 'completed' }),
    ]));
  });

  it('durably acknowledges one observed child completion without consuming earlier evidence', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Coordinate.' });
    const child = await controller.spawn('/root/parent', {
      taskName: 'child',
      objective: 'Inspect.',
    });
    await controller.send('/root/parent/child', '/root/parent', 'Important evidence.');
    executor.pending[1]?.resolve({ output: 'Child complete.' });
    await settle();

    const parent = controller.bind('/root/parent');
    await expect(parent.acknowledgeCompletions([child.turnId])).resolves.toBe(1);
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toEqual([
      expect.objectContaining({ kind: 'message', content: 'Important evidence.' }),
    ]);
    expect(saved?.acknowledgedCompletionTurnIds).toContain(child.turnId);

    executor.pending[0]?.resolve({ output: 'Parent complete.' });
    await settle();
    const restoredExecutor = new DeferredExecutor();
    const restored = new AgentActorController({
      executor: restoredExecutor,
      store: {
        async load() { return saved; },
        async save() {},
      },
    });
    await restored.initialize();
    await restored.followup('/root', '/root/parent', 'Continue after restart.');

    await expect(restoredExecutor.pending[0]?.input.drainMailbox()).resolves.toEqual([]);
  });

  it('republishes an unacknowledged root completion once after restart', async () => {
    let saved: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return saved; },
      async save(snapshot) { saved = snapshot; },
    };
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({ executor, store });
    const child = await first.spawn('/root', { taskName: 'worker', objective: 'Inspect.' });
    executor.pending[0]?.resolve({ output: 'Durable result.' });
    await settle();
    expect(saved?.pendingRootCompletionTurnIds).toContain(child.turnId);

    const restoredMessages: string[] = [];
    const restored = await createAgentActorController({
      store,
      onMessageCommitted(message) {
        restoredMessages.push(message.turnId ?? 'missing');
      },
    });

    expect(restoredMessages).toEqual([child.turnId]);
    await expect(restored.bind('/root').acknowledgeCompletions([child.turnId])).resolves.toBe(1);

    const replayedAfterAcknowledgement: string[] = [];
    await createAgentActorController({
      store,
      onMessageCommitted(message) {
        replayedAfterAcknowledgement.push(message.turnId ?? 'missing');
      },
    });
    expect(replayedAfterAcknowledgement).toEqual([]);
  });

  it('does not infer replayable completions from a legacy snapshot without delivery state', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'legacy', objective: 'Finish.' });
    executor.pending[0]?.resolve({ output: 'Historical result.' });
    await settle();
    if (!saved) throw new Error('Expected a persisted Actor snapshot.');
    const legacy = { ...saved };
    delete legacy.pendingRootCompletionTurnIds;
    const replayed: string[] = [];

    await createAgentActorController({
      store: {
        async load() { return legacy; },
        async save() {},
      },
      onMessageCommitted(message) {
        replayed.push(message.turnId ?? 'missing');
      },
    });

    expect(replayed).toEqual([]);
  });

  it('does not replay an acknowledged direct-child terminal event', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const parent = controller.bind('/root');
    const child = await parent.spawn({ taskName: 'worker', objective: 'Work.' });
    const cursor = parent.eventSnapshot().at(-1)?.sequence ?? 0;

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    const terminal = parent.eventSnapshot(cursor).find((event) => event.turnId === child.turnId);
    expect(terminal?.kind).toBe('turn_completed');

    await expect(parent.acknowledgeCompletions([child.turnId])).resolves.toBe(1);
    expect(parent.eventSnapshot(cursor).some((event) => event.turnId === child.turnId)).toBe(false);
    await expect(parent.wait(cursor, 0)).resolves.toBeUndefined();
  });

  it('does not persist an empty mailbox drain', async () => {
    const save = vi.fn(async () => undefined);
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: { async load() { return undefined; }, save },
    });
    await controller.spawn('/root', { taskName: 'waiting', objective: 'Wait.' });
    const savesAfterSpawn = save.mock.calls.length;

    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toEqual([]);

    expect(save).toHaveBeenCalledTimes(savesAfterSpawn);
  });

  it('publishes mailbox messages only after their durable commit', async () => {
    const committed: string[] = [];
    let rejectNextSave = false;
    const controller = await createAgentActorController({
      executor: new DeferredExecutor(),
      store: {
        async load() { return undefined; },
        async save() {
          if (rejectNextSave) throw new Error('save failed');
        },
      },
      onMessageCommitted(message) {
        committed.push(message.content);
      },
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Wait.' });

    await controller.send('/root', '/root/worker', 'committed message');
    rejectNextSave = true;
    await expect(controller.send('/root', '/root/worker', 'rolled back message'))
      .rejects.toThrow('save failed');

    expect(committed).toEqual(['committed message']);
  });

  it('registers trusted Workflow protocol owners without consuming an Agent slot', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });

    const owner = await controller.createProtocolOwner('/root', 'run-1');

    expect(owner.callerPath).toBe('/root/workflow:run-1');
    expect(controller.list('/root')).toMatchObject({ activeNonRootTurns: 0 });
    expect(controller.get('/root', owner.callerPath).actor).toMatchObject({
      taskName: 'workflow:run-1', kind: 'workflow', state: 'running', parentPath: '/root',
    });
    const review = await owner.spawn({ taskName: 'review', objective: 'Review.' });
    expect(review).toMatchObject({
      actorPath: '/root/workflow:run-1/review',
    });
    expect(controller.list('/root').activeNonRootTurns).toBe(1);
    const ownerSignal = controller.protocolOwnerSignal(owner.callerPath);
    expect(ownerSignal.aborted).toBe(false);
    executor.pending[0]?.resolve({ output: 'reviewed' });
    await settle();
    await controller.settleProtocolOwner(owner.callerPath, 'completed', {
      output: '{"status":"completed"}',
      structured: { status: 'completed', coverage: ['review'] },
    });
    expect(controller.output('/root', owner.callerPath)).toMatchObject({
      state: 'completed',
      structured: { status: 'completed', coverage: ['review'] },
    });
    expect(controller.get('/root', '/root').mailbox.filter((message) => (
      message.senderPath === owner.callerPath && message.kind === 'completion'
    ))).toHaveLength(1);
    await expect(controller.settleProtocolOwner(owner.callerPath, 'completed', {
      output: 'duplicate terminal callback',
    })).resolves.toBeUndefined();
  });

  it('aborts a Workflow protocol owner when its parent interrupts it', async () => {
    const controller = await createAgentActorController();
    const owner = await controller.createProtocolOwner('/root', 'run-abort');
    const signal = controller.protocolOwnerSignal(owner.callerPath);

    await controller.interrupt('/root', owner.callerPath, 'goal changed');

    expect(signal).toMatchObject({ aborted: true, reason: 'goal changed' });
    expect(controller.output('/root', owner.callerPath)).toMatchObject({
      state: 'interrupted', error: 'goal changed',
    });
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

  it('atomically interrupts a controlled subtree while preserving reusable identities', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });
    await controller.interrupt('/root', '/root/parent', 'branch invalidated', 'subtree');

    expect(controller.output('/root', '/root/parent')).toMatchObject({
      state: 'interrupted', error: 'branch invalidated',
    });
    expect(controller.output('/root', '/root/parent/child')).toMatchObject({
      state: 'interrupted', error: 'branch invalidated',
    });
    expect(controller.eventSnapshot('/root')
      .filter((event) => event.kind === 'turn_interrupted')
      .slice(-2)
      .map((event) => event.actorPath))
      .toEqual(['/root/parent/child', '/root/parent']);
    await expect(controller.followup('/root', '/root/parent', 'Use the corrected premise.'))
      .resolves.toMatchObject({ delivery: 'started_turn' });
  });

  it('rejects subtree interruption atomically when one active descendant cannot interrupt', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', {
      taskName: 'remote-child',
      objective: 'Child.',
      kind: 'external',
      capabilities: {
        control: { followup: true, interrupt: false, streaming: true, artifacts: true },
      },
    });

    await expect(controller.interrupt(
      '/root',
      '/root/parent',
      'branch invalidated',
      'subtree',
    )).rejects.toMatchObject({ code: 'unsupported_operation' });

    expect(controller.output('/root', '/root/parent').state).toBe('running');
    expect(controller.output('/root', '/root/parent/remote-child').state).toBe('running');
  });

  it('derives forwarding lineage from a Runtime message id and rejects cycles and self-send', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });

    await controller.send('/root/a', '/root/b', 'Evidence from A.');
    const receivedByB = controller.get('/root', '/root/b').mailbox.at(-1);
    expect(receivedByB).toMatchObject({
      senderPath: '/root/a',
      lineage: ['/root/a'],
    });
    if (!receivedByB) throw new Error('Expected B to receive a message.');

    await expect(controller.send(
      '/root/b',
      '/root/a',
      'Forward the evidence back.',
      'internal',
      receivedByB.messageId,
    )).rejects.toMatchObject({ code: 'message_cycle_detected' });
    await expect(controller.send('/root/a', '/root/a', 'Loop.'))
      .rejects.toMatchObject({ code: 'message_cycle_detected' });
  });

  it('rejects forged forwarding references instead of trusting model-supplied lineage', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });

    await expect(controller.send(
      '/root/a',
      '/root/b',
      'Forged forward.',
      'internal',
      'msg_not_received_by_a',
    )).rejects.toMatchObject({ code: 'invalid_forward_reference' });
  });

  it('caps forwarding depth and never downgrades the source classification', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      maxConcurrentThreadsPerSession: 8,
    });
    for (const taskName of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await controller.spawn('/root', { taskName, objective: taskName.toUpperCase() });
    }

    let message = await controller.send('/root/a', '/root/b', 'Sensitive evidence.', 'sensitive');
    for (const [sender, target] of [['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']] as const) {
      message = await controller.send(
        `/root/${sender}`,
        `/root/${target}`,
        'Forwarded evidence.',
        'public',
        message.messageId,
      );
      expect(message.classification).toBe('sensitive');
    }

    await expect(controller.send(
      '/root/f',
      '/root/g',
      'One hop too far.',
      'internal',
      message.messageId,
    )).rejects.toMatchObject({ code: 'message_cycle_detected' });
  });

  it('persists only bounded recent progress and exposes bounded running and terminal summaries', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'observer', objective: 'Inspect.' });
    const execution = executor.pending[0]?.input;
    if (!execution) throw new Error('Expected a running child execution.');

    for (let index = 0; index < 8; index += 1) {
      await execution.reportProgress({
        kind: index % 2 === 0 ? 'tool' : 'status',
        summary: `activity-${index} ${'x'.repeat(300)}`,
      });
    }

    const running = controller.output('/root', child.actorPath, child.turnId);
    const listedRunning = controller.list('/root').actors.find((actor) => actor.path === child.actorPath);
    expect(running.progress).toHaveLength(6);
    expect(running.progress[0]?.summary).toMatch(/^activity-2 /u);
    expect(running.progress.every((item) => item.summary.length <= 240)).toBe(true);
    expect(listedRunning?.latestTurn).toMatchObject({
      turnId: child.turnId,
      state: 'running',
      recentActivity: running.progress,
    });
    expect(controller.eventSnapshot('/root').at(-1)).toMatchObject({
      kind: 'turn_progress',
      actorPath: child.actorPath,
      progress: expect.objectContaining({ summary: expect.stringContaining('activity-7') }),
    });

    executor.pending[0]?.resolve({ output: `terminal ${'y'.repeat(10_000)}` });
    await settle();

    const terminal = controller.output('/root', child.actorPath, child.turnId);
    const listedTerminal = controller.list('/root').actors.find((actor) => actor.path === child.actorPath);
    expect(terminal.output).toHaveLength(8_192);
    expect(terminal.output).toContain('... [truncated] ...');
    expect(terminal.output).toMatch(/^terminal y/u);
    expect(terminal.output).toMatch(/y$/u);
    expect(terminal.outputTruncated).toBe(true);
    expect(listedTerminal?.latestTurn.summary.length).toBeLessThanOrEqual(480);
    expect(listedTerminal?.latestTurn.summaryTruncated).toBe(true);
  });

  it('caps retained events without reusing sequence numbers', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'observer', objective: 'Inspect.' });
    const execution = executor.pending[0]?.input;
    if (!execution) throw new Error('Expected a running child execution.');

    for (let index = 0; index < 2_050; index += 1) {
      await execution.reportProgress({ kind: 'status', summary: `event-${index}` });
    }

    const events = controller.eventSnapshot('/root');
    expect(events).toHaveLength(2_048);
    expect(events[0]?.sequence).toBeGreaterThan(1);
    expect(events.at(-1)?.sequence).toBeGreaterThan(events[0]?.sequence ?? 0);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  });

  it('keeps bounded output on complete grapheme boundaries', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'unicode', objective: 'Render.' });

    executor.pending[0]?.resolve({ output: `terminal ${'🙂'.repeat(5_000)} tail` });
    await settle();

    const output = controller.output('/root', child.actorPath, child.turnId).output ?? '';
    expect(output.length).toBeLessThanOrEqual(8_192);
    expect(output).toContain('... [truncated] ...');
    expect(output).toMatch(/^terminal /u);
    expect(output).toMatch(/ tail$/u);
    expect(Buffer.from(output, 'utf8').toString('utf8')).toBe(output);
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

  it('atomically installs cancellation before a durable start becomes launchable', async () => {
    let releaseStartSave: (() => void) | undefined;
    let startSaveEntered: (() => void) | undefined;
    let saveCount = 0;
    const startSaveStarted = new Promise<void>((resolve) => { startSaveEntered = resolve; });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save() {
          saveCount += 1;
          if (saveCount !== 1) return;
          startSaveEntered?.();
          await new Promise<void>((resolve) => { releaseStartSave = resolve; });
        },
      },
    });

    const spawning = controller.spawn('/root', { taskName: 'racing', objective: 'Race.' });
    await startSaveStarted;
    const interrupting = controller.interrupt('/root', '/root/racing', 'cancel before launch');
    releaseStartSave?.();

    const [turn] = await Promise.all([spawning, interrupting]);
    await settle();

    expect(executor.pending).toHaveLength(1);
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted', error: 'cancel before launch',
    });
  });

  it('does not persist a late executor completion after interruption', async () => {
    const save = vi.fn(async () => undefined);
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: { async load() { return undefined; }, save },
    });
    const turn = await controller.spawn('/root', { taskName: 'late', objective: 'Finish late.' });
    await controller.interrupt('/root', turn.actorPath, 'superseded');
    const savesAfterInterrupt = save.mock.calls.length;
    const revisionAfterInterrupt = controller.list('/root').revision;

    executor.pending[0]?.resolve({ output: 'obsolete result' });
    await settle();
    await settle();

    expect(save).toHaveBeenCalledTimes(savesAfterInterrupt);
    expect(controller.list('/root').revision).toBe(revisionAfterInterrupt);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted', error: 'superseded',
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

  it('makes a closed actor inert for both mailbox directions', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'closed', objective: 'Wait.' });
    const drainClosedMailbox = executor.pending[0]?.input.drainMailbox;
    await controller.close('/root', '/root/closed');

    await expect(controller.send('/root', '/root/closed', 'Do not queue this.'))
      .rejects.toMatchObject({ code: 'actor_closed' });
    await expect(controller.send('/root/closed', '/root', 'Do not send this.'))
      .rejects.toMatchObject({ code: 'actor_closed' });
    await expect(drainClosedMailbox?.()).rejects.toMatchObject({ code: 'actor_closed' });
    expect(controller.get('/root', '/root/closed').mailbox).toEqual([]);
  });

  it('does not deliver descendant completion into a parent closed by the same subtree commit', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Wait.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Wait too.' });

    await controller.close('/root', '/root/parent', 'retire branch');

    expect(controller.get('/root', '/root/parent')).toMatchObject({
      actor: { state: 'closed' },
      mailbox: [],
    });
    expect(controller.get('/root', '/root').mailbox).toEqual([
      expect.objectContaining({
        senderPath: '/root/parent',
        recipientPath: '/root',
        kind: 'completion',
        content: 'retire branch',
      }),
    ]);
  });

  it('conflicts a distinct concurrent follow-up submitted against the same idle revision', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const firstTurn = await controller.spawn('/root', { taskName: 'worker', objective: 'First.' });
    executor.pending[0]?.resolve({ output: 'first done' });
    await settle();
    const idleRevision = controller.get('/root', firstTurn.actorPath).actor.revision;

    const accepted = controller.followup(
      '/root',
      firstTurn.actorPath,
      'Accepted follow-up.',
      undefined,
      { expectedRevision: idleRevision },
    );
    const stale = controller.followup(
      '/root',
      firstTurn.actorPath,
      'Distinct stale follow-up.',
      undefined,
      { expectedRevision: idleRevision },
    );

    await expect(accepted).resolves.toMatchObject({ delivery: 'started_turn' });
    await expect(stale).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: idleRevision,
      currentRevision: idleRevision + 1,
    });
    expect(controller.get('/root', firstTurn.actorPath).mailbox.some((message) => (
      message.content === 'Distinct stale follow-up.'
    ))).toBe(false);
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

  it('fails an unmatched external turn with an explicit unknown-state recovery error', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return snapshot; },
      async save(next) { snapshot = next; },
    };
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({ executor, store });
    await first.spawn('/root', {
      taskName: 'remote-review',
      objective: 'Review remotely.',
      kind: 'external',
    });

    const recovered = await createAgentActorController({ store });

    expect(recovered.get('/root', '/root/remote-review').actor.state).toBe('idle');
    expect(recovered.output('/root', '/root/remote-review')).toMatchObject({
      state: 'failed', error: 'external_state_unknown',
    });
  });

  it('fails closed on a newer Actor snapshot schema without overwriting it', async () => {
    let saved: AgentActorSnapshot | undefined;
    const first = await createAgentActorController({
      executor: new DeferredExecutor(),
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'worker', objective: 'Persist.' });
    if (!saved) throw new Error('Expected an Actor snapshot to be persisted.');
    const incompatible = { ...saved, schemaVersion: 2 } as unknown as AgentActorSnapshot;
    const save = vi.fn(async () => undefined);
    const recovered = new AgentActorController({
      store: { async load() { return incompatible; }, save },
    });

    await expect(recovered.initialize()).rejects.toThrow('Unsupported actor snapshot schema');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects pending completion delivery state without a terminal turn', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'worker', objective: 'Persist.' });
    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    if (!saved) throw new Error('Expected an Actor snapshot to be persisted.');
    const invalid = { ...saved, turns: [] };

    const restored = new AgentActorController({
      store: {
        async load() { return invalid; },
        async save() {},
      },
    });

    await expect(restored.initialize()).rejects.toThrow(
      'root completion turn is missing or non-terminal',
    );
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

  it('never exposes a terminal turn before its durable commit succeeds', async () => {
    let rejectCompletion: ((error: Error) => void) | undefined;
    let saveCount = 0;
    const store: AgentActorStore = {
      async load() { return undefined; },
      save() {
        saveCount += 1;
        if (saveCount === 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => { rejectCompletion = reject; });
      },
    };
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({ executor, store, onBackgroundError });
    const turn = await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });

    executor.pending[0]?.resolve({ output: 'uncommitted result' });
    await settle();

    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({ state: 'running' });
    expect(controller.eventSnapshot('/root').some((event) => event.kind === 'turn_completed')).toBe(false);

    rejectCompletion?.(new Error('completion save failed'));
    await settle();
    await settle();

    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({ state: 'running' });
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'completion save failed',
    }));
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

  it('cancels an actor event waiter promptly when its owning round is interrupted', async () => {
    const controller = await createAgentActorController();
    const root = controller.bind('/root');
    const cursor = root.eventSnapshot().at(-1)?.sequence ?? 0;
    const abort = new AbortController();

    const waiting = root.wait(cursor, 30_000, abort.signal);
    abort.abort('user input');

    await expect(waiting).resolves.toBeUndefined();
  });

  it('returns an already committed visible event without installing a waiter', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const root = controller.bind('/root');
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    const existing = root.eventSnapshot()[0];

    expect(existing).toBeDefined();
    await expect(root.wait(0, 30_000)).resolves.toEqual(existing);
  });
});
