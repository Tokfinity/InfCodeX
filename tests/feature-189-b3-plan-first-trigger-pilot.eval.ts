/**
 * FEATURE_189 B.3 PLAN-FIRST TRIGGER quant→qual — Pilot Eval — 2026-05-24
 *
 * Tests whether swapping the quantitative threshold in worker-role-prompt
 * PLAN-FIRST CONTRACT from `≥2 distinct execution steps OR touching ≥2
 * files / areas / feature threads` to qualitative `multiple distinct
 * execution steps, or touching several files / areas / feature threads`
 * regresses plan-first triggering behavior. ADR-033 §1
 * "qualitative criteria over quantitative thresholds" applied to the
 * last remaining quant threshold in worker-role-prompt PLAN-FIRST block.
 *
 * Variants delivered to provider via system prompt (worker-role-prompt
 * PLAN-FIRST CONTRACT byte-aligned current production, only line-61
 * differs):
 *   v_baseline_quantitative — current production with `≥2 ... OR ≥2 ...`
 *   v_proposed_qualitative  — new line with `multiple ... or several ...`
 *
 * Cases:
 *   C1 clear_multi_step  — task with 3+ clearly distinct execution
 *      steps across multiple files. Expects todo_create batch (no
 *      under-triggering with qualitative criteria).
 *   C2 single_trivial    — single-line variable rename in one file.
 *      Expects NO todo_create (no over-triggering — qualitative
 *      "multiple" should not lead model to plan trivial work).
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells.
 * Estimated cost: ~$0.5.
 *
 * Pre-registered SHIP gate (decision-matrix):
 *   A (multi-step):  v_proposed plan-first ≥ v_baseline − 1 cell
 *   B (trivial):     v_proposed false-positive todo_create
 *                    ≤ v_baseline + 1 cell
 *   Both A AND B met → SHIP (per `feedback_eval_panel_floor_saturation`
 *   + EVAL_GUIDELINES anti-pattern 9; behavioral-neutral hygiene
 *   refactor, no panel needed if pilot non-regression confirmed)
 *   Either fails → DROP swap, restore quantitative threshold
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b3-plan-first-trigger-pilot
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
  'feature-189-b3-plan-first-trigger-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// =====================================================================
// PRODUCTION WORKER PROMPT (byte-aligned worker-role-prompt.ts 2026-05-24)
// — only PLAN-FIRST CONTRACT line 61 differs between variants
// =====================================================================

const PLAN_FIRST_LINE_BASELINE =
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.';

const PLAN_FIRST_LINE_PROPOSED =
  '- Non-trivial tasks (multiple distinct execution steps, or touching several files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.';

function buildSystemPrompt(planFirstLine: string): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
    '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
    planFirstLine,
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
}

// =====================================================================
// Tool definitions (current production todo_* descriptions per
// EVAL_GUIDELINES anti-pattern 8 — tool desc layered shipped 2026-05-24)
// =====================================================================

const TODO_CREATE_TOOL: KodaXToolDefinition = {
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
    + 'Returns `{ok: true, id: "todo_<n>"}` on success or `{ok: false, reason: "..."}` when the store is not wired, validation fails, or an extension hook blocks the create.',
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

const SHARED_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE_TOOL,
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

// =====================================================================
// User messages
// =====================================================================

const USER_MESSAGE_C1_CLEAR_MULTI_STEP =
  'Refactor the User authentication flow: '
  + '(1) extract token validation into a separate `validateToken(token)` helper in `packages/auth/src/token.ts`; '
  + '(2) update `loginHandler` in `packages/auth/src/login.ts` to call the new helper; '
  + '(3) add unit tests for `validateToken` covering valid / expired / malformed cases.';

const USER_MESSAGE_C2_TRIVIAL =
  'Rename the variable `usrName` to `userName` in `packages/auth/src/login.ts` at line 42 — that\'s the only occurrence, it\'s a one-line change.';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly expectsTodoCreate: boolean;
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'clear_multi_step',
    userMessage: USER_MESSAGE_C1_CLEAR_MULTI_STEP,
    expectsTodoCreate: true,
  },
  {
    id: 'single_trivial',
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

describe('FEATURE_189 B.3 PLAN-FIRST TRIGGER quant→qual — pilot', () => {
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
            id: 'v_baseline_quantitative',
            description: 'current production "≥2 distinct execution steps OR touching ≥2 files / areas / feature threads"',
            systemPrompt: buildSystemPrompt(PLAN_FIRST_LINE_BASELINE),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_qualitative',
            description: 'qualitative swap "multiple distinct execution steps, or touching several files / areas / feature threads"',
            systemPrompt: buildSystemPrompt(PLAN_FIRST_LINE_PROPOSED),
            tools: SHARED_TOOLS,
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
        lines.push(`[feature-189-b3-plan-first-trigger-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_quantitative', 'v_proposed_qualitative']) {
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
          stage: 'feature-189-b3-plan-first-trigger-pilot',
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
