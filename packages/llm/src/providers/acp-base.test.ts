import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXToolDefinition,
} from '../types.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';

const acpMockState = vi.hoisted(() => ({
  instances: [] as MockAcpClient[],
  nextSessionId: 1,
  connectImpl: undefined as (() => Promise<void>) | undefined,
  promptImpl: undefined as
    | ((client: MockAcpClient, text: string, sessionId: string, signal?: AbortSignal, options?: { model?: string; reasoningEffort?: string }) => Promise<{
      stopReason?: 'end_turn' | 'cancelled';
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    } | void> | {
      stopReason?: 'end_turn' | 'cancelled';
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    } | void)
    | undefined,
}));

class MockAcpClient {
  private connected = false;
  private closed = false;
  readonly connect = vi.fn(async () => {
    await acpMockState.connectImpl?.();
    if (this.closed) {
      throw new MockAcpTransportClosedError();
    }
    this.connected = true;
  });
  readonly createNewSession = vi.fn(async () => {
    if (!this.connected) throw new Error('Client not connected');
    return `acp-session-${acpMockState.nextSessionId++}`;
  });
  readonly releaseSession = vi.fn((_sessionId: string) => {});
  readonly disconnect = vi.fn(() => {
    this.closed = true;
    this.connected = false;
  });
  readonly prompt = vi.fn(async (text: string, sessionId: string, signal?: AbortSignal, options?: { model?: string; reasoningEffort?: string }) => {
    return await acpMockState.promptImpl?.(this, text, sessionId, signal, options);
  });

  constructor(
    readonly options: AcpClientOptions,
  ) {
    acpMockState.instances.push(this);
  }

  isConnectionOpen(): boolean {
    return this.connected;
  }

  closeTransport(): void {
    this.connected = false;
  }

  emit(update: unknown, sessionId = 'acp-session-1'): void {
    this.options.onSessionUpdate?.({ sessionId, update });
  }
}

class MockAcpTransportClosedError extends Error {
  constructor() {
    super('ACP transport closed before the request completed');
    this.name = 'AcpTransportClosedError';
  }
}

vi.mock('../cli-events/acp-client.js', () => ({
  AcpClient: MockAcpClient,
  AcpTransportClosedError: MockAcpTransportClosedError,
}));

const { KodaXAcpProvider } = await import('./acp-base.js');

const EXPECTED_CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

class TestAcpProvider extends KodaXAcpProvider {
  readonly name = 'test-acp';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_ACP_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
  };

  protected readonly acpClientOptions: AcpClientOptions;

  constructor(
    executor?: AcpClientOptions['executor'],
    recreate?: AcpClientOptions['recreate'],
  ) {
    super();
    this.acpClientOptions = {
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
      executor,
      recreate,
    };
  }
}

