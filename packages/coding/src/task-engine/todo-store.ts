/**
 * Todo Store — FEATURE_097 (v0.7.34).
 *
 * In-memory store for the Scout-seeded todo list. Lives within the scope
 * of one `runManagedTaskViaRunner` call; not shared across tasks, not
 * persisted across sessions (per design-doc §5 决策细节 ④ task-scoped
 * resume behavior).
 *
 * KodaX is a single-process CLI — no fs.watch, no proper-lockfile,
 * none of the Claude Code V2 swarm-multiprocess machinery. The store
 * is a plain object hidden behind a small interface.
 *
 * State transitions (Evaluator verdict handling per §5 ①):
 *   - `accept` verdict   → all `pending` AND `in_progress` items auto-flip to
 *                          `completed`. Including `in_progress` is intentional:
 *                          Evaluator only accepts when the work is done, so any
 *                          item the model forgot to close via `todo_update` is
 *                          finalized automatically. The design doc says
 *                          "remaining pending" which abbreviates "any
 *                          non-terminal state".
 *   - `revise` verdict   → all current `in_progress` auto-flip to `failed`
 *                          (with note); the next iteration's `resetFailed()`
 *                          flips them back to `pending` so Generator retries
 *   - `replan` verdict   → caller invokes `reset()` then Planner repopulates
 *                          via `replace(...)`
 */

import type { TodoItem, TodoList, TodoStatus } from '../types.js';

export interface TodoInit {
  readonly id: string;
  readonly content: string;
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  /**
   * FEATURE_149 (v0.7.38) — present-continuous form for spinner display
   * while this item is `in_progress`. See `TodoItem.activeForm` JSDoc.
   */
  readonly activeForm?: string;
}

export interface TodoStoreOptions {
  /**
   * Fired whenever the store's contents actually change. Wire this to
   * `KodaXEvents.onTodoUpdate` at runner-driven setup time so callers
   * (the `todo_update` tool, Evaluator verdict auto-handlers) do not
   * each have to remember to emit the event after every mutation.
   *
   * No-op writes (unknown id on updateStatus, 0-change auto-fills,
   * reset() on an empty store) do NOT fire onChange — only real
   * state transitions surface to subscribers.
   */
  readonly onChange?: (items: TodoList) => void;
}

export interface TodoStore {
  /** True when the store has at least one item. */
  hasItems(): boolean;
  /** True when the given id corresponds to an existing item. */
  has(id: string): boolean;
  /** Stable list of all valid ids in insertion order. Useful for unknown-id error reasons. */
  allIds(): readonly string[];
  /** Snapshot of all items (frozen, safe to pass to event handlers). */
  getAll(): TodoList;
  /** Replace the store's contents with a fresh seed list. */
  init(seeds: readonly TodoInit[]): void;
  /**
   * Update one item's status. When `note` is supplied, replaces the item's
   * existing note; when omitted (undefined), preserves any existing note.
   * Use `resetFailed()` (or pass an explicit empty-string note) to clear.
   * No-op for unknown id.
   *
   * FEATURE_149 (v0.7.38): when `activeForm` is supplied, replaces the
   * item's `activeForm` field (used by the spinner). Omitted = preserve
   * existing. Empty string = clear. Same preserve-vs-clear semantics as
   * `note`.
   */
  updateStatus(id: string, status: TodoStatus, note?: string, activeForm?: string): boolean;
  /** Planner H2 path: full-replace the list (used after the planner refines obligations). */
  replace(items: readonly TodoItem[]): void;
  /**
   * Auto-fill Evaluator `accept` verdict: every `pending` AND `in_progress`
   * item flips to `completed`. Items already in a terminal state
   * (`completed` / `failed` / `skipped`) are left as-is. Returns the number
   * of items that actually changed. Calling on an empty store returns 0.
   */
  autoCompleteOnAccept(): number;
  /**
   * Auto-fill Evaluator `revise` verdict: every `in_progress` item flips
   * to `failed` (with the supplied reviewer note). Returns the number
   * that actually changed.
   */
  markInProgressFailed(note: string): number;
  /**
   * Reset every `failed` item back to `pending`. Called at the start of
   * the next Generator iteration so the model retries them.
   */
  resetFailed(): number;
  /** Drop everything. Called on `replan` verdict and at task end. */
  reset(): void;
}

export function createTodoStore(options: TodoStoreOptions = {}): TodoStore {
  // The internal array is mutable; consumers see frozen snapshots only.
  let items: TodoItem[] = [];
  const onChange = options.onChange;

  function freeze(arr: readonly TodoItem[]): TodoList {
    return Object.freeze(arr.slice()) as TodoList;
  }

  function notifyIfChanged(changed: boolean): void {
    if (changed && onChange) onChange(freeze(items));
  }

  return {
    hasItems(): boolean {
      return items.length > 0;
    },
    has(id: string): boolean {
      return items.some((it) => it.id === id);
    },
    allIds(): readonly string[] {
      return Object.freeze(items.map((it) => it.id));
    },
    getAll(): TodoList {
      return freeze(items);
    },
    init(seeds): void {
      items = seeds.map((seed) => ({
        id: seed.id,
        content: seed.content,
        status: 'pending' as TodoStatus,
        owner: seed.owner,
        sourceObligationIndex: seed.sourceObligationIndex,
        activeForm: seed.activeForm,
      }));
      // init always notifies — even an empty seed list represents an
      // intentional "the task is starting, here is the (empty) plan" event.
      notifyIfChanged(true);
    },
    updateStatus(id, status, note, activeForm): boolean {
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return false;
      const prev = items[idx]!;
      // Always replace the slot rather than mutate the existing object —
      // immutability is part of the contract: snapshots already handed to
      // event subscribers must not appear to change. When `note` is omitted
      // we preserve `prev.note` rather than erasing it; this matters when a
      // `failed` item carrying an Evaluator note is later re-tried by the
      // Generator via `updateStatus(id, 'in_progress')` with no note arg —
      // the previous failure context should remain attached to the item.
      // FEATURE_149 (v0.7.38): same preserve-vs-replace semantics for
      // `activeForm` — omitted preserves existing, supplied replaces.
      let next: TodoItem = { ...prev, status };
      if (note !== undefined) next = { ...next, note };
      if (activeForm !== undefined) next = { ...next, activeForm };
      // Honour the onChange "no-op writes do NOT fire" contract: when
      // status AND note AND activeForm are all unchanged this call is
      // semantically a no-op (e.g., the LLM emitted
      // `todo_update({id, status:'in_progress'})` a second time after the
      // first one already flipped it). Skip the notification to avoid
      // wasted React renders. We still return `true` because the id was
      // found — the tool-level contract reports success.
      if (
        next.status === prev.status
        && next.note === prev.note
        && next.activeForm === prev.activeForm
      ) {
        return true;
      }
      items = items.map((it, i) => (i === idx ? next : it));
      notifyIfChanged(true);
      return true;
    },
    replace(next): void {
      items = next.map((it) => ({ ...it }));
      notifyIfChanged(true);
    },
    autoCompleteOnAccept(): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'pending' || it.status === 'in_progress') {
          changed++;
          return { ...it, status: 'completed' as TodoStatus };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    markInProgressFailed(note): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'in_progress') {
          changed++;
          return { ...it, status: 'failed' as TodoStatus, note };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    resetFailed(): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'failed') {
          changed++;
          return { ...it, status: 'pending' as TodoStatus, note: undefined };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    reset(): void {
      const wasNonEmpty = items.length > 0;
      items = [];
      notifyIfChanged(wasNonEmpty);
    },
  };
}
