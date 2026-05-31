/**
 * Pilot v3: dispatch_child prompt — isolate the quantitative-threshold
 * variable (per user directive 2026-05-21).
 *
 * ## Why v3
 *
 * Pilots v1/v2 (kimi/ark on C5 write-fan-out) revealed two confounders
 * that made claudecode-style wholesale refactor evaluation impossible:
 * 1. Harness binding gap — ark-coding + kimi often emit narrative
 *    `<tool_call>...</tool_call>` markup IN TEXT instead of structured
 *    tool blocks. Binding-only judge under-counts; regex-only judge
 *    over-counts (catches narration of intent that doesn't dispatch).
 * 2. Worktree confounder — the baseline RULE C wording says "Worktrees
 *    are isolated; merge happens at Evaluator review time", which is
 *    psychological reassurance ("safe to dispatch"). v1/v2 V1'''
 *    dropped this reassurance + the whole RULE A/B/C structure
 *    simultaneously; can't attribute the regression.
 *
 * User-directed plan for v3 (more conservative experiment):
 * - DO NOT refactor to claudecode style yet.
 * - Isolate ONE variable: remove only the quantitative thresholds (`≥3`
 *   investigations / `≥45 seconds` / `≥3` modules) from the existing
 *   RULE A/B/C structure. Keep every other character identical.
 * - If V_no_quantitative ≥ V_baseline_quant intent rate (within ±1
 *   cell) on both aliases → quantitative thresholds aren't load-bearing;
 *   safe to remove in v0.7.42 dispatch-prompt cleanup.
 * - If V_no_quantitative regresses on either alias by ≥2 cells →
 *   quantitative thresholds ARE load-bearing; keep the current prompt
 *   exactly as-is; defer claudecode-style restyle to a separate v0.7.43
 *   feature for fresh evaluation. Current v0.7.42 work focuses on
 *   worktree drop (ADR-034 TBD).
 *
 * ## Case choice
 *
 * C4 `read_only_fanout_not_polling` from feature-177-task-output —
 * "audit auth handler patterns across packages/auth, /api, /web, /cli".
 * This case has dispatch as the UNAMBIGUOUS correct answer (multi-
 * package investigation; bash/grep is not an equivalent substitute
 * the way it was for C5 single-line edits). Empty priorMessages,
 * single-turn.
 *
 * ## Judge
 *
 * Reuse feature-177 `judgeReadOnlyFanout` (binding-priority + 9-pattern
 * regex fallback per audit-corrected set from FEATURE_125/170). The
 * judge counts both real structured dispatches AND narrative-tool-call
 * markup — measuring INTENT-TO-DISPATCH, which is what prompt design
 * influences. Production-runtime narrative parser will convert the
 * markup to actual dispatches downstream.
 *
 * Pilot v3 ALSO separately reports `realBindingCount` (structured tool
 * calls only) per cell so we can see the binding/narrative split.
 *
 * ## Budget
 *
 * 2 alias × 2 variant × 5 runs = 20 calls × ~$0.01 = ~$0.20, ~5 min.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-dispatch-prompt-pilot
 *
 * Skips when KIMI_API_KEY + ARK_CODING_API_KEY both absent.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { buildJudges } from '../benchmark/datasets/feature-177-task-output/cases.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-dispatch-prompt-pilot',
);

// Tool surface — identical across variants. Mirrors feature-177
// panel TOOL_DOCS exactly.
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
  '`read` / `grep` / `bash`: standard read-only / mutation tools.',
].join('\n');

// V_baseline_quant — CURRENT post-FEATURE_177-REVERT dispatchRules.
// Includes ≥3 / ≥45s / ≥3 quantitative thresholds.
const DISPATCH_RULES_BASELINE_QUANT = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result.',
].join('\n');

// V_no_quantitative — minimal-diff variant. Replaces 3 quantitative
// phrases with qualitative ones; EVERY OTHER character identical.
// (Compare line-by-line against DISPATCH_RULES_BASELINE_QUANT above.)
const DISPATCH_RULES_NO_QUANTITATIVE = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need multiple independent investigations (e.g. probe several package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take a while (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across multiple modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
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

// C4 case — audit auth handlers across 4 packages. Empty priors,
// single-turn. Dispatch is the unambiguous correct answer.
const USER_MESSAGE_C4 =
  'Audit the auth handler patterns across packages/auth, packages/api, ' +
  'packages/web, and packages/cli — show me any inconsistencies in ' +
  'handler signatures, decorators, or error wrapping.';

const PILOT_ALIASES = ['kimi', 'ark/v4flash'] as const;
const RUNS_PER_CELL = 5;

describe('Pilot v3: dispatch_child prompt — quantitative threshold isolation test', () => {
  const aliases = availableAliases(...PILOT_ALIASES);

  if (aliases.length === 0) {
    it('skips: neither KIMI_API_KEY nor ARK_CODING_API_KEY in env', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  it(
    'kimi+ark × read_only_fanout × 5 runs × 2 variants — quantitative thresholds load-bearing?',
    { timeout: 10 * 60_000 },
    async () => {
      // Reuse FEATURE_177 C4 judge — binding-priority + 9-pattern regex
      // (audit-corrected set from FEATURE_125/170). Counts narrative
      // intent as PASS, which is what we want for prompt-design eval.
      const judges = buildJudges('read_only_fanout_not_polling');

      const variants = [
        {
          id: 'v_baseline_quant',
          description: 'current REVERTED RULE A/B/C with quantitative thresholds (≥3 / ≥45s / ≥3)',
          systemPrompt: buildSystemPrompt(DISPATCH_RULES_BASELINE_QUANT),
          priorMessages: [],
          userMessage: USER_MESSAGE_C4,
        },
        {
          id: 'v_no_quantitative',
          description:
            'minimal-diff variant: same RULE A/B/C structure, qualitative replacements only ' +
            '(≥3 → multiple, ≥45s → a while, ≥3 modules → multiple modules)',
          systemPrompt: buildSystemPrompt(DISPATCH_RULES_NO_QUANTITATIVE),
          priorMessages: [],
          userMessage: USER_MESSAGE_C4,
        },
      ];

      const result = await runBenchmark({
        variants,
        models: aliases,
        judges,
        runs: RUNS_PER_CELL,
      });

      const lines: string[] = [];
      lines.push('[feature-dispatch-prompt-pilot-v3][read_only_fanout_not_polling]');
      lines.push(`  aliases:         ${aliases.join(', ')}`);
      lines.push(`  runs per cell:   ${RUNS_PER_CELL}`);
      lines.push('  judge:           binding + 9-pattern narrative regex (intent rate)');

      for (const variantId of ['v_baseline_quant', 'v_no_quantitative']) {
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
              const reason =
                run.judges.find((j) => !j.passed)?.reason ?? 'unknown';
              failureCount[reason] = (failureCount[reason] ?? 0) + 1;
            }
          }
          const rate = cell.runsRaw.length > 0
            ? ((cellPassed / cell.runsRaw.length) * 100).toFixed(0)
            : 'n/a';
          lines.push(
            `    ${cell.alias.padEnd(16)} intent=${cellPassed}/${cell.runsRaw.length} (${rate}%) | real-binding=${realBindingCount}/${cell.runsRaw.length}`,
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
      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, 'pilot-v3-quantitative-threshold-isolation.json');
      const dump = {
        case: 'read_only_fanout_not_polling',
        stage: 'pilot-v3-quantitative-threshold-isolation',
        polarity: 'must_dispatch_readonly_fanout',
        userDirective: 'isolate quantitative threshold variable; do NOT refactor to claudecode style yet',
        preRegisteredDecision: {
          quantRemovableIff: 'V_no_quantitative intent rate ≥ V_baseline_quant within ±1 cell on both aliases',
          quantLoadBearingIff: 'V_no_quantitative regresses on either alias by ≥2 cells',
        },
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
            regexPassed: run.passed,
            regexJudges: run.judges.map((j) => ({
              name: j.name,
              passed: j.passed,
              reason: j.reason,
            })),
          })),
        })),
      };
      writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`  [dump] ${dumpPath}`);
    },
  );
});
