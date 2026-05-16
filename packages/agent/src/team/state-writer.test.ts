/**
 * FEATURE_125 (v0.7.41) — state-writer hermetic tests.
 *
 * No real fs. Every test injects an `InMemoryFs` and a controllable
 * clock, then asserts file shape / lifecycle invariants.
 *
 * TODO(FEATURE_125-S6): add `state-writer.integration.test.ts` that
 * drives the real fs adapter with a unique temp dir per test. Deferred
 * to S6 alongside the multi-process integration test so both real-fs
 * surfaces (writer + discovery) are covered in one file.
 */

import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SessionStateSnapshot,
  type StateWriterFs,
  type SessionMeta,
  createStateWriter,
} from './state-writer.js';

// Centralize path construction so assertions stay cross-platform.
const INSTANCES_ROOT = path.join('/root', 'instances');
const PID_DIR = path.join(INSTANCES_ROOT, '999');
const PATHS = {
  pidDir: PID_DIR,
  meta: path.join(PID_DIR, 'meta.json'),
  state: path.join(PID_DIR, 'state.json'),
  heartbeat: path.join(PID_DIR, 'heartbeat'),
};

/** In-memory fs implementation that captures all writes for inspection. */
class InMemoryFs implements StateWriterFs {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly mtimes = new Map<string, number>();
  /** Track every write order so tests can assert atomic-write semantics. */
  readonly writeLog: Array<{ op: string; path: string }> = [];

  mkdirSync(dirPath: string): void {
    this.directories.add(dirPath);
    this.writeLog.push({ op: 'mkdir', path: dirPath });
  }
  writeFileSync(filePath: string, data: string): void {
    this.files.set(filePath, data);
    this.writeLog.push({ op: 'write', path: filePath });
  }
  atomicWriteSync(filePath: string, data: string): void {
    // Simulate the tmp+rename pair.
    this.files.set(`${filePath}.tmp`, data);
    this.files.delete(`${filePath}.tmp`);
    this.files.set(filePath, data);
    this.writeLog.push({ op: 'atomicWrite', path: filePath });
  }
  utimesSync(filePath: string, _atime: number, mtime: number): void {
    this.mtimes.set(filePath, mtime);
    this.writeLog.push({ op: 'utimes', path: filePath });
  }
  rmSync(dirPath: string): void {
    this.directories.delete(dirPath);
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(`${dirPath}/`) || key.startsWith(`${dirPath}\\`)) {
        this.files.delete(key);
      }
    }
    for (const key of Array.from(this.mtimes.keys())) {
      if (key.startsWith(`${dirPath}/`) || key.startsWith(`${dirPath}\\`)) {
        this.mtimes.delete(key);
      }
    }
    this.writeLog.push({ op: 'rm', path: dirPath });
  }
  existsSync(targetPath: string): boolean {
    return this.files.has(targetPath) || this.directories.has(targetPath);
  }
}

const baseMeta: SessionMeta = {
  cwd: '/users/test/repo',
  startedAt: 1_700_000_000_000,
  gitBranch: 'main',
};

const baseState: SessionStateSnapshot = {
  agentPhase: 'idle',
  currentIntent: 'starting up',
};

function findStateFile(fs: InMemoryFs): { path: string; parsed: Record<string, unknown> } {
  const entry = Array.from(fs.files.entries()).find(([k]) => k.endsWith('state.json'));
  if (!entry) throw new Error('state.json not written');
  return { path: entry[0], parsed: JSON.parse(entry[1]) as Record<string, unknown> };
}

