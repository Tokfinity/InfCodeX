/**
 * Hermetic tests for the todo_update tool (FEATURE_097, v0.7.34). No LLM calls.
 * Coverage targets §5 决策细节 ⑤ (unknown-id self-recovery contract).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
} from '../extensions/index.js';
import { createTodoStore } from '../task-engine/todo-store.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolTodoUpdate } from './todo-update.js';

function makeContext(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeContextWithStore(
  seeds: ReadonlyArray<{ id: string; content: string }> = [
    { id: 'todo_1', content: 'Rename function' },
    { id: 'todo_2', content: 'Update callers' },
    { id: 'todo_3', content: 'Run typecheck' },
  ],
): {
  ctx: KodaXToolExecutionContext;
  store: ReturnType<typeof createTodoStore>;
  notifyCount: () => number;
} {
  let calls = 0;
  const store = createTodoStore({
    onChange: () => {
      calls++;
    },
  });
  store.init(seeds.map((s) => ({ id: s.id, content: s.content })));
  // init counts as call 1; reset for clarity.
  const initCalls = calls;
  return {
    ctx: makeContext({ todoStore: store }),
    store,
    notifyCount: () => calls - initCalls,
  };
}

describe('todo_update happy path', () => {
  it('returns {ok:true} and updates store on a valid call', async () => {
    const { ctx, store, notifyCount } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'in_progress' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll()[0]?.status).toBe('in_progress');
    expect(notifyCount()).toBe(1);
  });

  it('attaches note when supplied', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 'tests failed' },
      ctx,
    );
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('tests failed');
  });

  it('preserves existing note when called without note arg', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 'original note' },
      ctx,
    );
    await toolTodoUpdate({ id: 'todo_1', status: 'in_progress' }, ctx);
    expect(store.getAll()[0]?.note).toBe('original note');
  });
});

describe('todo_update §5 ⑤ unknown id contract', () => {
  it('returns {ok:false, reason} listing every valid id when id is unknown', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_99', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    // The reason MUST include the rejected id and ALL valid ids so the
    // model can pick a correct one on the next turn.
    expect(parsed.reason).toContain('todo_99');
    expect(parsed.reason).toContain('todo_1');
    expect(parsed.reason).toContain('todo_2');
    expect(parsed.reason).toContain('todo_3');
  });

  it('returns {ok:false} but does NOT mutate the store on unknown id', async () => {
    const { ctx, store, notifyCount } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_99', status: 'completed' }, ctx);
    expect(store.getAll().every((it) => it.status === 'pending')).toBe(true);
    expect(notifyCount()).toBe(0);
  });

  it('handles empty store gracefully (no todos seeded yet)', async () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    // Do NOT call init — the tool must handle an empty store.
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    // Reason should hint that the list is empty rather than offer
    // a bogus comma-list.
    expect(parsed.reason.toLowerCase()).toContain('no todos');
    expect(calls).toBe(0);
  });

  it('handles Planner replace() race: stale id gets a fresh valid-id list', async () => {
    const { ctx, store } = makeContextWithStore();
    // Planner fully replaces — old todo_1..todo_3 disappear.
    store.replace([
      { id: 'p_1', content: 'planner step a', status: 'pending' },
      { id: 'p_2', content: 'planner step b', status: 'pending' },
    ]);
    // Generator (running on stale ids) tries to update the old id.
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('todo_1');
    expect(parsed.reason).toContain('p_1');
    expect(parsed.reason).toContain('p_2');
    // Old id list must NOT be in the reason.
    expect(parsed.reason).not.toContain('todo_2');
    expect(parsed.reason).not.toContain('todo_3');
  });
});

describe('todo_update input validation', () => {
  it('returns {ok:false} when id is missing', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ status: 'in_progress' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
    expect(JSON.parse(result).reason).toContain('id');
  });

  it('returns {ok:false} when id is non-string', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 42 as unknown as string, status: 'in_progress' },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when id is empty string', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: '', status: 'in_progress' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when status is missing', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: 'todo_1' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
    expect(JSON.parse(result).reason.toLowerCase()).toContain('status');
  });

  it('returns {ok:false} on invalid status (not in allowed enum)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'archived' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('archived');
    expect(parsed.reason).toContain('in_progress');
  });

  it('rejects pending as a status (it is set automatically by store, not the tool)', async () => {
    // Per design, models cannot reset items to pending via todo_update —
    // that's resetFailed()'s job (Runner-driven on revise → next-iter).
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'pending' },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when note is non-string and non-undefined', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 42 as unknown as string },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('accepts note=undefined (treated as omitted)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed', note: undefined },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(true);
  });
});

describe('todo_update graceful degradation when store is not wired', () => {
  it('returns {ok:false} explaining todo_update is inactive (no throw)', async () => {
    // Simulates: Scout did not produce ≥2 obligations, so runner-driven
    // never wired the store. The tool was still injected to the toolset
    // (Scout/Generator/Planner all get it unconditionally), so the model
    // CAN call it — it just gets a soft refusal.
    const ctx = makeContext({ todoStore: undefined });
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain('not active');
  });
});

// FEATURE_151 (v0.7.38) — `op: 'init'` whole-list write tests.
// Mirrors Claude Code TodoWrite semantics: LLM commits the full list in one
// call; calling on an already-populated store fully replaces.

describe("todo_update FEATURE_151 op:'init' happy path", () => {
  function makeEmptyContext(): {
    ctx: KodaXToolExecutionContext;
    store: ReturnType<typeof createTodoStore>;
    notifyCount: () => number;
  } {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    return {
      ctx: makeContext({ todoStore: store }),
      store,
      notifyCount: () => calls,
    };
  }

  it('seeds an empty store and returns {ok:true, count:N}', async () => {
    const { ctx, store, notifyCount } = makeEmptyContext();
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'Audit auth', activeForm: 'Auditing auth' },
          { id: 'todo_2', content: 'Update tests' },
        ],
      },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; count?: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe('todo_1');
    expect(all[0]?.content).toBe('Audit auth');
    expect(all[0]?.activeForm).toBe('Auditing auth');
    expect(all[0]?.status).toBe('pending');
    expect(all[1]?.id).toBe('todo_2');
    expect(all[1]?.activeForm).toBeUndefined();
    // init() always notifies (even an empty seed counts as an intentional
    // event), so we expect exactly 1 onChange firing for one tool call.
    expect(notifyCount()).toBe(1);
  });

  it('accepts a single-item init (FEATURE_151 + Slice A: MIN=1 renders)', async () => {
    const { ctx, store } = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'Do the thing' }] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; count?: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(store.getAll()).toHaveLength(1);
  });

  it('REPLACES an already-populated store with new ids (drops items not in seed list)', async () => {
    // v0.7.42 update: store-layer id-match preserve (todo-store.ts:init)
    // keeps completed/skipped/cancelled status when the SAME id is
    // re-seeded. This test covers the complementary path — seeds with
    // ENTIRELY NEW ids cause the old items (including the mutated
    // completed one) to be dropped from the list. The "CC TodoWrite
    // parity" framing of the original v0.7.34 test is preserved here
    // for the new-id case; id-match preserve is exercised in the
    // dedicated todo-store.test.ts suite. Tool-layer dirty-reject was
    // prototyped + reverted in v0.7.42 (see FEATURE_175 SHIP gate
    // failure), so op:'init' on a dirty store still succeeds.
    const { ctx, store } = makeContextWithStore();
    expect(store.getAll()).toHaveLength(3);
    store.updateStatus('todo_1', 'completed');
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'p_1', content: 'New plan step 1' },
          { id: 'p_2', content: 'New plan step 2' },
        ],
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true, count: 2 });
    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((it) => it.id)).toEqual(['p_1', 'p_2']);
    // todo_1's completed status is gone because its id is not in the new
    // seed list — id-preserve only protects matched ids.
    expect(all.every((it) => it.status === 'pending')).toBe(true);
  });

  it("works as documented when omitting `op` (default 'update' branch unaffected)", async () => {
    const { ctx, store } = makeContextWithStore();
    // No `op` field → defaults to 'update'; existing behavior preserved.
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'in_progress', activeForm: 'Renaming function' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll()[0]?.status).toBe('in_progress');
    expect(store.getAll()[0]?.activeForm).toBe('Renaming function');
  });
});

describe("todo_update FEATURE_151 op:'init' input validation", () => {
  function makeEmptyContext(): KodaXToolExecutionContext {
    return makeContext({ todoStore: createTodoStore() });
  }

  it("rejects unknown `op` value", async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'replace', items: [{ id: 'a', content: 'b' }] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('Invalid op');
    expect(parsed.reason).toContain("'init'");
  });

  it('rejects op:init with non-array items', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'init', items: { id: 'a', content: 'b' } },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items');
    expect(parsed.reason).toContain('array');
  });

  it('rejects op:init with empty items array', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate({ op: 'init', items: [] }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('>= 1');
  });

  it('rejects op:init with malformed item object', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'A' }, null] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[1]');
  });

  it('rejects op:init with empty id', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: '', content: 'A' }] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[0].id');
  });

  it('rejects op:init with duplicate ids', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'A' },
          { id: 'todo_1', content: 'B' },
        ],
      },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('duplicate');
  });

  it('rejects op:init with empty content', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: '' }] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[0].content');
  });

  it('rejects op:init with non-string activeForm', async () => {
    const ctx = makeEmptyContext();
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [{ id: 'todo_1', content: 'A', activeForm: 42 as unknown as string }],
      },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[0].activeForm');
  });

  it('treats omitted activeForm as undefined (not "")', async () => {
    const ctx = makeContext({ todoStore: createTodoStore() });
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'A' }] },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true, count: 1 });
    const stored = (ctx.todoStore!.getAll())[0];
    expect(stored?.activeForm).toBeUndefined();
  });

  it('does not attempt op:init when todoStore is not wired (graceful degradation)', async () => {
    const ctx = makeContext({ todoStore: undefined });
    const result = await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'A' }] },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    // Same "not active" message as the v0.7.34 update path — store unwired
    // is store unwired regardless of which op the LLM tried.
    expect(parsed.reason.toLowerCase()).toContain('not active');
  });
});

// v0.7.42 — dirty-store reject was PROTOTYPED here and REVERTED after
// FEATURE_175 Layer 2 panel ran zhipu/glm51 0/5 on both cases (intent-
// vs-action floor; see SHIP gate (b) in
// benchmark/datasets/feature-175-init-reject-recovery/cases.ts). The
// store-layer id-match preserve in todo-store.ts:init() covers the
// dominant case (same ids re-seeded); the pivot path (entirely new
// ids) still drops prior items via init's destructive-replace
// semantic. The 7 dirty-reject tests that lived here in the prototype
// were removed alongside the executeInitOp guard. Pinning the absence
// of the reject so a future re-introduction triggers a deliberate
// re-evaluation.
describe("todo_update v0.7.42 op:'init' on dirty store still succeeds (no reject)", () => {
  it("op:'init' on a store with completed/failed/cancelled items returns ok:true (no dirty-reject)", async () => {
    const { ctx, store } = makeContextWithStore();
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'failed', 'first try blew up');
    store.updateStatus('todo_3', 'cancelled', 'pivoted');
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'p_1', content: 'New plan step 1' },
          { id: 'p_2', content: 'New plan step 2' },
        ],
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true, count: 2 });
    // All three old ids are gone (new seed list uses fresh ids).
    expect(store.allIds()).toEqual(['p_1', 'p_2']);
  });
});

// FEATURE_114 v0.7.36 Slice 1 — schema additions:
//   - `cancelled` accepted as a status transition value
//   - `evaluator: "build" | "test" | "lint"` accepted as an init-item field,
//     persisted on the resulting TodoItem
describe("todo_update FEATURE_114 v0.7.36 Slice 1 — cancelled status + evaluator hint", () => {
  it('accepts status="cancelled" on op="update" (Worker mid-execution drop)', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_2', status: 'cancelled', note: 'no longer needed' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    const item = store.getAll().find((it) => it.id === 'todo_2');
    expect(item?.status).toBe('cancelled');
    expect(item?.note).toBe('no longer needed');
  });

  it('rejects status="pending" — runner-only transition (parity with pre-FEATURE_114)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: 'todo_2', status: 'pending' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('Invalid status');
  });

  it("op:'init' persists evaluator hint on resulting TodoItem", async () => {
    const ctx = makeContext({ todoStore: createTodoStore() });
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'Run unit tests', evaluator: 'test' },
          { id: 'todo_2', content: 'Type-check the module', evaluator: 'build' },
          { id: 'todo_3', content: 'Format and lint', evaluator: 'lint' },
          { id: 'todo_4', content: 'Manual verification step' /* no evaluator */ },
        ],
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true, count: 4 });
    const items = ctx.todoStore!.getAll();
    expect(items[0]?.evaluator).toBe('test');
    expect(items[1]?.evaluator).toBe('build');
    expect(items[2]?.evaluator).toBe('lint');
    expect(items[3]?.evaluator).toBeUndefined();
  });

  it("op:'init' rejects unknown evaluator values", async () => {
    const ctx = makeContext({ todoStore: createTodoStore() });
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [{ id: 'todo_1', content: 'A', evaluator: 'typecheck' }],
      },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[0].evaluator');
    expect(parsed.reason).toContain("'build' | 'test' | 'lint'");
  });

  it("op:'init' rejects non-string evaluator values", async () => {
    const ctx = makeContext({ todoStore: createTodoStore() });
    const result = await toolTodoUpdate(
      {
        op: 'init',
        items: [{ id: 'todo_1', content: 'A', evaluator: 1 }],
      },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('items[0].evaluator');
  });
});

