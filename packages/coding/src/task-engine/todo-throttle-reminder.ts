/**
 * Todo Throttle Reminder — FEATURE_097 (v0.7.34) §5 ② + FEATURE_151 (v0.7.38).
 *
 * Layer 2 fallback for "model forgot to engage with the plan list": after
 * `TURNS_SINCE_TODO_UPDATE_REMINDER` consecutive Runner rounds without a
 * `todo_update` invocation, inject a `<system-reminder>` block. Mirrors
 * Claude Code's `getTodoReminderAttachments` (threshold tuned to KodaX's
 * heavier per-round cost — 8 vs Claude Code's 10).
 *
 * FEATURE_151 (v0.7.38) — the front gate `if (!todoStore.hasItems()) return false`
 * was a chicken-and-egg deadlock: when Scout did not seed (the common
 * case for tasks where `executionObligations.length < 2`), the store
 * stayed empty AND the reminder never fired AND the LLM had no signal
 * that a plan list was even available. With Slice B1 giving the LLM a
 * self-seeding path via `todo_update({op:'init', items:[...]})`, the
 * gate is removed and the reminder fires regardless of store state. The
 * text is now branched:
 *   - **empty store** → nudge the LLM toward `op:'init'` if the task is
 *     non-trivial (matches Claude Code's "TodoWrite hasn't been used
 *     recently" prompt that fires unconditionally).
 *   - **populated store** → unchanged from v0.7.34 — list the still-open
 *     items so the LLM knows what to act on.
 *
 * Counter scope:
 *   - **Per managed-task** lifetime: ONE `TodoReminderState` object per
 *     `runManagedTaskViaRunnerInner` call.
 *   - **Counter resets** on:
 *       1. any `todo_update` tool call (whether op:'init' or op:'update';
 *          the wrapper at `runner-driven.ts:buildRunnerAgentChain`
 *          clears it),
 *       2. role/agent transition.
 *   - **Increment** by 1 on every adapter call (each call = one round).
 *
 * Re-fire policy: fire ONCE per "run-of-no-updates". Once fired,
 * suppress until the counter is reset.
 *
 * FEATURE_104: this module produces LLM-facing prompt text and therefore
 * must have a paired eval at `tests/feature-097-throttle-reminder.eval.ts`.
 */

import type { TodoStore } from './todo-store.js';

/**
 * Threshold in Runner rounds. KodaX file-level constant (not exposed via
 * config) per CLAUDE.md "NEVER add configuration for hypothetical needs":
 * tune via telemetry once we have it, not via user knob.
 */
export const TURNS_SINCE_TODO_UPDATE_REMINDER = 8;

/**
 * Per-managed-task ref state for the throttle reminder.
 *
 *   - `roundsSinceUpdate`: monotonically increasing counter; reset on
 *     todo_update call or role transition.
 *   - `lastFiredAtRound`: -1 means "armed; reminder has not fired since
 *     last reset". A non-negative value means the reminder has fired
 *     and is suppressed until the counter is reset.
 *   - `lastSeenAgentName`: the previous adapter call's `agent.name`;
 *     used to detect agent transitions so the counter can reset.
 */
export interface TodoReminderState {
  readonly roundsSinceUpdate: { current: number };
  readonly lastFiredAtRound: { current: number };
  readonly lastSeenAgentName: { current: string | undefined };
}

export function createTodoReminderState(): TodoReminderState {
  return {
    roundsSinceUpdate: { current: 0 },
    lastFiredAtRound: { current: -1 },
    lastSeenAgentName: { current: undefined },
  };
}

/** Reset on todo_update call OR role transition. Both clear the throttle. */
export function resetTodoReminderState(state: TodoReminderState): void {
  state.roundsSinceUpdate.current = 0;
  state.lastFiredAtRound.current = -1;
}

