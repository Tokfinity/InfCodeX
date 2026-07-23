import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetActiveRootQueueRoutesForTests,
  _resetMessageQueueForTests,
  actorQueueId,
  applySessionCompaction,
  createSessionLineage,
  createAgent,
  enqueueWithArtifacts,
  getMessageQueue,
  resolveActiveRootQueueRoute,
  Runner,
} from '@kodax-ai/agent';
import type {
  GuardrailContext,
  ManagedRunClassification,
  RunnableTool,
  RunnerLlmResult,
  RunnerToolCall,
  WorkflowEvent,
} from '@kodax-ai/agent';
import type {
  AutoModeToolGuardrail,
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  RunningSession,
} from '@kodax-ai/coding';
import type { AutoModeBootstrapDeps } from '@kodax-ai/repl';
import type {
  RuntimeDaemonClientTransport,
  RuntimeEvent,
  RuntimeInput,
  RuntimeStartRunInput,
} from './sdk-runtime.js';
import type { RuntimeDaemonEndpoint } from './runtime-daemon/transport.js';
import {
  createRuntimePermissionMatcher,
  runtimePermissionHostPlatform,
} from './runtime-permission-scope.js';

const codingMock = vi.hoisted(() => ({
  runManagedTask: vi.fn(),
  startKodaX: vi.fn(),
}));

const replMock = vi.hoisted(() => ({
  bootstrapAutoMode: vi.fn(),
  beforeLoadSession: null as null | ((call: number) => Promise<void>),
  loadSessionCalls: 0,
}));

function runtimeAutoGuardrail(options: KodaXOptions): AutoModeToolGuardrail {
  const guardrail = options.guardrails?.find((candidate) => (
    candidate.kind === 'tool' && candidate.name === 'auto-mode'
  ));
  if (!guardrail || guardrail.kind !== 'tool') {
    throw new Error('expected Runtime-owned auto-mode tool guardrail');
  }
  const autoModeGuardrail = guardrail as AutoModeToolGuardrail;
  if (!autoModeGuardrail.beforeTool) {
    throw new Error('expected Runtime-owned auto-mode tool guardrail');
  }
  return autoModeGuardrail;
}

async function authorizeRuntimeAutoCall(
  options: KodaXOptions,
  call: RunnerToolCall,
): Promise<void> {
  const guardrail = runtimeAutoGuardrail(options);
  const context: GuardrailContext = {
    agent: createAgent({ name: 'runtime-auto-test', instructions: 'Test guardrail ordering.' }),
    messages: [],
  };
  const verdict = await guardrail.beforeTool?.(call, context);
  if (verdict?.action !== 'allow') {
    throw new Error(`expected auto-mode allow, received ${verdict?.action ?? 'no verdict'}`);
  }
}

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return {
    ...actual,
    runManagedTask: codingMock.runManagedTask,
    startKodaX: codingMock.startKodaX,
  };
});

vi.mock('@kodax-ai/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/repl')>();
  return {
    ...actual,
    bootstrapAutoMode: replMock.bootstrapAutoMode,
    createSessionManager: (...args: Parameters<typeof actual.createSessionManager>) => {
      const manager = actual.createSessionManager(...args);
      return {
        ...manager,
        async loadSession(sessionId: string) {
          const call = replMock.loadSessionCalls + 1;
          replMock.loadSessionCalls = call;
          await replMock.beforeLoadSession?.(call);
          return manager.loadSession(sessionId);
        },
      };
    },
  };
});