// FEATURE_170 (v0.7.41) — per-item PATCH fields, status:'deleted' delete
// path, 'todo:before-complete' hook gating, and 'todo:updated' /
// 'todo:deleted' event emission with source:'tool'.

describe('todo_update FEATURE_170 — patch fields without status transition', () => {
  it('patches content alone (no status change) and returns {ok:true}', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', content: 'Rename function AND update callers' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    const item = store.getAll().find((it) => it.id === 'todo_1');
    expect(item?.content).toBe('Rename function AND update callers');
    expect(item?.status).toBe('pending'); // unchanged
  });

  it('patches evaluator alone (mirrors op:init evaluator hint)', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', evaluator: 'test' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll().find((it) => it.id === 'todo_1')?.evaluator).toBe('test');
  });

  it('patches metadata (shallow-merge into empty) and returns {ok:true}', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', metadata: { owner: 'worker-1', tag: 'auth' } },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll().find((it) => it.id === 'todo_1')?.metadata).toEqual({
      owner: 'worker-1',
      tag: 'auth',
    });
  });

  it('shallow-merges metadata across two patch calls (claudecode TaskUpdate parity)', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_1', metadata: { owner: 'worker-1' } }, ctx);
    await toolTodoUpdate({ id: 'todo_1', metadata: { tag: 'auth' } }, ctx);
    expect(store.getAll().find((it) => it.id === 'todo_1')?.metadata).toEqual({
      owner: 'worker-1',
      tag: 'auth',
    });
  });

  it('clears metadata when caller passes explicit null', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_1', metadata: { owner: 'worker-1' } }, ctx);
    expect(store.getAll().find((it) => it.id === 'todo_1')?.metadata).toEqual({ owner: 'worker-1' });
    const result = await toolTodoUpdate({ id: 'todo_1', metadata: null }, ctx);
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll().find((it) => it.id === 'todo_1')?.metadata).toBeUndefined();
  });

  it('combines patch fields with a status transition in one call', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      {
        id: 'todo_1',
        status: 'in_progress',
        content: 'Renamed function (refined scope)',
        activeForm: 'Renaming function (refined scope)',
        metadata: { startedAt: 'iso-timestamp-stub' },
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    const item = store.getAll().find((it) => it.id === 'todo_1');
    expect(item?.status).toBe('in_progress');
    expect(item?.content).toBe('Renamed function (refined scope)');
    expect(item?.activeForm).toBe('Renaming function (refined scope)');
    expect(item?.metadata).toEqual({ startedAt: 'iso-timestamp-stub' });
  });

  it('rejects empty op:update payload (no status, no patch fields)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: 'todo_1' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/Empty op:'update' payload/);
  });

  it('rejects empty-string content (must be non-empty)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: 'todo_1', content: '' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/content.*non-empty/);
  });

  it('rejects invalid evaluator on op:update', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', evaluator: 'typecheck' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/evaluator/);
  });

  it('rejects non-object metadata (array)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', metadata: [1, 2, 3] as unknown as Record<string, unknown> },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/metadata/);
  });
});

