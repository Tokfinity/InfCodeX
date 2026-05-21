import { describe, expect, it } from 'vitest';
import {
  CHILD_PROGRESS_SNAPSHOT_CAP,
  RECENT_TOOL_CALLS_RING_CAP,
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
  initChildSnapshot,
  pruneToCapacity,
  type ChildProgressSnapshot,
} from './child-progress-snapshot.js';

describe('child-progress-snapshot — initChildSnapshot', () => {
  it('sets status=running with zero iterations and empty breadcrumbs', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    const snap = initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
      parentRole: 'worker',
      readOnly: false,
    });
    expect(snap.status).toBe('running');
    expect(snap.iterations).toBe(0);
    expect(snap.maxIterations).toBe(200);
    expect(snap.recentToolCalls).toEqual([]);
    expect(snap.startedAt).toBe(1000);
    expect(snap.endedAt).toBeUndefined();
    expect(snap.finalText).toBeUndefined();
    expect(snap.parentRole).toBe('worker');
    expect(snap.readOnly).toBe(false);
    expect(snapshots.get('c1')).toBe(snap);
  });

  it('overwrites a stale entry with the same childId (no duplicate registration)', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    const first = initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 100,
    });
    first.status = 'completed';
    const second = initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 2000,
      maxIterations: 50,
    });
    expect(snapshots.size).toBe(1);
    expect(snapshots.get('c1')).toBe(second);
    expect(second.status).toBe('running');
    expect(second.startedAt).toBe(2000);
    expect(second.maxIterations).toBe(50);
  });

  it('prunes to cap-1 before inserting when count would exceed CHILD_PROGRESS_SNAPSHOT_CAP', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    for (let i = 0; i < CHILD_PROGRESS_SNAPSHOT_CAP; i++) {
      initChildSnapshot(snapshots, {
        childId: `c${i}`,
        startedAt: i,
        maxIterations: 10,
      });
    }
    expect(snapshots.size).toBe(CHILD_PROGRESS_SNAPSHOT_CAP);
    // Now insert one more — should prune oldest (c0) before adding.
    initChildSnapshot(snapshots, {
      childId: `c-overflow`,
      startedAt: 99999,
      maxIterations: 10,
    });
    expect(snapshots.size).toBe(CHILD_PROGRESS_SNAPSHOT_CAP);
    expect(snapshots.has('c0')).toBe(false);
    expect(snapshots.has('c-overflow')).toBe(true);
    expect(snapshots.has('c1')).toBe(true); // c1 is now the oldest
  });
});

describe('child-progress-snapshot — applyChildSnapshotEvent', () => {
  it("'iteration' event updates iterations + maxIterations", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    applyChildSnapshotEvent(snapshots, 'c1', {
      kind: 'iteration',
      iteration: 5,
      maxIterations: 200,
    });
    expect(snapshots.get('c1')?.iterations).toBe(5);
    expect(snapshots.get('c1')?.maxIterations).toBe(200);
  });

  it("'tool-start' event pushes a breadcrumb into the ring buffer", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    applyChildSnapshotEvent(snapshots, 'c1', {
      kind: 'tool-start',
      iteration: 3,
      toolName: 'read',
      inputHint: 'src/foo.ts',
      startedAt: 2000,
    });
    const snap = snapshots.get('c1')!;
    expect(snap.recentToolCalls).toHaveLength(1);
    expect(snap.recentToolCalls[0]).toEqual({
      iteration: 3,
      toolName: 'read',
      inputHint: 'src/foo.ts',
      startedAt: 2000,
    });
  });

  it('breadcrumb ring buffer drops oldest entry when length exceeds cap', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    // Push cap+5 events; first 5 should fall off.
    for (let i = 0; i < RECENT_TOOL_CALLS_RING_CAP + 5; i++) {
      applyChildSnapshotEvent(snapshots, 'c1', {
        kind: 'tool-start',
        iteration: i + 1,
        toolName: `tool${i}`,
        inputHint: `hint${i}`,
        startedAt: 1000 + i,
      });
    }
    const snap = snapshots.get('c1')!;
    expect(snap.recentToolCalls).toHaveLength(RECENT_TOOL_CALLS_RING_CAP);
    // Oldest surviving entry should be `tool5` (indices 0-4 evicted).
    expect(snap.recentToolCalls[0].toolName).toBe('tool5');
    // Newest entry should be the last one we pushed.
    expect(snap.recentToolCalls[snap.recentToolCalls.length - 1].toolName).toBe(
      `tool${RECENT_TOOL_CALLS_RING_CAP + 4}`,
    );
  });

  it('silently no-ops when the snapshot map is undefined', () => {
    expect(() =>
      applyChildSnapshotEvent(undefined, 'c1', {
        kind: 'iteration',
        iteration: 1,
        maxIterations: 100,
      }),
    ).not.toThrow();
  });

  it("silently no-ops when the snapshot has been pruned (childId missing)", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    expect(() =>
      applyChildSnapshotEvent(snapshots, 'gone', {
        kind: 'iteration',
        iteration: 1,
        maxIterations: 100,
      }),
    ).not.toThrow();
    expect(snapshots.size).toBe(0);
  });
});

describe('child-progress-snapshot — finalizeChildSnapshot', () => {
  it("writes terminal status + endedAt + finalText", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'all done',
      endedAt: 5000,
    });
    const snap = snapshots.get('c1')!;
    expect(snap.status).toBe('completed');
    expect(snap.endedAt).toBe(5000);
    expect(snap.finalText).toBe('all done');
  });

  it("works without finalText (preserves undefined when none provided)", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'failed',
      endedAt: 5000,
    });
    const snap = snapshots.get('c1')!;
    expect(snap.status).toBe('failed');
    expect(snap.finalText).toBeUndefined();
  });

  it("supports aborted terminal", () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'aborted',
      finalText: 'crash: aborted by task_stop',
      endedAt: 5000,
    });
    expect(snapshots.get('c1')?.status).toBe('aborted');
  });

  it('silently no-ops when the snapshot map is undefined', () => {
    expect(() =>
      finalizeChildSnapshot(undefined, 'c1', {
        status: 'completed',
        endedAt: 1,
      }),
    ).not.toThrow();
  });

  it('silently no-ops when the childId has been pruned', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    expect(() =>
      finalizeChildSnapshot(snapshots, 'gone', {
        status: 'completed',
        endedAt: 1,
      }),
    ).not.toThrow();
  });
});

describe('child-progress-snapshot — pruneToCapacity', () => {
  it('removes oldest by startedAt when over cap', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, { childId: 'old', startedAt: 100, maxIterations: 10 });
    initChildSnapshot(snapshots, { childId: 'mid', startedAt: 200, maxIterations: 10 });
    initChildSnapshot(snapshots, { childId: 'new', startedAt: 300, maxIterations: 10 });
    pruneToCapacity(snapshots, 2);
    expect(snapshots.has('old')).toBe(false);
    expect(snapshots.has('mid')).toBe(true);
    expect(snapshots.has('new')).toBe(true);
  });

  it('is a no-op when size is already within capacity', () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, { childId: 'a', startedAt: 100, maxIterations: 10 });
    pruneToCapacity(snapshots, 5);
    expect(snapshots.size).toBe(1);
  });
});
