import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AampDispatchEnvelope, AampTaskAck, AampTaskResult, AampTransport } from '../src/aamp_types.js';

const { runKodaXMock } = vi.hoisted(() => ({
  runKodaXMock: vi.fn(),
}));

const { prepareRuntimeConfigMock } = vi.hoisted(() => ({
  prepareRuntimeConfigMock: vi.fn(),
}));

vi.mock('@kodax/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/coding')>();
  return {
    ...actual,
    runKodaX: runKodaXMock,
  };
});

vi.mock('@kodax/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/repl')>();
  return {
    ...actual,
    prepareRuntimeConfig: prepareRuntimeConfigMock,
  };
});

import { KodaXAampServer } from '../src/aamp_server.js';
import { FileAampTaskStore } from '../src/aamp_store.js';

class MockAampTransport implements AampTransport {
  readonly acks: AampTaskAck[] = [];
  readonly results: AampTaskResult[] = [];
  private handler: ((dispatch: AampDispatchEnvelope) => Promise<void>) | null = null;

  async listen(handler: (dispatch: AampDispatchEnvelope) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async sendAck(ack: AampTaskAck): Promise<void> {
    this.acks.push(ack);
  }

  async sendResult(result: AampTaskResult): Promise<void> {
    this.results.push(result);
  }

  async dispatch(dispatch: AampDispatchEnvelope): Promise<void> {
    if (!this.handler) {
      throw new Error('AAMP handler not registered');
    }
    await this.handler(dispatch);
  }
}

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

describe('KodaXAampServer', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    prepareRuntimeConfigMock.mockReturnValue({
      provider: 'openai',
      thinking: false,
      reasoningMode: 'auto',
      permissionMode: 'accept-edits',
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-aamp-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('acknowledges dispatches and returns task results', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: 'AAMP task completed' }));

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
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
  });

  it('skips duplicate completed task dispatches', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: 'done once' }));

    const transport = new MockAampTransport();
    const server = new KodaXAampServer({
      transport,
      repoRoot: tempDir,
      taskStore: new FileAampTaskStore(path.join(tempDir, 'tasks.json')),
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
  });
});
