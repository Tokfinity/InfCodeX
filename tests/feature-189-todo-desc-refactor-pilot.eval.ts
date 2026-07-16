/**
 * FEATURE_189 TODO_* DESCRIPTION REFACTOR — Pilot Eval — 2026-05-24
 *
 * Tests whether the claudecode-style layered restructure of the 4 todo_*
 * tool descriptions regresses plan-first behavior or trivial-exemption.
 *
 * The 4 `description` fields in `packages/coding/src/tools/registry.ts`
 * were reorganized from verbose monolithic prose into explicit
 * `## When to Use This Tool` / `## When NOT to Use This Tool` sections.
 * Combined description bytes drop from ~15.1KB to ~9.7KB (~36% lighter)
 * with the same semantic content reorganized for LLM scanability.
 *
 * Variants delivered to provider via the harness `tools` parameter:
 *   v_baseline_verbose_monolithic — pre-refactor descriptions
 *   v_proposed_claudecode_layered — post-refactor descriptions
 *
 * The production worker-role-prompt sections (PLAN-FIRST CONTRACT /
 * PLAN-LIST HYGIENE / SCOPE / MUTATION / REPO INTEL / DISPATCH /
 * STEERING / FAN-OUT / TERMINATION) are byte-identical across variants —
 * we are isolating the impact of the 4 todo_* tool description fields.
 *
 * Cases:
 *   C1 multi_step_implementation — non-trivial 5-step implementation
 *      task. Expects: model issues a batch of todo_create calls up
 *      front (plan-first behavior).
 *   C2 single_trivial_fix       — single-line variable rename in one
 *      file. Expects: model does NOT call todo_create (trivial
 *      exemption per "When NOT to Use").
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells.
 * Estimated cost: ~$0.5.
 *
 * Pre-registered SHIP gate (decision-matrix):
 *   A (multi-step): v_proposed plan-first ≥ v_baseline − 1 cell
 *   B (trivial):    v_proposed false-positive todo_create
 *                   ≤ v_baseline + 1 cell
 *   Both A AND B met → expand to 5-alias panel + judge audit
 *   Either fails → DROP refactor, restore old descriptions
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-todo-desc-refactor-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-todo-desc-refactor-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// =====================================================================
// PRODUCTION WORKER PROMPT (byte-aligned worker-role-prompt.ts 2026-05-24)
// =====================================================================

const SYSTEM_PROMPT = [
  "You are the Worker — KodaX's primary agent for this task.",
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  '',
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (v0.7.42, mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").',
  '    * `description` — OPTIONAL. Fuller context / work instructions read when you pick up the item later. Multi-line OK; NOT rendered in the compact row. Skip when subject alone is enough.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner while this item is `in_progress` (e.g. "Auditing handleAuth callers"). Supply alongside `subject` so the spinner reads natural while you work.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_create` AT THAT MOMENT — one call per newly-realized step — to retrofit the plan. Do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '',
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first to read the item\'s CURRENT state.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list (or call `todo_list`) and confirm no item with the same subject is already present.',
  '',
  'SCOPE COMMITMENT:',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '',
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial. Prefer `edit` over `write` for existing files.',
  '',
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary.',
].join('\n');

// =====================================================================
// V_BASELINE — verbose monolithic todo_* descriptions (pre-refactor)
// =====================================================================

const TODO_UPDATE_BASELINE: KodaXToolDefinition = {
  name: 'todo_update',
  description:
    'Drive the visible plan checklist so the user sees real-time progress — single-item PATCH plus status transition. '
    + '`op="update"` (default; omit `op` for back-compat) is the primary mode: target ONE item by `id` and either change its status, patch its fields, or both in one call.\n\n'
    + 'For ADDING new items (initial plan commitment or mid-task additive growth), use a batch of `todo_create` calls instead — purely additive and safe. The legacy `op="init"` whole-list replace path is reserved for runner-side seeding only; LLMs should not call it because it destructively drops any item not echoed back, which weaker models routinely under-echo and lose completed work.\n\n'
    + 'Status transitions:\n'
    + '- `in_progress` — set BEFORE starting work on an item. When transitioning to `in_progress`, ALWAYS supply `activeForm` (present-continuous rephrasing of the subject, e.g. subject "Run failing tests" → activeForm "Running failing tests") so the spinner shows the user what you are working on right now.\n'
    + '- `completed` — set AFTER finishing that item.\n'
    + '- Only ONE item should be `in_progress` per owner at any time — finish or fail the current item before starting the next.\n'
    + '- `failed` — an attempt clearly failed and needs retry.\n'
    + '- `skipped` — the item turned out to be unnecessary (e.g. planner-driven merging of two obligations into one).\n'
    + '- `cancelled` — you decide mid-execution to drop an item the user no longer needs; UI shows strikethrough as a visible breadcrumb of the discarded record.\n'
    + '- `deleted` — remove the item from the visible list entirely (no breadcrumb). Prefer `deleted` over `cancelled` when the item was wholly off-plan; prefer `cancelled` when the user benefits from seeing the discarded record.\n\n'
    + 'Field patches (status optional when only patching):\n'
    + '- `subject` (non-empty string) replaces the brief imperative title shown in the row.\n'
    + '- `description` (string; empty clears) replaces the fuller context shown by todo_get.\n'
    + '- `evaluator` ("build" | "test" | "lint") replaces the deterministic evaluator hint.\n'
    + '- `metadata` (object | null) — pass null to CLEAR the whole bag; pass an object to shallow-merge keys; inside the object, a value of null DELETES that specific key from existing metadata (mixed merge+delete in one call is supported, e.g. `{newKey: "v", oldKey: null}`).\n'
    + '- Patch fields can be combined with a status transition in a single call.\n\n'
    + 'Error handling:\n'
    + '- `ok=false` with reason "Unknown todo id" — inspect the listed valid ids and retry with a correct one.\n'
    + '- `ok=false` with reason "todo_update is not active" — the current run has no plan list; continue working without further todo_update calls.\n'
    + '- `ok=false` with reason "blocked-by-hook" (or an extension-supplied string) — an extension policy rejected the transition; re-read the visible plan and revise your approach before retrying.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the todo item to update.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'skipped', 'cancelled', 'deleted'],
        description: 'New status.',
      },
      subject: { type: 'string', description: 'Optional. Replaces the brief imperative title.' },
      description: { type: 'string', description: 'Optional. Replaces the fuller context.' },
      activeForm: { type: 'string', description: 'Present-continuous form for spinner.' },
      note: { type: 'string', description: 'Optional free-text reason.' },
      evaluator: {
        type: 'string',
        enum: ['build', 'test', 'lint'],
        description: 'Optional per-step deterministic evaluator.',
      },
    },
  },
};

const TODO_CREATE_BASELINE: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Insert ONE new pending item into the visible plan list — purely additive, existing items untouched. '
    + 'Use for plan commitment (one call per planned step, batched in the same response) AND for mid-task additive growth when an extra step is needed.\n\n'
    + 'Field semantics:\n'
    + '- `subject` (required) — brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers")\n'
    + '- `description` (optional) — fuller context / work instructions read when this item is later picked up via todo_get; multi-line OK; NOT rendered in the compact row\n'
    + '- `activeForm` (optional) — present-continuous form (e.g. "Auditing handleAuth callers") shown by the spinner when this item later flips to `in_progress` via todo_update\n'
    + '- `evaluator` (optional, "build" | "test" | "lint") — runs the corresponding deterministic check when the item flips to "completed". Use sparingly, only on milestone steps with a real ground-truth check\n'
    + '- `metadata` (optional) — opaque key-value bag carried alongside the item for extension hooks / observability; the UI does NOT render it\n\n'
    + 'The store auto-generates the id (monotonic `todo_N`). Never pass an id — any caller-supplied id is rejected at the schema layer.\n\n'
    + 'Returns {ok: true, id: "todo_<n>"} on success or {ok: false, reason: "..."} when the store is not wired, validation fails, or an extension hook blocks the create.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Brief imperative title.' },
      description: { type: 'string', description: 'Optional fuller context.' },
      activeForm: { type: 'string', description: 'Optional present-continuous form.' },
      evaluator: {
        type: 'string',
        enum: ['build', 'test', 'lint'],
        description: 'Optional per-step deterministic evaluator.',
      },
    },
    required: ['subject'],
  },
};

const TODO_LIST_BASELINE: KodaXToolDefinition = {
  name: 'todo_list',
  description:
    'Read-only query that returns the current visible plan list as JSON. Use this when you want to confirm what items are pending before deciding the next move, when you need to see the canonical id set after an "Unknown todo id" error, or when refining a plan and want to compare it against the existing list. '
    + 'Returns {ok: true, count: N, items: [{id, subject, status, description?, activeForm?, note?}, ...]} on success; {ok: false, reason: "todo_list is not active ..."} when no plan list infrastructure is wired (no managed task active). '
    + 'This tool is read-only — it never mutates the store. Pair with `todo_create` to add new steps additively, `todo_update` to change item state, or `todo_get` to fetch a single item with full detail (incl. description / metadata / evaluator).',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const TODO_GET_BASELINE: KodaXToolDefinition = {
  name: 'todo_get',
  description:
    'Read-only single-item lookup. Returns the full TodoItem detail for one id (subject + optional description + status + activeForm + note + evaluator + metadata).\n\n'
    + 'When to use:\n'
    + '- BEFORE calling todo_update when uncertain about an item\'s current state — runner-side auto-handlers may have flipped statuses between your turns; mutating on a stale view produces silent no-op patches.\n'
    + '- WHEN PICKING UP an item — the full `description` carries the work instruction; the compact row label (`subject`) alone often is not enough.\n'
    + '- AFTER an "Unknown todo id" error on todo_update — first use todo_list to see all ids, then todo_get to drill into the specific one.\n\n'
    + 'Returns {ok: true, item: {...}} on success or {ok: false, reason: "..."} when the store is not wired or the id is unknown (the reason carries the canonical valid-id list).',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The todo id to retrieve.' },
    },
    required: ['id'],
  },
};

// =====================================================================
// V_PROPOSED — claudecode-style layered todo_* descriptions (post-refactor)
// =====================================================================

const TODO_UPDATE_PROPOSED: KodaXToolDefinition = {
  name: 'todo_update',
  description:
    'Drive the visible plan checklist so the user sees real-time progress — single-item PATCH plus status transition for ONE existing todo item. `op="update"` is the default (omit `op` for back-compat); target one item by `id` and change its status, patch its fields, or both in one call.\n\n'
    + '## When to Use This Tool\n\n'
    + '- BEFORE starting work on an item — flip it to `in_progress` and supply `activeForm` (present-continuous form of the subject; e.g. subject "Run failing tests" → activeForm "Running failing tests") so the spinner reflects what you are doing right now.\n'
    + '- AFTER finishing work on an item — flip it to `completed`. If the item carries an `evaluator` hint, the runner runs the deterministic check on transition and surfaces stderr on failure.\n'
    + '- WHEN requirements clarify mid-task — patch `subject` and/or `description` to refine the row in place (e.g. "Run failing tests" → "Run failing tests AND clean up tmp").\n'
    + '- WHEN an attempt clearly failed and needs retry — set status to `failed`.\n'
    + '- WHEN the item turned out to be unnecessary (e.g. two obligations merged into one) — set status to `skipped`.\n'
    + '- WHEN you decide mid-execution to drop an item the user no longer needs — set status to `cancelled` (UI shows strikethrough as a visible breadcrumb); use `deleted` instead if the item was wholly off-plan and a breadcrumb would just clutter.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- To ADD a new item — call `todo_create` instead (one call per planned step, batched). `todo_update` only mutates EXISTING items.\n'
    + '- When the item is already in the target status — a redundant update is a silent no-op and clutters the transcript.\n'
    + '- When uncertain about an item\'s current state — call `todo_get` first; runner-side auto-handlers may have flipped statuses between your turns, and mutating on a stale view produces silent no-op patches.\n'
    + '- `op="init"` is reserved for runner-side seeding only. LLMs should never call it — it destructively replaces the whole list, dropping any item not echoed back, and weaker models routinely under-echo and lose completed work.\n\n'
    + '## Status Transitions\n\n'
    + 'Only ONE item per owner should be `in_progress` at any time — finish or fail the current item before starting the next. Valid statuses: `in_progress`, `completed`, `failed`, `skipped`, `cancelled`, `deleted`. `"pending"` is intentionally not allowed — items start pending automatically and only the runner moves them back to pending after a revise verdict. Prefer `deleted` over `cancelled` when the item was wholly off-plan; prefer `cancelled` when the user benefits from seeing the discarded record.\n\n'
    + '## Field Patches (status optional when only patching)\n\n'
    + '- `subject` (non-empty string) replaces the brief imperative title shown in the row.\n'
    + '- `description` (string; empty clears) replaces the fuller context shown by `todo_get`.\n'
    + '- `activeForm` is required with `in_progress`; for other statuses the previous value is preserved but irrelevant.\n'
    + '- `note` is optional free-text reason; when omitted, any pre-existing note is preserved.\n'
    + '- `evaluator` ("build" | "test" | "lint") replaces the deterministic evaluator hint.\n'
    + '- `metadata` (object | null) — shallow-merge: top-level keys overwrite; a value of `null` inside the object DELETES that key (mixed merge+delete is supported, e.g. `{newKey: "v", oldKey: null}`); pass the whole field as `null` to clear ALL metadata.\n'
    + '- Patch fields can be combined with a status transition in a single call.\n\n'
    + '## Error Handling\n\n'
    + '- `ok=false` with reason "Unknown todo id" — inspect the listed valid ids and retry, or call `todo_list` to refresh.\n'
    + '- `ok=false` with reason "todo_update is not active" — the current run has no plan list; continue without further `todo_update` calls.\n'
    + '- `ok=false` with reason "blocked-by-hook" (or an extension-supplied string) — an extension policy rejected the transition; re-read the visible plan and revise your approach before retrying.',
  input_schema: TODO_UPDATE_BASELINE.input_schema,
};

const TODO_CREATE_PROPOSED: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Insert ONE new pending item into the visible plan list — purely additive, existing items untouched. The store auto-generates the id (monotonic `todo_<n>`); never pass an id — any caller-supplied id is rejected at the schema layer.\n\n'
    + '## When to Use This Tool\n\n'
    + '- AT THE START of a non-trivial multi-step task — commit the full plan up front by batching one `todo_create` call per planned step in the same response, so the user sees the intended trajectory.\n'
    + '- WHEN you receive a user request with multiple distinct sub-tasks — capture each as its own item.\n'
    + '- WHEN you discover an additional step mid-task — add it additively so the user sees the plan growing rather than the original list being silently rewritten.\n'
    + '- BEFORE fanning out to child workers via `dispatch_child_task` — the plan list is the natural anchor for the work each child will execute.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- For a single straightforward operation that completes in one step — skip the plan list entirely.\n'
    + '- For purely informational responses (answering a question, explaining code) where there is no execution work to track.\n'
    + '- When an equivalent item already exists in the plan list — call `todo_list` first if unsure; duplicate items confuse the user.\n'
    + '- For the actual work itself — `todo_create` only RECORDS planned work; you still need to perform the real operations (read, edit, run, etc.) in subsequent tool calls.\n\n'
    + '## Fields\n\n'
    + '- `subject` (required) — brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").\n'
    + '- `description` (optional) — fuller context / work instructions read when this item is later picked up via `todo_get`; multi-line OK; NOT rendered in the compact row.\n'
    + '- `activeForm` (optional) — present-continuous form (e.g. "Auditing handleAuth callers") shown by the spinner when this item later flips to `in_progress` via `todo_update`.\n'
    + '- `evaluator` (optional, "build" | "test" | "lint") — runs the corresponding deterministic check when the item flips to "completed". Use sparingly, only on milestone steps with a real ground-truth check.\n'
    + '- `metadata` (optional) — opaque key-value bag carried alongside the item for extension hooks / observability; the UI does NOT render it.\n\n'
    + 'Returns `{ok: true, id: "todo_<n>"}` on success or `{ok: false, reason: "..."}` when the store is not wired, validation fails, or an extension hook blocks the create.',
  input_schema: TODO_CREATE_BASELINE.input_schema,
};

const TODO_LIST_PROPOSED: KodaXToolDefinition = {
  name: 'todo_list',
  description:
    'Read-only query that returns the current visible plan list as JSON. Never mutates the store.\n\n'
    + '## When to Use This Tool\n\n'
    + '- BEFORE deciding the next move — confirm what items are pending and which is currently `in_progress`.\n'
    + '- AFTER an "Unknown todo id" error — see the canonical valid-id set before retrying `todo_update` or `todo_get`.\n'
    + '- WHEN refining a plan — compare a proposed new step against existing items to avoid duplicates.\n'
    + '- AFTER a long quiet stretch — re-sync with any auto-handler-driven status flips before continuing.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- When you already know the exact id and want one item\'s full detail — call `todo_get` directly.\n'
    + '- When no plan list is active — the call returns `{ok: false, reason: "todo_list is not active ..."}`; further `todo_*` calls in this run will also be inactive.\n\n'
    + 'Returns `{ok: true, count: N, items: [{id, subject, status, description?, activeForm?, note?}, ...]}` on success. Pair with `todo_create` (additive), `todo_update` (mutate), or `todo_get` (full single-item detail).',
  input_schema: TODO_LIST_BASELINE.input_schema,
};

const TODO_GET_PROPOSED: KodaXToolDefinition = {
  name: 'todo_get',
  description:
    'Read-only single-item lookup. Returns the full TodoItem detail for one id — subject, optional description, status, activeForm, note, evaluator, metadata.\n\n'
    + '## When to Use This Tool\n\n'
    + '- BEFORE calling `todo_update` when uncertain about an item\'s current state — runner-side auto-handlers may have flipped statuses between your turns, and mutating on a stale view produces silent no-op patches.\n'
    + '- WHEN PICKING UP an item to work on — the full `description` carries the work instruction; the compact row label (`subject`) alone is often not enough.\n'
    + '- AFTER an "Unknown todo id" error on `todo_update` — call `todo_list` first to see all ids, then `todo_get` to drill into the specific one.\n\n'
    + '## When NOT to Use This Tool\n\n'
    + '- For a high-level overview of all items — call `todo_list` instead.\n'
    + '- When you already have a clear status flip + field patch to apply — call `todo_update` directly; an extra `todo_get` round-trip adds latency without changing the outcome.\n\n'
    + 'Returns `{ok: true, item: {...}}` on success or `{ok: false, reason: "..."}` when the store is not wired or the id is unknown (the reason carries the canonical valid-id list).',
  input_schema: TODO_GET_BASELINE.input_schema,
};

// =====================================================================
// Shared non-todo tools (identical across variants)
// =====================================================================

const SHARED_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file from disk.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute file path.' } },
      required: ['path'],
    },
  },
  {
    name: 'edit',
    description: 'Edit a file by replacing old_string with new_string.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write',
    description: 'Write contents to a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

const BASELINE_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE_BASELINE,
  TODO_UPDATE_BASELINE,
  TODO_LIST_BASELINE,
  TODO_GET_BASELINE,
  ...SHARED_TOOLS,
];

const PROPOSED_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE_PROPOSED,
  TODO_UPDATE_PROPOSED,
  TODO_LIST_PROPOSED,
  TODO_GET_PROPOSED,
  ...SHARED_TOOLS,
];

// =====================================================================
// User messages
// =====================================================================

const USER_MESSAGE_C1_MULTI_STEP =
  'Implement a new "subscription expiry warning" feature in the auth package: '
  + '(1) add a `expiresAt` field to the User model in `packages/auth/src/types.ts`; '
  + '(2) write a `daysUntilExpiry(user)` helper in `packages/auth/src/expiry.ts`; '
  + '(3) wire a banner component `<ExpiryBanner>` in `packages/web/src/components/`; '
  + '(4) add unit tests for the helper; '
  + '(5) add an integration test for the banner showing up at the right threshold.';

const USER_MESSAGE_C2_TRIVIAL =
  'Rename the variable `usrName` to `userName` in `packages/auth/src/login.ts` at line 42 — that\'s the only occurrence, it\'s a one-line change.';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly expectsTodoCreate: boolean;
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'multi_step_implementation',
    userMessage: USER_MESSAGE_C1_MULTI_STEP,
    expectsTodoCreate: true,
  },
  {
    id: 'single_trivial_fix',
    userMessage: USER_MESSAGE_C2_TRIVIAL,
    expectsTodoCreate: false,
  },
] as const;

// =====================================================================
// Judges
// =====================================================================

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

function judgePlanFirstMultiStep(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const todoCreateCalls = toolCalls.filter((t) => t.name === 'todo_create');
  if (todoCreateCalls.length >= 2) {
    return { passed: true };
  }
  if (todoCreateCalls.length === 1) {
    return { passed: false, reason: 'only 1 todo_create — multi-step needs batched plan-first' };
  }
  if (invokesTool(out, 'todo_create')) {
    return { passed: true, reason: 'narrative todo_create (text)' };
  }
  return { passed: false, reason: 'no todo_create invoked for multi-step task' };
}

function judgeTrivialExemption(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const hasTodoCreate = toolCalls.some((t) => t.name === 'todo_create');
  if (hasTodoCreate) {
    return { passed: false, reason: 'todo_create called for single-line trivial fix' };
  }
  if (invokesTool(out, 'todo_create')) {
    return { passed: false, reason: 'narrative todo_create (text) for trivial fix' };
  }
  return { passed: true };
}

const JUDGES_MULTI_STEP: readonly PromptJudge[] = [
  { name: 'plan_first_multi_step', category: 'correctness', judge: judgePlanFirstMultiStep },
];

const JUDGES_TRIVIAL: readonly PromptJudge[] = [
  { name: 'trivial_exemption', category: 'correctness', judge: judgeTrivialExemption },
];

// =====================================================================
// Driver
// =====================================================================

describe('FEATURE_189 todo_* description refactor — pilot', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => {
      /* no-op */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_verbose_monolithic',
            description: 'pre-refactor verbose monolithic todo_* descriptions',
            systemPrompt: SYSTEM_PROMPT,
            tools: BASELINE_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_claudecode_layered',
            description: 'post-refactor claudecode-style layered todo_* descriptions',
            systemPrompt: SYSTEM_PROMPT,
            tools: PROPOSED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges = c.expectsTodoCreate ? JUDGES_MULTI_STEP : JUDGES_TRIVIAL;

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const judgeName = c.expectsTodoCreate ? 'plan_first_multi_step' : 'trivial_exemption';
        const lines: string[] = [];
        lines.push(`[feature-189-todo-desc-refactor-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_verbose_monolithic', 'v_proposed_claudecode_layered']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const passCount = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === judgeName)?.passed,
            ).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} ${judgeName}=${passCount}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-todo-desc-refactor-pilot',
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
            toolCount: v.tools.length,
            userMessage: v.userMessage,
          })),
          aliases: result.cells.map((cell) => ({
            alias: cell.alias,
            variantId: cell.variantId,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              toolCalls: run.toolCalls,
              durationMs: run.durationMs,
              error: run.error,
              fallbackUsed: run.fallbackUsed,
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
            })),
          })),
        };
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