describe('createKodaXRuntime', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-'));
    codingMock.runManagedTask.mockReset();
    codingMock.startKodaX.mockReset();
    replMock.bootstrapAutoMode.mockReset();
    replMock.beforeLoadSession = null;
    replMock.loadSessionCalls = 0;
  });

  afterEach(async () => {
    _resetMessageQueueForTests();
    _resetActiveRootQueueRoutesForTests();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('hosts an embedded Runtime in a disposable Worker without changing the service API', async () => {
    const { createKodaXRuntime } = await import('./sdk-runtime.js');
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      isolation: 'worker',
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'worker-sessions'),
    });

    expect(runtime.identity).toMatchObject({
      mode: 'embedded',
      isolation: 'worker',
      workerThreadId: expect.any(Number),
    });
    const session = await runtime.sessions.create({ title: 'Worker Session' });
    await expect(runtime.sessions.list()).resolves.toEqual([
      expect.objectContaining({ id: session.id, title: 'Worker Session' }),
    ]);

    await runtime.close();
    await expect(runtime.status.snapshot()).rejects.toThrow(/Worker transport is closed/i);
  }, 60_000);

  it('fails closed when a connected Runtime lacks a required capability', async () => {
    const { createKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-no-hard-dispose',
            mode: 'embedded',
            profile: 'default',
            startedAt: '2026-07-10T00:00:00.000Z',
            version: '0.7.66',
          },
          capabilities: { hardDispose: false },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(createKodaXRuntime({
      mode: 'daemon',
      daemonTransport: transport,
      requirements: { hardDispose: true },
    })).rejects.toThrow(/does not support.*hardDispose/i);
  });

  it('fails closed when inline embedded Runtime cannot satisfy hard disposal', async () => {
    const { createKodaXRuntime } = await import('./sdk-runtime.js');

    await expect(createKodaXRuntime({
      mode: 'embedded',
      requirements: { hardDispose: true },
    })).rejects.toThrow(/does not support.*hardDispose/i);
  });

  it('fails closed when a daemon lacks the required safe management contract', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-without-management',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-15T00:00:00.000Z',
            version: '0.7.69',
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(connectKodaXRuntime({
      transport,
      requirements: { daemonManagement: 1 },
    })).rejects.toThrow(/does not support.*daemonManagement/i);
  });

  it('fails closed when an older daemon lacks fenced external Agent administration', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-with-legacy-external-agents',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-15T00:00:00.000Z',
            version: '0.7.70',
          },
          capabilities: { externalAgents: true },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(connectKodaXRuntime({
      transport,
      requirements: { externalAgentAdmin: 1 },
    })).rejects.toThrow(/does not support.*externalAgentAdmin/i);
  });

  it('fails closed when an older daemon lacks the versioned Actor control plane', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-without-actor-control-plane',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-18T00:00:00.000Z',
            version: '0.7.71',
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(connectKodaXRuntime({
      transport,
      requirements: { actorControlPlane: 1 },
    })).rejects.toThrow(/does not support.*actorControlPlane/i);
  });

  it('fails closed when an attach-only daemon lacks Runtime-owned Auto guardrails', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-with-legacy-permission-chain',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-18T00:00:00.000Z',
            version: '0.7.72',
          },
          capabilities: { sharedSessionSettings: { version: 1 } },
        };
      },
      subscribe() { return { close() {} }; },
    };

    await expect(connectKodaXRuntime({
      transport,
      requirements: { runtimeAutoModeGuardrail: 1 },
    })).rejects.toThrow(/does not support.*runtimeAutoModeGuardrail/i);
  });

  it('accepts a newer Runtime Auto guardrail capability for an older minimum requirement', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-with-auto-guardrail-v2',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-20T00:00:00.000Z',
            version: '0.7.73',
          },
          capabilities: {
            runtimeAutoModeGuardrail: { version: 2, owner: 'session-runtime' },
          },
        };
      },
      subscribe() { return { close() {} }; },
    };

    const runtime = await connectKodaXRuntime({
      transport,
      requirements: { runtimeAutoModeGuardrail: 1 },
    });
    expect(runtime.identity.runtimeId).toBe('daemon-with-auto-guardrail-v2');
    await runtime.close();
  });

  it('rejects Runtime Auto guardrail v1 when the caller requires v2 semantics', async () => {
    const { connectKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== 'initialize') return null;
        return {
          identity: {
            runtimeId: 'daemon-with-auto-guardrail-v1',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-19T00:00:00.000Z',
            version: '0.7.72',
          },
          capabilities: {
            runtimeAutoModeGuardrail: { version: 1, owner: 'session-runtime' },
          },
        };
      },
      subscribe() { return { close() {} }; },
    };

    await expect(connectKodaXRuntime({
      transport,
      requirements: { runtimeAutoModeGuardrail: 2 },
    })).rejects.toThrow(/does not support.*runtimeAutoModeGuardrail/i);
  });

  it('rejects Worker-only options unless Worker isolation is selected', async () => {
    const { createKodaXRuntime } = await import('./sdk-runtime.js');

    await expect(createKodaXRuntime({
      mode: 'embedded',
      worker: { shutdownTimeoutMs: 100 },
    })).rejects.toThrow(/worker options require.*isolation.*worker/i);
  });

  it('rejects an explicit embedded isolation mode for daemon ownership', async () => {
    const { createKodaXRuntime } = await import('./sdk-runtime.js');
    const transport: RuntimeDaemonClientTransport = {
      async request() {
        return {
          identity: {
            runtimeId: 'unused-daemon-runtime',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-10T00:00:00.000Z',
            version: '0.7.66',
          },
          capabilities: { hardDispose: false },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(createKodaXRuntime({
      mode: 'daemon',
      isolation: 'inline',
      daemonTransport: transport,
    })).rejects.toThrow(/daemon mode.*isolation/i);
  });

  it('exports daemon protocol schema artifacts from the runtime SDK entrypoint', async () => {
    const runtimeSdk = await import('@kodax-ai/kodax/runtime');

    expect(runtimeSdk.RUNTIME_DAEMON_METHODS).toContain('provider.custom.list');
    expect(runtimeSdk.RUNTIME_DAEMON_PROTOCOL_SCHEMA.methods).toMatchObject({
      'provider.custom.list': expect.any(Object),
      'mcp.server.validate': expect.any(Object),
      'extension.list': expect.any(Object),
    });
    expect(JSON.parse(runtimeSdk.RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON)).toMatchObject({
      protocol: runtimeSdk.KODAX_DAEMON_PROTOCOL,
      version: runtimeSdk.KODAX_DAEMON_PROTOCOL_VERSION,
    });
  });

  it('creates a daemon-mode runtime client through the daemon transport', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return {
            identity: {
              runtimeId: 'daemon-runtime',
              mode: 'embedded',
              profile: 'default',
              startedAt: '2026-07-09T00:00:00.000Z',
              version: '0.7.66',
            },
          };
        }
        if (method === 'session.create') {
          return { id: 'daemon-session', title: 'Daemon Session' };
        }
        return {};
      },
      subscribe() {
        return { close() {} };
      },
    };

    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      daemonTransport: transport,
      daemonToken: 'token-sdk',
      clientInfo: { name: 'sdk-test', version: '0.7.66' },
      capabilities: { permissionPrompts: true, contextDiagnostics: true },
    });
    const session = await runtime.sessions.create({ title: 'Daemon Session' });

    expect(runtime.identity).toMatchObject({
      runtimeId: 'daemon-runtime',
      mode: 'daemon',
    });
    expect(session).toEqual({ id: 'daemon-session', title: 'Daemon Session' });
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'session.create']);
    expect(calls[0]?.params).toMatchObject({
      profile: 'default',
      token: 'token-sdk',
      clientInfo: { name: 'sdk-test', version: '0.7.66' },
      capabilities: { permissionPrompts: true, contextDiagnostics: true },
    });
  });

  it('creates a daemon-mode runtime client through a local endpoint', async () => {
    const { createRuntimeDaemonSuccessResponse } = await import('./runtime-daemon/protocol.js');
    const { createRuntimeDaemonSocketServer } = await import('./runtime-daemon/transport.js');
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const endpoint = makeDaemonEndpoint(tempRoot);
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          if (request.method === 'initialize') {
            return createRuntimeDaemonSuccessResponse(request.id, {
              identity: {
                runtimeId: 'endpoint-daemon-runtime',
                mode: 'daemon',
                profile: 'default',
                startedAt: '2026-07-09T00:00:00.000Z',
                version: '0.7.66',
              },
            });
          }
          if (request.method === 'session.create') {
            return createRuntimeDaemonSuccessResponse(request.id, {
              id: 'endpoint-daemon-session',
              title: 'Endpoint Daemon Session',
            });
          }
          return createRuntimeDaemonSuccessResponse(request.id, {});
        },
        close() {},
      }),
    });
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      runtime = await createKodaXRuntime({
        mode: 'daemon',
        daemonEndpoint: endpoint,
      });
      const session = await runtime.sessions.create({ title: 'Endpoint Daemon Session' });

      expect(runtime.identity).toMatchObject({
        runtimeId: 'endpoint-daemon-runtime',
        mode: 'daemon',
      });
      expect(session).toEqual({
        id: 'endpoint-daemon-session',
        title: 'Endpoint Daemon Session',
      });
    } finally {
      await runtime?.close();
      await server.close();
    }
  });

  it('connects daemon-mode SDK clients through the default home/profile endpoint', async () => {
    const { createRuntimeDaemonSuccessResponse } = await import('./runtime-daemon/protocol.js');
    const {
      createRuntimeDaemonSocketServer,
      defaultRuntimeDaemonEndpoint,
    } = await import('./runtime-daemon/transport.js');
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const profile = `sdk-default-${randomUUID()}`;
    const endpoint = defaultRuntimeDaemonEndpoint(profile, tempRoot);
    const requests: Array<{
      readonly method: string;
      readonly params: unknown;
    }> = [];
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          requests.push({ method: request.method, params: request.params });
          if (request.method === 'initialize') {
            return createRuntimeDaemonSuccessResponse(request.id, {
              identity: {
                runtimeId: 'default-endpoint-daemon',
                mode: 'daemon',
                profile,
                startedAt: '2026-07-09T00:00:00.000Z',
                version: '0.7.66',
              },
            });
          }
          if (request.method === 'session.create') {
            return createRuntimeDaemonSuccessResponse(request.id, {
              id: 'default-endpoint-session',
              title: 'Default Endpoint Session',
            });
          }
          return createRuntimeDaemonSuccessResponse(request.id, {});
        },
        close() {},
      }),
    });
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      runtime = await createKodaXRuntime({
        mode: 'daemon',
        homeDir: tempRoot,
        profile,
        autoStartDaemon: false,
      });
      const session = await runtime.sessions.create({ title: 'Default Endpoint Session' });

      expect(runtime.identity).toMatchObject({
        runtimeId: 'default-endpoint-daemon',
        mode: 'daemon',
        profile,
      });
      expect(session.id).toBe('default-endpoint-session');
      expect(requests[0]).toMatchObject({
        method: 'initialize',
        params: {
          profile,
          endpoint: endpoint.path,
        },
      });
    } finally {
      await runtime?.close();
      await server.close();
    }
  });

  it('rejects daemon endpoints that report a different profile', async () => {
    const { connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        expect(method).toBe('initialize');
        return {
          identity: {
            runtimeId: 'wrong-profile-runtime',
            mode: 'daemon',
            profile: 'default',
            startedAt: '2026-07-09T00:00:00.000Z',
            version: '0.7.66',
          },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(connectKodaXRuntime({
      profile: 'space',
      transport,
    })).rejects.toThrow('Runtime daemon profile mismatch: expected space, got default');
  });

  it('auto-starts a local daemon host by default for daemon-mode SDK clients', async () => {
    const { connectKodaXRuntime, createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const {
      readRuntimeDaemonLockOwner,
      readRuntimeDaemonState,
      resolveRuntimeDaemonPaths,
    } = await import('./runtime-daemon/state.js');
    const sessionsDir = path.join(tempRoot, '.kodax', 'sessions');
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      homeDir: tempRoot,
      sessionsDir,
      profile: 'sdk-auto',
      defaultProvider: 'mock-provider',
    });

    const paths = resolveRuntimeDaemonPaths(tempRoot, 'sdk-auto');
    let peer: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;
    try {
      const session = await runtime.sessions.create({
        title: 'Auto Daemon Session',
        projectPath: tempRoot,
        surface: 'sdk',
      });

      expect(runtime.identity).toMatchObject({
        mode: 'daemon',
        profile: 'sdk-auto',
      });
      expect(session.title).toBe('Auto Daemon Session');
      expect(readRuntimeDaemonState(paths)).toMatchObject({
        runtimeId: runtime.identity.runtimeId,
        profile: 'sdk-auto',
        status: 'ready',
      });
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
        runtimeId: runtime.identity.runtimeId,
      });

      peer = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile: 'sdk-auto',
      });
      await runtime.close();

      expect(readRuntimeDaemonState(paths)).toMatchObject({
        runtimeId: peer.identity.runtimeId,
        status: 'ready',
      });
      await expect(peer.status.snapshot()).resolves.toMatchObject({
        runtimeId: runtime.identity.runtimeId,
      });
    } finally {
      await peer?.close();
      await runtime.close();
      await shutdownRuntimeDaemon(tempRoot, 'sdk-auto');
    }

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('uses homeDir as the default session storage root when sessionsDir is omitted', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const embeddedHome = path.join(tempRoot, 'embedded-home');
    const daemonHome = path.join(tempRoot, 'daemon-home');

    const embedded = await createKodaXRuntime({ homeDir: embeddedHome });
    try {
      const session = await embedded.sessions.create({
        title: 'Embedded Home Session',
        projectPath: embeddedHome,
      });
      const listed = await embedded.sessions.list({ limit: 20 });
      expect(listed.map((item) => item.id)).toEqual([session.id]);
      expect((await fs.stat(path.join(embeddedHome, '.kodax', 'sessions'))).isDirectory()).toBe(true);
    } finally {
      await embedded.close();
    }

    const daemonProfile = `home-sessions-${randomUUID()}`;
    const daemon = await createKodaXRuntime({
      mode: 'daemon',
      homeDir: daemonHome,
      profile: daemonProfile,
      defaultProvider: 'mock-provider',
    });
    try {
      const session = await daemon.sessions.create({
        title: 'Daemon Home Session',
        projectPath: daemonHome,
      });
      const listed = await daemon.sessions.list({ limit: 20 });
      expect(listed.map((item) => item.id)).toEqual([session.id]);
      expect((await fs.stat(path.join(daemonHome, '.kodax', 'sessions'))).isDirectory()).toBe(true);
    } finally {
      await daemon.close();
      await shutdownRuntimeDaemon(daemonHome, daemonProfile);
    }
  });

  it('filters Runtime sessions by surface and continues with an opaque cursor', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    try {
      await runtime.sessions.create({ title: 'ACP One', surface: 'acp' });
      await runtime.sessions.create({ title: 'REPL One', surface: 'repl' });
      await runtime.sessions.create({ title: 'ACP Two', surface: 'acp' });
      await runtime.sessions.create({ title: 'ACP Three', surface: 'acp' });

      const firstPage = await runtime.sessions.list({ surface: 'acp', limit: 2 });
      const cursor = firstPage.at(-1)?.cursor;
      const secondPage = await runtime.sessions.list({ surface: 'acp', limit: 2, cursor });
      const combined = [...firstPage, ...secondPage];

      expect(cursor).toEqual(expect.any(String));
      expect(new Set(combined.map((session) => session.id)).size).toBe(3);
      expect(combined.every((session) => session.surface === 'acp')).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('shares Space-style SDK control-plane access across daemon clients', async () => {
    const { connectKodaXRuntime, createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const profile = `space-${randomUUID()}`;
    const capabilities = {
      richEvents: true,
      permissionPrompts: true,
      configAdmin: true,
      commandCatalog: true,
      skillCatalog: true,
      artifactUpload: true,
      contextDiagnostics: true,
    };
    const space = await createKodaXRuntime({
      mode: 'daemon',
      homeDir: tempRoot,
      profile,
      defaultProvider: 'mock-provider',
      clientInfo: { name: 'kodax-space', title: 'KodaX Space', version: '0.1.29' },
      capabilities,
    });
    let ide: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;

    try {
      ide = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile,
        clientInfo: { name: 'kodax-ide', title: 'KodaX IDE Adapter', version: '0.1.0' },
        capabilities,
      });

      const session = await space.sessions.create({
        title: 'Space Shared Session',
        projectPath: tempRoot,
        surface: 'space-desktop',
        profileId: 'space',
      });
      await fs.writeFile(path.join(tempRoot, 'space-note.md'), '# shared note\n', 'utf-8');
      const visibleSessions = await ide.sessions.list({ limit: 20 });
      const updated = await ide.sessions.updateSettings(session.id, {
        provider: 'mock-provider',
        model: 'space-model',
      });
      const settingsFromSpace = await space.sessions.getSettings(session.id);
      const artifact = await ide.artifacts.create({
        kind: 'file',
        path: path.join(tempRoot, 'space-note.md'),
        name: 'space-note.md',
        source: 'file-picker',
      });
      const artifactFromSpace = await space.artifacts.get(artifact.id);
      const [providers, commands, skills, latestBudget, status] = await Promise.all([
        ide.catalog.providers(),
        ide.catalog.commands(tempRoot),
        ide.catalog.skills({ userInvocableOnly: true }),
        ide.diagnostics.latestContextBudget({ sessionId: session.id }),
        ide.status.snapshot(),
      ]);

      expect(space.identity.runtimeId).toBe(ide.identity.runtimeId);
      expect(visibleSessions.map((item) => item.id)).toContain(session.id);
      expect(updated).toMatchObject({ provider: 'mock-provider', model: 'space-model' });
      expect(settingsFromSpace).toMatchObject({ provider: 'mock-provider', model: 'space-model' });
      expect(artifactFromSpace).toMatchObject({
        id: artifact.id,
        kind: 'file',
        name: 'space-note.md',
        source: 'file-picker',
      });
      expect(Array.isArray(providers)).toBe(true);
      expect(Array.isArray(commands)).toBe(true);
      expect(Array.isArray(skills)).toBe(true);
      expect(latestBudget).toBeNull();
      expect(status.runtimeId).toBe(space.identity.runtimeId);
      expect(status.profile).toBe(profile);
      expect(status.sessions.some((item) => item.id === session.id)).toBe(true);
    } finally {
      await ide?.close();
      await space.close();
      await shutdownRuntimeDaemon(tempRoot, profile);
    }
  });

  it('lets a Space-style daemon client subscribe to permission prompts and resolve another client run', async () => {
    const { connectKodaXRuntime, createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const profile = `space-permission-${randomUUID()}`;
    const capabilities = {
      richEvents: true,
      permissionPrompts: true,
      contextDiagnostics: true,
    };
    const worker = await createKodaXRuntime({
      mode: 'daemon',
      homeDir: tempRoot,
      profile,
      defaultProvider: 'mock-provider',
      clientInfo: { name: 'kodax-repl', title: 'KodaX REPL', version: '0.7.66' },
      capabilities,
    });
    let space: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;
    let approvalDone: Promise<unknown> | undefined;
    let responseDone: Promise<boolean> | undefined;
    const seen: string[] = [];

    try {
      space = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile,
        clientInfo: { name: 'kodax-space', title: 'KodaX Space', version: '0.1.29' },
        capabilities,
      });
      const session = await worker.sessions.create({
        title: 'Space Permission Session',
        projectPath: tempRoot,
        surface: 'space-desktop',
        profileId: 'space',
      });

      const permissionSubscription = space.events.subscribe({ sessionId: session.id }, (event) => {
        seen.push(event.type);
        if (event.type !== 'permission.requested') return;
        const payload = event.payload;
        if (!isPermissionRequestPayload(payload)) return;
        responseDone = space?.permissions.respond(
          payload.id,
          { type: 'allow_once' },
          { runId: payload.runId },
        );
      });
      expect(permissionSubscription.ready).toBeInstanceOf(Promise);
      await permissionSubscription.ready;

      approvalDone = worker.permissions.request({
        sessionId: session.id,
        runId: 'run-space-permission',
        turnId: 'turn-space-permission',
        toolCallId: 'tool-space-permission',
        toolName: 'bash',
        inputPreview: '{"command":"echo from space permission"}',
      });
      await expect(expectSettles(approvalDone, 'space permission approval', 5_000)).resolves.toEqual({
        type: 'allow_once',
      });
      if (!responseDone) throw new Error('Space permission response was not submitted.');
      await expect(expectSettles(responseDone, 'space permission response', 5_000)).resolves.toBe(true);
      await flushMicrotasks();

      expect(await space.permissions.listPending({ runId: 'run-space-permission' })).toEqual([]);
      expect(seen).toContain('permission.requested');
      expect(seen).toContain('permission.resolved');
      const replay = await space.events.replay({
        runId: 'run-space-permission',
        type: ['permission.requested', 'permission.resolved'],
      });
      expect(replay.map((event) => event.type)).toEqual([
        'permission.requested',
        'permission.resolved',
      ]);
    } finally {
      await space?.close();
      await worker.close();
      await shutdownRuntimeDaemon(tempRoot, profile);
    }
  });

  it('keeps daemon-mode SDK clients attach-only when autoStartDaemon is false', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const {
      readRuntimeDaemonLockOwner,
      readRuntimeDaemonState,
      resolveRuntimeDaemonPaths,
    } = await import('./runtime-daemon/state.js');
    const profile = `sdk-no-auto-${randomUUID()}`;
    const paths = resolveRuntimeDaemonPaths(tempRoot, profile);

    await expect(createKodaXRuntime({
      mode: 'daemon',
      homeDir: tempRoot,
      profile,
      autoStartDaemon: false,
    })).rejects.toThrow();

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('creates, lists, loads, transcripts, and forks sessions through one runtime service', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const seen: string[] = [];
    runtime.events.subscribe({}, (event) => seen.push(event.type));

    const session = await runtime.sessions.create({
      title: 'Runtime Test',
      projectPath: tempRoot,
      surface: 'sdk',
      profileId: 'coder',
    });
    const listed = await runtime.sessions.list({ limit: 10 });
    const loaded = await runtime.sessions.load(session.id);
    const transcript = await runtime.sessions.transcript(session.id);
    const forked = await runtime.sessions.fork({
      sessionId: session.id,
      title: 'Runtime Fork',
    });

    expect(session.title).toBe('Runtime Test');
    expect(session.workspaceRoot).toBe(path.resolve(tempRoot));
    expect(listed.map((item) => item.id)).toContain(session.id);
    expect(loaded.id).toBe(session.id);
    expect(transcript?.transcriptEntries).toEqual([]);
    expect(forked?.title).toBe('Runtime Fork');
    expect(seen.filter((type) => type === 'session.created')).toHaveLength(2);

    await runtime.close();
  }, 60_000);

  it('isolates event listener failures from runtime operations and other subscribers', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const received: string[] = [];
    runtime.events.subscribe({}, () => {
      throw new Error('consumer boom');
    });
    runtime.events.subscribe({}, (event) => {
      received.push(event.type);
    });

    const session = await runtime.sessions.create({ title: 'Listener Isolation' });

    expect(session.title).toBe('Listener Isolation');
    expect(received).toEqual(['session.created']);
    await expect(runtime.events.replay({ sessionId: session.id }))
      .resolves.toEqual([expect.objectContaining({ type: 'session.created' })]);
    await runtime.close();
  });

  it('persists session settings and applies them as run defaults', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'fallback-provider',
      defaultModel: 'fallback-model',
    });
    const session = await runtime.sessions.create({ title: 'Settings Test' });
    const settingsEvents: unknown[] = [];
    const effectiveConfigs: unknown[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (event.type === 'session.settings.updated') settingsEvents.push(event.payload);
      if (event.type === 'config.effective') effectiveConfigs.push(event.payload);
    });

    const settings = await runtime.sessions.updateSettings(session.id, {
      provider: 'settings-provider',
      model: 'settings-model',
      effort: 'high',
      thinking: true,
      reasoningMode: 'balanced',
      permissionMode: 'accept-edits',
      executionCwd: path.resolve(tempRoot),
      autoModeClassifierModel: 'mock-provider:classifier-model',
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 110,
      compactionTriggerTokens: 120_000,
    });
    expect(settings).toMatchObject({
      provider: 'settings-provider',
      model: 'settings-model',
      effort: 'high',
      thinking: true,
      reasoningMode: 'balanced',
      permissionMode: 'accept-edits',
      executionCwd: path.resolve(tempRoot),
      autoModeClassifierModel: 'mock-provider:classifier-model',
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });
    await expect(runtime.sessions.updateSettings(session.id, { autoModeTimeoutMs: 0 }))
      .rejects.toThrow(/positive safe integer/);
    await expect(runtime.sessions.updateSettings(session.id, { autoModeSpeculativeWindowMs: -1 }))
      .rejects.toThrow(/non-negative safe integer/);
    await expect(runtime.sessions.updateSettings(session.id, { compactionTriggerTokens: -1 }))
      .rejects.toThrow(/positive safe integer or zero/);
    await expect(runtime.sessions.getSettings(session.id)).resolves.toMatchObject({
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });

    let capturedOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      capturedOptions = options;
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'settings done',
        messages: [],
        sessionId: session.id,
      }));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'uses settings' });
    await handle.result;

    expect(capturedOptions).toMatchObject({
      provider: 'settings-provider',
      modelOverride: 'settings-model',
      effort: 'high',
      thinking: true,
      reasoningMode: 'balanced',
      compaction: {
        triggerPercent: 90,
        triggerTokens: 120_000,
      },
      context: { executionCwd: path.resolve(tempRoot) },
    });
    expect(settingsEvents).toHaveLength(1);
    expect(effectiveConfigs[0]).toMatchObject({
      provider: 'settings-provider',
      model: 'settings-model',
      effort: 'high',
      thinking: true,
      reasoningMode: 'balanced',
      permissionMode: 'accept-edits',
      executionCwd: path.resolve(tempRoot),
      autoModeClassifierModel: 'mock-provider:classifier-model',
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });

    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'fallback-provider',
    });
    await expect(recreated.sessions.getSettings(session.id)).resolves.toMatchObject({
      provider: 'settings-provider',
      model: 'settings-model',
      permissionMode: 'accept-edits',
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });
    await expect(
      recreated.sessions.updateSettings(session.id, {
        compactionTriggerPercent: -5,
        compactionTriggerTokens: 0,
      }),
    ).resolves.toMatchObject({
      compactionTriggerPercent: 15,
    });
    await expect(recreated.sessions.getSettings(session.id)).resolves.not.toHaveProperty('compactionTriggerTokens');
    await recreated.close();
  });

  it('keeps 0.7.x compatibility aliases without restoring retired AMAW behavior', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Compatibility Aliases' });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'amaw' });
    let effectiveAgentMode: unknown;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      effectiveAgentMode = options.agentMode;
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId: session.id,
      }));
    });

    await (await runtime.runs.start({ sessionId: session.id, prompt: 'compat' })).result;
    expect(effectiveAgentMode).toBe('ama');
    const preflight = await runtime.status.preflight();
    // Compile-time compatibility: 0.7.x consumers may access the legacy
    // property without an undefined guard.
    const legacyTasks: readonly unknown[] = preflight.activeAgentTasks;
    expect(legacyTasks).toBe(preflight.activeAgentTurns);
    await runtime.close();
  });

  it('hides exit_plan_mode when a Runtime run has no approval callback', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Plan Bridge Test' });
    const capturedOptions: KodaXOptions[] = [];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      capturedOptions.push(options);
      return fakeRunningSession(
        options,
        Promise.resolve({
          success: true,
          lastText: 'done',
          messages: [],
          sessionId: session.id,
        }),
      );
    });

    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: 'plan without a bridge',
        options: { context: { excludeTools: ['caller_tool'] } },
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: 'plan with a bridge',
        options: {
          context: { excludeTools: ['caller_tool'] },
          events: { exitPlanMode: async () => true },
        },
      })
    ).result;

    expect(capturedOptions[0]?.context?.excludeTools).toEqual([
      'caller_tool',
      'exit_plan_mode',
    ]);
    expect(capturedOptions[1]?.context?.excludeTools).toEqual(['caller_tool']);
    await runtime.close();
  });

  it('keeps session executionCwd settings inside the session workspace root', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const projectRoot = path.join(tempRoot, 'project');
    const outsideRoot = path.join(tempRoot, 'outside');
    const dotPrefixedDirectory = path.join(projectRoot, '..cache');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.mkdir(dotPrefixedDirectory, { recursive: true });
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({
      sessionsDir,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({
      title: 'Workspace Settings Test',
      projectPath: projectRoot,
    });

    await expect(runtime.sessions.updateSettings(session.id, {
      executionCwd: projectRoot,
    })).resolves.toMatchObject({ executionCwd: path.resolve(projectRoot) });
    await expect(runtime.sessions.updateSettings(session.id, {
      executionCwd: dotPrefixedDirectory,
    })).resolves.toMatchObject({ executionCwd: path.resolve(dotPrefixedDirectory) });
    await expect(runtime.sessions.updateSettings(session.id, {
      executionCwd: outsideRoot,
    })).rejects.toThrow('executionCwd must stay within the session workspace root');
    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'blocked run cwd override',
      options: { context: { executionCwd: outsideRoot } },
    })).rejects.toThrow('executionCwd must stay within the session workspace root');
    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'blocked run boundary override',
      options: { context: { gitRoot: outsideRoot } },
    })).rejects.toThrow('gitRoot must match the session repository safety boundary');
    await fs.writeFile(
      path.join(tempRoot, '.kodax', 'runtime', 'session-settings', `${encodeURIComponent(session.id)}.json`),
      JSON.stringify({ executionCwd: outsideRoot }),
      'utf-8',
    );
    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'blocked by workspace root',
    })).rejects.toThrow('executionCwd must stay within the session workspace root');

    await runtime.close();
  });

  it('skips corrupted runtime persistence records and exposes runtime warnings', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const badRunDir = path.join(tempRoot, '.kodax', 'runtime', 'runs', 'bad-run');
    const settingsDir = path.join(tempRoot, '.kodax', 'runtime', 'session-settings');
    await fs.mkdir(badRunDir, { recursive: true });
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(path.join(badRunDir, 'status.json'), '{bad status', 'utf-8');
    await fs.writeFile(
      path.join(badRunDir, 'events.jsonl'),
      '{"id":"evt_bad","seq":1}\nnot-json\n',
      'utf-8',
    );
    await fs.writeFile(path.join(settingsDir, 'corrupt-session.json'), '{bad settings', 'utf-8');

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.list()).resolves.toEqual([]);
    await runtime.sessions.create({ sessionId: 'corrupt-session' });
    await expect(runtime.sessions.getSettings('corrupt-session')).resolves.toEqual({});
    const warnings = await runtime.events.replay({ type: 'runtime.warning' });
    const messages = warnings.map((event) => (
      event.payload as { readonly message?: string }
    ).message ?? '');
    expect(messages.some((message) => message.includes('runtime status record'))).toBe(true);
    expect(messages.some((message) => message.includes('runtime event record'))).toBe(true);
    expect(messages.some((message) => message.includes('runtime session settings'))).toBe(true);

    await runtime.close();
  });

  it('marks persisted non-terminal runs interrupted on runtime startup', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runDir = path.join(tempRoot, '.kodax', 'runtime', 'runs', 'run-crashed');
    const queuedRunDir = path.join(tempRoot, '.kodax', 'runtime', 'runs', 'run-queued');
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(queuedRunDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
      runId: 'run-crashed',
      sessionId: 'session-crashed',
      phase: 'running',
      startedAt: '2026-07-09T00:00:00.000Z',
      provider: 'mock-provider',
      interruptInputs: [{
        inputId: 'input-crashed',
        afterRunId: 'run-crashed',
        delivery: 'interrupt',
        state: 'queued',
        contentPreview: 'lost on restart',
        queuedAt: '2026-07-09T00:00:01.000Z',
      }],
    }), 'utf-8');
    await fs.writeFile(path.join(queuedRunDir, 'status.json'), JSON.stringify({
      runId: 'run-queued',
      sessionId: 'session-crashed',
      phase: 'queued',
      startedAt: '2026-07-09T00:00:01.000Z',
      provider: 'mock-provider',
    }), 'utf-8');

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get('run-crashed')).resolves.toMatchObject({
      runId: 'run-crashed',
      sessionId: 'session-crashed',
      phase: 'interrupted',
      error: 'daemon_crashed',
      terminal: {
        kind: 'interrupted',
        code: 'daemon_crashed',
        effectOutcome: 'unknown',
      },
      interruptInputs: [expect.objectContaining({
        inputId: 'input-crashed',
        state: 'terminal',
      })],
    });
    await expect(runtime.runs.get('run-queued')).resolves.toMatchObject({
      runId: 'run-queued',
      phase: 'interrupted',
      error: 'runtime_restarted',
      terminal: {
        kind: 'interrupted',
        code: 'runtime_restarted',
        effectOutcome: 'none',
      },
    });
    await expect(runtime.runs.await('run-crashed')).resolves.toMatchObject({
      runId: 'run-crashed',
      sessionId: 'session-crashed',
      phase: 'interrupted',
      error: expect.any(Error),
    });
    await expect(runtime.events.replay({
      runId: 'run-crashed',
      type: 'run.interrupted',
    })).resolves.toHaveLength(1);

    await runtime.close();
  });

  it('restores a durable terminal event instead of emitting a conflicting restart terminal', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runId = 'run-terminal-event-won';
    const sessionId = 'session-terminal-event-won';
    const runDir = path.join(tempRoot, '.kodax', 'runtime', 'runs', runId);
    const completed = {
      runId,
      sessionId,
      phase: 'completed',
      startedAt: '2026-07-09T00:00:00.000Z',
      endedAt: '2026-07-09T00:01:00.000Z',
      provider: 'mock-provider',
      terminal: {
        revision: 1,
        kind: 'completed',
        code: 'completed',
        effectOutcome: 'known',
      },
    };
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
      runId,
      sessionId,
      phase: 'running',
      startedAt: completed.startedAt,
      provider: completed.provider,
    }), 'utf-8');
    await fs.writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify({
      id: 'evt-terminal-event-won',
      seq: 1,
      time: completed.endedAt,
      sessionId,
      runId,
      type: 'run.completed',
      payload: completed,
    })}\n`, 'utf-8');

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get(runId)).resolves.toMatchObject({
      phase: 'completed',
      terminal: { kind: 'completed', code: 'completed' },
    });
    await expect(runtime.events.replay({ runId })).resolves.toEqual([
      expect.objectContaining({ type: 'run.completed' }),
    ]);
    await runtime.close();
  });

  it('recovers delivered interrupt state from its durable batch event', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runId = 'run-durable-interrupt-event';
    const sessionId = 'session-durable-interrupt-event';
    const runDir = path.join(tempRoot, '.kodax', 'runtime', 'runs', runId);
    const queuedAt = '2026-07-09T00:00:01.000Z';
    const deliveredAt = '2026-07-09T00:00:02.000Z';
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
      runId,
      sessionId,
      phase: 'running',
      startedAt: '2026-07-09T00:00:00.000Z',
      provider: 'mock-provider',
      interruptInputs: [{
        inputId: 'input-durable',
        afterRunId: runId,
        delivery: 'interrupt',
        state: 'queued',
        contentPreview: 'already consumed',
        queuedAt,
      }],
    }), 'utf-8');
    await fs.writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify({
      id: 'evt-durable-interrupt',
      seq: 1,
      time: deliveredAt,
      sessionId,
      runId,
      type: 'run.input.delivered',
      payload: {
        inputs: [{
          inputId: 'input-durable',
          afterRunId: runId,
          input: { type: 'text', text: 'already consumed' },
          queuedAt,
          deliveredAt,
        }],
      },
    })}\n`, 'utf-8');

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get(runId)).resolves.toMatchObject({
      phase: 'interrupted',
      interruptInputs: [expect.objectContaining({
        inputId: 'input-durable',
        state: 'delivered',
        deliveredAt,
      })],
    });
    await runtime.close();
  });

  it('persists non-terminal run status while a run is active', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Active Status Persistence' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'stay active' });
    const statusFile = path.join(tempRoot, '.kodax', 'runtime', 'runs', encodeURIComponent(handle.runId), 'status.json');
    const persisted = JSON.parse(await fs.readFile(statusFile, 'utf-8')) as { readonly phase?: unknown };

    expect(persisted.phase).toBe('running');
    await runtime.close();
  });

  it('normalizes runtime multimodal input into prompt plus coding inputArtifacts', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Input Artifact Test' });
    let capturedOptions: KodaXOptions | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      expect(['inspect these inputs', 'inspect artifact ref']).toContain(prompt);
      capturedOptions = options;
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'artifact done',
        messages: [],
        sessionId: session.id,
      }));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'inspect these inputs' },
        {
          type: 'image',
          path: path.join(tempRoot, 'screen.png'),
          mediaType: 'image/png',
          source: 'file-picker',
          description: 'screenshot',
        },
        {
          type: 'file',
          path: path.join(tempRoot, 'notes.txt'),
          mimeType: 'text/plain',
          name: 'notes.txt',
        },
      ],
      options: {
        context: {
          inputArtifacts: [{
            kind: 'file',
            path: path.join(tempRoot, 'legacy.md'),
            mimeType: 'text/markdown',
          }],
        },
      },
    });
    await handle.result;

    expect(capturedOptions?.context?.inputArtifacts).toEqual([
      {
        kind: 'file',
        path: path.join(tempRoot, 'legacy.md'),
        mimeType: 'text/markdown',
      },
      {
        kind: 'image',
        path: path.join(tempRoot, 'screen.png'),
        mediaType: 'image/png',
        source: 'file-picker',
        description: 'screenshot',
      },
      {
        kind: 'file',
        path: path.join(tempRoot, 'notes.txt'),
        mimeType: 'text/plain',
        name: 'notes.txt',
      },
    ]);

    await fs.writeFile(
      path.join(tempRoot, 'from-artifact-ref.txt'),
      'artifact contents',
      'utf-8',
    );
    const artifact = await runtime.artifacts.create({
      kind: 'file',
      path: path.join(tempRoot, 'from-artifact-ref.txt'),
      mimeType: 'text/plain',
      name: 'from-artifact-ref.txt',
      description: 'created through runtime artifact service',
    });
    expect(artifact.sizeBytes).toBe(Buffer.byteLength('artifact contents'));
    const refHandle = await runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'inspect artifact ref' },
        { type: 'artifact_ref', artifactId: artifact.id },
      ],
    });
    await refHandle.result;

    expect(capturedOptions?.context?.inputArtifacts?.at(-1)).toEqual({
      kind: 'file',
      path: path.join(tempRoot, 'from-artifact-ref.txt'),
      mimeType: 'text/plain',
      name: 'from-artifact-ref.txt',
      description: 'created through runtime artifact service',
    });

    await runtime.close();
  });

  it('rejects unsupported runtime artifacts before queueing a run', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Unsupported Artifact Test' });

    await expect(runtime.artifacts.create({
      kind: 'audio',
      path: path.join(tempRoot, 'clip.mp3'),
    } as unknown as Parameters<typeof runtime.artifacts.create>[0]))
      .rejects.toThrow('Unsupported runtime artifact kind: audio');

    await expect(runtime.artifacts.create({
      kind: 'file',
      path: path.join(tempRoot, 'missing.txt'),
    })).rejects.toThrow('Runtime artifact path is not readable');
    await expect(runtime.artifacts.create({
      kind: 'file',
      path: tempRoot,
    })).rejects.toThrow('Runtime artifact path must be a regular file');

    const oversizedPath = path.join(tempRoot, 'oversized.bin');
    const oversized = await fs.open(oversizedPath, 'w');
    try {
      await oversized.truncate(256 * 1024 * 1024 + 1);
    } finally {
      await oversized.close();
    }
    await expect(runtime.artifacts.create({
      kind: 'file',
      path: oversizedPath,
    })).rejects.toThrow('Runtime artifact exceeds the 268435456-byte limit');

    await expect(runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'listen to this' },
        { type: 'audio', path: path.join(tempRoot, 'clip.mp3') },
      ],
    } as unknown as Parameters<typeof runtime.runs.start>[0]))
      .rejects.toThrow('Unsupported runtime input type: audio');

    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await expect(runtime.runs.list()).resolves.toEqual([]);

    await runtime.close();
  });

  it('exposes project prompt commands through the runtime catalog', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const commandDir = path.join(tempRoot, '.kodax', 'commands');
    const commandFile = path.join(commandDir, 'ship-runtime.md');
    await fs.mkdir(commandDir, { recursive: true });
    await fs.writeFile(commandFile, [
      '---',
      'name: ship-runtime',
      'aliases: [deploy-runtime]',
      'description: Deploy from the runtime catalog',
      'argument-hint: <target>',
      'allowed-tools: bash, read',
      'agent: release',
      'model: release-model',
      '---',
      '',
      'Deploy the selected target.',
      '',
    ].join('\n'), 'utf8');

    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, '.kodax', 'sessions'),
      defaultProvider: 'mock-provider',
    });

    try {
      const commands = await runtime.catalog.commands(tempRoot);
      const command = commands.find((item) => item.name === 'ship-runtime');

      expect(command).toMatchObject({
        name: 'ship-runtime',
        aliases: ['deploy-runtime'],
        description: 'Deploy from the runtime catalog',
        source: 'extension',
        location: 'project',
        path: commandFile,
        userInvocable: true,
        argumentHint: '<target>',
        allowedTools: 'bash, read',
        agent: 'release',
        model: 'release-model',
      });

      await expect(runtime.catalog.resolveCommand({
        name: 'deploy-runtime',
        projectRoot: tempRoot,
      })).resolves.toMatchObject({
        name: 'ship-runtime',
        path: commandFile,
      });
    } finally {
      await runtime.close();
    }
  });

  it('does not mutate the REPL global command registry when listing project commands', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { getCommandRegistry } = await import('@kodax-ai/repl');
    const registry = getCommandRegistry();
    registry.unregister('runtime-local-only');
    registry.register({
      name: 'runtime-local-only',
      description: 'Registered by the live REPL process',
      source: 'extension',
      handler: async () => {},
    });

    const commandDir = path.join(tempRoot, '.kodax', 'commands');
    await fs.mkdir(commandDir, { recursive: true });
    await fs.writeFile(path.join(commandDir, 'space-project.md'), [
      '---',
      'name: space-project',
      'description: Project command for Space',
      '---',
      '',
      'Run the project command.',
      '',
    ].join('\n'), 'utf8');

    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, '.kodax', 'sessions'),
      defaultProvider: 'mock-provider',
    });

    try {
      const commands = await runtime.catalog.commands(tempRoot);

      expect(commands.some((item) => item.name === 'space-project')).toBe(true);
      expect(registry.has('runtime-local-only')).toBe(true);
      expect(registry.has('space-project')).toBe(false);
    } finally {
      registry.unregister('runtime-local-only');
      await runtime.close();
    }
  });

  it('exposes read-only extension inventory and MCP validation through runtime services', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, '.kodax', 'sessions'),
      defaultProvider: 'mock-provider',
    });

    try {
      await expect(runtime.catalog.extensions()).resolves.toEqual({
        active: false,
        extensions: [],
      });
      await expect(runtime.mcp.validateServer('local', {
        type: 'stdio',
        command: 'echo',
      })).resolves.toEqual({
        ok: true,
        config: {
          type: 'stdio',
          command: 'echo',
        },
      });
      await expect(runtime.mcp.validateServer('broken', {
        type: 'stdio',
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('stdio transport requires'),
      });
    } finally {
      await runtime.close();
    }
  });

  it('exposes custom provider CRUD through runtime catalog services', async () => {
    const { setAgentConfigHome } = await import('@kodax-ai/agent');
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const configHome = path.join(tempRoot, '.kodax');
    setAgentConfigHome(configHome);

    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, '.kodax', 'sessions'),
      defaultProvider: 'mock-provider',
    });

    try {
      await expect(runtime.catalog.customProviders()).resolves.toEqual([]);
      await expect(runtime.catalog.upsertCustomProvider({
        name: 'custom-openai',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_OPENAI_KEY',
        model: 'custom-model',
      })).resolves.toMatchObject({
        name: 'custom-openai',
        model: 'custom-model',
      });
      await expect(runtime.catalog.customProviders()).resolves.toEqual([
        expect.objectContaining({
          name: 'custom-openai',
          baseUrl: 'https://example.invalid/v1',
        }),
      ]);
      await expect(runtime.catalog.deleteCustomProvider('custom-openai')).resolves.toBe(true);
      await expect(runtime.catalog.customProviders()).resolves.toEqual([]);
    } finally {
      await runtime.close();
      setAgentConfigHome(undefined);
    }
  });

  it('exposes transcript notice session operation through runtime events', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Notice Test' });
    const seen: string[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      seen.push(event.type);
    });

    const entry = await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: 'test',
      content: 'host-side notice',
    });
    const transcript = await runtime.sessions.transcript(session.id);

    expect(entry).toMatchObject({
      type: 'client_notice',
      source: 'client',
      payload: { content: 'host-side notice' },
    });
    expect(transcript?.transcriptEntries).toContainEqual(expect.objectContaining({
      type: 'client_notice',
      source: 'client',
      payload: expect.objectContaining({
        content: 'host-side notice',
        source: 'test',
      }),
    }));
    expect(seen).toContain('session.notice.appended');

    await runtime.close();
  });

  it('exposes rewind and setActiveEntry session operations through runtime events', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { createSessionLineage } = await import('@kodax-ai/agent');
    const { createSessionManager } = await import('@kodax-ai/repl');
    const sessionId = 'runtime-history-session';
    const manager = createSessionManager({ sessionsDir: tempRoot });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second reply' },
    ];
    const lineage = createSessionLineage(messages);
    const userEntries = lineage.entries.filter((entry) => (
      entry.type === 'message' && entry.message.role === 'user'
    ));
    const firstUserEntry = userEntries[0];
    const secondUserEntry = userEntries[1];
    expect(firstUserEntry).toBeDefined();
    expect(secondUserEntry).toBeDefined();
    await manager.storage.save(sessionId, {
      messages,
      lineage,
      title: 'History Test',
      gitRoot: tempRoot,
      scope: 'user',
    });

    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const seen: string[] = [];
    runtime.events.subscribe({ sessionId }, (event) => {
      seen.push(event.type);
    });

    const rewound = await runtime.sessions.rewind({
      sessionId,
      selector: secondUserEntry!.id,
    });
    const afterRewind = await manager.loadSession(sessionId);
    expect(rewound?.id).toBe(sessionId);
    expect(afterRewind?.messages.map((message) => message.content)).toEqual([
      'first',
      'first reply',
      'second',
    ]);

    const active = await runtime.sessions.setActiveEntry({
      sessionId,
      entryId: firstUserEntry!.id,
    });
    const afterSetActive = await manager.loadSession(sessionId);
    expect(active?.id).toBe(sessionId);
    expect(afterSetActive?.messages.map((message) => message.content)).toEqual(['first']);
    expect(seen).toEqual(['session.rewound', 'session.active_entry.updated']);

    await runtime.close();
  });

  it('rejects canonical session mutations while the session has an active run', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Active Mutation Conflict' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'stay active' });

    await expect(runtime.sessions.rewind({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(runtime.sessions.setActiveEntry({
      sessionId: session.id,
      entryId: 'entry-during-run',
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(runtime.sessions.compact({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'conflict' });

    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it('normalizes run callbacks into scoped runtime events and terminal status', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Run Test' });
    const events: Array<{
      type: string;
      sessionId: string;
      runId: string;
      seq: number;
      time: string;
      turnId?: string;
    }> = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      events.push({
        type: event.type,
        sessionId: event.sessionId,
        runId: event.runId,
        seq: event.seq,
        time: event.time,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
    });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      expect(prompt).toBe('hello runtime');
      const sessionId = options.session?.id ?? 'missing-session';
      queueMicrotask(() => {
        options.events?.onTurnStarted?.({
          sessionId,
          seq: 1,
          turnId: 'turn-1',
          deliveryKind: 'initial',
          timestamp: '2026-07-08T00:00:00.000Z',
        });
        options.events?.onTextDelta?.('hi', {
          sessionId,
          seq: 2,
          turnId: 'turn-1',
          timestamp: '2026-07-08T00:00:00.001Z',
        });
        options.events?.onToolUseStart?.(
          { id: 'tool-1', name: 'bash', input: { command: 'pwd' } },
          {
            sessionId,
            seq: 3,
            turnId: 'turn-1',
            toolId: 'tool-1',
            timestamp: '2026-07-08T00:00:00.002Z',
          },
        );
        options.events?.onToolResult?.(
          { id: 'tool-1', name: 'bash', content: 'ok' },
          {
            sessionId,
            seq: 4,
            turnId: 'turn-1',
            toolId: 'tool-1',
            timestamp: '2026-07-08T00:00:00.003Z',
          },
        );
      });
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId,
      }));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: { type: 'text', text: 'hello runtime' },
    });
    const result = await handle.result;
    const awaitedResult = await runtime.runs.await(handle.runId);
    const status = await runtime.runs.get(handle.runId);
    const replay = await runtime.events.replay({ runId: handle.runId });
    const assistantReplay = await runtime.events.replay({
      runId: handle.runId,
      type: 'assistant.delta',
    });

    expect(result.phase).toBe('completed');
    expect(awaitedResult).toEqual(result);
    expect(status.phase).toBe('completed');
    expect(status.turnId).toBe('turn-1');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'config.effective',
      'turn.started',
      'assistant.delta',
      'tool.started',
      'tool.finished',
      'run.completed',
    ]);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([handle.runId]));
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(events.every((event) => event.seq > 0 && event.time.includes('T'))).toBe(true);
    expect(replay.every((event) => event.sessionId === session.id)).toBe(true);
    expect(replay.every((event) => event.runId === handle.runId)).toBe(true);
    expect(replay.every((event) => event.id && event.time && event.seq > 0)).toBe(true);
    expect(replay.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(assistantReplay.map((event) => event.type)).toEqual(['assistant.delta']);

    await runtime.close();
  });

  it('emits one canonical post-commit compaction event with stable context ownership', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({
      title: 'Canonical Compact Event',
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        options.events?.onCompactedMessages?.(
          [{ role: 'user', content: 'checkpoint' }],
          {
            preCompactionMessages: [{
              role: 'user',
              content: `HOST_ONLY_HISTORY_${'x'.repeat(256_000)}`,
            }],
            anchor: {
              summary: `PRIVATE_SUMMARY_${'y'.repeat(256_000)}`,
              tokensBefore: 1_000,
              tokensAfter: 400,
              entriesRemoved: 3,
              reason: 'automatic_compaction',
            },
            postCompactAttachments: [{
              role: 'system',
              content: `PRIVATE_ATTACHMENT_${'z'.repeat(256_000)}`,
            }],
          },
        );
        options.events?.onCompactStats?.({
          tokensBefore: 1_000,
          tokensAfter: 400,
        });
        options.events?.onCompact?.(400);
        options.events?.onContextCompactionFinished?.({
          sessionId: session.id,
          seq: 4,
          turnId: 'turn-compact',
          contextId: session.id,
          contextKind: 'root',
          contextRevision: 1,
          source: 'automatic_threshold',
          tokensBefore: 1_000,
          tokensAfter: 400,
          committed: true,
          elapsedMs: 12,
          strategy: 'full_prefix',
        });
      });
      return fakeRunningSession(
        options,
        Promise.resolve({
          success: true,
          lastText: 'done',
          messages: [],
          sessionId: session.id,
        }),
      );
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'compact',
      options: { session: { persistedByHost: true } },
    });
    await handle.result;
    await flushMicrotasks();
    const events = await runtime.events.replay({
      runId: handle.runId,
      type: 'context.compaction.finished',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      contextId: session.id,
      contextKind: 'root',
      contextRevision: 1,
      beforeRevision: 0,
      afterRevision: 1,
      tokensBefore: 1_000,
      tokensAfter: 400,
      committed: true,
    });
    const messageEvents = await runtime.events.replay({
      runId: handle.runId,
      type: 'context.compaction.messages',
    });
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.payload).toMatchObject({
      messageCount: 1,
      update: {
        hasAnchor: true,
        tokensBefore: 1_000,
        tokensAfter: 400,
        entriesRemoved: 3,
        artifactLedgerEntryCount: 0,
        postCompactAttachmentCount: 1,
        exactSnapshotAvailable: true,
      },
    });
    const eventJson = JSON.stringify(messageEvents[0]);
    expect(eventJson).not.toContain('HOST_ONLY_HISTORY');
    expect(eventJson).not.toContain('PRIVATE_SUMMARY');
    expect(eventJson).not.toContain('PRIVATE_ATTACHMENT');
    expect(Buffer.byteLength(eventJson, 'utf8')).toBeLessThan(4_096);
    expect(codingMock.startKodaX.mock.calls[0]?.[0].session?.persistedByHost).toBe(false);
    await runtime.close();
  });

  it('emits one ordered canonical lifecycle for manual session compaction', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({
      title: 'Manual Compact Lifecycle',
    });
    const events: Array<{ readonly type: string; readonly payload: unknown }> = [];
    runtime.events.subscribe({ sessionId: session.id }, event => {
      if (event.type.startsWith('context.compaction.')) {
        events.push({ type: event.type, payload: event.payload });
      }
    });

    const result = await runtime.sessions.compact({
      sessionId: session.id,
      provider: 'mock-provider',
    });

    expect(result.compacted).toBe(false);
    expect(events.map(event => event.type)).toEqual([
      'context.compaction.started',
      'context.compaction.finished',
      'context.compaction.ended',
    ]);
    expect(events[0]?.payload).toMatchObject({
      meta: {
        contextId: session.id,
        contextKind: 'root',
        contextRevision: 0,
      },
    });
    expect(events[1]?.payload).toMatchObject({
      contextId: session.id,
      contextKind: 'root',
      contextRevision: 0,
      beforeRevision: 0,
      afterRevision: 0,
      source: 'manual',
      committed: false,
    });
    expect(events[2]?.payload).toMatchObject({
      meta: {
        contextId: session.id,
        contextKind: 'root',
        contextRevision: 0,
      },
    });
    await runtime.close();
  });

  it('keeps active live projection complete after durable event history is trimmed', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Live Projection Retention' });
    const chunk = 'x'.repeat(2 * 1024 * 1024);
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? session.id;
      options.events?.onToolUseStart?.(
        { id: 'long-tool', name: 'bash', input: { command: 'long-running' } },
        {
          sessionId,
          seq: 1,
          turnId: 'turn-live',
          toolId: 'long-tool',
          timestamp: '2026-07-09T00:00:00.000Z',
        },
      );
      for (let index = 0; index < 9; index += 1) {
        options.events?.onTextDelta?.(chunk, {
          sessionId,
          seq: index + 2,
          turnId: 'turn-live',
          timestamp: '2026-07-09T00:00:00.000Z',
        });
      }
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'large active run' });
    const observation = await runtime.sessions.observe(session.id, () => undefined);

    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({ runId: run.runId }),
    ]);
    expect(observation.snapshot.live.assistantTextByRun[run.runId]).toHaveLength(chunk.length * 9);
    observation.close();
    await runtime.close();
  });

  it('keeps child activity out of the primary live observation projection', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Child Activity Projection' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const rootMeta = {
        sessionId: session.id,
        turnId: 'turn-root',
        contextId: session.id,
        contextKind: 'root',
        contextRevision: 0,
      } as const;
      options.events?.onTextDelta?.('root answer', rootMeta);
      options.events?.onTextDelta?.(' root live-only update', { liveOnly: true });
      options.events?.onTextDelta?.('child answer', {
        sessionId: session.id,
        turnId: 'turn-child',
        contextId: 'child-context',
        contextKind: 'child',
        contextRevision: 0,
      });
      options.events?.onThinkingDelta?.('root reasoning', rootMeta);
      options.events?.onThinkingDelta?.('child reasoning', {
        childAgentId: 'child-agent',
      });
      options.events?.onToolUseStart?.({ id: 'root-tool', name: 'bash' }, rootMeta);
      options.events?.onToolUseStart?.(
        { id: 'child-tool', name: 'read' },
        { childAgentId: 'child-tool-agent', liveOnly: true },
      );
      options.events?.onTodoUpdate?.([], rootMeta);
      options.events?.onTodoUpdate?.([], {
        workflowCorrelation: { workflowRunId: 'workflow-child' },
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'project root only' });
    const observation = await runtime.sessions.observe(session.id, () => undefined);

    expect(observation.snapshot.live.assistantTextByRun).toEqual({
      [run.runId]: 'root answer root live-only update',
    });
    expect(observation.snapshot.live.thinkingTextByRun).toEqual({
      [run.runId]: 'root reasoning',
    });
    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({
        runId: run.runId,
        started: expect.objectContaining({
          tool: expect.objectContaining({ id: 'root-tool' }),
        }),
      }),
    ]);
    expect(observation.snapshot.live.todo).toEqual(
      expect.objectContaining({
        items: [],
        meta: expect.objectContaining({ contextKind: 'root' }),
      }),
    );
    observation.close();
    await runtime.close();
  });

  it('bounds observation transcripts and pages oversized entries explicitly', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const session = await runtime.sessions.create({
      title: 'Paged Transcript',
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: 'large-test',
      content: 'x'.repeat(9 * 1024 * 1024),
    });

    const observation = await runtime.sessions.observe(session.id, () => undefined);
    const slice = observation.snapshot.transcript;
    expect(Buffer.byteLength(JSON.stringify(slice), 'utf8')).toBeLessThan(1024 * 1024);
    expect(slice?.entries).toEqual([
      expect.objectContaining({
        index: 0,
        oversized: true,
        byteLength: expect.any(Number),
      }),
    ]);

    const recovered: Buffer[] = [];
    let cursor: string | undefined;
    do {
      const chunk = await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: slice!.revision,
        entryIndex: 0,
        ...(cursor ? { cursor } : {}),
      });
      expect(chunk?.encoding).toBe('base64-json');
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThan(512 * 1024);
      recovered.push(Buffer.from(chunk!.data, 'base64'));
      cursor = chunk!.hasMore ? chunk!.nextCursor : undefined;
    } while (cursor);
    const recoveredEntry = JSON.parse(Buffer.concat(recovered).toString('utf8')) as {
      message?: { content?: string };
    };
    expect(recoveredEntry.message?.content).toContain('x'.repeat(1024));
    expect(recoveredEntry.message?.content?.length).toBeGreaterThanOrEqual(9 * 1024 * 1024);

    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: 'revision-change',
      content: 'newer',
    });
    await expect(
      runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: slice!.revision,
        entryIndex: 0,
      }),
    ).rejects.toThrow(/revision changed/i);

    observation.close();
    await runtime.close();
  });

  it('searches exact compacted history through the Runtime session service', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { createSessionManager } = await import('@kodax-ai/repl');
    const sessionsDir = path.join(tempRoot, 'search-sessions');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    try {
      const session = await runtime.sessions.create({ title: 'Searchable transcript' });
      const manager = createSessionManager({ sessionsDir });
      const lineage = applySessionCompaction(
        createSessionLineage([
          { role: 'user', content: 'The exact historical code is ZX-4401.' },
          { role: 'assistant', content: 'ZX-4401 was verified before compaction.' },
        ]),
        [{ role: 'user', content: 'active follow-up' }],
        { summary: 'A historical code was verified.' },
      );
      await manager.storage.save(session.id, {
        messages: [{ role: 'user', content: 'active follow-up' }],
        title: 'Searchable transcript',
        gitRoot: tempRoot,
        lineage,
      });

      const result = await runtime.sessions.transcriptSearch({
        sessionId: session.id,
        query: 'ZX-4401',
      });
      expect(result?.revision).toMatch(/^sha256:/);
      expect(result?.hits[0]).toMatchObject({
        active: false,
        entryIndex: expect.any(Number),
        citation: expect.stringMatching(/^session-history:entry_/),
      });
      const exact = await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: result!.revision,
        entryIndex: result!.hits[0]!.entryIndex,
      });
      expect(Buffer.from(exact!.data, 'base64').toString('utf8')).toContain('ZX-4401');
    } finally {
      await runtime.close();
    }
  });

  it('keeps parallel active tools when another tool finishes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Parallel Tool Projection' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const meta = { sessionId: session.id, turnId: 'turn-tools' };
      options.events?.onToolUseStart?.({ id: 'tool-a', name: 'read' }, meta);
      options.events?.onToolUseStart?.({ id: 'tool-b', name: 'bash' }, meta);
      options.events?.onToolResult?.({ id: 'tool-a', name: 'read', content: 'done' }, meta);
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'parallel tools' });
    const observation = await runtime.sessions.observe(session.id, () => undefined);

    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({
        runId: run.runId,
        started: expect.objectContaining({
          tool: expect.objectContaining({ id: 'tool-b' }),
        }),
      }),
    ]);
    observation.close();
    await runtime.close();
  });

  it('flushes buffered streaming events before replay without dropping deltas', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Buffered Replay Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        options.events?.onTextDelta?.('buffered delta', {
          sessionId: session.id,
          turnId: 'turn-buffered',
        });
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'stream' });
    await flushMicrotasks();
    const replay = await runtime.events.replay({
      runId: run.runId,
      type: 'assistant.delta',
    });
    const eventLog = await fs.readFile(path.join(
      tempRoot,
      '.kodax',
      'runtime',
      'runs',
      encodeURIComponent(run.runId),
      'events.jsonl',
    ), 'utf-8');

    expect(replay).toEqual([
      expect.objectContaining({ type: 'assistant.delta' }),
    ]);
    expect(eventLog).toContain('buffered delta');
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it('forwards context diagnostics hooks into runtime event subscriptions', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Context Diagnostics Test' });
    const seen: string[] = [];
    const payloads: unknown[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (
        event.type === 'context.budget.snapshot'
        || event.type === 'tool.exposure.planned'
        || event.type === 'context.compaction.skipped'
      ) {
        seen.push(event.type);
        payloads.push(event.payload);
      }
    });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? 'missing-session';
      queueMicrotask(() => {
        options.events?.onContextBudgetSnapshot?.({
          sessionId,
          turnId: 'turn-diagnostics',
          seq: 1,
          timestamp: '2026-07-08T00:00:00.000Z',
          profile: 'report_only',
          contextWindow: 32_000,
          smallWindow: true,
          pressure: 'low',
          tokenBreakdown: {
            systemPrompt: 1,
            toolSchemas: 2,
            skillCatalog: 0,
            mcpCatalog: 0,
            transcript: 3,
            pendingInput: 0,
            recentToolResults: 0,
            reservedResponse: 0,
            total: 6,
          },
          usedTokens: 6,
          availableTokens: 31_994,
          usedRatio: 0.0002,
          toolSchemaRatio: 0.0001,
          recommendations: [],
          createdAt: '2026-07-08T00:00:00.000Z',
        });
        options.events?.onToolExposurePlanned?.({
          sessionId,
          turnId: 'turn-diagnostics',
          seq: 2,
          timestamp: '2026-07-08T00:00:00.001Z',
          profile: 'report_only',
          reportOnly: true,
          pressure: 'low',
          bridgeAvailable: false,
          nativeDeferredAvailable: true,
          decisions: [],
          modelVisibleToolNames: ['read', 'tool_search'],
          estimatedToolSchemaTokensBefore: 10,
          estimatedToolSchemaTokensAfter: 8,
          estimatedToolSchemaTokensIfApplied: 8,
          estimatedTokensSaved: 2,
          estimatedTokensSavedIfApplied: 2,
          residentToolCount: 2,
          hintedToolCount: 0,
          bridgeToolCount: 0,
          nativeDeferredToolCount: 0,
          hiddenToolCount: 0,
        });
        options.events?.onContextCompactionSkipped?.({
          sessionId,
          turnId: 'turn-diagnostics',
          seq: 3,
          timestamp: '2026-07-08T00:00:00.002Z',
          reason: 'low_savings_cooldown',
          currentTokens: 18_000,
          contextWindow: 32_000,
          triggerPercent: 75,
          cooldownTurnsRemaining: 1,
          lowSavingsStreak: 0,
        });
      });
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'diagnostics forwarded',
        messages: [],
        sessionId,
      }));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'diagnostics',
      options: {
        context: { contextDiagnostics: true },
      },
    });
    await handle.result;
    await flushMicrotasks();
    const replay = await runtime.events.replay({ runId: handle.runId });
    const latestBudget = await runtime.diagnostics.latestContextBudget({ runId: handle.runId });
    const latestExposure = await runtime.diagnostics.latestToolExposure({ runId: handle.runId });

    expect(seen).toEqual([
      'context.budget.snapshot',
      'tool.exposure.planned',
      'context.compaction.skipped',
    ]);
    expect(payloads[0]).toMatchObject({ pressure: 'low', usedTokens: 6 });
    expect(payloads[1]).toMatchObject({ reportOnly: true, modelVisibleToolNames: ['read', 'tool_search'] });
    expect(payloads[2]).toMatchObject({ reason: 'low_savings_cooldown', cooldownTurnsRemaining: 1 });
    expect(replay.map((event) => event.type)).toContain('context.budget.snapshot');
    expect(replay.map((event) => event.type)).toContain('tool.exposure.planned');
    expect(replay.map((event) => event.type)).toContain('context.compaction.skipped');
    expect(latestBudget).toMatchObject({ pressure: 'low', usedTokens: 6 });
    expect(latestExposure).toMatchObject({ reportOnly: true, modelVisibleToolNames: ['read', 'tool_search'] });

    await runtime.close();
  });

  it('serializes runs within one session while allowing queued status to be observed', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Queue Test' });
    const starts: string[] = [];
    const queuedEvents: string[] = [];
    const persistedAtPublication: Array<{
      readonly event: string;
      readonly phase: string;
    }> = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;

    runtime.events.subscribe({ type: 'run.queued' }, (event) => queuedEvents.push(event.runId));
    runtime.events.subscribe({
      type: ['run.started', 'run.queued', 'run.completed'],
    }, (event) => {
      const persisted: { readonly phase: string } = JSON.parse(readFileSync(path.join(
        tempRoot,
        '.kodax',
        'runtime',
        'runs',
        encodeURIComponent(event.runId),
        'status.json',
      ), 'utf-8')) as { readonly phase: string };
      persistedAtPublication.push({ event: event.type, phase: persisted.phase });
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      const sessionId = options.session?.id ?? session.id;
      starts.push(prompt);
      if (prompt === 'first') {
        return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
          finishFirst = resolve;
        }));
      }
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishSecond = resolve;
      }));
    });

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const second = await runtime.runs.start({ sessionId: session.id, prompt: 'second' });

    expect(starts).toEqual(['first']);
    expect((await runtime.runs.get(first.runId)).phase).toBe('running');
    expect((await runtime.runs.get(second.runId)).phase).toBe('queued');
    expect(queuedEvents).toEqual([second.runId]);

    finishFirst?.({
      success: true,
      lastText: 'first done',
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();

    expect(starts).toEqual(['first', 'second']);
    expect((await runtime.runs.get(second.runId)).phase).toBe('running');

    finishSecond?.({
      success: true,
      lastText: 'second done',
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: 'completed' });
    expect(persistedAtPublication).toEqual([
      { event: 'run.started', phase: 'running' },
      { event: 'run.queued', phase: 'queued' },
      { event: 'run.completed', phase: 'completed' },
      { event: 'run.started', phase: 'running' },
      { event: 'run.completed', phase: 'completed' },
    ]);

    await runtime.close();
  });

  it('preserves same-session start arrival order when session loading completes out of order', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Concurrent Queue Test' });
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoadBlocked = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    replMock.beforeLoadSession = async (call) => {
      if (call === 1) await firstLoadBlocked;
    };
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => fakeRunningSession(
      options,
      new Promise<KodaXResult>(() => undefined),
    ));

    const firstStart = runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const secondStart = runtime.runs.start({ sessionId: session.id, prompt: 'second' });
    await vi.waitFor(() => expect(replMock.loadSessionCalls).toBe(1));
    releaseFirstLoad?.();
    const [first, second] = await Promise.all([firstStart, secondStart]);

    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      phase: 'running',
      sessionOrder: 1,
    });
    await expect(runtime.runs.get(second.runId)).resolves.toMatchObject({
      phase: 'queued',
      sessionOrder: 2,
    });
    await runtime.close();
  });

  it('creates ordered after-turn continuation runs and rejects stale delivery', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Continuation Test' });
    const starts: string[] = [];
    const finishers: Array<(value: KodaXResult) => void> = [];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      starts.push(prompt);
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishers.push(resolve);
      }));
    });

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const continuation = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'after_turn',
      input: { type: 'text', text: 'second' },
    });
    expect(continuation).toMatchObject({
      accepted: true,
      delivery: 'after_turn',
      afterRunId: first.runId,
      sessionOrder: 2,
    });
    expect(starts).toEqual(['first']);
    if (!continuation.accepted || continuation.delivery !== 'after_turn') {
      throw new Error('Expected accepted continuation');
    }
    await expect(runtime.runs.get(continuation.runId)).resolves.toMatchObject({
      phase: 'queued',
      continuation: {
        inputId: continuation.runId,
        afterRunId: first.runId,
        delivery: 'after_turn',
        state: 'queued',
        contentPreview: 'second',
      },
    });
    const observation = await runtime.sessions.observe(session.id, () => undefined);
    expect(observation.snapshot.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: continuation.runId,
        continuation: expect.objectContaining({ inputId: continuation.runId }),
      }),
    ]));
    observation.close();

    finishers[0]?.({ success: true, lastText: 'done', messages: [], sessionId: session.id });
    await first.result;
    await flushMicrotasks();
    expect(starts).toEqual(['first', 'second']);
    finishers[1]?.({ success: true, lastText: 'continued', messages: [], sessionId: session.id });
    await runtime.runs.await(continuation.runId);

    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'after_turn',
      input: { type: 'text', text: 'too late' },
    })).resolves.toMatchObject({ accepted: false, reason: 'stale_run' });
    await runtime.close();
  });

  it('rejects interrupt input after a managed task closes its final safe-boundary window', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Managed Interrupt Window Test' });
    let activeEvents: KodaXOptions['events'];
    let finishManaged: ((value: KodaXResult) => void) | undefined;
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return new Promise<KodaXResult>((resolve) => {
        finishManaged = resolve;
      });
    });

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'managed',
      mode: 'managed_task',
    });
    activeEvents?.onManagedTaskStatus?.({
      agentMode: 'ama',
      harnessProfile: 'H0_DIRECT',
      currentRound: 1,
      maxRounds: 1,
      upgradeCeiling: 'H0_DIRECT',
      phase: 'completed',
      note: 'Task completed',
      persistToHistory: true,
    });

    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'arrived during finalization' },
    })).resolves.toEqual({
      accepted: false,
      delivery: 'interrupt',
      sessionId: session.id,
      afterRunId: run.runId,
      reason: 'interrupt_window_closed',
    });
    expect(getMessageQueue().size()).toBe(0);
    await expect(runtime.events.replay({
      runId: run.runId,
      type: 'run.input.queued',
    })).resolves.toEqual([]);

    finishManaged?.({
      success: true,
      lastText: 'done',
      messages: [],
      sessionId: session.id,
    });
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    await runtime.close();
  });

  it('rejects interrupt input after an ordinary coding run reports completion', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Coding Interrupt Window Test' });
    let activeEvents: KodaXOptions['events'];
    let finishCoding: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      activeEvents = options.events;
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishCoding = resolve;
      }));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'coding' });
    activeEvents?.onComplete?.();

    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'arrived after completion callback' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'interrupt_window_closed',
    });
    expect(getMessageQueue().size()).toBe(0);

    finishCoding?.({
      success: true,
      lastText: 'done',
      messages: [],
      sessionId: session.id,
    });
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    await runtime.close();
  });

  it('rejects interrupt input after a coding run reports its terminal error', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Failed Interrupt Window Test' });
    let activeEvents: KodaXOptions['events'];
    let failCoding: ((error: Error) => void) | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      activeEvents = options.events;
      return fakeRunningSession(options, new Promise<KodaXResult>((_resolve, reject) => {
        failCoding = reject;
      }));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'coding' });
    activeEvents?.onError?.(new Error('provider failed'));

    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'arrived after terminal error' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'interrupt_window_closed',
    });
    expect(getMessageQueue().size()).toBe(0);

    failCoding?.(new Error('provider failed'));
    await expect(run.result).resolves.toMatchObject({ phase: 'failed' });
    await runtime.close();
  });

  it.each([
    ['coding', undefined],
    ['managed task', 'managed_task'],
  ] as const)(
    'rejects interrupt input immediately after an external abort closes a %s run',
    async (_label, mode) => {
      const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, 'sessions'),
        defaultProvider: 'mock-provider',
      });
      const session = await runtime.sessions.create({ title: 'External Abort Interrupt Window' });
      const abortController = new AbortController();
      const neverSettles = new Promise<KodaXResult>(() => undefined);
      codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
        fakeRunningSession(options, neverSettles)
      ));
      codingMock.runManagedTask.mockImplementation(() => neverSettles);

      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: 'wait for external abort',
        ...(mode !== undefined ? { mode } : {}),
        options: { abortSignal: abortController.signal },
      });

      try {
        abortController.abort(new Error('host cancelled'));
        await expect(runtime.runs.submitInput({
          sessionId: session.id,
          afterRunId: run.runId,
          delivery: 'interrupt',
          input: { type: 'text', text: 'arrived after external abort' },
        })).resolves.toMatchObject({
          accepted: false,
          reason: 'interrupt_window_closed',
        });
        expect(getMessageQueue().size()).toBe(0);
      } finally {
        await runtime.runs.abort(run.runId);
        await expectSettles(run.result, 'external abort run result');
        await runtime.close();
      }
    },
  );

  it.each([
    ['coding', undefined],
    ['managed task', 'managed_task'],
  ] as const)(
    'releases the external abort listener when Runtime aborts a %s run',
    async (_label, mode) => {
      const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, 'sessions'),
        defaultProvider: 'mock-provider',
      });
      const session = await runtime.sessions.create({ title: 'Abort Listener Cleanup' });
      const abortController = new AbortController();
      const removeAbortListener = vi.spyOn(
        abortController.signal,
        'removeEventListener',
      );
      const neverSettles = new Promise<KodaXResult>(() => undefined);
      codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
        fakeRunningSession(options, neverSettles)
      ));
      codingMock.runManagedTask.mockImplementation(() => neverSettles);

      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: 'wait for Runtime abort',
        ...(mode !== undefined ? { mode } : {}),
        options: { abortSignal: abortController.signal },
      });

      await runtime.runs.abort(run.runId);
      await expect(run.result).resolves.toMatchObject({ phase: 'cancelled' });
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
      await runtime.close();
    },
  );

  it('queues active-run interrupts and reports their FIFO delivery as one batch', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Interrupt Test' });
    const starts: string[] = [];
    let activeEvents: KodaXOptions['events'];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string) => {
      starts.push(prompt);
      activeEvents = options.events;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    await vi.waitFor(() => expect(starts).toEqual(['first']));
    expect(runtime.capabilities).toMatchObject({
      interruptInput: { version: 1, availability: 'per_run' },
    });

    const firstInterrupt = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'urgent one' },
    });
    const secondInterrupt = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'urgent two' },
    });

    expect(firstInterrupt).toMatchObject({
      accepted: true,
      delivery: 'interrupt',
      runId: first.runId,
      sessionId: session.id,
      afterRunId: first.runId,
    });
    expect(secondInterrupt).toMatchObject({
      accepted: true,
      delivery: 'interrupt',
      runId: first.runId,
      sessionId: session.id,
      afterRunId: first.runId,
    });
    expect(starts).toEqual(['first']);

    const queueAgentId = actorQueueId(session.id, '/root');
    const queued = getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    });
    expect(queued.map((message) => message.content)).toEqual(['urgent one', 'urgent two']);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ delivery: 'interrupt', state: 'queued' }),
        expect.objectContaining({ delivery: 'interrupt', state: 'queued' }),
      ],
    });
    const observation = await runtime.sessions.observe(session.id, () => undefined);
    expect(observation.snapshot.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: first.runId,
        interruptInputs: [
          expect.objectContaining({ state: 'queued' }),
          expect.objectContaining({ state: 'queued' }),
        ],
      }),
    ]));
    observation.close();

    const drained = getMessageQueue().dequeue({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    });
    activeEvents?.onMidTurnUserMessages?.(
      drained.map((message) => message.content),
      { queuedMessageIds: drained.map((message) => message.id) },
    );
    await flushMicrotasks();

    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ state: 'delivered' }),
        expect.objectContaining({ state: 'delivered' }),
      ],
    });
    const replay = await runtime.events.replay({ runId: first.runId });
    expect(replay.filter((event) => event.type === 'run.input.queued')).toHaveLength(2);
    expect(replay.filter((event) => event.type === 'run.input.delivered')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          inputs: [
            expect.objectContaining({ input: { type: 'text', text: 'urgent one' } }),
            expect.objectContaining({ input: { type: 'text', text: 'urgent two' } }),
          ],
        }),
      }),
    ]);
    expect(starts).toEqual(['first']);

    await runtime.runs.abort(first.runId);
    await expectSettles(first.result, 'interrupt run abort result');
    await runtime.close();
  });

  it('labels rejected submitted input without mutating its run or queue', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Invalid Interrupt Input Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const queueSizeBefore = getMessageQueue().size();

    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'prompt',
      input: { type: 'text', text: 'text item' },
    })).rejects.toThrow('runtime.runs.start accepts either prompt or text input, not both');
    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    })).rejects.toThrow('runtime.runs.submitInput accepts at most one text input item');
    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: [],
    })).rejects.toThrow('runtime.runs.submitInput requires prompt or text input');
    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'after_turn',
      input: [],
    })).rejects.toThrow('runtime.runs.submitInput requires prompt or text input');

    const status = await runtime.runs.get(run.runId);
    expect(status.interruptInputs).toBeUndefined();
    await expect(runtime.runs.list({ sessionId: session.id })).resolves.toHaveLength(1);
    expect(getMessageQueue().size()).toBe(queueSizeBefore);
    await runtime.runs.abort(run.runId);
    await expectSettles(run.result, 'invalid interrupt input abort result');
    await runtime.close();
  });

  it('marks only the exact interrupt batch consumed at a safe boundary', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Interrupt Race Test' });
    let activeEvents: KodaXOptions['events'];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'consumed now' },
    });
    const queueAgentId = actorQueueId(session.id, '/root');
    const consumed = getMessageQueue().dequeue({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
      limit: 1,
    });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'arrived during boundary work' },
    });

    activeEvents?.onMidTurnUserMessages?.(
      consumed.map((message) => message.content),
      { queuedMessageIds: consumed.map((message) => message.id) },
    );

    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ state: 'delivered' }),
        expect.objectContaining({ state: 'queued' }),
      ],
    });
    const deliveryEvents = await runtime.events.replay({
      runId: run.runId,
      type: 'run.input.delivered',
    });
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]?.payload).toMatchObject({
      inputs: [expect.objectContaining({
        input: { type: 'text', text: 'consumed now' },
      })],
    });

    await runtime.runs.abort(run.runId);
    await expectSettles(run.result, 'interrupt race abort result');
    expect(getMessageQueue().size()).toBe(0);
    await runtime.close();
  });

  it('does not publish delivered state when the durable batch event cannot be written', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Interrupt Persistence Failure Test' });
    let activeEvents: KodaXOptions['events'];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'must remain unconfirmed' },
    });
    const consumed = getMessageQueue().dequeue({
      agentId: actorQueueId(session.id, '/root'),
      maxPriority: 'user',
      mode: 'prompt',
    });
    const eventsFile = path.join(
      tempRoot,
      '.kodax',
      'runtime',
      'runs',
      encodeURIComponent(run.runId),
      'events.jsonl',
    );
    const eventsBackup = `${eventsFile}.bak`;
    await fs.rename(eventsFile, eventsBackup);
    await fs.mkdir(eventsFile);

    let deliveryError: unknown;
    try {
      activeEvents?.onMidTurnUserMessages?.(
        consumed.map((message) => message.content),
        { queuedMessageIds: consumed.map((message) => message.id) },
      );
    } catch (error: unknown) {
      deliveryError = error;
    } finally {
      await fs.rm(eventsFile, { recursive: true, force: true });
      await fs.rename(eventsBackup, eventsFile);
    }

    expect(deliveryError).toBeInstanceOf(Error);
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      interruptInputs: [expect.objectContaining({ state: 'queued' })],
    });
    await expect(runtime.events.replay({
      runId: run.runId,
      type: 'run.input.delivered',
    })).resolves.toEqual([]);
    const warnings = await runtime.events.replay({
      runId: run.runId,
      type: 'runtime.warning',
    });
    expect(warnings.some((event) => (
      (event.payload as Record<string, unknown>).source === 'run.input.delivered'
    ))).toBe(true);

    await runtime.runs.abort(run.runId);
    await expectSettles(run.result, 'interrupt persistence failure abort result');
    await runtime.close();
  });

  it('rejects interrupt delivery when the active run has no safe Actor boundary', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'SA Interrupt Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'first',
      options: { agentMode: 'sa' },
    });
    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'unsupported here' },
    })).resolves.toEqual({
      accepted: false,
      delivery: 'interrupt',
      sessionId: session.id,
      afterRunId: first.runId,
      reason: 'unsupported_capability',
    });
    expect(getMessageQueue().size()).toBe(0);

    await runtime.runs.abort(first.runId);
    await expectSettles(first.result, 'SA interrupt run abort result');
    await runtime.close();
  });

  it('does not leave queued input behind when interrupt cloning fails', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Interrupt Clone Failure Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const malformed = {
      type: 'text',
      text: 'must not be queued',
      nonCloneable: () => undefined,
    } as unknown as RuntimeInput;

    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: 'interrupt',
      input: malformed,
    })).rejects.toThrow();
    expect(getMessageQueue().size()).toBe(0);
    const status = await runtime.runs.get(run.runId);
    expect(status.interruptInputs).toBeUndefined();

    await runtime.runs.abort(run.runId);
    await expectSettles(run.result, 'interrupt clone failure abort result');
    await runtime.close();
  });

  it('terminalizes and removes an interrupt that the active run never consumes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Interrupt Cleanup Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const submitted = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'never delivered' },
    });
    expect(submitted).toMatchObject({ accepted: true, delivery: 'interrupt' });
    expect(getMessageQueue().size()).toBe(1);

    await runtime.runs.abort(first.runId);
    await expectSettles(first.result, 'undelivered interrupt abort result');

    expect(getMessageQueue().size()).toBe(0);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      phase: 'cancelled',
      interruptInputs: [expect.objectContaining({ state: 'terminal' })],
    });
    await expect(runtime.events.replay({
      runId: first.runId,
      type: 'run.input.delivered',
    })).resolves.toEqual([]);
    await expect(runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'too late' },
    })).resolves.toMatchObject({ accepted: false, reason: 'stale_run' });
    await runtime.close();
  });

  it('fails closed when a run-scoped credential is bound to another provider', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Credential Scope' });
    const trustedInput = {
      sessionId: session.id,
      prompt: 'must not run',
      providerCredential: 'leased-secret',
      providerCredentialProvider: 'another-provider',
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    await expect(runtime.runs.start(trustedInput)).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('never persists a provider error that may echo a run-scoped credential', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const secret = 'F269_PROVIDER_ERROR_SECRET';
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Credential Error Redaction' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      options.events?.onRetry?.(`provider echoed ${secret}`, 1, 1);
      options.events?.onError?.(new Error(`provider emitted ${secret}`));
      return fakeRunningSession(
        options,
        Promise.reject(new Error(`provider rejected ${secret}`)),
      );
    });
    const trustedInput = {
      sessionId: session.id,
      prompt: 'fail safely',
      providerCredential: secret,
      providerCredentialProvider: 'mock-provider',
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    const handle = await runtime.runs.start(trustedInput);
    await expect(handle.result).resolves.toMatchObject({
      phase: 'failed',
      error: { message: 'Provider run failed while using a run-scoped credential.' },
    });
    expect(JSON.stringify(await runtime.runs.get(handle.runId))).not.toContain(secret);
    expect(JSON.stringify(await runtime.events.replay({ runId: handle.runId }))).not.toContain(secret);
    await runtime.close();
    expect(await readDirectoryText(tempRoot)).not.toContain(secret);
  });

  it('keeps queued runs on the session settings snapshot captured at queue time', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const session = await runtime.sessions.create({
      title: 'Queued Settings Snapshot',
    });
    await runtime.sessions.updateSettings(session.id, {
      provider: 'settings-provider-a',
      model: 'settings-model-a',
    });

    const starts: Array<{
      readonly prompt: string;
      readonly provider?: string;
      readonly model?: string;
    }> = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      starts.push({
        prompt,
        provider: options.provider,
        model: options.modelOverride,
      });
      if (prompt === 'first') {
        return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
          finishFirst = resolve;
        }));
      }
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishSecond = resolve;
      }));
    });

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const second = await runtime.runs.start({ sessionId: session.id, prompt: 'second' });
    await runtime.sessions.updateSettings(session.id, {
      provider: 'settings-provider-b',
      model: 'settings-model-b',
    });

    expect((await runtime.runs.get(second.runId)).phase).toBe('queued');
    expect(starts).toEqual([{
      prompt: 'first',
      provider: 'settings-provider-a',
      model: 'settings-model-a',
    }]);

    finishFirst?.({
      success: true,
      lastText: 'first done',
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();

    expect(starts).toEqual([
      {
        prompt: 'first',
        provider: 'settings-provider-a',
        model: 'settings-model-a',
      },
      {
        prompt: 'second',
        provider: 'settings-provider-a',
        model: 'settings-model-a',
      },
    ]);

    finishSecond?.({
      success: true,
      lastText: 'second done',
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: 'completed' });

    await runtime.close();
  });

  it('allows different sessions to run concurrently without cross-queueing', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const firstSession = await runtime.sessions.create({ title: 'Concurrent A' });
    const secondSession = await runtime.sessions.create({ title: 'Concurrent B' });
    const starts: string[] = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      starts.push(`${options.session?.id ?? 'missing'}:${prompt}`);
      if (prompt === 'first-session') {
        return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
          finishFirst = resolve;
        }));
      }
      return fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishSecond = resolve;
      }));
    });

    const first = await runtime.runs.start({ sessionId: firstSession.id, prompt: 'first-session' });
    const second = await runtime.runs.start({ sessionId: secondSession.id, prompt: 'second-session' });

    expect(starts).toEqual([
      `${firstSession.id}:first-session`,
      `${secondSession.id}:second-session`,
    ]);
    expect((await runtime.runs.get(first.runId)).phase).toBe('running');
    expect((await runtime.runs.get(second.runId)).phase).toBe('running');
    await expect(runtime.events.replay({ type: 'run.queued' })).resolves.toEqual([]);

    finishFirst?.({
      success: true,
      lastText: 'first done',
      messages: [],
      sessionId: firstSession.id,
    });
    finishSecond?.({
      success: true,
      lastText: 'second done',
      messages: [],
      sessionId: secondSession.id,
    });

    await expect(first.result).resolves.toMatchObject({
      phase: 'completed',
      sessionId: firstSession.id,
    });
    await expect(second.result).resolves.toMatchObject({
      phase: 'completed',
      sessionId: secondSession.id,
    });

    await runtime.close();
  });

  it('persists runtime replay and terminal run status across runtime recreation', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Persistence Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? session.id;
      queueMicrotask(() => {
        options.events?.onTextDelta?.('persist me', {
          sessionId,
          seq: 1,
          timestamp: new Date().toISOString(),
        });
      });
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'persisted',
        messages: [],
        sessionId,
      }));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'persist' });
    await handle.result;
    const snapshot = await runtime.status.snapshot();
    expect(snapshot.runs).toContainEqual(expect.objectContaining({
      runId: handle.runId,
      phase: 'completed',
    }));
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: 'mock-provider',
    });
    const replay = await recreated.events.replay({ runId: handle.runId });
    const restoredStatus = await recreated.runs.get(handle.runId);

    expect(replay.map((event) => event.type)).toEqual([
      'run.started',
      'config.effective',
      'assistant.delta',
      'run.completed',
    ]);
    expect(restoredStatus).toMatchObject({
      runId: handle.runId,
      sessionId: session.id,
      phase: 'completed',
    });

    await recreated.close();
  });

  it('keeps event sequences monotonic across runtime recreation and honors sinceSeq', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const first = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const firstSession = await first.sessions.create({ sessionId: 'sequence-first' });
    const firstEvents = await first.events.replay({ sessionId: firstSession.id });
    const lastFirstSeq = firstEvents.at(-1)?.seq;
    expect(lastFirstSeq).toBeDefined();
    await first.close();

    const second = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const secondSession = await second.sessions.create({ sessionId: 'sequence-second' });
    const allEvents = await second.events.replay();
    const afterFirst = await second.events.replay({ sinceSeq: lastFirstSeq });

    expect(allEvents.map((event) => event.seq)).toEqual(
      [...allEvents.map((event) => event.seq)].sort((a, b) => a - b),
    );
    expect(new Set(allEvents.map((event) => event.seq)).size).toBe(allEvents.length);
    expect(afterFirst).toEqual([
      expect.objectContaining({
        sessionId: secondSession.id,
        type: 'session.created',
      }),
    ]);
    expect(afterFirst[0]?.seq).toBeGreaterThan(lastFirstSeq!);
    await second.close();
  });

  it('caps in-memory terminal run records while keeping persisted run lookup available', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Run Retention Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => (
      fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: prompt,
        messages: [],
        sessionId: session.id,
      }))
    ));

    let firstRunId = '';
    for (let i = 0; i < 1_005; i += 1) {
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: `retained-${i}`,
      });
      if (i === 0) firstRunId = handle.runId;
      await handle.result;
    }

    const snapshot = await runtime.status.snapshot();
    expect(snapshot.runs.length).toBeLessThanOrEqual(1_000);
    expect(snapshot.runs.some((run) => run.runId === firstRunId)).toBe(false);
    await expect(runtime.runs.get(firstRunId)).resolves.toMatchObject({
      runId: firstRunId,
      phase: 'completed',
    });

    await runtime.close();
  }, 30_000);

  it('rejects runs for missing sessions before calling the coding layer', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });

    await expect(runtime.runs.start({
      sessionId: 'missing-session',
      prompt: 'should not start',
    })).rejects.toThrow('Session not found: missing-session');
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

    await runtime.close();
  });

  it('keeps an aborted run cancelled even if the coding promise later resolves', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Abort Race Test' });
    let finishRun: ((value: KodaXResult) => void) | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>((resolve) => {
        finishRun = resolve;
      }))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'abort me' });
    await runtime.runs.abort(handle.runId);
    finishRun?.({
      success: true,
      lastText: 'late success',
      messages: [],
      sessionId: session.id,
    });

    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const terminalEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ['run.completed', 'run.cancelled'],
    });

    expect(result.phase).toBe('cancelled');
    expect(status.phase).toBe('cancelled');
    expect(terminalEvents.map((event) => event.type)).toEqual(['run.cancelled']);

    await runtime.close();
  });

  it('resolves an active run result when aborting even if the coding promise never settles', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Abort Settle Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'abort me' });
    await runtime.runs.abort(handle.runId);

    const result = await expectSettles(handle.result, 'aborted run result');
    expect(result.phase).toBe('cancelled');
    expect((await runtime.runs.get(handle.runId)).phase).toBe('cancelled');

    await runtime.close();
  });

  it('resolves running and queued run results when the runtime closes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Close Settle Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const first = await runtime.runs.start({ sessionId: session.id, prompt: 'first' });
    const second = await runtime.runs.start({ sessionId: session.id, prompt: 'second' });
    expect((await runtime.runs.get(second.runId)).phase).toBe('queued');

    await runtime.close();

    await expect(expectSettles(first.result, 'closed running run result')).resolves.toMatchObject({
      phase: 'cancelled',
    });
    await expect(expectSettles(second.result, 'closed queued run result')).resolves.toMatchObject({
      phase: 'cancelled',
    });
  });

  it('routes legacy media follow-up helpers to the active SDK Actor session', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Queue Route Test' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'stay active',
    });
    enqueueWithArtifacts({
      provider: 'mock-provider',
      content: 'queued follow-up',
    });

    const queueAgentId = actorQueueId(session.id, '/root');
    expect(resolveActiveRootQueueRoute()).toBe(queueAgentId);
    expect(getMessageQueue().dequeue({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);

    await runtime.runs.abort(handle.runId);
    await expectSettles(handle.result, 'queue route abort result');
    expect(resolveActiveRootQueueRoute()).toBeUndefined();
    await runtime.close();
  });

  it.each([
    ['coding', undefined],
    ['managed task', 'managed_task'],
  ] as const)(
    'terminalizes a %s run when SDK launch throws synchronously',
    async (_label, mode) => {
      const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
      const runtime = await createKodaXRuntime({
        sessionsDir: tempRoot,
        defaultProvider: 'mock-provider',
      });
      const session = await runtime.sessions.create({ title: 'Queue Route Launch Failure' });
      const throwLaunchError = (): never => {
        throw new Error('synchronous launch failure');
      };
      codingMock.startKodaX.mockImplementation(throwLaunchError);
      codingMock.runManagedTask.mockImplementation(throwLaunchError);

      await expect(runtime.runs.start({
        sessionId: session.id,
        prompt: 'fail before launch',
        ...(mode !== undefined ? { mode } : {}),
      })).rejects.toThrow('synchronous launch failure');

      const [failedRun] = await runtime.runs.list({ sessionId: session.id });
      expect(failedRun).toMatchObject({
        phase: 'failed',
        error: 'synchronous launch failure',
      });
      await expect(runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: failedRun!.runId,
        delivery: 'interrupt',
        input: { type: 'text', text: 'must not enter failed run' },
      })).resolves.toMatchObject({ accepted: false, reason: 'stale_run' });
      expect(resolveActiveRootQueueRoute()).toBeUndefined();

      await runtime.close();
    },
  );

  it('rejects pending permissions when aborting a run', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Abort Permission Test' });
    let approvalDone: Promise<boolean | string> | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-abort-permission',
            toolId: 'tool-abort-permission',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'needs permission' });
    await flushMicrotasks();

    expect(await runtime.permissions.listPending({ runId: handle.runId })).toHaveLength(1);
    await runtime.runs.abort(handle.runId);

    expect(approvalDone).toBeDefined();
    await expect(expectSettles(approvalDone!, 'aborted permission')).resolves.toBe('runtime run aborted');
    await expect(expectSettles(handle.result, 'aborted permission run result')).resolves.toMatchObject({
      phase: 'cancelled',
    });
    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);

    await runtime.close();
  });

  it('expires runtime permission requests using expiresAt', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      permissionTimeoutMs: 60_000,
    });

    const decision = runtime.permissions.request({
      sessionId: 'permission-expiry-session',
      runId: 'permission-expiry-run',
      toolName: 'bash',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(expectSettles(decision, 'expired permission decision')).resolves.toEqual({
      type: 'reject',
      reason: 'permission request timed out',
    });
    await expect(runtime.permissions.listPending({
      runId: 'permission-expiry-run',
    })).resolves.toEqual([]);

    await runtime.close();
  });

  it('runs managed_task mode through runManagedTask and settles on abort', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Managed Task Test' });
    let signal: AbortSignal | undefined;

    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      signal = options.abortSignal;
      options.events?.onManagedTaskStatus?.({
        agentMode: 'ama',
        harnessProfile: 'standard' as never,
        phase: 'worker',
        activeWorkerId: 'worker-1',
        activeWorkerTitle: 'Implementing',
        currentRound: 2,
        maxRounds: 4,
      });
      return new Promise<KodaXResult>(() => undefined);
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'managed',
      mode: 'managed_task',
    });
    expect(codingMock.runManagedTask).toHaveBeenCalledOnce();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    const observation = await runtime.sessions.observe(session.id, () => undefined);
    expect(observation.snapshot.live.managedTasks).toEqual([
      expect.objectContaining({
        runId: handle.runId,
        status: expect.objectContaining({
          phase: 'worker',
          activeWorkerId: 'worker-1',
          currentRound: 2,
        }),
      }),
    ]);
    observation.close();

    await runtime.runs.abort(handle.runId);

    expect(signal?.aborted).toBe(true);
    await expect(expectSettles(handle.result, 'managed task abort result')).resolves.toMatchObject({
      phase: 'cancelled',
    });

    await runtime.close();
  });

  it('reports failed run status when the coding layer rejects', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Failure Test' });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, Promise.reject(new Error('provider exploded')))
    ));

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'fail' });
    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const failedEvents = await runtime.events.replay({
      runId: handle.runId,
      type: 'run.failed',
    });

    expect(result.phase).toBe('failed');
    expect(result.error?.message).toBe('provider exploded');
    expect(status).toMatchObject({ phase: 'failed', error: 'provider exploded' });
    expect(failedEvents).toHaveLength(1);

    await runtime.close();
  });

  it('applies permissionMode policy and skips bridge meta-tool prompts', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Policy Test' });
    const decisions = new Map<string, boolean | string>();
    const requestedTools: string[] = [];
    const toolByPrompt: Readonly<Record<string, { readonly name: string; readonly input: Record<string, unknown> }>> = {
      'accept-edit': { name: 'edit', input: { path: 'file.ts', old_string: 'a', new_string: 'b' } },
      'runtime-write': { name: 'write', input: { path: 'runtime.txt', content: 'runtime' } },
      'client-write': { name: 'write', input: { path: 'client.txt', content: 'client' } },
      'protected-write': { name: 'write', input: { path: '.kodax/config.json', content: '{}' } },
      'accept-bash': { name: 'bash', input: { command: 'npm test' } },
      'plan-edit': { name: 'edit', input: { path: 'file.ts', old_string: 'a', new_string: 'b' } },
      bridge: { name: 'tool_call', input: { name: 'edit', arguments: { path: 'file.ts' } } },
    };
    runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
      const request = event.payload as { readonly id?: unknown; readonly toolName?: unknown };
      if (typeof request.toolName === 'string') requestedTools.push(request.toolName);
      if (typeof request.id === 'string') {
        void runtime.permissions.respond(request.id, { type: 'allow_once' });
      }
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions, prompt: string): RunningSession => {
      const tool = toolByPrompt[prompt];
      if (!tool) throw new Error(`missing permission test tool for ${prompt}`);
      const result = Promise.resolve(options.events?.beforeToolExecute?.(
        tool.name,
        tool.input,
        { sessionId: session.id, toolId: `tool-${prompt}` },
      )).then((decision) => {
        if (decision === undefined) throw new Error('missing runtime permission hook');
        decisions.set(prompt, decision);
        return {
          success: true,
          lastText: String(decision),
          messages: [],
          sessionId: session.id,
        } satisfies KodaXResult;
      });
      return fakeRunningSession(options, result);
    });

    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'accept-edits',
      executionCwd: path.join(process.cwd(), 'permission-policy-project'),
    });
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'accept-edit' })).result;
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'runtime-write' })).result;
    await (await runtime.runs.start({
      sessionId: session.id,
      prompt: 'client-write',
      permissionBroker: 'client',
    })).result;
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'protected-write' })).result;
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'accept-bash' })).result;
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'bridge' })).result;
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'plan-edit' })).result;

    expect(decisions.get('accept-edit')).toBe(true);
    expect(decisions.get('runtime-write')).toBe(true);
    expect(decisions.get('client-write')).toBe(true);
    expect(decisions.get('protected-write')).toBe(true);
    expect(decisions.get('accept-bash')).toBe(true);
    expect(decisions.get('bridge')).toBe(true);
    expect(decisions.get('plan-edit')).toContain('[Blocked]');
    expect(requestedTools).toEqual(['write', 'write', 'bash']);
    expect(await runtime.permissions.listPending()).toEqual([]);
    await runtime.close();
  });

  it('runs explicit auto engines inside Runtime and brokers only guardrail escalation', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
      permissionTimeoutMs: 1_000,
    });
    const gitRoot = path.join(tempRoot, 'project');
    const executionCwd = path.join(gitRoot, 'packages', 'app');
    const session = await runtime.sessions.create({ title: 'Daemon Auto Mode' });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      autoModeClassifierModel: 'mock-provider:classifier-model',
      autoModeTimeoutMs: 20_000,
      executionCwd,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'inspect Python',
      permissionBroker: 'client',
      options: { context: { gitRoot, executionCwd } },
    });
    await flushMicrotasks();

    const bootstrap = replMock.bootstrapAutoMode.mock.calls[0]?.[0] as
      | AutoModeBootstrapDeps
      | undefined;
    expect(bootstrap).toMatchObject({ projectRoot: gitRoot, executionCwd });
    expect(bootstrap?.autoModeSettings).toMatchObject({
      engine: 'llm',
      classifierModel: 'mock-provider:classifier-model',
      timeoutMs: 20_000,
    });
    if (!runOptions) throw new Error('expected Runtime run options');
    const runtimeGuardrail = runtimeAutoGuardrail(runOptions);
    expect(runtimeGuardrail).not.toBe(fakeGuardrail);

    const command = 'python -c "import sys; print(sys.executable); print(sys.version)"';
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'bash_python',
      name: 'bash',
      input: { command, description: 'Check Python environment' },
    });
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      { command, description: 'Check Python environment' },
      { sessionId: session.id, toolId: 'bash_python' },
    )).resolves.toBe(true);
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    const escalation = bootstrap?.askUser(
      {
        id: 'bash_python',
        name: 'bash',
        input: {
          command: `${command} # Authorization: Bearer private-value`,
          description: 'Check Python environment',
          apiKey: 'private-value',
        },
      },
      'The classifier could not establish whether this command is safe.',
      [{ kind: 'outside_project', path: 'C:\\outside\\input.pdf' }],
    );
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({ runId: handle.runId });
    expect(pending).toMatchObject({
      toolName: 'bash',
      reason: 'The classifier could not establish whether this command is safe.',
      risk: 'medium',
      executionCwd,
    });
    expect(JSON.parse(pending?.inputPreview ?? '{}')).toMatchObject({
      command: `${command} # Authorization: [REDACTED]`,
      description: 'Check Python environment',
      __truncated: true,
    });
    expect(pending?.inputPreview).not.toContain('private-value');
    if (!pending) throw new Error('expected guardrail escalation permission');
    await runtime.permissions.respond(pending.id, { type: 'allow_once' }, { runId: handle.runId });
    await expect(escalation).resolves.toBe('allow');

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('fails Auto LLM before provider or permission work when no classifier model exists', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Missing Auto Model' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
    });

    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'inspect the workspace',
    })).rejects.toMatchObject({
      code: 'auto_mode_classifier_model_required',
      recoverable: true,
    });
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await expect(runtime.permissions.listPending({ sessionId: session.id })).resolves.toEqual([]);

    await runtime.close();
  });

  it('treats an omitted Auto engine as the default LLM engine during model preflight', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Implicit Auto LLM Model' });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'auto' });

    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'inspect the workspace',
    })).rejects.toMatchObject({
      code: 'auto_mode_classifier_model_required',
      recoverable: true,
    });
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

    await runtime.close();
  });

  it('owns the default LLM guardrail when Auto engine is omitted', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: false,
    });
    const session = await runtime.sessions.create({ title: 'Implicit Auto LLM Guardrail' });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'verify' });
    await flushMicrotasks();
    if (!runOptions) throw new Error('expected Runtime run options');
    expect(replMock.bootstrapAutoMode).toHaveBeenCalledWith(expect.objectContaining({
      autoModeSettings: expect.objectContaining({ engine: 'llm' }),
    }));
    const call = {
      id: 'bash_implicit_llm',
      name: 'bash',
      input: { command: 'node --version' },
    };
    await authorizeRuntimeAutoCall(runOptions, call);
    await expect(runOptions.events?.beforeToolExecute?.(
      call.name,
      call.input,
      { sessionId: session.id, toolId: call.id },
    )).resolves.toBe(true);
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('rejects blank and malformed Runtime Auto LLM classifier-model settings', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const session = await runtime.sessions.create({ title: 'Invalid Auto Model' });

    await expect(runtime.sessions.updateSettings(session.id, {
      autoModeClassifierModel: '   ',
    })).rejects.toThrow(/autoModeClassifierModel.*non-empty/i);
    await expect(runtime.sessions.updateSettings(session.id, {
      autoModeClassifierModel: 'mock-provider:',
    })).rejects.toThrow(/autoModeClassifierModel.*model spec/i);

    await runtime.close();
  });

  it('blocks a live rules-to-LLM switch with no classifier model without brokering permission', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Live Auto Model Switch' });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'rules' as const,
      getStats: () => ({ engine: 'rules' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'rules' as const,
      getStatsForTest: () => ({ engine: 'rules' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'rules',
      executionCwd: tempRoot,
    });
    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'verify' });
    await flushMicrotasks();
    if (!runOptions) throw new Error('expected Runtime run options');

    await runtime.sessions.updateSettings(session.id, { autoModeEngine: 'llm' });
    const verdict = await runtimeAutoGuardrail(runOptions).beforeTool?.(
      { id: 'bash_1', name: 'bash', input: { command: 'npm test' } },
      {
        agent: createAgent({ name: 'runtime-auto-test', instructions: 'Test runtime Auto LLM validation.' }),
        messages: [],
      },
    );
    expect(verdict).toMatchObject({
      action: 'block',
      reason: expect.stringMatching(/classifier model/i),
    });
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('blocks Runtime auto tool hooks that lack a matching guardrail decision', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Auto Decision Receipt' });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
      autoModeSpeculativeWindowMs: 1_200,
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'verify' });
    await flushMicrotasks();
    if (!runOptions) throw new Error('expected Runtime run options');
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      { command: 'npm test' },
      { sessionId: session.id, toolId: 'bash_test' },
    )).resolves.toContain('[Blocked]');
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('binds a tool_call guardrail decision to one exact concrete bridge execution', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Concrete Bridge Receipt' });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'verify bridge' });
    await flushMicrotasks();
    if (!runOptions) throw new Error('expected Runtime run options');
    const outerCall: RunnerToolCall = {
      id: 'bridge_1',
      name: 'tool_call',
      input: { name: 'bash', input: { command: 'npm test', marker: undefined } },
    };
    await authorizeRuntimeAutoCall(runOptions, outerCall);
    await expect(runOptions.events?.beforeToolExecute?.(
      outerCall.name,
      outerCall.input,
      { sessionId: session.id, toolId: outerCall.id },
    )).resolves.toBe(true);
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      { command: 'npm test' },
      { sessionId: session.id, toolId: 'bridge_1:bash' },
    )).resolves.toContain('[Blocked]');
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      { command: 'npm test', marker: undefined },
      { sessionId: session.id, toolId: 'bridge_1:bash' },
    )).resolves.toBe(true);
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      { command: 'npm test', marker: undefined },
      { sessionId: session.id, toolId: 'bridge_1:bash' },
    )).resolves.toContain('[Blocked]');

    let accessorReads = 0;
    const accessorInput: Record<string, unknown> = { command: 'npm test' };
    Object.defineProperty(accessorInput, 'marker', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'dynamic';
      },
    });
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'bash_accessor',
      name: 'bash',
      input: accessorInput,
    });
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      accessorInput,
      { sessionId: session.id, toolId: 'bash_accessor' },
    )).resolves.toContain('[Blocked]');
    expect(accessorReads).toBe(0);

    const symbolInput: Record<string, unknown> = { command: 'npm test' };
    Object.defineProperty(symbolInput, Symbol('marker'), { enumerable: true, value: 'hidden' });
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'bash_symbol',
      name: 'bash',
      input: symbolInput,
    });
    await expect(runOptions.events?.beforeToolExecute?.(
      'bash',
      symbolInput,
      { sessionId: session.id, toolId: 'bash_symbol' },
    )).resolves.toContain('[Blocked]');
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('keeps host permission hooks without creating a shared request in Runtime-owned auto mode', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Auto Host Hook' });
    const hostPermissionHook = vi.fn(async () => true);
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const call: RunnerToolCall = {
        id: 'bash_test',
        name: 'bash',
        input: { command: 'npm test' },
      };
      const result = authorizeRuntimeAutoCall(options, call)
        .then(() => options.events?.beforeToolExecute?.(
          call.name,
          call.input,
          { sessionId: session.id, toolId: call.id },
        ))
        .then((decision): KodaXResult => ({
          success: decision === true,
          lastText: String(decision),
          messages: [],
          sessionId: session.id,
        }));
      return fakeRunningSession(options, result);
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'verify',
      options: { events: { beforeToolExecute: hostPermissionHook } },
    });
    await expect(handle.result).resolves.toMatchObject({ phase: 'completed' });

    expect(hostPermissionHook).toHaveBeenCalledOnce();
    await expect(runtime.events.replay({
      runId: handle.runId,
      type: 'permission.requested',
    })).resolves.toEqual([]);
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);
    await runtime.close();
  }, 60_000);

  it('derives Runtime auto path context from the Session when run options omit it', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const projectRoot = path.join(tempRoot, 'session-project');
    await fs.mkdir(projectRoot, { recursive: true });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: 'Session Path Context',
      projectPath: projectRoot,
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
    });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId: session.id,
      }))
    ));

    await (await runtime.runs.start({ sessionId: session.id, prompt: 'inspect' })).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot,
      executionCwd: projectRoot,
    }));
    await runtime.close();
  }, 60_000);

  it('executes the Runtime auto guardrail before the static permission hook', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Runner Auto Mode' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });

    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push('execute');
      return { content: 'ok' };
    });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: vi.fn(async () => {
        order.push('guardrail');
        return { action: 'allow' as const };
      }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const bashTool: RunnableTool = {
        name: 'bash',
        description: 'Test bash tool',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        execute,
      };
      const agent = createAgent({
        name: 'runtime-auto-runner',
        instructions: 'Run the requested command.',
        tools: [bashTool],
      });
      let turn = 0;
      const result = Runner.run(agent, 'inspect', {
        guardrails: options.guardrails,
        llm: async (): Promise<RunnerLlmResult> => {
          turn += 1;
          return turn === 1
            ? {
                text: '',
                toolCalls: [{ id: 'bash_python', name: 'bash', input: { command: 'python --version' } }],
              }
            : { text: 'done', toolCalls: [] };
        },
        toolObserver: {
          beforeTool: async (call) => {
            order.push('permission');
            return options.events?.beforeToolExecute?.(
              call.name,
              call.input,
              { sessionId: session.id, toolId: call.id },
            );
          },
        },
      }).then((): KodaXResult => ({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId: session.id,
      }));
      return fakeRunningSession(options, result);
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'inspect' });
    await expect(handle.result).resolves.toMatchObject({ phase: 'completed' });
    expect(fakeGuardrail.beforeTool).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(order).toEqual(['guardrail', 'permission', 'execute']);
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);
    await runtime.close();
  }, 60_000);

  it('reuses one Runtime auto guardrail until classifier configuration changes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Persistent Auto Mode' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });

    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'rules' as const,
      getStats: () => ({ engine: 'rules' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'rules' as const,
      getStatsForTest: () => ({ engine: 'rules' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockImplementation(async (deps: AutoModeBootstrapDeps) => {
      queueMicrotask(() => deps.onEngineChange?.('rules'));
      return {
        getGuardrail: () => fakeGuardrail,
        rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
      };
    });
    const guardrails: unknown[] = [];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      guardrails.push(options.guardrails?.find((guardrail) => guardrail.name === 'auto-mode'));
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId: session.id,
      }));
    });

    await (await runtime.runs.start({ sessionId: session.id, prompt: 'turn one' })).result;
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'turn two' })).result;

    await runtime.sessions.updateSettings(session.id, {
      autoModeTimeoutMs: 18_000,
      autoModeSpeculativeWindowMs: 0,
    });
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'turn three' })).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(3);
    expect(guardrails).toHaveLength(3);
    expect(guardrails[0]).not.toBe(guardrails[1]);
    expect(guardrails[2]).not.toBe(guardrails[1]);
    expect(guardrails[0]).not.toBe(fakeGuardrail);
    expect(replMock.bootstrapAutoMode.mock.calls[2]?.[0].autoModeSettings)
      .toMatchObject({
        engine: 'rules',
        timeoutMs: 18_000,
        speculativeWindowMs: 0,
      });
    await expect(runtime.sessions.getSettings(session.id)).resolves.toMatchObject({
      autoModeEngine: 'rules',
      autoModeSpeculativeWindowMs: 0,
    });
    await runtime.close();
  }, 60_000);

  it('releases the Session guardrail cache when a Session is deleted', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const sessionId = 'recreated-auto-session';
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    const runtimeGuardrails: AutoModeToolGuardrail[] = [];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runtimeGuardrails.push(runtimeAutoGuardrail(options));
      return fakeRunningSession(options, Promise.resolve({
        success: true,
        lastText: 'done',
        messages: [],
        sessionId,
      }));
    });

    const configureSession = async (): Promise<void> => {
      await runtime.sessions.create({ sessionId, title: 'Recreated Auto Session' });
      await runtime.sessions.updateSettings(sessionId, {
        permissionMode: 'auto',
        autoModeEngine: 'llm',
        executionCwd: tempRoot,
      });
    };
    await configureSession();
    await (await runtime.runs.start({ sessionId, prompt: 'first lifetime' })).result;
    await runtime.sessions.delete(sessionId);
    await configureSession();
    await (await runtime.runs.start({ sessionId, prompt: 'second lifetime' })).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(2);
    expect(runtimeGuardrails).toHaveLength(2);
    expect(runtimeGuardrails[0]).not.toBe(runtimeGuardrails[1]);
    await runtime.close();
  }, 60_000);

  it('reports the shared auto guardrail engine when a queued turn starts after fallback', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Queued Auto Mode' });
    const firstCwd = path.join(tempRoot, 'first-cwd');
    const secondCwd = path.join(tempRoot, 'second-cwd');
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: firstCwd,
    });

    let notifyEngineChange: ((next: 'llm' | 'rules') => void) | undefined;
    let bootstrapCount = 0;
    replMock.bootstrapAutoMode.mockImplementation(async (deps: AutoModeBootstrapDeps) => {
      bootstrapCount += 1;
      let guardrailEngine = deps.autoModeSettings.engine;
      if (bootstrapCount === 1) {
        notifyEngineChange = (next) => {
          guardrailEngine = next;
          deps.onEngineChange?.(next);
        };
      }
      const fakeGuardrail = {
        kind: 'tool',
        name: 'auto-mode',
        beforeTool: async () => ({ action: 'allow' as const }),
        getEngine: () => guardrailEngine,
        getStats: () => ({ engine: guardrailEngine, denials: {}, breaker: {} }),
        setEngine: (next: 'llm' | 'rules') => {
          guardrailEngine = next;
        },
        getEngineForTest: () => guardrailEngine,
        getStatsForTest: () => ({ engine: guardrailEngine, denials: {}, breaker: {} }),
        setProviderForTest: () => undefined,
      } as unknown as AutoModeToolGuardrail;
      return {
        getGuardrail: () => fakeGuardrail,
        rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
      };
    });

    let releaseFirst: ((result: KodaXResult) => void) | undefined;
    let invocation = 0;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      invocation += 1;
      const result = invocation === 1
        ? new Promise<KodaXResult>((resolve) => {
            releaseFirst = resolve;
          })
        : authorizeRuntimeAutoCall(options, {
            id: 'queued-read',
            name: 'read',
            input: { path: 'README.md' },
          }).then(() => ({
          success: true,
          lastText: 'done',
          messages: [],
          sessionId: session.id,
        }));
      return fakeRunningSession(options, result);
    });
    const effectiveConfigs: unknown[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (event.type === 'config.effective') effectiveConfigs.push(event.payload);
    });

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'turn one',
      options: { context: { executionCwd: firstCwd } },
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'turn two',
      options: { context: { executionCwd: secondCwd } },
    });
    notifyEngineChange?.('rules');
    await flushMicrotasks();
    releaseFirst?.({
      success: true,
      lastText: 'done',
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await second.result;

    expect(effectiveConfigs).toEqual([
      expect.objectContaining({ autoModeEngine: 'llm', executionCwd: firstCwd }),
      expect.objectContaining({ autoModeEngine: 'rules', executionCwd: secondCwd }),
    ]);
    expect(replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0]).toMatchObject({
      executionCwd: secondCwd,
      autoModeSettings: { engine: 'rules' },
    });
    expect(replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0].sharedState)
      .toBe(replMock.bootstrapAutoMode.mock.calls[0]?.[0].sharedState);
    await expect(runtime.sessions.getAutoModeStats(session.id)).resolves.toMatchObject({
      engine: 'rules',
      denials: expect.any(Object),
      breaker: expect.any(Object),
    });
    await runtime.close();
  }, 60_000);

  it('activates the Runtime-owned Auto guardrail when permission mode changes during a run', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Live Auto Mode' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'plan',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: vi.fn(async () => ({ action: 'allow' as const })),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'wait' });
    if (!runOptions) throw new Error('expected run options');
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'auto' });
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'live-auto-read',
      name: 'read',
      input: { path: 'README.md' },
    });
    await expect(runOptions.events?.beforeToolExecute?.(
      'read',
      { path: 'README.md' },
      { sessionId: session.id, toolId: 'live-auto-read' },
    )).resolves.toBe(true);
    expect(fakeGuardrail.beforeTool).toHaveBeenCalledOnce();
    await expect(runtime.permissions.listPending({ runId: handle.runId })).resolves.toEqual([]);

    await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    await expect(runtime.sessions.getSettings(session.id)).resolves.toMatchObject({
      permissionMode: 'plan',
    });
    const blockedPlanPath = path.join(os.homedir(), 'kodax-plan-mode-blocked.txt');
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'live-plan-write',
      name: 'write',
      input: { path: blockedPlanPath, content: 'blocked' },
    });
    await expect(runOptions.events?.beforeToolExecute?.(
      'write',
      { path: blockedPlanPath, content: 'blocked' },
      { sessionId: session.id, toolId: 'live-plan-write' },
    )).resolves.toMatch(/plan mode/i);
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('serializes settings updates and Auto fallback without losing unrelated fields', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Settings Fallback CAS' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });
    let fallback: ((engine: 'llm' | 'rules') => void) | undefined;
    const fakeGuardrail = {
      kind: 'tool',
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
      getEngine: () => 'llm' as const,
      getStats: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => 'llm' as const,
      getStatsForTest: () => ({ engine: 'llm' as const, denials: {}, breaker: {} }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockImplementation(async (deps: AutoModeBootstrapDeps) => {
      fallback = deps.onEngineChange;
      return {
        getGuardrail: () => fakeGuardrail,
        rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
      };
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));
    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'wait' });
    fallback?.('rules');
    await runtime.sessions.updateSettings(session.id, {
      autoModeClassifierModel: 'mock-provider:classifier-v2',
    });
    await flushMicrotasks();

    await expect(runtime.sessions.getSettings(session.id)).resolves.toMatchObject({
      permissionMode: 'auto',
      autoModeEngine: 'rules',
      autoModeClassifierModel: 'mock-provider:classifier-v2',
      executionCwd: tempRoot,
    });
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('rebuilds the LLM guardrail after fallback when the Session explicitly switches back to LLM', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Auto Engine Reset' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });
    let fallback: ((engine: 'llm' | 'rules') => void) | undefined;
    replMock.bootstrapAutoMode.mockImplementation(async (deps: AutoModeBootstrapDeps) => {
      fallback ??= deps.onEngineChange;
      const engine = deps.autoModeSettings.engine;
      const guardrail = {
        kind: 'tool',
        name: 'auto-mode',
        beforeTool: async () => ({ action: 'allow' as const }),
        getEngine: () => engine,
        getStats: () => ({ engine, denials: {}, breaker: {} }),
        setEngine: () => undefined,
        getEngineForTest: () => engine,
        getStatsForTest: () => ({ engine, denials: {}, breaker: {} }),
        setProviderForTest: () => undefined,
      } as unknown as AutoModeToolGuardrail;
      return {
        getGuardrail: () => guardrail,
        rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
      };
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      runOptions = options;
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'wait' });
    fallback?.('rules');
    await flushMicrotasks();
    await expect(runtime.sessions.getSettings(session.id)).resolves.toMatchObject({
      autoModeEngine: 'rules',
    });
    await runtime.sessions.updateSettings(session.id, { autoModeEngine: 'llm' });
    if (!runOptions) throw new Error('expected run options');
    await authorizeRuntimeAutoCall(runOptions, {
      id: 'llm-after-fallback',
      name: 'read',
      input: { path: 'README.md' },
    });

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(2);
    expect(replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0].autoModeSettings).toMatchObject({
      engine: 'llm',
    });
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('rejects a caller-supplied auto-mode guardrail when Runtime owns explicit auto mode', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Duplicate Auto Mode' });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      executionCwd: tempRoot,
    });
    const duplicate = {
      kind: 'tool' as const,
      name: 'auto-mode',
      beforeTool: async () => ({ action: 'allow' as const }),
    };

    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'duplicate',
      options: { guardrails: [duplicate] },
    })).rejects.toThrow(/Runtime owns the auto-mode guardrail/i);
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('tracks pending permission requests from wrapped tool approval hooks', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Test' });
    let releaseApproval: ((value: boolean) => void) | undefined;
    let approvalDone: Promise<boolean | string> | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-permission',
            toolId: 'tool-permission',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs permission',
      options: {
        events: {
          beforeToolExecute: () => new Promise<boolean>((resolve) => {
            releaseApproval = resolve;
          }),
        },
      },
    });

    await flushMicrotasks();
    const pending = await runtime.permissions.listPending({ runId: handle.runId });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe('bash');

    releaseApproval?.(true);
    await approvalDone;

    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);
    const permissionEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ['permission.requested', 'permission.resolved'],
    });
    expect(permissionEvents.map((event) => event.type)).toEqual([
      'permission.requested',
      'permission.resolved',
    ]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('lets runtime permission responses resolve pending approval hooks', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Respond Test' });
    let approvalDone: Promise<boolean | string> | undefined;
    let requestId = '';

    runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === 'string') {
        requestId = payload.id;
        void runtime.permissions.respond(payload.id, { type: 'allow_once' });
      }
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-permission-respond',
            toolId: 'tool-permission-respond',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs runtime permission response',
      options: {
        events: {
          beforeToolExecute: () => new Promise<boolean>(() => undefined),
        },
      },
    });

    await flushMicrotasks();

    expect(requestId).toMatch(/^perm_/);
    await expect(approvalDone).resolves.toBe(true);
    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);
    expect(await runtime.permissions.respond(requestId, { type: 'allow_once' })).toBe(false);
    expect(await runtime.permissions.respond('missing-permission', { type: 'allow_once' })).toBe(false);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('emits bounded valid permission previews with an effective cwd for large writes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const projectRoot = path.join(tempRoot, 'large-write-project');
    await fs.mkdir(projectRoot, { recursive: true });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({
      title: 'Large Write Preview',
      projectPath: projectRoot,
    });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'write',
          {
            file_path: 'generated/large.txt',
            description:
              'Authorization: Bearer private-preview-token; deploy --access-token private-access-token; password: yaml-secret; "apiKey":"json-secret"; -----BEGIN PRIVATE KEY-----\npem-secret\n-----END PRIVATE KEY-----',
            content: `password=private-write-password\n${'x'.repeat(32_000)}`,
          },
          { sessionId: session.id, toolId: 'write-large' },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'write a large generated file',
    });
    await flushMicrotasks();

    const [pending] = await runtime.permissions.listPending({ runId: handle.runId });
    expect(pending?.executionCwd).toBe(projectRoot);
    expect(pending?.inputPreview?.length).toBeLessThanOrEqual(8_192);
    const preview = JSON.parse(pending?.inputPreview ?? '');
    expect(preview).toMatchObject({
      file_path: 'generated/large.txt',
      description: 'Authorization: [REDACTED]; deploy --access-token=[REDACTED]; password: "[REDACTED]"; "apiKey":"[REDACTED]"; [REDACTED_PEM]',
      __truncated: true,
    });
    expect(pending?.inputPreview).not.toContain('private-preview-token');
    expect(pending?.inputPreview).not.toContain('private-access-token');
    expect(pending?.inputPreview).not.toContain('private-write-password');
    expect(pending?.inputPreview).not.toContain('yaml-secret');
    expect(pending?.inputPreview).not.toContain('json-secret');
    expect(pending?.inputPreview).not.toContain('pem-secret');
    expect(preview).not.toHaveProperty('content');

    if (!pending) throw new Error('expected a permission request for the large write');
    await runtime.permissions.respond(pending.id, { type: 'reject' }, { runId: handle.runId });
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it('does not traverse or serialize write bodies even when they are small', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Small Write Preview' });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        const toolInput: Record<string, unknown> = { file_path: 'small.txt' };
        Object.defineProperty(toolInput, 'content', {
          enumerable: true,
          get() { throw new Error('write body was traversed'); },
        });
        approvalDone = options.events?.beforeToolExecute?.(
          'write',
          toolInput,
          { sessionId: session.id, toolId: 'write-small' },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'write safely' });
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({ runId: handle.runId });
    expect(JSON.parse(pending?.inputPreview ?? '')).toEqual({
      file_path: 'small.txt',
      __truncated: true,
    });
    if (!pending) throw new Error('expected a permission request');
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('falls back to valid bounded JSON when a tool input descriptor trap throws', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Hostile Preview Input' });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        const toolInput = new Proxy<Record<string, unknown>>(
          { path: 'safe.txt' },
          {
            getOwnPropertyDescriptor() {
              throw new Error('descriptor trap');
            },
          },
        );
        approvalDone = options.events?.beforeToolExecute?.(
          'write',
          toolInput,
          { sessionId: session.id, toolId: 'write-hostile-preview' },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'write safely' });
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({ runId: handle.runId });
    expect(JSON.parse(pending?.inputPreview ?? '')).toEqual({
      __truncated: true,
    });
    if (!pending) throw new Error('expected a permission request');
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('normalizes caller-supplied permission previews into redacted JSON', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const session = await runtime.sessions.create({ title: 'Permission Preview Input' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-preview-input',
      toolName: 'bash',
      inputPreview: `Authorization: Bearer private-token\npassword: |\n  yaml-block-secret\n  second-secret\n${'x'.repeat(100_000)}`,
    });
    await flushMicrotasks();

    const [pending] = await runtime.permissions.listPending({ runId: 'run-preview-input' });
    expect(pending?.executionCwd).toBe(process.cwd());
    expect(pending?.inputPreview?.length).toBeLessThanOrEqual(8_192);
    expect(() => JSON.parse(pending?.inputPreview ?? '')).not.toThrow();
    expect(pending?.inputPreview).toContain('[REDACTED]');
    expect(pending?.inputPreview).not.toContain('private-token');
    expect(pending?.inputPreview).not.toContain('yaml-block-secret');
    expect(pending?.inputPreview).not.toContain('second-secret');

    if (!pending) throw new Error('expected caller permission request');
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await expect(decision).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('derives the observable preview from concrete tool input instead of trusting caller text', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Trusted Permission Preview' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-trusted-preview',
      toolName: 'bash',
      inputPreview: '{"command":"npm test"}',
      toolInput: { command: 'echo --token=private-preview-secret' },
      executionCwd: tempRoot,
    });

    const [pending] = await runtime.permissions.listPending({ runId: 'run-trusted-preview' });
    if (!pending) throw new Error('expected concrete permission request');
    expect(pending.inputPreview).toContain('echo');
    expect(pending.inputPreview).not.toContain('npm test');
    expect(pending.inputPreview).not.toContain('private-preview-secret');
    expect(pending.inputPreview).toContain('[REDACTED]');
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await expect(decision).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('lets clients select only Runtime-issued concrete grant suggestions', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const session = await runtime.sessions.create({ title: 'Concrete Permission Grant' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-concrete-grant',
      toolCallId: 'tool-concrete-grant',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-concrete-grant' });
    if (!pending) throw new Error('expected concrete permission request');

    expect(pending.grantSuggestions).toEqual([
      expect.objectContaining({ kind: 'session', label: expect.stringContaining('npm test') }),
      expect.objectContaining({ kind: 'persistent', label: expect.stringContaining('npm test') }),
    ]);
    const persistent = pending.grantSuggestions?.find((candidate) => candidate.kind === 'persistent');
    if (!persistent) throw new Error('expected persistent grant suggestion');

    await expect(runtime.permissions.respond(pending.id, {
      type: 'allow_always',
      suggestionId: 'scope_not_issued_by_runtime',
    })).rejects.toThrow(/grant suggestion/i);
    expect(await runtime.permissions.listPending({ runId: 'run-concrete-grant' })).toHaveLength(1);

    expect(await runtime.permissions.respond(pending.id, {
      type: 'allow_always',
      suggestionId: persistent.id,
    })).toBe(true);
    await expect(decision).resolves.toEqual({
      type: 'allow_always',
      suggestionId: persistent.id,
    });

    const grants = await runtime.permissions.listGrants();
    expect(grants.value).toEqual([
      expect.objectContaining({
        persistence: 'persistent',
        scope: expect.objectContaining({
          toolName: 'bash',
          matcher: expect.objectContaining({ kind: 'exact-command' }),
        }),
      }),
    ]);

    await expect(runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-concrete-grant-reuse',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: tempRoot,
    })).resolves.toMatchObject({ type: 'allow_always' });
    const changed = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-concrete-grant-changed',
      toolName: 'bash',
      toolInput: { command: 'npm publish' },
      executionCwd: tempRoot,
    });
    expect(await runtime.permissions.listPending({ runId: 'run-concrete-grant-changed' }))
      .toHaveLength(1);
    const [changedRequest] = await runtime.permissions.listPending({ runId: 'run-concrete-grant-changed' });
    if (!changedRequest) throw new Error('expected changed permission request');
    await runtime.permissions.respond(changedRequest.id, { type: 'reject' });
    await expect(changed).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('narrows legacy allow_always scope responses to a Runtime-issued concrete matcher', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Legacy Scope Response' });
    const filePath = path.join(tempRoot, 'legacy-response.md');
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-legacy-scope-response',
      toolName: 'edit',
      toolInput: { path: filePath, old_string: 'a', new_string: 'b' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: 'run-legacy-scope-response',
    });
    if (!pending) throw new Error('expected legacy compatibility request');

    const legacyDecision = {
      type: 'allow_always' as const,
      scope: { toolName: 'edit', sessionId: session.id },
    };
    expect(await runtime.permissions.respond(pending.id, legacyDecision)).toBe(true);
    await expect(decision).resolves.toEqual(legacyDecision);
    const grants = await runtime.permissions.listGrants();
    expect(grants.value).toEqual([
      expect.objectContaining({
        persistence: 'persistent',
        scope: expect.objectContaining({
          toolName: 'edit',
          sessionId: session.id,
          matcher: expect.objectContaining({ kind: 'exact-path' }),
        }),
      }),
    ]);

    await expect(runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-legacy-scope-reuse',
      toolName: 'edit',
      toolInput: { path: filePath, old_string: 'other', new_string: 'content' },
      executionCwd: tempRoot,
    })).resolves.toMatchObject({ type: 'allow_always' });
    const otherSession = await runtime.sessions.create({ title: 'Other Session' });
    const otherDecision = runtime.permissions.request({
      sessionId: otherSession.id,
      runId: 'run-legacy-scope-other-session',
      toolName: 'edit',
      toolInput: { path: filePath, old_string: 'other', new_string: 'content' },
      executionCwd: tempRoot,
    });
    const [otherPending] = await runtime.permissions.listPending({
      runId: 'run-legacy-scope-other-session',
    });
    if (!otherPending) throw new Error('expected another Session to require permission');
    await runtime.permissions.respond(otherPending.id, { type: 'reject' });
    await expect(otherDecision).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('never offers a persistent grant for dangerous or dynamically expanded shell commands', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Unsafe Grant Suggestions' });

    const dangerous = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-dangerous-grant',
      toolName: 'bash',
      toolInput: { command: 'rm -rf build' },
      executionCwd: tempRoot,
    });
    const dynamic = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-dynamic-grant',
      toolName: 'bash',
      toolInput: {
        command: process.platform === 'win32'
          ? 'echo %USERPROFILE% > output.txt'
          : 'echo $HOME > output.txt',
      },
      executionCwd: tempRoot,
    });
    for (const runId of ['run-dangerous-grant', 'run-dynamic-grant']) {
      const [request] = await runtime.permissions.listPending({ runId });
      if (!request) throw new Error(`expected permission request for ${runId}`);
      expect(request.grantSuggestions?.map((candidate) => candidate.kind)).toEqual(['session']);
      await runtime.permissions.respond(request.id, { type: 'reject' });
    }
    await expect(dangerous).resolves.toEqual({ type: 'reject' });
    await expect(dynamic).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('does not honor a previously persisted dynamic command grant', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtimeDir = path.join(tempRoot, '.kodax', 'runtime');
    const command = process.platform === 'win32'
      ? 'powershell -Command "Get-Content $HOME\\report.txt"'
      : 'cat "$HOME/report.txt"';
    const matcher = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command },
      executionCwd: tempRoot,
      platform: runtimePermissionHostPlatform(),
    });
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'permission-grants.json'), JSON.stringify({
      revision: 1,
      value: [{
        id: 'legacy-dynamic-command',
        scope: { toolName: 'bash', matcher },
        persistence: 'persistent',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }), 'utf-8');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Dynamic Grant Migration' });

    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-dynamic-grant-migration',
      toolName: 'bash',
      toolInput: { command },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: 'run-dynamic-grant-migration',
    });
    if (!pending) throw new Error('expected dynamic grant to require a new decision');
    expect(pending.grantSuggestions?.map((candidate) => candidate.kind)).toEqual(['session']);
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await expect(decision).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('offers persistent grants only for Runtime-normalized command or path scopes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Generic Grant Boundary' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-generic-grant',
      toolName: 'extension_action',
      toolInput: { action: 'publish', _target: 'staging' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-generic-grant' });
    if (!pending) throw new Error('expected generic permission request');
    expect(pending.grantSuggestions?.map((candidate) => candidate.kind)).toEqual(['session']);
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await expect(decision).resolves.toEqual({ type: 'reject' });
    await runtime.close();
  });

  it('redacts secrets from Runtime-issued grant labels without weakening the exact matcher', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Redacted Permission Grant' });
    const command = 'TOKEN=private-grant-secret npm test -- --token=private-grant-secret';
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-redacted-grant',
      toolName: 'bash',
      toolInput: { command },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-redacted-grant' });
    if (!pending) throw new Error('expected redacted permission request');
    expect(pending.grantSuggestions?.map((item) => item.label).join('\n'))
      .not.toContain('private-grant-secret');
    expect(pending.grantSuggestions?.map((item) => item.label).join('\n'))
      .toContain('[REDACTED]');

    const persistent = pending.grantSuggestions?.find((item) => item.kind === 'persistent');
    if (!persistent) throw new Error('expected persistent grant suggestion');
    await runtime.permissions.respond(pending.id, {
      type: 'allow_always',
      suggestionId: persistent.id,
    });
    await decision;
    await expect(runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-redacted-grant-reuse',
      toolName: 'bash',
      toolInput: { command },
      executionCwd: tempRoot,
    })).resolves.toMatchObject({ type: 'allow_always' });
    expect(JSON.stringify(await runtime.permissions.listGrants()))
      .not.toContain('private-grant-secret');
    const grantAudit = await runtime.events.replay({
      type: 'permission.grant.changed',
      sessionId: session.id,
    });
    expect(grantAudit.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        action: 'created',
        grant: expect.objectContaining({ persistence: 'persistent' }),
      }),
    ]);
    expect(JSON.stringify(grantAudit)).not.toContain('private-grant-secret');
    await runtime.close();
  });

  it('coalesces concurrent identical concrete calls without widening their grant candidate', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Concurrent Permission Grant' });
    const input = {
      sessionId: session.id,
      runId: 'run-concurrent-grant',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: tempRoot,
    } as const;
    const first = runtime.permissions.request({ ...input, toolCallId: 'tool-a' });
    const second = runtime.permissions.request({ ...input, toolCallId: 'tool-b' });

    const pending = await runtime.permissions.listPending({ runId: input.runId });
    expect(pending).toHaveLength(1);
    const suggestion = pending[0]?.grantSuggestions?.find((item) => item.kind === 'session');
    if (!pending[0] || !suggestion) throw new Error('expected coalesced session suggestion');
    const decision = { type: 'allow_session' as const, suggestionId: suggestion.id };
    await runtime.permissions.respond(pending[0].id, decision);

    await expect(Promise.all([first, second])).resolves.toEqual([decision, decision]);
    expect((await runtime.permissions.listGrants()).value).toHaveLength(1);
    await runtime.close();
  });

  it('loads, lists, and revokes legacy coarse grants without letting them authorize calls', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtimeDir = path.join(tempRoot, '.kodax', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'permission-grants.json'), JSON.stringify({
      revision: 7,
      value: [{
        id: 'legacy-bash-grant',
        scope: { toolName: 'bash', sessionId: 'legacy-session' },
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
    }), 'utf-8');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    const listed = await runtime.permissions.listGrants();
    expect(listed).toEqual({
      revision: 7,
      value: [expect.objectContaining({
        id: 'legacy-bash-grant',
        persistence: 'persistent',
        scope: { toolName: 'bash', sessionId: 'legacy-session' },
      })],
    });
    const decision = runtime.permissions.request({
      sessionId: 'legacy-session',
      runId: 'legacy-run',
      toolName: 'bash',
      toolInput: { command: 'rm -rf C:/project/$env:LEGACY_TARGET' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'legacy-run' });
    if (!pending) throw new Error('expected legacy grant to require fresh approval');
    expect(pending).toMatchObject({
      sessionId: 'legacy-session',
      toolName: 'bash',
    });
    await runtime.permissions.respond(pending.id, { type: 'reject' });
    await expect(decision).resolves.toEqual({ type: 'reject' });
    expect(await runtime.permissions.revokeGrant('legacy-bash-grant', listed.revision)).toBe(true);
    expect((await runtime.permissions.listGrants()).value).toEqual([]);
    await expect(runtime.events.replay({ type: 'permission.grant.changed' })).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          action: 'revoked',
          grant: expect.objectContaining({ id: 'legacy-bash-grant' }),
        }),
      }),
    ]);
    await runtime.close();
  });

  it('keeps session grants in memory and exposes them through revisioned list/revoke', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: 'Session Permission Grant' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-session-grant',
      toolName: 'edit',
      toolInput: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-session-grant' });
    const suggestion = pending?.grantSuggestions?.find((candidate) => candidate.kind === 'session');
    if (!pending || !suggestion) throw new Error('expected session grant suggestion');
    await runtime.permissions.respond(pending.id, {
      type: 'allow_session',
      suggestionId: suggestion.id,
    });
    await expect(decision).resolves.toMatchObject({ type: 'allow_session' });

    const listed = await runtime.permissions.listGrants();
    expect(listed.value).toEqual([
      expect.objectContaining({ persistence: 'session' }),
    ]);
    await expect(runtime.permissions.revokeGrant('missing', listed.revision - 1))
      .rejects.toThrow(/stale/i);
    expect(await runtime.permissions.revokeGrant(listed.value[0]?.id ?? '', listed.revision)).toBe(true);
    expect((await runtime.permissions.listGrants()).value).toEqual([]);
    await runtime.close();
  });

  it('drops session grants on Session deletion while keeping the grant CAS revision durable', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const session = await runtime.sessions.create({ title: 'Session Grant Lifecycle' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-session-grant-lifecycle',
      toolName: 'read',
      toolInput: { path: 'README.md' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: 'run-session-grant-lifecycle',
    });
    const suggestion = pending?.grantSuggestions?.find((item) => item.kind === 'session');
    if (!pending || !suggestion) throw new Error('expected session grant suggestion');
    await runtime.permissions.respond(pending.id, {
      type: 'allow_session',
      suggestionId: suggestion.id,
    });
    await decision;
    const beforeDelete = await runtime.permissions.listGrants();
    expect(beforeDelete.value).toHaveLength(1);

    await runtime.sessions.delete(session.id);
    const afterDelete = await runtime.permissions.listGrants();
    expect(afterDelete.value).toEqual([]);
    expect(afterDelete.revision).toBeGreaterThan(beforeDelete.revision);
    const grantAudit = await runtime.events.replay({
      type: 'permission.grant.changed',
      sessionId: session.id,
    });
    expect(grantAudit.map((event) => (
      (event.payload as { action?: string }).action
    ))).toEqual(['created', 'expired']);
    await runtime.close();

    const recreated = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    await expect(recreated.permissions.listGrants()).resolves.toEqual({
      revision: afterDelete.revision,
      value: [],
    });
    await recreated.close();
  });

  it('advances the durable grant revision when Runtime close expires session grants', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const session = await runtime.sessions.create({ title: 'Runtime Grant Lifecycle' });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-runtime-grant-lifecycle',
      toolName: 'read',
      toolInput: { path: 'README.md' },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: 'run-runtime-grant-lifecycle',
    });
    const suggestion = pending?.grantSuggestions?.find((item) => item.kind === 'session');
    if (!pending || !suggestion) throw new Error('expected session grant suggestion');
    await runtime.permissions.respond(pending.id, {
      type: 'allow_session',
      suggestionId: suggestion.id,
    });
    await decision;
    const beforeClose = await runtime.permissions.listGrants();
    expect(beforeClose.value).toHaveLength(1);
    await runtime.close();

    const recreated = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const afterClose = await recreated.permissions.listGrants();
    expect(afterClose.value).toEqual([]);
    expect(afterClose.revision).toBeGreaterThan(beforeClose.revision);
    await recreated.close();
  });

  it('brokers daemon AskUser and accepts exactly one concurrent answer', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: 'Shared AskUser' });
    let answerDone: Promise<unknown> | undefined;

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        answerDone = options.events?.askUser?.({
          question: 'Continue?',
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        });
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'ask the user',
    });
    await flushMicrotasks();
    const [request] = await runtime.userInputs.listPending({ runId: handle.runId });
    if (!request) throw new Error('expected pending AskUser request');
    const observation = await runtime.sessions.observe(session.id, () => undefined);
    expect(observation.snapshot.live.pendingUserInputs).toEqual([
      expect.objectContaining({ requestId: request.id, runId: handle.runId }),
    ]);
    observation.close();

    const results = await Promise.all([
      runtime.userInputs.respond(request.id, 'yes', { expectedRevision: request.revision }),
      runtime.userInputs.respond(request.id, 'no', { expectedRevision: request.revision }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    await expect(answerDone).resolves.toBe('yes');
    await expect(runtime.userInputs.listPending({ runId: handle.runId })).resolves.toEqual([]);
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('keeps pending permission requests when a response is bound to another run', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Permission Binding Test' });
    const pendingDecision = runtime.permissions.request({
      sessionId: session.id,
      runId: 'run-permission-owner',
      toolName: 'bash',
      timeoutMs: 60_000,
    });
    const pending = await runtime.permissions.listPending({ runId: 'run-permission-owner' });
    const request = pending[0];
    if (!request) throw new Error('expected a pending permission request');

    expect(await runtime.permissions.respond(
      request.id,
      { type: 'allow_once' },
      { runId: 'run-other' },
    )).toBe(false);
    expect(await runtime.permissions.listPending({ runId: 'run-permission-owner' }))
      .toHaveLength(1);

    expect(await runtime.permissions.respond(
      request.id,
      { type: 'allow_once' },
      { runId: 'run-permission-owner' },
    )).toBe(true);
    await expect(pendingDecision).resolves.toEqual({ type: 'allow_once' });
    expect(await runtime.permissions.respond(
      request.id,
      { type: 'allow_once' },
      { runId: 'run-permission-owner' },
    )).toBe(false);

    await runtime.close();
  });

  it('brokers permission requests even when the host did not provide an approval hook', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Broker Test' });
    let approvalDone: Promise<boolean | string> | undefined;

    runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === 'string') {
        void runtime.permissions.respond(payload.id, { type: 'allow_once' });
      }
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      queueMicrotask(() => {
        approvalDone = options.events?.beforeToolExecute?.(
          'bash',
          { command: 'npm test' },
          {
            sessionId: options.session?.id ?? session.id,
            seq: 1,
            turnId: 'turn-broker',
            toolId: 'tool-broker',
          },
        );
      });
      return fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'needs broker permission',
    });

    await flushMicrotasks();

    await expect(approvalDone).resolves.toBe(true);
    expect(await runtime.permissions.listPending({ runId: handle.runId })).toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it('aborts the targeted running session only', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const first = await runtime.sessions.create({ title: 'First' });
    const second = await runtime.sessions.create({ title: 'Second' });
    const aborts = new Map<string, number>();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    runtime.events.subscribe({ sessionId: first.id }, (event) => firstEvents.push(event.type));
    runtime.events.subscribe({ sessionId: second.id }, (event) => secondEvents.push(event.type));

    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => {
      const sessionId = options.session?.id ?? 'missing-session';
      queueMicrotask(() => {
        options.events?.onTextDelta?.(`delta-${sessionId}`, {
          sessionId,
          seq: 1,
          timestamp: new Date().toISOString(),
        });
      });
      const session = fakeRunningSession(options, new Promise<KodaXResult>(() => undefined));
      return {
        ...session,
        abort(reason?: unknown) {
          aborts.set(sessionId, (aborts.get(sessionId) ?? 0) + 1);
          session.abort(reason);
        },
      };
    });

    const firstRun = await runtime.runs.start({ sessionId: first.id, prompt: 'first' });
    const secondRun = await runtime.runs.start({ sessionId: second.id, prompt: 'second' });
    await flushMicrotasks();

    await runtime.runs.abort(firstRun.runId);
    const firstReplay = await runtime.events.replay({ runId: firstRun.runId });
    const secondReplay = await runtime.events.replay({ runId: secondRun.runId });

    expect(aborts.get(first.id)).toBe(1);
    expect(aborts.get(second.id)).toBeUndefined();
    expect((await runtime.runs.get(firstRun.runId)).phase).toBe('cancelled');
    expect((await runtime.runs.get(secondRun.runId)).phase).toBe('running');
    expect(firstEvents).toContain('assistant.delta');
    expect(firstEvents).toContain('run.cancelled');
    expect(firstEvents).not.toContain('run.completed');
    expect(secondEvents).toContain('assistant.delta');
    expect(secondEvents).not.toContain('run.cancelled');
    expect(firstReplay.every((event) => event.sessionId === first.id)).toBe(true);
    expect(secondReplay.every((event) => event.sessionId === second.id)).toBe(true);

    await runtime.close();
  });

  it('persists and publishes run setting changes to other observers', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: 'mock-provider',
    });
    const session = await runtime.sessions.create({ title: 'Run settings' });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions): RunningSession => (
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined))
    ));
    const updates: RuntimeEvent[] = [];
    runtime.events.subscribe({ sessionId: session.id, type: 'run.updated' }, (event) => {
      updates.push(event);
    });
    const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'configure me' });

    await runtime.runs.setModel(handle.runId, 'model-next');
    await runtime.runs.setProvider(handle.runId, 'provider-next');
    await runtime.runs.setReasoning(handle.runId, 'deep');

    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      model: 'model-next',
      provider: 'provider-next',
      reasoning: 'deep',
    });
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)?.payload).toMatchObject({
      model: 'model-next',
      provider: 'provider-next',
      reasoning: 'deep',
    });
    await runtime.close();
  });

  it('wraps the existing workflow run manager without creating a second workflow store', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { getDefaultWorkflowRunManager } = await import('@kodax-ai/agent');
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const manager = getDefaultWorkflowRunManager();
    const runId = `runtime-workflow-${Date.now()}`;
    const workflowEvents: string[] = [];
    let finishWorkflow: (() => void) | undefined;
    const subscription = runtime.workflows.subscribe({ runId }, (event) => {
      workflowEvents.push(event.type);
    });

    const run = manager.start<WorkflowOutcome>({
      runId,
      workflow: 'runtime-contract-test',
      processMetadata: {
        source: 'sdk',
        hostMetadata: { sessionId: 'workflow-session' },
      },
      runFn: async (hooks) => {
        hooks.onEvent(workflowEvent('agent_spawned', 1));
        await new Promise<void>((resolve) => {
          finishWorkflow = resolve;
        });
        hooks.onEvent(workflowEvent('agent_completed', 2));
        hooks.onEvent({
          type: 'workflow_completed',
          seq: 3,
          data: { resultSummary: 'workflow ok' },
        });
        return { kind: 'completed', result: 'workflow ok' };
      },
      classify: classifyWorkflowOutcome,
      onError: workflowErrorOutcome,
    });

    await flushMicrotasks();

    await expect(runtime.status.preflight()).resolves.toMatchObject({
      activeWorkflows: [expect.objectContaining({ runId, status: 'running' })],
      activeAgentTurns: [],
      blockers: expect.arrayContaining(['active_workflows']),
      canStop: false,
    });
    expect(await runtime.workflows.list({ runId })).toHaveLength(1);
    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      workflowName: 'runtime-contract-test',
      status: 'running',
    });
    expect(await runtime.workflows.pause(runId)).toBe(true);
    expect((await runtime.workflows.get(runId))?.status).toBe('paused');
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      activeWorkflows: [expect.objectContaining({ runId, status: 'paused' })],
      blockers: expect.arrayContaining(['active_workflows']),
      canStop: false,
    });
    expect(await runtime.workflows.resume(runId)).toBe(true);

    finishWorkflow?.();
    await run.done;

    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      status: 'completed',
      resultSummary: 'workflow ok',
    });
    expect(workflowEvents).toContain('workflow_updated');
    expect(workflowEvents).toContain('workflow_finished');
    expect(await runtime.workflows.stop('missing-workflow')).toBe(false);
    const settledPreflight = await runtime.status.preflight();
    expect(settledPreflight.activeWorkflows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId }),
    ]));
    expect(settledPreflight.blockers).not.toContain('active_workflows');

    subscription.close();
    await runtime.close();
  });
});