describe("todo_update FEATURE_170 — status:'deleted' delete path", () => {
  it("removes the item from the store and returns {ok:true}", async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_2', status: 'deleted' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.has('todo_2')).toBe(false);
    expect(store.getAll().map((it) => it.id)).toEqual(['todo_1', 'todo_3']);
  });

  it('does NOT reuse the deleted id on subsequent add (monotonic counter)', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_2', status: 'deleted' }, ctx);
    // store.add() should mint a fresh id past the highest seeded.
    const newId = store.add({ content: 'New step' });
    expect(newId).not.toBe('todo_2');
  });

  it('returns {ok:false} on delete of unknown id (no store mutation)', async () => {
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_99', status: 'deleted' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('todo_99');
    expect(store.getAll()).toHaveLength(3); // unchanged
  });

  it('ignores incidentally-malformed patch fields when status="deleted" (reviewer MEDIUM fix)', async () => {
    // Regression pin: prior to the C4 review fix, the patch-field
    // validators ran before the delete branch, so `{status:'deleted',
    // note:42}` would be rejected with a misleading "Invalid note" error
    // and the intended delete silently dropped. The delete branch now
    // runs first and ignores all patch fields per its documented
    // semantics.
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      {
        id: 'todo_2',
        status: 'deleted',
        // Each of these would individually trip a patch-field validator,
        // but on the delete path they must all be ignored.
        note: 42 as unknown as string,
        content: '' as unknown as string,
        evaluator: 'typecheck' as unknown as string,
        metadata: [1, 2, 3] as unknown as Record<string, unknown>,
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.has('todo_2')).toBe(false);
  });
});

