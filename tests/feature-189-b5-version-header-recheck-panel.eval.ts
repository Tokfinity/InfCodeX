/**
 * Layer 2 RECHECK panel — FEATURE_189 B.5 version-header cleanup — 2026-05-24
 *
 * Full-production-prompt re-evaluation of the 2026-05-22 DROP.
 * Companion to feature-189-b5-version-header-recheck-pilot.eval.ts.
 *
 * ## Why different from DROP-time panel (feature-189-b5-version-header-cleanup.eval.ts)
 *
 * 1. **Byte-aligned with current production** — DROP-time panel
 *    snapshot had 7-12 (FEATURE_xxx vX.Y.Z) markers across various
 *    placements. Current production worker-role-prompt has only 5
 *    markers, all at section headers (PLAN-FIRST + LARGE CHILD OUTPUT
 *    inline + ASYNC CHILD STEERING + REPO INTEL + CHANGE-REVIEW). The
 *    sparser anchor density changes the "dense parenthetical attention
 *    anchor" hypothesis's applicability.
 * 2. **Refreshed cases** — DROP-time `edit_3_modules` saturated to
 *    0/3 on ark/v4flash floor (B.5 pilot 2026-05-24 confirmed).
 *    Replaced with `review_recent_changes` which exercises
 *    CHANGE-REVIEW POSITIVE REFRAME + REPO INTEL sections (the two
 *    sections with the heaviest version markers).
 *
 * ## Variants (byte-aligned to current worker-role-prompt.ts:54-228)
 *
 *   v_baseline_current_prod  — current production with (FEATURE_xxx vX.Y.Z)
 *                               annotations at 5 section headers.
 *   v_proposed_no_versions   — same sections; (FEATURE_xxx ...)
 *                               parenthetical annotations stripped.
 *
 * ## Pre-registered SHIP gate (decision-matrix-style)
 *
 *   (a) plan_first_compliance (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case.
 *   (b) dispatch_intent (judge view): same.
 *   (c) audit disagreement ≤ 10% → DATA VALID.
 *
 * ## Decision matrix
 *
 *   OUTCOME A — (a)+(b)+(c) MET: DROP candidate overturn; ship the
 *               version-marker strip.
 *   OUTCOME B — (a) or (b) fails on ≥1 alias × case: DROP holds; update
 *               memory with current-prod evidence date stamp.
 *   OUTCOME C — (c) fails: regex/judge misalignment; re-judge dump in
 *               place (no new panel cost).
 *
 * ## Scope
 *
 * 5 alias × 2 case × 2 variant × 5 runs = 100 cells, ~$4, ~25 min wall.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b5-version-header-recheck-panel
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
  'feature-189-b5-version-header-recheck-panel',
);

const CANONICAL_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
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
  '`changed_diff`:',
  '  Input:  { path:string }',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// =====================================================================
// CURRENT PRODUCTION — WITH VERSION MARKERS
// =====================================================================

const PLAN_FIRST_WITH_V = [
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (v0.7.42, mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").',
  '    * `description` — OPTIONAL. Fuller context / work instructions read when you pick up the item later.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly.',
  '- Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const PLAN_LIST_HYGIENE_WITH_V = [
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list and confirm no item with the same subject is already present.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start) is exempt from the dedup check.',
].join('\n');

const SCOPE_COMMITMENT_WITH_V = [
  'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '- If the user request is review/audit, your initial plan IS the visible review report skeleton.',
].join('\n');

const MUTATION_DISCIPLINE_WITH_V = [
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial.',
  '- Prefer `edit` over `write` for existing files.',
  '- For multiple edits to one file, batch with `multi_edit`.',
].join('\n');

const REPO_INTEL_WITH_V = [
  'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what depends on what".',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  '- `changed_diff(path)` — paged diff for one file.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes", "check diff", or "what changed since X": your first scope-acquisition tool MUST be `changed_scope` (one call), followed by `changed_diff_bundle(paths[])` for the files you need to read.',
  '- Do NOT use `bash git diff …` for change review — that pattern reads opaque text the repo-intel daemon already structured for you.',
  '- `bash git …` is reserved for NON-review git ops: status, commit, tag, push, log (commit history), branch operations.',
].join('\n');

const DISPATCH_RULES_WITH_V = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations, launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while, dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children.',
  '- IDLE-YIELD: after `dispatch_child_task` returns a `task_id:<id>`, do interleaved work; when out of useful work AND children still in flight, end your turn with ONE short status sentence.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker pointing at the spilled file.',
  '- MODEL HINT (optional, FEATURE_120 v0.7.39): set `model_hint` to advertise the child\'s reasoning weight class.',
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): prefer stating the goal abstractly. Avoid hand-feeding specific bash commands.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT, briefly note the recommended pull-tool family.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>`.',
].join('\n');

const ASYNC_STEERING_WITH_V = [
  'ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — `send_message` + `task_stop`):',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. Use SPARINGLY.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully.',
].join('\n');

const FAN_OUT_PROD = [
  'FAN-OUT PLAN GRANULARITY:',
  '- When you are about to dispatch several children in parallel, first emit a `todo_create` call for each one.',
  '- Mark each item `in_progress` just before its `dispatch_child_task` call.',
].join('\n');

const HANDOFF_PROD = [
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary.',
  '- If you cannot proceed, end your turn with a text-only summary of the blocker.',
].join('\n');

// =====================================================================
// NO VERSIONS — strip every (FEATURE_xxx ...) parenthetical
// =====================================================================

const PLAN_FIRST_NO_V = [
  'PLAN-FIRST CONTRACT:',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").',
  '    * `description` — OPTIONAL. Fuller context / work instructions read when you pick up the item later.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly.',
  '- Mark exactly ONE item `in_progress` at a time.',
].join('\n');

const PLAN_LIST_HYGIENE_NO_V = [
  'PLAN-LIST HYGIENE (staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched, call `todo_get(id)` first.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list and confirm no item with the same subject is already present.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start) is exempt from the dedup check.',
].join('\n');

const SCOPE_COMMITMENT_NO_V = [
  'SCOPE COMMITMENT:',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run.',
  '- If the user request is review/audit, your initial plan IS the visible review report skeleton.',
].join('\n');

// MUTATION_DISCIPLINE has no version markers — identical to with_v
const MUTATION_DISCIPLINE_NO_V = MUTATION_DISCIPLINE_WITH_V;

const REPO_INTEL_NO_V = [
  'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what depends on what".',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  '- `changed_diff(path)` — paged diff for one file.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes", "check diff", or "what changed since X": your first scope-acquisition tool MUST be `changed_scope` (one call), followed by `changed_diff_bundle(paths[])` for the files you need to read.',
  '- Do NOT use `bash git diff …` for change review — that pattern reads opaque text the repo-intel daemon already structured for you.',
  '- `bash git …` is reserved for NON-review git ops: status, commit, tag, push, log (commit history), branch operations.',
].join('\n');

const DISPATCH_RULES_NO_V = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations, launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while, dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children.',
  '- IDLE-YIELD: after `dispatch_child_task` returns a `task_id:<id>`, do interleaved work; when out of useful work AND children still in flight, end your turn with ONE short status sentence.',
  '- LARGE CHILD OUTPUT: when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker pointing at the spilled file.',
  '- MODEL HINT (optional): set `model_hint` to advertise the child\'s reasoning weight class.',
  '- DISPATCH OBJECTIVE QUALITY: prefer stating the goal abstractly. Avoid hand-feeding specific bash commands.',
  '- DISPATCH OBJECTIVE GUIDANCE: WHEN RELEVANT, briefly note the recommended pull-tool family.',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain, prefer dispatching with `subagent_type=<name>`.',
].join('\n');

const ASYNC_STEERING_NO_V = [
  'ASYNC CHILD STEERING (`send_message` + `task_stop`):',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. Use SPARINGLY.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully.',
].join('\n');

function buildSystemPrompt(useVersions: boolean): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    useVersions ? PLAN_FIRST_WITH_V : PLAN_FIRST_NO_V,
    '',
    useVersions ? PLAN_LIST_HYGIENE_WITH_V : PLAN_LIST_HYGIENE_NO_V,
    '',
    useVersions ? SCOPE_COMMITMENT_WITH_V : SCOPE_COMMITMENT_NO_V,
    '',
    useVersions ? MUTATION_DISCIPLINE_WITH_V : MUTATION_DISCIPLINE_NO_V,
    '',
    useVersions ? REPO_INTEL_WITH_V : REPO_INTEL_NO_V,
    '',
    useVersions ? DISPATCH_RULES_WITH_V : DISPATCH_RULES_NO_V,
    '',
    useVersions ? ASYNC_STEERING_WITH_V : ASYNC_STEERING_NO_V,
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

// C1 (REUSED): exercises PLAN-FIRST CONTRACT (has version marker).
const USER_MESSAGE_C1 =
  'Audit the auth handler patterns across packages/auth, packages/api, ' +
  'packages/web, and packages/cli — show me any inconsistencies in ' +
  'handler signatures, decorators, or error wrapping.';

// C2 (NEW): exercises CHANGE-REVIEW POSITIVE REFRAME (has version marker)
// + REPO INTEL pull-tools (has version marker). Tests the two heaviest
// version-marker sections directly. Per CHANGE-REVIEW POSITIVE REFRAME,
// first tool call MUST be `changed_scope`, then `changed_diff_bundle`.
const USER_MESSAGE_C2 =
  'Review the recent changes since v0.7.42 — which files have been ' +
  'modified, and are there any concerns about test coverage drift or ' +
  'cross-package consistency in the diffs? Treat this as a structured ' +
  'review report.';

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly judgeKind: 'dispatch_fan_out' | 'change_review';
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'audit_4_packages',
    userMessage: USER_MESSAGE_C1,
    judgeKind: 'dispatch_fan_out',
  },
  {
    id: 'review_recent_changes',
    userMessage: USER_MESSAGE_C2,
    judgeKind: 'change_review',
  },
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

// Per-case judges:
// dispatch_fan_out case (audit_4_packages): plan_first_compliance + dispatch_intent
// change_review case (review_recent_changes): plan_first_compliance + pull_tool_first
function judgePlanFirstCompliance(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  // For change_review case, plan first means todo_create before any pull-tool/dispatch.
  // For dispatch case, plan first means todo_create before dispatch_child_task.
  const todoIdx = toolCalls.findIndex((t) => t.name === 'todo_create');
  const firstActionIdx = toolCalls.findIndex(
    (t) =>
      t.name === 'dispatch_child_task' ||
      t.name === 'changed_scope' ||
      t.name === 'changed_diff_bundle',
  );
  if (todoIdx >= 0 && firstActionIdx >= 0) {
    if (todoIdx < firstActionIdx) return { passed: true };
    return { passed: false, reason: 'todo_create AFTER first action (binding)' };
  }
  if (todoIdx >= 0 && firstActionIdx < 0) return { passed: true };
  if (todoIdx < 0 && firstActionIdx >= 0) {
    return { passed: false, reason: 'first action without prior todo_create (binding)' };
  }
  const todoFound = invokesTool(out, 'todo_create');
  const dispatchFound = invokesTool(out, 'dispatch_child_task');
  const changedScopeFound = invokesTool(out, 'changed_scope');
  const anyActionFound = dispatchFound || changedScopeFound;
  if (todoFound && anyActionFound) {
    const todoMatch = out.search(/\btodo_create\b/i);
    const actionMatch =
      Math.min(
        out.search(/\bdispatch_child_task\b/i) >= 0 ? out.search(/\bdispatch_child_task\b/i) : Number.MAX_SAFE_INTEGER,
        out.search(/\bchanged_scope\b/i) >= 0 ? out.search(/\bchanged_scope\b/i) : Number.MAX_SAFE_INTEGER,
      );
    if (todoMatch >= 0 && actionMatch < Number.MAX_SAFE_INTEGER && todoMatch < actionMatch) return { passed: true };
    return { passed: false, reason: 'narrative todo_create after action (text)' };
  }
  if (!todoFound && anyActionFound) return { passed: false, reason: 'action without todo_create (text)' };
  if (todoFound && !anyActionFound) return { passed: true };
  return { passed: false, reason: 'neither todo_create nor any action invoked' };
}

function judgeDispatchIntent(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.some((t) => t.name === 'dispatch_child_task')) return { passed: true };
  if (invokesTool(out, 'dispatch_child_task')) return { passed: true };
  return { passed: false, reason: 'no dispatch_child_task invocation' };
}

// For change_review case, success = first scope-acquisition tool is
// `changed_scope` (per CHANGE-REVIEW POSITIVE REFRAME). Fall-back regex
// scanning.
function judgePullToolFirst(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  // Binding view: first tool call (excluding todo_*) must be changed_scope
  // or another pull-tool, NOT bash git diff.
  const nonTodo = toolCalls.find((t) => t.name !== 'todo_create' && t.name !== 'todo_update' && t.name !== 'todo_get');
  if (nonTodo) {
    if (nonTodo.name === 'changed_scope' || nonTodo.name === 'changed_diff_bundle' || nonTodo.name === 'module_context') {
      return { passed: true };
    }
    if (nonTodo.name === 'bash') {
      // Check if bash is git-diff (anti-pattern for review)
      try {
        const input = nonTodo.input as { command?: string };
        if (typeof input.command === 'string' && /git\s+diff/i.test(input.command)) {
          return { passed: false, reason: 'first action is bash git diff (anti-pattern)' };
        }
      } catch {
        /* ignore */
      }
    }
    return { passed: false, reason: `first action is ${nonTodo.name}, not pull-tool` };
  }
  // Binding empty: scan text for changed_scope invocation
  if (invokesTool(out, 'changed_scope')) {
    // Verify nothing else came before it textually
    const idx = out.search(/\bchanged_scope\b/i);
    const bashIdx = out.search(/\bbash\b.*git\s+diff/i);
    if (bashIdx >= 0 && bashIdx < idx) {
      return { passed: false, reason: 'text shows bash git diff before changed_scope' };
    }
    return { passed: true };
  }
  // No pull-tool, but maybe bash git diff (anti-pattern)
  if (/\bbash\b.*git\s+diff/i.test(out) || /git\s+diff/i.test(out)) {
    return { passed: false, reason: 'text shows bash git diff (anti-pattern, no pull-tool)' };
  }
  return { passed: false, reason: 'no pull-tool invocation' };
}

