/**
 * Hermetic tests for todo-store (FEATURE_097, v0.7.34). No LLM calls.
 */
import { describe, expect, it } from 'vitest';

import type { TodoList, TodoStatus } from '../types.js';
import { createTodoStore, type TodoInit } from './todo-store.js';

const SEEDS: readonly TodoInit[] = Object.freeze([
  { id: 'todo_1', content: 'Rename function', owner: 'main', sourceObligationIndex: 0 },
  { id: 'todo_2', content: 'Update callers', owner: 'main', sourceObligationIndex: 1 },
  { id: 'todo_3', content: 'Run typecheck', owner: 'main', sourceObligationIndex: 2 },
]);

describe('todo-store basics', () => {
  it('starts empty', () => {
    const store = createTodoStore();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
    expect(store.allIds()).toEqual([]);
  });

  it('init() seeds items as pending', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.hasItems()).toBe(true);
    expect(store.allIds()).toEqual(['todo_1', 'todo_2', 'todo_3']);
    for (const it of store.getAll()) {
      expect(it.status).toBe('pending');
      expect(it.note).toBeUndefined();
    }
  });

  it('has() returns true only for existing ids', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.has('todo_2')).toBe(true);
    expect(store.has('todo_99')).toBe(false);
    expect(store.has('')).toBe(false);
  });

  it('reset() drops every item', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.reset();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
  });

  it('replace() swaps the entire list', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.replace([
      { id: 'p_1', content: 'planned step a', status: 'pending' },
      { id: 'p_2', content: 'planned step b', status: 'pending' },
    ]);
    expect(store.allIds()).toEqual(['p_1', 'p_2']);
    expect(store.has('todo_1')).toBe(false);
  });
});

describe('todo-store updateStatus', () => {
  it('returns true and updates status when id exists', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.updateStatus('todo_2', 'in_progress')).toBe(true);
    const items = store.getAll();
    expect(items[1]?.status).toBe('in_progress');
    // Other items untouched.
    expect(items[0]?.status).toBe('pending');
    expect(items[2]?.status).toBe('pending');
  });

  it('returns false and is a no-op when id is unknown', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.updateStatus('todo_99', 'completed')).toBe(false);
    expect(store.getAll().every((it) => it.status === 'pending')).toBe(true);
  });

  it('attaches note on update', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'Evaluator requested revision');
    expect(store.getAll()[0]?.note).toBe('Evaluator requested revision');
    expect(store.getAll()[0]?.status).toBe('failed');
  });

  it('preserves existing note when called without a note argument', () => {
    // Regression for code-reviewer MEDIUM finding: prior implementation
    // erased existing notes on every status transition that did not
    // explicitly supply one. This matters when a failed item carrying an
    // Evaluator note is later re-tried via updateStatus(id, 'in_progress')
    // with no note — the failure context should remain visible until the
    // model actively replaces it (via a new note) or resetFailed clears it.
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'audit failed: missing scope check');
    // Re-try as in_progress without supplying a note — note must persist.
    store.updateStatus('todo_1', 'in_progress');
    expect(store.getAll()[0]?.status).toBe('in_progress');
    expect(store.getAll()[0]?.note).toBe('audit failed: missing scope check');
  });

  it('replaces note when caller supplies a new one', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'first reason');
    store.updateStatus('todo_1', 'failed', 'second reason');
    expect(store.getAll()[0]?.note).toBe('second reason');
  });

  it('allows terminal-state transitions (lifecycle is not enforced at the store layer)', () => {
    // The design doc describes a one-way lifecycle pending → in_progress →
    // (completed | failed | skipped). The store deliberately does NOT
    // enforce that — the constraint lives in the role-prompt layer (per
    // CLAUDE.md "约束走 prompt 层，代码层不 enforce"). Document the
    // intentional permissiveness with an explicit test so future refactors
    // do not accidentally add validation that violates the design.
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    // Re-opening a completed item is permitted at the store layer.
    expect(store.updateStatus('todo_1', 'failed', 'reopened by reviewer')).toBe(true);
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('reopened by reviewer');
  });

  it('snapshots returned to consumers are frozen and not affected by later mutations', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    const snapshot = store.getAll();
    // Snapshot itself is frozen.
    expect(Object.isFrozen(snapshot)).toBe(true);
    // Mutating store does not retroactively change the snapshot.
    store.updateStatus('todo_1', 'completed');
    expect(snapshot[0]?.status).toBe('pending');
    expect(store.getAll()[0]?.status).toBe('completed');
  });
});

