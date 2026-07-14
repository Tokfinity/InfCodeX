import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ManagedRunClassification,
  WorkflowEvent,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  RunningSession,
} from '@kodax-ai/coding';
import type {
  RuntimeDaemonClientTransport,
  RuntimeEvent,
  RuntimeStartRunInput,
} from './sdk-runtime.js';
import type { RuntimeDaemonEndpoint } from './runtime-daemon/transport.js';

const codingMock = vi.hoisted(() => ({
  runManagedTask: vi.fn(),
  startKodaX: vi.fn(),
}));

const replMock = vi.hoisted(() => ({
  beforeLoadSession: null as null | ((call: number) => Promise<void>),
  loadSessionCalls: 0,
}));

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
    replMock.beforeLoadSession = null;
    replMock.loadSessionCalls = 0;
  });

  afterEach(async () => {
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
  }, 30_000);

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
    const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
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
        surface: 'sdk-test',
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

      space.events.subscribe({ sessionId: session.id }, (event) => {
        seen.push(event.type);
        if (event.type !== 'permission.requested') return;
        const payload = event.payload;
        if (!isPermissionRequestPayload(payload)) return;
        void space?.permissions.respond(payload.id, { type: 'allow_once' }, { runId: payload.runId });
      });

      approvalDone = worker.permissions.request({
        sessionId: session.id,
        runId: 'run-space-permission',
        turnId: 'turn-space-permission',
        toolCallId: 'tool-space-permission',
        toolName: 'bash',
        inputPreview: '{"command":"echo from space permission"}',
      });
      await expect(expectSettles(approvalDone, 'space permission approval')).resolves.toEqual({
        type: 'allow_once',
      });
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
      surface: 'sdk-test',
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
  });

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
    });
    expect(settings).toMatchObject({
      provider: 'settings-provider',
      model: 'settings-model',
      effort: 'high',
      thinking: true,
      reasoningMode: 'balanced',
      permissionMode: 'accept-edits',
      executionCwd: path.resolve(tempRoot),
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
    });
    await recreated.close();
  });

  it('keeps session executionCwd settings inside the session workspace root', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const projectRoot = path.join(tempRoot, 'project');
    const outsideRoot = path.join(tempRoot, 'outside');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
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
      executionCwd: outsideRoot,
    })).rejects.toThrow('executionCwd must stay within the session workspace root');
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
    const persistedAtPublication: Array<{ readonly event: string; readonly phase: string }> = [];
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

  it('creates ordered after-turn continuation runs and rejects stale or interrupt delivery', async () => {
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
    const unsupported = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: 'interrupt',
      input: { type: 'text', text: 'urgent' },
    });

    expect(continuation).toMatchObject({
      accepted: true,
      delivery: 'after_turn',
      afterRunId: first.runId,
      sessionOrder: 2,
    });
    expect(unsupported).toEqual({
      accepted: false,
      delivery: 'interrupt',
      sessionId: session.id,
      afterRunId: first.runId,
      reason: 'unsupported_capability',
    });
    expect(starts).toEqual(['first']);
    if (!continuation.accepted) throw new Error('Expected accepted continuation');
    expect((await runtime.runs.get(continuation.runId)).phase).toBe('queued');

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
    const session = await runtime.sessions.create({ title: 'Queued Settings Snapshot' });
    await runtime.sessions.updateSettings(session.id, {
      provider: 'settings-provider-a',
      model: 'settings-model-a',
    });

    const starts: Array<{ readonly prompt: string; readonly provider?: string; readonly model?: string }> = [];
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
      return new Promise<KodaXResult>(() => undefined);
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: 'managed',
      mode: 'managed_task',
    });
    expect(codingMock.runManagedTask).toHaveBeenCalledOnce();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

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
      'auto-bash': { name: 'bash', input: { command: 'npm test' } },
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
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'auto' });
    await (await runtime.runs.start({ sessionId: session.id, prompt: 'auto-bash' })).result;

    expect(decisions.get('accept-edit')).toBe(true);
    expect(decisions.get('runtime-write')).toBe(true);
    expect(decisions.get('client-write')).toBe(true);
    expect(decisions.get('protected-write')).toBe(true);
    expect(decisions.get('accept-bash')).toBe(true);
    expect(decisions.get('bridge')).toBe(true);
    expect(decisions.get('plan-edit')).toContain('[Blocked]');
    expect(decisions.get('auto-bash')).toBe(true);
    expect(requestedTools).toEqual(['write', 'write', 'bash']);
    expect(await runtime.permissions.listPending()).toEqual([]);
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
    await runtime.runs.setReasoning(handle.runId, 'on');

    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      model: 'model-next',
      provider: 'provider-next',
      reasoning: 'on',
    });
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)?.payload).toMatchObject({
      model: 'model-next',
      provider: 'provider-next',
      reasoning: 'on',
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

    expect(await runtime.workflows.list({ runId })).toHaveLength(1);
    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      workflowName: 'runtime-contract-test',
      status: 'running',
    });
    expect(await runtime.workflows.pause(runId)).toBe(true);
    expect((await runtime.workflows.get(runId))?.status).toBe('paused');
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
    readRuntimeDaemonState,
    readRuntimeDaemonToken,
    resolveRuntimeDaemonPaths,
  } = await import('./runtime-daemon/state.js');
  const state = readRuntimeDaemonState(resolveRuntimeDaemonPaths(homeDir, profile));
  if (!state) return;
  const { runtimeDaemonEndpointFromState } = await import('./runtime-daemon/lifecycle.js');
  const { createRuntimeDaemonSocketClientTransport } = await import('./runtime-daemon/transport.js');
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const transport = await createRuntimeDaemonSocketClientTransport(runtimeDaemonEndpointFromState(state));
  try {
    await transport.request('initialize', {
      profile,
      token: readRuntimeDaemonToken(paths),
    });
    await transport.request('runtime.shutdown');
  } finally {
    await transport.close?.();
  }
  await waitForCondition(() => readRuntimeDaemonState(paths) === undefined);
}

async function expectSettles<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
