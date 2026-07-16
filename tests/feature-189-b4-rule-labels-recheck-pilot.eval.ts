/**
 * Re-check Pilot — FEATURE_189 B.4 RULE A/B/C label removal — 2026-05-24
 *
 * Re-evaluates the 2026-05-22 eval-driven DROP under current production
 * worker-role-prompt environment. The original B.4 pilot (2026-05-22) used
 * a 4-bullet synthetic dispatch section (RULE A/B/C only) representing the
 * dispatch block at that point in time. Since DROP, the dispatch section
 * has grown to 9 bullets with 5 categorical anchors (RULE A/B/C +
 * DISPATCH OBJECTIVE QUALITY + DISPATCH OBJECTIVE GUIDANCE + SPECIALIST
 * ROUTING — see worker-role-prompt.ts:118-138 commits 7e471b4c F191 +
 * F169 expansion).
 *
 * Under the "anchor density" hypothesis from the original DROP rationale
 * (RULE labels = floor model's only categorical anchor → removing them
 * destabilizes classification), the current production environment with
 * 5 categorical anchors should be MORE robust to RULE removal than the
 * DROP-time 3-anchor synthetic test. This recheck verifies the prediction
 * empirically.
 *
 * Variants:
 *   v_baseline_current_prod  — current 9-bullet dispatch section with
 *                               RULE A/B/C labels (production-byte-aligned
 *                               with worker-role-prompt.ts:118-138).
 *   v_proposed_no_rule_labels — same 9 bullets but RULE A/B/C labels
 *                               stripped (use-case descriptions preserved).
 *
 * 1 alias (ark/v4flash) × 2 case × 2 variant × 3 runs = 12 cells, ~$0.30.
 *
 * Pre-registered SHIP gate (decision-matrix-style):
 *   A: Both cases v_proposed ≥ v_baseline − 1 cell → DROP candidate
 *      overturn → escalate to 5-alias panel + 3-judge audit on
 *      current-prod snapshot for ship-gate confirmation
 *   B: Either case v_proposed ≤ v_baseline − 2 cells → DROP holds;
 *      log re-pilot evidence with date stamp, no further escalation
 *   C: Mixed / borderline (1-cell delta) → noise floor; needs panel
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b4-rule-labels-recheck-pilot
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
  'feature-189-b4-rule-labels-recheck-pilot',
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
  '  Input:  { subject:string, activeForm:string }',
  '  Output: appends one plan-list item; the user sees it as the agent\'s real-time progress dashboard.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// Current production worker-role-prompt.ts:118-138 (byte-aligned 2026-05-24).
const DISPATCH_RULES_CURRENT_PROD = [
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

// Same 9 bullets as CURRENT_PROD but RULE A/B/C labels stripped — use-case
// descriptions preserved verbatim. This isolates the marginal effect of
// removing RULE labels in the current 5-categorical-anchor environment.
const DISPATCH_RULES_NO_RULE_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- Read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- Write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
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

const FAN_OUT_PLAN_GRANULARITY = [
  'FAN-OUT PLAN GRANULARITY:',
  '- When you are about to dispatch several children in parallel, first emit a `todo_create` call for each one so the user sees per-child progress instead of a 30-60s black box. One todo per child — use the child\'s objective as the subject.',
  '- Mark each item `in_progress` just before its `dispatch_child_task` call, and `completed` when the matching `<task-completed>` block arrives.',
  '- If mid fan-out you decide to dispatch another child, add the matching todo before the new dispatch.',
].join('\n');

function buildSystemPrompt(dispatchRules: string): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    dispatchRules,
    '',
    FAN_OUT_PLAN_GRANULARITY,
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

describe('FEATURE_189 B.4 RECHECK pilot — current-prod env RULE label removal', () => {
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
            description: 'current production 9-bullet dispatch with RULE A/B/C labels',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_CURRENT_PROD),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_rule_labels',
            description: 'current 9-bullet dispatch; RULE A/B/C labels stripped (4 categorical anchors remain)',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_NO_RULE_LABELS),
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
        lines.push(`[feature-189-b4-recheck-pilot][${c.id}]`);
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
          stage: 'feature-189-b4-rule-labels-recheck-pilot',
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
