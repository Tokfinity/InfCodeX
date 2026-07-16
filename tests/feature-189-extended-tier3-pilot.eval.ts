/**
 * FEATURE_189-extended Tier 3 SAFE batch — Pilot Eval — 2026-05-25
 *
 * Verifies the Tier 3 SAFE batch of ADR-033 hygiene swaps doesn't
 * regress behavior on cases that exercise the modified sections.
 * Per Phase A audit (`c:/tmp/f189-extended-phase-a-audit.md`), Tier 3
 * is 11 SAFE violations across 5 files. The MED-severity changes that
 * could affect Worker behavior:
 *
 *   V3 — worker-role-prompt.ts:130-131 F0a/F0b label strip
 *   V4 — worker-role-prompt.ts:68 plan item compound split
 *   V5 — worker-role-prompt.ts:211 scope acquisition compound split
 *
 * (V16 / V17 / V20 / V25 / V26 / V28 / V29 are tool-description /
 * subordinate-role changes that don't affect Worker plan-first
 * behavior — covered by Phase A audit + tsc/unit tests only.)
 *
 * Pilot tests:
 *   C1 multi_step_implementation — does Worker still commit plan
 *      with todo_create on multi-step tasks?
 *   C2 change_review_audit       — does Worker still pull
 *      changed_scope first on review/audit framing? (V5 surface)
 *
 * Variants delivered as full production worker-role-prompt
 * byte-aligned with pre-Tier-3 vs post-Tier-3 state.
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells.
 * Estimated cost: ~$0.5.
 *
 * Pre-registered SHIP gate:
 *   A: Each case proposed ≥ baseline − 1 cell on its primary metric
 *      → Tier 3 batch ships as-is
 *   B: Any case proposed ≤ baseline − 2 cells → bisect to identify
 *      problematic V# and revert that one
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-extended-tier3-pilot
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
  'feature-189-extended-tier3-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// =====================================================================
// V_BASELINE — pre-Tier-3 worker-role-prompt PLAN-FIRST + REPO-INTEL
// + DISPATCH OBJECTIVE sections (byte-aligned 2026-05-24 pre-Tier-3)
// =====================================================================

const BASELINE_PLAN_FIRST = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (multiple distinct execution steps, or touching several files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema: `subject` REQUIRED + `activeForm` OPTIONAL.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_create` AT THAT MOMENT.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const BASELINE_DISPATCH_OBJECTIVE = [
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): when writing a child\'s `objective`, prefer stating the goal abstractly.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT, briefly note the recommended pull-tool family.',
].join('\n');

const BASELINE_CHANGE_REVIEW = [
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes", "check diff", or "what changed since X": your first scope-acquisition tool MUST be `changed_scope` (one call), followed by `changed_diff_bundle(paths[])` for the files you need to read.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

// =====================================================================
// V_PROPOSED — post-Tier-3 (V3 + V4 + V5 applied)
// =====================================================================

const PROPOSED_PLAN_FIRST = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (multiple distinct execution steps, or touching several files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema: `subject` REQUIRED + `activeForm` OPTIONAL.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_create` AT THAT MOMENT.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`).',
  '- Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const PROPOSED_DISPATCH_OBJECTIVE = [
  '- DISPATCH OBJECTIVE QUALITY: when writing a child\'s `objective`, prefer stating the goal abstractly.',
  '- DISPATCH OBJECTIVE GUIDANCE: WHEN RELEVANT, briefly note the recommended pull-tool family.',
].join('\n');

const PROPOSED_CHANGE_REVIEW = [
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes", "check diff", or "what changed since X": your first scope-acquisition tool MUST be `changed_scope` (one call).',
  '- Follow with `changed_diff_bundle(paths[])` to read the specific files surfaced by `changed_scope`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

function buildSystemPrompt(opts: { proposed: boolean }): string {
  const planFirst = opts.proposed ? PROPOSED_PLAN_FIRST : BASELINE_PLAN_FIRST;
  const dispatch = opts.proposed ? PROPOSED_DISPATCH_OBJECTIVE : BASELINE_DISPATCH_OBJECTIVE;
  const review = opts.proposed ? PROPOSED_CHANGE_REVIEW : BASELINE_CHANGE_REVIEW;
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    planFirst,
    '',
    'DISPATCH RULES:',
    dispatch,
    '',
    review,
    '',
    'TERMINATION:',
    '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary.',
  ].join('\n');
}

// =====================================================================
// Tool definitions — current production todo_create + changed_scope +
// changed_diff_bundle + dispatch_child_task per anti-pattern 8
// =====================================================================

const TODO_CREATE_TOOL: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Insert ONE new pending item into the visible plan list — purely additive, existing items untouched.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      activeForm: { type: 'string' },
    },
    required: ['subject'],
  },
};

const CHANGED_SCOPE_TOOL: KodaXToolDefinition = {
  name: 'changed_scope',
  description:
    'List of changed files in current git state, with area/category labels. Use as first scope-acquisition step for any review / audit / change-diff task.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const CHANGED_DIFF_BUNDLE_TOOL: KodaXToolDefinition = {
  name: 'changed_diff_bundle',
  description:
    'Paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  input_schema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of file paths to diff (from changed_scope output).',
      },
    },
    required: ['paths'],
  },
};

const SHARED_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE_TOOL,
  CHANGED_SCOPE_TOOL,
  CHANGED_DIFF_BUNDLE_TOOL,
  {
    name: 'read',
    description: 'Read a file from disk.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
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

const USER_MESSAGE_C1_MULTI_STEP =
  'Refactor the User authentication flow: '
  + '(1) extract token validation into a separate `validateToken(token)` helper in `packages/auth/src/token.ts`; '
  + '(2) update `loginHandler` in `packages/auth/src/login.ts` to call the new helper; '
  + '(3) add unit tests for `validateToken` covering valid / expired / malformed cases.';

const USER_MESSAGE_C2_REVIEW =
  'Review the changes I made on this branch — what changed and is it ready to commit?';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly judgeKind: 'plan_first' | 'changed_scope_first';
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'multi_step_implementation',
    userMessage: USER_MESSAGE_C1_MULTI_STEP,
    judgeKind: 'plan_first',
  },
  {
    id: 'change_review_audit',
    userMessage: USER_MESSAGE_C2_REVIEW,
    judgeKind: 'changed_scope_first',
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
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

function judgePlanFirstMultiStep(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const todoCreateCalls = toolCalls.filter((t) => t.name === 'todo_create');
  if (todoCreateCalls.length >= 2) return { passed: true };
  if (todoCreateCalls.length === 1) {
    return { passed: false, reason: 'only 1 todo_create — multi-step needs batched plan-first' };
  }
  if (invokesTool(out, 'todo_create')) return { passed: true, reason: 'narrative todo_create (text)' };
  return { passed: false, reason: 'no todo_create invoked' };
}

function judgeChangedScopeFirst(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const changedScopeIdx = toolCalls.findIndex((t) => t.name === 'changed_scope');
  const bashIdx = toolCalls.findIndex((t) => t.name === 'bash' && /git\s+diff|git\s+log/i.test(
    typeof t.input === 'object' && t.input && 'command' in t.input
      ? String((t.input as { command?: string }).command ?? '')
      : '',
  ));
  if (changedScopeIdx >= 0 && (bashIdx < 0 || changedScopeIdx < bashIdx)) return { passed: true };
  if (changedScopeIdx >= 0) {
    return { passed: false, reason: 'changed_scope called but bash git diff was first' };
  }
  if (invokesTool(out, 'changed_scope')) return { passed: true, reason: 'narrative changed_scope (text)' };
  return { passed: false, reason: 'no changed_scope invoked for review/audit task' };
}

const JUDGES_PLAN_FIRST: readonly PromptJudge[] = [
  { name: 'plan_first_multi_step', category: 'correctness', judge: judgePlanFirstMultiStep },
];

const JUDGES_CHANGED_SCOPE: readonly PromptJudge[] = [
  { name: 'changed_scope_first', category: 'correctness', judge: judgeChangedScopeFirst },
];

// =====================================================================
// Driver
// =====================================================================

describe('FEATURE_189-extended Tier 3 SAFE batch — pilot', () => {
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
            id: 'v_baseline_pre_tier3',
            description: 'pre-Tier-3 worker-role-prompt (PLAN-FIRST + DISPATCH OBJECTIVE + CHANGE-REVIEW byte-aligned 2026-05-24 pre-batch)',
            systemPrompt: buildSystemPrompt({ proposed: false }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_post_tier3',
            description: 'post-Tier-3 worker-role-prompt (V3 + V4 + V5 applied: F0a/F0b stripped, plan-item compound split, scope-acquisition compound split)',
            systemPrompt: buildSystemPrompt({ proposed: true }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges = c.judgeKind === 'plan_first' ? JUDGES_PLAN_FIRST : JUDGES_CHANGED_SCOPE;
        const judgeName = c.judgeKind === 'plan_first' ? 'plan_first_multi_step' : 'changed_scope_first';

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-189-extended-tier3-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_pre_tier3', 'v_proposed_post_tier3']) {
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
          stage: 'feature-189-extended-tier3-pilot',
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