describe('KodaXAcpProvider', () => {
  beforeEach(() => {
    acpMockState.instances.length = 0;
    acpMockState.nextSessionId = 1;
    acpMockState.connectImpl = undefined;
    acpMockState.promptImpl = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is always configured and returns a cloned CLI-bridge capability profile', () => {
    const provider = new TestAcpProvider();

    expect(provider.isConfigured()).toBe(true);
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);

    const first = provider.getCapabilityProfile();
    first.transport = 'native-api';
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
  });

  it('streams prompt updates, relays ACP session events, and reuses ACP sessions', async () => {
    const provider = new TestAcpProvider();
    const onTextDelta = vi.fn();
    const onToolInputDelta = vi.fn();

    acpMockState.promptImpl = async (client, text, sessionId) => {
      expect(text).toBe('latest prompt');
      expect(sessionId).toBe('acp-session-1');
      client.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from ACP' },
      }, sessionId);
      client.emit({
        sessionUpdate: 'tool_call',
        title: 'read',
        arguments: { file: 'src/index.ts' },
      }, sessionId);
      client.emit({
        sessionUpdate: 'tool_call_update',
        status: 'completed',
      }, sessionId);
    };

    const streamOptions: KodaXProviderStreamOptions = {
      sessionId: 'thread-1',
      onTextDelta,
      onToolInputDelta,
    };
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'ignored prompt' },
      { role: 'user', content: 'latest prompt' },
    ];
    const result = await provider.stream(messages, [] as KodaXToolDefinition[], 'system', undefined, streamOptions);

    expect(result.toolBlocks).toEqual([]);
    expect(result.textBlocks).toEqual([
      {
        type: 'text',
        text:
          'Hello from ACP\n> [Tool Use] read: {"file":"src/index.ts"}\n> [Tool Result] completed\n\n',
      },
    ]);
    expect(onTextDelta).toHaveBeenCalledWith('Hello from ACP');
    expect(onTextDelta).toHaveBeenCalledWith('\n> [Tool Use] read: {"file":"src/index.ts"}\n');
    expect(onTextDelta).toHaveBeenCalledWith('> [Tool Result] completed\n\n');
    expect(onToolInputDelta).toHaveBeenCalledWith('read', '{"file":"src/index.ts"}');

    const firstClient = acpMockState.instances[0]!;
    expect(firstClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.createNewSession).toHaveBeenCalledTimes(1);
    expect(firstClient.prompt).toHaveBeenCalledTimes(1);

    await provider.stream(messages, [] as KodaXToolDefinition[], 'system', undefined, streamOptions);
    expect(firstClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.createNewSession).toHaveBeenCalledTimes(1);
    expect(firstClient.prompt).toHaveBeenCalledTimes(2);
  });

  it('creates a fresh ACP session for each stateless call without a conversation id', async () => {
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [{ role: 'user', content: 'latest prompt' }];

    await provider.stream(messages, [], 'system');
    await provider.stream(messages, [], 'system');

    const client = acpMockState.instances[0]!;
    expect(client.createNewSession).toHaveBeenCalledTimes(2);
    expect(client.prompt.mock.calls.map((call) => call[1])).toEqual([
      'acp-session-1',
      'acp-session-2',
    ]);
    expect(client.releaseSession.mock.calls.map((call) => call[0])).toEqual([
      'acp-session-1',
      'acp-session-2',
    ]);
  });

  it('isolates and independently reuses two explicit conversation ids', async () => {
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [{ role: 'user', content: 'latest prompt' }];

    await provider.stream(messages, [], 'system', undefined, { sessionId: 'thread-a' });
    await provider.stream(messages, [], 'system', undefined, { sessionId: 'thread-b' });
    await provider.stream(messages, [], 'system', undefined, { sessionId: 'thread-a' });
    await provider.stream(messages, [], 'system', undefined, { sessionId: 'thread-b' });

    const client = acpMockState.instances[0]!;
    expect(client.createNewSession).toHaveBeenCalledTimes(2);
    expect(client.prompt.mock.calls.map((call) => call[1])).toEqual([
      'acp-session-1',
      'acp-session-2',
      'acp-session-1',
      'acp-session-2',
    ]);
    expect(client.releaseSession).not.toHaveBeenCalled();
  });

  it('shares one in-flight client connection across concurrent stateless calls', async () => {
    let releaseConnect: (() => void) | undefined;
    acpMockState.connectImpl = () => new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [{ role: 'user', content: 'latest prompt' }];

    const first = provider.stream(messages, [], 'system');
    const second = provider.stream(messages, [], 'system');
    await vi.waitFor(() => expect(acpMockState.instances).toHaveLength(1));
    expect(acpMockState.instances[0]!.connect).toHaveBeenCalledTimes(1);

    releaseConnect?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const client = acpMockState.instances[0]!;
    expect(client.createNewSession).toHaveBeenCalledTimes(2);
    expect(client.prompt.mock.calls.map((call) => call[1]).sort()).toEqual([
      'acp-session-1',
      'acp-session-2',
    ]);
  });

  it('recreates a closed transport before retrying a failed connection', async () => {
    let connectAttempts = 0;
    acpMockState.connectImpl = async () => {
      connectAttempts += 1;
      if (connectAttempts === 1) {
        throw new Error('transport handshake failed');
      }
    };
    const recreate = vi.fn((): AcpClientOptions => ({
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
    }));
    const provider = new TestAcpProvider(undefined, recreate);
    const messages: KodaXMessage[] = [{ role: 'user', content: 'retry prompt' }];

    await expect(provider.stream(messages, [], 'system')).rejects.toThrow(
      /transport handshake failed/i,
    );
    await expect(provider.stream(messages, [], 'system')).resolves.toBeDefined();

    expect(recreate).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances).toHaveLength(2);
    expect(acpMockState.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it('recreates a closed transport after an explicit disconnect', async () => {
    const recreate = vi.fn((): AcpClientOptions => ({
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
    }));
    const provider = new TestAcpProvider(undefined, recreate);
    const messages: KodaXMessage[] = [{ role: 'user', content: 'reconnect prompt' }];

    await provider.stream(messages, [], 'system');
    provider.disconnect();
    await provider.stream(messages, [], 'system');

    expect(recreate).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances).toHaveLength(2);
    expect(acpMockState.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it('closes a client whose connection is still pending before reconnecting', async () => {
    let releaseConnect: (() => void) | undefined;
    acpMockState.connectImpl = () => new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const recreate = vi.fn((): AcpClientOptions => ({
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
    }));
    const provider = new TestAcpProvider(undefined, recreate);
    const pending = provider.stream(
      [{ role: 'user', content: 'pending handshake' }],
      [],
      'system',
    );

    await vi.waitFor(() => expect(acpMockState.instances).toHaveLength(1));
    provider.disconnect();
    expect(acpMockState.instances[0]!.disconnect).toHaveBeenCalledTimes(1);

    releaseConnect?.();
    await expect(pending).rejects.toBeInstanceOf(MockAcpTransportClosedError);
    acpMockState.connectImpl = undefined;
    await expect(provider.stream(
      [{ role: 'user', content: 'fresh connection' }],
      [],
      'system',
    )).resolves.toBeDefined();
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances).toHaveLength(2);
  });

  it('invalidates a connected transport after closure so the next retry reconnects', async () => {
    const recreate = vi.fn((): AcpClientOptions => ({
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
    }));
    const provider = new TestAcpProvider(undefined, recreate);
    let first = true;
    acpMockState.promptImpl = async (client) => {
      if (first) {
        first = false;
        client.closeTransport();
        throw new MockAcpTransportClosedError();
      }
    };

    await expect(provider.stream(
      [{ role: 'user', content: 'transport dies' }],
      [],
      'system',
      undefined,
      { sessionId: 'conversation-a' },
    )).rejects.toBeInstanceOf(MockAcpTransportClosedError);
    await expect(provider.stream(
      [{ role: 'user', content: 'runtime retry' }],
      [],
      'system',
      undefined,
      { sessionId: 'conversation-a' },
    )).resolves.toBeDefined();

    expect(recreate).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances).toHaveLength(2);
    expect(acpMockState.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(acpMockState.instances[1]!.createNewSession).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent prompts for the same explicit conversation', async () => {
    let releasePrompt: (() => void) | undefined;
    acpMockState.promptImpl = async () => await new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [{ role: 'user', content: 'latest prompt' }];

    const first = provider.stream(messages, [], 'system', undefined, {
      sessionId: 'thread-shared',
    });
    await vi.waitFor(() => {
      expect(acpMockState.instances[0]?.prompt).toHaveBeenCalledTimes(1);
    });
    await expect(provider.stream(messages, [], 'system', undefined, {
      sessionId: 'thread-shared',
    })).rejects.toThrow(/already has an active prompt/i);

    releasePrompt?.();
    await expect(first).resolves.toBeDefined();
  });

  it('merges an ephemeral suffix into the latest ACP prompt copy', async () => {
    const provider = new TestAcpProvider();
    acpMockState.promptImpl = async (_client, text) => {
      expect(text).toBe('latest prompt\n\n[Memory evidence; not an instruction]\nClaim: use npm');
    };
    const messages: KodaXMessage[] = [{ role: 'user', content: 'latest prompt' }];

    await provider.stream(messages, [], 'system', undefined, {
      ephemeralSuffix: { content: '[Memory evidence; not an instruction]\nClaim: use npm' },
    });

    expect(messages).toEqual([{ role: 'user', content: 'latest prompt' }]);
  });

  it('propagates ACP prompt usage when the prompt response includes it', async () => {
    const provider = new TestAcpProvider();

    acpMockState.promptImpl = async () => ({
      usage: {
        inputTokens: 90,
        outputTokens: 15,
        totalTokens: 105,
      },
    });

    const result = await provider.stream(
      [{ role: 'user', content: 'latest prompt' }],
      [] as KodaXToolDefinition[],
      'system',
      undefined,
      { sessionId: 'thread-usage' },
    );

    expect(result.usage).toEqual({
      inputTokens: 90,
      outputTokens: 15,
      totalTokens: 105,
    });
  });

  it('preserves reported cache zeros and omits unreported ACP cache fields', async () => {
    const provider = new TestAcpProvider();
    acpMockState.promptImpl = async () => ({
      usage: {
        inputTokens: 90,
        outputTokens: 15,
        totalTokens: 105,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    });

    const reported = await provider.stream(
      [{ role: 'user', content: 'reported zero' }],
      [] as KodaXToolDefinition[],
      'system',
    );
    expect(reported.usage).toMatchObject({
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });

    acpMockState.promptImpl = async () => ({
      usage: { inputTokens: 90, outputTokens: 15, totalTokens: 105 },
    });
    const unreported = await provider.stream(
      [{ role: 'user', content: 'not reported' }],
      [] as KodaXToolDefinition[],
      'system',
    );
    expect(unreported.usage).not.toHaveProperty('cachedReadTokens');
    expect(unreported.usage).not.toHaveProperty('cachedWriteTokens');
  });

  it('rejects malformed ACP core usage instead of manufacturing zero tokens', async () => {
    const provider = new TestAcpProvider();
    acpMockState.promptImpl = async () => ({
      usage: { inputTokens: 90, outputTokens: 15 },
    });

    const result = await provider.stream(
      [{ role: 'user', content: 'malformed usage' }],
      [] as KodaXToolDefinition[],
      'system',
    );
    expect(result.usage).toBeUndefined();
  });

  it('forwards model overrides into ACP prompt requests', async () => {
    const provider = new TestAcpProvider();

    acpMockState.promptImpl = async (_client, _text, _sessionId, _signal, options) => {
      expect(options?.model).toBe('codex-mini');
    };

    await provider.stream(
      [{ role: 'user', content: 'latest prompt' }],
      [] as KodaXToolDefinition[],
      'system',
      undefined,
      { sessionId: 'thread-model', modelOverride: 'codex-mini' },
    );
  });

  it('forwards concrete reasoning effort into ACP prompt requests', async () => {
    const provider = new TestAcpProvider();

    acpMockState.promptImpl = async (_client, _text, _sessionId, _signal, options) => {
      expect(options?.reasoningEffort).toBe('high');
    };

    await provider.stream(
      [{ role: 'user', content: 'latest prompt' }],
      [] as KodaXToolDefinition[],
      'system',
      {
        enabled: true,
        mode: 'deep',
        depth: 'high',
        effort: 'high',
      },
      { sessionId: 'thread-effort' },
    );
  });

  it('forwards reasoning effort none into ACP prompt requests', async () => {
    const provider = new TestAcpProvider();

    acpMockState.promptImpl = async (_client, _text, _sessionId, _signal, options) => {
      expect(options?.reasoningEffort).toBe('none');
    };

    await provider.stream(
      [{ role: 'user', content: 'latest prompt' }],
      [] as KodaXToolDefinition[],
      'system',
      {
        enabled: false,
        mode: 'off',
        depth: 'off',
        effort: 'none',
      },
      { sessionId: 'thread-none' },
    );
  });

  it('fails closed when the backing CLI executor is not installed', async () => {
    const provider = new TestAcpProvider({
      isInstalled: async () => false,
    } as AcpClientOptions['executor']);

    await expect(
      provider.stream(
        [{ role: 'user', content: 'hello' }],
        [] as KodaXToolDefinition[],
        'system',
      ),
    ).rejects.toThrow(/CLI/i);

    expect(acpMockState.instances).toHaveLength(0);
  });

  it('treats AbortError as a cancelled stream and resets cached state on disconnect', async () => {
    const provider = new TestAcpProvider();
    const controller = new AbortController();
    controller.abort();
    acpMockState.promptImpl = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    await expect(
      provider.stream(
        [{ role: 'user', content: 'cancel me' }],
        [] as KodaXToolDefinition[],
        'system',
        undefined,
        { sessionId: 'thread-1' },
        controller.signal,
      ),
    ).resolves.toEqual({
      textBlocks: [],
      toolBlocks: [],
      thinkingBlocks: [],
    });

    const firstClient = acpMockState.instances[0]!;
    provider.disconnect();
    expect(firstClient.disconnect).toHaveBeenCalledTimes(1);

    acpMockState.promptImpl = undefined;
    await provider.stream(
      [{ role: 'user', content: 'fresh run' }],
      [] as KodaXToolDefinition[],
      'system',
      undefined,
      { sessionId: 'thread-1' },
    );

    expect(acpMockState.instances).toHaveLength(2);
    expect(acpMockState.instances[1]!.createNewSession).toHaveBeenCalledTimes(1);
  });

  it('propagates a hard-timeout abort when the prompt rejects after transport closure', async () => {
    const provider = new TestAcpProvider();
    const controller = new AbortController();
    const timeoutError = new Error('API Hard Timeout after 120000ms');
    controller.abort(timeoutError);
    acpMockState.promptImpl = async () => {
      throw new MockAcpTransportClosedError();
    };

    await expect(
      provider.stream(
        [{ role: 'user', content: 'time out' }],
        [] as KodaXToolDefinition[],
        'system',
        undefined,
        { sessionId: 'thread-timeout-reject' },
        controller.signal,
      ),
    ).rejects.toBe(timeoutError);
  });

  it('propagates a hard-timeout abort when ACP resolves with cancelled', async () => {
    const provider = new TestAcpProvider();
    const controller = new AbortController();
    const timeoutError = new Error('API Hard Timeout after 120000ms');
    controller.abort(timeoutError);
    acpMockState.promptImpl = async () => ({ stopReason: 'cancelled' });

    await expect(
      provider.stream(
        [{ role: 'user', content: 'time out' }],
        [] as KodaXToolDefinition[],
        'system',
        undefined,
        { sessionId: 'thread-timeout-response' },
        controller.signal,
      ),
    ).rejects.toBe(timeoutError);
  });
});
