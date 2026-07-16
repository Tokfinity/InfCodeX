/**
 * Pilot — FEATURE_189 B.5 version-header cleanup.
 *
 * 1 alias (ark/v4flash, cheapest coding-plan floor model) × 2 case × 2
 * variant × 3 runs = 12 cells, ~$0.30, ~5 min wall.
 *
 * Purpose per `feedback_eval_pilot_before_scale`: verify that v_baseline +
 * v_proposed both trigger dispatch behavior on these cases before scaling
 * to the canonical 5-alias panel. Re-uses the full Worker system prompt
 * shape from the companion panel driver to ensure the version-metadata
 * strip is the only variable.
 *
 * If pilot shows BOTH variants have 0/3 dispatch on a case → the case
 * doesn't exercise the dispatch path → must rewrite case before panel.
 * If pilot shows clear signal (≥1/3 dispatch) → proceed to panel.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b5-version-header-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-b5-version-header-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

const TOOL_DOCS = [
  'Tools you have on this turn:',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly?:boolean (default true), model_hint?:"fast"|"deep"|"balanced" }',
  '',
  '`todo_create`:',
  '  Input:  { subject:string, activeForm:string, description?:string, evaluator?:"build"|"test"|"lint" }',
  '',
  '`todo_update`:',
  '  Input:  { id:string, subject?:string, description?:string, activeForm?:string, status?:string, note?:string }',
  '',
  '`todo_get`:',
  '  Input:  { id:string }',
  '',
  '`emit_handoff`:',
  '  Input:  { artifacts:string[], note?:string }',
  '',
  '`module_context` / `symbol_context` / `impact_estimate` / `process_context` /',
  '`repo_overview` / `changed_scope` / `changed_diff_bundle` / `changed_diff`: repo-intel pull tools.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit` / `multi_edit`: standard tools.',
].join('\n');

const PLAN_FIRST_WITH_VERSIONS = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (v0.7.42, mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (≤80 chars).',
  '    * `description` — OPTIONAL. Fuller context read when you pick up the item later.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly.',
  '- Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const PLAN_FIRST_NO_VERSIONS = [
  'PLAN-FIRST CONTRACT:',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (≤80 chars).',
  '    * `description` — OPTIONAL. Fuller context read when you pick up the item later.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly.',
  '- Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const PLAN_LIST_HYGIENE_WITH_VERSIONS = [
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first to read the item\'s CURRENT state.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list and confirm no item with the same subject is already present.',
].join('\n');

const PLAN_LIST_HYGIENE_NO_VERSIONS = [
  'PLAN-LIST HYGIENE (staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first to read the item\'s CURRENT state.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list and confirm no item with the same subject is already present.',
].join('\n');

const SCOPE_COMMITMENT_WITH_VERSIONS = [
  'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '- If the user request is review/audit, your initial plan IS the visible review report skeleton.',
].join('\n');

const SCOPE_COMMITMENT_NO_VERSIONS = [
  'SCOPE COMMITMENT:',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '- If the user request is review/audit, your initial plan IS the visible review report skeleton.',
].join('\n');

const DISPATCH_RULES_WITH_VERSIONS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- Read-only fan-out: when you need multiple independent investigations, launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while, dispatch as a child and continue with other tools while it runs.',
  '- Write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children.',
  '- IDLE-YIELD: after `dispatch_child_task` returns a `task_id:<id>`, do interleaved work; when out of useful work AND children still in flight, end your turn with ONE short status sentence and NO tool calls.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report exceeds the inline envelope budget (~50KB), the `<task-completed>` banner contains a preview + a marker pointing at the spilled file. Read the spilled file only when the preview is insufficient.',
  '- MODEL HINT (optional, FEATURE_120 v0.7.39): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class. Routing is a no-op today but the hint is recorded for FEATURE_102 (v0.7.45).',
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): when writing a child\'s `objective`, prefer stating the goal abstractly. If you need to convey a specific git revision (e.g., v0.7.39..HEAD), state it as data ("scope: v0.7.39..HEAD") rather than a command directive.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT (review / change-audit / module-exploration objectives), briefly note the recommended pull-tool family in the objective.',
].join('\n');

const DISPATCH_RULES_NO_VERSIONS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model):',
  '- Read-only fan-out: when you need multiple independent investigations, launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while, dispatch as a child and continue with other tools while it runs.',
  '- Write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children.',
  '- IDLE-YIELD: after `dispatch_child_task` returns a `task_id:<id>`, do interleaved work; when out of useful work AND children still in flight, end your turn with ONE short status sentence and NO tool calls.',
  '- LARGE CHILD OUTPUT: when a child\'s report exceeds the inline envelope budget (~50KB), the `<task-completed>` banner contains a preview + a marker pointing at the spilled file. Read the spilled file only when the preview is insufficient.',
  '- MODEL HINT (optional): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class. Routing is a no-op today but the hint is recorded for future routing.',
  '- DISPATCH OBJECTIVE QUALITY: when writing a child\'s `objective`, prefer stating the goal abstractly. If you need to convey a specific git revision (e.g., v0.7.39..HEAD), state it as data ("scope: v0.7.39..HEAD") rather than a command directive.',
  '- DISPATCH OBJECTIVE GUIDANCE: WHEN RELEVANT (review / change-audit / module-exploration objectives), briefly note the recommended pull-tool family in the objective.',
].join('\n');

const ASYNC_STEERING_WITH_VERSIONS = [
  'ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — `send_message` + `task_stop`):',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. Use SPARINGLY.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully.',
].join('\n');

const ASYNC_STEERING_NO_VERSIONS = [
  'ASYNC CHILD STEERING (`send_message` + `task_stop`):',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. Use SPARINGLY.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully.',
].join('\n');

const REPO_INTEL_WITH_VERSIONS = [
  'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs.',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate.',
  '- `changed_scope()` — list of changed files in current git state.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes": your first scope-acquisition tool MUST be `changed_scope`, followed by `changed_diff_bundle(paths[])`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

const REPO_INTEL_NO_VERSIONS = [
  'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs.',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate.',
  '- `changed_scope()` — list of changed files in current git state.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes": your first scope-acquisition tool MUST be `changed_scope`, followed by `changed_diff_bundle(paths[])`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

const FAN_OUT_PLAN_GRANULARITY = [
  'FAN-OUT PLAN GRANULARITY:',
  '- When you are about to dispatch several children in parallel, first emit a `todo_create` call for each one so the user sees per-child progress instead of a 30-60s black box. One todo per child — use the child\'s objective as the subject.',
  '- Mark each item `in_progress` just before its `dispatch_child_task` call, and `completed` when the matching `<task-completed>` block arrives.',
  '- If mid fan-out you decide to dispatch another child, add the matching todo before the new dispatch.',
].join('\n');

const HANDOFF_RULES = [
  'EVALUATOR HANDOFF:',
  '- When your plan is complete (all non-cancelled items `completed`), call `emit_handoff` with the artifacts you want the Evaluator to audit.',
].join('\n');

function buildSystemPrompt(withVersions: boolean): string {
  const planFirst = withVersions ? PLAN_FIRST_WITH_VERSIONS : PLAN_FIRST_NO_VERSIONS;
  const hygiene = withVersions ? PLAN_LIST_HYGIENE_WITH_VERSIONS : PLAN_LIST_HYGIENE_NO_VERSIONS;
  const scope = withVersions ? SCOPE_COMMITMENT_WITH_VERSIONS : SCOPE_COMMITMENT_NO_VERSIONS;
  const dispatch = withVersions ? DISPATCH_RULES_WITH_VERSIONS : DISPATCH_RULES_NO_VERSIONS;
  const steering = withVersions ? ASYNC_STEERING_WITH_VERSIONS : ASYNC_STEERING_NO_VERSIONS;
  const repoIntel = withVersions ? REPO_INTEL_WITH_VERSIONS : REPO_INTEL_NO_VERSIONS;
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    planFirst,
    '',
    hygiene,
    '',
    scope,
    '',
    repoIntel,
    '',
    dispatch,
    '',
    steering,
    '',
    FAN_OUT_PLAN_GRANULARITY,
    '',
    HANDOFF_RULES,
    '',
    TOOL_DOCS,
  ].join('\n');
}

const USER_MESSAGE_C4 =
  'Audit the auth handler patterns across packages/auth, packages/api, ' +
  'packages/web, and packages/cli — show me any inconsistencies in ' +
  'handler signatures, decorators, or error wrapping.';

const USER_MESSAGE_C5 =
  'Add a `requestId` field to the request-context type and thread it ' +
  "through to the three module boundaries that currently log without " +
  'it: packages/api/log.ts, packages/web/middleware.ts, and ' +
  "packages/cli/runner.ts. Each module's change is self-contained; the " +
  "shared type is a 1-line addition to packages/shared/context.ts.";

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
}

const CASES: readonly CaseBundle[] = [
  { id: 'audit_4_packages', userMessage: USER_MESSAGE_C4 },
  { id: 'edit_3_modules', userMessage: USER_MESSAGE_C5 },
] as const;

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

function judgePlanFirstCompliance(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const todoIdx = toolCalls.findIndex((t) => t.name === 'todo_create');
  const dispatchIdx = toolCalls.findIndex((t) => t.name === 'dispatch_child_task');
  if (todoIdx >= 0 && dispatchIdx >= 0) {
    if (todoIdx < dispatchIdx) return { passed: true };
    return { passed: false, reason: 'todo_create AFTER dispatch (binding) — plan-first violated' };
  }
  if (todoIdx >= 0 && dispatchIdx < 0) return { passed: true };
  if (todoIdx < 0 && dispatchIdx >= 0) {
    return { passed: false, reason: 'dispatch without prior todo_create (binding)' };
  }
  const todoFound = invokesTool(out, 'todo_create');
  const dispatchFound = invokesTool(out, 'dispatch_child_task');
  if (todoFound && dispatchFound) {
    const todoMatch = out.search(/\btodo_create\b/i);
    const dispatchMatch = out.search(/\bdispatch_child_task\b/i);
    if (todoMatch >= 0 && dispatchMatch >= 0 && todoMatch < dispatchMatch) return { passed: true };
    return { passed: false, reason: 'narrative todo_create after dispatch (text)' };
  }
  if (!todoFound && dispatchFound) return { passed: false, reason: 'dispatch without todo_create (text)' };
  if (todoFound && !dispatchFound) return { passed: true };
  return { passed: false, reason: 'neither todo_create nor dispatch_child_task invoked' };
}

function judgeDispatchIntent(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.some((t) => t.name === 'dispatch_child_task')) return { passed: true };
  if (invokesTool(out, 'dispatch_child_task')) return { passed: true };
  return { passed: false, reason: 'no dispatch_child_task invocation (binding + regex empty)' };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'plan_first_compliance', category: 'correctness', judge: judgePlanFirstCompliance },
  { name: 'dispatch_intent', category: 'correctness', judge: judgeDispatchIntent },
];

describe('FEATURE_189 B.5 pilot — version-header cleanup trigger validation', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_with_versions',
            description: 'current production worker prompt with 12 LLM-visible version annotations',
            systemPrompt: buildSystemPrompt(true),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_versions',
            description: '12 LLM-visible version annotations stripped per ADR-033 §5',
            systemPrompt: buildSystemPrompt(false),
            priorMessages: [],
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

        const lines: string[] = [];
        lines.push(`[feature-189-b5-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_with_versions', 'v_proposed_no_versions']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const planFirstPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'plan_first_compliance')?.passed,
            ).length;
            const dispatchPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'dispatch_intent')?.passed,
            ).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} plan-first=${planFirstPass}/${cell.runsRaw.length}  dispatch=${dispatchPass}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-b5-version-header-cleanup-pilot',
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
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
