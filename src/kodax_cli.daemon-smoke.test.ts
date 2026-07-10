import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState,
} from './runtime-daemon/state.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    stopDaemonBestEffort(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('daemon CLI smoke', () => {
  it('prints JSON for real start/stop commands and releases daemon state', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-smoke-'));
    tempRoots.push(homeDir);
    const profile = `smoke-${process.pid}-${Date.now()}`;

    const start = runDaemonCommand([
      'start',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--provider',
      'mock-provider',
      '--timeout-ms',
      '12000',
      '--json',
    ]);
    expect(start).toMatchObject({
      started: true,
      health: 'healthy',
    });
    expect(start.state).toMatchObject({
      profile,
      status: 'ready',
    });

    const status = runDaemonCommand([
      'status',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--json',
    ]);
    expect(status).toMatchObject({
      profile,
      health: 'healthy',
      runtime: {
        ok: true,
        summary: {
          sessions: 0,
          runs: 0,
          activeRuns: 0,
          queuedRuns: 0,
          pendingPermissions: 0,
          workflows: 0,
        },
      },
    });

    const logs = runDaemonCommand([
      'logs',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--json',
    ]);
    expect(logs).toMatchObject({
      profile,
      exists: true,
    });
    expect(Array.isArray(logs.lines) ? logs.lines.join('\n') : '').toContain('Runtime daemon ready.');
    expect(String(logs.logFile)).toContain(path.join('.kodax', 'runtime', 'daemon', profile, 'daemon.log'));

    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { defaultRuntimeDaemonEndpoint } = await import('./runtime-daemon/transport.js');
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      profile,
      homeDir,
      daemonEndpoint: defaultRuntimeDaemonEndpoint(profile, homeDir),
      autoStartDaemon: false,
    });
    try {
      await expect(runtime.config.patch({
        provider: 'mock-provider',
        model: 'daemon-home-model',
      })).resolves.toMatchObject({
        provider: 'mock-provider',
        model: 'daemon-home-model',
      });
    } finally {
      await runtime.close();
    }
    const configFile = path.join(homeDir, '.kodax', 'config.json');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({
      provider: 'mock-provider',
      model: 'daemon-home-model',
    });

    const restart = runDaemonCommand([
      'restart',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--provider',
      'mock-provider',
      '--timeout-ms',
      '12000',
      '--json',
    ]);
    expect(restart).toMatchObject({
      restarted: true,
      stop: {
        stopped: true,
      },
      start: {
        started: true,
        health: 'healthy',
      },
    });

    const stop = runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '12000',
      '--json',
    ]);
    expect(stop).toEqual({
      stopped: true,
      health: 'missing',
      state: null,
    });

    const stateFile = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile, 'daemon.json');
    const lockFile = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile, 'daemon.lock');
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 90_000);

  it('force-cleans stale daemon ownership without a live owner process', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-force-stale-'));
    tempRoots.push(homeDir);
    const profile = `force-stale-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    writeRuntimeDaemonState(paths, {
      runtimeId: 'runtime-stale',
      profile,
      pid: 999_999_999,
      startedAt: '2026-07-09T00:00:00.000Z',
      endpoint: process.platform === 'win32'
        ? '\\\\.\\pipe\\kodax-runtime-force-stale-missing'
        : path.join(os.tmpdir(), 'kodax-runtime-force-stale-missing.sock'),
      version: '0.7.66',
      status: 'ready',
    });
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-stale',
      pid: 999_999_999,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    const stop = runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '3000',
      '--force',
      '--json',
    ]);

    expect(stop).toMatchObject({
      stopped: true,
      forced: true,
      health: 'missing',
      state: null,
    });
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  }, 30_000);

  it('refuses force stop when a live pid cannot be verified as the daemon owner', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-force-live-'));
    tempRoots.push(homeDir);
    const profile = `force-live-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    writeRuntimeDaemonState(paths, {
      runtimeId: 'runtime-live',
      profile,
      pid: process.pid,
      startedAt: '2026-07-09T00:00:00.000Z',
      endpoint: process.platform === 'win32'
        ? '\\\\.\\pipe\\kodax-runtime-force-live-missing'
        : path.join(os.tmpdir(), 'kodax-runtime-force-live-missing.sock'),
      version: '0.7.66',
      status: 'ready',
    });
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-live',
      pid: process.pid,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    const stop = runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '3000',
      '--force',
      '--json',
    ]);

    expect(stop).toMatchObject({
      stopped: false,
      forced: true,
      reason: 'unverified_owner',
      health: 'unhealthy',
      state: {
        runtimeId: 'runtime-live',
        pid: process.pid,
      },
    });
    expect(fs.existsSync(paths.stateFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
  }, 30_000);
});

function runDaemonCommand(args: readonly string[]): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [
    '--import',
    'tsx',
    path.join(process.cwd(), 'src', 'kodax_cli.ts'),
    'daemon',
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      KODAX_TRACING: '0',
    },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function stopDaemonBestEffort(homeDir: string): void {
  const daemonRoot = path.join(homeDir, '.kodax', 'runtime', 'daemon');
  if (!fs.existsSync(daemonRoot)) return;
  for (const entry of fs.readdirSync(daemonRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profile = entry.name;
    try {
      runDaemonCommand([
        'stop',
        '--home',
        homeDir,
        '--profile',
        profile,
        '--timeout-ms',
        '3000',
        '--json',
      ]);
    } catch {
      const stateFile = path.join(daemonRoot, profile, 'daemon.json');
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { pid?: unknown };
        if (typeof state.pid === 'number') {
          process.kill(state.pid, 'SIGTERM');
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
