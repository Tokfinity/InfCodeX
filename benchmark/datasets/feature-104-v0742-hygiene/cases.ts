/**
 * Dataset — FEATURE_104 v0.7.42 plan-list hygiene Layer 2 eval.
 *
 * Verifies that v0.7.42 Step 5 (worker prompt PLAN-LIST HYGIENE
 * section) + Step 6 (todo_update tool `reminder` field on terminal-
 * completion transition) actually shifts LLM behavior compared to
 * the v0.7.41 baseline.
 *
 * Three cases, each pinned to one specific behavior the Steps 5/6
 * changes target:
 *
 *   C1 staleness_refresh_before_update — Worker just emerged from
 *       idle-yield (children returned 7+ turns ago); user message
 *       says "I think todo_2 may have already advanced — mark it
 *       completed if it's still in_progress". Expected: call
 *       `todo_get(id="todo_2")` (or `todo_list`) BEFORE any
 *       `todo_update` to refresh state. v_baseline lacks the
 *       staleness teaching → expected to skip todo_get and patch
 *       blindly; v_proposed teaches the refresh-before-mutate
 *       discipline.
 *
 *   C2 dedup_scan_before_create — Worker mid-task; existing plan
 *       includes `todo_2: Audit packages/auth (in_progress)`. User
 *       message: "Also please audit packages/auth for SQL injection
 *       vulnerabilities". Expected: NOT create a duplicate
 *       `todo_create({subject:"Audit packages/auth..."})`. Either
 *       expand todo_2 via `todo_update({id:"todo_2", description})`,
 *       OR mention in text that the audit is already in plan, OR
 *       call `todo_list` first to confirm. v_baseline lacks the
 *       dedup teaching → expected to blindly create the duplicate.
 *
 *   C3 verification_after_completion — Worker just flipped the last
 *       todo to completed; tool result contains the verification
 *       reminder (Step 6 nudge). User message: "great, can you
 *       confirm the work is done?". Expected: first non-text tool
 *       call is `bash` running test/build/lint (or `read` of a
 *       test file's output). v_baseline gets the same prompt but
 *       no reminder in the tool result; v_proposed gets the
 *       reminder text appended.
 *
 * Variants: only v_baseline vs v_proposed (no v2/v3/v4 prompt
 * iteration variants this round — keeps eval scope tight per the
 * canonical alias panel × 5 runs × 3 cases × 2 variants = 150 calls
 * budget).
 *
 * Pre-registered SHIP gate (per EVAL_GUIDELINES §pre-registered
 * thresholds + memory `feedback_model_structural_floor_not_prompt_tunable`):
 *
 *   SHIP iff (all three required):
 *     (a) Each case C1+C2+C3 reaches ≥60% pass rate on v_proposed in
 *         ≥4-of-5 alias. Threshold drops one alias to absorb the
 *         occasional zhipu/kimi structural floor — pre-FEATURE_125
 *         lesson.
 *     (b) Each case Δ (v_proposed − v_baseline) ≥ +15pp on
 *         ≥3-of-5 alias. No cross-case-regression requirement (each
 *         case targets an orthogonal behavior; one case's lift
 *         carries no implication for the others).
 *     (c) NO case regresses ≥10pp on any alias (cross-case parity
 *         guard, per `feedback_prompt_strengthening_cross_case_regression`).
 *
 *   PARTIAL: any (a) or (b) miss on 1-2 cases → ship those cases'
 *     prompts (Step 5 / Step 6 selectively), revert the underperforming
 *     section. Decision matrix recorded after Layer 2 panel runs.
 *
 *   REJECT (full revert of Steps 5 + 6): (c) hits — cross-case regression
 *     means the prompt/nudge introduced unintended downside larger than
 *     the upside. Per the FEATURE_120 v3 case-study memory.
 */

import type { KodaXMessage } from '@kodax-ai/llm';

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

// ---------------------------------------------------------------------------
// Case spec
// ---------------------------------------------------------------------------

