/**
 * TODO TIMELINESS FIX — Pilot Eval — 2026-06-30
 *
 * Tests whether the A1 (worker TERMINATION close-out sentence) + A2 (todo_update
 * "flip it to `completed` before moving on" cadence) prompt changes make the
 * model mark todo items `completed` more promptly — without regressing.
 *
 * Background: KodaX's three todo reminders were one-shot; the prompt's strongest
 * timing language lived only on the fan-out path. A1 + A2 sharpen the inline /
 * termination completion cadence. B1 (recurring throttle reminder) is a harness
 * logic change covered by unit tests, NOT exercised here.
 *
 * Anti-pattern 8 compliance: the todo_update description is the REAL production
 * byte string (imported from BUILTIN_TOOL_DEFINITIONS). v_baseline reverts ONLY
 * the A2 phrase; v_proposed is production as-shipped. The worker TERMINATION
 * block is byte-aligned to worker-role-prompt.ts (baseline = pre-A1, proposed =
 * post-A1). PLAN-FIRST + PLAN-LIST HYGIENE context is byte-aligned and identical
 * across variants.
 *
 * Cases (both POSITIVE — we WANT the model to mark completed):
 *   C1 mid_task_cadence — todo_1 in_progress, its real work just finished.
 *      Expects: next action marks todo_1 `completed` (not jump to todo_2 work).
 *   C2 termination_closeout — all work done, todo_2 in_progress + todo_3 pending
 *      but unmarked, model about to wrap up.
 *      Expects: marks the open items `completed` before the text-only summary.
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells. ~$0.5.
 *
 * Pre-registered gate (decision BEFORE running):
 *   - REACHABILITY: v_proposed PASS ≥ 1/3 on at least one case (the probe can
 *     actually elicit timely completion-marking).
 *   - NO-REGRESSION: v_proposed PASS ≥ v_baseline PASS on BOTH cases.
 *   - SIGNAL: v_proposed > v_baseline on ≥1 case → directional lift.
 *   Decision: reachable AND no-regression → recommend 5-alias panel.
 *             any-case regression → investigate before panel (do NOT ship blind).
 *   Raw dump is self-judged by the orchestrating session (read the dump, audit
 *   ≥1 fail per cell against the structured toolCalls) per EVAL_GUIDELINES judge
 *   constraints.
 *
 * ## Run
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- todo-timeliness-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';
import type { KodaXToolDefinition, KodaXMessage } from '@kodax-ai/llm';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark, type PromptVariant } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'todo-timeliness-pilot',
);

// ark/v4flash + ark/v4pro (2 of the canonical 5) are unavailable — the
// ark-coding CodingPlan subscription is expired (400 InvalidSubscription).
// Panel falls back to the 3 available subscription-covered coding-plan
// aliases (kimi / zhipu / minimax — 3 independent families). Calls are
// subscription-covered (no marginal token bill). availableAliases() drops
// any whose key is absent.
const PILOT_PANEL: readonly ModelAlias[] = ['kimi', 'zhipu/glm52', 'mmx/m3'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {};
const RUNS_PER_CELL = 5;

// =====================================================================
// Tools — production bytes (anti-pattern 8). v_proposed = as-shipped;
// v_baseline reverts ONLY the A2 phrase on todo_update.
// =====================================================================

// Production todo_update description (current shipped bytes). The AFTER
// bullet below carries the A2 change; v_baseline reverts ONLY that phrase.
const TODO_UPDATE_INPUT_SCHEMA = {
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
    evaluator: { type: 'string', enum: ['build', 'test', 'lint'], description: 'Optional per-step deterministic evaluator.' },
  },
} as const;

const TODO_UPDATE_DESC_PROPOSED =
  'Drive the visible plan checklist so the user sees real-time progress — single-item PATCH plus status transition for ONE existing todo item. `op="update"` is the default (omit `op` for back-compat); target one item by `id` and change its status, patch its fields, or both in one call.\n\n'
  + '## When to Use This Tool\n\n'
  + '- BEFORE starting work on an item — flip it to `in_progress` and supply `activeForm` (present-continuous form of the subject; e.g. subject "Run failing tests" → activeForm "Running failing tests") so the spinner reflects what you are doing right now.\n'
  + '- AFTER finishing work on an item — flip it to `completed` before moving on, so the plan list stays current. If the item carries an `evaluator` hint, the runner runs the deterministic check on transition and surfaces stderr on failure.\n'
  + '- WHEN requirements clarify mid-task — patch `subject` and/or `description` to refine the row in place.\n'
  + '- WHEN an attempt clearly failed and needs retry — set status to `failed`.\n'
  + '- WHEN the item turned out to be unnecessary — set status to `skipped`.\n'
  + '- WHEN you decide mid-execution to drop an item the user no longer needs — set status to `cancelled` (UI shows strikethrough); use `deleted` if the item was wholly off-plan.\n\n'
  + '## When NOT to Use This Tool\n\n'
  + '- To ADD a new item — call `todo_create` instead. `todo_update` only mutates EXISTING items.\n'
  + '- When the item is already in the target status — a redundant update is a silent no-op.\n'
  + '- When uncertain about an item\'s current state — call `todo_get` first.\n'
  + '- `op="init"` is reserved for runner-side seeding only. LLMs should never call it.\n\n'
  + '## Status Transitions\n\n'
  + 'Only ONE item per owner should be `in_progress` at any time — finish or fail the current item before starting the next. Valid statuses: `in_progress`, `completed`, `failed`, `skipped`, `cancelled`, `deleted`.';

// A2 revert: baseline drops "before moving on, so the plan list stays current".
const TODO_UPDATE_DESC_BASELINE = TODO_UPDATE_DESC_PROPOSED.replace(
  'flip it to `completed` before moving on, so the plan list stays current. If the item carries',
  'flip it to `completed`. If the item carries',
);
if (TODO_UPDATE_DESC_BASELINE === TODO_UPDATE_DESC_PROPOSED) {
  throw new Error('A2 phrase revert produced no change — eval is stale vs the shipped wording');
}

const TODO_UPDATE_BASELINE: KodaXToolDefinition = {
  name: 'todo_update',
  description: TODO_UPDATE_DESC_BASELINE,
  input_schema: TODO_UPDATE_INPUT_SCHEMA,
};
const TODO_UPDATE_PROPOSED: KodaXToolDefinition = {
  name: 'todo_update',
  description: TODO_UPDATE_DESC_PROPOSED,
  input_schema: TODO_UPDATE_INPUT_SCHEMA,
};

const TODO_CREATE: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Insert ONE new pending item into the visible plan list — purely additive. The store auto-generates the id. Use one call per planned step, batched up front for a non-trivial multi-step task.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Brief imperative title.' },
      description: { type: 'string', description: 'Optional fuller context.' },
      activeForm: { type: 'string', description: 'Optional present-continuous form.' },
    },
    required: ['subject'],
  },
};

const TODO_LIST: KodaXToolDefinition = {
  name: 'todo_list',
  description: 'Read-only query that returns the current visible plan list as JSON. Never mutates the store.',
  input_schema: { type: 'object', properties: {} },
};

const TODO_GET: KodaXToolDefinition = {
  name: 'todo_get',
  description: 'Read-only single-item lookup. Returns the full TodoItem detail for one id.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The todo id to retrieve.' } },
    required: ['id'],
  },
};

const SHARED_WORK_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file from disk.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'edit',
    description: 'Edit a file by replacing old_string with new_string.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write',
    description: 'Write contents to a file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

const BASELINE_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE,
  TODO_UPDATE_BASELINE,
  TODO_LIST,
  TODO_GET,
  ...SHARED_WORK_TOOLS,
];
const PROPOSED_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE,
  TODO_UPDATE_PROPOSED,
  TODO_LIST,
  TODO_GET,
  ...SHARED_WORK_TOOLS,
];

// =====================================================================
// Worker prompt — PLAN-FIRST + HYGIENE shared; TERMINATION varies (A1).
// Byte-aligned to packages/coding/src/agents/worker-role-prompt.ts.
// =====================================================================

const PLAN_SECTIONS = [
  "You are the Worker — KodaX's single primary agent for this task.",
  '',
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (multiple distinct execution steps, or touching several files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`).',
  '- Mark exactly ONE item `in_progress` at a time.',
  '',
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  "- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first to read the item's CURRENT state. Runner-side auto-handlers can flip statuses between your turns.",
  '- BEFORE `todo_create` mid-task, scan the existing plan list (or call `todo_list`) and confirm no item with the same subject is already present.',
].join('\n');

const TERMINATION_BASELINE = [
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed` AND every dispatched child has produced its matching `<task-completed>` block, end your turn with a brief text-only summary covering what you did, what changed (files / behavior), and any caveats. No tool call needed to terminate — the absence of a `tool_use` block on your final assistant message IS the terminal signal.',
  '- If you cannot proceed (e.g. user-input blocker, irrecoverable failure), end your turn with a text-only summary of the blocker. Mark the affected plan items `failed` with a note BEFORE the final summary turn so the dashboard reflects the blocked state.',
].join('\n');

// A1: the new close-out bullet prepended under TERMINATION.
const TERMINATION_PROPOSED = [
  'TERMINATION:',
  '- Before writing that final summary, mark every finished item `completed` as your closing tool calls — this is the only way the plan reflects your progress in real time. The runner force-completes any still-open items on an accept verdict, but that correction is invisible to you and lands only after the user has already watched the list sit stale.',
  '- When all non-cancelled plan items are `completed` AND every dispatched child has produced its matching `<task-completed>` block, end your turn with a brief text-only summary covering what you did, what changed (files / behavior), and any caveats. No tool call needed to terminate — the absence of a `tool_use` block on your final assistant message IS the terminal signal.',
  '- If you cannot proceed (e.g. user-input blocker, irrecoverable failure), end your turn with a text-only summary of the blocker. Mark the affected plan items `failed` with a note BEFORE the final summary turn so the dashboard reflects the blocked state.',
].join('\n');

function systemPrompt(stateBlock: string, termination: string): string {
  const parts = stateBlock
    ? [PLAN_SECTIONS, '', stateBlock, '', termination]
    : [PLAN_SECTIONS, '', termination];
  return parts.join('\n');
}

// =====================================================================
// Cases — canned state embedded in the system prompt (drift-eval pattern).
// =====================================================================

const STATE_C1 = [
  'CURRENT STATE:',
  'Visible plan list:',
  '- todo_1 in_progress: Add `expiresAt` field to the User model',
  '- todo_2 pending: Write `daysUntilExpiry(user)` helper',
  '- todo_3 pending: Add unit tests for the helper',
  'You just successfully applied an `edit` to packages/auth/src/types.ts that added the `expiresAt` field. The real work for todo_1 is now finished; todo_2 has not been started.',
].join('\n');

// C2 is a Layer-3 choreographed probe for A1 (TERMINATION close-out). The
// single-turn C2 saturated at 0/0 on kimi because the model recons first
// (todo_get/todo_list) per PLAN-LIST HYGIENE, pushing the actual completion-
// marking to turn 2. Here the turn-1 recon (todo_list) is CANNED in
// priorMessages, so the model has fresh authoritative state and no reason to
// re-recon — isolating whether the A1 sentence makes it mark the finished
// items `completed` before the text-only summary.
const PRIOR_A1_RESYNC: readonly KodaXMessage[] = [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tc_resync', name: 'todo_list', input: {} }],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tc_resync',
        content: JSON.stringify({
          ok: true,
          count: 3,
          items: [
            { id: 'todo_1', subject: 'Add expiresAt field to the User model', status: 'completed' },
            { id: 'todo_2', subject: 'Write daysUntilExpiry(user) helper', status: 'in_progress' },
            { id: 'todo_3', subject: 'Add unit tests for the helper', status: 'pending' },
          ],
        }),
      },
    ],
  },
] as KodaXMessage[];

const C2_NUDGE =
  'You just re-synced the plan via todo_list (result above). All the actual implementation work is now finished: the daysUntilExpiry helper is written and its unit tests are written and passing (vitest is green). todo_2 and todo_3 are functionally done. Finish the task.';

interface CaseBundle {
  readonly id: string;
  /** System-prompt CURRENT STATE block; '' when the state lives in priorMessages. */
  readonly stateBlock: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage: string;
}

