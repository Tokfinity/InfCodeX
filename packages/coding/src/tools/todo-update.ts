/**
 * KodaX `todo_update` Tool — FEATURE_097 (v0.7.34) + FEATURE_151 (v0.7.38).
 *
 * Drives the todo plan list visible in the AMA REPL surface. The tool is
 * injected into Scout (H0 path), Generator, and Planner tool sets at
 * runner setup time; Evaluator does NOT receive it (its verdict drives
 * the list via runner-side auto-handling per design §5 ①).
 *
 * FEATURE_151 (v0.7.38) added the `op` parameter so the LLM has a path
 * equivalent to Claude Code's `TodoWrite` whole-list write — previously
 * the only seeding path was Runner-driven from Scout's
 * `executionObligations` (and only when length >= 2). When Scout judges
 * a task as not requiring a plan but the executing LLM later realises
 * one is needed (e.g. the work expanded mid-task), the LLM can now
 * commit a plan via `op: 'init'`.
 *
 * Contract:
 *
 *   Input (op-discriminated union):
 *
 *     op?: 'init' | 'update'   — defaults to 'update' for back-compat.
 *
 *   ── op === 'update' (or omitted) — single-item state transition:
 *     id        string     — required. Must match a current todo id.
 *     status    enum       — required. one of: in_progress | completed | failed | skipped.
 *                                     pending is intentionally excluded — items
 *                                     start at pending automatically and only
 *                                     `resetFailed()` (Runner-driven) sends them
 *                                     back to that state.
 *     note      string?    — optional. Free-text reason / detail. When omitted,
 *                                     any pre-existing note on the item is
 *                                     preserved.
 *     activeForm string?   — optional. Present-continuous form ("Running tests").
 *                                     Drives the spinner verb when status flips
 *                                     to in_progress (FEATURE_149).
 *
 *   ── op === 'init' (FEATURE_151) — whole-list seed/replace:
 *     items     [{id, content, activeForm?}]  — required. >= 1 entry.
 *                                     Each id must be a non-empty string and
 *                                     unique within the list. content non-empty.
 *                                     Calling on an already-populated store
 *                                     fully REPLACES — items not present in
 *                                     the new list are dropped (matches Claude
 *                                     Code TodoWrite semantics).
 *
 *   Output (string, JSON-stringified):
 *     {ok: true}                                — success
 *     {ok: true, count: N}                      — success on op:'init'; N is
 *                                                   the number of items now in
 *                                                   the store
 *     {ok: false, reason: "Unknown todo id ..."} — id not in store on update;
 *                                                   reason includes the full set
 *                                                   of currently valid ids so the
 *                                                   model can self-correct on the
 *                                                   next turn
 *     {ok: false, reason: "..."}                — validation error (bad status,
 *                                                   missing id, todo store not
 *                                                   wired in this run, malformed
 *                                                   init items, etc.)
 *
 * Why we return `{ok:false}` instead of throwing on unknown id / bad
 * input: a single hallucinated id should not crash the Runner loop.
 * Returning a structured error lets the LLM recover on the next turn.
 * (Hermetic test coverage: see todo-update.test.ts.)
 */

import type { KodaXToolExecutionContext, TodoEvaluatorHint, TodoStatus } from '../types.js';

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'skipped',
  // FEATURE_114 v0.7.36: explicit cancellation mid-task. Distinct from
  // `skipped` (Planner-merge) — `cancelled` is a Worker-driven mid-execution
  // decision (UI shows strikethrough). 'pending' deliberately omitted — the
  // store enters items at pending automatically; explicit pending transitions
  // are the runner's job (resetFailed) not the LLM's.
  'cancelled',
]);

const ALLOWED_EVALUATOR_HINTS: ReadonlySet<string> = new Set(['build', 'test', 'lint']);

const ALLOWED_OPS: ReadonlySet<string> = new Set(['init', 'update']);

interface TodoUpdateInput {
  /**
   * FEATURE_151 (v0.7.38). Default 'update' when omitted — preserves
   * v0.7.34 single-item-update behavior. 'init' switches to whole-list
   * write semantics.
   */
  op?: unknown;
  /** op:'init' payload — array of `{id, content, activeForm?}`. */
  items?: unknown;
  // op:'update' (v0.7.34) parameters:
  id?: unknown;
  status?: unknown;
  note?: unknown;
  /**
   * FEATURE_149 (v0.7.38) — present-continuous form (e.g. "Running tests").
   * Optional; when supplied with `status: 'in_progress'`, the spinner
   * picks it up live as `currentTodo?.activeForm`. Omitted = preserve
   * existing.
   */
  activeForm?: unknown;
}

interface InitItemInput {
  readonly id: unknown;
  readonly content: unknown;
  readonly activeForm?: unknown;
  /**
   * FEATURE_114 v0.7.36 — optional per-step deterministic evaluator hint.
   * `'build' | 'test' | 'lint'`. When supplied, the runner runs the
   * corresponding deterministic check on `pending → completed`. Useful
   * sparingly on milestone steps with a real ground-truth check.
   */
  readonly evaluator?: unknown;
}

function jsonResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/**
 * FEATURE_151 (v0.7.38) — validate and execute the whole-list seed/replace.
 * Pulled into its own function so the main `toolTodoUpdate` body stays
 * readable. Returns the tool-result JSON string in either success or
 * structured-error form; never throws.
 */
