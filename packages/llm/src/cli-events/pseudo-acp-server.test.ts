import { afterEach, describe, expect, it } from 'vitest';
import { createPseudoAcpServer } from './pseudo-acp-server.js';
import { CLIExecutor } from './executor.js';
import type { CLIEvent, CLIExecutionOptions } from './types.js';

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

async function writeJson(writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value)}\n`;
  await writer.write(new TextEncoder().encode(payload));
}

async function readJsonLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
): Promise<Record<string, any>> {
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error('Stream ended before a JSON line was received');
    }
    buffer += decoder.decode(value, { stream: true });
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      return JSON.parse(line);
    }
  }
}

describe('createPseudoAcpServer', () => {
  afterEach(() => {
    // no-op, individual tests abort their own streams
  });

  it('emits tool-call arguments, streams updates, and only responds after the prompt turn completes', async () => {
    const executor = new TestExecutor(async function* (options) {
      expect(options.prompt).toBe('run the tool');
      yield {
        type: 'tool_use',
        timestamp: Date.now(),
        toolId: 'tool-1',
        toolName: 'read',
        parameters: { file: 'src/index.ts' },
        raw: null,
      };
      yield {
        type: 'tool_result',
        timestamp: Date.now(),
        toolId: 'tool-1',
        status: 'success',
        output: 'done',
        raw: null,
      };
      yield {
        type: 'complete',
        timestamp: Date.now(),
        status: 'success',
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
        raw: null,
      };
    });

    const server = createPseudoAcpServer(executor);
    const writer = server.outputStream.getWriter();
    const reader = server.inputStream.getReader();
    const decoder = new TextDecoder();

    try {
      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2026-01-01' },
      });
      await readJsonLine(reader, decoder);

      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {},
      });
      const session = await readJsonLine(reader, decoder);
      const sessionId = session.result.sessionId;

      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'run the tool' }],
        },
      });

      const toolUse = await readJsonLine(reader, decoder);
      expect(toolUse.method).toBe('session/update');
      expect(toolUse.params.update).toEqual({
        sessionUpdate: 'tool_call',
        title: 'read',
        arguments: { file: 'src/index.ts' },
        status: 'running',
        toolCallId: 'tool-1',
      });

      const toolResult = await readJsonLine(reader, decoder);
      expect(toolResult.method).toBe('session/update');
      expect(toolResult.params.update).toEqual({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'success',
      });

      const response = await readJsonLine(reader, decoder);
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
          },
        },
      });
    } finally {
      server.abort();
      reader.releaseLock();
      writer.releaseLock();
    }
  });

  it('returns a cancelled stop reason when the prompt is aborted', async () => {
    const executor = new TestExecutor(async function* ({ signal }) {
      while (!signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const server = createPseudoAcpServer(executor);
    const writer = server.outputStream.getWriter();
    const reader = server.inputStream.getReader();
    const decoder = new TextDecoder();

    try {
      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2026-01-01' },
      });
      await readJsonLine(reader, decoder);

      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {},
      });
      const session = await readJsonLine(reader, decoder);
      const sessionId = session.result.sessionId;

      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'cancel me' }],
        },
      });

      await writeJson(writer, {
        jsonrpc: '2.0',
        id: 4,
        method: 'session/cancel',
        params: { sessionId },
      });

      const cancelResponse = await readJsonLine(reader, decoder);
      expect(cancelResponse).toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: {},
      });

      const promptResponse = await readJsonLine(reader, decoder);
      expect(promptResponse).toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: { stopReason: 'cancelled' },
      });
    } finally {
      server.abort();
      reader.releaseLock();
      writer.releaseLock();
    }
  });
});