const JUDGES_DISPATCH: readonly PromptJudge[] = [
  { name: 'plan_first_compliance', category: 'correctness', judge: judgePlanFirstCompliance },
  { name: 'dispatch_intent', category: 'correctness', judge: judgeDispatchIntent },
];

const JUDGES_REVIEW: readonly PromptJudge[] = [
  { name: 'plan_first_compliance', category: 'correctness', judge: judgePlanFirstCompliance },
  { name: 'pull_tool_first', category: 'correctness', judge: judgePullToolFirst },
];

describe('FEATURE_189 B.5 RECHECK panel — current-prod version-header removal', () => {
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
            description: 'full current production worker-role-prompt with (FEATURE_xxx vX.Y.Z) annotations',
            systemPrompt: buildSystemPrompt(true),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_versions',
            description: 'same prompt; (FEATURE_xxx vX.Y.Z) annotations stripped',
            systemPrompt: buildSystemPrompt(false),
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const judges = c.judgeKind === 'change_review' ? JUDGES_REVIEW : JUDGES_DISPATCH;

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-189-b5-recheck-panel][${c.id}] (kind=${c.judgeKind})`);
        for (const variantId of ['v_baseline_current_prod', 'v_proposed_no_versions']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const planFirstPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'plan_first_compliance')?.passed,
            ).length;
            const secondJudgeName = c.judgeKind === 'change_review' ? 'pull_tool_first' : 'dispatch_intent';
            const secondPass = cell.runsRaw.filter((r) => r.judges.find((j) => j.name === secondJudgeName)?.passed).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} plan-first=${planFirstPass}/${cell.runsRaw.length}  ${secondJudgeName}=${secondPass}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-b5-version-header-recheck-panel',
          judgeKind: c.judgeKind,
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