describe('createStateWriter — registration', () => {
  let fs: InMemoryFs;
  let now: number;
  let clock: () => number;

  beforeEach(() => {
    fs = new InMemoryFs();
    now = 1_700_000_000_000;
    clock = () => now;
  });

  it('creates the instance directory + meta.json + state.json + heartbeat at registration time', () => {
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });

    expect(writer.pid).toBe(999);
    expect(writer.instanceDir).toBe(PATHS.pidDir);
    expect(fs.directories.has(PATHS.pidDir)).toBe(true);
    expect(fs.files.has(PATHS.meta)).toBe(true);
    expect(fs.files.has(PATHS.state)).toBe(true);
    expect(fs.files.has(PATHS.heartbeat)).toBe(true);
    expect(fs.mtimes.has(PATHS.heartbeat)).toBe(true);
  });

  it('writes meta.json with the static SessionMeta payload', () => {
    createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    const meta = JSON.parse(fs.files.get(PATHS.meta)!);
    expect(meta).toEqual(baseMeta);
  });

  it('writes state.json with version + pid + meta + initial state + updatedAt', () => {
    createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    const { parsed } = findStateFile(fs);
    expect(parsed.version).toBe('1');
    expect(parsed.pid).toBe(999);
    expect(parsed.updatedAt).toBe(now);
    expect(parsed.meta).toEqual(baseMeta);
    expect(parsed.agentPhase).toBe('idle');
    expect(parsed.currentIntent).toBe('starting up');
  });

  it('uses atomicWriteSync for state.json (not bare writeFileSync)', () => {
    createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    const stateOps = fs.writeLog.filter((op) => op.path.endsWith('state.json'));
    expect(stateOps.every((op) => op.op === 'atomicWrite')).toBe(true);
  });
});

describe('createStateWriter — update()', () => {
  let fs: InMemoryFs;
  let now: number;
  let clock: () => number;

  beforeEach(() => {
    fs = new InMemoryFs();
    now = 1_700_000_000_000;
    clock = () => now;
  });

  it('merges patch fields into state and re-writes state.json synchronously', () => {
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });

    now = now + 5000;
    writer.update({ agentPhase: 'running_tool', activeFiles: ['packages/foo/bar.ts'] });

    const { parsed } = findStateFile(fs);
    expect(parsed.agentPhase).toBe('running_tool');
    expect(parsed.activeFiles).toEqual(['packages/foo/bar.ts']);
    // Patch must NOT clobber unrelated fields.
    expect(parsed.currentIntent).toBe('starting up');
    expect(parsed.updatedAt).toBe(now);
  });

  it('touches the heartbeat on update so siblings see a fresh mtime immediately', () => {
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    const initialMtime = fs.mtimes.get(PATHS.heartbeat);

    now = now + 1234;
    writer.update({ currentIntent: 'doing work' });

    expect(fs.mtimes.get(PATHS.heartbeat)).not.toBe(initialMtime);
    expect(fs.mtimes.get(PATHS.heartbeat)).toBe(now / 1000);
  });

  it('serializes activeFiles as a fresh array (frozen-input safe)', () => {
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    const frozenInput = Object.freeze(['a.ts', 'b.ts']);
    writer.update({ activeFiles: frozenInput });
    const { parsed } = findStateFile(fs);
    expect(parsed.activeFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('carries currentTodoSummary through to state.json verbatim (FEATURE_170 TODO-INFRA-1 hook)', () => {
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    writer.update({
      currentTodoSummary: {
        inProgress: 'Refactor auth module',
        pendingCount: 3,
        completedCount: 2,
      },
    });
    const { parsed } = findStateFile(fs);
    expect(parsed.currentTodoSummary).toEqual({
      inProgress: 'Refactor auth module',
      pendingCount: 3,
      completedCount: 2,
    });
  });

  it('swallows fs failures so a transient write error does not crash the agent loop', () => {
    // Registration must succeed (meta/state/heartbeat write through). Swap in a
    // failing atomicWriteSync for the post-registration phase to simulate a
    // transient OS-level error (EBUSY, drive briefly unavailable on Windows).
    const hybridFs: StateWriterFs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs: hybridFs,
      instancesRoot: INSTANCES_ROOT,
    });
    (hybridFs as { atomicWriteSync: StateWriterFs['atomicWriteSync'] }).atomicWriteSync = () => {
      throw new Error('EBUSY');
    };
    expect(() => writer.update({ agentPhase: 'running_tool' })).not.toThrow();
    // In-memory state must still reflect the patch despite the disk failure —
    // the agent loop sees the up-to-date state; only sibling sessions are
    // briefly behind until the next interval tick retries.
    expect(writer.getState().agentPhase).toBe('running_tool');
  });
});

