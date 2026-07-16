/**
 * Dataset — FEATURE_170 (v0.7.41) Todo V2 Migration prompt eval cases.
 *
 * Verifies that the v0.7.41 C5 prompt rewrite (in `worker-role-prompt.ts`
 * `planFirstContract` / `scopeCommitment` / `fanOutPlanGranularity` /
 * `reviseFailureRetrospective` and the legacy `role-prompt.ts` H0_DIRECT
 * `MID-TASK REFINEMENT` block) effectively teaches the Worker LLM the
 * Todo V2 per-item API (`todo_create` / `todo_update({id, content?, status?,
 * metadata?, ...})` / `todo_update({id, status:'deleted'})`) WITHOUT
 * regressing the existing `op:'init'` batch path and the status-flip
 * backwards-compat (`todo_update({id, status})`).
 *
 * Five cases — 3 NEW BEHAVIOR (todo_create / per-item patch / delete) +
 * 1 INITIAL PLAN (either path PASSes) + 1 BACKWARDS-COMPAT (status flip):
 *
 *   1. **C1 mid_task_insert_via_todo_create** — Worker has already
 *      committed a 3-item plan via op:'init'; user adds a 4th step
 *      mid-task. Expected: `todo_create({content})`, NOT `op:'init'`
 *      (wipes user-visible progress).
 *   2. **C2 mid_task_content_patch** — Worker has a 4-item plan; one
 *      item's description turned out wrong; user asks to correct it.
 *      Expected: `todo_update({id, content: "..."})`, NOT `op:'init'`.
 *   3. **C3 mid_task_delete_obsolete** — Worker has a 4-item plan;
 *      one step is no longer needed. Expected: `todo_update({id,
 *      status:"deleted"})`, NOT `op:'init'` and NOT silent skip.
 *   4. **C4 initial_plan_commitment** — Empty store; user gives a
 *      multi-step task. Expected: EITHER `todo_update({op:"init",
 *      items:[...]})` OR ≥2 `todo_create` calls (both pre-FEATURE_170
 *      and post-FEATURE_170 paths are valid for INITIAL commitment).
 *   5. **C5 status_flip_backwards_compat** — Worker has marked an item
 *      `in_progress`; the work completed. Expected: `todo_update({id,
 *      status:"completed"})`. This is the v0.7.40 backwards-compat path;
 *      C5 prompt must NOT regress this.
 *
 * **Variants**: `v_baseline` (pre-C5 prompt, v0.7.40 state, only knows
 * `op:'init'` / `op:'update', status`) vs `v_proposed` (v0.7.41 C5
 * prompt, teaches the 4-bullet API). The tool surface is IDENTICAL
 * across both variants (both have `todo_create` + extended `todo_update`
 * available); ONLY the prompt differs. This isolates prompt impact from
 * tool wiring.
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §4: tool-name detection uses the
 * 9-pattern set (same as feature-125's audit-corrected set) covering
 * fn-call / JSON / XML / kimi `tool:N>{}` / mmx `[TOOL_CALL]{tool=>}`
 * / ark `<tool_call>tool<arg_key>` / zhipu `<tool_name>tool</tool_name>`.
 *
 * **SHIP gate** (pre-registered, per design doc Acceptance §):
 *
 *   - SHIP iff:
 *     (a) C1+C2+C3 each ≥70% pass rate on v_proposed, ≥3-of-5 alias
 *     (b) C5 NOT regressed >10pp on v_proposed vs v_baseline on any alias
 *     (c) C1+C2+C3 Δ ≥ +20pp on v_proposed vs v_baseline, ≥3-of-5 alias
 *   - PARTIAL: runtime ships, prompt rewrite partial — keep planFirstContract
 *     change (largest impact), revert fanOut / revise / scope sections
 *   - REJECT: C5 regressed ≥20pp on v_proposed vs v_baseline (backwards-
 *     compat break) → revert ALL prompt changes, keep tool/store/extension
 *     paths only
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';
import type { KodaXMessage } from '@kodax-ai/llm';

export type CaseId =
  | 'mid_task_insert_via_todo_create'
  | 'mid_task_content_patch'
  | 'mid_task_delete_obsolete'
  | 'initial_plan_commitment'
  | 'status_flip_backwards_compat';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  readonly polarity:
    | 'must_call_todo_create'
    | 'must_patch_content'
    | 'must_delete_status'
    | 'must_commit_plan'
    | 'must_flip_status';
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'mid_task_insert_via_todo_create',
    description:
      "Worker already committed a 3-item plan (item 1 completed, item 2 in_progress, item 3 pending). " +
      "User mid-task asks to add a 4th step ('also add a config flag for the feature'). Worker must " +
      "INSERT ONE new step via `todo_create({content})` — must NOT call `todo_update({op:'init', ...})` " +
      'because that wipes the user-visible progress on the completed item 1.',
    behaviour:
      "first non-text response invokes `todo_create` with a content field; does NOT invoke `todo_update({op:'init'})`",
    polarity: 'must_call_todo_create',
  },
  {
    id: 'mid_task_content_patch',
    description:
      "Worker has a 4-item plan; one item's description turned out to be inaccurate (says 'refactor X' " +
      "but the actual scope is X + Y). User asks the Worker to correct the description. Worker must " +
      "patch via `todo_update({id, content: '...'})`. Status-only `todo_update` is INSUFFICIENT " +
      "(content stays wrong); `op:'init'` is FORBIDDEN (wipes other items' status).",
    behaviour:
      "invokes `todo_update` with both `id` AND `content` field set; does NOT invoke `todo_update({op:'init'})`",
    polarity: 'must_patch_content',
  },
  {
    id: 'mid_task_delete_obsolete',
    description:
      "Worker has a 4-item plan; one step ('add backwards-compat shim') has become obsolete after " +
      "user pivoted the requirements. User asks Worker to drop that step. Worker must call " +
      "`todo_update({id, status:'deleted'})`. Silent skip is FAIL (leaves stale plan entry); " +
      "`op:'init'` is FAIL (wipes progress).",
    behaviour:
      "invokes `todo_update` with `id` AND `status` field set to `deleted`; does NOT invoke `todo_update({op:'init'})`",
    polarity: 'must_delete_status',
  },
  {
    id: 'initial_plan_commitment',
    description:
      'Empty store (Worker first turn). User gives a non-trivial 3-step task. Worker must commit a ' +
      "plan — EITHER `todo_update({op:'init', items:[...]})` (canonical batch seed) OR ≥2 separate " +
      '`todo_create` calls. Both paths are valid for INITIAL commitment per FEATURE_170 design.',
    behaviour:
      "invokes `todo_update({op:'init', items:[...]})` OR ≥2 `todo_create` calls",
    polarity: 'must_commit_plan',
  },
  {
    id: 'status_flip_backwards_compat',
    description:
      'Worker marked item 2 `in_progress` last turn and has now finished the work. Must flip the ' +
      "status — `todo_update({id:'todo_2', status:'completed'})`. This is v0.7.40 backwards-compat " +
      'path; C5 prompt rewrite must NOT regress it.',
    behaviour:
      "invokes `todo_update` with `id` AND `status` field set to `completed` (or equivalent terminal status)",
    polarity: 'must_flip_status',
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — v_baseline (pre-C5 prompt, v0.7.40) vs v_proposed (v0.7.41 C5).
//
// Tool surface is IDENTICAL across both variants — both have `todo_create`
// and extended `todo_update` available. ONLY the prompt section differs.
// This isolates prompt impact from tool wiring (which is non-LLM and
// covered by C1-C4 unit tests).
// ---------------------------------------------------------------------------

const TOOL_DOCS = [
  '## Available Tools',
  '',
  '`todo_update`:',
  '  Inputs (UNION — pick ONE shape):',
  '    A. Batch initial seed:  { op:"init", items:[{id, content, activeForm?, evaluator?}] }',
  '    B. Per-item patch:      { id:string, content?:string, status?:"pending"|"in_progress"|"completed"|"failed"|"cancelled"|"deleted", activeForm?:string, note?:string, evaluator?:"build"|"test"|"lint", metadata?:object }',
  '  Output: { ok:true, ... } or { ok:false, reason:"..." }',
  '',
  '`todo_create` (NEW, FEATURE_170 v0.7.41):',
  '  Input:  { content:string, activeForm?:string, evaluator?:"build"|"test"|"lint", metadata?:object }',
  '  Output: { ok:true, id:string } or { ok:false, reason:"..." }',
  '  Effect: inserts ONE new todo item with a store-minted id. Existing items unchanged.',
  '',
  '`read` / `grep` / `bash`: standard read-only / mutation tools.',
].join('\n');

const PLAN_FIRST_CONTRACT_BASELINE = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled`). Mark exactly ONE item `in_progress` at a time.',
  '- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `\'build\' | \'test\' | \'lint\'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- Replan iteratively: insert / cancel / adjust items via `todo_update` as the picture firms up. Do NOT reset the entire list mid-task; reserve full reset for explicit "start over" decisions.',
].join('\n');

const PLAN_FIRST_CONTRACT_PROPOSED = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update({op:"init", items:[...]})` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update({op:"init", ...})` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `\'build\' | \'test\' | \'lint\'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- Replan iteratively as the picture firms up — FEATURE_170 v0.7.41 split the API for clarity:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({content:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '    * EDIT ONE STEP\'S TEXT / EVALUATOR / METADATA: `todo_update({id, content?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '    * REMOVE ONE STEP entirely (no breadcrumb): `todo_update({id, status:"deleted"})`. Prefer over `cancelled` when the item was wholly off-plan.',
  '    * STRIKETHROUGH ONE STEP (keep visible breadcrumb): `todo_update({id, status:"cancelled", note:"..."})`. Prefer over `deleted` when the user benefits from seeing the discarded record.',
  '    * FULL REPLAN (rare — reserved for explicit "start over"): `todo_update({op:"init", items:[...]})`. NEVER use full replan for mid-task insertion — it wipes the user-visible progress on items already completed.',
].join('\n');

// ---------------------------------------------------------------------------
// Prompt-iteration pilot variants (2026-05-17) — hypothesis-testing for zhipu
// C3 -60pp regression (project_zhipu_send_message_floor + cognitive load).
// All four are SIMPLIFICATIONS of v_proposed; none add new constraints
// (per `feedback_prompt_strengthening_cross_case_regression` memory).
//
// V2 = merge REMOVE+STRIKETHROUGH bullets, demote `cancelled` to parenthetical
// V3 = drop `cancelled` from teaching entirely (most aggressive)
// V4 = keep both bullets but delete "Prefer over" comparative clauses
// ---------------------------------------------------------------------------

const PLAN_FIRST_CONTRACT_V2 = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update({op:"init", items:[...]})` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update({op:"init", ...})` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `\'build\' | \'test\' | \'lint\'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- Replan iteratively as the picture firms up — FEATURE_170 v0.7.41 split the API for clarity:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({content:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '    * EDIT ONE STEP\'S TEXT / EVALUATOR / METADATA: `todo_update({id, content?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '    * REMOVE ONE STEP: `todo_update({id, status:"deleted"})`. (If you want a visible breadcrumb instead of full removal, use `status:"cancelled"` with a `note`.)',
  '    * FULL REPLAN (rare — reserved for explicit "start over"): `todo_update({op:"init", items:[...]})`. NEVER use full replan for mid-task insertion — it wipes the user-visible progress on items already completed.',
].join('\n');

const PLAN_FIRST_CONTRACT_V3 = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update({op:"init", items:[...]})` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update({op:"init", ...})` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `\'build\' | \'test\' | \'lint\'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- Replan iteratively — FEATURE_170 v0.7.41 split the API:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({content})`',
  '    * EDIT ONE STEP: `todo_update({id, content?, ...})`',
  '    * REMOVE ONE STEP: `todo_update({id, status:"deleted"})`',
  '    * FULL REPLAN (rare): `todo_update({op:"init", items:[...]})`. NEVER use for mid-task insertion.',
].join('\n');

const PLAN_FIRST_CONTRACT_V4 = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update({op:"init", items:[...]})` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update({op:"init", ...})` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `\'build\' | \'test\' | \'lint\'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- Replan iteratively as the picture firms up — FEATURE_170 v0.7.41 split the API for clarity:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({content:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '    * EDIT ONE STEP\'S TEXT / EVALUATOR / METADATA: `todo_update({id, content?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '    * REMOVE ONE STEP entirely (no breadcrumb): `todo_update({id, status:"deleted"})`.',
  '    * STRIKETHROUGH ONE STEP (keep visible breadcrumb): `todo_update({id, status:"cancelled", note:"..."})`.',
  '    * FULL REPLAN (rare — reserved for explicit "start over"): `todo_update({op:"init", items:[...]})`. NEVER use full replan for mid-task insertion — it wipes the user-visible progress on items already completed.',
].join('\n');

export type PromptVariantKind = 'baseline' | 'proposed' | 'v2' | 'v3' | 'v4';

function buildSystemPrompt(variant: PromptVariantKind): string {
  let contract: string;
  switch (variant) {
    case 'baseline': contract = PLAN_FIRST_CONTRACT_BASELINE; break;
    case 'proposed': contract = PLAN_FIRST_CONTRACT_PROPOSED; break;
    case 'v2': contract = PLAN_FIRST_CONTRACT_V2; break;
    case 'v3': contract = PLAN_FIRST_CONTRACT_V3; break;
    case 'v4': contract = PLAN_FIRST_CONTRACT_V4; break;
  }
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    contract,
    '',
    TOOL_DOCS,
  ].join('\n');
}

// Canned prior-state Worker transcripts. Each case fabricates a believable
// mid-run state so the user's follow-up message has unambiguous context.

const PLAN_3_ITEMS_PRIOR: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user' as const,
    content:
      "Add a feature flag `experimental_v2` to the auth module, plumb it through the login endpoint, " +
      'and update the relevant unit tests.',
  },
  {
    role: 'assistant' as const,
    content:
      "I'll commit a 3-step plan first.\n\n" +
      '<tool_call>\n' +
      '{"name":"todo_update","arguments":{"op":"init","items":[' +
      '{"id":"todo_1","content":"Add `experimental_v2` flag to auth module config","activeForm":"Adding `experimental_v2` flag to auth module config"},' +
      '{"id":"todo_2","content":"Plumb the flag through the login endpoint handler","activeForm":"Plumbing the flag through the login endpoint handler"},' +
      '{"id":"todo_3","content":"Update unit tests in auth module for the flag","activeForm":"Updating unit tests in auth module for the flag"}' +
      ']}}\n' +
      '</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "count": 3 }\n</tool_result>',
  },
  {
    role: 'assistant' as const,
    content:
      "Marking todo_1 in_progress and starting on the config change.\n\n" +
      '<tool_call>\n{"name":"todo_update","arguments":{"id":"todo_1","status":"in_progress"}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "changedFields": ["status"] }\n</tool_result>',
  },
  {
    role: 'assistant' as const,
    content:
      "Added the flag to `src/auth/config.ts` (default false). Now marking todo_1 completed and starting todo_2.\n\n" +
      '<tool_call>\n{"name":"todo_update","arguments":{"id":"todo_1","status":"completed"}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "changedFields": ["status"] }\n</tool_result>',
  },
  {
    role: 'assistant' as const,
    content:
      "Now starting todo_2 — plumbing the flag through the login handler.\n\n" +
      '<tool_call>\n{"name":"todo_update","arguments":{"id":"todo_2","status":"in_progress"}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "changedFields": ["status"] }\n</tool_result>',
  },
];

const PLAN_4_ITEMS_PRIOR: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user' as const,
    content:
      "Refactor the auth module to use the new password-hashing library, plumb the new options through " +
      "the login endpoint, add backwards-compat shim for old session tokens, and update the unit tests.",
  },
  {
    role: 'assistant' as const,
    content:
      "I'll commit a 4-step plan first.\n\n" +
      '<tool_call>\n' +
      '{"name":"todo_update","arguments":{"op":"init","items":[' +
      '{"id":"todo_1","content":"Refactor auth module to use new password-hashing library","activeForm":"Refactoring auth module to use new password-hashing library"},' +
      '{"id":"todo_2","content":"Plumb new options through login endpoint","activeForm":"Plumbing new options through login endpoint"},' +
      '{"id":"todo_3","content":"Add backwards-compat shim for old session tokens","activeForm":"Adding backwards-compat shim for old session tokens"},' +
      '{"id":"todo_4","content":"Update unit tests","activeForm":"Updating unit tests"}' +
      ']}}\n' +
      '</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "count": 4 }\n</tool_result>',
  },
  {
    role: 'assistant' as const,
    content:
      "Marking todo_1 in_progress and starting on the auth refactor.\n\n" +
      '<tool_call>\n{"name":"todo_update","arguments":{"id":"todo_1","status":"in_progress"}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>\n{ "ok": true, "changedFields": ["status"] }\n</tool_result>',
  },
];

const PLAN_3_ITEMS_TODO2_IN_PROGRESS_PRIOR: ReadonlyArray<KodaXMessage> = [
  ...PLAN_3_ITEMS_PRIOR,
  // After plumbing the flag through the login endpoint, the work is done.
  {
    role: 'assistant' as const,
    content:
      "Plumbed the flag through `src/auth/login.ts:handleLogin` — it now checks the flag and dispatches " +
      'to the v2 path when set. The endpoint signature is unchanged for backwards compatibility.',
  },
];

function variantIdOf(v: PromptVariantKind): string {
  switch (v) {
    case 'baseline': return 'v_baseline';
    case 'proposed': return 'v_proposed';
    case 'v2': return 'v_proposed_v2';
    case 'v3': return 'v_proposed_v3';
    case 'v4': return 'v_proposed_v4';
  }
}

function buildVariantForCase(
  caseId: CaseId,
  variant: PromptVariantKind,
): PromptVariant {
  const systemPrompt = buildSystemPrompt(variant);
  switch (caseId) {
    case 'mid_task_insert_via_todo_create':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'pre-C5 prompt: only knows op:init batch + op:update status'
            : 'C5 prompt: teaches todo_create for mid-task insert',
        systemPrompt,
        priorMessages: PLAN_3_ITEMS_PRIOR,
        userMessage:
          "One more thing — please also add a CLI command `--show-experimental-v2` that prints the current " +
          'state of the flag. Add it to the plan and handle it as part of this task.',
      };
    case 'mid_task_content_patch':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'pre-C5 prompt — only op:init + status; no per-item content patch'
            : 'C5 prompt: teaches todo_update({id, content}) for content edit',
        systemPrompt,
        priorMessages: PLAN_4_ITEMS_PRIOR,
        userMessage:
          "Actually I just realized todo_3 is mis-stated — it should be 'Add backwards-compat shim for " +
          "old session tokens AND old auth cookies', not just session tokens. Please correct the wording " +
          'of todo_3 so the plan is accurate.',
      };
    case 'mid_task_delete_obsolete':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'pre-C5 prompt — only knows status enum without deleted'
            : 'C5 prompt: teaches todo_update({id, status:"deleted"}) for removal',
        systemPrompt,
        priorMessages: PLAN_4_ITEMS_PRIOR,
        userMessage:
          "I want to drop the backwards-compat shim entirely — we're going to force-migrate all sessions " +
          'on rollout instead. Please drop todo_3 from the plan; we don\'t need it.',
      };
    case 'initial_plan_commitment':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'pre-C5 prompt — initial commitment via op:init'
            : 'C5 prompt — initial commitment via op:init OR multiple todo_create',
        systemPrompt,
        priorMessages: [],
        userMessage:
          "Please add a feature flag `experimental_v2` to the auth module, plumb it through the login " +
          'endpoint, and update the relevant unit tests for the new flag behavior.',
      };
    case 'status_flip_backwards_compat':
      return {
        id: variantIdOf(variant),
        description: 'status flip — must work the same across both prompts',
        systemPrompt,
        priorMessages: PLAN_3_ITEMS_TODO2_IN_PROGRESS_PRIOR,
        userMessage:
          "Great — please mark that step done and move on to the next step.",
      };
  }
}

/**
 * Pilot variants for the 2026-05-17 prompt iteration probe — compares the
 * current v_proposed (V1 control) against three simplification candidates
 * (V2 merged REMOVE+STRIKETHROUGH / V3 drop cancelled / V4 keep dual no
 * Prefer-over). Skips v_baseline to keep cost down; we already have the
 * baseline measurements from the prior Phase 1 run.
 */
