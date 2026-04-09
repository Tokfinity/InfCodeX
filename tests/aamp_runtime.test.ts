import type { KodaXEvents, KodaXOptions, KodaXResult } from '@kodax/coding';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AampDispatchEnvelope, AampTaskRecord } from '../src/aamp_types.js';

const { runKodaXMock } = vi.hoisted(() => ({
  runKodaXMock: vi.fn(),
}));

const { initializeSkillRegistryMock, getSkillRegistryMock } = vi.hoisted(() => ({
  initializeSkillRegistryMock: vi.fn(),
  getSkillRegistryMock: vi.fn(),
}));

vi.mock('@kodax/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/coding')>();
  return {
    ...actual,
    runKodaX: runKodaXMock,
  };
});

vi.mock('@kodax/skills', () => ({
  initializeSkillRegistry: initializeSkillRegistryMock,
  getSkillRegistry: getSkillRegistryMock,
}));

import { KodaXAampRuntime } from '../src/aamp_runtime.js';

type RunKodaXMockOptions = KodaXOptions & { events?: KodaXEvents };

function createMockResult(overrides: Partial<KodaXResult> = {}): KodaXResult {
  return {
    success: true,
    lastText: 'Final summary',
    messages: [],
    sessionId: 'session-1',
    interrupted: false,
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('KodaXAampRuntime terminal output', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    writes = [];
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text: string | Uint8Array) => {
      writes.push(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
      return true;
    });
    getSkillRegistryMock.mockReturnValue({
      getSystemPromptSnippet: () => 'skill snippet',
    });
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it('renders agent transcript separately from AAMP lifecycle lines', async () => {
    runKodaXMock.mockImplementation(async (options: RunKodaXMockOptions) => {
      options.events?.onTextDelta?.('First line\nSecond line');
      options.events?.onToolUseStart?.({ id: 'tool-1', name: 'read', input: { path: 'README.md' } });
      options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'done' });
      options.events?.onThinkingDelta?.('Planning next step');
      options.events?.onComplete?.();
      return createMockResult();
    });

    const runtime = new KodaXAampRuntime({
      provider: 'openai',
      repoRoot: '/tmp/repo',
      sessionStorage: {
        saveSession: async () => undefined,
        loadSession: async () => null,
        deleteSession: async () => false,
        listSessions: async () => [],
      },
    });

    const dispatch: AampDispatchEnvelope = {
      taskId: 'task-123',
      from: 'agent@example.com',
      bodyText: 'Inspect the repo',
      messageId: 'msg-123',
    };

    const record: AampTaskRecord = {
      aampTaskId: 'task-123',
      sessionId: 'session-123',
      status: 'running',
      senderEmail: 'agent@example.com',
      inboundMessageId: 'msg-123',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
    };

    await runtime.execute(dispatch, record);

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('[aamp/task] task=task-123 from=agent@example.com');
    expect(output).toContain('  | First line');
    expect(output).toContain('  | Second line');
    expect(output).toContain('[agent/tool:read] {"path":"README.md"}');
    expect(output).toContain('[agent/tool:read] done');
    expect(output).toContain('[agent/thinking] Planning next step');
    expect(output).toContain('[aamp/task] task=task-123 completed');
  });

  it('logs tool lifecycle events and permission blocks', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    runKodaXMock.mockImplementation(async (options: RunKodaXMockOptions) => {
      options.events?.onToolUseStart?.({ id: 'tool-1', name: 'read_file', input: { path: 'README.md' } });
      options.events?.onToolResult?.({ id: 'tool-1', name: 'read_file', content: 'done' });
      await options.events?.beforeToolExecute?.('bash', { command: 'rm -rf dist' }, { toolId: 'tool-2' });
      options.events?.onError?.(new Error('simulated tool failure'));
      return createMockResult();
    });

    const runtime = new KodaXAampRuntime({
      provider: 'openai',
      repoRoot: '/tmp/repo',
      sessionStorage: {
        saveSession: async () => undefined,
        loadSession: async () => null,
        deleteSession: async () => false,
        listSessions: async () => [],
      },
      logger,
    });

    const dispatch: AampDispatchEnvelope = {
      taskId: 'task-123',
      from: 'agent@example.com',
      bodyText: 'Inspect the repo',
      messageId: 'msg-123',
    };

    const record: AampTaskRecord = {
      aampTaskId: 'task-123',
      sessionId: 'session-123',
      status: 'running',
      senderEmail: 'agent@example.com',
      inboundMessageId: 'msg-123',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
    };

    await runtime.execute(dispatch, record);

    expect(logger.info).toHaveBeenCalledWith('tool.execution_started', 'tool execution started', expect.objectContaining({
      taskId: 'task-123',
      sessionId: 'session-123',
      toolId: 'tool-1',
      toolName: 'read_file',
      path: 'README.md',
    }));
    expect(logger.info).toHaveBeenCalledWith('tool.execution_finished', 'tool execution finished', expect.objectContaining({
      taskId: 'task-123',
      sessionId: 'session-123',
      toolId: 'tool-1',
      toolName: 'read_file',
      isError: false,
    }));
    expect(logger.error).toHaveBeenCalledWith('tool.execution_blocked', 'tool execution blocked by permissions', expect.objectContaining({
      taskId: 'task-123',
      sessionId: 'session-123',
      toolId: 'tool-2',
      toolName: 'bash',
      command: 'rm -rf dist',
    }));
    expect(logger.error).toHaveBeenCalledWith('tool.execution_failed', 'tool execution failed', expect.objectContaining({
      taskId: 'task-123',
      sessionId: 'session-123',
      error: 'simulated tool failure',
    }));
  });

});
