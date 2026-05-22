/**
 * FEATURE_125 (v0.7.41) — instance-discovery hermetic tests.
 *
 * Drives discoverInstances() through an in-memory fs that simulates
 * every production failure mode: missing root, empty root, mixed
 * stale/alive peers, corrupt state.json, partial writes, unknown
 * version, vanished heartbeat, peer pid mismatch, and reap-on-startup.
 */

import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverInstances, type InstanceDiscoveryFs } from './instance-discovery.js';
import type { PersistedSessionState, SessionMeta } from './state-writer.js';

const INSTANCES_ROOT = path.join('/root', 'instances');

const baseMeta: SessionMeta = {
  cwd: '/users/test/repo',
  startedAt: 1_700_000_000_000,
  gitBranch: 'main',
};

function makeState(overrides: Partial<PersistedSessionState> & { pid: number }): PersistedSessionState {
  return {
    version: '1',
    pid: overrides.pid,
    updatedAt: 1_700_000_000_000,
    meta: baseMeta,
    agentPhase: 'idle',
    ...overrides,
  };
}

class FakeFs implements InstanceDiscoveryFs {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  readonly mtimes = new Map<string, number>();
  readonly removedDirs: string[] = [];
  /** Force a specific call to throw, e.g. for mid-write race simulation. */
  failNextRead?: (filePath: string) => Error | null;

  addInstance(pid: number, opts: {
    heartbeatMtimeMs: number;
    stateJson?: string;
    skipHeartbeat?: boolean;
    skipStateFile?: boolean;
  }): void {
    const dir = path.join(INSTANCES_ROOT, String(pid));
    this.directories.add(INSTANCES_ROOT);
    this.directories.add(dir);
    if (!opts.skipHeartbeat) {
      this.files.set(path.join(dir, 'heartbeat'), '');
      this.mtimes.set(path.join(dir, 'heartbeat'), opts.heartbeatMtimeMs);
    }
    if (!opts.skipStateFile) {
      this.files.set(
        path.join(dir, 'state.json'),
        opts.stateJson ?? JSON.stringify(makeState({ pid })),
      );
    }
  }

  existsSync(p: string): boolean {
    return this.directories.has(p) || this.files.has(p);
  }
  readdirSync(p: string): string[] {
    const prefix = `${p}${path.sep}`;
    const entries = new Set<string>();
    for (const dir of this.directories) {
      if (dir.startsWith(prefix)) {
        const remainder = dir.slice(prefix.length);
        const first = remainder.split(path.sep)[0];
        if (first) entries.add(first);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const remainder = file.slice(prefix.length);
        const first = remainder.split(path.sep)[0];
        if (first) entries.add(first);
      }
    }
    return Array.from(entries);
  }
  statMtimeMs(p: string): number | null {
    return this.mtimes.get(p) ?? null;
  }
  readFileSync(p: string, _enc: 'utf8'): string {
    const planned = this.failNextRead?.(p);
    if (planned) {
      this.failNextRead = undefined;
      throw planned;
    }
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  rmSync(p: string): void {
    this.removedDirs.push(p);
    this.directories.delete(p);
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(`${p}${path.sep}`)) this.files.delete(key);
    }
    for (const key of Array.from(this.mtimes.keys())) {
      if (key.startsWith(`${p}${path.sep}`)) this.mtimes.delete(key);
    }
  }
}

const NOW = 1_700_000_500_000; // canonical "now" for the fake clock

describe('discoverInstances — root directory does not exist', () => {
  it('returns [] without throwing (first session ever)', () => {
    const fs = new FakeFs();
    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
    });
    expect(result).toEqual([]);
  });
});

describe('discoverInstances — basic enumeration', () => {
  it('returns all alive siblings (heartbeat within threshold)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 5000 });
    fs.addInstance(300, { heartbeatMtimeMs: NOW - 100 });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999, // not in the set
    });

    expect(result.map((i) => i.pid).sort()).toEqual([100, 200, 300]);
  });

  it('orders results freshest-first (heartbeat mtime descending)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 10_000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(300, { heartbeatMtimeMs: NOW - 5000 });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([200, 300, 100]);
  });

  it('excludes the caller pid', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(300, { heartbeatMtimeMs: NOW - 1000 });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 200,
    });

    expect(result.map((i) => i.pid).sort()).toEqual([100, 300]);
  });

  it('skips entries whose name is not a numeric pid', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    // Stray non-numeric entries: .DS_Store, README, manual rename.
    fs.directories.add(INSTANCES_ROOT);
    fs.files.set(path.join(INSTANCES_ROOT, '.DS_Store'), '');
    fs.directories.add(path.join(INSTANCES_ROOT, 'README'));

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  it('exposes the heartbeat mtime on every entry', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 2500 });
    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });
    expect(result[0]?.heartbeatMtimeMs).toBe(NOW - 2500);
  });
});

describe('discoverInstances — stale detection', () => {
  it('skips instances whose heartbeat is older than 30s (default threshold)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 29_000 }); // alive
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 31_000 }); // stale
    fs.addInstance(300, { heartbeatMtimeMs: NOW - 60_000 }); // stale

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  it('honors a custom staleThresholdMs', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 5000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 15_000 });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
      staleThresholdMs: 10_000,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  it('skips (and does not reap by default) entries with no heartbeat file at all', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: 0, skipHeartbeat: true });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });
    expect(result.map((i) => i.pid)).toEqual([100]);
    expect(fs.removedDirs).toEqual([]);
  });
});