type WorkflowOutcome =
  | { readonly kind: 'completed'; readonly result: string }
  | { readonly kind: 'failed'; readonly error: Error };

function classifyWorkflowOutcome(outcome: WorkflowOutcome): ManagedRunClassification {
  if (outcome.kind === 'completed') {
    return { status: 'completed', resultText: outcome.result };
  }
  return { status: 'failed', error: outcome.error };
}

function workflowErrorOutcome(error: unknown): WorkflowOutcome {
  return {
    kind: 'failed',
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

function workflowEvent(type: WorkflowEvent['type'], seq: number): WorkflowEvent {
  return { type, seq };
}

function fakeRunningSession(
  options: KodaXOptions,
  result: Promise<KodaXResult>,
): RunningSession {
  let aborted = false;
  let provider = options.provider;
  let model = options.modelOverride ?? options.model;
  let reasoning = options.reasoningMode;
  return {
    id: options.session?.id ?? 'missing-session',
    get currentProvider() {
      return provider;
    },
    get currentModel() {
      return model;
    },
    get currentReasoning() {
      return reasoning;
    },
    get aborted() {
      return aborted;
    },
    attached: true,
    setProvider(name) {
      provider = name;
    },
    setModel(nextModel) {
      model = nextModel;
    },
    setReasoning(nextReasoning) {
      reasoning = nextReasoning;
    },
    abort() {
      aborted = true;
    },
    result,
  };
}

function makeDaemonEndpoint(tempRoot: string): RuntimeDaemonEndpoint {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-sdk-runtime-test-${randomUUID()}`,
    };
  }
  return {
    kind: 'unix',
    path: path.join(tempRoot, `kodax-sdk-runtime-test-${randomUUID()}.sock`),
  };
}

function isPermissionRequestPayload(value: unknown): value is { readonly id: string; readonly runId: string } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { readonly id?: unknown }).id === 'string'
    && typeof (value as { readonly runId?: unknown }).runId === 'string';
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function readDirectoryText(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        chunks.push((await fs.readFile(target)).toString('utf8'));
      }
    }
  };
  await visit(root);
  return chunks.join('\n');
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not become true within ${timeoutMs}ms.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function shutdownRuntimeDaemon(homeDir: string, profile: string): Promise<void> {
  const {
    readRuntimeDaemonLockOwner,
    readRuntimeDaemonState,
    readRuntimeDaemonToken,
    resolveRuntimeDaemonPaths,
  } = await import('./runtime-daemon/state.js');
  const state = readRuntimeDaemonState(resolveRuntimeDaemonPaths(homeDir, profile));
  if (!state) return;
  const { runtimeDaemonEndpointFromState } = await import('./runtime-daemon/lifecycle.js');
  const {
    createRuntimeDaemonSocketClientTransport,
    isRuntimeDaemonTransportError,
  } = await import('./runtime-daemon/transport.js');
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const transport = await createRuntimeDaemonSocketClientTransport(runtimeDaemonEndpointFromState(state));
  try {
    await transport.request('initialize', {
      profile,
      token: readRuntimeDaemonToken(paths),
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await transport.request('runtime.shutdown');
        break;
      } catch (error: unknown) {
        if (
          !isRuntimeDaemonTransportError(error)
          || error.code !== 'conflict'
          || Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await transport.close?.();
  }
  await waitForCondition(() => (
    readRuntimeDaemonState(paths) === undefined
    && readRuntimeDaemonLockOwner(paths.lockFile) === undefined
  ));
}

async function expectSettles<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 250,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
