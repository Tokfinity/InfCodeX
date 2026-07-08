import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ManagedRunClassification,
  WorkflowEvent,
} from '@kodax-ai/agent';
import type {
  KodaXOptions,
  KodaXResult,
  RunningSession,
} from '@kodax-ai/coding';

const codingMock = vi.hoisted(() => ({
  startKodaX: vi.fn(),
}));

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return {
    ...actual,
    startKodaX: codingMock.startKodaX,
  };
});

describe('createKodaXRuntime', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-'));
    codingMock.startKodaX.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates, lists, loads, transcripts, and forks sessions through one runtime service', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const seen: string[] = [];
    runtime.events.subscribe({}, (event) => seen.push(event.type));

    const session = await runtime.sessions.create({
      title: 'Runtime Test',
      projectPath: tempRoot,
      surface: 'sdk-test',
      profileId: 'coder',
    });
    const listed = await runtime.sessions.list({ limit: 10 });
    const loaded = await runtime.sessions.load(session.id);
    const transcript = await runtime.sessions.transcript(session.id);
    const forked = await runtime.sessions.fork({
      sessionId: session.id,
      title: 'Runtime Fork',
    });

    expect(session.title).toBe('Runtime Test');
    expect(session.workspaceRoot).toBe(path.resolve(tempRoot));
    expect(listed.map((item) => item.id)).toContain(session.id);
    expect(loaded.id).toBe(session.id);
    expect(transcript?.transcriptEntries).toEqual([]);
    expect(forked?.title).toBe('Runtime Fork');
    expect(seen.filter((type) => type === 'session.created')).toHaveLength(2);

    await runtime.close();
  });

  it('normalizes run callbacks into scoped runtime events and terminal status', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Run Test' });
    const events: Array<{
      type: string;
      sessionId: string;
      runId: string;
      seq: number;
      time: string;
      turnId?: string;
    }> = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      events.push({
        type: event.type,
        sessionId: event.sessionId,
        runId: event.runId,
        seq: event.seq,
        time: event.time,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
    });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      expect(prompt).toBe('hello runtime');
      const sessionId = options.session?.id ?? 'missing-session';
      queueMicrotask(() => {
        options.events?.onTurnStarted?.({
          sessionId,
          seq: 1,
          turnId: 'turn-1',
          deliveryKind: 'initial',
          timestamp: '2026-07-08T00:00:00.000Z',
        });
        options.events?.onTextDelta?.('hi', {
          sessionId,
          seq: 2,
          turnId: 'turn-1',
          timestamp: '2026-07-08T00:00:00.001Z',
        });
        options.events?.onToolUseStart?.(
          { id: 'tool-1', name: 'bash', input: { command: 'pwd' } },
          {
            sessionId,
            seq: 3,
            turnId: 'turn-1',
            toolId: 'tool-1',
            timestamp: '2026-07-08T00:00:00.002Z',
          },
        );
        options.events?.onToolResult?.(
          { id: 'tool-1', name: 'bash', content: 'ok' },
          {
            sessionId,
            seq: 4,
            turnId: 'turn-1',
            toolId: 'tool-1',
            timestamp: '2026-07-08T00:00:00.003Z',
          },
        );
      });
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId,
      }));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: { type: 'text', text: 'hello runtime' },
    });
    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const replay = await runtime.events.replay({ runId: handle.runId });
    const assistantReplay = await runtime.events.replay({
      runId: handle.runId,
      type: 'assistant.delta',
    });

    expect(result.phase).toBe('completed');
    expect(status.phase).toBe('completed');
    expect(status.turnId).toBe('turn-1');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'assistant.delta',
      'tool.started',
      'tool.finished',
      'run.completed',
    ]);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([handle.runId]));
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(events.every((event) => event.seq > 0 && event.time.includes('T'))).toBe(true);
    expect(replay.every((event) => event.sessionId === session.id)).toBe(true);
    expect(replay.every((event) => event.runId === handle.runId)).toBe(true);
    expect(replay.every((event) => event.id && event.time && event.seq > 0)).toBe(true);
    expect(replay.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(assistantReplay.map((event) => event.type)).toEqual(['assistant.delta']);

    await runtime.close();
  });

  it('serializes runs within one session while allowing queued status to be observed', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Queue Test' });
    const starts: string[] = [];
    const queuedEvents: string[] = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;

    runtime.events.subscribe({ type: 'run.queued' }, (event) => queuedEvents.push(event.runId));
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      const sessionId = options.session?.id ?? session.id;
      starts.push(prompt);
      if (prompt === 'first') {
        return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
          finishFirst = resolve;
        }));
      }
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishSecond = resolve;
      }));
    });

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const second = await runtime.runs.start({ sessionId: session.id, prompt: 'second' });

    expect(starts).toEqual(['first']);
    expect((await runtime.runs.get(first.runId)).phase).toBe('running');
    expect((await runtime.runs.get(second.runId)).phase).toBe('queued');
    expect(queuedEvents).toEqual([second.runId]);

    finishFirst?.({
      success: true,
      lastText: 'first done',
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();

    expect(starts).toEqual(['first', 'second']);
    expect((await runtime.runs.get(second.runId)).phase).toBe('running');

    finishSecond?.({
      success: true,
      lastText: 'second done',
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: 'completed' });

    await runtime.close();
  });

  it('persists runtime replay and terminal run status across runtime recreation', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Persistence Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? session.id;
      queueMicrotask(() => {
        options.events?.onTextDelta?.('persist me', {
          sessionId,
          seq: 1,
          timestamp: new Date().toISOString(),
        });
      });
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'persisted',
        messages: [],
        sessionId,
      }));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'persist' });
    await handle.result;
    const snapshot = await runtime.status.snapshot();
    expect(snapshot.runs).toContainEqual(expect.objectContaining({
      runId: handle.runId,
      phase: 'completed',
    }));
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'mock-provider',
    });
    const replay = await recreated.events.replay({ runId: handle.runId });
    const restoredStatus = await recreated.runs.get(handle.runId);

    expect(replay.map((event) => event.type)).toEqual([
      'run.started',
      'assistant.delta',
      'run.completed',
    ]);
    expect(restoredStatus).toMatchObject({
      runId: handle.runId,
      sessionId: session.id,
      phase: 'completed',
    });

    await recreated.close();
  });

  it('rejects runs for missing sessions before calling the coding layer', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });

    await expect(runtime.runs.start({
      sessionId: 'missing-session',
      prompt: 'should not start',
    })).rejects.toThrow('Session not found: missing-session');
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

    await runtime.close();
  });

  it('keeps an aborted run cancelled even if the coding promise later resolves', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Abort Race Test' });
    let finishRun: ((value: KodaXResult) => void) | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishRun = resolve;
      }))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'abort me' });
    await runtime.runs.abort(handle.runId);
    finishRun?.({
      success: true,
      lastText: 'late success',
      messages: [],
      sessionId: session.id,
    });

    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const terminalEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ['run.completed', 'run.cancelled'],
    });

    expect(result.phase).toBe('cancelled');
    expect(status.phase).toBe('cancelled');
    expect(terminalEvents.map((event) => event.type)).toEqual(['run.cancelled']);

    await runtime.close();
  });

  it('reports failed run status when the coding layer rejects', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Failure Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, Promise.reject(new Error('provider exploded')))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'fail' });
    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const failedEvents = await runtime.events.replay({
      runId: handle.runId,
      type: 'run.failed',
    });

    expect(result.phase).toBe('failed');
    expect(result.error?.message).toBe('provider exploded');
    expect(status).toMatchObject({ phase: 'failed', error: 'provider exploded' });
    expect(failedEvents).toHaveLength(1);

    await runtime.close();
  });

  it('tracks pending permission requests from wrapped tool approval hooks', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Test' });
    let releaseApproval: ((value: boolean) => void) | undefined;
    let approvalDone: Promise<boolean | string> | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-permission',
            toolId: 'tool-permission',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs permission',
      options: {
        events: {
          beforeToolExecute: () => new Promise<boolean>((resolve) => {
            releaseApproval = resolve;
          }),
        },
      },
    });

    await flushMicrotasks();
    const pending = await runtime.permissions.listPending({ runId: handle.runId });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe('bash');

    releaseApproval?.(true);
    await approvalDone;

    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);
    const permissionEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ['permission.requested', 'permission.resolved'],
    });
    expect(permissionEvents.map((event) => event.type)).toEqual([
      'permission.requested',
      'permission.resolved',
    ]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('lets runtime permission responses resolve pending approval hooks', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Respond Test' });
    let approvalDone: Promise<boolean | string> | undefined;
    let requestId = '';

    runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === 'string') {
        requestId = payload.id;
        void runtime.permissions.respond(payload.id, { type: 'allow_once' });
      }
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-permission-respond',
            toolId: 'tool-permission-respond',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs runtime permission response',
      options: {
        events: {
          beforeToolExecute: () => new Promise<boolean>(() => undefined),
        },
      },
    });

    await flushMicrotasks();

    expect(requestId).toMatch(/^perm_/);
    await expect(approvalDone).resolves.toBe(true);
    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);
    expect(await runtime.permissions.respond(requestId, { type: 'allow_once' })).toBe(false);
    expect(await runtime.permissions.respond('missing-permission', { type: 'allow_once' })).toBe(false);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('brokers permission requests even when the host did not provide an approval hook', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Broker Test' });
    let approvalDone: Promise<boolean | string> | undefined;

    runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === 'string') {
        void runtime.permissions.respond(payload.id, { type: 'allow_once' });
      }
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-broker',
            toolId: 'tool-broker',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs broker permission',
    });

    await flushMicrotasks();

    await expect(approvalDone).resolves.toBe(true);
    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('aborts the targeted running session only', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const first = await runtime.sessions.create({ title: 'First' });
    const second = await runtime.sessions.create({ title: 'Second' });
    const aborts = new Map<string, number>();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    runtime.events.subscribe({ sessionId: first.id }, (event) => firstEvents.push(event.type));
    runtime.events.subscribe({ sessionId: second.id }, (event) => secondEvents.push(event.type));

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? 'missing-session';
      queueMicrotask(() => {
        options.events?.onTextDelta?.(`delta-${sessionId}`, {
          sessionId,
          seq: 1,
          timestamp: new Date().toISOString(),
        });
      });
      const session = fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
      return {
        ...session,
        abort(reason?: unknown) {
          aborts.set(sessionId, (aborts.get(sessionId) ?? 0) + 1);
          session.abort(reason);
        },
      };
    });

    const firstRun = await runtime.runs.start({ sessionId: first.id, prompt: 'first' });
    const secondRun = await runtime.runs.start({ sessionId: second.id, prompt: 'second' });
    await flushMicrotasks();

    await runtime.runs.abort(firstRun.runId);
    const firstReplay = await runtime.events.replay({ runId: firstRun.runId });
    const secondReplay = await runtime.events.replay({ runId: secondRun.runId });

    expect(aborts.get(first.id)).toBe(1);
    expect(aborts.get(second.id)).toBeUndefined();
    expect((await runtime.runs.get(firstRun.runId)).phase).toBe('cancelled');
    expect((await runtime.runs.get(secondRun.runId)).phase).toBe('running');
    expect(firstEvents).toContain('assistant.delta');
    expect(firstEvents).toContain('run.cancelled');
    expect(firstEvents).not.toContain('run.completed');
    expect(secondEvents).toContain('assistant.delta');
    expect(secondEvents).not.toContain('run.cancelled');
    expect(firstReplay.every((event) => event.sessionId === first.id)).toBe(true);
    expect(secondReplay.every((event) => event.sessionId === second.id)).toBe(true);

    await runtime.close();
  });

  it('wraps the existing workflow run manager without creating a second workflow store', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { getDefaultWorkflowRunManager } = await import('@kodax-ai/agent');
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const manager = getDefaultWorkflowRunManager();
    const runId = `runtime-workflow-${Date.now()}`;
    const workflowEvents: string[] = [];
    let finishWorkflow: (() => void) | undefined;
    const subscription = runtime.workflows.subscribe({ runId }, (event) => {
      workflowEvents.push(event.type);
    });

    const run = manager.start<WorkflowOutcome>({
      runId,
      workflow: 'runtime-contract-test',
      processMetadata: {
        source: 'sdk',
        hostMetadata: { sessionId: 'workflow-session' },
      },
      runFn: async (hooks) => {
        hooks.onEvent(workflowEvent('agent_spawned', 1));
        await new Promise<void>((resolve) => {
          finishWorkflow = resolve;
        });
        hooks.onEvent(workflowEvent('agent_completed', 2));
        hooks.onEvent({
          type: 'workflow_completed',
          seq: 3,
          data: { resultSummary: 'workflow ok' },
        });
        return { kind: 'completed', result: 'workflow ok' };
      },
      classify: classifyWorkflowOutcome,
      onError: workflowErrorOutcome,
    });

    await flushMicrotasks();

    expect(await runtime.workflows.list({ runId })).toHaveLength(1);
    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      workflowName: 'runtime-contract-test',
      status: 'running',
    });
    expect(await runtime.workflows.pause(runId)).toBe(true);
    expect((await runtime.workflows.get(runId))?.status).toBe('paused');
    expect(await runtime.workflows.resume(runId)).toBe(true);

    finishWorkflow?.();
    await run.done;

    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      status: 'completed',
      resultSummary: 'workflow ok',
    });
    expect(workflowEvents).toContain('workflow_updated');
    expect(workflowEvents).toContain('workflow_finished');
    expect(await runtime.workflows.stop('missing-workflow')).toBe(false);

    subscription.close();
    await runtime.close();
  });
});

