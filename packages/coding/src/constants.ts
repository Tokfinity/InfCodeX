/**
 * KodaX Core Constants
 */

export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from '@kodax-ai/agent';

/**
 * Empty-completion retry budget for the managed-task LLM adapter.
 *
 * When a provider returns a syntactically-complete turn (finish_reason
 * received — so NOT a stream-incomplete error) that carries no text, no
 * tool calls, and no thinking, the adapter re-streams the same turn up to
 * this many times before falling through to the runner's terminal
 * no-tool branch. Without it, a degraded/empty completion — common on
 * budget OpenAI-compatible providers under load or right after a 429 — is
 * misread by the runner as a clean text-only task completion and the task
 * exits silently. A genuine text-only termination (text present, no tool)
 * is unaffected: the guard only fires on the fully-empty turn.
 */
export const KODAX_MAX_EMPTY_COMPLETION_RETRIES = 2;
/** Base backoff (ms) between empty-completion re-streams; scales by attempt. */
export const KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS = 500;

/**
 * Hard safety ceiling for the managed-task (AMA) Runner tool loop.
 *
 * The runner-driven AMA chain invokes `Runner.run` with this value as
 * `maxToolLoopIterations`. The engine default (`MAX_TOOL_LOOP_ITERATIONS`
 * = 20) targets stand-alone single-agent runs and is far too low for a
 * multi-step investigation + execution + verify chain. This is a hard
 * SAFETY ceiling, not the real throttle — the budget controller (H0=100 /
 * H1=H2=200 base, +extensions on user approval) stops the chain long
 * before 500. Reaching 500 genuinely indicates a prompt / tool-design bug.
 *
 * The LLM adapter (`buildRunnerLlmAdapter`) reports this same value as the
 * `maxIter` in `onIterationStart` / `onIterationEnd` so the SDK callback
 * reflects the real effective per-invocation ceiling instead of a stale
 * constant. Keeping both sites on this single source of truth guarantees
 * the reported denominator always matches the cap the Runner enforces.
 */
export const MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS = 500;

/** Prefix used to detect user-cancelled tool results in the agent loop. */
export const CANCELLED_TOOL_RESULT_PREFIX = '[Cancelled]';
/** Standard cancellation message returned when a tool is cancelled by the user. */
export const CANCELLED_TOOL_RESULT_MESSAGE = `${CANCELLED_TOOL_RESULT_PREFIX} Operation cancelled by user`;
