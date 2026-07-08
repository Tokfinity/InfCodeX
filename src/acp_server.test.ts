import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewSessionRequest, PromptRequest, SetSessionModeRequest } from '@agentclientprotocol/sdk';

type RuntimeConfigMock = {
  provider: string;
  model?: string;
  thinking?: boolean;
  effort?: string;
  reasoningMode: string;
};

const acpServerState = vi.hoisted(() => ({
  capturedOptions: [] as unknown[],
  sessions: new Map<string, { title: string; messages: unknown[] }>(),
  startKodaX: vi.fn((options: { session?: { id?: string } }) => {
    acpServerState.capturedOptions.push(options);
    const sessionId = options.session?.id ?? 'missing-session';
    return {
      id: sessionId,
      attached: true,
      currentProvider: 'openai',
      currentModel: undefined,
      currentReasoning: undefined,
      aborted: false,
      setProvider: vi.fn(),
      setModel: vi.fn(),
      setReasoning: vi.fn(),
      abort: vi.fn(),
      result: Promise.resolve({
        interrupted: false,
        success: true,
        messages: [],
        sessionId,
      }),
    };
  }),
  prepareRuntimeConfig: vi.fn<() => RuntimeConfigMock>(() => ({
    provider: 'openai',
    reasoningMode: 'auto',
  })),
}));

vi.mock('@kodax-ai/coding', () => ({
  KODAX_DEFAULT_PROVIDER: 'openai',
  buildMcpReverseCapabilities: vi.fn(() => ({})),
  combineExtensionRuntimes: vi.fn((primary: unknown) => primary),
  createBashPrefixExtractor: vi.fn(() => ({})),
  createExtensionRuntime: vi.fn(() => ({
    activate: vi.fn(),
    dispose: vi.fn(async () => undefined),
  })),
  dedupeExtensionPathsByEntrypoint: vi.fn((paths: string[]) => paths),
  discoverDefaultExtensions: vi.fn(async () => []),
  excludeExtensionPathsByEntrypoint: vi.fn((paths: string[]) => paths),
  isToolFileMutation: vi.fn(() => false),
  normalizeReasoningEffortValue: (value: string): string => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      throw new Error('Reasoning effort cannot be empty.');
    }
    return normalized;
  },
  registerConfiguredMcpCapabilityProvider: vi.fn(async () => undefined),
  resolveProvider: vi.fn(() => ({})),
  generateSessionId: vi.fn(async () => 'generated-session'),
  runManagedTask: vi.fn(),
  startKodaX: acpServerState.startKodaX,
  shutdownDefaultLspService: vi.fn(async () => undefined),
}));

vi.mock('@kodax-ai/repl', () => ({
  KODAX_CONFIG_FILE: 'C:/Users/test/.kodax/config.json',
  FileSessionStorage: class FileSessionStorage {},
  collectBashWriteTargets: vi.fn(() => []),
  computeConfirmTools: vi.fn(() => []),
  generateSavePattern: vi.fn(() => ''),
  getBashOutsideProjectWriteRisk: vi.fn(() => ({ risky: false })),
  getPlanModeBlockReason: vi.fn(() => null),
  isAlwaysConfirmPath: vi.fn(() => false),
  isBashReadCommand: vi.fn(() => true),
  isPathInsideProject: vi.fn(() => true),
  isToolCallAllowed: vi.fn(() => ({ allowed: true })),
  prepareRuntimeConfig: acpServerState.prepareRuntimeConfig,
  createSessionManager: vi.fn(() => ({
    storage: {
      save: vi.fn(async (sessionId: string, data: { title?: string; messages?: unknown[] }) => {
        acpServerState.sessions.set(sessionId, {
          title: data.title ?? '',
          messages: data.messages ?? [],
        });
      }),
    },
    loadSession: vi.fn(async (sessionId: string) => acpServerState.sessions.get(sessionId) ?? null),
    listSessions: vi.fn(async () => []),
    loadFullTranscript: vi.fn(async () => ({ transcriptEntries: [] })),
    forkSession: vi.fn(async () => null),
    archiveSession: vi.fn(async () => true),
    unarchiveSession: vi.fn(async () => true),
    deleteSession: vi.fn(async () => ({ ok: true })),
  })),
}));