export function buildPromptVariantsIteration(caseId: CaseId): readonly PromptVariant[] {
  return [
    buildVariantForCase(caseId, 'proposed'),
    buildVariantForCase(caseId, 'v2'),
    buildVariantForCase(caseId, 'v3'),
    buildVariantForCase(caseId, 'v4'),
  ];
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [
    buildVariantForCase(caseId, 'baseline'),
    buildVariantForCase(caseId, 'proposed'),
  ];
}

// ---------------------------------------------------------------------------
// Judges — 9-pattern tool-name detection (audit-corrected set from
// FEATURE_125 2026-05-16 lesson). Per-case polarity-specific assertion.
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // 1. fn-call form `read(...)` — exclude shell-wrapper false positives
    //    (Layer B 2026-05-17 finding: `<command>read(...)` was misjudged PASS).
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    // 3. XML-style `<read>...</read>` OR self-closing `<read ... />`.
    //    Require either a closing tag within 2000 chars or `/>` self-close
    //    at the end of the opener (ds-style `<read path=".." />`).
    //    Rejects truncated `<read>` (no close) responses.
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),
    // 7. ark-style `<tool_call>read<arg_key>...</tool_call>` — require
    //    closing `</tool_call\s*>` within 2000 chars (zhipu emits trailing
    //    whitespace `</tool_call >`); rejects broken-JSON
    //    `<tool_call>read",{...` (Layer B 2026-05-17 finding).
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

