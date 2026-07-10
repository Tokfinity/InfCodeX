import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimRuntimeDaemonOwnership,
  classifyRuntimeDaemonHealth,
  createRuntimeDaemonToken,
  normalizeRuntimeDaemonProfile,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  releaseRuntimeDaemonLock,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState,
  writeRuntimeDaemonToken,
  type RuntimeDaemonState,
} from './state.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-state-'));
  tempRoots.push(dir);
  return dir;
}

function state(overrides: Partial<RuntimeDaemonState> = {}): RuntimeDaemonState {
  return {
    runtimeId: 'runtime-1',
    profile: 'default',
    pid: 1234,
    startedAt: '2026-07-09T00:00:00.000Z',
    endpoint: 'pipe://kodax-runtime-default',
    version: '0.7.66',
    status: 'ready',
    ...overrides,
  };
}

describe('runtime daemon state paths', () => {
  it('resolves profile-scoped daemon files under the KodaX runtime directory', () => {
    const paths = resolveRuntimeDaemonPaths('C:/Users/test', 'space');

    expect(paths.profile).toBe('space');
    expect(paths.stateFile.replaceAll('\\', '/')).toContain('/.kodax/runtime/daemon/space/daemon.json');
    expect(paths.lockFile.endsWith('daemon.lock')).toBe(true);
    expect(paths.tokenFile.endsWith('daemon.token')).toBe(true);
  });

  it('rejects path-like profile names', () => {
    expect(() => normalizeRuntimeDaemonProfile('../escape')).toThrow(/Invalid runtime daemon profile/);
    expect(() => normalizeRuntimeDaemonProfile('space profile')).toThrow(/Invalid runtime daemon profile/);
  });

  it('round-trips daemon state with validation', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const expected = state();

    writeRuntimeDaemonState(paths, expected);

    expect(readRuntimeDaemonState(paths)).toEqual(expected);
  });

  it('treats malformed daemon state as missing instead of throwing', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.stateFile, '{not-json', 'utf8');

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
  });

  it('stores a profile-scoped local daemon token with user-only permissions where supported', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const token = createRuntimeDaemonToken();

    writeRuntimeDaemonToken(paths, token);

    expect(token).toMatch(/^dt_[a-f0-9]+$/);
    expect(readRuntimeDaemonToken(paths)).toBe(token);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    }
  });
});

describe('runtime daemon lock ownership', () => {
  it('allows exactly one atomic lock owner', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const first = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-1',
      pid: 111,
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    const second = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-2',
      pid: 222,
      createdAt: '2026-07-09T00:00:01.000Z',
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(first ? releaseRuntimeDaemonLock(first) : false).toBe(true);
  });

  it('does not release a lock owned by another runtime', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const owner = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-1',
      pid: 111,
      createdAt: '2026-07-09T00:00:00.000Z',
    });

    expect(owner).toBeDefined();
    expect(releaseRuntimeDaemonLock({
      file: paths.lockFile,
      owner: {
        runtimeId: 'runtime-2',
        pid: 222,
        createdAt: '2026-07-09T00:00:01.000Z',
      },
    })).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(owner ? releaseRuntimeDaemonLock(owner) : false).toBe(true);
  });

  it('treats malformed lock ownership as unreadable instead of throwing', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, '{not-json', 'utf8');

    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });
});

describe('runtime daemon health classification', () => {
  it('classifies the documented healthy, stale, unhealthy, and mismatch cases', () => {
    const current = state();

    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    })).toBe('healthy');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    })).toBe('stale');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    })).toBe('unhealthy');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: false,
    })).toBe('mismatch');
  });
});

describe('runtime daemon ownership claims', () => {
  it('attaches to a healthy daemon instead of taking the lock', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    });

    expect(decision).toMatchObject({ kind: 'attach', state: current });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('claims an atomic lock when no daemon exists and makes a racing claimant wait', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');

    const first = claimRuntimeDaemonOwnership(paths, owner('runtime-1'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });
    const second = claimRuntimeDaemonOwnership(paths, owner('runtime-2'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(first.kind).toBe('claim');
    expect(second).toMatchObject({
      kind: 'wait',
      lockOwner: { runtimeId: 'runtime-1' },
    });
  });

  it('claims a missing profile when an old lock owner is no longer alive', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
      lockOwnerPidAlive: false,
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('clears malformed missing-state locks before claiming the profile', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, '{not-json', 'utf8');

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('cleans verified stale ownership before claiming the profile', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: stale,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('waits for a live transitional daemon instead of marking it unhealthy', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const starting = state({ runtimeId: 'runtime-starting', status: 'starting' });
    writeRuntimeDaemonState(paths, starting);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-starting', 777))).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: starting,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision).toMatchObject({
      kind: 'wait',
      state: starting,
      lockOwner: { runtimeId: 'runtime-starting' },
    });
    expect(readRuntimeDaemonState(paths)).toEqual(starting);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-starting' });
  });

  it('does not delete ownership for live unhealthy or mismatched daemon states', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-live', pid: 777 });
    writeRuntimeDaemonState(paths, current);
    const liveLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-live', 777));
    expect(liveLock).toBeDefined();

    const unhealthy = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    });
    const mismatch = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: false,
    });

    expect(unhealthy).toMatchObject({ kind: 'unhealthy', health: 'unhealthy' });
    expect(mismatch).toMatchObject({ kind: 'unhealthy', health: 'mismatch' });
    expect(readRuntimeDaemonState(paths)).toEqual(current);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-live' });
  });
});

function owner(runtimeId: string, pid = 111): { runtimeId: string; pid: number; createdAt: string } {
  return {
    runtimeId,
    pid,
    createdAt: '2026-07-09T00:00:00.000Z',
  };
}