/**
 * Decide whether the reminder should fire for the upcoming adapter call.
 * Side effects when returning `true`:
 *   - flips `lastFiredAtRound` to `roundsSinceUpdate` (suppresses re-fire
 *     until the next reset).
 *
 * Caller must call this exactly once per adapter call, BEFORE incrementing
 * the counter for the upcoming round.
 *
 * FEATURE_151 (v0.7.38) — the `!todoStore.hasItems()` early-return was
 * removed. Empty store now also reaches the threshold check; the body
 * text (`buildTodoReminderText`) branches on store state to give the LLM
 * the right nudge (op:'init' vs op:'update'). The `todoStore` parameter
 * is retained for API stability and for tests that pass it through; it
 * is no longer consulted by this function.
 */
export function shouldFireTodoReminder(
  state: TodoReminderState,
  todoStore: TodoStore,
): boolean {
  void todoStore;
  if (state.roundsSinceUpdate.current < TURNS_SINCE_TODO_UPDATE_REMINDER) return false;
  if (state.lastFiredAtRound.current >= 0) return false; // already fired this run
  state.lastFiredAtRound.current = state.roundsSinceUpdate.current;
  return true;
}

/**
 * Increment the counter for the round that is about to start. Call this
 * AFTER `shouldFireTodoReminder` so the reminder check sees the current
 * (pre-increment) round value.
 */
export function tickTodoReminder(state: TodoReminderState): void {
  state.roundsSinceUpdate.current += 1;
}

/**
 * Build the `<system-reminder>` text body. Three branches:
 *   - **Empty store** (FEATURE_151 v0.7.38) — no plan committed yet.
 *     Nudge the LLM toward `todo_update({op:'init', ...})` if the task
 *     is non-trivial. Mirrors Claude Code's "TodoWrite tool hasn't been
 *     used recently" attachment ([attachments.ts:3668](
 *     c:/Works/claudecode/src/utils/messages.ts#L3668)).
 *   - **Populated, has open items** — list every non-terminal item
 *     (pending / in_progress / failed). Unchanged from v0.7.34.
 *   - **Populated, all terminal** — short form: model may want to close
 *     out or add a follow-up substep. Unchanged from v0.7.34.
 *
 * Format mirrors the design-doc literal so the eval harness can pin
 * character-for-character.
 */
export function buildTodoReminderText(todoStore: TodoStore): string {
  // FEATURE_151 (v0.7.38) — empty store branch.
  if (!todoStore.hasItems()) {
    return [
      '<system-reminder>',
      `You have not committed a plan in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations.`,
      'If this task has ≥2 distinct execution steps, commit a plan now via',
      'todo_update({op:"init", items:[{id:"todo_1", content:"...", activeForm:"..."}, ...]}).',
      'A visible plan list helps the user follow progress and forces full-scope thinking.',
      'Trivial single-step tasks (single typo / single edit / single-action lookup /',
      'one-sentence answer) may proceed without a plan — ignore this reminder if applicable.',
      'NEVER mention this reminder to the user.',
      '</system-reminder>',
    ].join('\n');
  }

  const items = todoStore.getAll();
  const open = items.filter(
    (it) => it.status === 'pending' || it.status === 'in_progress' || it.status === 'failed',
  );
  if (open.length === 0) {
    // Every item is in a terminal state but the model never signalled
    // "done" via accept. Nudge to close out / add a follow-up substep.
    return [
      '<system-reminder>',
      `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations. ` +
        `All listed items are already in a terminal state, but you may want to call todo_update ` +
        `if any new substep emerged.`,
      '</system-reminder>',
    ].join('\n');
  }
  const lines: string[] = [
    '<system-reminder>',
    `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations. Pending items:`,
  ];
  for (const it of open) {
    lines.push(`- ${it.id}: ${it.content}`);
  }
  lines.push(
    'If you have started or finished any of these, call todo_update now.',
    '</system-reminder>',
  );
  return lines.join('\n');
}

/**
 * Detect agent transition. Updates `lastSeenAgentName` and returns
 * `true` when the agent name changed (i.e., a phase transition happened
 * between this adapter call and the previous one).
 *
 * On the very first adapter call (no previous name), returns `false` —
 * the initial entry into Scout is not a "transition" worth resetting on.
 */
export function detectAgentTransition(
  state: TodoReminderState,
  agentName: string,
): boolean {
  const prev = state.lastSeenAgentName.current;
  state.lastSeenAgentName.current = agentName;
  if (prev === undefined) return false;
  return prev !== agentName;
}