describe('todo-store Evaluator verdict auto-handling (§5 决策细节 ①)', () => {
  it('autoCompleteOnAccept on an empty store returns 0 and is a no-op', () => {
    // Edge case: replan → reset → accept race ordering. The verdict can
    // arrive after the list was cleared. Must not throw, must report 0.
    const store = createTodoStore();
    expect(store.autoCompleteOnAccept()).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it('autoCompleteOnAccept flips pending + in_progress to completed', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_2', 'in_progress');
    expect(store.autoCompleteOnAccept()).toBe(3); // all 3 changed
    expect(store.getAll().every((it) => it.status === 'completed')).toBe(true);
  });

  it('autoCompleteOnAccept does not affect already completed/failed/skipped', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'failed');
    store.updateStatus('todo_3', 'skipped');
    expect(store.autoCompleteOnAccept()).toBe(0);
    expect(store.getAll().map((it) => it.status)).toEqual([
      'completed',
      'failed',
      'skipped',
    ]);
  });

  it('markInProgressFailed flips only in_progress items, attaches note', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'in_progress');
    expect(store.markInProgressFailed('Evaluator requested revision')).toBe(1);
    const items = store.getAll();
    expect(items[0]?.status).toBe('completed'); // unchanged
    expect(items[1]?.status).toBe('failed');
    expect(items[1]?.note).toBe('Evaluator requested revision');
    expect(items[2]?.status).toBe('pending'); // unchanged
  });

  it('resetFailed flips failed items back to pending and clears their note', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'previous reason');
    store.updateStatus('todo_2', 'completed');
    expect(store.resetFailed()).toBe(1);
    const items = store.getAll();
    expect(items[0]?.status).toBe('pending');
    expect(items[0]?.note).toBeUndefined();
    expect(items[1]?.status).toBe('completed'); // unchanged
  });

  it('full revise → reset cycle: in_progress → failed → pending', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'in_progress');

    // Evaluator returns revise.
    expect(store.markInProgressFailed('audit failed')).toBe(1);
    expect(store.getAll()[1]?.status).toBe('failed');

    // Next iteration starts.
    expect(store.resetFailed()).toBe(1);
    expect(store.getAll()[1]?.status).toBe('pending');
    expect(store.getAll()[1]?.note).toBeUndefined();
  });
});

