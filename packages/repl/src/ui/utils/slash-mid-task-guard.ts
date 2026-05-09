/**
 * FEATURE_149 Slice C6 (v0.7.38) — slash-command mid-task guard.
 *
 * KodaX's pending-inputs queue stores plain strings and the drain path
 * (`runQueuedPromptSequence`) feeds them verbatim to the agent as user
 * prompts — without re-dispatching through `parseCommand`. So a `/cost`
 * typed during loading would silently arrive at the LLM as the literal
 * text "/cost" (broken). v0.7.38 takes the conservative posture: refuse
 * to enqueue slash-prefixed input mid-task and tell the user to abort
 * first if they want to run one. Future versions can layer in CC's
 * immediate-local-jsx execution path for side-effect-free commands like
 * `/help` / `/cost`.
 *
 * Closes the only P0 GAP from the 14-dimension queue parity audit
 * comparing KodaX's queue subsystem against Claude Code (CC).
 *
 * Tested by `slash-mid-task-guard.test.ts` and human-verified via
 * Test 8 in `docs/test-guides/FEATURE_149_v0.7.38_TEST_GUIDE.md`.
 */

export const SLASH_MID_TASK_GUARD_MESSAGE =
  'Slash commands cannot be queued mid-task. Press Esc to abort the current task, then run the command.';

/** Dedupe key — kept distinct from `'queue-limit'` so the two messages
 *  don't suppress each other within the notice dedupe window. */
export const SLASH_MID_TASK_GUARD_DEDUPE_KEY = 'slash-guard';

/**
 * Returns true when `text` should be rejected as a slash command rather
 * than enqueued as a queued user prompt. Leading whitespace is tolerated
 * (the user may have a soft-tab muscle-memory from other shells), but
 * any non-whitespace character before the slash means it's a regular
 * prompt that happens to mention a slash and should queue normally.
 */
export function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith('/');
}