export type CaseId =
  | 'staleness_refresh_before_update'
  | 'dedup_scan_before_create'
  | 'verification_after_completion';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  readonly polarity:
    | 'must_call_todo_get_or_list'
    | 'must_not_duplicate_subject'
    | 'must_invoke_verification';
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'staleness_refresh_before_update',
    description:
      'Worker just emerged from idle-yield (children returned 7+ turns ago). User asks ' +
      'to mark `todo_2` completed but is uncertain about its current status ("may have ' +
      'already advanced"). Worker must refresh state with `todo_get(id="todo_2")` or ' +
      '`todo_list` BEFORE any `todo_update`.',
    behaviour:
      'first non-text tool call is `todo_get` or `todo_list`; subsequent `todo_update` is fine',
    polarity: 'must_call_todo_get_or_list',
  },
  {
    id: 'dedup_scan_before_create',
    description:
      'Worker has a 3-item plan with `todo_2: Audit packages/auth` already in_progress. ' +
      'User asks for an additional "audit packages/auth for SQL injection". Worker must ' +
      'NOT blindly call `todo_create({subject:"Audit packages/auth..."})` — either expand ' +
      'todo_2 via patch, call `todo_list` to confirm, or mention in text that audit is ' +
      'already in plan.',
    behaviour:
      'does NOT call todo_create with a subject duplicating the existing in_progress item; ' +
      'acceptable paths: todo_update on todo_2, todo_list scan first, or text-only ack',
    polarity: 'must_not_duplicate_subject',
  },
  {
    id: 'verification_after_completion',
    description:
      'Worker just flipped the last todo to completed; tool result contains the Step 6 ' +
      'verification reminder. User asks to confirm the work is done. Worker must run ' +
      'verification (bash test/build/lint, or read of a test output) BEFORE declaring done.',
    behaviour:
      'first non-text tool call invokes `bash` (with test/build/lint command) OR reads ' +
      'a verification artifact; OR text explicitly states verification already happened',
    polarity: 'must_invoke_verification',
  },
] as const;

// ---------------------------------------------------------------------------
// Tool docs (identical across variants — isolates prompt impact)
// ---------------------------------------------------------------------------

const TOOL_DOCS = [
  '## Available Tools',
  '',
  '`todo_update`:',
  '  Inputs (UNION — pick ONE shape):',
  '    A. Per-item PATCH:  { id:string, subject?:string, description?:string, status?:"in_progress"|"completed"|"failed"|"skipped"|"cancelled"|"deleted", activeForm?:string, note?:string, evaluator?:"build"|"test"|"lint", metadata?:object }',
  '    B. Whole-list seed: { op:"init", items:[{id, subject, description?, activeForm?, evaluator?}] }  (legacy / runner-side only — avoid for LLM-driven mutations)',
  '  Output: { ok:true, ... } or { ok:false, reason:"..." }. v0.7.42 adds an optional `reminder` field on the success envelope when the patch leaves the plan all-terminal with ≥3 items.',
  '',
  '`todo_create`:  (FEATURE_170 v0.7.41 — additive insertion path)',
  '  Input:  { subject:string, description?:string, activeForm?:string, evaluator?:"build"|"test"|"lint", metadata?:object }',
  '  Output: { ok:true, id:string } or { ok:false, reason:"..." }',
  '  Effect: inserts ONE new pending item with a store-minted id. Existing items unchanged.',
  '',
  '`todo_list`:   (FEATURE_151 v0.7.38)  Read-only — returns the current plan as JSON.',
  '`todo_get`:    (v0.7.42 — claudecode V2 `TaskGet` parity)  { id:string } → returns full TodoItem detail for one id. Use BEFORE `todo_update` when uncertain about an item\'s current state.',
  '',
  '`bash` / `read` / `grep`: standard shell + file inspection tools.',
].join('\n');

// ---------------------------------------------------------------------------
// Plan-list hygiene section — present only in v_proposed.
// ---------------------------------------------------------------------------

