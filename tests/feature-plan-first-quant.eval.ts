/**
 * Layer 2 panel — ADR-033 hygiene follow-up to FEATURE_188.
 *
 * Tests whether the PLAN-FIRST block's quantitative `≥3 children`
 * trigger can be replaced with qualitative `multiple children` without
 * regressing plan-first compliance or dispatch intent.
 *
 * ## Prior evidence
 *
 *   - FEATURE_188 panel (5 alias × 2 case × 2 variant × 5 runs = 100
 *     cells, both variants used the same `≥3 children` PLAN-FIRST
 *     block) showed **0/100 plan-first compliance** via binding +
 *     9-pattern regex. The `≥3 children` MANDATORY rule is structurally
 *     ignored by all 5 alias on multi-child tasks.
 *   - 2026-05-22 pilot (1 alias × 2 case × 2 variant × 3 runs = 12
 *     cells): 1/6 narrative-todo emission in v_baseline (no dispatch
 *     follow-through); 0/6 in v_proposed. Indistinguishable at the
 *     intent-vs-action floor.
 *
 * ## Scope
 *
 * Canonical 5-alias panel × 2 case (C4 audit_4_packages + C5
 * edit_3_modules) × 2 variant × 5 runs = 100 cells. ~$3, ~30 min wall.
 *
 * Companion `feature-plan-first-quant-judge-audit.eval.ts` does the
 * 3-judge LLM majority-vote audit per `feedback_audit_must_see_binding`
 * + `feedback_audit_binding_priority_in_prompt`.
 *
 * ## Variants — only PLAN-FIRST `MANDATORY TRIGGER` line differs
 *
 *   v_baseline_plan_quant  — `≥3 children` (current production)
 *   v_proposed_plan_qual   — `multiple children` (qualitative swap)
 *
 * Both use the post-FEATURE_188 dispatchRules to isolate the
 * PLAN-FIRST variable.
 *
 * ## Pre-registered SHIP gate
 *
 *   (a) plan_first_compliance (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case. Below saturation floor (0%) regression
 *       is impossible.
 *   (b) dispatch_intent (judge view): v_proposed ≥ v_baseline − 1
 *       cell per alias × case (FEATURE_188 baseline preserved).
 *   (c) audit disagreement ≤ 10% → DATA VALID.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-plan-first-quant
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
  'feature-plan-first-quant',
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

const DISPATCH_RULES = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
].join('\n');

function buildPlanFirstBlock(triggerLine: string): string {
  return [
    'FAN-OUT PLAN GRANULARITY (FEATURE_151 Slice I, v0.7.38 + v0.7.42 schema split):',
    triggerLine,
    '- COUNT-FIRST RULE: before the batch, count the exact number N of `dispatch_child_task` calls you will make. Emit EXACTLY N `todo_create` calls — ONE per child\'s objective, mirroring each child\'s `bundle.objective` literally (e.g. child reviewing `packages/foo` ⇒ item `subject:"Review packages/foo"`). Not 1 collapsed item. Not 2. Not N-1. Exactly N.',
    '- WORKED EXAMPLE — 5 packages ⇒ exactly 5 todo_create calls (emit them in the same response so they batch):',
    '    todo_create({subject:"Audit packages/llm",    activeForm:"Auditing packages/llm"})',
    '    todo_create({subject:"Audit packages/agent",  activeForm:"Auditing packages/agent"})',
    '    todo_create({subject:"Audit packages/coding", activeForm:"Auditing packages/coding"})',
    '    todo_create({subject:"Audit packages/repl",   activeForm:"Auditing packages/repl"})',
    '    todo_create({subject:"Audit packages/skills", activeForm:"Auditing packages/skills"})',
    '- ANTI-PATTERNS (NEVER emit any of these):',
    '    BAD: skip todo_create and go straight to dispatch_child_task                       (violates plan-first)',
    '    BAD: one todo_create with subject:"Fan out review across 5 packages"               (1 item collapses N children)',
    '    BAD: two todo_create calls collapsing 5 children into "Review all" + "Aggregate"   (hides per-package progress)',
    '    BAD: any todo_create batch shorter than the number of dispatch_child_task calls.',
    '- Mark each item `in_progress` just before the corresponding `dispatch_child_task`, and `completed` when the matching `<task-completed task_id="…">` block arrives in your next user message (`failed` if the child crashes / times out).',
    '- LATE-DISCOVERED CHILD: if you decide mid-fan-out to dispatch an N+1th child, add the matching item with `todo_create({subject:"...", activeForm:"..."})` BEFORE the new `dispatch_child_task`. Each `todo_create` is purely additive — existing items are untouched.',
    '- Rationale: the plan list IS the user\'s progress dashboard during 30-60s fan-outs. Collapsing N dispatches into fewer items, or skipping the plan altogether, turns parallel work into a black box and hides 30+ seconds of progress. "Dispatching N children" IS N distinct steps from the user\'s viewpoint, never fewer.',
  ].join('\n');
}

const PLAN_FIRST_QUANT_TRIGGER =
  '- MANDATORY TRIGGER: when you intend to dispatch ≥3 children (`dispatch_child_task` per RULE A or RULE C), your FIRST tool calls MUST be a batch of `todo_create` — one call per planned child. No exceptions — even if the user phrases the task as "just go review X, Y, Z", commit the plan first.';
const PLAN_FIRST_QUAL_TRIGGER =
  '- MANDATORY TRIGGER: when you intend to dispatch multiple children (`dispatch_child_task` per RULE A or RULE C), your FIRST tool calls MUST be a batch of `todo_create` — one call per planned child. No exceptions — even if the user phrases the task as "just go review X, Y, Z", commit the plan first.';

function buildSystemPrompt(planFirstBlock: string): string {
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    DISPATCH_RULES,
    '',
    planFirstBlock,
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
  if (todoIdx >= 0 && dispatchIdx < 0) {
    return { passed: false, reason: 'todo_create called, no dispatch follow-through (binding)' };
  }
  if (todoIdx < 0 && dispatchIdx >= 0) {
    return { passed: false, reason: 'dispatch without prior todo_create (binding) — MANDATORY violated' };
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
    return { passed: false, reason: 'dispatch without todo_create (text) — MANDATORY violated' };
  }
  if (todoFound && !dispatchFound) {
    return { passed: false, reason: 'todo_create narrative, no dispatch follow-through (text)' };
  }
  return { passed: false, reason: 'neither todo_create nor dispatch_child_task invoked (no fan-out at all)' };
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

describe('PLAN-FIRST quant→qual canonical panel (ADR-033 hygiene follow-up to FEATURE_188)', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no canonical alias key in env', () => {
      // No-op.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 30 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_plan_quant',
            description: 'current PLAN-FIRST MANDATORY TRIGGER with "≥3 children" quantitative threshold',
            systemPrompt: buildSystemPrompt(buildPlanFirstBlock(PLAN_FIRST_QUANT_TRIGGER)),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_plan_qual',
            description: 'qualitative swap — "multiple children" replaces "≥3 children" (minimal-diff)',
            systemPrompt: buildSystemPrompt(buildPlanFirstBlock(PLAN_FIRST_QUAL_TRIGGER)),
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
        lines.push(`[feature-plan-first-quant][${c.id}]`);
        lines.push(`  aliases:         ${aliases.join(', ')}`);
        lines.push(`  runs per cell:   ${RUNS_PER_CELL}`);
        lines.push('  judges:          plan_first_compliance + dispatch_intent (binding-priority + 9-pattern regex)');

        for (const variantId of ['v_baseline_plan_quant', 'v_proposed_plan_qual']) {
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
          stage: 'plan-first-quant-vs-qual-canonical-panel',
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