describe('todo-store onChange callback', () => {
  it('does not fire onChange before any mutation', () => {
    const calls: number[] = [];
    createTodoStore({ onChange: (items) => calls.push(items.length) });
    expect(calls).toEqual([]);
  });

  it('fires onChange on init() with the seeded list', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items.length) });
    store.init(SEEDS);
    expect(calls).toEqual([3]);
  });

  it('fires onChange on successful updateStatus, but NOT on unknown id', () => {
    const calls: string[][] = [];
    const store = createTodoStore({
      onChange: (items) => calls.push(items.map((it) => it.status)),
    });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'in_progress'); // call 2
    store.updateStatus('todo_99', 'completed'); // unknown id — no call
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('does NOT fire onChange when updateStatus is called with the same status + same note (LLM double-call guard)', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'in_progress'); // call 2 (transition)
    store.updateStatus('todo_1', 'in_progress'); // no-op same status, no note → no call
    store.updateStatus('todo_1', 'in_progress'); // no-op again → no call
    expect(calls).toBe(2);
  });

  it('fires onChange when updateStatus changes the note even if status is unchanged', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'failed', 'first reason'); // call 2
    store.updateStatus('todo_1', 'failed', 'first reason'); // no-op → no call
    store.updateStatus('todo_1', 'failed', 'updated reason'); // call 3 (note changed)
    expect(calls).toBe(3);
  });

  it('fires onChange on replace()', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items.length) });
    store.init(SEEDS); // call 1
    store.replace([{ id: 'p_1', content: 'new', status: 'pending' }]); // call 2
    expect(calls).toEqual([3, 1]);
  });

  it('fires onChange on autoCompleteOnAccept only when items actually change', () => {
    const calls: string[][] = [];
    const store = createTodoStore({
      onChange: (items) => calls.push(items.map((it) => it.status)),
    });
    store.init(SEEDS); // call 1: all pending
    store.autoCompleteOnAccept(); // call 2: pending → completed
    store.autoCompleteOnAccept(); // no-op: all already completed → no call
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(['completed', 'completed', 'completed']);
  });

  it('fires onChange on markInProgressFailed only when there are in_progress items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.init(SEEDS); // call 1
    store.markInProgressFailed('reason'); // no in_progress → no call
    store.updateStatus('todo_1', 'in_progress'); // call 2
    store.markInProgressFailed('reason'); // call 3
    expect(calls.length).toBe(3);
  });

  it('fires onChange on resetFailed only when there are failed items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.init(SEEDS); // call 1
    store.resetFailed(); // no failed → no call
    store.updateStatus('todo_1', 'failed', 'reason'); // call 2
    store.resetFailed(); // call 3
    expect(calls.length).toBe(3);
  });

  it('fires onChange on reset() only when store had items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.reset(); // empty already → no call
    store.init(SEEDS); // call 1
    store.reset(); // call 2
    store.reset(); // empty already → no call
    expect(calls.length).toBe(2);
  });

  it('passes a frozen snapshot, not the live array', () => {
    const calls: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items) });
    store.init(SEEDS);
    expect(Object.isFrozen(calls[0])).toBe(true);
    // Subsequent mutations do not retroactively change earlier snapshots.
    store.updateStatus('todo_1', 'completed');
    expect(calls[0]?.[0]?.status).toBe('pending');
    expect(calls[1]?.[0]?.status).toBe('completed');
  });
});

describe('todo-store immutability invariant', () => {
  it('updateStatus returns new objects (does not mutate prior snapshot)', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    const before = store.getAll();
    const beforeRef = before[1];
    store.updateStatus('todo_2', 'in_progress');
    const afterRef = store.getAll()[1];
    expect(beforeRef).not.toBe(afterRef);
    expect(beforeRef?.status).toBe('pending');
    expect(afterRef?.status).toBe('in_progress');
  });
});