const PLAN_LIST_HYGIENE_PROPOSED = [
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched (e.g. just resumed from idle-yield, or mid-fan-out after children finished, or after a long thinking stretch), call `todo_get(id)` first to read the item\'s CURRENT state. Runner-side auto-handlers can flip statuses between your turns; mutating on a stale view produces silent no-op patches or surprising overwrites. `todo_get` is cheap — one tool call per uncertain item — and the JSON it returns is authoritative.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list (it is visible at the top of every throttle reminder, OR call `todo_list` for an explicit snapshot) and confirm no item with the same subject is already present. Duplicate items split the user\'s progress dashboard into parallel branches of the same work — confusing and easy to over-count.',
  '- DEDUP HEURISTIC: two items are duplicates when their `subject` describes the same concrete artifact / file path / module. They are NOT duplicates when one is a parent-level summary ("Audit packages/auth") and the other a leaf ("Write test for handleLogin in packages/auth") — those are legitimately distinct rows.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start of the task) is exempt from the dedup check — the list is empty so duplicates are impossible.',
].join('\n');

const PLAN_FIRST_CONTRACT = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- INSERT ONE NEW STEP mid-task: `todo_create({subject:"...", description?:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '- EDIT ONE STEP: `todo_update({id, subject?, description?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '- REMOVE ONE STEP entirely (no breadcrumb): `todo_update({id, status:"deleted"})`. Prefer over `cancelled` when the item was wholly off-plan.',
  '- STRIKETHROUGH ONE STEP (keep visible breadcrumb): `todo_update({id, status:"cancelled", note:"..."})`. Prefer over `deleted` when the user benefits from seeing the discarded record.',
].join('\n');

export type PromptVariantKind = 'baseline' | 'proposed';

function buildSystemPrompt(variant: PromptVariantKind): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    PLAN_FIRST_CONTRACT,
    '',
    ...(variant === 'proposed' ? [PLAN_LIST_HYGIENE_PROPOSED, ''] : []),
    TOOL_DOCS,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Canned mid-run transcripts — one per case, gives the user message
// unambiguous context.
// ---------------------------------------------------------------------------

const C1_STALENESS_HISTORY: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user',
    content:
      'Audit packages/auth + packages/llm + packages/coding for any TODO comments and ' +
      'compile them into a single report.',
  },
  {
    role: 'assistant',
    content:
      "I'll commit a plan first and then fan out three child investigations.\n\n" +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Audit packages/auth TODO comments","activeForm":"Auditing packages/auth TODO comments"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Audit packages/llm TODO comments","activeForm":"Auditing packages/llm TODO comments"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Audit packages/coding TODO comments","activeForm":"Auditing packages/coding TODO comments"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true,"id":"todo_1"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_2"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_3"}</tool_result>',
  },
  {
    role: 'assistant',
    content:
      'Dispatching three parallel children.\n\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_1","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_2","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_3","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"dispatch_child_task","arguments":{"objective":"Audit packages/auth TODO comments","readOnly":true}}</tool_call>\n' +
      '<tool_call>{"name":"dispatch_child_task","arguments":{"objective":"Audit packages/llm TODO comments","readOnly":true}}</tool_call>\n' +
      '<tool_call>{"name":"dispatch_child_task","arguments":{"objective":"Audit packages/coding TODO comments","readOnly":true}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true}</tool_result>\n'.repeat(3) +
      '<tool_result>{"task_id":"task_A1","status":"dispatched"}</tool_result>\n'.repeat(3) +
      '<task-completed task_id="task_A1">Found 4 TODO comments in packages/auth/src/login.ts and 2 in token-refresh.ts.</task-completed>\n' +
      '<task-completed task_id="task_A2">Found 0 TODO comments in packages/llm — recently cleaned.</task-completed>\n' +
      '<task-completed task_id="task_A3">Found 1 TODO comment in packages/coding/src/tools/edit.ts.</task-completed>',
  },
  {
    role: 'assistant',
    content:
      "All three children completed. Compiling the report.\n\nThe TODO audit found:\n- packages/auth: 6 TODO comments (4 in login.ts, 2 in token-refresh.ts)\n- packages/llm: 0 TODO comments\n- packages/coding: 1 TODO comment in tools/edit.ts\n\nTotal: 7 TODO comments across the three packages.",
  },
];

