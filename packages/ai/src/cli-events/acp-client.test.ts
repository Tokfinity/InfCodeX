import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient } from './acp-client.js';
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
      expect(options.sessionId).toBeTruthy();
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
});