describe('createStateWriter — heartbeat interval', () => {
  let fs: InMemoryFs;

  beforeEach(() => {
    fs = new InMemoryFs();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches the heartbeat on every interval tick', () => {
    let now = 1_700_000_000_000;
    const clock = () => now;
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
      heartbeatIntervalMs: 100,
    });

    const mtimeAfterRegistration = fs.mtimes.get(PATHS.heartbeat);

    now += 100;
    vi.advanceTimersByTime(100);
    expect(fs.mtimes.get(PATHS.heartbeat)).not.toBe(mtimeAfterRegistration);
    const mtime1 = fs.mtimes.get(PATHS.heartbeat);

    now += 100;
    vi.advanceTimersByTime(100);
    expect(fs.mtimes.get(PATHS.heartbeat)).not.toBe(mtime1);

    void writer.shutdown();
  });

  it('refreshes state.json on every interval tick (updatedAt advances)', () => {
    let now = 1_700_000_000_000;
    const clock = () => now;
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs,
      instancesRoot: INSTANCES_ROOT,
      heartbeatIntervalMs: 50,
    });

    const before = findStateFile(fs).parsed.updatedAt as number;
    now += 50;
    vi.advanceTimersByTime(50);
    const after = findStateFile(fs).parsed.updatedAt as number;
    expect(after).toBeGreaterThan(before);

    void writer.shutdown();
  });

  it('a flaky interval tick (write throws) does not kill the timer', () => {
    let now = 1_700_000_000_000;
    const clock = () => now;
    let throwOnNextWrite = false;
    const flaky = new InMemoryFs();
    const origAtomic = flaky.atomicWriteSync.bind(flaky);
    flaky.atomicWriteSync = (filePath: string, data: string) => {
      if (throwOnNextWrite) {
        throwOnNextWrite = false;
        throw new Error('EBUSY');
      }
      origAtomic(filePath, data);
    };
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      clock,
      fs: flaky,
      instancesRoot: INSTANCES_ROOT,
      heartbeatIntervalMs: 50,
    });
    const mtimeAfterRegistration = flaky.mtimes.get(PATHS.heartbeat);

    throwOnNextWrite = true;
    now += 50;
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    // The state.json write threw, so updatedAt may or may not have advanced —
    // but the heartbeat touch comes BEFORE writeState in the tick callback,
    // so the heartbeat mtime SHOULD still have advanced on the first tick.

    // Second tick: must succeed, must touch heartbeat with a fresh mtime.
    now += 50;
    vi.advanceTimersByTime(50);
    const finalMtime = flaky.mtimes.get(PATHS.heartbeat);
    expect(finalMtime).toBeGreaterThan(mtimeAfterRegistration ?? 0);
    // updatedAt on disk must also have advanced — proves writeState ran on
    // the second (recovered) tick.
    expect(findStateFile(flaky).parsed.updatedAt).toBe(now);

    void writer.shutdown();
  });
});

describe('createStateWriter — shutdown()', () => {
  it('clears the timer and removes the instance directory', async () => {
    const fs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    expect(fs.directories.has(PATHS.pidDir)).toBe(true);

    await writer.shutdown();

    expect(fs.directories.has(PATHS.pidDir)).toBe(false);
    expect(fs.files.has(PATHS.state)).toBe(false);
    expect(fs.files.has(PATHS.meta)).toBe(false);
    expect(fs.files.has(PATHS.heartbeat)).toBe(false);
  });

  it('is idempotent — calling shutdown twice is harmless', async () => {
    const fs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    await writer.shutdown();
    await expect(writer.shutdown()).resolves.toBeUndefined();
  });

  it('drops further update() / refresh() calls after shutdown (no resurrection)', async () => {
    const fs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    await writer.shutdown();
    writer.update({ agentPhase: 'running_tool' });
    writer.refresh();
    expect(fs.directories.has(PATHS.pidDir)).toBe(false);
    expect(fs.files.has(PATHS.state)).toBe(false);
  });

  it('tolerates the directory already being gone (peer cleanup race)', async () => {
    const fs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    // Peer's discovery scan declared us stale and already cleaned up.
    fs.rmSync(PATHS.pidDir, { recursive: true, force: true });
    await expect(writer.shutdown()).resolves.toBeUndefined();
  });
});

describe('createStateWriter — getState()', () => {
  it('returns the in-memory snapshot (reflects the last update)', () => {
    const fs = new InMemoryFs();
    const writer = createStateWriter({
      pid: 999,
      meta: baseMeta,
      initialState: baseState,
      fs,
      instancesRoot: INSTANCES_ROOT,
    });
    expect(writer.getState()).toEqual(baseState);
    writer.update({ agentPhase: 'running_tool', activeFiles: ['x.ts'] });
    expect(writer.getState()).toEqual({
      agentPhase: 'running_tool',
      currentIntent: 'starting up',
      activeFiles: ['x.ts'],
    });
  });
});
