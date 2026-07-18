/**
 * Eval: FEATURE_170 (v0.7.41) — Prompt iteration pilot for zhipu C3 -60pp.
 *
 * ## Purpose
 *
 * The main FEATURE_170 Layer 2 eval (2026-05-17, see
 * `tests/feature-170-todo-v2-migration.eval.ts`) shipped per cross-method
 * convergence, BUT zhipu/glm52 C3 regressed from v_baseline 80% → v_proposed
 * 20% (-60pp), while the other 4 aliases held 100% on v_proposed C3.
 *
 * Layer A LLM judge audit confirmed the regression is REAL (not regex
 * artifact): zhipu narrated "I'll mark item X as deleted..." in 4/5 cells
 * but emitted no tool call. This is the documented zhipu intent-vs-action
 * floor (memory: `project_zhipu_send_message_floor`) — but the v_proposed
 * prompt's added complexity (REMOVE/STRIKETHROUGH dual track + "Prefer over"
 * comparative clauses, ~280 tokens vs baseline ~80) is the hypothesized
 * amplifier.
 *
 * This pilot tests 3 simplification candidates against the current v_proposed
 * (V1) — all pure simplifications (no new constraints) per memory
 * `feedback_prompt_strengthening_cross_case_regression`.
 *
 * ## Variants
 *
 *   V1 (control) = current v_proposed (5 bullets with Prefer-over)
 *   V2           = merge REMOVE+STRIKETHROUGH → 1 bullet, demote `cancelled`
 *                  to parenthetical (4 bullets total)
 *   V3           = drop `cancelled` from teaching entirely (most aggressive)
 *   V4           = keep both bullets, delete "Prefer over" comparative clauses
 *
 * ## Pilot scope
 *
 *   4 variants × 3 cases (C1+C2+C3 = mid-task suite, only cases affected
 *   by the changed prompt section) × 3 aliases (zhipu=target / ds=100%
 *   control / kimi=100% control) × 5 runs = 180 calls, ~$5.
 *
 * ## Pre-registered SHIP gate
 *
 *   Replace v_proposed with V_k iff ALL three conditions met:
 *
 *   (1) **Target lift**: zhipu C3 V_k pass-rate − V1 pass-rate ≥ +20pp
 *       (current V1: zhipu C3 = 20%; need V_k zhipu C3 ≥ 40%)
 *
 *   (2) **Control non-regression**: ds and kimi C1+C2+C3 pass-rate on V_k
 *       ≥ V1 pass-rate − 10pp on EVERY (alias × case) cell
 *       (no cross-case regression per
 *       `feedback_prompt_strengthening_cross_case_regression`)
 *
 *   (3) **LLM judge audit**: Layer A self-judge disagreement vs regex ≤ 10%
 *       per EVAL_GUIDELINES anti-pattern 7 §3
 *
 *   If multiple V_k pass: prefer the smallest-change variant (V4 > V2 > V3).
 *   If no V_k passes: defer with documented evidence (prompt is sticky).
 *
 * ## Run
 *
 *   npm run test:eval -- feature-170-prompt-iteration-pilot
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
  buildPromptVariantsIteration,
} from '../benchmark/datasets/feature-170-todo-v2-migration/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-170-prompt-iteration-pilot');

// 3 aliases: zhipu (target — failed C3), ds (control — was 100%), kimi (control — was 100%)
const PILOT_ALIASES = ['zhipu/glm52', 'ds/v4pro', 'kimi'] as const;

// Only mid-task suite — the 3 cases that actually exercise the changed prompt section.
const PILOT_CASE_IDS = new Set([
  'mid_task_insert_via_todo_create',
  'mid_task_content_patch',
  'mid_task_delete_obsolete',
]);

const RUNS_PER_CELL = 5;

describe('Eval: FEATURE_170 prompt iteration pilot (v0.7.41) — V1/V2/V3/V4 × C1+C2+C3 × zhipu/ds/kimi × 5', () => {
  const aliases = availableAliases(...PILOT_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {});
    return;
  }

  for (const c of CASES) {
    if (!PILOT_CASE_IDS.has(c.id)) continue;
    it(
      `${c.id} — V1/V2/V3/V4 × ${aliases.length}-alias × ${RUNS_PER_CELL}-run`,
      { timeout: 45 * 60_000 },
      async () => {
        const variants = buildPromptVariantsIteration(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-170-prompt-iteration-pilot][${c.id}]`);
        lines.push(`  polarity:        ${c.polarity}`);
        lines.push(`  primary judge:   ${PRIMARY_JUDGE ?? '(none)'}`);

        for (const variant of variants) {
          const cells = result.byVariant[variant.id] ?? [];
          let totalRuns = 0;
          let totalPassed = 0;
          lines.push('');
          lines.push(`  --- variant: ${variant.id} ---`);
          for (const cell of cells) {
            let cellPassed = 0;
            for (const run of cell.runsRaw) {
              totalRuns++;
              if (run.passed) {
                totalPassed++;
                cellPassed++;
              }
            }
            const cellTotal = cell.runsRaw.length;
            const cellRate = cellTotal > 0 ? ((cellPassed / cellTotal) * 100).toFixed(0) : 'n/a';
            lines.push(`    ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)`);
          }
          const overallRate = totalRuns > 0 ? ((totalPassed / totalRuns) * 100).toFixed(1) : 'n/a';
          lines.push(`    overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dump = {
          case: c.id,
          stage: 'prompt-iteration-pilot-v1-v2-v3-v4',
          polarity: c.polarity,
          variants: variants.map((variant) => {
            const cells = result.byVariant[variant.id] ?? [];
            return {
              variantId: variant.id,
              description: variant.description,
              systemPrompt: variant.systemPrompt,
              userMessage: variant.userMessage,
              priorMessages: variant.priorMessages ?? [],
              aliases: cells.map((cell) => ({
                alias: cell.alias,
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
          }),
        };
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
