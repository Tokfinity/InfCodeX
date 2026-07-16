import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AampLogger } from '../src/aamp_logger.js';
import type { AampTaskExecutionResult } from '../src/aamp_runtime.js';
import type { AgentProcessHandle, AgentProcessSpawner } from '../src/aamp_server.js';
import type {
  AampDispatchEnvelope,
  AampTaskAck,
  AampTaskResult,
  AampTransport,
  WorkerStreamEventMessage,
} from '../src/aamp_types.js';

const { runKodaXMock } = vi.hoisted(() => ({
  runKodaXMock: vi.fn(),
}));

const { prepareRuntimeConfigMock } = vi.hoisted(() => ({
  prepareRuntimeConfigMock: vi.fn(),
}));

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return {
    ...actual,
    runKodaX: runKodaXMock,
  };
});

vi.mock('@kodax-ai/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/repl')>();
  return {
    ...actual,
    prepareRuntimeConfig: prepareRuntimeConfigMock,
  };
});

import { KodaXAampRuntime } from '../src/aamp_runtime.js';
import { KodaXAampServer, resetAampServerSingletonForTests } from '../src/aamp_server.js';
import { FileAampTaskStore } from '../src/aamp_store.js';

// Imported after mocks are set up so FileSessionStorage uses the (partially) mocked repl module.
const { FileSessionStorage } = await import('@kodax-ai/repl');

class MockAampTransport implements AampTransport {
  readonly acks: AampTaskAck[] = [];
  readonly results: AampTaskResult[] = [];
  readonly streamCreates: Array<{ taskId: string; peerEmail: string }> = [];
  readonly streamOpened: Array<{
    to: string;
    taskId: string;
    streamId: string;
    inReplyTo: string;
  }> = [];
  readonly streamEvents: Array<{
    streamId: string;
    type: string;
    payload: Record<string, unknown>;
  }> = [];
  readonly streamClosures: Array<{
    streamId: string;
    payload?: Record<string, unknown>;
  }> = [];
  readonly operations: string[] = [];
  private handler: ((dispatch: AampDispatchEnvelope) => Promise<void>) | null = null;
  private cancelHandler: ((targetTaskId: string) => void) | null = null;
  ackError: Error | null = null;
  resultError: Error | null = null;
  createStreamError: Error | null = null;
  closeStreamError: Error | null = null;
  appendStreamFailure: ((event: {
    streamId: string;
    type: string;
    payload: Record<string, unknown>;
  }) => Error | null) | null = null;

  async listen(
    handler: (dispatch: AampDispatchEnvelope) => Promise<void>,
    cancelHandler?: (targetTaskId: string) => void,
  ): Promise<void> {
    this.handler = handler;
    this.cancelHandler = cancelHandler ?? null;
  }

  async sendAck(ack: AampTaskAck): Promise<void> {
    if (this.ackError) {
      throw this.ackError;
    }
    this.acks.push(ack);
  }

  async sendResult(result: AampTaskResult): Promise<void> {
    if (this.resultError) {
      throw this.resultError;
    }
    this.operations.push('result');
    this.results.push(result);
  }

  async createStream(opts: { taskId: string; peerEmail: string }): Promise<{ streamId: string }> {
    this.operations.push('create');
    if (this.createStreamError) {
      throw this.createStreamError;
    }
    this.streamCreates.push(opts);
    return { streamId: 'stream-1' };
  }

  async sendStreamOpened(opts: {
    to: string;
    taskId: string;
    streamId: string;
    inReplyTo: string;
  }): Promise<void> {
    this.operations.push('opened');
    this.streamOpened.push(opts);
  }