function invokesOpInit(text: string): boolean {
  // Allow optional quote between `op` and `:` to handle JSON `"op":"init"`.
  return /["'`]?op["'`]?\s*[:=]\s*["'`]?init["'`]?/i.test(text)
    || /["'`]op["'`]\s*:\s*["'`]init["'`]/i.test(text);
}

function judgeMidTaskInsert(out: string): { passed: boolean; reason?: string } {
  if (!invokesTool(out, 'todo_create')) {
    return { passed: false, reason: '`todo_create` not invoked' };
  }
  if (invokesOpInit(out)) {
    return { passed: false, reason: '`todo_create` invoked AND `op:"init"` also invoked — must not re-seed' };
  }
  return { passed: true };
}

function judgeMidTaskContentPatch(out: string): { passed: boolean; reason?: string } {
  if (!invokesTool(out, 'todo_update')) {
    return { passed: false, reason: '`todo_update` not invoked' };
  }
  if (invokesOpInit(out)) {
    return { passed: false, reason: '`op:"init"` re-seed used — forbidden mid-task' };
  }
  // Must have a content field — distinguishes patch from status-only update.
  if (!/["'`]?content["'`]?\s*[:=]/i.test(out)) {
    return { passed: false, reason: '`todo_update` invoked but no `content` field — patch missing' };
  }
  return { passed: true };
}

function judgeMidTaskDelete(out: string): { passed: boolean; reason?: string } {
  if (!invokesTool(out, 'todo_update')) {
    return { passed: false, reason: '`todo_update` not invoked' };
  }
  if (invokesOpInit(out)) {
    return { passed: false, reason: '`op:"init"` re-seed used — forbidden' };
  }
  // status: "deleted" specifically (cancelled is acceptable in some readings
  // but the user asked to "drop" not "keep as breadcrumb" — strict deleted).
  // Pattern allows quote between `status` and `:` (JSON `"status":"deleted"`).
  if (!/["'`]?status["'`]?\s*[:=]\s*["'`]?(deleted|cancelled)["'`]?/i.test(out)) {
    return { passed: false, reason: 'status not set to `deleted`/`cancelled`' };
  }
  return { passed: true };
}

function judgeInitialPlan(out: string): { passed: boolean; reason?: string } {
  // Path A: `op:init` + `items` array structure (canonical batch seed).
  // Accept this even when the explicit `todo_update` tool-name wrapper is
  // absent — models often emit raw `<tool_call>{"op":"init","items":[...]}`
  // or kimi-style ```todo_update\n{op:init, items:[]}``` without the JSON
  // `{"name":"todo_update"}` envelope. The runtime infers `todo_update`
  // from the `{op, items}` shape; the judge should too.
  if (invokesOpInit(out) && /["'`]?items["'`]?\s*[:=]/i.test(out)) {
    return { passed: true };
  }
  // Path B: ≥2 todo_create invocations.
  const patterns = buildToolNamePatterns('todo_create');
  let count = 0;
  for (const p of patterns) {
    const gp = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    const matches = out.match(gp);
    if (matches) count = Math.max(count, matches.length);
  }
  if (count >= 2) return { passed: true };
  return { passed: false, reason: `no op:init+items structure AND only ${count} todo_create calls (need ≥2)` };
}

function judgeStatusFlip(out: string): { passed: boolean; reason?: string } {
  if (!invokesTool(out, 'todo_update')) {
    return { passed: false, reason: '`todo_update` not invoked' };
  }
  if (invokesOpInit(out)) {
    return { passed: false, reason: '`op:"init"` re-seed — wrong path for status flip' };
  }
  // Pattern allows quote between `status` and `:` (JSON `"status":"completed"`).
  if (!/["'`]?status["'`]?\s*[:=]\s*["'`]?(completed|done|finished)["'`]?/i.test(out)) {
    return { passed: false, reason: 'status not flipped to completed' };
  }
  return { passed: true };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) {
    throw new Error(`Unknown FEATURE_170 case id: ${caseId}`);
  }
  switch (caseId) {
    case 'mid_task_insert_via_todo_create':
      return [{ name: 'invokes_todo_create_no_op_init', category: 'correctness', judge: judgeMidTaskInsert }];
    case 'mid_task_content_patch':
      return [{ name: 'todo_update_with_content_patch', category: 'correctness', judge: judgeMidTaskContentPatch }];
    case 'mid_task_delete_obsolete':
      return [{ name: 'todo_update_status_deleted', category: 'correctness', judge: judgeMidTaskDelete }];
    case 'initial_plan_commitment':
      return [{ name: 'commits_plan_either_path', category: 'correctness', judge: judgeInitialPlan }];
    case 'status_flip_backwards_compat':
      return [{ name: 'todo_update_status_completed', category: 'correctness', judge: judgeStatusFlip }];
  }
}
