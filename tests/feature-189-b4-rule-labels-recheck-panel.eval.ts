/**
 * Layer 2 RECHECK panel — FEATURE_189 B.4 RULE A/B/C label removal — 2026-05-24
 *
 * Full-production-prompt re-evaluation of the 2026-05-22 DROP.
 * Companion to feature-189-b4-rule-labels-recheck-pilot.eval.ts; this
 * driver scales to the canonical 5-alias panel + 2 cases that exercise
 * the current 9-bullet dispatchRules section (RULE A + DISPATCH OBJECTIVE
 * GUIDANCE etc. all post-DROP additions).
 *
 * ## Why different from DROP-time panel (feature-189-b4-rule-labels-removal.eval.ts)
 *
 * 1. **Full production sections** — DROP-time panel used a truncated
 *    synthetic system prompt (dispatchRules + fan_out + tools only).
 *    This panel includes every section the live worker-role-prompt
 *    emits (PLAN-FIRST CONTRACT + HYGIENE + SCOPE + MUTATION + REPO INTEL
 *    + DISPATCH + STEERING + FAN-OUT + TERMINATION) so the marginal
 *    effect of removing RULE labels is measured in the real anchor-density
 *    environment, not an isolated 3-anchor synthetic.
 * 2. **Refreshed cases** — DROP-time `edit_3_modules` saturated to 0/3
 *    on ark/v4flash floor model (floor saturation per
 *    [[feedback_eval_panel_floor_saturation]]). Replaced with
 *    `single_deep_probe` which exercises RULE B (long-running single
 *    probe) and the post-DROP DISPATCH OBJECTIVE GUIDANCE bullet.
 *
 * ## Variants (byte-aligned to current production worker-role-prompt.ts:54-228)
 *
 *   v_baseline_current_prod   — current production dispatch section with
 *                                RULE A/B/C labels intact (9 bullets).
 *   v_proposed_no_rule_labels — same 9 bullets but RULE A/B/C labels
 *                                stripped; use-case descriptions preserved.
 *
 * ## Pre-registered SHIP gate
 *
 *   (a) plan_first_compliance (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case.
 *   (b) dispatch_intent (judge view): v_proposed ≥ v_baseline − 1 cell
 *       per alias × case. (Primary actionable metric.)
 *   (c) audit disagreement ≤ 10% → DATA VALID.
 *
 * ## Decision matrix
 *
 *   OUTCOME A — Gate (a)+(b)+(c) MET: DROP candidate overturn; ship the
 *               RULE label strip as Batch 6 follow-up.
 *   OUTCOME B — Either (a) or (b) fails on ≥1 alias × case: DROP holds;
 *               update memory with current-prod-env evidence date stamp.
 *   OUTCOME C — (c) fails (disagreement > 10%): regex semantic
 *               misalignment; align regex to judge prompt, re-judge
 *               existing dump (no new panel cost) per
 *               [[feedback_regex_judge_semantic_must_align]].
 *
 * ## Scope
 *
 * 5 alias × 2 case × 2 variant × 5 runs = 100 cells, ~$4, ~25 min wall.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b4-rule-labels-recheck-panel
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
  'feature-189-b4-rule-labels-recheck-panel',
);

const CANONICAL_PANEL: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4flash',
  'ark/v4pro',
] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
  'ark/v4pro': 'ds/v4pro',
};

const RUNS_PER_CELL = 5;

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
  '`module_context`:',
  '  Input:  { target_path:string }',
  '',
  '`changed_scope`:',
  '  Input:  {}',
  '',
  '`changed_diff_bundle`:',
  '  Input:  { paths:string[] }',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// =====================================================================
// CURRENT PRODUCTION worker-role-prompt.ts:54-228 (byte-aligned 2026-05-24)
// All sections shipped — only dispatchRules differs between variants.
// =====================================================================

const PLAN_FIRST_PROD = [
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
].join('\n');

const PLAN_LIST_HYGIENE_PROD = [
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first to read the item\'s CURRENT state.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list and confirm no item with the same subject is already present.',
  '- DEDUP HEURISTIC: two items are duplicates when their `subject` describes the same concrete artifact / file path / module.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start of the task) is exempt from the dedup check.',
].join('\n');

const SCOPE_COMMITMENT_PROD = [
  'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '- If the user request is review/audit, your initial plan committed via `todo_create` IS the visible review report skeleton.',
].join('\n');

const MUTATION_DISCIPLINE_PROD = [
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial.',
  '- Prefer `edit` over `write` for existing files.',
  '- For multiple edits to one file, batch with `multi_edit` instead of N separate `edit` calls.',
  '- NEVER route a single known-content file through `bash` heredocs.',
  '- Workspace discipline: scratch files go under `.agent/tmp/` (relative to git root).',
].join('\n');

const REPO_INTEL_PROD = [
  'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs.',
  '- `changed_scope()` — list of changed files in current git state.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes": your first scope-acquisition tool MUST be `changed_scope`, followed by `changed_diff_bundle(paths[])`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

// VARIANT-SPECIFIC sections (everything else is identical across variants)
const DISPATCH_RULES_WITH_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful. When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker pointing at the spilled file.',
  '- MODEL HINT (optional, FEATURE_120 v0.7.39): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class.',
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): when writing a child\'s `objective`, prefer stating the goal abstractly. Avoid hand-feeding specific bash commands.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT (review / change-audit / module-exploration objectives only), briefly note the recommended pull-tool family in the objective.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

const DISPATCH_RULES_NO_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- Read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- Write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful. When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker pointing at the spilled file.',
  '- MODEL HINT (optional, FEATURE_120 v0.7.39): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class.',
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): when writing a child\'s `objective`, prefer stating the goal abstractly. Avoid hand-feeding specific bash commands.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT (review / change-audit / module-exploration objectives only), briefly note the recommended pull-tool family in the objective.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

const FAN_OUT_PROD = [
  'FAN-OUT PLAN GRANULARITY:',
  '- When you are about to dispatch several children in parallel, first emit a `todo_create` call for each one.',
  '- Mark each item `in_progress` just before its `dispatch_child_task` call, and `completed` when the matching `<task-completed>` block arrives.',
].join('\n');

const HANDOFF_PROD = [
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary covering what you did and what changed.',
  '- If you cannot proceed, end your turn with a text-only summary of the blocker. Mark the affected plan items `failed` with a note BEFORE the final summary turn.',
].join('\n');

function buildSystemPrompt(useLabels: boolean): string {
  const dispatch = useLabels ? DISPATCH_RULES_WITH_LABELS : DISPATCH_RULES_NO_LABELS;
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    PLAN_FIRST_PROD,
    '',
    PLAN_LIST_HYGIENE_PROD,
    '',
    SCOPE_COMMITMENT_PROD,
    '',
    MUTATION_DISCIPLINE_PROD,
    '',
    REPO_INTEL_PROD,
    '',
    dispatch,
    '',
    FAN_OUT_PROD,
    '',
    HANDOFF_PROD,
    '',
    TOOL_DOCS,
  ].join('\n');
}

// =====================================================================
// CASES
// =====================================================================

// C1 (REUSED from B.4 5-22 panel): RULE A read-only fan-out.
const USER_MESSAGE_C1 =
  'Audit the auth handler patterns across packages/auth, packages/api, ' +
  'packages/web, and packages/cli — show me any inconsistencies in ' +
  'handler signatures, decorators, or error wrapping.';

// C2 (NEW): RULE B long-running probe — exercises classification choice
// between (a) direct local execution and (b) single long-running child
// dispatch. The full vitest suite is independently long; dispatching it
// frees the Worker to do interleaved synthesis work. Tests whether the
// model picks up the "long-running probe → dispatch as child" pattern
// in the post-DROP 9-bullet dispatch section.
const USER_MESSAGE_C2 =
  'Run the full vitest suite in packages/coding (it takes 2-3 minutes), ' +
  'identify the 5 slowest test files by total wall time, and explain ' +
  'why each is slow (suspected slow setup vs slow assertions vs heavy ' +
  'I/O). Capture the slowest suite\'s log output for follow-up.';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
}

const CASES: readonly CaseBundle[] = [
  { id: 'audit_4_packages', userMessage: USER_MESSAGE_C1 },
  { id: 'single_deep_probe', userMessage: USER_MESSAGE_C2 },
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
    return { passed: false, reason: 'todo_create AFTER dispatch (binding)' };
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
  return { passed: false, reason: 'no dispatch_child_task invocation' };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'plan_first_compliance', category: 'correctness', judge: judgePlanFirstCompliance },
  { name: 'dispatch_intent', category: 'correctness', judge: judgeDispatchIntent },
];

describe('FEATURE_189 B.4 RECHECK panel — current-prod RULE label removal', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no panel alias keys in env', () => {
      /* no-op */
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 60 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_current_prod',
            description: 'full current production worker-role-prompt with RULE A/B/C labels',
            systemPrompt: buildSystemPrompt(true),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_rule_labels',
            description: 'same prompt; RULE A/B/C labels stripped',
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
        lines.push(`[feature-189-b4-recheck-panel][${c.id}]`);
        for (const variantId of ['v_baseline_current_prod', 'v_proposed_no_rule_labels']) {
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
          stage: 'feature-189-b4-rule-labels-recheck-panel',
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