  async appendStreamEvent(opts: {
    streamId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.operations.push(`append:${opts.type}`);
    this.streamEvents.push(opts);
    const failure = this.appendStreamFailure?.(opts);
    if (failure) {
      throw failure;
    }
  }

  async closeStream(opts: { streamId: string; payload?: Record<string, unknown> }): Promise<void> {
    this.operations.push('close');
    this.streamClosures.push(opts);
    if (this.closeStreamError) {
      throw this.closeStreamError;
    }
  }

  async dispatch(dispatch: AampDispatchEnvelope): Promise<void> {
    if (!this.handler) {
      throw new Error('AAMP handler not registered');
    }
    await this.handler(dispatch);
  }

  cancel(targetTaskId: string): void {
    if (!this.cancelHandler) {
      throw new Error('AAMP cancel handler not registered');
    }
    this.cancelHandler(targetTaskId);
  }
}

/** KodaXResult-shaped mock return value for runKodaXMock. */
function createResult(overrides: Partial<Awaited<ReturnType<typeof runKodaXMock>>> = {}) {
  return {
    success: true,
    lastText: 'done',
    messages: [],
    sessionId: 'session-from-runtime',
    interrupted: false,
    ...overrides,
  };
}

const STREAMING_ROLE_MARKER = '你是一名在本地环境中执行开发任务的工程师。';

type TestStreamOptions = Parameters<AgentProcessSpawner>[2];

function createExecutionResult(
  dispatch: AampDispatchEnvelope,
  output = 'final answer',
): AampTaskExecutionResult {
  return {
    result: createResult({ lastText: output }),
    outbound: {
      taskId: dispatch.taskId,
      to: dispatch.from,
      status: 'completed',
      output,
      inReplyToMessageId: dispatch.messageId,
    },
  };
}

function createDirectSpawner(
  execute: (
    dispatch: AampDispatchEnvelope,
    streamOptions: TestStreamOptions,
  ) => Promise<AampTaskExecutionResult>,
): AgentProcessSpawner {
  return (dispatch, record, streamOptions) => {
    void record;
    return {
      pid: 24680,
      kill: vi.fn(),
      resultPromise: execute(dispatch, streamOptions),
    };
  };
}

/**
 * Build a mock AgentProcessSpawner that wraps KodaXAampRuntime.execute
 * in-process so the runKodaXMock is exercised without spawning real OS processes.
 */
function createMockSpawner(
  tempDir: string,
  dangerousFullPermissions = false,
): AgentProcessSpawner {
  return (dispatch, record) => {
    const runtime = new KodaXAampRuntime({
      provider: 'openai',
      model: 'gpt-5.4',
      repoRoot: tempDir,
      sessionStorage: new FileSessionStorage(),
      dangerousFullPermissions,
    });
    const resultPromise = runtime.execute(dispatch, record);
    return {
      pid: 12345,
      kill: vi.fn(),
      resultPromise,
    };
  };
}

describe('KodaXAampServer', () => {
  let tempDir: string;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let logger: AampLogger & {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAampServerSingletonForTests();
    prepareRuntimeConfigMock.mockReturnValue({
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'auto',
      permissionMode: 'accept-edits',
    });
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-aamp-test-'));
  });

  afterEach(async () => {
    resetAampServerSingletonForTests();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('acknowledges dispatches and returns task results', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: 'AAMP task completed' }));

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-1',
      from: 'agent@example.com',
      bodyText: 'Review this repository',
      messageId: 'msg-1',
      dispatchContext: { project_key: 'proj_123' },
    });

    expect(transport.acks).toEqual([
      {
        taskId: 'task-1',
        to: 'agent@example.com',
        inReplyToMessageId: 'msg-1',
      },
    ]);
    expect(transport.results).toEqual([
      {
        taskId: 'task-1',
        to: 'agent@example.com',
        status: 'completed',
        output: 'AAMP task completed',
        inReplyToMessageId: 'msg-1',
      },
    ]);
    expect(runKodaXMock).toHaveBeenCalledTimes(1);
    expect(runKodaXMock.mock.calls[0]?.[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      context: {
        gitRoot: tempDir,
        executionCwd: tempDir,
        rawUserInput: 'Review this repository',
      },
      session: {
        scope: 'user',
      },
    });
    expect(runKodaXMock.mock.calls[0]?.[1]).toContain('Dispatch Context:');
    expect(logger.info).toHaveBeenCalledWith('worker.starting', 'worker starting', expect.objectContaining({
      repoRoot: tempDir,
      provider: 'openai',
      model: 'gpt-5.4',
      dangerousFullPermissions: false,
    }));
    expect(logger.info).toHaveBeenCalledWith('worker.started', 'worker listening for task.dispatch messages', expect.any(Object));
    expect(logger.info).toHaveBeenCalledWith('dispatch.received', 'received task.dispatch', expect.objectContaining({
      taskId: 'task-1',
      sender: 'agent@example.com',
    }));
    expect(logger.info).toHaveBeenCalledWith('task.result_sent', 'sent task.result', expect.objectContaining({
      taskId: 'task-1',
      status: 'completed',
    }));
    expect(logger.info).toHaveBeenCalledWith('task.process_spawned', 'agent process spawned', expect.objectContaining({
      taskId: 'task-1',
      pid: 12345,
    }));
  });

  it('returns structured plan_todos result when final output is valid JSON', async () => {
    runKodaXMock.mockResolvedValue(createResult({
      lastText: JSON.stringify({
        summary: '完成结构化计划输出',
        todos: ['梳理 runtime 输出', '解析 JSON 结果', '回传 structuredResult'],
      }),
    }));

    const transport = new MockAampTransport();
    const taskStore = new FileAampTaskStore(path.join(tempDir, 'tasks.json'));
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore,
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-plan',
      from: 'agent@example.com',
      bodyText: 'Please plan todos',
      messageId: 'msg-plan',
      dispatchContext: { state_key: 'state_2' },
    });

    expect(transport.results).toEqual([
      {
        taskId: 'task-plan',
        to: 'agent@example.com',
        status: 'completed',
        output: '{"summary":"完成结构化计划输出","todos":["梳理 runtime 输出","解析 JSON 结果","回传 structuredResult"]}',
        inReplyToMessageId: 'msg-plan',
        structuredResult: [
          {
            fieldKey: 'summary',
            fieldAlias: 'summary',
            fieldTypeKey: 'text',
            value: '完成结构化计划输出',
          },
          {
            fieldKey: 'todos',
            fieldAlias: 'todos',
            fieldTypeKey: 'json',
            value: ['梳理 runtime 输出', '解析 JSON 结果', '回传 structuredResult'],
          },
        ],
      },
    ]);

    expect(await taskStore.get('task-plan')).toMatchObject({
      status: 'completed',
      executionStatus: 'completed',
      resultSummary: '{"summary":"完成结构化计划输出","todos":["梳理 runtime 输出","解析 JSON 结果","回传 structuredResult"]}',
      planningSummary: '完成结构化计划输出',
      todoList: ['梳理 runtime 输出', '解析 JSON 结果', '回传 structuredResult'],
    });
  });

  it('falls back to empty structured todos when plan_todos JSON parsing fails', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: '非 JSON 计划摘要' }));

    const transport = new MockAampTransport();
    const taskStore = new FileAampTaskStore(path.join(tempDir, 'tasks.json'));
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore,
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-plan-fallback',
      from: 'agent@example.com',
      bodyText: 'Please plan todos',
      messageId: 'msg-plan-fallback',
      dispatchContext: { state_key: 'state_2' },
    });

    expect(transport.results).toEqual([
      {
        taskId: 'task-plan-fallback',
        to: 'agent@example.com',
        status: 'completed',
        output: '非 JSON 计划摘要',
        inReplyToMessageId: 'msg-plan-fallback',
        structuredResult: [
          {
            fieldKey: 'summary',
            fieldAlias: 'summary',
            fieldTypeKey: 'text',
            value: '非 JSON 计划摘要',
          },
          {
            fieldKey: 'todos',
            fieldAlias: 'todos',
            fieldTypeKey: 'json',
            value: [],
          },
        ],
      },
    ]);

    expect(await taskStore.get('task-plan-fallback')).toMatchObject({
      status: 'completed',
      executionStatus: 'completed',
      resultSummary: '非 JSON 计划摘要',
      planningSummary: '非 JSON 计划摘要',
      todoList: [],
      parseError: expect.any(String),
    });
  });

  it('blocks non-read bash commands by default because AAMP cannot prompt for approval', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'rm -rf dist' },
        { toolId: 'tool-bash-write' },
      );

      expect(decision).toContain('--dangerous-full-permissions');
      return createResult({ lastText: 'blocked by test harness' });
    });

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-bash-blocked',
      from: 'agent@example.com',
      bodyText: 'Clean up the repo',
      messageId: 'msg-bash-blocked',
    });

    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Blocking shell command without --dangerous-full-permissions: rm -rf dist',
      ),
    );
  });

  it('still auto-allows read-only bash commands in default AAMP mode', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'git status --short' },
        { toolId: 'tool-bash-read' },
      );

      expect(decision).toBe(true);
      return createResult({ lastText: 'read command ok' });
    });

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-bash-read',
      from: 'agent@example.com',
      bodyText: 'Inspect the repo',
      messageId: 'msg-bash-read',
    });
  });

  it('allows destructive shell commands in dangerous full permissions mode', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'rm -rf dist' },
        { toolId: 'tool-bash-dangerous' },
      );

      expect(decision).toBe(true);
      return createResult({ lastText: 'dangerous shell ok' });
    });

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      dangerousFullPermissions: true,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir, true),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-bash-dangerous',
      from: 'agent@example.com',
      bodyText: 'Delete build outputs',
      messageId: 'msg-bash-dangerous',
    });

    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'worker.starting',
      'worker starting',
      expect.objectContaining({ dangerousFullPermissions: true }),
    );
  });

  it('keeps a small hard blacklist even in dangerous full permissions mode', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'sudo rm -rf /tmp/demo' },
        { toolId: 'tool-bash-blacklisted' },
      );

      expect(decision).toBe(
        '[Blocked] AAMP shell hard blacklist: privilege escalation via sudo is blocked.',
      );
      return createResult({ lastText: 'hard blacklist enforced' });
    });

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      dangerousFullPermissions: true,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir, true),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-bash-blacklisted',
      from: 'agent@example.com',
      bodyText: 'Run a forbidden shell command',
      messageId: 'msg-bash-blacklisted',
    });
  });


  it('opens streams only for dispatches carrying the engineering role marker', async () => {
    const transport = new MockAampTransport();
    let receivedStreamOptions: TestStreamOptions;
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createDirectSpawner(async (dispatch, streamOptions) => {
        receivedStreamOptions = streamOptions;
        return createExecutionResult(dispatch);
      }),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-non-streaming',
      from: 'agent@example.com',
      bodyText: 'Implement the requested change.',
      messageId: 'msg-non-streaming',
    });

    expect(receivedStreamOptions).toBeUndefined();
    expect(transport.streamCreates).toHaveLength(0);
    expect(transport.results).toHaveLength(1);
  });

  it('forwards worker deltas before done/close and keeps the final result separate', async () => {
    const transport = new MockAampTransport();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createDirectSpawner(async (dispatch, streamOptions) => {
        expect(streamOptions?.streamId).toBe('stream-1');
        streamOptions?.onStreamEvent({
          __streamEvent: true,
          eventType: 'text.delta',
          payload: { text: 'partial answer' },
        });
        return createExecutionResult(dispatch, 'final answer');
      }),
    });

    try {
      await server.start();
      await transport.dispatch({
        taskId: 'task-streaming-order',
        from: 'agent@example.com',
        bodyText: `${STREAMING_ROLE_MARKER}
Implement the requested change.`,
        messageId: 'msg-streaming-order',
      });

      expect(transport.operations).toEqual([
        'create',
        'opened',
        'append:status',
        'append:text.delta',
        'append:done',
        'close',
        'result',
      ]);
      expect(transport.results[0]?.output).toBe('final answer');
      expect(transport.results[0]?.output).not.toContain('partial answer');
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it('continues as a normal task when stream setup fails', async () => {
    const transport = new MockAampTransport();
    transport.createStreamError = new Error('stream service unavailable');
    let receivedStreamOptions: TestStreamOptions;
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createDirectSpawner(async (dispatch, streamOptions) => {
        receivedStreamOptions = streamOptions;
        return createExecutionResult(dispatch);
      }),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-stream-setup-failed',
      from: 'agent@example.com',
      bodyText: `${STREAMING_ROLE_MARKER}
Implement the requested change.`,
      messageId: 'msg-stream-setup-failed',
    });

    expect(receivedStreamOptions).toBeUndefined();
    expect(transport.results).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      'stream.setup_failed',
      'failed to set up stream, proceeding without streaming',
      expect.objectContaining({ error: 'stream service unavailable' }),
    );
  });

  it('suppresses later appends and teardown after the server reports a closed stream', async () => {
    const transport = new MockAampTransport();
    transport.appendStreamFailure = (event) => (
      event.type === 'text.delta' && event.payload.text === 'first'
        ? new Error('HTTP 409: stream already closed')
        : null
    );
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createDirectSpawner(async (dispatch, streamOptions) => {
        const first: WorkerStreamEventMessage = {
          __streamEvent: true,
          eventType: 'text.delta',
          payload: { text: 'first' },
        };
        const second: WorkerStreamEventMessage = {
          __streamEvent: true,
          eventType: 'text.delta',
          payload: { text: 'second' },
        };
        streamOptions?.onStreamEvent(first);
        await Promise.resolve();
        await Promise.resolve();
        streamOptions?.onStreamEvent(second);
        await Promise.resolve();
        return createExecutionResult(dispatch);
      }),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-stream-remotely-closed',
      from: 'agent@example.com',
      bodyText: `${STREAMING_ROLE_MARKER}
Implement the requested change.`,
      messageId: 'msg-stream-remotely-closed',
    });

    expect(transport.streamEvents.map((event) => [event.type, event.payload.text])).toEqual([
      ['status', undefined],
      ['text.delta', 'first'],
    ]);
    expect(transport.streamClosures).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      'stream.remotely_closed',
      'stream was closed by server (idle timeout); suppressing further appends',
      expect.objectContaining({ streamId: 'stream-1' }),
    );
  });

  it('logs stream close failures on the task error path without hiding the task result', async () => {
    const transport = new MockAampTransport();
    transport.closeStreamError = new Error('close request failed');
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createDirectSpawner(async () => {
        throw new Error('runtime failed');
      }),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-stream-error-close-failed',
      from: 'agent@example.com',
      bodyText: `${STREAMING_ROLE_MARKER}
Implement the requested change.`,
      messageId: 'msg-stream-error-close-failed',
    });

    expect(transport.results).toEqual([
      expect.objectContaining({ status: 'failed', output: 'runtime failed' }),
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      'stream.close_failed',
      'failed to close stream',
      expect.objectContaining({
        taskId: 'task-stream-error-close-failed',
        streamId: 'stream-1',
        error: 'close request failed',
      }),
    );
  });

  it('skips duplicate completed task dispatches', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: 'done once' }));

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();

    const dispatch: AampDispatchEnvelope = {
      taskId: 'task-2',
      from: 'agent@example.com',
      bodyText: 'Do it',
      messageId: 'msg-2',
    };

    await transport.dispatch(dispatch);
    await transport.dispatch(dispatch);

    expect(runKodaXMock).toHaveBeenCalledTimes(1);
    expect(transport.acks).toHaveLength(1);
    expect(transport.results).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith('dispatch.duplicate_skipped', 'skip duplicate completed task', expect.objectContaining({
      taskId: 'task-2',
    }));
  });

  it('allows only one AAMP server instance per process', async () => {
    const first = new KodaXAampServer({
      transport: new MockAampTransport(),
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks-a.json')),
    });
    const second = new KodaXAampServer({
      transport: new MockAampTransport(),
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks-b.json')),
    });

    await first.start();
    await expect(second.start()).rejects.toThrow('AAMP server is already running in this process');

    expect(logger.error).toHaveBeenCalledWith(
      'worker.singleton_violation',
      'refusing to start a second AAMP worker',
      expect.any(Object),
    );

    await first.stop();
    await expect(second.start()).resolves.toBeUndefined();
  });

  it('swallows secondary sendResult failures after a task error so the worker stays alive', async () => {
    runKodaXMock.mockRejectedValue(new Error('primary execution failed'));

    const transport = new MockAampTransport();
    transport.resultError = new Error('HTTP send failed: 401');
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await expect(transport.dispatch({
      taskId: 'task-3',
      from: 'agent@example.com',
      bodyText: 'Do it',
      messageId: 'msg-3',
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'task.failed',
      'task failed',
      expect.objectContaining({
        taskId: 'task-3',
        error: 'primary execution failed',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'task.failure_result_send_failed',
      'failed to send failed task.result',
      expect.objectContaining({
        taskId: 'task-3',
        error: 'HTTP send failed: 401',
        originalError: 'primary execution failed',
      }),
    );
  });

  it('persists failed execution status for plan_todos tasks when runtime execution throws', async () => {
    runKodaXMock.mockRejectedValue(new Error('primary execution failed'));

    const transport = new MockAampTransport();
    const taskStore = new FileAampTaskStore(path.join(tempDir, 'tasks.json'));
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      logger,
      taskStore,
      processSpawner: createMockSpawner(tempDir),
    });

    await server.start();
    await transport.dispatch({
      taskId: 'task-plan-runtime-failed',
      from: 'agent@example.com',
      bodyText: 'Please plan todos',
      messageId: 'msg-plan-runtime-failed',
      dispatchContext: { state_key: 'state_2' },
    });

    expect(await taskStore.get('task-plan-runtime-failed')).toMatchObject({
      status: 'failed',
      executionStatus: 'failed',
      resultSummary: 'primary execution failed',
    });
  });

});
