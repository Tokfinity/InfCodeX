import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InteractiveSurface = 'ink' | 'classic';

interface RuntimeConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: 'embedded' | 'daemon';
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
  readonly runtimeStarts: unknown[];
  readonly runtimeDeletes: string[];
  readonly runManagedTask: ReturnType<typeof vi.fn>;
}

const originalArgv = process.argv;
const originalVitest = process.env.VITEST;
const originalRuntimeMode = process.env.KODAX_RUNTIME_MODE;
const originalProvider = process.env.KODAX_PROVIDER;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  process.argv = ['node', 'kodax'];
  process.env.VITEST = 'false';
  delete process.env.KODAX_RUNTIME_MODE;
  delete process.env.KODAX_PROVIDER;
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@kodax-ai/agent');
  vi.doUnmock('@kodax-ai/coding');
  vi.doUnmock('@kodax-ai/repl');
  vi.doUnmock('./sdk-runtime.js');
  vi.doUnmock('./a2a/runtime-config.js');
  process.argv = originalArgv;
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  process.exitCode = originalExitCode;
  if (originalRuntimeMode === undefined) delete process.env.KODAX_RUNTIME_MODE;
  else process.env.KODAX_RUNTIME_MODE = originalRuntimeMode;
  if (originalProvider === undefined) delete process.env.KODAX_PROVIDER;
  else process.env.KODAX_PROVIDER = originalProvider;
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
  readonly runtimeClose?: () => Promise<void>;
  readonly mockSdkRuntime?: boolean;
} = {}): Promise<{
  readonly main: () => Promise<void>;
  readonly harness: InteractiveMainHarness;
}> {
  const calls: string[] = [];
  const runtimeOptions: unknown[] = [];
  const runtimeStarts: unknown[] = [];
  const runtimeDeletes: string[] = [];
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
  const runManagedTask = vi.fn(async () => ({
    success: true,
    lastText: 'legacy',
    messages: [],
    sessionId: 'legacy-session',
  }));
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
        async updateSettings() {
          return {};
        },
        async delete(sessionId: string) {
          runtimeDeletes.push(sessionId);
        },
      },
      runs: {
        async start(input: unknown) {
          runtimeStarts.push(input);
          return {
            runId: 'run-1',
            sessionId: 'cli-session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'cli-session-1',
              phase: 'completed',
              result: { success: true, lastText: 'ok', messages: [], sessionId: 'cli-session-1' },
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
      events: {
        subscribe() {
          return { close: vi.fn() };
        },
      },
      permissions: {
        async respond() {
          return true;
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
      async close() {
        calls.push('runtime-close');
        await options.runtimeClose?.();
      },
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
    runManagedTask,
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
      reconcileExtensions: vi.fn(async () => undefined),
    })),
    dedupeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    discoverDefaultExtensions: vi.fn(async () => []),
    excludeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    registerConfiguredMcpCapabilityProvider: vi.fn(async () => {
      calls.push('register-mcp');
    }),
    replaceConfiguredMcpCapabilityProvider: vi.fn(async () => undefined),
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
    generateSessionId: vi.fn(async () => 'cli-session-1'),
  }));

  vi.doMock('@kodax-ai/repl', () => {
    class MockIntegrationConfigController {
      private readonly domain: 'mcp' | 'extensions';

      constructor(options: { readonly domain: 'mcp' | 'extensions' }) {
        this.domain = options.domain;
      }

      initialize(): Promise<{ readonly revision: string; readonly document: object }> {
        return Promise.resolve({
          revision: 'default',
          document: this.domain === 'mcp' ? { version: 1, servers: {} } : { version: 1, paths: [] },
        });
      }

      subscribe(): () => void { return () => undefined; }
      startWatching(): void {}
      close(): void {}
      status(): { readonly domain: string; readonly state: 'watching' } {
        return { domain: this.domain, state: 'watching' };
      }
    }

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
      KODAX_DIR: 'C:/Users/test/.kodax',
      IntegrationConfigController: MockIntegrationConfigController,
      parseMcpIntegrationDocument: vi.fn((value: unknown) => value),
      parseExtensionsIntegrationDocument: vi.fn((value: unknown) => value),
      readMcpIntegration: vi.fn(() => ({ revision: 'default', document: { version: 1, servers: {} } })),
      readExtensionsIntegration: vi.fn(() => ({ revision: 'default', document: { version: 1, paths: [] } })),
      ensureExampleConfigFiles: vi.fn(() => []),
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
  vi.doMock('./a2a/runtime-config.js', () => ({
    createConfiguredA2ARuntimeIntegration: vi.fn(() => ({
      runtimeOptions: { factories: [], policy: vi.fn(() => ({ allowed: true })) },
      start: vi.fn(async () => ({
        status: vi.fn(() => ({ domain: 'a2a' })),
        reload: vi.fn(async () => undefined),
        close: vi.fn(),
      })),
    })),
  }));

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
      runtimeStarts,
      runtimeDeletes,
      runManagedTask,
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
      'runtime-close',
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

  it('continues host cleanup when runtime close fails', async () => {
    const closeError = new Error('runtime close failed');
    const { main, harness } = await importMainWithMocks({
      runtimeClose: async () => { throw closeError; },
    });

    await expect(main()).rejects.toBe(closeError);

    expect(harness.calls).toEqual(expect.arrayContaining([
      'runtime-close',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
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

  it('routes print mode through the configured daemon runtime', async () => {
    process.argv = ['node', 'kodax', '-p', 'inspect the repo'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider', runtimeMode: 'daemon' },
    });

    await main();

    expect(harness.createKodaXRuntime).toHaveBeenCalledOnce();
    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'daemon',
      profile: 'default',
      autoStartDaemon: true,
    });
    expect(harness.runtimeOptions[0]).not.toHaveProperty('externalAgents');
    expect(harness.runtimeStarts).toHaveLength(1);
    expect(harness.runtimeStarts[0]).toMatchObject({
      sessionId: 'cli-session-1',
      prompt: 'inspect the repo',
      mode: 'managed_task',
      permissionBroker: 'client',
    });
    expect(harness.runManagedTask).not.toHaveBeenCalled();
    expect(harness.calls).toContain('runtime-close');
  });

  it('removes the transient runtime session for --no-session runs', async () => {
    process.argv = ['node', 'kodax', '-p', 'stateless task', '--no-session'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider', runtimeMode: 'embedded' },
    });

    await main();

    expect(harness.runtimeStarts).toHaveLength(1);
    expect(harness.runtimeDeletes).toEqual(['cli-session-1']);
    expect(harness.runManagedTask).not.toHaveBeenCalled();
  });

  it('applies CLI > env > config precedence to runtime mode and provider', async () => {
    process.env.KODAX_RUNTIME_MODE = 'daemon';
    process.env.KODAX_PROVIDER = 'env-provider';
    process.argv = [
      'node',
      'kodax',
      '-p',
      'precedence task',
      '--runtime-mode',
      'embedded',
    ];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'config-provider', runtimeMode: 'daemon' },
    });

    await main();

    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'embedded',
      defaultProvider: 'env-provider',
      autoStartDaemon: false,
      externalAgents: expect.objectContaining({ factories: [] }),
    });
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

  it('does not fall through when a root option precedes a subcommand', async () => {
    process.env.VITEST = 'true';
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-prefixed-daemon-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = [
        'node',
        'kodax',
        '--provider',
        'prefixed-provider',
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
