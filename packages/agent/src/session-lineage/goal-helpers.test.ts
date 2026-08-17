/**
 * FEATURE_192 v0.7.44 Phase A — goal-helpers unit tests.
 *
 * Coverage:
 *   - appendGoalEntry happy path + invariant violations
 *   - readLatestGoalFromBranch:
 *       (a) returns null when no goal entry attached
 *       (b) returns latest goal entry (by timestamp) on active branch
 *       (c) excludes goal entries from abandoned (off-branch) message paths
 *       (d) returns 'cleared' entry, not null, when user cleared the goal
 *   - readLatestGoalState — convenience accessor
 *   - isGoalEntry predicate
 *   - Goal entries are filtered OUT of `getSessionLineagePath` (non-navigable
 *     like label) — proves the type-guard contract
 */

import { describe, it, expect } from 'vitest';
import type {
  KodaXGoalState,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '../types.js';
import {
  appendGoalEntry,
  isGoalEntry,
  readLatestGoalFromBranch,
  readLatestGoalState,
} from './goal-helpers.js';
import {
  forkSessionLineage,
  getSessionLineagePath,
} from './kodax-session-lineage.js';

function makeMsg(
  id: string,
  parentId: string | null,
  timestamp = '2026-05-25T00:00:00.000Z',
): KodaXSessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    message: { role: 'user', content: id },
  };
}

function makeGoal(
  override: Partial<KodaXGoalState> = {},
): KodaXGoalState {
  return {
    version: 1,
    id: '20260525-abc',
    objective: 'demo',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    blockerTurnCount: 0,
    lastBlockerKind: null,
    createdAt: Date.parse('2026-05-25T00:00:00Z'),
    updatedAt: Date.parse('2026-05-25T00:00:00Z'),
    ...override,
  };
}

function makeLineage(
  entries: KodaXSessionEntry[],
  activeEntryId: string | null,
): KodaXSessionLineage {
  return { version: 2, activeEntryId, entries };
}

describe('appendGoalEntry', () => {
  it('appends a created entry to the active branch', () => {
    const m1 = makeMsg('m1', null);
    const lineage = makeLineage([m1], 'm1');
    const out = appendGoalEntry(lineage, makeGoal(), 'created');
    expect(out.entries.length).toBe(2);
    const goalEntry = out.entries[1];
    expect(goalEntry.type).toBe('goal');
    expect(goalEntry.parentId).toBe('m1');
    expect((goalEntry as { event: string }).event).toBe('created');
  });

  it('throws when goal=null and event != cleared', () => {
    const lineage = makeLineage([makeMsg('m1', null)], 'm1');
    expect(() => appendGoalEntry(lineage, null, 'paused')).toThrow(
      /goal=null is only valid when event='cleared'/,
    );
  });

  it('throws when event=cleared and goal is non-null', () => {
    const lineage = makeLineage([makeMsg('m1', null)], 'm1');
    expect(() => appendGoalEntry(lineage, makeGoal(), 'cleared')).toThrow(
      /event='cleared' requires goal=null/,
    );
  });

  it('accepts event=cleared with goal=null', () => {
    const lineage = makeLineage([makeMsg('m1', null)], 'm1');
    const out = appendGoalEntry(lineage, null, 'cleared');
    expect(out.entries[1].type).toBe('goal');
    expect((out.entries[1] as { goal: unknown }).goal).toBeNull();
  });

  it('returns a fresh lineage object (does not mutate input)', () => {
    const lineage = makeLineage([makeMsg('m1', null)], 'm1');
    const before = lineage.entries.length;
    appendGoalEntry(lineage, makeGoal(), 'created');
    expect(lineage.entries.length).toBe(before);
  });
});