describe("todo_update FEATURE_170 — 'todo:before-complete' hook + events", () => {
  let runtime: ReturnType<typeof createExtensionRuntime> | null = null;

  beforeEach(() => {
    runtime = null;
  });

  afterEach(async () => {
    const active = getActiveExtensionRuntime();
    if (active) {
      await active.dispose();
    }
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });

  it("blocks status='completed' via hook string and returns {ok:false, reason:<string>}", async () => {
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-complete', (hookCtx) => {
      if (hookCtx.item.content.includes('forbidden')) {
        return 'policy: cannot complete items mentioning forbidden';
      }
    });
    const { ctx, store } = makeContextWithStore([
      { id: 'todo_1', content: 'forbidden step' },
      { id: 'todo_2', content: 'safe step' },
    ]);
    const blocked = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const blockedParsed = JSON.parse(blocked) as { ok: boolean; reason: string };
    expect(blockedParsed.ok).toBe(false);
    expect(blockedParsed.reason).toBe('policy: cannot complete items mentioning forbidden');
    // Store must not have been mutated.
    expect(store.getAll().find((it) => it.id === 'todo_1')?.status).toBe('pending');

    // Safe item still goes through.
    const ok = await toolTodoUpdate(
      { id: 'todo_2', status: 'completed' },
      ctx,
    );
    expect(JSON.parse(ok)).toEqual({ ok: true });
    expect(store.getAll().find((it) => it.id === 'todo_2')?.status).toBe('completed');
  });

  it("blocks via hook=false with reason:'blocked-by-hook'", async () => {
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-complete', () => false);
    const { ctx, store } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('blocked-by-hook');
    expect(store.getAll().find((it) => it.id === 'todo_1')?.status).toBe('pending');
  });

  it("does NOT fire 'todo:before-complete' for idempotent completed→completed re-write", async () => {
    runtime = createExtensionRuntime().activate();
    let hookCalls = 0;
    runtime.registerHook('todo:before-complete', () => {
      hookCalls++;
    });
    const { ctx } = makeContextWithStore();
    // First completion fires the hook (pending → completed).
    await toolTodoUpdate({ id: 'todo_1', status: 'completed' }, ctx);
    expect(hookCalls).toBe(1);
    // Second completion is idempotent — hook must NOT fire again.
    await toolTodoUpdate({ id: 'todo_1', status: 'completed' }, ctx);
    expect(hookCalls).toBe(1);
  });

  it("does NOT fire 'todo:before-complete' for non-completion transitions", async () => {
    runtime = createExtensionRuntime().activate();
    let hookCalls = 0;
    runtime.registerHook('todo:before-complete', () => {
      hookCalls++;
    });
    const { ctx } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_1', status: 'in_progress' }, ctx);
    await toolTodoUpdate({ id: 'todo_1', status: 'failed', note: 'oops' }, ctx);
    expect(hookCalls).toBe(0);
  });

  it("fires 'todo:updated' with {id, before, after, changedFields, source:'tool'}", async () => {
    runtime = createExtensionRuntime().activate();
    const received: Array<{
      id: string;
      source: string;
      beforeStatus: string;
      afterStatus: string;
      changedFields: readonly string[];
    }> = [];
    runtime.on('todo:updated', (payload) => {
      received.push({
        id: payload.id,
        source: payload.source,
        beforeStatus: payload.before.status,
        afterStatus: payload.after.status,
        changedFields: [...payload.changedFields],
      });
    });

    const { ctx } = makeContextWithStore();
    await toolTodoUpdate(
      { id: 'todo_1', status: 'in_progress', activeForm: 'Running' },
      ctx,
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 'todo_1',
      source: 'tool',
      beforeStatus: 'pending',
      afterStatus: 'in_progress',
    });
    expect(received[0]?.changedFields).toEqual(
      expect.arrayContaining(['status', 'activeForm']),
    );
  });

  it("does NOT fire 'todo:updated' on no-op patch (same value, no diff)", async () => {
    runtime = createExtensionRuntime().activate();
    let events = 0;
    runtime.on('todo:updated', () => {
      events++;
    });
    const { ctx } = makeContextWithStore();
    // First in_progress flip fires.
    await toolTodoUpdate({ id: 'todo_1', status: 'in_progress' }, ctx);
    expect(events).toBe(1);
    // Second identical call is a no-op (store.patch returns early).
    await toolTodoUpdate({ id: 'todo_1', status: 'in_progress' }, ctx);
    expect(events).toBe(1);
  });

  it("fires 'todo:deleted' with {id, item, source:'tool'} on status='deleted'", async () => {
    runtime = createExtensionRuntime().activate();
    const received: Array<{ id: string; source: string; itemContent: string }> = [];
    runtime.on('todo:deleted', (payload) => {
      received.push({
        id: payload.id,
        source: payload.source,
        itemContent: payload.item.content,
      });
    });

    const { ctx } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_2', status: 'deleted' }, ctx);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: 'todo_2',
      source: 'tool',
      itemContent: 'Update callers',
    });
  });

  it("does NOT fire 'todo:updated' when 'todo:before-complete' blocks", async () => {
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-complete', () => 'blocked');
    let events = 0;
    runtime.on('todo:updated', () => {
      events++;
    });
    const { ctx } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_1', status: 'completed' }, ctx);
    expect(events).toBe(0);
  });
});
