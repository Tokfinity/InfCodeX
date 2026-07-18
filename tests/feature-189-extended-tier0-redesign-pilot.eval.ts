/**
 * FEATURE_189-extended Tier 0 case redesign pilot — 2026-05-25
 *
 * Per user feedback: "v0.7.43 早期跑过 eval 之后，我们做了非常多改动，
 * 重新设计案例再做一下试试" — the 2026-05-22 B.4 (RULE A/B/C labels)
 * and B.5 (FEATURE_xxx vX.Y.Z version metadata) eval-driven DROPs were
 * decided under a substrate that has since shifted significantly:
 *
 *   - F189 Batch 1 (✗ + WHY) added clauses
 *   - F189 Batch 4 (quant→qual) dropped 8 thresholds
 *   - F189 Batch 5 (child-executor prompt)
 *   - B.3 (PLAN-FIRST trigger quant→qual)
 *   - F189-extended Tier 3 (V3 F0a/F0b strip + V4 V5 compound splits +
 *     V16 V17 V20 V25 V26 V28 V29 WHY additions)
 *   - F189-extended Tier 4 (write/edit/multi_edit/bash layered)
 *   - F190 (TERMINATION cleanup)
 *   - F191 (specialist routing)
 *
 * The DROP rationale at decision time:
 *   B.4: ark/v4flash 5/5 textLen <220 systematic regression on C4 when
 *        RULE A/B/C labels removed.
 *   B.5: zhipu/glm52 -2pf -2dp + ark/v4pro -2pf when version metadata
 *        stripped (mid-tier model attention anchors).
 *
 * Under current substrate, this pilot tests whether those regressions
 * still reproduce. Per EVAL_GUIDELINES anti-pattern 10 (DROP recheck
 * after substrate change is mandatory before re-relying on archived
 * evidence) — and the original recheck (commit c4d5be1e) reused the
 * 2026-05-22 cases verbatim. THIS pilot redesigns cases to exercise
 * dispatch + version-anchor decisions under current production sections
 * (specialist routing, qualitative thresholds, layered tool descriptions).
 *
 * Variants — ALL byte-aligned current production EXCEPT the targeted change:
 *   B.4 sub-block:
 *     v_baseline_with_rule_labels   — current prod (line 121-123 RULE A/B/C)
 *     v_proposed_no_rule_labels     — RULE labels stripped, informal use cases
 *
 *   B.5 sub-block:
 *     v_baseline_with_version_meta  — current prod (11 (FEATURE_xxx vX.Y.Z))
 *     v_proposed_no_version_meta    — all version parentheticals stripped
 *
 * Cases (redesigned for current substrate):
 *   C1 fan_out_specialist_overlap — task could be fan-out OR specialist
 *      routing (F191 specialist registry exists). Tests whether RULE
 *      labels are load-bearing when alternative routing exists.
 *   C2 write_fan_out_clear        — clear write fan-out task (3 modules,
 *      non-conflicting). Tests RULE C specifically (the write fan-out
 *      branch B.4 focused on).
 *   C3 version_anchor_navigation  — long task requiring model to
 *      reference multiple prompt sections (DISPATCH RULES + FAN-OUT
 *      PLAN GRANULARITY + REPO INTELLIGENCE). Tests B.5 — does removing
 *      version parentheticals break model's ability to navigate sections?
 *
 * 1 alias (ark/v4flash for B.4, zhipu/glm52 for B.5) × 3 case × 2 variant
 * × 3 runs = 18 cells per sub-block (~$0.6 each, ~$1.2 total).
 *
 * Pre-registered SHIP gate (sub-block independent):
 *   B.4: ark/v4flash proposed C1+C2+C3 per-case ≥ baseline − 1 cell
 *        → revisit B.4 DROP (escalate to 5-alias panel)
 *   B.5: zhipu/glm52 proposed per-case ≥ baseline − 1 cell + ark/v4pro
 *        cross-check → revisit B.5 DROP
 *   If pilot shows clear regression under current substrate → DROP holds
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-extended-tier0-redesign-pilot
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
  'feature-189-extended-tier0-redesign-pilot',
);

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
  'ark/v4pro': 'ds/v4pro',
};

const RUNS_PER_CELL = 3;

// =====================================================================
// PRODUCTION WORKER PROMPT — current 2026-05-25 (post Tier 3+4)
// =====================================================================

const DISPATCH_RULES_BASELINE = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

const DISPATCH_RULES_NO_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- For multiple independent investigations (e.g. probing several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- For a single investigation that will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- For non-conflicting file-level edits across multiple modules (write fan-out, Generator-equivalent only), dispatch them as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- When a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

// All 11 version-metadata parentheticals stripped
const PLAN_FIRST_WITH_VERSIONS =
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):';
const PLAN_FIRST_NO_VERSIONS = 'PLAN-FIRST CONTRACT:';

const PLAN_LIST_HYGIENE_WITH = 'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):';
const PLAN_LIST_HYGIENE_NO = 'PLAN-LIST HYGIENE (staleness + dedup):';

const SCOPE_WITH = 'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):';
const SCOPE_NO = 'SCOPE COMMITMENT:';

const DISPATCH_HEADER_WITH = 'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):';
const DISPATCH_HEADER_NO = 'DISPATCH RULES (`dispatch_child_task` — idle-yield model):';

const REPO_INTEL_WITH = 'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):';
const REPO_INTEL_NO = 'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):';

const CHANGE_REVIEW_WITH = 'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):';
const CHANGE_REVIEW_NO = 'CHANGE-REVIEW POSITIVE REFRAME (review-specific):';

function buildSystemPrompt(opts: {
  ruleLabels: boolean;
  versionMeta: boolean;
}): string {
  const planFirst = opts.versionMeta ? PLAN_FIRST_WITH_VERSIONS : PLAN_FIRST_NO_VERSIONS;
  const hygiene = opts.versionMeta ? PLAN_LIST_HYGIENE_WITH : PLAN_LIST_HYGIENE_NO;
  const scope = opts.versionMeta ? SCOPE_WITH : SCOPE_NO;
  const dispatchHeader = opts.versionMeta ? DISPATCH_HEADER_WITH : DISPATCH_HEADER_NO;
  const repoIntel = opts.versionMeta ? REPO_INTEL_WITH : REPO_INTEL_NO;
  const changeReview = opts.versionMeta ? CHANGE_REVIEW_WITH : CHANGE_REVIEW_NO;

  const dispatchRules = opts.ruleLabels
    ? DISPATCH_RULES_BASELINE.replace(DISPATCH_HEADER_WITH, dispatchHeader)
    : DISPATCH_RULES_NO_LABELS.replace(DISPATCH_HEADER_WITH, dispatchHeader);

  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    planFirst,
    '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
    '- Non-trivial tasks (multiple distinct execution steps, or touching several files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
    '',
    hygiene,
    '- BEFORE `todo_update` on stale items, call `todo_get(id)` first.',
    '',
    scope,
    '- Whatever scope you commit to in your first batch of `todo_create` is your contract.',
    '',
    repoIntel,
    '- `module_context(target)` — compact module capsule.',
    '- `changed_scope()` — list of changed files.',
    '- `changed_diff_bundle(paths[])` — paged diff for review tasks.',
    '',
    dispatchRules,
    '',
    changeReview,
    '- For ANY task framed as "review", "audit", "compare changes": first scope-acquisition tool MUST be `changed_scope`.',
    '- Follow with `changed_diff_bundle(paths[])` to read the surfaced files.',
    '',
    'Available specialist agents:',
    '- `code-reviewer` (description: "review code changes for quality + security")',
    '- `test-generator` (description: "generate unit tests for a given file or function")',
  ].join('\n');
}

// =====================================================================
// Tools — current production todo_create + dispatch_child_task + repo-intel
// =====================================================================

const TODO_CREATE_TOOL: KodaXToolDefinition = {
  name: 'todo_create',
  description: 'Insert ONE new pending item into the visible plan list.',
  input_schema: {
    type: 'object',
    properties: { subject: { type: 'string' } },
    required: ['subject'],
  },
};

const DISPATCH_CHILD_TASK_TOOL: KodaXToolDefinition = {
  name: 'dispatch_child_task',
  description: 'Launch a child task with its own LLM context.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      objective: { type: 'string' },
      readOnly: { type: 'boolean' },
      subagent_type: { type: 'string', description: 'Optional specialist agent name.' },
    },
    required: ['id', 'objective'],
  },
};

const SHARED_TOOLS: readonly KodaXToolDefinition[] = [
  TODO_CREATE_TOOL,
  DISPATCH_CHILD_TASK_TOOL,
  {
    name: 'changed_scope',
    description: 'List changed files in current git state.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'module_context',
    description: 'Compact module capsule.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
  {
    name: 'read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

// =====================================================================
// Redesigned cases
// =====================================================================

const USER_MESSAGE_C1_FAN_OUT_SPECIALIST =
  'Review the changes I made to the auth package on this branch. Specifically I want '
  + 'a quality + security review of `packages/auth/src/login.ts`, `packages/auth/src/token.ts`, '
  + 'and `packages/auth/src/middleware.ts`. Use whatever approach works best.';

const USER_MESSAGE_C2_WRITE_FAN_OUT =
  'I have 3 independent README files to update across these unrelated modules: '
  + 'packages/auth/README.md (add a "Quick Start" section), '
  + 'packages/api/README.md (add an "API Reference" link), and '
  + 'packages/web/README.md (add a "Browser Compatibility" note). '
  + 'The 3 modules have no shared code; each README is independent.';

const USER_MESSAGE_C3_NAVIGATION =
  'I want to understand what changed in packages/auth + packages/api on this branch, '
  + 'then refactor the shared logging utility to use the new structured-logger pattern. '
  + 'Walk me through the changes first, then plan the refactor.';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly judgeKind: 'fan_out_or_specialist' | 'write_fan_out' | 'multi_section';
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'fan_out_specialist_overlap',
    userMessage: USER_MESSAGE_C1_FAN_OUT_SPECIALIST,
    judgeKind: 'fan_out_or_specialist',
  },
  {
    id: 'write_fan_out_clear',
    userMessage: USER_MESSAGE_C2_WRITE_FAN_OUT,
    judgeKind: 'write_fan_out',
  },
  {
    id: 'multi_section_navigation',
    userMessage: USER_MESSAGE_C3_NAVIGATION,
    judgeKind: 'multi_section',
  },
] as const;

// =====================================================================
// Judges
// =====================================================================

function judgeFanOutOrSpecialist(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const dispatches = toolCalls.filter((t) => t.name === 'dispatch_child_task');
  if (dispatches.length === 0) {
    return { passed: false, reason: 'no dispatch_child_task — fan-out or specialist routing expected' };
  }
  // Either readOnly fan-out OR specialist routing is acceptable
  return { passed: true };
}

function judgeWriteFanOut(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const writeDispatches = toolCalls.filter(
    (t) => t.name === 'dispatch_child_task'
      && typeof t.input === 'object'
      && t.input !== null
      && 'readOnly' in t.input
      && (t.input as { readOnly?: boolean }).readOnly === false,
  );
  if (writeDispatches.length >= 2) return { passed: true };
  // Also accept any dispatch_child_task (even without explicit readOnly:false)
  const dispatches = toolCalls.filter((t) => t.name === 'dispatch_child_task');
  if (dispatches.length >= 2) return { passed: true, reason: 'multiple dispatches (readOnly not explicit)' };
  return { passed: false, reason: `only ${dispatches.length} dispatch — write fan-out for 3 modules expected` };
}

function judgeMultiSection(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  // Multi-section navigation expects: changed_scope first (for "what changed")
  // then plan (todo_create for refactor steps)
  const csIdx = toolCalls.findIndex((t) => t.name === 'changed_scope');
  const todoIdx = toolCalls.findIndex((t) => t.name === 'todo_create');
  if (csIdx >= 0) return { passed: true };
  if (todoIdx >= 0) return { passed: true, reason: 'todo_create before changed_scope (still ok per substrate)' };
  return { passed: false, reason: 'neither changed_scope nor todo_create invoked' };
}

const JUDGES_FAN_OUT_SPECIALIST: readonly PromptJudge[] = [
  { name: 'fan_out_or_specialist', category: 'correctness', judge: judgeFanOutOrSpecialist },
];

const JUDGES_WRITE_FAN_OUT: readonly PromptJudge[] = [
  { name: 'write_fan_out', category: 'correctness', judge: judgeWriteFanOut },
];

const JUDGES_MULTI_SECTION: readonly PromptJudge[] = [
  { name: 'multi_section', category: 'correctness', judge: judgeMultiSection },
];

// =====================================================================
// Driver — split into 2 sub-blocks (B.4 RULE labels + B.5 version metadata)
// =====================================================================

describe('FEATURE_189-extended Tier 0 redesign pilot — B.4 RULE labels', () => {
  const aliases = availableAliases('ark/v4flash');

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => {
      /* no-op */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — B.4 RULE labels pilot — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_with_rule_labels',
            description: 'current production worker prompt WITH RULE A/B/C labels',
            systemPrompt: buildSystemPrompt({ ruleLabels: true, versionMeta: true }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_rule_labels',
            description: 'RULE A/B/C labels removed (informal use-case bullets, same content)',
            systemPrompt: buildSystemPrompt({ ruleLabels: false, versionMeta: true }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges =
          c.judgeKind === 'fan_out_or_specialist' ? JUDGES_FAN_OUT_SPECIALIST
          : c.judgeKind === 'write_fan_out' ? JUDGES_WRITE_FAN_OUT
          : JUDGES_MULTI_SECTION;
        const judgeName =
          c.judgeKind === 'fan_out_or_specialist' ? 'fan_out_or_specialist'
          : c.judgeKind === 'write_fan_out' ? 'write_fan_out'
          : 'multi_section';

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[tier0-b4-redesign][${c.id}]`);
        for (const variantId of ['v_baseline_with_rule_labels', 'v_proposed_no_rule_labels']) {
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
        writeFileSync(
          join(DUMP_ROOT, `b4-${c.id}.json`),
          JSON.stringify({
            case: c.id,
            subBlock: 'B.4-rule-labels',
            variants: variants.map((v) => ({ id: v.id, systemPrompt: v.systemPrompt, userMessage: v.userMessage })),
            cells: result.cells.map((cell) => ({
              alias: cell.alias,
              variantId: cell.variantId,
              runs: cell.runsRaw.map((run) => ({
                runIndex: run.runIndex,
                text: run.text,
                toolCalls: run.toolCalls,
                error: run.error,
                fallbackUsed: run.fallbackUsed,
                regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
              })),
            })),
          }, null, 2),
          'utf-8',
        );
      },
    );
  }
});

describe('FEATURE_189-extended Tier 0 redesign pilot — B.5 version metadata', () => {
  const aliases = availableAliases('zhipu/glm52');

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => {
      /* no-op */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — B.5 version meta pilot — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_with_version_meta',
            description: 'current production worker prompt WITH (FEATURE_xxx vX.Y.Z) parentheticals',
            systemPrompt: buildSystemPrompt({ ruleLabels: true, versionMeta: true }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_version_meta',
            description: 'All (FEATURE_xxx vX.Y.Z) parentheticals stripped from section headers',
            systemPrompt: buildSystemPrompt({ ruleLabels: true, versionMeta: false }),
            tools: SHARED_TOOLS,
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges =
          c.judgeKind === 'fan_out_or_specialist' ? JUDGES_FAN_OUT_SPECIALIST
          : c.judgeKind === 'write_fan_out' ? JUDGES_WRITE_FAN_OUT
          : JUDGES_MULTI_SECTION;
        const judgeName =
          c.judgeKind === 'fan_out_or_specialist' ? 'fan_out_or_specialist'
          : c.judgeKind === 'write_fan_out' ? 'write_fan_out'
          : 'multi_section';

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[tier0-b5-redesign][${c.id}]`);
        for (const variantId of ['v_baseline_with_version_meta', 'v_proposed_no_version_meta']) {
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
        writeFileSync(
          join(DUMP_ROOT, `b5-${c.id}.json`),
          JSON.stringify({
            case: c.id,
            subBlock: 'B.5-version-metadata',
            variants: variants.map((v) => ({ id: v.id, systemPrompt: v.systemPrompt, userMessage: v.userMessage })),
            cells: result.cells.map((cell) => ({
              alias: cell.alias,
              variantId: cell.variantId,
              runs: cell.runsRaw.map((run) => ({
                runIndex: run.runIndex,
                text: run.text,
                toolCalls: run.toolCalls,
                error: run.error,
                fallbackUsed: run.fallbackUsed,
                regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
              })),
            })),
          }, null, 2),
          'utf-8',
        );
      },
    );
  }
});
