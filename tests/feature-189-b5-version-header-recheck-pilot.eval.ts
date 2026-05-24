/**
 * Re-check Pilot — FEATURE_189 B.5 version-header cleanup — 2026-05-24
 *
 * Re-evaluates the 2026-05-22 eval-driven DROP under current production
 * worker-role-prompt environment. The original B.5 pilot (2026-05-22)
 * used a synthetic prompt with 7 (FEATURE_xxx vX.Y.Z) markers spread
 * across 5 sections. Since DROP:
 *
 *   - F189 Batch 1 (557c29a4) added because-clauses (anchor density up)
 *   - F189 Batch 4 (52b08ada) dropped quantitative thresholds (-3 anchors)
 *   - F190 (5fa1c362) replaced EVALUATOR HANDOFF block with TERMINATION
 *   - F191 (7e471b4c) added SPECIALIST ROUTING bullet to dispatchRules
 *
 * Current worker-role-prompt has 5 `(FEATURE_xxx vX.Y.Z)` markers in
 * total (down from 12 at DROP-commit-time, per grep). The "dense
 * parenthetical attention anchor" hypothesis from the original DROP
 * rationale should be re-tested against this sparser anchor environment.
 *
 * Variants:
 *   v_baseline_current_prod   — current production worker-role-prompt
 *                                byte-aligned with worker-role-prompt.ts:
 *                                54-228 (2026-05-24 state). All
 *                                (FEATURE_xxx ...) annotations intact.
 *   v_proposed_no_versions    — same sections, byte-aligned, but all
 *                                (FEATURE_xxx ...) parenthetical
 *                                annotations stripped.
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells, ~$0.30.
 *
 * Pre-registered SHIP gate (decision-matrix-style):
 *   A: Both cases v_proposed ≥ v_baseline − 1 cell → DROP candidate
 *      overturn → escalate to 5-alias panel + 3-judge audit on
 *      current-prod snapshot
 *   B: Either case v_proposed ≤ v_baseline − 2 cells → DROP holds;
 *      log re-pilot evidence with date stamp
 *   C: Mixed / borderline (1-cell delta) → noise floor; needs panel
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b5-version-header-recheck-pilot
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
  'feature-189-b5-version-header-recheck-pilot',
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
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// =====================================================================
// CURRENT PRODUCTION (worker-role-prompt.ts:54-228 byte-aligned 2026-05-24)
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
  '- Replan iteratively as the picture firms up — use the per-item API:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({subject:"...", description?:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '    * EDIT ONE STEP: `todo_update({id, subject?, description?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '    * REMOVE ONE STEP entirely (no breadcrumb): `todo_update({id, status:"deleted"})`. Prefer over `cancelled` when the item was wholly off-plan.',
  '    * STRIKETHROUGH ONE STEP (keep visible breadcrumb): `todo_update({id, status:"cancelled", note:"..."})`. Prefer over `deleted` when the user benefits from seeing the discarded record.',
].join('\n');

const PLAN_LIST_HYGIENE_PROD = [
  'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched (e.g. just resumed from idle-yield, or mid-fan-out after children finished, or after a long thinking stretch), call `todo_get(id)` first to read the item\'s CURRENT state. Runner-side auto-handlers can flip statuses between your turns; mutating on a stale view produces silent no-op patches or surprising overwrites. `todo_get` is cheap — one tool call per uncertain item — and the JSON it returns is authoritative.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list (it is visible at the top of every throttle reminder, OR call `todo_list` for an explicit snapshot) and confirm no item with the same subject is already present. Duplicate items split the user\'s progress dashboard into parallel branches of the same work — confusing and easy to over-count.',
  '- DEDUP HEURISTIC: two items are duplicates when their `subject` describes the same concrete artifact / file path / module. They are NOT duplicates when one is a parent-level summary ("Audit packages/auth") and the other a leaf ("Write test for handleLogin in packages/auth") — those are legitimately distinct rows.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start of the task) is exempt from the dedup check — the list is empty so duplicates are impossible.',
].join('\n');

const SCOPE_COMMITMENT_PROD = [
  'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run. Surfacing belated obligations later forfeits the trust that drove your initial harness choice — call `todo_create({subject:"..."})` to add the new item explicitly, do not slip it into a later step\'s description.',
  '- If the user request is review/audit, your initial plan committed via `todo_create` IS the visible review report skeleton — emit it in the first 1-2 turns so the user sees structured progress, not a wall of bash + read calls followed by a single text dump.',
].join('\n');

const MUTATION_DISCIPLINE_PROD = [
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial. Skipping the read forces `edit`/`multi_edit` to fail with "old_string not found" and costs a retry round-trip.',
  '- Prefer `edit` over `write` for existing files (smaller token footprint, diff-safe). Use `write` only for new files or full rewrites the user explicitly asked for.',
  '- For multiple edits to one file, batch with `multi_edit` instead of N separate `edit` calls — atomic, cheaper, structure-preserving.',
  '- NEVER route a single known-content file through `bash` heredocs — use `write` or `edit` instead. Heredoc routing bypasses mutation tracking and diff visibility; the file lands without an edit record so reviewers cannot see what changed.',
  '- Workspace discipline: scratch files go under `.agent/tmp/` (relative to git root). NEVER write scratch to project root or system tmp — project root pollutes the user\'s repo (shows up in `git status` and file listings), and system tmp gets reclaimed by the OS before you can re-read it.',
].join('\n');

const DISPATCH_RULES_PROD = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result. This lets the user keep chatting with you while children run.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker like `[Tool output truncated. ... Full output saved to: <ABSOLUTE_PATH>. Use the Read tool to view full output.]`. The preview is usually enough — read it first, and only call `Read` on the saved path when you need details beyond what the preview shows (e.g., specific code snippets the child cited, or items below the cutoff). Do NOT blindly Read every spillover path; that wastes context.',
  '- MODEL HINT (optional, FEATURE_120 v0.7.39): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class. `"fast"` for trivial single-file lookups; `"deep"` for multi-file research or analytical synthesis; `"balanced"` (or omit) for everything else. Routing is a no-op today — every child runs on your model — but the hint is recorded for FEATURE_102 (v0.7.45). Mark intentionally; do not blanket-tag every child.',
  '- DISPATCH OBJECTIVE QUALITY (FEATURE_169 — F0a): when writing a child\'s `objective`, prefer stating the goal abstractly. Avoid hand-feeding specific bash commands ("use `git diff X`", "run `git log`") — the child picks its own tools, and hand-feeding bash bypasses the child\'s pull-tool guidance. If you need to convey a specific git revision or scope (e.g., v0.7.39..HEAD), state it as data ("scope: v0.7.39..HEAD") rather than a command directive.',
  '- DISPATCH OBJECTIVE GUIDANCE (FEATURE_169 — F0b): WHEN RELEVANT (review / change-audit / module-exploration objectives only — not trivial probes), briefly note the recommended pull-tool family in the objective. Examples:',
  '    - Review tasks: "scope via `changed_scope`, then drill specific files with `changed_diff_bundle`"',
  '    - Module exploration: "use `module_context` to map the module surface before reading individual files"',
  '    - Symbol tracing: "start with `symbol_context` to find callers"',
  '    - Process flow / execution trace: "use `process_context` to map the flow before reading runner files"',
  '    - Rename / refactor impact: "use `impact_estimate` to estimate blast radius first"',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain (see "Available specialist agents" block above when present), prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

const ASYNC_STEERING_PROD = [
  'ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — `send_message` + `task_stop`):',
  'After `dispatch_child_task` launches a child, you may steer it while it runs:',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. The child sees it as a `<coordinator-instruction>` block at its next LLM turn boundary. Use SPARINGLY: a child that needed more context is a planning failure — the typical pattern is 0-1 send_message calls per child.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully. Its currently-executing tool finishes atomically (no hard kill of a 90s `npm test` mid-run); the child then sees a `<coordinator-stop-request>` reminder and emits a final summary.',
].join('\n');

const REPO_INTEL_PROD = [
  'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what depends on what".',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports for one symbol. Replaces multiple `grep -n "symbolName"` + `read` rounds when tracing usage.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate combining symbol/module info with current changed-scope overlap. Use BEFORE planning a rename/refactor instead of guessing from grep.',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes": your first scope-acquisition tool MUST be `changed_scope`, followed by `changed_diff_bundle(paths[])`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

const FAN_OUT_PROD = [
  'FAN-OUT PLAN GRANULARITY:',
  '- When you are about to dispatch several children in parallel, first emit a `todo_create` call for each one so the user sees per-child progress instead of a 30-60s black box. One todo per child — use the child\'s objective as the subject.',
  '- Mark each item `in_progress` just before its `dispatch_child_task` call, and `completed` when the matching `<task-completed>` block arrives.',
  '- If mid fan-out you decide to dispatch another child, add the matching todo before the new dispatch.',
].join('\n');

const HANDOFF_RULES_PROD = [
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary covering what you did, what changed (files / behavior), and any caveats. No tool call needed to terminate — the absence of a `tool_use` block on your final assistant message IS the terminal signal.',
  '- If you cannot proceed (e.g. user-input blocker, irrecoverable failure), end your turn with a text-only summary of the blocker. Mark the affected plan items `failed` with a note BEFORE the final summary turn so the dashboard reflects the blocked state.',
  '- After your terminal turn, an independent Sidecar Verifier reads your work in a fresh read-only session and decides accept (success) / revise (your turn again, fix the called-out issues) / blocked (terminal failure). You do not call the verifier — it runs automatically.',
].join('\n');

// =====================================================================
// NO_VERSIONS — strip (FEATURE_xxx ...) parenthetical version metadata,
// keep every other byte identical.
// =====================================================================

const PLAN_FIRST_NO_VERSIONS = [
  'PLAN-FIRST CONTRACT:',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_create` / `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
  '- Plan item schema (mirrors claudecode V2 `TaskCreate`):',
  '    * `subject` — REQUIRED. Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").',
  '    * `description` — OPTIONAL. Fuller context / work instructions read when you pick up the item later. Multi-line OK; NOT rendered in the compact row. Skip when subject alone is enough.',
  '    * `activeForm` — OPTIONAL. Present-continuous form shown by the spinner while this item is `in_progress` (e.g. "Auditing handleAuth callers"). Supply alongside `subject` so the spinner reads natural while you work.',
  '    * `evaluator` — OPTIONAL `\'build\' | \'test\' | \'lint\'`. Use sparingly — only on milestone steps with a real ground-truth check.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_create` AT THAT MOMENT — one call per newly-realized step — to retrofit the plan. Do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled` / `deleted`). Mark exactly ONE item `in_progress` at a time.',
  '- Replan iteratively as the picture firms up — use the per-item API:',
  '    * INSERT ONE NEW STEP mid-task: `todo_create({subject:"...", description?:"...", activeForm?:"..."})`. Use this when the plan needs one more step but the existing items must be preserved. The store auto-mints the id.',
  '    * EDIT ONE STEP: `todo_update({id, subject?, description?, activeForm?, evaluator?, metadata?})` — patch fields without changing status.',
  '    * REMOVE ONE STEP entirely (no breadcrumb): `todo_update({id, status:"deleted"})`. Prefer over `cancelled` when the item was wholly off-plan.',
  '    * STRIKETHROUGH ONE STEP (keep visible breadcrumb): `todo_update({id, status:"cancelled", note:"..."})`. Prefer over `deleted` when the user benefits from seeing the discarded record.',
].join('\n');

const PLAN_LIST_HYGIENE_NO_VERSIONS = [
  'PLAN-LIST HYGIENE (staleness + dedup):',
  '- BEFORE `todo_update` on an item you have NOT recently touched (e.g. just resumed from idle-yield, or mid-fan-out after children finished, or after a long thinking stretch), call `todo_get(id)` first to read the item\'s CURRENT state. Runner-side auto-handlers can flip statuses between your turns; mutating on a stale view produces silent no-op patches or surprising overwrites. `todo_get` is cheap — one tool call per uncertain item — and the JSON it returns is authoritative.',
  '- BEFORE `todo_create` mid-task, scan the existing plan list (it is visible at the top of every throttle reminder, OR call `todo_list` for an explicit snapshot) and confirm no item with the same subject is already present. Duplicate items split the user\'s progress dashboard into parallel branches of the same work — confusing and easy to over-count.',
  '- DEDUP HEURISTIC: two items are duplicates when their `subject` describes the same concrete artifact / file path / module. They are NOT duplicates when one is a parent-level summary ("Audit packages/auth") and the other a leaf ("Write test for handleLogin in packages/auth") — those are legitimately distinct rows.',
  '- INITIAL PLAN COMMITMENT (first batch of `todo_create` at the start of the task) is exempt from the dedup check — the list is empty so duplicates are impossible.',
].join('\n');

const SCOPE_COMMITMENT_NO_VERSIONS = [
  'SCOPE COMMITMENT:',
  '- Whatever scope you commit to in your first batch of `todo_create` calls is your contract for the run. Surfacing belated obligations later forfeits the trust that drove your initial harness choice — call `todo_create({subject:"..."})` to add the new item explicitly, do not slip it into a later step\'s description.',
  '- If the user request is review/audit, your initial plan committed via `todo_create` IS the visible review report skeleton — emit it in the first 1-2 turns so the user sees structured progress, not a wall of bash + read calls followed by a single text dump.',
].join('\n');

// MUTATION_DISCIPLINE has no version markers — same as PROD.
const MUTATION_DISCIPLINE_NO_VERSIONS = MUTATION_DISCIPLINE_PROD;

const DISPATCH_RULES_NO_VERSIONS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result. This lets the user keep chatting with you while children run.',
  '- LARGE CHILD OUTPUT: when a child\'s report is too large to include inline, the `<task-completed>` banner contains a preview + a marker like `[Tool output truncated. ... Full output saved to: <ABSOLUTE_PATH>. Use the Read tool to view full output.]`. The preview is usually enough — read it first, and only call `Read` on the saved path when you need details beyond what the preview shows (e.g., specific code snippets the child cited, or items below the cutoff). Do NOT blindly Read every spillover path; that wastes context.',
  '- MODEL HINT (optional): you may set `model_hint` on a dispatch to advertise the child\'s reasoning weight class. `"fast"` for trivial single-file lookups; `"deep"` for multi-file research or analytical synthesis; `"balanced"` (or omit) for everything else. Routing is a no-op today — every child runs on your model — but the hint is recorded for future routing. Mark intentionally; do not blanket-tag every child.',
  '- DISPATCH OBJECTIVE QUALITY: when writing a child\'s `objective`, prefer stating the goal abstractly. Avoid hand-feeding specific bash commands ("use `git diff X`", "run `git log`") — the child picks its own tools, and hand-feeding bash bypasses the child\'s pull-tool guidance. If you need to convey a specific git revision or scope, state it as data ("scope: v0.7.39..HEAD") rather than a command directive.',
  '- DISPATCH OBJECTIVE GUIDANCE: WHEN RELEVANT (review / change-audit / module-exploration objectives only — not trivial probes), briefly note the recommended pull-tool family in the objective. Examples:',
  '    - Review tasks: "scope via `changed_scope`, then drill specific files with `changed_diff_bundle`"',
  '    - Module exploration: "use `module_context` to map the module surface before reading individual files"',
  '    - Symbol tracing: "start with `symbol_context` to find callers"',
  '    - Process flow / execution trace: "use `process_context` to map the flow before reading runner files"',
  '    - Rename / refactor impact: "use `impact_estimate` to estimate blast radius first"',
  '- SPECIALIST ROUTING: when a registered specialist agent matches the task domain (see "Available specialist agents" block above when present), prefer dispatching with `subagent_type=<name>` over a generic child.',
].join('\n');

const ASYNC_STEERING_NO_VERSIONS = [
  'ASYNC CHILD STEERING (`send_message` + `task_stop`):',
  'After `dispatch_child_task` launches a child, you may steer it while it runs:',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. The child sees it as a `<coordinator-instruction>` block at its next LLM turn boundary. Use SPARINGLY: a child that needed more context is a planning failure — the typical pattern is 0-1 send_message calls per child.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully. Its currently-executing tool finishes atomically (no hard kill of a 90s `npm test` mid-run); the child then sees a `<coordinator-stop-request>` reminder and emits a final summary.',
].join('\n');

const REPO_INTEL_NO_VERSIONS = [
  'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule with deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what depends on what".',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports for one symbol. Replaces multiple `grep -n "symbolName"` + `read` rounds when tracing usage.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate combining symbol/module info with current changed-scope overlap. Use BEFORE planning a rename/refactor instead of guessing from grep.',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes": your first scope-acquisition tool MUST be `changed_scope`, followed by `changed_diff_bundle(paths[])`.',
  '- Do NOT use `bash git diff …` for change review.',
].join('\n');

// FAN_OUT and HANDOFF have no version markers — same as PROD.
const FAN_OUT_NO_VERSIONS = FAN_OUT_PROD;
const HANDOFF_RULES_NO_VERSIONS = HANDOFF_RULES_PROD;

function buildSystemPrompt(useVersions: boolean): string {
  const planFirst = useVersions ? PLAN_FIRST_PROD : PLAN_FIRST_NO_VERSIONS;
  const hygiene = useVersions ? PLAN_LIST_HYGIENE_PROD : PLAN_LIST_HYGIENE_NO_VERSIONS;
  const scope = useVersions ? SCOPE_COMMITMENT_PROD : SCOPE_COMMITMENT_NO_VERSIONS;
  const mutation = useVersions ? MUTATION_DISCIPLINE_PROD : MUTATION_DISCIPLINE_NO_VERSIONS;
  const dispatch = useVersions ? DISPATCH_RULES_PROD : DISPATCH_RULES_NO_VERSIONS;
  const steering = useVersions ? ASYNC_STEERING_PROD : ASYNC_STEERING_NO_VERSIONS;
  const repoIntel = useVersions ? REPO_INTEL_PROD : REPO_INTEL_NO_VERSIONS;
  const fanOut = useVersions ? FAN_OUT_PROD : FAN_OUT_NO_VERSIONS;
  const handoff = useVersions ? HANDOFF_RULES_PROD : HANDOFF_RULES_NO_VERSIONS;
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
    mutation,
    '',
    repoIntel,
    '',
    dispatch,
    '',
    steering,
    '',
    fanOut,
    '',
    handoff,
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

describe('FEATURE_189 B.5 RECHECK pilot — current-prod env version-header removal', () => {
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
            id: 'v_baseline_current_prod',
            description: 'current production worker-role-prompt with (FEATURE_xxx vX.Y.Z) annotations',
            systemPrompt: buildSystemPrompt(true),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_versions',
            description: 'same current sections; (FEATURE_xxx vX.Y.Z) annotations stripped',
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
        lines.push(`[feature-189-b5-recheck-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_current_prod', 'v_proposed_no_versions']) {
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
          stage: 'feature-189-b5-version-header-recheck-pilot',
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
