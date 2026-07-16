/**
 * Eval: FEATURE_177 (v0.7.45) — `task_output` Worker prompt RULE D.
 *
 * ## Purpose
 *
 * Verifies the v0.7.45 RULE D prompt addition (in `worker-role-prompt.ts`
 * `dispatchRules`, env-flag gated behind `KODAX_TASK_OUTPUT_PROMPT=1`)
 * effectively teaches the Worker LLM the `task_output(task_id, block?,
 * timeout_ms?)` peek pattern WITHOUT regressing:
 *
 *   - RULE A read-only fan-out (cross-case)
 *   - RULE C write fan-out (cross-case)
 *   - IDLE-YIELD wait mechanic (negative case — block:true must not be
 *     used as a wait substitute)
 *
 * ## Five cases (2 POSITIVE + 1 BLOCK-MISUSE NEGATIVE + 2 CROSS-REGRESSION)
 *
 *   1. C1 peek_running_child_user_asked        → must call task_output(block:false)
 *   2. C2 peek_long_running_user_wonders       → must call task_output(block:false)
 *   3. C3 idle_yield_not_block_true            → must idle-yield (no tool_use)
 *   4. C4 read_only_fanout_not_polling         → must dispatch read-only fan-out (RULE A)
 *   5. C5 write_fanout_not_polling             → must dispatch write fan-out  (RULE C)
 *
 * ## Pre-registered SHIP gate
 *
 *   SHIP iff:
 *     (a) C1+C2 (positive) each ≥60% PASS on v_proposed, ≥4-of-5 alias
 *     (b) C3 (block:true misuse) ≥80% PASS on v_proposed, ≥4-of-5 alias
 *     (c) C4+C5 (cross-case) pass rate NOT degraded by >10pp on any alias
 *     (d) LLM-judge majority-vote disagreement ≤10%
 *
 *   PARTIAL: (a) met but (c) shows 10-20pp regression on one alias →
 *            keep prompt OFF default; ship runtime only (already done);
 *            re-design RULE D wording for commit 3/n
 *   REVERT:  (b) or (c) violation (>20pp regression OR <50% PASS on C3)
 *            → drop RULE D entirely; runtime tool stays callable for
 *            programmatic SDK consumers
 *
 * ## Pilot → Phase 1
 *
 * KODAX_EVAL_PILOT_ONLY=1: 1 alias × 1 case × 2 variant × 1 run = 2 calls (~$0.05).
 * Full Phase 1:           5 alias × 5 case × 2 variant × 5 runs = 250 calls (~$10).
 *
 * Pilot uses `ark/v4flash` × `peek_running_child_user_asked` only —
 * the cheapest alias on the canonical coding-plan panel, the case
 * with the most explicit user signal (user asked "check what task_C is
 * doing"), so trigger-firing is most likely. Per
 * `feedback_eval_pilot_before_scale`: confirm the constructed history
 * triggers the targeted behavior before burning the full budget.
 *
 * ## Run
 *
 *   KODAX_EVAL_PILOT_ONLY=1 npm run test:eval -- feature-177-task-output
 *   npm run test:eval -- feature-177-task-output
 *
 * Skips when no provider API keys are present.
 *
 * ## Raw dump
 *
 * `os.tmpdir()/kodax-eval-dumps/feature-177-task-output/<case>.json` per
 * EVAL_GUIDELINES.md §Raw output preservation. Mandatory for LLM-judge
 * audit (anti-pattern 7 §2) — regex assertions may false-negative on
 * verbose CoT output that says "I should NOT call task_output(block:true)"
 * in plain text.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-177-task-output/cases.js';

// EVAL_GUIDELINES says use os.tmpdir() so dumps are transient. On Windows
// machines with aggressive Storage Sense / Temp janitor sweeps (1-2 hr
// cleanup window), the panel→audit gap can exceed the survival window
// and the audit then SKIPs with "dump missing". The KODAX_EVAL_DUMP_DIR
// env var lets the operator point to a non-Temp transient location
// (e.g., c:/tmp/) on those machines. Default unchanged — still OS tmpdir
// per guideline.
const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-177-task-output',
);

// Canonical coding-plan alias panel per
// feedback_canonical_eval_alias_panel + memory 2026-05-21 update
// (DeepSeek dual-archer via ark-coding gateway).
const PHASE1_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
] as const;
const PILOT_ALIAS = 'ark/v4flash' as const;
const PILOT_CASE = 'peek_running_child_user_asked' as const;

// FEATURE_177 v0.7.45 panel lesson: ark-coding's shared coding-plan
// quota drained during the 47-min panel run, wiping 2/5 alias data.
// Fallback to DeepSeek's official API (same models, different gateway)
// when ark hits 429. DeepSeek's per-account quota is higher and
// independent of the ark-coding pool, so panels can complete cleanly.
const ALIAS_FALLBACK = {
  'ark/v4pro': 'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
} as const;

const PILOT_ONLY = process.env.KODAX_EVAL_PILOT_ONLY === '1';
const STAGE_LABEL = PILOT_ONLY
  ? 'pilot-1alias-1case-1run'
  : 'phase1-5alias-5case-5run-with-dump';
const RUNS_PER_CELL = PILOT_ONLY ? 1 : 5;

describe('Eval: FEATURE_177 task_output Worker prompt RULE D (v0.7.45)', () => {
  const aliases = PILOT_ONLY
    ? availableAliases(PILOT_ALIAS)
    : availableAliases(...PHASE1_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  const casesToRun = PILOT_ONLY
    ? CASES.filter((c) => c.id === PILOT_CASE)
    : CASES;

  for (const c of casesToRun) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 45 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-177-task-output][${c.id}]`);
        lines.push(`  polarity:        ${c.polarity}`);
        lines.push(`  behaviour:       ${c.behaviour}`);
        lines.push(`  primary judge:   ${PRIMARY_JUDGE ?? '(none)'}`);

        for (const variantId of ['v_baseline', 'v_proposed']) {
          const cells = result.byVariant[variantId] ?? [];
          let totalRuns = 0;
          let totalPassed = 0;
          lines.push('');
          lines.push(`  --- variant: ${variantId} ---`);
          for (const cell of cells) {
            let cellPassed = 0;
            const failureCount: Record<string, number> = {};
            for (const run of cell.runsRaw) {
              totalRuns++;
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
              `    ${cell.alias.padEnd(16)} ${cellPassed}/${cell.runsRaw.length} (${rate}%)`,
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
          lines.push(`  AGGREGATE ${variantId}: ${totalPassed}/${totalRuns} (${aggRate}%)`);
        }

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // ----- Raw dump per EVAL_GUIDELINES.md §Raw output preservation -----
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          polarity: c.polarity,
          behaviour: c.behaviour,
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
  }
});
