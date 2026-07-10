import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InteractiveSurface = 'ink' | 'classic';

interface RuntimeConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly sessionRetentionDays?: number;
  readonly extensions?: readonly string[];
  readonly mcpServers?: Record<string, { readonly connect?: string }>;
}

interface InteractiveMainHarness {
  readonly calls: string[];
  readonly runInkInteractiveMode: ReturnType<typeof vi.fn>;
  readonly runInteractiveMode: ReturnType<typeof vi.fn>;
  readonly shutdownDefaultLspService: ReturnType<typeof vi.fn>;
  readonly cleanupRegisteredManagedChildren: ReturnType<typeof vi.fn>;
  readonly shutdownTracing: ReturnType<typeof vi.fn>;
  readonly runtimeDispose: ReturnType<typeof vi.fn>;
  readonly createKodaXRuntime: ReturnType<typeof vi.fn>;
  readonly runtimeOptions: unknown[];
}

const originalArgv = process.argv;
const originalVitest = process.env.VITEST;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  process.argv = ['node', 'kodax'];
  process.env.VITEST = 'false';
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@kodax-ai/agent');
  vi.doUnmock('@kodax-ai/coding');
  vi.doUnmock('@kodax-ai/repl');
  vi.doUnmock('./sdk-runtime.js');
  process.argv = originalArgv;
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  process.exitCode = originalExitCode;
});

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function importMainWithMocks(options: {
  readonly surface?: InteractiveSurface;
  readonly config?: RuntimeConfig;
  readonly lspShutdown?: () => Promise<void>;
  readonly mockSdkRuntime?: boolean;
} = {}): Promise<{
  readonly main: () => Promise<void>;
  readonly harness: InteractiveMainHarness;
}> {
  const calls: string[] = [];
  const runtimeOptions: unknown[] = [];
  const surface = options.surface ?? 'ink';
  const config = options.config ?? {
    provider: 'mock-provider',
    mcpServers: {
      mock: { connect: 'lazy' },
    },
  };

  const runInkInteractiveMode = vi.fn(async () => {
    calls.push('run-ink');
  });
  const runInteractiveMode = vi.fn(async () => {
    calls.push('run-classic');
  });
  const shutdownDefaultLspService = vi.fn(async () => {
    calls.push('shutdown-lsp');
    await options.lspShutdown?.();
  });
  const cleanupRegisteredManagedChildren = vi.fn(async (cleanupOptions?: { includeCurrentOwner?: boolean }) => {
    calls.push(cleanupOptions?.includeCurrentOwner ? 'cleanup-children-final' : 'cleanup-children-startup');
    return { killed: 0, pruned: 0, skipped: 0 };
  });
  const shutdownTracing = vi.fn(async () => {
    calls.push('shutdown-tracing');
  });
  const runtimeDispose = vi.fn(async () => {
    calls.push('runtime-dispose');
  });
  const createKodaXRuntime = vi.fn(async (runtimeOptionsInput: unknown) => {
    runtimeOptions.push(runtimeOptionsInput);
    const runtimeOptionsRecord = runtimeOptionsInput !== null && typeof runtimeOptionsInput === 'object'
      ? runtimeOptionsInput as Record<string, unknown>
      : {};
    const runtimeMode = runtimeOptionsRecord.mode === 'daemon' ? 'daemon' : 'embedded';
    const runtimeProfile = typeof runtimeOptionsRecord.profile === 'string'
      ? runtimeOptionsRecord.profile
      : 'default';
    return {
      identity: {
        runtimeId: 'rt_mock_interactive',
        mode: runtimeMode,
        profile: runtimeProfile,
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66-test',
      },
      sessions: {
        async load() {
          return { id: 'session-1', title: 'Loaded' };
        },
        async create() {
          return { id: 'session-1', title: 'Created' };
        },
      },
      runs: {
        async start() {
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed',
              result: { success: true, lastText: 'ok', messages: [] },
            }),
          };
        },
        async await() {
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            phase: 'completed',
            result: { success: true, lastText: 'ok', messages: [] },
          };
        },
      },
      status: {
        async snapshot() {
          return {
            runtimeId: 'rt_mock_interactive',
            mode: runtimeMode,
            profile: runtimeProfile,
            startedAt: '2026-07-09T00:00:00.000Z',
            sessions: [],
            runs: [],
            pendingPermissions: [],
            workflows: [],
          };
        },
      },
      async close() {},
    };
  });

  vi.doMock('@kodax-ai/agent', () => ({
    applyProcessHardening: vi.fn(() => {
      calls.push('hardening');
    }),
    cleanupRegisteredManagedChildren,
    shutdownTracing,
  }));

  vi.doMock('@kodax-ai/coding', () => ({
    runKodaX: vi.fn(),
    runManagedTask: vi.fn(),
    KodaXClient: class KodaXClient {},
    KodaXEvents: class KodaXEvents {},
    KodaXAgentMode: {},
    KodaXReasoningMode: {},
    KODAX_REASONING_MODE_SEQUENCE: ['off', 'auto', 'quick', 'balanced', 'deep'],
    normalizeReasoningEffortValue: vi.fn((value: string) => value),
    parseReasoningEffortEnv: vi.fn(() => ({ kind: 'unset' })),
    createExtensionRuntime: vi.fn(() => ({
      activate: vi.fn(() => {
        calls.push('runtime-activate');
      }),
      dispose: runtimeDispose,
      loadExtensions: vi.fn(async () => undefined),
    })),
    dedupeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    discoverDefaultExtensions: vi.fn(async () => []),
    excludeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    registerConfiguredMcpCapabilityProvider: vi.fn(async () => {
      calls.push('register-mcp');
    }),
    buildMcpReverseCapabilities: vi.fn(() => ({})),
    KODAX_DEFAULT_PROVIDER: 'mock-provider',
    checkPromiseSignal: vi.fn(),
    getProvider: vi.fn(),
    getAvailableProviderNames: vi.fn(() => ['mock-provider']),
    KODAX_TOOLS: [],
    KodaXTerminalError: class KodaXTerminalError extends Error {
      readonly suggestions: readonly string[] = [];
    },
    bootstrapTracing: vi.fn(() => {
      calls.push('bootstrap-tracing');
    }),
    shutdownDefaultLspService,
  }));

  vi.doMock('@kodax-ai/repl', () => {
    class MockFileSessionStorage {
      cleanupOldSessions(): Promise<void> {
        calls.push('session-retention');
        return Promise.resolve();
      }
    }

    return {
      getGitRoot: vi.fn(() => undefined),
      createCliEvents: vi.fn(() => ({})),
      createJsonEvents: vi.fn(() => ({})),
      loadConfig: vi.fn(() => ({})),
      prepareRuntimeConfig: vi.fn(() => config),
      FileSessionStorage: MockFileSessionStorage,
      dedupeSessions: vi.fn(),
      KODAX_CONFIG_FILE: 'C:/Users/test/.kodax/config.json',
      ensureExampleConfigFile: vi.fn(() => undefined),
      resolveInteractiveSurfacePreference: vi.fn(() => surface),
      runInteractiveMode,
      runInkInteractiveMode,
    };
  });

  if (options.mockSdkRuntime !== false) {
    vi.doMock('./sdk-runtime.js', () => ({
      createKodaXRuntime,
    }));
  }

  const module = await import('./kodax_cli.js');
  return {
    main: module.main,
    harness: {
      calls,
      runInkInteractiveMode,
      runInteractiveMode,
      shutdownDefaultLspService,
      cleanupRegisteredManagedChildren,
      shutdownTracing,
      runtimeDispose,
      createKodaXRuntime,
      runtimeOptions,
    },
  };
}

