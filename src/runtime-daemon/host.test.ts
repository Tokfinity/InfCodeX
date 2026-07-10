import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type {
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimePermissionRequest,
  RuntimeRunResult,
  RuntimeStartRunInput,
} from '../sdk-runtime.js';
import { startRuntimeDaemonHost } from './host.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  type RuntimeDaemonEndpoint,
} from './transport.js';

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime daemon host', () => {
  it('serves a hosted runtime over the local daemon transport and releases ownership on close', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for host test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    expect(readRuntimeDaemonState(paths)).toMatchObject({
      runtimeId: runtime.identity.runtimeId,
      status: 'ready',
      endpoint: host.endpoint.path,
    });

    const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await client.close?.();
    });

    await expect(client.request('initialize', { profile: 'default' }))
      .rejects.toThrow('Runtime daemon initialize token is invalid.');
    const token = readRuntimeDaemonToken(paths);
    expect(token).toMatch(/^dt_/);
    await expect(client.request('initialize', { profile: 'default', token })).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: 'default',
      },
    });
    await expect(client.request('ping')).resolves.toMatchObject({
      ok: true,
      runtimeId: runtime.identity.runtimeId,
    });
    await expect(client.request('daemon.logs')).resolves.toMatchObject({
      logFile: paths.logFile,
      entries: expect.arrayContaining([
        expect.objectContaining({ message: 'Runtime daemon ready.' }),
      ]),
    });

    await host.close();

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('releases host ownership when daemon.stop is requested through the protocol', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for stop test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await client.close?.();
    });
    const token = readRuntimeDaemonToken(paths);

    await expect(client.request('initialize', { profile: 'default', token })).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: 'default',
      },
    });
    await expect(client.request('daemon.stop')).resolves.toEqual({ ok: true });
    await waitForHostStateRemoval(paths);

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('routes runtime diagnostics to the daemon log without writing to the live terminal', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for diagnostic test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    emitKodaXDiagnostic({
      source: 'test:diagnostic',
      level: 'warn',
      message: 'bounded warning',
      detail: { code: 'E_TEST' },
    });

    const logText = fs.readFileSync(paths.logFile, 'utf8');
    expect(logText).toContain('[test:diagnostic] bounded warning');
    expect(logText).toContain('"code":"E_TEST"');

    await host.close();
  });

  it('retains run results across daemon client reconnects', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for reconnect test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    const firstClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await firstClient.close?.();
    });
    const token = readRuntimeDaemonToken(paths);
    await expect(firstClient.request('initialize', { profile: 'default', token })).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: 'default',
      },
    });
    await expect(firstClient.request('run.start', {
      sessionId: 'session-1',
      prompt: 'hello',
    })).resolves.toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
    });
    await firstClient.close?.();

    const secondClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await secondClient.close?.();
    });
    await expect(secondClient.request('initialize', { profile: 'default', token })).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: 'default',
      },
    });
    await expect(secondClient.request('run.await', { runId: 'run-1' })).resolves.toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
      phase: 'completed',
      result: {
        success: true,
        lastText: 'done',
      },
    });
  });

  it('broadcasts matching session events to multiple initialized daemon clients', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for multi-client test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);

    const replClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    const spaceClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await replClient.close?.();
      await spaceClient.close?.();
    });

    await expect(replClient.request('initialize', {
      profile: 'default',
      token,
      clientInfo: { name: 'kodax-repl-test' },
    })).resolves.toMatchObject({ identity: { runtimeId: runtime.identity.runtimeId } });
    await expect(spaceClient.request('initialize', {
      profile: 'default',
      token,
      clientInfo: { name: 'kodax-space-test' },
    })).resolves.toMatchObject({ identity: { runtimeId: runtime.identity.runtimeId } });

    const replEvents: RuntimeEvent[] = [];
    const spaceEvents: RuntimeEvent[] = [];
    replClient.subscribe((notification) => {
      const event = extractRuntimeEventNotification(notification.params);
      if (event) replEvents.push(event);
    });
    spaceClient.subscribe((notification) => {
      const event = extractRuntimeEventNotification(notification.params);
      if (event) spaceEvents.push(event);
    });

    await expect(replClient.request('event.subscribe', {
      filter: { sessionId: 'session-1', type: 'run.completed' },
    })).resolves.toMatchObject({ subscriptionId: expect.any(String) });
    await expect(spaceClient.request('event.subscribe', {
      filter: { sessionId: 'session-1', type: 'run.completed' },
    })).resolves.toMatchObject({ subscriptionId: expect.any(String) });
    await expect(replClient.request('run.start', {
      sessionId: 'session-1',
      prompt: 'hello from repl',
    })).resolves.toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
    });

    await waitFor(() => replEvents.length === 1 && spaceEvents.length === 1);
    expect(replEvents[0]).toMatchObject({
      type: 'run.completed',
      sessionId: 'session-1',
      runId: 'run-1',
      payload: { lastText: 'done' },
    });
    expect(spaceEvents[0]).toEqual(replEvents[0]);
  });

  it('lists and answers pending permissions after a daemon client reconnects', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const baseRuntime = makeRuntime();
    const pending: RuntimePermissionRequest[] = [{
      id: 'perm-1',
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      reason: 'edit requires approval',
      createdAt: '2026-07-09T00:00:00.000Z',
    }];
    const runtime: KodaXRuntime & { closed: boolean } = {
      ...baseRuntime,
      permissions: {
        async request() {
          return { type: 'allow_once' };
        },
        async listPending(filter) {
          return pending.filter((request) => (
            (filter?.sessionId === undefined || request.sessionId === filter.sessionId)
            && (filter?.runId === undefined || request.runId === filter.runId)
            && (filter?.toolName === undefined || request.toolName === filter.toolName)
          ));
        },
        async respond(requestId, _decision, options) {
          const index = pending.findIndex((request) => (
            request.id === requestId
            && (options?.runId === undefined || request.runId === options.runId)
          ));
          if (index < 0) return false;
          pending.splice(index, 1);
          return true;
        },
      },
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon lock for permission reconnect test.');

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);

    const firstClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await firstClient.close?.();
    });
    await expect(firstClient.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: runtime.identity.runtimeId } });
    await expect(firstClient.request('permission.list', { runId: 'run-1' }))
      .resolves.toEqual([expect.objectContaining({ id: 'perm-1', toolName: 'bash' })]);
    await firstClient.close?.();

    const secondClient = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await secondClient.close?.();
    });
    await expect(secondClient.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: runtime.identity.runtimeId } });
    await expect(secondClient.request('permission.respond', {
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      runId: 'run-1',
    })).resolves.toBe(true);
    await expect(secondClient.request('permission.respond', {
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      runId: 'run-1',
    })).resolves.toBe(false);
    expect(pending).toEqual([]);
  });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-host-'));
  tempRoots.push(dir);
  return dir;
}