const CASES: readonly CaseBundle[] = [
  { id: 'mid_task_cadence', stateBlock: STATE_C1, userMessage: 'Continue.' },
  {
    id: 'termination_closeout_choreographed',
    stateBlock: '',
    priorMessages: PRIOR_A1_RESYNC,
    userMessage: C2_NUDGE,
  },
] as const;

// =====================================================================
// Judge — marks an item `completed` this turn (structured toolCall first,
// text fallback for models that emit tool calls as prose).
// =====================================================================

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

function inputMarksCompleted(input: unknown): boolean {
  return (
    typeof input === 'object'
    && input !== null
    && (input as { status?: unknown }).status === 'completed'
  );
}

function judgeMarksCompleted(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const structured = calls.filter((c) => c.name === 'todo_update' && inputMarksCompleted(c.input));
  if (structured.length >= 1) {
    return { passed: true };
  }
  // Text fallback: model emitted the call as prose AND named a completed status.
  if (invokesTool(out, 'todo_update') && /completed/i.test(out)) {
    return { passed: true, reason: 'narrative todo_update completed (text)' };
  }
  const names = calls.map((c) => c.name).join(', ') || 'none';
  return { passed: false, reason: `no todo_update→completed this turn; toolCalls=[${names}]` };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'marks_completed', category: 'correctness', judge: judgeMarksCompleted },
];

