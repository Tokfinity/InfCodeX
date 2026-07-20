import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upgradeMocks = vi.hoisted(() => ({
  acquireProcessLease: vi.fn(),
  enableDaemonOwner: vi.fn(),
  readLockOwner: vi.fn(),
}));

vi.mock('./runtime-daemon/process.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/process.js')>();
  return {
    ...actual,
    acquireRuntimeDaemonProcessLease: upgradeMocks.acquireProcessLease,
  };
});

vi.mock('./runtime-daemon/state.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/state.js')>();
  return {
    ...actual,
    enableRuntimeDaemonOwner: upgradeMocks.enableDaemonOwner,
    readRuntimeDaemonLockOwner: upgradeMocks.readLockOwner,
  };
});

import {
  connectKodaXRuntime,
  RuntimeDaemonCapabilityUpgradeError,
  type RuntimeDaemonManagementState,
  type RuntimeDaemonPreflight,
} from './sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './runtime-daemon/client.js';
import type { RuntimeDaemonProcessLease } from './runtime-daemon/process.js';
import type { RuntimeDaemonPaths } from './runtime-daemon/state.js';

const PROFILE = 'upgrade-test';
const RUNTIME_ID = 'runtime_legacy';

describe('Runtime daemon capability upgrade', () => {
  beforeEach(() => {
    upgradeMocks.acquireProcessLease.mockReset();
    upgradeMocks.enableDaemonOwner.mockReset();
    upgradeMocks.readLockOwner.mockReset();
  });

  it('fences and replaces an idle legacy daemon before returning the current runtime', async () => {
    const calls: string[] = [];
    const oldClose = vi.fn(async () => undefined);
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: oldClose,
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    const newTransport = createCurrentTransport(calls, newClose);
    const oldLease = createLease(oldTransport);
    const newLease = createLease(newTransport);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(oldLease)
      .mockResolvedValueOnce(newLease);
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    expect(upgradeMocks.enableDaemonOwner).toHaveBeenCalledWith(oldLease.paths);
    expect(oldClose).toHaveBeenCalled();

    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('returns a recoverable error without stopping a busy legacy daemon', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        blockers: ['queued_runs'],
        canStop: false,
      }),
      calls,
      close: vi.fn(async () => undefined),
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(
      createLease(oldTransport),
    );

    let failure: unknown;
    try {
      await connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeDaemonCapabilityUpgradeError);
    expect(failure).toMatchObject({
      code: 'daemon_capability_upgrade_required',
      recoverable: true,
      restartRequired: true,
      capability: 'runtimeAutoModeGuardrail',
      preflight: {
        blockers: ['queued_runs'],
        canStop: false,
      },
    });
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:close',
    ]);
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('restores daemon ownership when a stopped legacy daemon does not release its fence', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
    });
    const oldLease = createLease(oldTransport);
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(oldLease);
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
        daemonStartupTimeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      restartRequired: true,
    });

    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
    ]);
    expect(upgradeMocks.enableDaemonOwner).toHaveBeenCalledWith(oldLease.paths);
  });

  it('points recovery failures to the public SDK owner API', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(
      createLease(oldTransport),
    );
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });
    upgradeMocks.enableDaemonOwner.mockImplementation(() => {
      throw new Error('owner policy write failed');
    });

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      }),
    ).rejects.toThrow(
      'Call `enableKodaXDaemonOwner(...)` from the SDK and retry.',
    );

    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
    ]);
  });
});

function createLegacyTransport(input: {
  readonly preflight: RuntimeDaemonPreflight;
  readonly calls: string[];
  readonly close: () => Promise<void>;
  readonly onRollback?: () => void;
}): RuntimeDaemonClientTransport {
  return {
    async request(method) {
      input.calls.push(`old:${method}`);
      if (method === 'initialize') {
        return initializeResult(RUNTIME_ID, {
          daemonManagement: { version: 1 },
          runtimeAutoModeGuardrail: { version: 1, owner: 'session-runtime' },
        });
      }
      if (method === 'daemon.management.get') {
        return createManagementState(input.preflight);
      }
      if (method === 'daemon.rollbackToInline') {
        input.onRollback?.();
        return {
          accepted: true,
          runtimeId: RUNTIME_ID,
          revision: 8,
          ownerPolicy: {
            mode: 'inline',
            revision: 4,
            updatedAt: '2026-07-19T00:00:01.000Z',
          },
        };
      }
      throw new Error(`Unexpected legacy daemon request: ${method}`);
    },
    subscribe() {
      return { close() {} };
    },
    async close() {
      input.calls.push('old:close');
      await input.close();
    },
  };
}

function createCurrentTransport(
  calls: string[],
  close: () => Promise<void>,
): RuntimeDaemonClientTransport {
  return {
    async request(method) {
      calls.push(`new:${method}`);
      if (method !== 'initialize') {
        throw new Error(`Unexpected current daemon request: ${method}`);
      }
      return initializeResult('runtime_current', {
        runtimeAutoModeGuardrail: { version: 2, owner: 'session-runtime' },
      });
    },
    subscribe() {
      return { close() {} };
    },
    async close() {
      calls.push('new:close');
      await close();
    },
  };
}

function initializeResult(
  runtimeId: string,
  capabilities: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    identity: {
      runtimeId,
      mode: 'daemon',
      profile: PROFILE,
      startedAt: '2026-07-19T00:00:00.000Z',
      version: '0.7.73-test',
      isolation: 'process',
    },
    capabilities,
  };
}

function createManagementState(
  preflight: RuntimeDaemonPreflight,
): RuntimeDaemonManagementState {
  return {
    runtimeId: RUNTIME_ID,
    revision: 7,
    ownerPolicy: {
      mode: 'daemon',
      revision: 3,
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    owner: {
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    },
    preflight,
  };
}

function createPreflight(
  overrides: Partial<RuntimeDaemonPreflight> = {},
): RuntimeDaemonPreflight {
  const activeAgentTurns: RuntimeDaemonPreflight['activeAgentTurns'] = [];
  return {
    runtimeId: RUNTIME_ID,
    clientCount: 1,
    activeRuns: [],
    queuedRuns: [],
    activeWorkflows: [],
    activeAgentTurns,
    activeAgentTasks: activeAgentTurns,
    pendingPermissions: [],
    pendingUserInputs: [],
    blockers: [],
    canStop: true,
    ...overrides,
  };
}

function createLease(
  transport: RuntimeDaemonClientTransport,
): RuntimeDaemonProcessLease {
  const rootDir = path.join(
    'C:',
    'kodax-upgrade-test',
    '.kodax',
    'runtime',
    PROFILE,
  );
  const paths: RuntimeDaemonPaths = {
    profile: PROFILE,
    configHome: path.join('C:', 'kodax-upgrade-test', '.kodax'),
    rootDir,
    stateFile: path.join(rootDir, 'daemon.json'),
    lockFile: path.join(rootDir, 'daemon.lock'),
    tokenFile: path.join(rootDir, 'daemon.token'),
    logFile: path.join(rootDir, 'daemon.log'),
    runsDir: path.join(rootDir, 'runs'),
    eventsDir: path.join(rootDir, 'events'),
    ownerPolicyFile: path.join(rootDir, 'owner-policy.json'),
    ownerPolicyLockFile: path.join(rootDir, 'owner-policy.lock'),
  };
  return {
    transport,
    paths,
    endpoint: { kind: 'pipe', path: '\\\\.\\pipe\\kodax-upgrade-test' },
    ownsHost: false,
    async close() {
      await transport.close?.();
    },
    async shutdown() {
      await transport.close?.();
    },
  };
}
