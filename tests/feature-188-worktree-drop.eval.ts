/**
 * Layer 2 eval — FEATURE_188 (v0.7.42, ADR-034) "claudecode-Parity
 * dispatch_child Architecture — Drop Forced Worktree + Prompt-Level
 * Conflict Awareness".
 *
 * ## Scope
 *
 * 5 alias × 2 case × 2 variant × 5 runs = 100 calls (~$3-5, ~50 min).
 * Canonical alias panel per `feedback_canonical_eval_alias_panel`:
 *   zhipu/glm51 + kimi + mmx/m27 + ark/v4flash + ark/v4pro
 * with `aliasFallback` to DeepSeek-official when ark hits rate-limit
 * (per `feedback_harness_alias_fallback`).
 *
 * ## Variants
 *
 * v_baseline_pre188 — pre-FEATURE_188 dispatchRules (quantitative
 *   thresholds `≥3 / ≥45s / ≥3 modules` + "Worktrees are isolated;
 *   merge happens at Evaluator review time" sentence). This is the
 *   `dispatchRules` that shipped on top of v0.7.41 / pre-revert v0.7.42.
 * v_proposed_post188 — post-FEATURE_188 dispatchRules (qualitative
 *   "multiple independent investigations" / "a while" / "multiple
 *   modules" + worktree-isolated sentence dropped). This is the
 *   `dispatchRules` currently in `worker-role-prompt.ts`.
 *
 * Pilot v3 (2026-05-21, 20 calls) verified the qualitative swap is not
 * load-bearing in isolation. This eval is the SHIP gate for the full
 * FEATURE_188 prompt change.
 *
 * ## Cases
 *
 * C4 read_only_fanout_not_polling — audit auth handlers across 4
 *   packages. Dispatch is the unambiguous correct answer (multi-package
 *   investigation; bash/grep serial is not equivalent).
 *
 * C5 write_fanout_not_polling — edit 3 modules with non-conflicting
 *   changes. RULE C dispatch is the correct answer. This is the CORE
 *   case where worktree drop changes behavior (per ADR-034 §Re-eval
 *   design — C5 is the strict gate).
 *
 * Both cases reuse FEATURE_177 judges (binding-priority + 9-pattern
 * regex fallback for narrative tool-call markup).
 *
 * ## Pre-registered SHIP gate (ADR-034 + v0.7.42.md §Re-eval design)
 *
 *   (a) C4 collateral: v_proposed_post188 intent rate ≥ baseline − 1
 *       cell per alias (5 runs each). Any alias regressing ≥2 cells →
 *       REVERT trigger.
 *   (b) C5 strict (core signal): v_proposed_post188 ≥ v_baseline_pre188
 *       per alias (write fan-out is the worktree-drop behavior signal;
 *       any regression on any alias → REVERT).
 *   (c) Audit disagreement ≤ 10% (LLM-judge regime — see companion
 *       `feature-188-worktree-drop-judge-audit.eval.ts`).
 *   (d) Cell-level binding rate reported separately (no SHIP gate on
 *       it — pilot v3 panel #2 C4/C5 baseline was 0/250, so Δ ≥ 0 is
 *       mathematically achievable but not pre-registerable as "Δ ≥ N
 *       pp" per `feedback_pre_registered_gate_saturation`).
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-188-worktree-drop
 *
 * Skips when canonical alias keys absent.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { buildJudges, type CaseId } from '../benchmark/datasets/feature-177-task-output/cases.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-188-worktree-drop',
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

// Tool surface — identical across variants. Mirrors feature-177 / pilot
// v3 TOOL_DOCS exactly.
const TOOL_DOCS = [
  'Tools you have on this turn:',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly?:boolean (default true), model_hint?:"fast"|"deep"|"balanced" }',
  '  Output: launches a child task in the background. Returns task_id immediately;',
  '          the result arrives in a later turn as <task-completed task_id="…">.',
  '',
  '`task_output`:',
  '  Input:  { task_id:string, block?:boolean (default false), timeout_ms?:number }',
  '  Output: structured envelope; default block=false returns the current snapshot immediately.',
  '',
  '`task_stop`:',
  '  Input:  { task_id:string, reason?:string }',
  '  Output: requests graceful exit of a specific in-flight child task.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
].join('\n');

// Pre-FEATURE_188 dispatchRules — quantitative thresholds + worktree
// isolation sentence. Byte-for-byte identical to v0.7.41 / pre-revert
// v0.7.42 worker-role-prompt.ts dispatchRules (lines 105-110 before
// FEATURE_188 edit).
const DISPATCH_RULES_PRE_188 = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result.',
].join('\n');

// Post-FEATURE_188 dispatchRules — qualitative wording + worktree
// isolation sentence dropped. Byte-for-byte identical to current
// worker-role-prompt.ts dispatchRules (post-FEATURE_188 edit).
const DISPATCH_RULES_POST_188 = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result.',
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
    TOOL_DOCS,
  ].join('\n');
}

// User messages — reuse FEATURE_177 panel #2 user messages so the
// pre/post dump comparisons in c:/tmp/kodax-eval-dumps/feature-177-task-output/
// remain apples-to-apples.
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
  readonly id: CaseId;
  readonly userMessage: string;
}

const CASES: readonly CaseBundle[] = [
  { id: 'read_only_fanout_not_polling', userMessage: USER_MESSAGE_C4 },
  { id: 'write_fanout_not_polling', userMessage: USER_MESSAGE_C5 },
] as const;

describe('FEATURE_188 v0.7.42 — dispatch_child worktree drop + qualitative prompt Layer 2 panel', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no canonical alias key in env', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — 5 alias × 2 variant × ${RUNS_PER_CELL} runs (panel size = ${aliases.length * 2 * RUNS_PER_CELL})`,
      // 30-min per case timeout cap (50 runs × ~30s = 25 min worst case).
      { timeout: 30 * 60_000 },
      async () => {
        const judges = buildJudges(c.id);

        const variants = [
          {
            id: 'v_baseline_pre188',
            description:
              'pre-FEATURE_188 dispatchRules (quantitative thresholds ≥3 / ≥45s / ≥3 modules + "Worktrees are isolated; merge happens at Evaluator review time" sentence). v0.7.41 / pre-revert v0.7.42 shipped form.',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_PRE_188),
            priorMessages: [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_post188',
            description:
              'post-FEATURE_188 dispatchRules (qualitative wording + worktree-isolated sentence dropped). Current worker-role-prompt.ts dispatchRules.',
            systemPrompt: buildSystemPrompt(DISPATCH_RULES_POST_188),
            priorMessages: [],
            userMessage: c.userMessage,
          },
        ];

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-188-worktree-drop][${c.id}]`);
        lines.push(`  aliases:         ${aliases.join(', ')}`);
        lines.push(`  runs per cell:   ${RUNS_PER_CELL}`);
        lines.push('  judge:           binding + 9-pattern narrative regex (intent rate)');

        for (const variantId of ['v_baseline_pre188', 'v_proposed_post188']) {
          const cells = result.byVariant[variantId] ?? [];
          let totalPassed = 0;
          let totalRuns = 0;
          let totalRealBinding = 0;
          lines.push('');
          lines.push(`  --- variant: ${variantId} ---`);
          for (const cell of cells) {
            let cellPassed = 0;
            let realBindingCount = 0;
            const failureCount: Record<string, number> = {};
            for (const run of cell.runsRaw) {
              totalRuns++;
              const hasRealBinding =
                (run.toolCalls ?? []).some((t) => t.name === 'dispatch_child_task');
              if (hasRealBinding) {
                realBindingCount++;
                totalRealBinding++;
              }
              if (run.passed) {
                cellPassed++;
                totalPassed++;
              } else {
                const reason = run.judges.find((j) => !j.passed)?.reason ?? 'unknown';
                failureCount[reason] = (failureCount[reason] ?? 0) + 1;
              }
            }
            const rate = cell.runsRaw.length > 0
              ? ((cellPassed / cell.runsRaw.length) * 100).toFixed(0)
              : 'n/a';
            const fallbackSamples = cell.runsRaw.filter((r) => r.fallbackUsed);
            const fallbackTag = fallbackSamples.length > 0
              ? ` [fallback→${fallbackSamples[0]!.fallbackUsed} ×${fallbackSamples.length}/${cell.runsRaw.length}]`
              : '';
            lines.push(
              `    ${cell.alias.padEnd(16)} intent=${cellPassed}/${cell.runsRaw.length} (${rate}%) | real-binding=${realBindingCount}/${cell.runsRaw.length}${fallbackTag}`,
            );
            const reasons = Object.entries(failureCount);
            if (reasons.length > 0) {
              for (const [reason, count] of reasons) {
                lines.push(`      ✗ ${count}x: ${reason}`);
              }
            }
          }
          const aggRate = totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(0)
            : 'n/a';
          lines.push(
            `  AGGREGATE ${variantId}: intent=${totalPassed}/${totalRuns} (${aggRate}%) | real-binding=${totalRealBinding}/${totalRuns}`,
          );
        }

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // ----- Raw dump per EVAL_GUIDELINES.md §Raw output preservation -----
        // Per `feedback_audit_dump_dir_vanishes`: re-mkdir before each
        // writeFileSync so a Windows tmpdir wipe between mkdirSync and
        // writeFileSync doesn't lose the dump.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-188-layer2-panel',
          polarity:
            c.id === 'read_only_fanout_not_polling'
              ? 'must_dispatch_readonly_fanout'
              : 'must_dispatch_write_fanout',
          behaviour:
            c.id === 'read_only_fanout_not_polling'
              ? 'multi-package audit → RULE A dispatch fan-out'
              : 'non-conflicting 3-module edit → RULE C dispatch fan-out',
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
            userMessage: v.userMessage,
            priorMessages: v.priorMessages ?? [],
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
              regexPassed: run.passed,
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
            })),
          })),
        };
        // Re-mkdir defensively against Windows tmpdir wipe.
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