// FEATURE_097 (v0.7.34) §5 ① cross-turn lifecycle — pinpoints the
// runner-driven.ts contract that the wrapEmitterWithRecorder verdict
// slot arms `pendingFailedResetRef` after a `revise` and the next
// Generator turn's `instructions` closure consumes it. The ref itself
// lives in runner-driven.ts; this test exercises the store-level
// contract end-to-end so a future regression that drops either side
// of the contract is caught at the unit layer rather than waiting for
// integration tests to detect it.
describe('todo-store revise → reset cross-turn lifecycle (FEATURE_097 §5 ①)', () => {
  it('markInProgressFailed → resetFailed produces the ●→✗→☐ visual sequence', () => {
    const snapshots: ReadonlyArray<{ status: TodoStatus; note?: string }>[] = [];
    const store = createTodoStore({
      onChange: (items) => {
        snapshots.push(
          items.map((it) => ({ status: it.status, note: it.note })),
        );
      },
    });
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
      { id: 'todo_3', content: 'C' },
    ]);
    // Phase 1: Generator marks todo_1 + todo_2 in_progress (sequential).
    store.updateStatus('todo_1', 'in_progress');
    store.updateStatus('todo_2', 'in_progress');
    // Phase 2: Evaluator revise — wrapEmitterWithRecorder calls
    // markInProgressFailed; pendingFailedResetRef arms.
    const failedCount = store.markInProgressFailed('Evaluator requested revision');
    expect(failedCount).toBe(2);
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('Evaluator requested revision');
    // Phase 3: Generator's next-turn instructions closure consumes
    // the flag and calls resetFailed; failed → pending.
    const resetCount = store.resetFailed();
    expect(resetCount).toBe(2);
    expect(store.getAll()[0]?.status).toBe('pending');
    expect(store.getAll()[0]?.note).toBeUndefined();
    expect(store.getAll()[2]?.status).toBe('pending'); // unchanged
    // The full visual sequence: init → in_prog → in_prog → failed → pending.
    // Each transition must have produced exactly one onChange call.
    expect(snapshots.length).toBe(5);
  });

  it('idempotent on second resetFailed: no extra onChange (the flag is already cleared)', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    store.markInProgressFailed('reason');
    store.resetFailed();
    const callsAtSettled = calls;
    // If the runner-driven flag handling re-fires resetFailed
    // accidentally (lifecycle bug), no items are in `failed` state, so
    // the second call should be a true no-op.
    store.resetFailed();
    expect(calls).toBe(callsAtSettled);
  });

  it('replan path is distinguishable: store.reset() empties the list', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    // §5 ① replan disposition routes through `reset()` (not
    // markInProgressFailed). Distinguishes "retry these items" from
    // "abandon the list, Planner refines".
    store.reset();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
  });
});

// FEATURE_149 (v0.7.38) — `activeForm` field on TodoItem drives the
// spinner verb. Tests pin: seeded value flows through; updateStatus can
// set / preserve / replace; absent value stays absent.
describe('todo-store activeForm (FEATURE_149)', () => {
  it('init() seeds activeForm when provided', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'Run failing tests', activeForm: 'Running failing tests' },
    ]);
    expect(store.getAll()[0]?.activeForm).toBe('Running failing tests');
  });

  it('init() leaves activeForm undefined when not provided (back-compat)', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    for (const it of store.getAll()) {
      expect(it.activeForm).toBeUndefined();
    }
  });

  it('updateStatus() sets activeForm when supplied', () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', content: 'Refactor auth' }]);
    store.updateStatus('todo_1', 'in_progress', undefined, 'Refactoring auth');
    expect(store.getAll()[0]?.activeForm).toBe('Refactoring auth');
    expect(store.getAll()[0]?.status).toBe('in_progress');
  });

  it('updateStatus() preserves existing activeForm when omitted', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'Refactor auth', activeForm: 'Refactoring auth' },
    ]);
    // Subsequent transition with no activeForm arg should preserve.
    store.updateStatus('todo_1', 'completed');
    expect(store.getAll()[0]?.activeForm).toBe('Refactoring auth');
  });

  it('updateStatus() replaces activeForm when supplied', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'Refactor auth', activeForm: 'old phrase' },
    ]);
    store.updateStatus('todo_1', 'in_progress', undefined, 'new phrase');
    expect(store.getAll()[0]?.activeForm).toBe('new phrase');
  });

  it('updateStatus() with no actual change does not fire onChange (no-op contract)', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([
      { id: 'todo_1', content: 'X', activeForm: 'Doing X' },
    ]);
    events.length = 0; // Drop the init notification.
    // Same status + same activeForm = no-op.
    store.updateStatus('todo_1', 'pending', undefined, 'Doing X');
    expect(events).toEqual([]);
  });

  it('updateStatus() fires onChange when only activeForm changes', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([{ id: 'todo_1', content: 'X', activeForm: 'Doing X' }]);
    events.length = 0;
    store.updateStatus('todo_1', 'pending', undefined, 'Working on X');
    expect(events.length).toBe(1);
    expect(events[0]![0]!.activeForm).toBe('Working on X');
  });
});

