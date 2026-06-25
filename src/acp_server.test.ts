import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewSessionRequest, PromptRequest, SetSessionModeRequest } from '@agentclientprotocol/sdk';

const acpServerState = vi.hoisted(() => ({
  capturedOptions: [] as unknown[],
  runKodaX: vi.fn(async (options: unknown) => {
    acpServerState.capturedOptions.push(options);
    return { interrupted: false };
  }),
  prepareRuntimeConfig: vi.fn(() => ({
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
  runKodaX: acpServerState.runKodaX,
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
    acpServerState.runKodaX.mockClear();
    acpServerState.prepareRuntimeConfig.mockClear();
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
    expect(acpServerState.runKodaX).not.toHaveBeenCalled();
    await server.dispose();
  });
});
