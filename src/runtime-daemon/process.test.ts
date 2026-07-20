import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertRuntimeDaemonCliEntryAvailable,
  createRuntimeDaemonServeEnvironment,
  daemonServeExecArgv,
  waitForHealthyDaemonStartup,
  type RuntimeDaemonStartupProcess,
} from './process.js';
import {
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
} from './state.js';

describe('runtime daemon child process environment', () => {
  it('does not retain the Electron bootstrap variable in the daemon environment', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '0',
      KODAX_HOME: 'parent-config-home',
      PARENT_SENTINEL: 'preserved',
    };

    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: 'runtime-home',
      parentEnv,
    });

    expect(childEnv).toMatchObject({
      KODAX_DAEMON_SERVE: '1',
      KODAX_HOME: path.join('runtime-home', '.kodax'),
      PARENT_SENTINEL: 'preserved',
    });
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(parentEnv).toEqual({
      ELECTRON_RUN_AS_NODE: '0',
      KODAX_HOME: 'parent-config-home',
      PARENT_SENTINEL: 'preserved',
    });
  });

  it('preserves the ordinary Node child environment contract', () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: 'runtime-home',
      parentEnv: { PARENT_SENTINEL: 'preserved' },
    });

    expect(childEnv).toMatchObject({
      KODAX_DAEMON_SERVE: '1',
      KODAX_HOME: path.join('runtime-home', '.kodax'),
      PARENT_SENTINEL: 'preserved',
    });
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('passes an arbitrary config home through to the daemon child unchanged', () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: 'runtime-home',
      configHome: 'custom-config-home',
      parentEnv: {},
    });

    expect(childEnv.KODAX_HOME).toBe('custom-config-home');
  });

  it('fails before spawning when an embedder bundle omitted the daemon CLI sidecar', () => {
    const missingEntry = path.join('missing-kodax-package', 'dist', 'kodax_cli.js');

    expect(() => assertRuntimeDaemonCliEntryAvailable(undefined)).not.toThrow();
    expect(() => assertRuntimeDaemonCliEntryAvailable(missingEntry)).toThrow(
      /Keep the published KodaX dist files external/,
    );
  });

  it('does not inherit test-runner loaders into a source daemon child', () => {
    expect(daemonServeExecArgv([
      '--import', 'tsx',
      '--import', 'vitest/worker',
      '--require', './scripts/production-env.cjs',
      '--require', 'vitest/register',
      '--loader', 'some-test-loader',
      '--max-old-space-size=4096',
      '--enable-source-maps',
    ], true)).toEqual([
      '--require', './scripts/production-env.cjs',
      '--max-old-space-size=4096',
      '--enable-source-maps',
      '--import', 'tsx',
    ]);
  });
});

describe('runtime daemon child startup', () => {
  const paths = resolveRuntimeDaemonPathsFromConfigHome('runtime-config-home', 'default');
  const missingHealth = async () => ({
    pidAlive: false,
    endpointReachable: false,
    identityMatches: false,
  });
  const healthy = (pid: number) => async () => ({
    state: {
      runtimeId: `runtime-${pid}`,
      profile: 'default',
      pid,
      startedAt: '2026-07-17T00:00:00.000Z',
      endpoint: 'runtime-endpoint',
      version: '0.7.71',
      status: 'ready' as const,
    },
    pidAlive: true,
    endpointReachable: true,
    identityMatches: true,
  });

  it('fails immediately and reclaims the child when it exits before becoming healthy', async () => {
    let reportExit: ((exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 321,
      exit: new Promise((resolve) => { reportExit = resolve; }),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    const waiting = waitForHealthyDaemonStartup(paths, {
      startupTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
    }, child, missingHealth);
    reportExit?.({ code: 17, signal: null });

    await expect(waiting).rejects.toThrow(/exited.*code 17/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('reclaims a still-running child when startup reaches its timeout', async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 654,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    await expect(waitForHealthyDaemonStartup(paths, {
      startupTimeoutMs: 0,
      pollIntervalMs: 1,
    }, child, missingHealth)).rejects.toThrow(/timed out waiting/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('reclaims a still-starting child when startup is cancelled', async () => {
    const controller = new AbortController();
    const child: RuntimeDaemonStartupProcess = {
      pid: 655,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    const waiting = waitForHealthyDaemonStartup(paths, {
      startupTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
      startupSignal: controller.signal,
    }, child, missingHealth);
    controller.abort();

    await expect(waiting).rejects.toThrow(/startup cancelled/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('unrefs the spawned child only after that child publishes healthy state', async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 777,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    await expect(waitForHealthyDaemonStartup(paths, {}, child, healthy(777)))
      .resolves.toMatchObject({ state: { pid: 777 } });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.terminate).not.toHaveBeenCalled();
  });

  it('reclaims its spawned child when another daemon wins the startup race', async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    await expect(waitForHealthyDaemonStartup(paths, {}, child, healthy(999)))
      .resolves.toMatchObject({ state: { pid: 999 } });
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('waits for the competing owner when its spawned child exits after losing the race', async () => {
    const configHome = mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-startup-race-'));
    const racePaths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'race');
    const winnerPid = 999;
    const lock = tryAcquireRuntimeDaemonLock(racePaths, {
      runtimeId: `runtime-${winnerPid}`,
      pid: winnerPid,
      createdAt: '2026-07-17T00:00:00.000Z',
      kind: 'daemon',
    });
    expect(lock).toBeDefined();
    let reportExit: ((exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise((resolve) => { reportExit = resolve; }),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const competingHealth = async () => {
      healthChecks += 1;
      return healthChecks === 1 ? missingHealth() : healthy(winnerPid)();
    };

    try {
      const waiting = waitForHealthyDaemonStartup(racePaths, {
        startupTimeoutMs: 1_000,
        pollIntervalMs: 1,
      }, child, competingHealth);
      reportExit?.({ code: 1, signal: null });

      await expect(waiting).resolves.toMatchObject({ state: { pid: winnerPid } });
      expect(child.terminate).toHaveBeenCalledOnce();
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it('allows a clean loser exit a bounded grace period for winner publication', async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: Promise.resolve({ code: 0, signal: null }),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const delayedWinner = async () => {
      healthChecks += 1;
      return healthChecks < 3 ? missingHealth() : healthy(999)();
    };

    await expect(waitForHealthyDaemonStartup(paths, {
      startupTimeoutMs: 1_000,
      pollIntervalMs: 1,
    }, child, delayedWinner)).resolves.toMatchObject({ state: { pid: 999 } });
    expect(healthChecks).toBeGreaterThanOrEqual(3);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });
});