type WorkflowOutcome =
  | { readonly kind: 'completed'; readonly result: string }
  | { readonly kind: 'failed'; readonly error: Error };

function classifyWorkflowOutcome(outcome: WorkflowOutcome): ManagedRunClassification {
  if (outcome.kind === 'completed') {
    return { status: 'completed', resultText: outcome.result };
  }
  return { status: 'failed', error: outcome.error };
}

function workflowErrorOutcome(error: unknown): WorkflowOutcome {
  return {
    kind: 'failed',
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

function workflowEvent(type: WorkflowEvent['type'], seq: number): WorkflowEvent {
  return { type, seq };
}

function fakeRunningSession(
  options: KodaXOptions,
  result: Promise<KodaXResult>,
): RunningSession {
  let aborted = false;
  let provider = options.provider;
  let model = options.modelOverride ?? options.model;
  let reasoning = options.reasoningMode;
  return {
    id: options.session?.id ?? 'missing-session',
    get currentProvider() {
      return provider;
    },
    get currentModel() {
      return model;
    },
    get currentReasoning() {
      return reasoning;
    },
    get aborted() {
      return aborted;
    },
    attached: true,
    setProvider(name) {
      provider = name;
    },
    setModel(nextModel) {
      model = nextModel;
    },
    setReasoning(nextReasoning) {
      reasoning = nextReasoning;
    },
    abort() {
      aborted = true;
    },
    result,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
