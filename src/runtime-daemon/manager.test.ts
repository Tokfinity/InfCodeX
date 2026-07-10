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
import { acquireRuntimeDaemonLease } from './manager.js';
import {
  readRuntimeDaemonLockOwner,
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
    cleanupTasks.push(() => firstLease.close(), () => secondLease.close());

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
    cleanupTasks.push(() => firstLease.close(), () => secondLease.close());

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
    cleanupTasks.push(() => lease.close());

    expect(lease.ownsHost).toBe(true);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: runtime.identity.runtimeId,
    });
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
          phase: 'completed',
        };
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async await(runId) {
        return { runId, sessionId: 'session-1', phase: 'completed' };
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