describe('discoverInstances — reapStale', () => {
  it('rmSyncs stale directories when reapStale=true', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 60_000 });
    fs.addInstance(300, { heartbeatMtimeMs: NOW - 90_000 });

    discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
      reapStale: true,
    });

    expect(fs.removedDirs.sort()).toEqual([
      path.join(INSTANCES_ROOT, '200'),
      path.join(INSTANCES_ROOT, '300'),
    ]);
    expect(fs.removedDirs.includes(path.join(INSTANCES_ROOT, '100'))).toBe(false);
  });

  it('does NOT reap when reapStale=false (default)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 60_000 });

    discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(fs.removedDirs).toEqual([]);
  });

  it('does NOT reap an instance with an unknown version (future writer)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({ version: '2', pid: 100, updatedAt: NOW }),
    });

    discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
      reapStale: true,
    });

    expect(fs.removedDirs).toEqual([]);
  });
});

describe('discoverInstances — corruption resilience', () => {
  it('skips instances whose state.json is unparseable (partial write race)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: '{"version":"1","pi', // truncated
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  it('skips instances with unknown version (forward-compat)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({ version: '2', pid: 200, updatedAt: NOW }),
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  it("skips instances with structurally invalid state (missing meta.cwd)", () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({
        version: '1',
        pid: 200,
        updatedAt: NOW,
        meta: { startedAt: NOW - 5000 }, // cwd missing
        agentPhase: 'idle',
      }),
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
  });

  // v0.7.43 (FEATURE_173 Part B follow-up) — sessionId on state.json must
  // surface through discovery; pre-v0.7.43 writers omit the field and
  // must still pass the type guard.
  it('exposes sessionId on the discovered state when present, undefined otherwise', () => {
    const fs = new FakeFs();
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({
        version: '1',
        pid: 100,
        updatedAt: NOW,
        meta: { cwd: '/users/test/repo', startedAt: NOW - 5000 },
        agentPhase: 'idle',
        sessionId: '20260522_113000',
      }),
    });
    fs.addInstance(200, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({
        version: '1',
        pid: 200,
        updatedAt: NOW,
        meta: { cwd: '/users/test/repo', startedAt: NOW - 5000 },
        agentPhase: 'idle',
        // sessionId omitted — pre-v0.7.43 writer shape.
      }),
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    const byPid = new Map(result.map((i) => [i.pid, i] as const));
    expect(byPid.get(100)?.state.sessionId).toBe('20260522_113000');
    expect(byPid.get(200)?.state.sessionId).toBeUndefined();
  });

  it('rejects state.json whose sessionId is the wrong type', () => {
    const fs = new FakeFs();
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify({
        version: '1',
        pid: 100,
        updatedAt: NOW,
        meta: { cwd: '/users/test/repo', startedAt: NOW - 5000 },
        agentPhase: 'idle',
        sessionId: 123, // wrong type
      }),
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result).toEqual([]);
  });

  it('skips instances whose state.json read fails mid-scan (peer mid-write)', () => {
    const fs = new FakeFs();
    fs.addInstance(100, { heartbeatMtimeMs: NOW - 1000 });
    fs.addInstance(200, { heartbeatMtimeMs: NOW - 1000 });
    const targetState = path.join(INSTANCES_ROOT, '200', 'state.json');
    fs.failNextRead = (p) => (p === targetState ? new Error('ENOENT mid-write') : null);

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result.map((i) => i.pid)).toEqual([100]);
    // Mid-write peer must NOT be reaped — they may complete the write
    // on the next tick.
    expect(fs.removedDirs).toEqual([]);
  });

  it('emits log lines via the injectable logger on each per-instance failure', () => {
    const fs = new FakeFs();
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: '{not json',
    });

    const logs: string[] = [];
    discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
      logger: (msg) => logs.push(msg),
    });

    expect(logs.some((l) => l.includes('parse('))).toBe(true);
    expect(logs[0]).toContain('100');
  });

  it('returns [] (and logs) when readdir on the root throws', () => {
    const fs = new FakeFs();
    fs.directories.add(INSTANCES_ROOT);
    const origReaddir = fs.readdirSync.bind(fs);
    fs.readdirSync = (p: string) => {
      if (p === INSTANCES_ROOT) throw new Error('EACCES');
      return origReaddir(p);
    };
    const logs: string[] = [];
    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
      logger: (msg) => logs.push(msg),
    });
    expect(result).toEqual([]);
    expect(logs.some((l) => l.includes('readdir'))).toBe(true);
  });
});

describe('discoverInstances — pid coherence', () => {
  it('logs a warning but still returns the instance when dir name and state.pid disagree', () => {
    const fs = new FakeFs();
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify(makeState({ pid: 999 })), // disagreement
    });

    const logs: string[] = [];
    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 0,
      logger: (msg) => logs.push(msg),
    });

    expect(result.map((i) => i.pid)).toEqual([100]); // dir name wins
    expect(logs.some((l) => l.includes('pid mismatch'))).toBe(true);
  });
});

describe('discoverInstances — state payload', () => {
  it('returns the full PersistedSessionState shape from the file', () => {
    const fs = new FakeFs();
    const state: PersistedSessionState = {
      version: '1',
      pid: 100,
      updatedAt: NOW - 500,
      meta: baseMeta,
      agentPhase: 'running_tool',
      currentIntent: 'refactor auth',
      activeFiles: ['packages/api/auth.ts'],
      recentlyModifiedFiles: [{ path: 'packages/api/session.ts', modifiedAt: NOW - 60_000 }],
      currentTodoSummary: { inProgress: 'Migrating token storage', pendingCount: 2, completedCount: 4 },
    };
    fs.addInstance(100, {
      heartbeatMtimeMs: NOW - 1000,
      stateJson: JSON.stringify(state),
    });

    const result = discoverInstances({
      instancesRoot: INSTANCES_ROOT,
      fs,
      clock: () => NOW,
      excludePid: 999,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.state).toEqual(state);
  });
});
