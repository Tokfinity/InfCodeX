import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient, AcpTransportClosedError } from './acp-client.js';
import { createPseudoAcpServer } from './pseudo-acp-server.js';
import { CLIExecutor } from './executor.js';
import type { CLIEvent, CLIExecutionOptions } from './types.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for ACP session updates');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class TestExecutor extends CLIExecutor {
  constructor(
    private readonly eventsFactory: (options: {
      prompt: string;
      sessionId?: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<CLIEvent>,
  ) {
    super({ command: 'test-cli', baseArgs: [] });
  }

  protected async checkInstalled(): Promise<boolean> {
    return true;
  }

  protected buildArgs(_options: CLIExecutionOptions): string[] {
    return [];
  }

  protected parseLine(_line: string): CLIEvent | null {
    return null;
  }

  override execute(options: {
    prompt: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<CLIEvent> {
    return this.eventsFactory(options);
  }
}

describe('AcpClient', () => {
  afterEach(() => {
    // Each test creates and disconnects its own pseudo server.
  });

  it('creates a session and forwards pseudo ACP session updates to the caller', async () => {
    const updates: any[] = [];
    const executor = new TestExecutor(async function* (options) {
      expect(options.prompt).toBe('hello from client');
      expect(options.sessionId).toBeUndefined();
      yield {
        type: 'session_start',
        timestamp: Date.now(),
        sessionId: 'native-cli-session',
        model: 'test-model',
        raw: null,
      };
      yield {
        type: 'message',
        timestamp: Date.now(),
        role: 'assistant',
        content: 'hello from server',
        raw: null,
      };
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'success',
        raw: null,
      };
    });

    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      onSessionUpdate: (update) => updates.push(update),
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();
      expect(sessionId).toBeTruthy();
      await client.prompt('hello from client', sessionId);
      await waitFor(() => updates.length > 0);

      expect(updates).toContainEqual({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello from server' },
        },
      });
    } finally {
      client.disconnect();
    }
  });

  it('rejects a backing CLI failure instead of returning a normal end turn', async () => {
    const executor = new TestExecutor(async function* () {
      throw new Error('native CLI exited with code 2');
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();

      await expect(client.prompt('failing prompt', sessionId)).rejects.toThrow(
        /native CLI exited with code 2/i,
      );
    } finally {
      client.disconnect();
    }
  });

  it('rejects normalized CLI error events even when the process exits normally', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'error',
        timestamp: Date.now(),
        errorType: 'provider_error',
        message: 'upstream rejected the request',
        raw: null,
      };
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();

      await expect(client.prompt('failing prompt', sessionId)).rejects.toThrow(
        /upstream rejected the request/i,
      );
    } finally {
      client.disconnect();
    }
  });

  it('rejects a failed CLI completion instead of returning normal end turn', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'failed',
        raw: null,
      };
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();

      await expect(client.prompt('failed completion', sessionId)).rejects.toThrow(
        /reported a failed completion/i,
      );
    } finally {
      client.disconnect();
    }
  });

  it('keeps draining the CLI after completion and rejects a trailing process failure', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'success',
        raw: null,
      };
      throw new Error('native CLI exited with code 7 after completion');
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();

      await expect(client.prompt('trailing failure', sessionId)).rejects.toThrow(
        /native CLI exited with code 7 after completion/i,
      );
    } finally {
      client.disconnect();
    }
  });

  it('rejects a zero-exit CLI stream that never emits a completion event', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'message',
        timestamp: Date.now(),
        role: 'assistant',
        content: 'partial output without a terminal event',
        raw: null,
      };
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    try {
      await client.connect();
      const sessionId = await client.createNewSession();
      await expect(client.prompt('missing completion', sessionId)).rejects.toThrow(
        /without a completion event/i,
      );
    } finally {
      client.disconnect();
    }
  });

  it('rejects promptly when the underlying transport closes mid-session', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'success',
        raw: null,
      };
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });

    await client.connect();
    const sessionId = await client.createNewSession();
    server.abort();
    await waitFor(() => !client.isConnectionOpen());
    await expect(client.prompt('closed transport', sessionId)).rejects.toBeInstanceOf(
      AcpTransportClosedError,
    );
    client.disconnect();
  });

  it('rejects a prompt whose signal was already aborted before dispatch', async () => {
    const executor = new TestExecutor(async function* () {
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'success',
        raw: null,
      };
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });
    const controller = new AbortController();
    controller.abort();

    try {
      await client.connect();
      const sessionId = await client.createNewSession();

      await expect(client.prompt('cancelled prompt', sessionId, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      client.disconnect();
    }
  });

  it('rejects an in-flight prompt even when the ACP server ignores cancellation', async () => {
    const executor = new TestExecutor(async function* () {
      await new Promise<void>(() => {
        // Deliberately ignore the prompt AbortSignal.
      });
    });
    const server = createPseudoAcpServer(executor);
    const client = new AcpClient({
      inputStream: server.inputStream,
      outputStream: server.outputStream,
      abort: server.abort,
    });
    const controller = new AbortController();
    const timeoutError = new Error('API Hard Timeout after 120000ms');

    try {
      await client.connect();
      const sessionId = await client.createNewSession();
      const pending = client.prompt('hung prompt', sessionId, controller.signal);
      const rejection = expect(pending).rejects.toBe(timeoutError);
      controller.abort(timeoutError);

      await rejection;
    } finally {
      client.disconnect();
    }
  }, 1_000);
});
