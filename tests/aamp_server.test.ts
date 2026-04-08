import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AampLogger } from '../src/aamp_logger.js';
import type { AampTaskExecutionResult } from '../src/aamp_runtime.js';
import type { AgentProcessHandle, AgentProcessSpawner } from '../src/aamp_server.js';
import type { AampDispatchEnvelope, AampTaskAck, AampTaskResult, AampTransport } from '../src/aamp_types.js';

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
  private handler: ((dispatch: AampDispatchEnvelope) => Promise<void>) | null = null;
  private cancelHandler: ((targetTaskId: string) => void) | null = null;
  ackError: Error | null = null;
  resultError: Error | null = null;

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
    this.results.push(result);
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

});
