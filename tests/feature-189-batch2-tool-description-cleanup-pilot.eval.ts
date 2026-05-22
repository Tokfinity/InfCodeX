/**
 * Pilot — FEATURE_189 Batch 2: Tool description structural cleanup.
 *
 * Restructures todo_create / todo_update / todo_get descriptions:
 *   - numbered rules (1)-(N) → bullet `-` list
 *   - drop LLM-visible FEATURE_xxx vX.Y.Z references
 *   - split compound concept "patch fields with status transition in one call" into 2 sentences
 *
 * Risk class per ADR-033 §4: enumerated label removal CAN trigger floor /
 * mid-tier model anchor regression (B.4 lesson). Pilot first to detect.
 *
 * 1 alias (ark/v4flash) × 4 case × 2 variant × 3 runs = 24 cells, ~$0.5.
 *
 * Cases:
 *   C1 — initial plan commitment (5-step task, batch todo_create)
 *   C2 — status transition + activeForm patch (todo_update mid-task)
 *   C3 — staleness recovery (todo_get before todo_update)
 *   C4 — cancelled vs deleted distinction (status enum semantics)
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch2-tool-description-cleanup-pilot
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
  'feature-189-batch2-tool-description-cleanup-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = { 'ark/v4flash': 'ds/v4flash' };
const RUNS_PER_CELL = 3;

// ---------- v_baseline (numbered rules + FEATURE_xxx) ----------

const TODO_CREATE_BASELINE = `\`todo_create\`: Insert ONE new pending item into the visible plan list. Use this for plan commitment (one call per planned step, batched in the same response) AND for mid-task additive growth when you realize an extra step is needed. Each todo_create is purely additive — existing items are untouched. Rules: (1) The store auto-generates the id. Do NOT pass an id. (2) \`subject\` is required (brief imperative title; keep ≤80 chars). (3) Optional \`description\` carries fuller context. (4) Supply \`activeForm\` (present-continuous, e.g. "Running tests"). (5) Optional \`evaluator: "build" | "test" | "lint"\` (FEATURE_114). (6) Optional \`metadata\` object.`;

const TODO_UPDATE_BASELINE = `\`todo_update\`: Drive the visible plan checklist. PRIMARY MODE is \`op="update"\` (default). Rules: (1) Set status="in_progress" BEFORE starting work. (2) Set status="completed" AFTER finishing. (3) Only ONE in_progress at a time. (4) Use status="failed" if attempt failed. (5) Use status="skipped" only when item turned out unnecessary. (6) Use status="cancelled" (FEATURE_114) when dropping an item mid-execution — UI shows strikethrough. (7) FEATURE_170 v0.7.41: Use status="deleted" to remove the item from the visible list entirely. (8) When transitioning to status="in_progress", ALWAYS supply \`activeForm\`. (9) FEATURE_170 v0.7.41 + v0.7.42 — on op="update" you may patch fields without changing status: subject, description, evaluator, metadata. Combining patch fields with a status transition in one call is supported.`;

const TODO_GET_BASELINE = `\`todo_get\`: v0.7.42 — read-only single-item lookup. Returns the full TodoItem detail. Use this: (1) BEFORE calling todo_update when uncertain about an item's current state. (2) WHEN PICKING UP an item — the full description carries the work instruction. (3) AFTER an "Unknown todo id" error on todo_update.`;

// ---------- v_proposed (bullets, no FEATURE_xxx) ----------

const TODO_CREATE_PROPOSED = `\`todo_create\`: Insert ONE new pending item into the visible plan list — purely additive, existing items untouched. Use for plan commitment (one call per planned step, batched in the same response) AND for mid-task additive growth when an extra step is needed.

Field semantics:
- \`subject\` (required) — brief imperative title shown in the plan-list row
- \`description\` (optional) — fuller context / work instructions read when this item is later picked up via todo_get
- \`activeForm\` (optional) — present-continuous form (e.g. "Running tests") shown by the spinner when this item later flips to \`in_progress\`
- \`evaluator\` (optional, "build" | "test" | "lint") — runs the corresponding deterministic check when the item flips to "completed". Use sparingly
- \`metadata\` (optional) — opaque key-value bag for extension hooks

The store auto-generates the id. Never pass an id — any caller-supplied id is rejected at the schema layer.`;

const TODO_UPDATE_PROPOSED = `\`todo_update\`: Drive the visible plan checklist — single-item PATCH plus status transition. \`op="update"\` (default) is the primary mode.

Status transitions:
- \`in_progress\` — set BEFORE starting work. When transitioning to \`in_progress\`, ALWAYS supply \`activeForm\` (present-continuous rephrasing of the subject).
- \`completed\` — set AFTER finishing.
- Only ONE item should be \`in_progress\` at a time.
- \`failed\` — an attempt clearly failed and needs retry.
- \`skipped\` — the item turned out to be unnecessary.
- \`cancelled\` — you decide mid-execution to drop an item the user no longer needs; UI shows strikethrough as a visible breadcrumb.
- \`deleted\` — remove the item from the visible list entirely (no breadcrumb). Prefer \`deleted\` when the item was wholly off-plan; prefer \`cancelled\` when the user benefits from seeing the discarded record.

Field patches (status optional when only patching):
- \`subject\` (non-empty string) replaces the title.
- \`description\` replaces the fuller context.
- \`evaluator\` ("build" | "test" | "lint") replaces the evaluator hint.
- \`metadata\` (object | null) — shallow-merge; null inside clears a key; null outside clears all.
- Patch fields can be combined with a status transition in a single call.`;

const TODO_GET_PROPOSED = `\`todo_get\`: Read-only single-item lookup. Returns the full TodoItem detail.

When to use:
- BEFORE calling todo_update when uncertain about an item's current state — runner-side auto-handlers may have flipped statuses between turns.
- WHEN PICKING UP an item — the full description carries the work instruction.
- AFTER an "Unknown todo id" error — first todo_list to see all ids, then todo_get to drill in.`;

function buildPrompt(variant: 'baseline' | 'proposed'): string {
  const tc = variant === 'baseline' ? TODO_CREATE_BASELINE : TODO_CREATE_PROPOSED;
  const tu = variant === 'baseline' ? TODO_UPDATE_BASELINE : TODO_UPDATE_PROPOSED;
  const tg = variant === 'baseline' ? TODO_GET_BASELINE : TODO_GET_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent.",
    '',
    'PLAN-FIRST CONTRACT: For non-trivial tasks (multiple steps OR multiple files), your FIRST tool calls MUST be a batch of `todo_create` — one call per planned step — to commit the full plan up front.',
    '',
    '## Tools',
    '',
    tc,
    '',
    tu,
    '',
    tg,
    '',
    '`todo_list`: returns the current plan list as JSON.',
    '',
    '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
  ].join('\n');
}

// ---------- Cases ----------

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

const CASE_C1: CaseBundle = {
  id: 'C1_initial_plan',
  userMessage:
    'Audit the auth module across packages/auth, packages/api, packages/web, packages/cli — produce ' +
    'a report listing inconsistencies in handler signatures, decorators, and error wrapping.',
};

const CASE_C2: CaseBundle = {
  id: 'C2_status_transition',
  userMessage: 'Mark todo_2 as in_progress now — I\'m about to start running the failing tests.',
  priorMessages: [
    { role: 'assistant', content: '<todo_create subject="Audit handleAuth callers" activeForm="Auditing handleAuth callers" />\n<todo_create subject="Run failing tests" activeForm="Running failing tests" />\n<todo_create subject="Fix error wrapping" activeForm="Fixing error wrapping" />' },
    { role: 'user', content: '[Plan committed. Active todos: todo_1 (Audit), todo_2 (Run failing tests), todo_3 (Fix error wrapping). All pending.]' },
  ],
};

const CASE_C3: CaseBundle = {
  id: 'C3_staleness',
  userMessage:
    "I've been thinking through a different approach while you were waiting. Please update todo_2 to mark it completed — actually wait, you should first check what state it's in now. The runner may have already auto-handled some things.",
  priorMessages: [
    { role: 'assistant', content: '<todo_create subject="Audit handleAuth callers" />\n<todo_create subject="Run failing tests" />\n<todo_create subject="Fix error wrapping" />' },
    { role: 'user', content: '[15 min later — Plan list state may have changed due to runner-side auto-handlers.]' },
  ],
};

const CASE_C4: CaseBundle = {
  id: 'C4_cancelled_vs_deleted',
  userMessage:
    "Actually, scrap todo_3 — the error wrapping fix turned out to be irrelevant to this audit, I had misunderstood the original report. I don't want it to appear in the user-visible progress list at all, no strikethrough or anything. What status should I set?",
  priorMessages: [
    { role: 'assistant', content: '<todo_create subject="Audit handleAuth callers" />\n<todo_create subject="Run failing tests" />\n<todo_create subject="Fix error wrapping" />' },
    { role: 'user', content: '[Plan committed.]' },
  ],
};

const CASES: readonly CaseBundle[] = [CASE_C1, CASE_C2, CASE_C3, CASE_C4] as const;

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

// C1: PASS if model emits ≥3 todo_create calls upfront (initial plan committed via batch)
function judgeC1(out: string, context?: JudgeContext): JudgeResult {
  const todoCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'todo_create');
  if (todoCalls.length >= 3) return { passed: true };
  const textCount = (out.match(/\btodo_create\b/gi) ?? []).length;
  if (textCount >= 3 && invokesTool(out, 'todo_create')) return { passed: true };
  return { passed: false, reason: `only ${todoCalls.length} binding / ${textCount} text todo_create (need ≥3 for 4-package audit)` };
}

// C2: PASS if model invokes todo_update with id=todo_2 + status=in_progress + activeForm field
function judgeC2(out: string, context?: JudgeContext): JudgeResult {
  const updateCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'todo_update');
  for (const c of updateCalls) {
    const input = c.input as { id?: string; status?: string; activeForm?: string } | undefined;
    if (input?.id === 'todo_2' && input?.status === 'in_progress' && typeof input?.activeForm === 'string' && input.activeForm.length > 0) {
      return { passed: true };
    }
  }
  // Text fallback
  const hasUpdate = invokesTool(out, 'todo_update');
  const hasTodo2 = /\btodo_2\b/.test(out);
  const hasInProgress = /in_progress|"in_progress"/.test(out);
  const hasActiveForm = /activeForm/i.test(out);
  if (hasUpdate && hasTodo2 && hasInProgress && hasActiveForm) return { passed: true };
  if (hasUpdate && hasTodo2 && hasInProgress) return { passed: false, reason: 'missing activeForm field' };
  return { passed: false, reason: `todo_update markup incomplete (hasUpdate=${hasUpdate} hasTodo2=${hasTodo2} hasInProgress=${hasInProgress})` };
}

// C3: PASS if model invokes todo_get/todo_list BEFORE todo_update
function judgeC3(out: string, context?: JudgeContext): JudgeResult {
  const tcalls = context?.toolCalls ?? [];
  const getIdx = tcalls.findIndex((t) => t.name === 'todo_get' || t.name === 'todo_list');
  const updIdx = tcalls.findIndex((t) => t.name === 'todo_update');
  if (getIdx >= 0 && (updIdx < 0 || getIdx < updIdx)) return { passed: true };
  // Text fallback: check order in raw text
  const getMatch = Math.min(
    out.search(/\btodo_get\b/) >= 0 ? out.search(/\btodo_get\b/) : Infinity,
    out.search(/\btodo_list\b/) >= 0 ? out.search(/\btodo_list\b/) : Infinity,
  );
  const updMatch = out.search(/\btodo_update\b/);
  if (getMatch !== Infinity && (updMatch < 0 || getMatch < updMatch)) {
    if (invokesTool(out, 'todo_get') || invokesTool(out, 'todo_list')) return { passed: true };
  }
  if (invokesTool(out, 'todo_update') && !invokesTool(out, 'todo_get') && !invokesTool(out, 'todo_list')) {
    return { passed: false, reason: 'todo_update invoked without prior todo_get/todo_list (staleness check skipped)' };
  }
  return { passed: false, reason: 'no todo_get / todo_list invocation before todo_update' };
}

// C4: PASS if model uses status="deleted" (NOT cancelled) — user asked for no strikethrough
function judgeC4(out: string, context?: JudgeContext): JudgeResult {
  const updateCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'todo_update');
  for (const c of updateCalls) {
    const input = c.input as { id?: string; status?: string } | undefined;
    if (input?.id === 'todo_3' && input?.status === 'deleted') return { passed: true };
    if (input?.id === 'todo_3' && input?.status === 'cancelled') {
      return { passed: false, reason: 'used "cancelled" (UI shows strikethrough) when user explicitly asked for no breadcrumb' };
    }
  }
  // Text fallback
  if (/status\s*[:=]\s*["']deleted["']/.test(out) && /todo_3/.test(out)) return { passed: true };
  if (/status\s*[:=]\s*["']cancelled["']/.test(out) && /todo_3/.test(out)) {
    return { passed: false, reason: 'narrative chose cancelled instead of deleted (UI breadcrumb mismatch)' };
  }
  // Also accept narrative answering "deleted" without invoking tool yet (user asked WHAT STATUS)
  if (/\b(use\s+)?["']?status["']?\s*[:=]?\s*["']deleted["']/i.test(out) || /\bdeleted\b[\s\S]{0,80}\b(no strikethrough|no breadcrumb|wholly off-plan|completely remove)/i.test(out)) return { passed: true };
  if (/\b["']deleted["']\b/i.test(out) && !/cancelled/i.test(out)) return { passed: true };
  if (/\b["']cancelled["']\b/i.test(out) && !/deleted/i.test(out)) {
    return { passed: false, reason: 'narrative answered cancelled (breadcrumb) when user wanted no breadcrumb' };
  }
  return { passed: false, reason: 'unclear answer about cancelled vs deleted distinction' };
}

const JUDGE_BY_CASE: Record<string, PromptJudge> = {
  C1_initial_plan: { name: 'initial_plan_batch', category: 'correctness', judge: judgeC1 },
  C2_status_transition: { name: 'status_with_activeForm', category: 'correctness', judge: judgeC2 },
  C3_staleness: { name: 'staleness_check_first', category: 'correctness', judge: judgeC3 },
  C4_cancelled_vs_deleted: { name: 'deleted_for_no_breadcrumb', category: 'correctness', judge: judgeC4 },
};

describe('FEATURE_189 Batch 2 pilot — Tool description cleanup (numbered→bullet + drop version meta)', () => {
  const aliases = availableAliases(...PILOT_PANEL);
  if (aliases.length === 0) { it('skips: no pilot alias key in env', () => { /* no-op */ }); return; }

  for (const c of CASES) {
    const judge = JUDGE_BY_CASE[c.id]!;
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_numbered_with_versions',
            description: 'numbered (1)-(N) rules + FEATURE_xxx vX.Y.Z markers preserved',
            systemPrompt: buildPrompt('baseline'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_bullets_no_versions',
            description: 'numbered → bullets + FEATURE_xxx vX.Y.Z removed + compound concept split',
            systemPrompt: buildPrompt('proposed'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
        ];
        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: [judge],
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });
        const lines: string[] = [];
        lines.push(`[feature-189-batch2-pilot][${c.id}] judge=${judge.name}`);
        for (const vid of ['v_baseline_numbered_with_versions', 'v_proposed_bullets_no_versions']) {
          const cells = result.byVariant[vid] ?? [];
          lines.push(`  --- ${vid} ---`);
          for (const cell of cells) {
            const pass = cell.runsRaw.filter((r) => r.judges.find((j) => j.name === judge.name)?.passed).length;
            lines.push(`    ${cell.alias.padEnd(14)} ${judge.name}=${pass}/${cell.runsRaw.length}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-batch2-tool-description-cleanup-pilot',
          judgeName: judge.name,
          startedAt: result.startedAt,
          variants: variants.map((v) => ({ id: v.id, description: v.description, systemPrompt: v.systemPrompt, userMessage: v.userMessage, priorMessages: v.priorMessages })),
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
              regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
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