function executeInitOp(
  input: TodoUpdateInput,
  ctx: KodaXToolExecutionContext,
): string {
  if (!Array.isArray(input.items)) {
    return jsonResult({
      ok: false,
      reason:
        "Invalid op:'init' payload: `items` must be an array of " +
        '{id, content, activeForm?} objects (>= 1 entry).',
    });
  }

  const rawItems = input.items as readonly InitItemInput[];
  if (rawItems.length === 0) {
    return jsonResult({
      ok: false,
      reason:
        "Invalid op:'init' payload: `items` array must contain >= 1 entry. " +
        'Use op:\'update\' (or pass a non-empty list) instead of an empty init.',
    });
  }

  const seenIds = new Set<string>();
  const seeds: Array<{ id: string; content: string; activeForm?: string }> = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] as InitItemInput | undefined;
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return jsonResult({
        ok: false,
        reason: `Invalid op:'init' items[${i}]: must be an object {id, content, activeForm?}.`,
      });
    }
    const { id, content, activeForm, evaluator } = raw;
    if (typeof id !== 'string' || id.length === 0) {
      return jsonResult({
        ok: false,
        reason: `Invalid op:'init' items[${i}].id: must be a non-empty string.`,
      });
    }
    if (seenIds.has(id)) {
      return jsonResult({
        ok: false,
        reason:
          `Invalid op:'init' items[${i}].id: duplicate id ${JSON.stringify(id)}. ` +
          'Each item id must be unique within the list.',
      });
    }
    seenIds.add(id);
    if (typeof content !== 'string' || content.length === 0) {
      return jsonResult({
        ok: false,
        reason: `Invalid op:'init' items[${i}].content: must be a non-empty string.`,
      });
    }
    if (activeForm !== undefined && typeof activeForm !== 'string') {
      return jsonResult({
        ok: false,
        reason:
          `Invalid op:'init' items[${i}].activeForm: when provided, must be a string ` +
          '(present-continuous form, e.g. "Running tests").',
      });
    }
    // FEATURE_114 v0.7.36 — validate optional evaluator hint.
    if (evaluator !== undefined && (typeof evaluator !== 'string' || !ALLOWED_EVALUATOR_HINTS.has(evaluator))) {
      return jsonResult({
        ok: false,
        reason:
          `Invalid op:'init' items[${i}].evaluator: when provided, must be one of ` +
          `'build' | 'test' | 'lint'. Got ${JSON.stringify(evaluator)}.`,
      });
    }
    seeds.push({
      id,
      content,
      ...(typeof activeForm === 'string' ? { activeForm } : {}),
      ...(typeof evaluator === 'string' ? { evaluator: evaluator as TodoEvaluatorHint } : {}),
    });
  }

  ctx.todoStore!.init(seeds);
  // Note: store fires its onChange callback internally; the REPL host
  // sees the new items via `KodaXEvents.onTodoUpdate`. No second emission
  // needed here.
  return jsonResult({ ok: true, count: seeds.length });
}

export async function toolTodoUpdate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const { op, id, status, note, activeForm } = input as TodoUpdateInput;

  if (!ctx.todoStore) {
    // Configuration error — runner-driven did not wire a store for this run.
    // Surface this clearly so the model knows the tool call did nothing.
    return jsonResult({
      ok: false,
      reason:
        'todo_update is not active in this run (no plan list was seeded). ' +
        'You may continue working without calling todo_update.',
    });
  }

  // FEATURE_151 (v0.7.38) — `op` parameter routes between init / update.
  // Default 'update' when omitted preserves v0.7.34 callers.
  const effectiveOp = op === undefined ? 'update' : op;
  if (typeof effectiveOp !== 'string' || !ALLOWED_OPS.has(effectiveOp)) {
    return jsonResult({
      ok: false,
      reason:
        `Invalid op: ${JSON.stringify(op)}. ` +
        `Allowed: 'init' | 'update' (omit for default 'update').`,
    });
  }

  if (effectiveOp === 'init') {
    return executeInitOp(input as TodoUpdateInput, ctx);
  }

  // op === 'update' — single-item state transition (v0.7.34 behavior).
  if (typeof id !== 'string' || id.length === 0) {
    return jsonResult({
      ok: false,
      reason: 'Missing or invalid required parameter: id (non-empty string).',
    });
  }

  if (typeof status !== 'string' || !ALLOWED_STATUSES.has(status)) {
    return jsonResult({
      ok: false,
      reason:
        `Invalid status: ${JSON.stringify(status)}. ` +
        `Allowed: in_progress | completed | failed | skipped | cancelled.`,
    });
  }

  if (note !== undefined && typeof note !== 'string') {
    return jsonResult({
      ok: false,
      reason: 'Invalid note: when provided, must be a string.',
    });
  }

  if (activeForm !== undefined && typeof activeForm !== 'string') {
    return jsonResult({
      ok: false,
      reason: 'Invalid activeForm: when provided, must be a string (present-continuous, e.g. "Running tests").',
    });
  }

  if (!ctx.todoStore.has(id)) {
    const validIds = ctx.todoStore.allIds();
    const validList =
      validIds.length === 0
        ? 'no todos currently exist'
        : validIds.join(', ');
    return jsonResult({
      ok: false,
      reason:
        `Unknown todo id: ${JSON.stringify(id)}. ` +
        `Current valid ids: ${validList}. ` +
        `Please retry with one of the valid ids, or skip this update.`,
    });
  }

  ctx.todoStore.updateStatus(
    id,
    status as TodoStatus,
    note as string | undefined,
    activeForm as string | undefined,
  );
  // Note: store fires its onChange callback internally — no need for the
  // tool to also emit onTodoUpdate.
  return jsonResult({ ok: true });
}
