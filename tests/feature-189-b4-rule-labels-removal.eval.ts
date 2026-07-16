/**
 * Layer 2 panel — FEATURE_189 Phase B sub-block B.4: RULE A/B/C label removal.
 *
 * ## Why
 *
 * ADR-033 §4 (no enumerated taxonomies) — claudecode 同位置 prompt 0 处
 * RULE label。KodaX worker-role-prompt.ts:115-117 用 `RULE A` / `RULE B` /
 * `RULE C` 三个标签把 dispatchRules 分类，违反 ADR-033 §4。
 *
 * FEATURE_188 (v0.7.42) 改了 dispatchRules 的量化阈值（`≥3 children`→`multiple`
 * 等）但**没动 RULE label**——本 eval 验证去掉 RULE label 后 dispatch
 * 行为不退化。Use-case 描述保留（`Read-only fan-out: ...` /
 * `Long-running probes: ...` / `Write fan-out: ...`）— 只删 enumerated
 * label，不改 use-case 内容或措辞。
 *
 * ## Scope (B.4 only — minimal diff)
 *
 *   Before: `- RULE A — read-only fan-out: when you need multiple ...`
 *   After:  `- Read-only fan-out: when you need multiple ...`
 *
 * 3 行各删 1 个 9-char `RULE X — ` prefix；use-case 描述全部保留；其它
 * dispatchRules 段（IDLE-YIELD / LARGE CHILD OUTPUT / MODEL HINT / DISPATCH
 * OBJECTIVE QUALITY / DISPATCH OBJECTIVE GUIDANCE）不动。
 *
 * ## Variants
 *
 *   v_baseline_with_rules — 当前生产（含 RULE A/B/C labels）
 *   v_proposed_no_labels  — 同生产但删 3 个 `RULE X — ` prefix
 *
 * ## Cases (复用 feature-plan-first-claudecode panel 已验证 cases)
 *
 *   audit_4_packages — 触发 RULE A read-only fan-out（验证 label 删除后
 *                      read-only fan-out 行为不退化）
 *   edit_3_modules   — 触发 RULE C write fan-out（验证 label 删除后
 *                      write fan-out 行为不退化）
 *
 * RULE B (long-running probe) 不在 case scope —— 这两个 cases 触发不到
 * RULE B 场景；若 panel 结果显示 RULE A/C 无退化，default 假设 RULE B 同样
 * 无退化（pure label removal 不改 use-case 措辞）。RULE B 单独 case 可作
 * follow-up 加。
 *
 * ## Scope
 *
 * 5 alias × 2 case × 2 variant × 5 runs = 100 cells, ~$3-5, ~25 min wall.
 * Companion judge-audit eval re-judges via 3-judge majority vote.
 *
 * ## Pre-registered SHIP gate
 *
 *   (a) plan_first_compliance (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case.
 *   (b) dispatch_intent (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case. (Primary actionable metric — label 删除
 *       不应抑制 dispatch 行为。)
 *   (c) audit disagreement ≤ 10% → DATA VALID per
 *       `feedback_audit_must_see_binding` + `feedback_regex_judge_semantic_must_align`.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b4-rule-labels-removal
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
  'feature-189-b4-rule-labels-removal',
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
  '  Input:  { subject:string, activeForm:string }',
  '  Output: appends one plan-list item; the user sees it as the agent\'s real-time progress dashboard.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// v_baseline_with_rules — current production worker-role-prompt.ts:115-117.
const DISPATCH_RULES_WITH_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
].join('\n');

// v_proposed_no_labels — RULE A/B/C labels removed; use-case description preserved.
const DISPATCH_RULES_NO_LABELS = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- Read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- Long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- Write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
].join('\n');

// FAN-OUT PLAN GRANULARITY (claudecode 3-bullet, ship 1e60eeb0) — identical
// in both variants, isolating the RULE label variable.
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

// Lenient plan_first per feedback_regex_judge_semantic_must_align —
// "plan committed" is PASS regardless of dispatch follow-through;
// dispatch_intent judges that separately.
function judgePlanFirstCompliance(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const todoIdx = toolCalls.findIndex((t) => t.name === 'todo_create');
  const dispatchIdx = toolCalls.findIndex((t) => t.name === 'dispatch_child_task');
  if (todoIdx >= 0 && dispatchIdx >= 0) {
    if (todoIdx < dispatchIdx) return { passed: true };
    return { passed: false, reason: 'todo_create AFTER dispatch (binding) — plan-first violated' };
  }
  if (todoIdx >= 0 && dispatchIdx < 0) {
    return { passed: true };
  }
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
  if (!todoFound && dispatchFound) {
    return { passed: false, reason: 'dispatch without todo_create (text)' };
  }
  if (todoFound && !dispatchFound) {
    return { passed: true };
  }
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

describe('FEATURE_189 B.4 — RULE A/B/C label removal (ADR-033 §4 application)', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no canonical alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 30 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_with_rules',
            description: 'current production worker-role-prompt.ts:115-117 with RULE A/B/C labels',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_WITH_LABELS),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_no_labels',
            description: 'RULE A/B/C labels removed; use-case descriptions preserved (ADR-033 §4)',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_NO_LABELS),
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
        lines.push(`[feature-189-b4][${c.id}]`);
        lines.push(`  aliases:         ${aliases.join(', ')}`);
        lines.push(`  runs per cell:   ${RUNS_PER_CELL}`);
        lines.push('  judges:          plan_first_compliance (lenient) + dispatch_intent (binding-priority + 9-pattern regex)');

        for (const variantId of ['v_baseline_with_rules', 'v_proposed_no_labels']) {
          const cells = result.byVariant[variantId] ?? [];
          let aggPlanFirst = 0, aggDispatch = 0, aggTotal = 0;
          lines.push('');
          lines.push(`  --- variant: ${variantId} ---`);
          for (const cell of cells) {
            const planFirstPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'plan_first_compliance')?.passed,
            ).length;
            const dispatchPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'dispatch_intent')?.passed,
            ).length;
            aggPlanFirst += planFirstPass;
            aggDispatch += dispatchPass;
            aggTotal += cell.runsRaw.length;
            const fallbackSamples = cell.runsRaw.filter((r) => r.fallbackUsed);
            const fallbackTag = fallbackSamples.length > 0
              ? ` [fallback→${fallbackSamples[0]!.fallbackUsed} ×${fallbackSamples.length}/${cell.runsRaw.length}]`
              : '';
            lines.push(
              `    ${cell.alias.padEnd(14)} plan-first=${planFirstPass}/${cell.runsRaw.length}  dispatch=${dispatchPass}/${cell.runsRaw.length}${fallbackTag}`,
            );
          }
          lines.push(
            `  AGGREGATE ${variantId}: plan-first=${aggPlanFirst}/${aggTotal} (${aggTotal > 0 ? ((aggPlanFirst/aggTotal)*100).toFixed(0) : 'n/a'}%)  dispatch=${aggDispatch}/${aggTotal} (${aggTotal > 0 ? ((aggDispatch/aggTotal)*100).toFixed(0) : 'n/a'}%)`,
          );
        }

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-b4-rule-labels-removal-panel',
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
