/**
 * FEATURE_170 (v0.7.41) — Todo V2 Migration end-to-end integration test.
 *
 * Hermetic. No LLM calls. Exercises the full per-task surface through
 * the tool layer to confirm:
 *
 *   1. `op:'init'` seeds the store with monotonic ids and resets the
 *      `add()` counter to the highest seeded suffix.
 *   2. `todo_create` inserts a mid-task item without disturbing the
 *      already-seeded list and emits `'todo:created'`.
 *   3. `todo_update` patch-only path (content/activeForm/metadata)
 *      emits `'todo:updated'` with a populated `changedFields` set.
 *   4. `todo_update` status-transition to `'completed'` fires
 *      `'todo:before-complete'` exactly once.
 *   5. `todo_update` `status:'deleted'` removes the item and emits
 *      `'todo:deleted'`.
 *   6. `todo_update` `status:'cancelled'` keeps the item visible and
 *      emits `'todo:updated'` (NOT `'todo:deleted'`).
 *   7. Runner-side `autoCompleteOnAccept()` finalizes residual non-
 *      terminal items (the Evaluator-accept path) WITHOUT firing
 *      `'todo:before-complete'` — hook authority is reserved for
 *      LLM-initiated mutations.
 *
 * This file is the Layer 1 acceptance test for FEATURE_170. The Layer 2
 * LLM-behavioral eval (does the model actually pick the right tool for
 * the right intent) is gated on the v0.7.41 release per FEATURE_104.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
} from '../extensions/index.js';
import { toolTodoCreate } from '../tools/todo-create.js';
import { toolTodoUpdate } from '../tools/todo-update.js';
import { createTodoStore, type TodoStore } from './todo-store.js';
import type { KodaXToolExecutionContext, TodoItem } from '../types.js';

interface CreatedEvent {
  readonly id: string;
  readonly itemContent: string;
  readonly source: string;
}
interface UpdatedEvent {
  readonly id: string;
  readonly beforeStatus: string;
  readonly afterStatus: string;
  readonly changedFields: readonly string[];
  readonly source: string;
}
interface DeletedEvent {
  readonly id: string;
  readonly itemContent: string;
  readonly source: string;
}

function makeCtx(store: TodoStore): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    todoStore: store,
  } as KodaXToolExecutionContext;
}

describe('FEATURE_170 — Todo V2 end-to-end (hermetic, no LLM)', () => {
  let runtime: ReturnType<typeof createExtensionRuntime> | null = null;
  let created: CreatedEvent[] = [];
  let updated: UpdatedEvent[] = [];
  let deleted: DeletedEvent[] = [];
  let beforeCompleteCount = 0;

  beforeEach(() => {
    runtime = createExtensionRuntime().activate();
    created = [];
    updated = [];
    deleted = [];
    beforeCompleteCount = 0;
    runtime.on('todo:created', (p) => {
      created.push({ id: p.id, itemContent: p.item.content, source: p.source });
    });
    runtime.on('todo:updated', (p) => {
      updated.push({
        id: p.id,
        beforeStatus: p.before.status,
        afterStatus: p.after.status,
        changedFields: [...p.changedFields],
        source: p.source,
      });
    });
    runtime.on('todo:deleted', (p) => {
      deleted.push({ id: p.id, itemContent: p.item.content, source: p.source });
    });
    runtime.registerHook('todo:before-complete', () => {
      beforeCompleteCount++;
    });
  });

  afterEach(async () => {
    const active = getActiveExtensionRuntime();
    if (active) await active.dispose();
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });

  it('runs a realistic Scout-seed → mid-task insert → patch → complete → delete → cancel → accept flow', async () => {
    const store = createTodoStore();
    const ctx = makeCtx(store);

    // ─── Phase 1: Scout-equivalent op:'init' seed (the v0.7.34 path). ───
    const initRes = await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'Read failing test', activeForm: 'Reading failing test' },
          { id: 'todo_2', content: 'Identify root cause', activeForm: 'Identifying root cause' },
          { id: 'todo_3', content: 'Apply minimal fix', activeForm: 'Applying minimal fix' },
        ],
      },
      ctx,
    );
    expect(JSON.parse(initRes)).toEqual({ ok: true, count: 3 });
    expect(store.allIds()).toEqual(['todo_1', 'todo_2', 'todo_3']);
    // op:'init' does NOT emit per-item tool events — it is a single
    // whole-list seed; the REPL host observes via onChange.
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);

    // ─── Phase 2: Worker realizes mid-task a tmp-cleanup step was missed. ───
    const createRes = await toolTodoCreate(
      { content: 'Clean up tmp dir', activeForm: 'Cleaning up tmp dir' },
      ctx,
    );
    const createParsed = JSON.parse(createRes) as { ok: boolean; id: string };
    expect(createParsed.ok).toBe(true);
    // Counter advanced past the highest seeded suffix (3) to 4 — id reuse forbidden.
    expect(createParsed.id).toBe('todo_4');
    expect(store.allIds()).toEqual(['todo_1', 'todo_2', 'todo_3', 'todo_4']);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: 'todo_4',
      itemContent: 'Clean up tmp dir',
      source: 'tool',
    });

    // ─── Phase 3: Patch the new item's metadata (FEATURE_170 patch path). ───
    const patchRes = await toolTodoUpdate(
      { id: 'todo_4', metadata: { owner: 'cleanup-bot', priority: 'low' } },
      ctx,
    );
    expect(JSON.parse(patchRes)).toEqual({ ok: true });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: 'todo_4',
      beforeStatus: 'pending',
      afterStatus: 'pending',
      source: 'tool',
    });
    expect(updated[0]?.changedFields).toEqual(['metadata']);
    expect(beforeCompleteCount).toBe(0); // patch alone is not a completion

    // ─── Phase 4: Worker flips todo_1 → completed via tool. Hook fires once. ───
    const completeRes = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    expect(JSON.parse(completeRes)).toEqual({ ok: true });
    expect(beforeCompleteCount).toBe(1);
    expect(updated).toHaveLength(2);
    expect(updated[1]).toMatchObject({
      id: 'todo_1',
      beforeStatus: 'pending',
      afterStatus: 'completed',
      source: 'tool',
    });
    expect(updated[1]?.changedFields).toEqual(['status']);

    // ─── Phase 5: Drop a step that turned out to be off-plan (deleted). ───
    const deleteRes = await toolTodoUpdate(
      { id: 'todo_2', status: 'deleted' },
      ctx,
    );
    expect(JSON.parse(deleteRes)).toEqual({ ok: true });
    expect(store.has('todo_2')).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      id: 'todo_2',
      itemContent: 'Identify root cause',
      source: 'tool',
    });
    // status:'deleted' must NOT fire 'todo:before-complete' (not a
    // completion transition) and must NOT emit 'todo:updated' (the
    // event for the removed item is 'todo:deleted').
    expect(beforeCompleteCount).toBe(1);
    expect(updated).toHaveLength(2);

    // ─── Phase 6: Mark todo_3 cancelled (breadcrumb stays visible). ───
    const cancelRes = await toolTodoUpdate(
      { id: 'todo_3', status: 'cancelled', note: 'covered by todo_1\'s fix' },
      ctx,
    );
    expect(JSON.parse(cancelRes)).toEqual({ ok: true });
    expect(store.has('todo_3')).toBe(true);
    expect(store.getAll().find((it) => it.id === 'todo_3')?.status).toBe('cancelled');
    expect(updated).toHaveLength(3);
    expect(updated[2]?.changedFields).toEqual(expect.arrayContaining(['status', 'note']));
    expect(deleted).toHaveLength(1); // unchanged — cancelled is NOT a delete

    // ─── Phase 7: Evaluator accept → runner-side autoCompleteOnAccept. ───
    // Pre-state: todo_4 is still pending. autoCompleteOnAccept flips
    // every pending/in_progress item to completed without consulting
    // the LLM. The hook MUST NOT fire — hook authority is reserved for
    // LLM-driven mutations per ExtensionHookMap JSDoc.
    const changed = store.autoCompleteOnAccept();
    expect(changed).toBe(1); // only todo_4 was still non-terminal
    expect(store.getAll().find((it) => it.id === 'todo_4')?.status).toBe('completed');
    expect(beforeCompleteCount).toBe(1); // STILL 1 — runner path bypasses the hook

    // Final store state shape:
    //   todo_1 completed (tool), todo_2 removed, todo_3 cancelled,
    //   todo_4 completed (autoComplete)
    const finalItems = store.getAll().map((it) => ({
      id: it.id,
      status: it.status,
      metadata: it.metadata,
    }));
    expect(finalItems).toEqual([
      { id: 'todo_1', status: 'completed', metadata: undefined },
      { id: 'todo_3', status: 'cancelled', metadata: undefined },
      { id: 'todo_4', status: 'completed', metadata: { owner: 'cleanup-bot', priority: 'low' } },
    ]);
  });

  it('hook block on the new mid-task item prevents the create + leaves the seeded list intact', async () => {
    // Replace the default permissive hook with a policy that rejects
    // any content containing "skip". The seed should still go through
    // because op:'init' is a one-shot seed, not a per-item create.
    const active = getActiveExtensionRuntime();
    if (active) await active.dispose();
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-create', (hookCtx) => {
      if (hookCtx.seed.content.includes('skip')) return 'policy: cannot skip steps';
    });

    const store = createTodoStore();
    const ctx = makeCtx(store);
    await toolTodoUpdate(
      {
        op: 'init',
        items: [{ id: 'todo_1', content: 'real step' }],
      },
      ctx,
    );
    expect(store.allIds()).toEqual(['todo_1']);

    const blocked = await toolTodoCreate({ content: 'skip the verification' }, ctx);
    const parsed = JSON.parse(blocked) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('policy: cannot skip steps');
    // Hook fires BEFORE store.add — no item allocated, counter
    // unchanged, list shape preserved.
    expect(store.allIds()).toEqual(['todo_1']);

    // Subsequent legitimate create still works and lands at todo_2
    // (counter advanced past the seeded suffix).
    const ok = await toolTodoCreate({ content: 'follow-up step' }, ctx);
    expect((JSON.parse(ok) as { id: string }).id).toBe('todo_2');
  });

  it('isolation: store state stays per-task — a second store starts fresh', async () => {
    // Per design: stores are task-scoped, not session-scoped. A new
    // store from createTodoStore() must not see any prior task's items
    // and must reset the id counter to 0.
    const storeA = createTodoStore();
    await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'A1' },
          { id: 'todo_2', content: 'A2' },
        ],
      },
      makeCtx(storeA),
    );
    expect(storeA.allIds()).toEqual(['todo_1', 'todo_2']);

    const storeB = createTodoStore();
    const ctxB = makeCtx(storeB);
    expect(storeB.allIds()).toEqual([]);

    const firstCreate = await toolTodoCreate({ content: 'fresh task step' }, ctxB);
    expect((JSON.parse(firstCreate) as { id: string }).id).toBe('todo_1');
    expect(storeB.allIds()).toEqual(['todo_1']);
    // Store A unchanged.
    expect(storeA.allIds()).toEqual(['todo_1', 'todo_2']);
  });

  it("the empty-payload guard catches accidental no-op todo_update calls (FEATURE_170)", async () => {
    // Without this guard, the LLM could call todo_update({id}) with no
    // status or patch fields and get {ok:true} despite making no
    // mutation — a silent dead end that masks "what should I have done
    // here" confusion. The guard surfaces the error so the model can
    // self-correct on the next turn.
    const store = createTodoStore();
    await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'step' }] },
      makeCtx(store),
    );
    const ctx = makeCtx(store);

    const noop = await toolTodoUpdate({ id: 'todo_1' }, ctx);
    const parsed = JSON.parse(noop) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/Empty op:'update' payload/);
    // No event should have fired for the no-op rejection.
    expect(updated).toHaveLength(0);
  });

  // Guard against the silent-data-loss failure mode we deliberately
  // protect against in todo_update: an LLM that hand-feeds a malformed
  // patch field alongside status:'deleted' must NOT have the delete
  // dropped just because the (ignored) patch field is invalid.
  it("status:'deleted' is not gated by patch-field validators (regression pin)", async () => {
    const store = createTodoStore();
    await toolTodoUpdate(
      {
        op: 'init',
        items: [
          { id: 'todo_1', content: 'real step' },
          { id: 'todo_2', content: 'doomed step' },
        ],
      },
      makeCtx(store),
    );
    const ctx = makeCtx(store);

    const res = await toolTodoUpdate(
      {
        id: 'todo_2',
        status: 'deleted',
        // Each of these would individually be rejected by a patch-field
        // validator. The delete branch runs first and ignores them.
        note: 42 as unknown as string,
        evaluator: 'typecheck' as unknown as string,
      },
      ctx,
    );
    expect(JSON.parse(res)).toEqual({ ok: true });
    expect(store.has('todo_2')).toBe(false);
    expect(deleted).toHaveLength(1);
  });

  it('extension hook failures are recorded but never break the tool path', async () => {
    // ExtensionHookMap return-shape semantics: a hook that THROWS is a
    // logic error in the extension, not a policy block. The runtime
    // records the failure and treats the absent return as "allow".
    // Confirm a throwing 'todo:before-complete' does not block the
    // completion.
    const active = getActiveExtensionRuntime();
    if (active) await active.dispose();
    runtime = createExtensionRuntime().activate();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtime.registerHook('todo:before-complete', () => {
      throw new Error('extension misbehaved');
    });

    const store = createTodoStore();
    await toolTodoUpdate(
      { op: 'init', items: [{ id: 'todo_1', content: 'step' }] },
      makeCtx(store),
    );

    const res = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      makeCtx(store),
    );
    expect(JSON.parse(res)).toEqual({ ok: true });
    expect(store.getAll().find((it: TodoItem) => it.id === 'todo_1')?.status).toBe('completed');
    // The runtime should have recorded a failure but the tool path is
    // unaffected.
    const diagnostics = runtime.getDiagnostics();
    expect(
      diagnostics.failures.some(
        (f) => f.stage === 'hook' && f.target === 'todo:before-complete',
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });
});