// =====================================================================
// Driver
// =====================================================================

describe('todo timeliness fix — pilot', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env (ark/v4flash)', () => {
      /* no-op — makes the skip visible */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants: readonly PromptVariant[] = [
          {
            id: 'v_baseline',
            description: 'pre-A1 TERMINATION + pre-A2 todo_update description',
            systemPrompt: systemPrompt(c.stateBlock, TERMINATION_BASELINE),
            tools: BASELINE_TOOLS,
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed',
            description: 'A1 close-out sentence + A2 "before moving on" cadence (as shipped)',
            systemPrompt: systemPrompt(c.stateBlock, TERMINATION_PROPOSED),
            tools: PROPOSED_TOOLS,
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
          },
        ];

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: JUDGES,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [`[todo-timeliness-pilot][${c.id}]`];
        for (const v of variants) {
          for (const cell of result.byVariant[v.id] ?? []) {
            const pass = cell.runsRaw.filter((r) => r.passed).length;
            lines.push(`  ${v.id.padEnd(11)} ${cell.alias.padEnd(14)} marks_completed=${pass}/${cell.runsRaw.length}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          dumpPath,
          JSON.stringify(
            {
              case: c.id,
              stage: 'todo-timeliness-pilot',
              startedAt: result.startedAt,
              userMessage: c.userMessage,
              variants: variants.map((v) => ({ id: v.id, description: v.description, systemPrompt: v.systemPrompt })),
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
                  judges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
                })),
              })),
            },
            null,
            2,
          ),
          'utf-8',
        );
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
