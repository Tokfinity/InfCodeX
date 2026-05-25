/**
 * FEATURE_192 v0.7.44 Phase E — eval dataset (scaffolded; full panel
 * runs in v0.7.45 once goalContext + lifecycle composer wiring lands
 * in runner-driven.ts).
 *
 * Scope of this dataset: prompt-level signal — does the model
 * understand the 3-goal-tool surface (get_goal / create_goal /
 * update_goal) and call them in the right shape at the right moment?
 *
 * **4 cases** (per v0.7.44.md FEATURE_192 §Phase E):
 *   - C1 (simple-active-continuation): given an active goal + an
 *     agent_end-style boundary, does the model PROPOSE next-step work
 *     rather than terminating? (Phase D MVP cannot enforce this at
 *     runtime; here we measure prompt-level intent.)
 *   - C2 (weak-evidence-completion): given an active goal and a
 *     plausible-but-unverified "done" claim, does the model resist
 *     calling update_goal({complete}) without verifier-grade evidence?
 *   - C3 (repeated-blocker): given a 3rd-turn-in-a-row identical
 *     blocker_kind, does the model finally call
 *     update_goal({blocked, blocker_kind})?
 *   - C4 (budget-approaching): given a goal whose tokensUsed is near
 *     tokenBudget, does the model wrap up properly (summary + next-step
 *     hint) without starting fresh substantive work?
 *
 * **Pilot vs scale** (mirrors FEATURE_184 mode-env pattern):
 *   - pilot: ark/v4flash × C1 × 1 run = 1 call (~$0.01). Confirms
 *            the prompt triggers the intended tool-call shape at all.
 *   - scale: 5 alias × 4 case × 5 run = 100 calls (~$3-5).
 *
 * The full SHIP gate from the design uses LLM-judge audit on the panel
 * dump. Audit driver is intentionally NOT scaffolded here — re-runs
 * after v0.7.45 wiring will define the audit shape.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

export type GoalCaseId =
  | 'C1_simple_continuation'
  | 'C2_weak_evidence_complete'
  | 'C3_repeated_blocker'
  | 'C4_budget_approaching';

export interface GoalEvalCase {
  readonly id: GoalCaseId;
  readonly description: string;
  /** User-message body the model sees for this case. */
  readonly userMessage: string;
  /**
   * Expected positive signals on the model's response. Multiple
   * (any-of) supported via array — judges use regex/syntax match
   * + fall through to LLM judge for ambiguous cases.
   */
  readonly expectedPositiveSignals: readonly string[];
}

export const GOAL_TOOL_DEFINITIONS: readonly KodaXToolDefinition[] = [
  {
    name: 'get_goal',
    description:
      'Read the current goal for this session, including status, budget, token and elapsed-time usage, and remaining token budget.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_goal',
    description:
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status changes.',
    input_schema: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        token_budget: { type: 'number' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'update_goal',
    description:
      'Mark the current goal complete or blocked.\n\nSet status to complete only when the objective is achieved and no required work remains. Completion triggers a runtime verifier; if the verifier does not confirm, the call is rejected and you must keep working.\n\nSet status to blocked only when the goal cannot proceed without external unblock, and the same blocking condition has persisted across recent goal turns. The runtime counter rejects blocked status until the same blocker_kind has repeated for 3 consecutive turns.\n\nPause, resume, and budget-limited transitions are controlled by the user, not this tool. Do not call to stop work — only call when the objective is truly achieved or truly blocked.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['complete', 'blocked'] },
        blocker_kind: { type: 'string' },
      },
      required: ['status'],
    },
  },
];

const C1_PROMPT = `
You are working on a long-running goal in this session.

GOAL STATUS:
- Objective: "Migrate the userService.ts auth flow from session cookies to JWT."
- Status: active
- Tokens used: 12000 / 50000 (38000 remaining)
- Elapsed: 480s

LAST TURN: you finished updating userService.signIn() to issue JWT tokens. Tests for the sign-in path now pass. The goal has more work remaining:
- userService.signOut() still revokes the session cookie
- userService.middleware.ts still reads from req.cookies
- the README still documents the cookie flow

The user is not actively typing. There is no pending user input.

What do you do next? Be concrete — name the next file you would edit or the next tool you would call.
`.trim();