const C1_USER_MESSAGE =
  "Thanks. I think todo_2 (packages/llm audit) may have already been marked completed " +
  "by the runner since the child returned cleanly. Can you mark todo_2 completed if it's " +
  "still in_progress, and todo_1 + todo_3 completed too?";

const C2_DEDUP_HISTORY: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user',
    content:
      'Audit the auth subsystem: review packages/auth for security issues, write a summary, ' +
      'and add unit tests for the login flow.',
  },
  {
    role: 'assistant',
    content:
      "I'll commit a 3-step plan.\n\n" +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Audit packages/auth for security issues","activeForm":"Auditing packages/auth for security issues"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Write security summary","activeForm":"Writing security summary"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Add unit tests for login flow","activeForm":"Adding unit tests for login flow"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true,"id":"todo_1"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_2"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_3"}</tool_result>',
  },
  {
    role: 'assistant',
    content:
      'Starting the audit (todo_1).\n\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_1","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"read","arguments":{"file_path":"/repo/packages/auth/src/login.ts"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true}</tool_result>\n' +
      '<tool_result>function login(username, password) { /* ... 80 lines ... */ }</tool_result>',
  },
];

const C2_USER_MESSAGE =
  'Actually also please specifically audit packages/auth for SQL injection vulnerabilities — ' +
  "that's our biggest worry.";

const C3_VERIFICATION_HISTORY: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user',
    content:
      'Refactor the date-utils module: extract `formatRelativeTime` into its own file, ' +
      'update the callers, and run the test suite.',
  },
  {
    role: 'assistant',
    content:
      "I'll plan this out.\n\n" +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Extract formatRelativeTime into its own file","activeForm":"Extracting formatRelativeTime into its own file"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Update callers of formatRelativeTime","activeForm":"Updating callers of formatRelativeTime"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_create","arguments":{"subject":"Run the test suite for date-utils","activeForm":"Running the test suite for date-utils"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true,"id":"todo_1"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_2"}</tool_result>\n' +
      '<tool_result>{"ok":true,"id":"todo_3"}</tool_result>',
  },
  {
    role: 'assistant',
    content:
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_1","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"write","arguments":{"file_path":"/repo/src/date-utils/formatRelativeTime.ts","content":"export function formatRelativeTime(date: Date) { /* extracted */ }"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_1","status":"completed"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true}</tool_result>\n' +
      '<tool_result>{"ok":true}</tool_result>\n' +
      '<tool_result>{"ok":true}</tool_result>',
  },
  {
    role: 'assistant',
    content:
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_2","status":"in_progress"}}</tool_call>\n' +
      '<tool_call>{"name":"edit","arguments":{"file_path":"/repo/src/date-utils/index.ts","old_string":"import { formatRelativeTime } from \'./helpers\';","new_string":"import { formatRelativeTime } from \'./formatRelativeTime\';"}}</tool_call>\n' +
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_2","status":"completed"}}</tool_call>',
  },
  {
    role: 'user',
    content:
      '<tool_result>{"ok":true}</tool_result>\n' +
      '<tool_result>{"ok":true}</tool_result>\n' +
      '<tool_result>{"ok":true}</tool_result>',
  },
];

const C3_USER_MESSAGE = 'great work. can you confirm the work is done?';