// =============================================================================
// FEATURE_170 v0.7.41 — per-task CRUD: add() / patch() / remove() + id counter
// =============================================================================

describe('todo-store add() — FEATURE_170 v0.7.41', () => {
  it('returns a new monotonic id and appends a pending item', () => {
    const store = createTodoStore();
    store.init(SEEDS); // todo_1, todo_2, todo_3
    const newId = store.add({ content: 'New step' });
    expect(newId).toBe('todo_4');
    expect(store.has('todo_4')).toBe(true);
    const item = store.getAll().find((it) => it.id === 'todo_4')!;
    expect(item.status).toBe('pending');
    expect(item.content).toBe('New step');
  });

  it('carries activeForm / evaluator / metadata / owner from the seed', () => {
    const store = createTodoStore();
    const id = store.add({
      content: 'Refactor auth',
      activeForm: 'Refactoring auth',
      evaluator: 'build',
      owner: 'main',
      metadata: { foo: 1 },
    });
    const item = store.getAll().find((it) => it.id === id)!;
    expect(item.activeForm).toBe('Refactoring auth');
    expect(item.evaluator).toBe('build');
    expect(item.owner).toBe('main');
    expect(item.metadata).toEqual({ foo: 1 });
  });

  it('counter is monotonic — remove() then add() does NOT reuse the id', () => {
    const store = createTodoStore();
    store.init(SEEDS); // counter = 3
    expect(store.add({ content: 'A' })).toBe('todo_4');
    expect(store.add({ content: 'B' })).toBe('todo_5');
    expect(store.remove('todo_5')).toBe(true);
    // Next add must be todo_6 — todo_5 is forever gone.
    expect(store.add({ content: 'C' })).toBe('todo_6');
  });

  it('counter initializes from sparse numeric seeds (gaps OK)', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_3', content: 'first' },
      { id: 'todo_5', content: 'second' },
    ]);
    // Highest numeric suffix is 5 → next add is todo_6.
    expect(store.add({ content: 'C' })).toBe('todo_6');
  });

  it('counter initializes to 0 from non-numeric seeds (counter falls back gracefully)', () => {
    const store = createTodoStore();
    store.init([
      { id: 'step-a', content: 'first' },
      { id: 'step-b', content: 'second' },
    ]);
    // No `^todo_\d+$` matches → counter stays at 0 → next add is todo_1.
    expect(store.add({ content: 'C' })).toBe('todo_1');
  });

  it('counter never regresses across multiple init() calls', () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_10', content: 'big seed' }]);
    expect(store.add({ content: 'X' })).toBe('todo_11');
    // Now a smaller init — counter must NOT regress.
    store.init([{ id: 'todo_2', content: 'small seed' }]);
    expect(store.add({ content: 'Y' })).toBe('todo_12');
  });

  it('fires onChange after add', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([]);
    events.length = 0;
    store.add({ content: 'X' });
    expect(events.length).toBe(1);
    expect(events[0]!.length).toBe(1);
  });
});