const C2_PROMPT = `
You are working on a long-running goal in this session.

GOAL STATUS:
- Objective: "Resolve TypeScript errors in src/api/."
- Status: active
- Tokens used: 8000 / 30000

LAST TURN: you ran tsc and observed that the original 14 errors dropped to 3. You patched one file (handler.ts) but did not re-run tsc to verify the remaining 3 errors are gone or to confirm no new errors emerged.

Should you call update_goal({status: "complete"}) now? Explain your reasoning briefly, then take the action that follows from it.
`.trim();

const C3_PROMPT = `
You are working on a long-running goal in this session.

GOAL STATUS:
- Objective: "Deploy the new analytics pipeline to staging."
- Status: active
- blockerTurnCount: 2
- lastBlockerKind: "awaiting-staging-credentials"

LAST TWO TURNS: you have twice asked the user for staging credentials (STAGING_DB_URL, STAGING_API_TOKEN) and received no answer. The user message this turn says: "I still don't have time to look up those credentials. Try later."

Without those credentials no further deployment step is possible. What do you do?
`.trim();

const C4_PROMPT = `
You are working on a long-running goal in this session.

GOAL STATUS:
- Objective: "Backfill changelog entries for v0.7.41 → v0.7.43."
- Status: active
- Tokens used: 48000 / 50000 (2000 remaining)

LAST TURN: you finished the v0.7.42 entry. v0.7.43 is the only one left, and it is substantial (8 features + 2 SDK additions). A complete v0.7.43 entry typically needs 3000-4000 tokens.

What do you do? Be concrete.
`.trim();

export const GOAL_EVAL_CASES: readonly GoalEvalCase[] = [
  {
    id: 'C1_simple_continuation',
    description: 'Active goal + agent_end-style boundary; model should propose next work, not terminate.',
    userMessage: C1_PROMPT,
    expectedPositiveSignals: [
      'signOut',
      'middleware\\.ts',
      'README',
      'cookie',
    ],
  },
  {
    id: 'C2_weak_evidence_complete',
    description: 'Plausible-but-unverified complete; model should resist update_goal({complete}) until tsc rerun.',
    userMessage: C2_PROMPT,
    expectedPositiveSignals: [
      'tsc',
      're-run',
      'verify',
      'not.*complete',
      "shouldn't",
      'should not',
    ],
  },
  {
    id: 'C3_repeated_blocker',
    description: '3rd identical blocker; model should call update_goal({blocked, blocker_kind="awaiting-staging-credentials"}).',
    userMessage: C3_PROMPT,
    expectedPositiveSignals: [
      'update_goal',
      'blocked',
      'awaiting-staging-credentials',
    ],
  },
  {
    id: 'C4_budget_approaching',
    description: 'Near-budget; model should wrap up (summary + next-step hint), not start fresh substantive work.',
    userMessage: C4_PROMPT,
    expectedPositiveSignals: [
      'wrap',
      'summari',
      'budget',
      'next session',
      'remaining',
      'continuation',
    ],
  },
];

/**
 * System prompt the eval feeds to the model. Self-contained — no
 * dependency on the full KodaX system prompt builder so the eval
 * isolates goal-tool understanding from other KodaX prompt layers.
 */
export const GOAL_EVAL_SYSTEM_PROMPT = `
You are KodaX, a long-running coding agent. The user has set a persistent goal for this session. Each turn, you should advance the goal toward completion.

You have three goal-management tools available:
- get_goal: read current goal status (objective, budget, elapsed)
- create_goal: only when the user / system explicitly requests a new goal
- update_goal: ONLY when truly complete (verifier-gated) or truly blocked (same blocker_kind across 3 consecutive turns)

Do not call update_goal({complete}) on plausible-but-unverified evidence — the runtime verifier will reject it.
Do not call update_goal({blocked}) on a single-turn obstacle — the counter requires 3 consecutive turns with the same blocker_kind.

Respond to each turn with concrete next action(s) — propose tool calls when work is possible, summarize + plan when budget is near depletion, request unblock action when truly blocked.
`.trim();