describe('CLI interactive exit lifecycle', () => {
  it('keeps Ink cleanup host-owned and exits only after top-level cleanup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      expect(code).toBe(0);
      return undefined as never;
    }) as typeof process.exit);
    const { main, harness } = await importMainWithMocks();

    await main();

    expect(harness.runInkInteractiveMode).toHaveBeenCalledTimes(1);
    expect(harness.runInkInteractiveMode).toHaveBeenCalledWith(expect.objectContaining({
      hardExitOnClose: false,
    }));
    expect(harness.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(harness.shutdownDefaultLspService).toHaveBeenCalledTimes(1);
    expect(harness.cleanupRegisteredManagedChildren).toHaveBeenNthCalledWith(1);
    expect(harness.cleanupRegisteredManagedChildren).toHaveBeenNthCalledWith(2, { includeCurrentOwner: true });
    expect(harness.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(harness.calls).toEqual([
      'hardening',
      'cleanup-children-startup',
      'bootstrap-tracing',
      'session-retention',
      'register-mcp',
      'runtime-activate',
      'run-ink',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]);
  });

  it('does not exit before asynchronous cleanup resolves', async () => {
    const lspDeferred = createDeferred();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({
      lspShutdown: () => lspDeferred.promise,
    });

    const mainPromise = main();
    await vi.waitFor(() => expect(harness.shutdownDefaultLspService).toHaveBeenCalledTimes(1));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(harness.calls).toContain('runtime-dispose');
    expect(harness.calls).not.toContain('cleanup-children-final');

    lspDeferred.resolve();
    await mainPromise;

    expect(harness.calls).toContain('shutdown-tracing');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the same cleanup-before-exit policy for classic interactive mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({ surface: 'classic' });

    await main();

    expect(harness.runInteractiveMode).toHaveBeenCalledTimes(1);
    expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(expect.arrayContaining([
      'run-classic',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('can opt the interactive REPL into daemon runtime mode', async () => {
    const previousRuntimeMode = process.env.KODAX_RUNTIME_MODE;
    process.env.KODAX_RUNTIME_MODE = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    try {
      const { main, harness } = await importMainWithMocks({ mockSdkRuntime: true });

      await main();

      expect(harness.runInkInteractiveMode).toHaveBeenCalledTimes(1);
      expect(harness.createKodaXRuntime).toHaveBeenCalledTimes(1);
      expect(harness.runtimeOptions[0]).toMatchObject({
        mode: 'daemon',
        homeDir: homedir(),
        profile: 'default',
        autoStartDaemon: true,
      });
      const replOptions = harness.runInkInteractiveMode.mock.calls[0]?.[0] as {
        getRuntimeStatus?: () => Promise<unknown>;
      };
      const getRuntimeStatus = replOptions.getRuntimeStatus;
      expect(getRuntimeStatus).toBeTypeOf('function');
      if (!getRuntimeStatus) throw new Error('Expected REPL runtime status callback.');
      await expect(getRuntimeStatus()).resolves.toMatchObject({
        mode: 'daemon',
        profile: 'default',
        runtimeId: 'rt_mock_interactive',
        sessions: 0,
        runs: 0,
      });
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRuntimeMode === undefined) {
        delete process.env.KODAX_RUNTIME_MODE;
      } else {
        process.env.KODAX_RUNTIME_MODE = previousRuntimeMode;
      }
    }
  });

  it('does not fall through to interactive mode after daemon subcommands', async () => {
    process.env.VITEST = 'true';
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-daemon-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = [
        'node',
        'kodax',
        'daemon',
        'status',
        '--home',
        homeDir,
        '--profile',
        'test',
        '--json',
      ];
      const { main, harness } = await importMainWithMocks();

      await main();

      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"health": "missing"'));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
