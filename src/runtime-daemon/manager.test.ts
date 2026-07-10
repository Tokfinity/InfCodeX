import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeRunResult,
  RuntimeStartRunInput,
} from '../sdk-runtime.js';
import { createRuntimeDaemonClient } from './client.js';
import { acquireRuntimeDaemonLease } from './manager.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './state.js';
import type { RuntimeDaemonEndpoint } from './transport.js';

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime daemon lease manager', () => {
  it('lets concurrent starters converge on one daemon owner', async () => {
    const homeDir = tempHome();
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    const endpoint = await makeTestEndpoint();
    const firstRuntime = makeRuntime('runtime-concurrent-1');
    const secondRuntime = makeRuntime('runtime-concurrent-2');

    const [firstLease, secondLease] = await Promise.all([
      acquireRuntimeDaemonLease({
        homeDir,
        profile: 'default',
        endpoint,
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async () => firstRuntime,
      }),
      acquireRuntimeDaemonLease({
        homeDir,
        profile: 'default',
        endpoint,
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async () => secondRuntime,
      }),
    ]);
    const ownerLease = firstLease.ownsHost ? firstLease : secondLease;
    cleanupTasks.push(async () => {
      await firstLease.close();
      await secondLease.close();
      await ownerLease.shutdown();
    });

    expect([firstLease.ownsHost, secondLease.ownsHost].filter(Boolean)).toHaveLength(1);
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    expect(owner?.runtimeId).toMatch(/^runtime-concurrent-/);
    expect([firstRuntime.closed, secondRuntime.closed].filter(Boolean)).toHaveLength(1);

    const token = readRuntimeDaemonToken(paths);
    await expect(firstLease.transport.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: owner?.runtimeId } });
    await expect(secondLease.transport.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: owner?.runtimeId } });
  });

  it('isolates default endpoints by home directory for the same profile', async () => {
    const firstHome = tempHome();
    const secondHome = tempHome();
    const firstPaths = resolveRuntimeDaemonPaths(firstHome, 'shared');
    const secondPaths = resolveRuntimeDaemonPaths(secondHome, 'shared');
    const firstRuntime = makeRuntime('runtime-home-1', 'shared');
    const secondRuntime = makeRuntime('runtime-home-2', 'shared');

    const [firstLease, secondLease] = await Promise.all([
      acquireRuntimeDaemonLease({
        homeDir: firstHome,
        profile: 'shared',
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async () => firstRuntime,
      }),
      acquireRuntimeDaemonLease({
        homeDir: secondHome,
        profile: 'shared',
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async () => secondRuntime,
      }),
    ]);
    cleanupTasks.push(async () => {
      await firstLease.close();
      await secondLease.close();
      await firstLease.shutdown();
      await secondLease.shutdown();
    });

    expect(firstLease.ownsHost).toBe(true);
    expect(secondLease.ownsHost).toBe(true);
    expect(firstLease.endpoint.path).not.toBe(secondLease.endpoint.path);
    expect(readRuntimeDaemonLockOwner(firstPaths.lockFile)).toMatchObject({
      runtimeId: firstRuntime.identity.runtimeId,
    });
    expect(readRuntimeDaemonLockOwner(secondPaths.lockFile)).toMatchObject({
      runtimeId: secondRuntime.identity.runtimeId,
    });

    await expect(firstLease.transport.request('initialize', {
      profile: 'shared',
      token: readRuntimeDaemonToken(firstPaths),
    })).resolves.toMatchObject({ identity: { runtimeId: firstRuntime.identity.runtimeId } });
    await expect(secondLease.transport.request('initialize', {
      profile: 'shared',
      token: readRuntimeDaemonToken(secondPaths),
    })).resolves.toMatchObject({ identity: { runtimeId: secondRuntime.identity.runtimeId } });
  });

  it('claims a startup lock after the waiting owner disappears', async () => {
    const homeDir = tempHome();
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-starter',
      pid: 999_999,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    let pidChecks = 0;
    const runtime = makeRuntime();
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      profile: 'default',
      endpoint: await makeTestEndpoint(),
      startupTimeoutMs: 1_000,
      pollIntervalMs: 10,
      healthCheck: {
        isPidAlive: () => {
          pidChecks += 1;
          return pidChecks === 1;
        },
      },
      createRuntime: async () => runtime,
    });
    cleanupTasks.push(async () => {
      await lease.close();
      await lease.shutdown();
    });

    expect(lease.ownsHost).toBe(true);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: runtime.identity.runtimeId,
    });
  });

  it('keeps the daemon alive when its original client detaches', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    const firstLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async () => makeRuntime('runtime-owner'),
    });
    const token = readRuntimeDaemonToken(firstLease.paths);
    await firstLease.transport.request('initialize', { profile: 'default', token });
    const secondLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async () => makeRuntime('runtime-candidate'),
    });
    await secondLease.transport.request('initialize', { profile: 'default', token });
    cleanupTasks.push(async () => {
      await secondLease.close();
      await firstLease.shutdown();
    });

    await firstLease.close();

    await expect(secondLease.transport.request('ping')).resolves.toEqual({
      ok: true,
      runtimeId: 'runtime-owner',
    });
  });

  it('round-trips failed run Errors through a real daemon socket', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async () => makeRuntime(
        'runtime-errors',
        'default',
        new TypeError('provider unavailable'),
      ),
    });
    cleanupTasks.push(async () => {
      await lease.close();
      await lease.shutdown();
    });
    const token = readRuntimeDaemonToken(lease.paths);
    await lease.transport.request('initialize', { profile: 'default', token });
    const client = createRuntimeDaemonClient({
      identity: {
        ...makeRuntime('runtime-errors').identity,
        mode: 'daemon',
      },
      transport: lease.transport,
    });

    const handle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'fail over the wire',
    });
    const result = await handle.result;

    expect(result).toMatchObject({ phase: 'failed' });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('provider unavailable');
  });

  it('releases daemon ownership only through explicit shutdown', async () => {
    const homeDir = tempHome();
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint: await makeTestEndpoint(),
      createRuntime: async () => makeRuntime('runtime-explicit-shutdown'),
    });
    cleanupTasks.push(() => lease.shutdown());
    const token = readRuntimeDaemonToken(lease.paths);
    await lease.transport.request('initialize', { profile: 'default', token });

    await lease.close();
    expect(readRuntimeDaemonState(lease.paths)).toMatchObject({ status: 'ready' });

    await lease.shutdown();
    expect(readRuntimeDaemonState(lease.paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(lease.paths.lockFile)).toBeUndefined();
  });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-manager-'));
  tempRoots.push(dir);
  return dir;
}

async function makeTestEndpoint(): Promise<RuntimeDaemonEndpoint> {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-manager-test-${randomUUID()}`,
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-manager-socket-'));
  tempRoots.push(dir);
  return {
    kind: 'unix',
    path: path.join(dir, 'daemon.sock'),
  };
}

function makeRuntime(
  runtimeId = 'runtime-manager-test',
  profile = 'default',
  runError?: Error,
): KodaXRuntime & { closed: boolean } {
  const runtime: KodaXRuntime & { closed: boolean } = {
    closed: false,
    identity: {
      runtimeId,
      mode: 'daemon',
      profile,
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
        return [];
      },
      async transcript() {
        return null;
      },
      async fork() {
        return null;
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
          phase: runError === undefined ? 'completed' : 'failed',
          ...(runError !== undefined ? { error: runError } : {}),
        };
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async await(runId) {
        return {
          runId,
          sessionId: 'session-1',
          phase: runError === undefined ? 'completed' : 'failed',
          ...(runError !== undefined ? { error: runError } : {}),
        };
      },
      async get(runId) {
        return {
          runId,
          sessionId: 'session-1',
          phase: 'completed',
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
      subscribe() {
        return { close() {} };
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