async function makeTestEndpoint(): Promise<RuntimeDaemonEndpoint> {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-host-test-${randomUUID()}`,
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-host-socket-'));
  tempRoots.push(dir);
  return {
    kind: 'unix',
    path: path.join(dir, 'daemon.sock'),
  };
}

async function waitForHostStateRemoval(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (!readRuntimeDaemonState(paths) && !readRuntimeDaemonLockOwner(paths.lockFile)) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  throw new Error('Timed out waiting for daemon host state removal.');
}

function makeRuntime(): KodaXRuntime & { closed: boolean } {
  const runs = new Map<string, RuntimeRunResult>();
  const eventSubscribers: Array<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }> = [];
  let eventSeq = 1;
  const emitEvent = (event: Omit<RuntimeEvent, 'id' | 'seq' | 'time'>): RuntimeEvent => {
    const fullEvent: RuntimeEvent = {
      ...event,
      id: `evt_${eventSeq}`,
      seq: eventSeq,
      time: new Date().toISOString(),
    };
    eventSeq += 1;
    for (const subscriber of eventSubscribers) {
      if (runtimeEventMatchesFilter(fullEvent, subscriber.filter)) {
        subscriber.listener(fullEvent);
      }
    }
    return fullEvent;
  };
  const runtime: KodaXRuntime & { closed: boolean } = {
    closed: false,
    identity: {
      runtimeId: 'runtime-host-test',
      mode: 'daemon',
      profile: 'default',
      startedAt: '2026-07-09T00:00:00.000Z',
      version: '0.7.66',
    },
    sessions: {
      async create(input) {
        return { id: input?.sessionId ?? 'session-1', title: input?.title ?? 'Test Session' };
      },
      async load(sessionId) {
        return { id: sessionId, title: 'Loaded Session' };
      },
      async list() {
        return [{ id: 'session-1', title: 'Test Session', msgCount: 0 }];
      },
      async transcript() {
        return null;
      },
      async fork() {
        return { id: 'fork-1', title: 'Forked Session' };
      },
      async getSettings() {
        return {};
      },
      async updateSettings() {
        return {};
      },
      async appendNotice() {
        return null;
      },
      async rewind(input) {
        return { id: input.sessionId, title: 'Rewound Session' };
      },
      async setActiveEntry(input) {
        return { id: input.sessionId, title: 'Active Entry Session' };
      },
      async compact(input) {
        return {
          compacted: false,
          tokensBefore: 0,
          tokensAfter: 0,
          messages: [],
          session: { id: input.sessionId, title: 'Compacted Session' },
        } satisfies RuntimeCompactSessionResult;
      },
      async archive() {},
      async unarchive() {},
      async delete() {},
    },
    runs: {
      async start(input: RuntimeStartRunInput) {
        const result: RuntimeRunResult = {
          runId: 'run-1',
          sessionId: input.sessionId,
          phase: 'completed',
          result: {
            success: true,
            lastText: 'done',
            messages: [],
            sessionId: input.sessionId,
          },
        };
        runs.set(result.runId, result);
        emitEvent({
          sessionId: result.sessionId,
          runId: result.runId,
          type: 'run.completed',
          payload: { lastText: result.result?.lastText },
        });
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async await(runId) {
        const result = runs.get(runId);
        if (result) return result;
        return { runId, sessionId: 'session-1', phase: 'completed' };
      },
      async get(runId) {
        const result = runs.get(runId);
        return {
          runId,
          sessionId: result?.sessionId ?? 'session-1',
          phase: result?.phase ?? 'completed',
          startedAt: '2026-07-09T00:00:00.000Z',
          provider: 'mock',
        };
      },
      async list() {
        return [];
      },
      async abort() {},
      async setModel() {},
      async setProvider() {},
      async setReasoning() {},
    },
    events: {
      subscribe(filter, listener) {
        const subscriber = { filter, listener };
        eventSubscribers.push(subscriber);
        return {
          close() {
            const index = eventSubscribers.indexOf(subscriber);
            if (index >= 0) eventSubscribers.splice(index, 1);
          },
        };
      },
      async replay() {
        return [];
      },
    },
    permissions: {
      async request() {
        return { type: 'allow_once' };
      },
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
    },
    workflows: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      subscribe() {
        return { close() {} };
      },
      async pause() {
        return false;
      },
      async resume() {
        return false;
      },
      async stop() {
        return false;
      },
    },
    config: {
      async read() {
        return {};
      },
      async patch(patch) {
        return patch;
      },
      async reload() {
        return { ok: true, config: {} };
      },
    },
    catalog: {
      async providers() {
        return [];
      },
      async models() {
        return [];
      },
      async commands() {
        return [];
      },
      async resolveCommand() {
        return null;
      },
      async skills() {
        return [];
      },
      async describeSkill() {
        return null;
      },
      async customProviders() {
        return [];
      },
      async upsertCustomProvider(config) {
        return config;
      },
      async deleteCustomProvider() {
        return false;
      },
      async extensions() {
        return { active: false, extensions: [] };
      },
      async reloadExtensions() {
        return { ok: true, active: false };
      },
    },
    mcp: {
      async listServers() {
        return {};
      },
      async getServer() {
        return undefined;
      },
      async validateServer(_name, config) {
        return {
          ok: true,
          config: config as Parameters<KodaXRuntime['mcp']['upsertServer']>[1],
        };
      },
      async upsertServer(_name, config) {
        return config;
      },
      async deleteServer() {
        return false;
      },
      async reloadServers() {
        return { ok: true, servers: [] };
      },
      async listTools() {
        return [];
      },
    },
    artifacts: {
      async create(input) {
        return {
          id: 'art-1',
          kind: input.kind,
          path: input.path,
          sizeBytes: 0,
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async get() {
        return undefined;
      },
      async delete() {
        return false;
      },
    },
    admin: {
      agentRegistrations: {
        async list() { return []; },
        async upsert() { throw new Error('External agents are disabled in this test runtime.'); },
        async remove() { throw new Error('External agents are disabled in this test runtime.'); },
      },
    },
    agents: {
      enabled: false,
      async listDispatchable() { return []; },
      async describe() { return undefined; },
      async preflight() { throw new Error('External agents are disabled in this test runtime.'); },
    },
    agentTasks: {
      async start() { throw new Error('External agents are disabled in this test runtime.'); },
      async list() { return []; },
      async get() { throw new Error('External agents are disabled in this test runtime.'); },
      async events() { throw new Error('External agents are disabled in this test runtime.'); },
      async wait() { throw new Error('External agents are disabled in this test runtime.'); },
      async sendInput() { throw new Error('External agents are disabled in this test runtime.'); },
      async cancel() { throw new Error('External agents are disabled in this test runtime.'); },
      async reconcile() { throw new Error('External agents are disabled in this test runtime.'); },
    },
    status: {
      async snapshot() {
        return {
          ...runtime.identity,
          sessions: [],
          runs: [],
          pendingPermissions: [],
          workflows: [],
        };
      },
    },
    diagnostics: {
      async latestContextBudget() {
        return null;
      },
      async latestToolExposure() {
        return null;
      },
    },
    async close() {
      runtime.closed = true;
    },
  };
  return runtime;
}

function extractRuntimeEventNotification(params: unknown): RuntimeEvent | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const event = (params as { readonly event?: unknown }).event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return undefined;
  }
  return event as RuntimeEvent;
}

function runtimeEventMatchesFilter(event: RuntimeEvent, filter: RuntimeEventFilter): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  throw new Error('Timed out waiting for daemon test condition.');
}