import { KodaXAcpServer } from './acp_server.js';

type PromptRequestWithEffort = PromptRequest & {
  effort?: string;
};

function makePrompt(sessionId: string, effort?: string): PromptRequestWithEffort {
  return {
    sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
    ...(effort !== undefined ? { effort } : {}),
  } as PromptRequestWithEffort;
}

function lastRunOptions(): Record<string, unknown> {
  const options = acpServerState.capturedOptions.at(-1);
  expect(options).toBeDefined();
  return options as Record<string, unknown>;
}

describe('KodaXAcpServer reasoning effort forwarding', () => {
  beforeEach(() => {
    acpServerState.capturedOptions = [];
    acpServerState.sessions.clear();
    acpServerState.startKodaX.mockClear();
    acpServerState.prepareRuntimeConfig.mockClear();
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      reasoningMode: 'auto',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createSession(server: KodaXAcpServer): Promise<string> {
    const response = await server.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    } as NewSessionRequest);
    return response.sessionId;
  }

  async function switchToPlan(server: KodaXAcpServer, sessionId: string): Promise<void> {
    await server.setSessionMode({
      sessionId,
      modeId: 'plan',
    } as SetSessionModeRequest);
  }

  it('forwards the configured server effort to runKodaX', async () => {
    const server = new KodaXAcpServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('medium');
    await server.dispose();
  });

  it('inherits config model when ACP provider is not overridden', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-configured',
      reasoningMode: 'auto',
    });
    const server = new KodaXAcpServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({
      provider: 'openai',
      model: 'gpt-configured',
    });
    await server.dispose();
  });

  it('does not carry config model across an ACP provider override', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-configured',
      reasoningMode: 'auto',
    });
    const server = new KodaXAcpServer({ provider: 'anthropic', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({ provider: 'anthropic' });
    expect(lastRunOptions().model).toBeUndefined();
    await server.dispose();
  });

  it('normalizes ACP effort none into legacy reasoning off fields', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      thinking: true,
      reasoningMode: 'deep',
      effort: 'none',
    });
    const server = new KodaXAcpServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({
      effort: 'none',
      thinking: false,
      reasoningMode: 'off',
    });
    await server.dispose();
  });

  it('lets a prompt effort override the server default', async () => {
    const server = new KodaXAcpServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId, 'high'));

    expect(lastRunOptions().effort).toBe('high');
    await server.dispose();
  });

  it('uses planModeEffort while the ACP session is in plan mode', async () => {
    const server = new KodaXAcpServer({
      provider: 'openai',
      effort: undefined,
      planModeEffort: 'medium',
      logLevel: 'off',
    });
    const sessionId = await createSession(server);
    await switchToPlan(server, sessionId);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('medium');
    await server.dispose();
  });

  it('keeps explicit server effort ahead of planModeEffort', async () => {
    const server = new KodaXAcpServer({
      provider: 'openai',
      effort: 'high',
      planModeEffort: 'medium',
      logLevel: 'off',
    });
    const sessionId = await createSession(server);
    await switchToPlan(server, sessionId);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('high');
    await server.dispose();
  });

  it('lets prompt effort auto clear the server default for one turn', async () => {
    const server = new KodaXAcpServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId, 'auto'));

    expect(lastRunOptions().effort).toBeUndefined();
    await server.dispose();
  });

  it('rejects invalid prompt effort before calling runKodaX', async () => {
    const server = new KodaXAcpServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await expect(server.prompt(makePrompt(sessionId, '   '))).rejects.toThrow(/Reasoning effort cannot be empty/);
    expect(acpServerState.startKodaX).not.toHaveBeenCalled();
    await server.dispose();
  });
});