describe('readLatestGoalFromBranch', () => {
  it('returns null when no goal entry is attached to the lineage', () => {
    const lineage = makeLineage([makeMsg('m1', null)], 'm1');
    expect(readLatestGoalFromBranch(lineage)).toBeNull();
  });

  it('returns null when activeEntryId is null', () => {
    const lineage = makeLineage([makeMsg('m1', null)], null);
    expect(readLatestGoalFromBranch(lineage)).toBeNull();
  });

  it('returns latest goal entry (largest timestamp) on the active branch', () => {
    const m1 = makeMsg('m1', null, '2026-05-25T00:00:00.000Z');
    const m2 = makeMsg('m2', 'm1', '2026-05-25T00:01:00.000Z');
    let lineage = makeLineage([m1, m2], 'm2');
    lineage = appendGoalEntry(lineage, makeGoal({ objective: 'first' }), 'created', {
      timestamp: '2026-05-25T00:02:00.000Z',
    });
    lineage = appendGoalEntry(lineage, makeGoal({ objective: 'second' }), 'updated', {
      timestamp: '2026-05-25T00:03:00.000Z',
    });
    const latest = readLatestGoalFromBranch(lineage);
    expect(latest?.event).toBe('updated');
    expect(latest?.goal?.objective).toBe('second');
  });

  it('ignores goal entries whose parentId is off the active branch', () => {
    // Tree:
    //   m1 ─ m2 ─ m3 (active)
    //        └─ m4 (abandoned fork)
    // Goal attached to m4 must NOT count for active path m1→m2→m3.
    const m1 = makeMsg('m1', null);
    const m2 = makeMsg('m2', 'm1');
    const m3 = makeMsg('m3', 'm2');
    const m4 = makeMsg('m4', 'm2');
    let lineage = makeLineage([m1, m2, m3, m4], 'm3');
    lineage = {
      ...lineage,
      entries: [
        ...lineage.entries,
        {
          type: 'goal',
          id: 'g1',
          parentId: 'm4',
          timestamp: '2026-05-25T00:10:00.000Z',
          goal: makeGoal({ objective: 'abandoned-branch' }),
          event: 'created',
        },
      ],
    };
    expect(readLatestGoalFromBranch(lineage)).toBeNull();
  });

  it("returns the 'cleared' entry, not null, when user explicitly cleared the goal", () => {
    const m1 = makeMsg('m1', null);
    let lineage = makeLineage([m1], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal(), 'created', {
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    lineage = appendGoalEntry(lineage, null, 'cleared', {
      timestamp: '2026-05-25T00:01:00.000Z',
    });
    const latest = readLatestGoalFromBranch(lineage);
    expect(latest).not.toBeNull();
    expect(latest?.event).toBe('cleared');
    expect(latest?.goal).toBeNull();
  });
});

describe('readLatestGoalState', () => {
  it('returns the inner state when present', () => {
    let lineage = makeLineage([makeMsg('m1', null)], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal({ objective: 'X' }), 'created');
    expect(readLatestGoalState(lineage)?.objective).toBe('X');
  });

  it('returns null when cleared', () => {
    let lineage = makeLineage([makeMsg('m1', null)], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal(), 'created', {
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    lineage = appendGoalEntry(lineage, null, 'cleared', {
      timestamp: '2026-05-25T00:01:00.000Z',
    });
    expect(readLatestGoalState(lineage)).toBeNull();
  });
});

describe('isGoalEntry', () => {
  it('matches type=goal entries', () => {
    let lineage = makeLineage([makeMsg('m1', null)], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal(), 'created');
    const goalEntry = lineage.entries.find(isGoalEntry);
    expect(goalEntry?.type).toBe('goal');
  });

  it('rejects non-goal entries', () => {
    const msg = makeMsg('m1', null);
    expect(isGoalEntry(msg)).toBe(false);
  });
});

describe('Goal entries are non-navigable (excluded from path)', () => {
  it('getSessionLineagePath does NOT include goal entries', () => {
    const m1 = makeMsg('m1', null);
    let lineage = makeLineage([m1], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal(), 'created');
    const path = getSessionLineagePath(lineage);
    expect(path.length).toBe(1);
    expect(path[0].id).toBe('m1');
    // No goal entry leaked into navigable path
    expect(path.some((e) => (e as { type: string }).type === 'goal')).toBe(false);
  });
});

describe('forkSessionLineage carries the active goal forward', () => {
  it('carries non-null goal state across a fork', () => {
    const m1 = makeMsg('m1', null);
    const m2 = makeMsg('m2', 'm1');
    let lineage = makeLineage([m1, m2], 'm2');
    lineage = appendGoalEntry(
      lineage,
      makeGoal({ objective: 'survive-fork', id: 'goal-XYZ' }),
      'created',
    );
    const forked = forkSessionLineage(lineage);
    expect(forked).not.toBeNull();
    const carriedGoal = readLatestGoalFromBranch(forked!);
    expect(carriedGoal).not.toBeNull();
    expect(carriedGoal?.goal?.id).toBe('goal-XYZ');
    expect(carriedGoal?.goal?.objective).toBe('survive-fork');
    // event preserved (we used 'created')
    expect(carriedGoal?.event).toBe('created');
  });

  it('does NOT carry a cleared goal forward (cleared = no goal)', () => {
    const m1 = makeMsg('m1', null);
    let lineage = makeLineage([m1], 'm1');
    lineage = appendGoalEntry(lineage, makeGoal(), 'created', {
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    lineage = appendGoalEntry(lineage, null, 'cleared', {
      timestamp: '2026-05-25T00:01:00.000Z',
    });
    const forked = forkSessionLineage(lineage);
    expect(forked).not.toBeNull();
    expect(readLatestGoalState(forked!)).toBeNull();
  });

  it('returns null goal on a fork with no goal ever set', () => {
    const m1 = makeMsg('m1', null);
    const lineage = makeLineage([m1], 'm1');
    const forked = forkSessionLineage(lineage);
    expect(forked).not.toBeNull();
    expect(readLatestGoalFromBranch(forked!)).toBeNull();
  });

  it('carries the LATEST goal forward when same-ms timestamps tie (complete -> cleared -> created)', () => {
    // Regression for the same-ms tie-break bug: `/goal new` after a
    // `complete` goal emits 3 goal entries in the same Date.now() ms,
    // and a strict `>` comparison in findLatestGoalOnPath would
    // strand the latest (`created`) entry, carrying the stale
    // `complete` state across the fork.
    const m1 = makeMsg('m1', null);
    let lineage = makeLineage([m1], 'm1');
    const sameMs = '2026-05-25T00:00:00.000Z';
    // Sequence the slash command would produce:
    //   1) prior goal (status=complete) — already present on branch
    //   2) /goal new -> emit cleared
    //   3)            -> emit created (with new objective)
    lineage = appendGoalEntry(
      lineage,
      { ...makeGoal({ objective: 'old-objective', id: 'goal-OLD' }), status: 'complete' },
      'complete',
      { timestamp: sameMs },
    );
    lineage = appendGoalEntry(lineage, null, 'cleared', { timestamp: sameMs });
    lineage = appendGoalEntry(
      lineage,
      makeGoal({ objective: 'new-objective', id: 'goal-NEW' }),
      'created',
      { timestamp: sameMs },
    );
    const forked = forkSessionLineage(lineage);
    expect(forked).not.toBeNull();
    const carried = readLatestGoalFromBranch(forked!);
    expect(carried?.goal?.id).toBe('goal-NEW');
    expect(carried?.goal?.objective).toBe('new-objective');
    expect(carried?.event).toBe('created');
  });

  it('fork-of-fork carried goal points at the first fork clone, not the original', () => {
    const m1 = makeMsg('m1', null);
    let lineage = makeLineage([m1], 'm1');
    lineage = appendGoalEntry(
      lineage,
      makeGoal({ objective: 'direct-predecessor', id: 'goal-ABC' }),
      'created',
      { id: 'goal-entry-orig' },
    );
    const firstFork = forkSessionLineage(lineage);
    expect(firstFork).not.toBeNull();
    const firstCarried = readLatestGoalFromBranch(firstFork!);
    expect(firstCarried).not.toBeNull();
    expect(firstCarried!.sourceEntryId).toBe('goal-entry-orig');

    const secondFork = forkSessionLineage(firstFork!);
    expect(secondFork).not.toBeNull();
    const secondCarried = readLatestGoalFromBranch(secondFork!);
    expect(secondCarried).not.toBeNull();
    // Direct addressing: the second-level fork's carried goal names the
    // first-level fork clone's physical id, not the generation-0 original.
    expect(secondCarried!.sourceEntryId).toBe(firstCarried!.id);
    expect(secondCarried!.sourceEntryId).not.toBe('goal-entry-orig');
  });
});