describe('todo-store patch() — FEATURE_170 v0.7.41', () => {
  it('patches content while preserving status / activeForm / evaluator', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'old content', activeForm: 'Doing X', evaluator: 'build' },
    ]);
    expect(store.patch('todo_1', { content: 'new content' })).toBe(true);
    const item = store.getAll()[0]!;
    expect(item.content).toBe('new content');
    expect(item.activeForm).toBe('Doing X');
    expect(item.evaluator).toBe('build');
    expect(item.status).toBe('pending');
  });

  it('patches multiple fields at once', () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', content: 'X' }]);
    store.patch('todo_1', {
      content: 'Y',
      status: 'in_progress',
      activeForm: 'Doing Y',
      evaluator: 'test',
    });
    const item = store.getAll()[0]!;
    expect(item.content).toBe('Y');
    expect(item.status).toBe('in_progress');
    expect(item.activeForm).toBe('Doing Y');
    expect(item.evaluator).toBe('test');
  });

  it('returns false for unknown id (no mutation)', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.patch('todo_99', { content: 'X' })).toBe(false);
    expect(store.getAll().every((it) => it.content !== 'X')).toBe(true);
  });

  it('shallow-merges metadata, preserving untouched keys', () => {
    const store = createTodoStore();
    const id = store.add({ content: 'X', metadata: { a: 1, b: 2 } });
    store.patch(id, { metadata: { b: 99, c: 3 } });
    expect(store.getAll()[0]!.metadata).toEqual({ a: 1, b: 99, c: 3 });
  });

  it('clears metadata when patch passes metadata:null', () => {
    const store = createTodoStore();
    const id = store.add({ content: 'X', metadata: { a: 1 } });
    store.patch(id, { metadata: null });
    expect(store.getAll()[0]!.metadata).toBeUndefined();
  });

  it('preserves metadata when patch.metadata is undefined', () => {
    const store = createTodoStore();
    const id = store.add({ content: 'X', metadata: { a: 1 } });
    store.patch(id, { content: 'Y' });
    expect(store.getAll()[0]!.metadata).toEqual({ a: 1 });
  });

  it('is a no-op (no onChange) when patch fields equal current values', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([{ id: 'todo_1', content: 'X', activeForm: 'Doing X' }]);
    events.length = 0;
    store.patch('todo_1', { content: 'X', activeForm: 'Doing X', status: 'pending' });
    expect(events).toEqual([]);
  });

  it('is a no-op when patch.note equals current value', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([{ id: 'todo_1', content: 'X' }]);
    store.patch('todo_1', { note: 'first note' }); // sets note
    events.length = 0;
    store.patch('todo_1', { note: 'first note' }); // same note again — no-op
    expect(events).toEqual([]);
  });

  it('is a no-op when patch.evaluator equals current value', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([{ id: 'todo_1', content: 'X', evaluator: 'build' }]);
    events.length = 0;
    store.patch('todo_1', { evaluator: 'build' });
    expect(events).toEqual([]);
  });

  it('does NOT expose owner / sourceObligationIndex in TodoPatch (caller-immutable)', () => {
    // Compile-time check: TodoPatch does not include owner or
    // sourceObligationIndex. The runtime can't witness a "should not"
    // type rule, so this test documents the contract by exercising the
    // expected behavior: an item's owner stays put after a content patch.
    const store = createTodoStore();
    store.init([{ id: 'todo_1', content: 'X', owner: 'main', sourceObligationIndex: 7 }]);
    store.patch('todo_1', { content: 'Y' });
    const item = store.getAll()[0]!;
    expect(item.owner).toBe('main');
    expect(item.sourceObligationIndex).toBe(7);
  });

  it('fires onChange when at least one field changes', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init([{ id: 'todo_1', content: 'X' }]);
    events.length = 0;
    store.patch('todo_1', { status: 'in_progress' });
    expect(events.length).toBe(1);
    expect(events[0]![0]!.status).toBe('in_progress');
  });
});

describe('todo-store remove() — FEATURE_170 v0.7.41', () => {
  it('drops the item and returns true', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.remove('todo_2')).toBe(true);
    expect(store.allIds()).toEqual(['todo_1', 'todo_3']);
  });

  it('returns false (and is a no-op) for unknown id', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.remove('todo_99')).toBe(false);
    expect(store.allIds()).toEqual(['todo_1', 'todo_2', 'todo_3']);
  });

  it('fires onChange after a successful remove', () => {
    const events: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => { events.push(items); } });
    store.init(SEEDS);
    events.length = 0;
    store.remove('todo_2');
    expect(events.length).toBe(1);
    expect(events[0]!.map((it) => it.id)).toEqual(['todo_1', 'todo_3']);
  });
});