// v_proposed adds the Step 6 reminder field to the last tool_result.
// v_baseline omits it (mirrors v0.7.41 — no reminder field exists).
function c3HistoryForVariant(variant: PromptVariantKind): ReadonlyArray<KodaXMessage> {
  // Insert the "I'm about to flip the last item" turn — assistant flips
  // todo_3 to completed; tool result either carries reminder (proposed)
  // or not (baseline).
  const flipTurn: KodaXMessage = {
    role: 'assistant',
    content:
      '<tool_call>{"name":"todo_update","arguments":{"id":"todo_3","status":"completed"}}</tool_call>',
  };
  const flipResult: KodaXMessage = variant === 'proposed'
    ? {
        role: 'user',
        content:
          '<tool_result>{"ok":true,"reminder":"All plan-list items are now in a terminal state (completed / skipped / cancelled). Before declaring the task done, run the deterministic verification that applies (build / test / lint as appropriate), surface any failures, and only then write your final answer. If you have already verified within this run, ignore this reminder. NEVER mention this reminder to the user."}</tool_result>',
      }
    : { role: 'user', content: '<tool_result>{"ok":true}</tool_result>' };
  return [...C3_VERIFICATION_HISTORY, flipTurn, flipResult];
}

// ---------------------------------------------------------------------------
// Prompt variants per case.
// ---------------------------------------------------------------------------

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  switch (caseId) {
    case 'staleness_refresh_before_update':
      return [
        {
          id: 'v_baseline',
          description: 'v0.7.41 prompt (no PLAN-LIST HYGIENE section)',
          systemPrompt: buildSystemPrompt('baseline'),
          userMessage: C1_USER_MESSAGE,
          priorMessages: C1_STALENESS_HISTORY,
        },
        {
          id: 'v_proposed',
          description: 'v0.7.42 Step 5 (PLAN-LIST HYGIENE section added)',
          systemPrompt: buildSystemPrompt('proposed'),
          userMessage: C1_USER_MESSAGE,
          priorMessages: C1_STALENESS_HISTORY,
        },
      ];
    case 'dedup_scan_before_create':
      return [
        {
          id: 'v_baseline',
          description: 'v0.7.41 prompt (no PLAN-LIST HYGIENE section)',
          systemPrompt: buildSystemPrompt('baseline'),
          userMessage: C2_USER_MESSAGE,
          priorMessages: C2_DEDUP_HISTORY,
        },
        {
          id: 'v_proposed',
          description: 'v0.7.42 Step 5 (PLAN-LIST HYGIENE section added)',
          systemPrompt: buildSystemPrompt('proposed'),
          userMessage: C2_USER_MESSAGE,
          priorMessages: C2_DEDUP_HISTORY,
        },
      ];
    case 'verification_after_completion':
      return [
        {
          id: 'v_baseline',
          description: 'v0.7.41 prompt (no Step 6 reminder field in tool result)',
          systemPrompt: buildSystemPrompt('proposed'), // hygiene present
          userMessage: C3_USER_MESSAGE,
          priorMessages: c3HistoryForVariant('baseline'),
        },
        {
          id: 'v_proposed',
          description: 'v0.7.42 Step 6 (verification reminder in tool result)',
          systemPrompt: buildSystemPrompt('proposed'),
          userMessage: C3_USER_MESSAGE,
          priorMessages: c3HistoryForVariant('proposed'),
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Tool-call detection — multi-syntax (per EVAL_GUIDELINES anti-pattern 7 §4).
// Mirrors the audit-corrected pattern set shipped in feature-170 + feature-125.
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Judges — Layer 1 mechanical regex (composed with harness toolCalls).
// LLM-judge audit lives in the paired -judge-audit.eval.ts file.
// ---------------------------------------------------------------------------

function judgeStaleness(out: string): { passed: boolean; reason?: string } {
  // PASS if first tool call (binding-captured or visible) is todo_get or todo_list,
  // BEFORE any todo_update. We approximate "first tool call" by checking that
  // todo_update does NOT appear before todo_get/todo_list in the text.
  const hasGet = invokesTool(out, 'todo_get');
  const hasList = invokesTool(out, 'todo_list');
  if (!hasGet && !hasList) {
    return {
      passed: false,
      reason: 'neither todo_get nor todo_list invoked — staleness refresh missing',
    };
  }
  // Soft order check: find the first occurrence index of each tool in the text.
  const findIdx = (name: string): number => {
    for (const p of buildToolNamePatterns(name)) {
      const m = p.exec(out);
      if (m) return m.index;
    }
    return -1;
  };
  const updateIdx = findIdx('todo_update');
  const getIdx = findIdx('todo_get');
  const listIdx = findIdx('todo_list');
  const refreshIdx = Math.min(
    ...[getIdx, listIdx].filter((i) => i >= 0),
  );
  if (updateIdx >= 0 && refreshIdx >= 0 && updateIdx < refreshIdx) {
    return {
      passed: false,
      reason: 'todo_update appears BEFORE todo_get / todo_list — refresh-after-update is too late',
    };
  }
  return { passed: true };
}

function judgeDedup(out: string): { passed: boolean; reason?: string } {
  // ACCEPT-LIST paths (any one of these passes):
  //   (a) no todo_create invocation at all (acknowledged via text or via
  //       todo_update patch on the existing item)
  //   (b) todo_list invoked first (the model checked before deciding)
  //   (c) todo_update invoked on todo_2 (expansion path)
  const hasCreate = invokesTool(out, 'todo_create');
  if (!hasCreate) {
    return { passed: true };
  }
  // todo_create WAS invoked. Check the subject does not duplicate
  // "Audit packages/auth" (case-insensitive contains-check on the
  // captured tool input).
  // We can't see toolCalls input here from text alone — fall back to
  // text-scan of the subject argument. If the subject mentions
  // "packages/auth" AND "audit", it's a duplicate.
  const dupSubjectPattern = /["'`]subject["'`]\s*[:=]\s*["'`][^"'`]*audit[^"'`]*packages\/auth/i;
  const altDupPattern = /["'`]subject["'`]\s*[:=]\s*["'`][^"'`]*packages\/auth[^"'`]*audit/i;
  if (dupSubjectPattern.test(out) || altDupPattern.test(out)) {
    return {
      passed: false,
      reason: 'todo_create invoked with subject duplicating existing `todo_2: Audit packages/auth`',
    };
  }
  return { passed: true };
}

function judgeVerification(out: string): { passed: boolean; reason?: string } {
  // PASS if any of:
  //   (a) bash invoked with test/build/lint/vitest/jest/npm command
  //   (b) text explicitly mentions verification done (regex /verif|tested|ran (the )?tests?|all tests pass/i)
  //   (c) read of a test/coverage file
  if (invokesTool(out, 'bash')) {
    // Check the bash command for verification-related keywords.
    const verifyCmdPattern =
      /(?:command|cmd)["'`]?\s*[:=]\s*["'`][^"'`]*(?:test|build|lint|vitest|jest|npm run|tsc -b|tsc --build|coverage)/i;
    if (verifyCmdPattern.test(out)) {
      return { passed: true };
    }
  }
  if (/\b(?:verif(?:y|ied|ication)?|tested|ran (?:the )?tests?|all tests? (?:now )?pass)\b/i.test(out)) {
    return { passed: true };
  }
  if (invokesTool(out, 'read')) {
    const readsTestFile =
      /["'`]?(?:file_path|path|target)["'`]?\s*[:=]\s*["'`][^"'`]*(?:test|spec|coverage|junit)/i;
    if (readsTestFile.test(out)) {
      return { passed: true };
    }
  }
  return {
    passed: false,
    reason: 'no verification signal — neither bash test/build/lint, nor text ack, nor read of test artifact',
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'staleness_refresh_before_update':
      return [
        {
          name: 'staleness_refresh_judge',
          category: 'correctness',
          judge: (output) => judgeStaleness(output),
        },
      ];
    case 'dedup_scan_before_create':
      return [
        {
          name: 'dedup_scan_judge',
          category: 'correctness',
          judge: (output) => judgeDedup(output),
        },
      ];
    case 'verification_after_completion':
      return [
        {
          name: 'verification_judge',
          category: 'correctness',
          judge: (output) => judgeVerification(output),
        },
      ];
  }
}
