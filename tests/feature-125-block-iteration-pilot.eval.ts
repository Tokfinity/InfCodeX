/**
 * Eval: FEATURE_125 (v0.7.41) — Team-mode block iteration pilot for kimi case 2.
 *
 * ## Purpose
 *
 * Main FEATURE_125 Layer 2 eval (2026-05-16, see
 * `tests/feature-125-team-mode-awareness.eval.ts`) shipped per cross-method
 * convergence, BUT kimi case 2 (`peer_recently_modified_reread`) has 0/5
 * pass-rate while kimi case 1 (`peer_active_file_acknowledge`) has 5/5.
 *
 * Same prompt block → opposite behavior split by case ⇒ block IS effective
 * (case 1 100%) but the `recentlyModifiedFiles` guidance line specifically
 * triggers kimi's narrate-without-tool quirk. This pilot tests 2 alternate
 * phrasings of the coordination guidance.
 *
 * ## Variants
 *
 *   V1 (control) = current production block (informational "may have just
 *                  changed; re-read before relying on memory")
 *   V2           = more concrete/actionable wording ("have likely changed
 *                  since you last saw them. Read the current content before
 *                  reasoning about them.")
 *   V3           = bullet order swap — recently_modified before active_files
 *
 * Both V2 and V3 are pure simplification/restructuring — NO new MUST
 * constraints per `feedback_prompt_strengthening_cross_case_regression`.
 *
 * ## Pilot scope
 *
 *   3 variants × 2 cases × 3 aliases (kimi=target / ds=100% control /
 *   zhipu=intermediate) × 5 runs = 90 calls, ~$2.
 *
 * ## Pre-registered SHIP gate
 *
 *   Replace V1 with V_k iff ALL three conditions met:
 *
 *   (1) **Target lift**: kimi case 2 V_k pass-rate − V1 pass-rate ≥ +20pp
 *       (current V1: kimi c2 = 0%; need V_k kimi c2 ≥ 20%)
 *
 *   (2) **Control non-regression**: every (alias × case) cell V_k pass-rate
 *       ≥ V1 pass-rate − 10pp
 *       Critical: kimi case 1 (currently 100%) must NOT drop below 80%
 *       (that's the cross-case regression risk).
 *
 *   (3) **LLM judge audit**: Layer A self-judge disagreement ≤ 10%
 *
 *   If multiple V_k pass: prefer the smallest-change variant (V3 reorder >
 *   V2 reword).
 *   If no V_k passes: defer — kimi case 2 narrate-without-tool is model
 *   structural quirk in `recently_modified` scenario, not prompt-tunable.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-125-block-iteration-pilot
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
} from '../benchmark/datasets/feature-125-team-mode-awareness/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-125-block-iteration-pilot');

const PILOT_ALIASES = ['kimi', 'ds/v4pro', 'zhipu/glm51'] as const;
const RUNS_PER_CELL = 5;

describe('Eval: FEATURE_125 block iteration pilot (v0.7.41) — V1/V2/V3 × c1+c2 × kimi/ds/zhipu × 5', () => {
  const aliases = availableAliases(...PILOT_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {});
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — V1/V2/V3 × ${aliases.length}-alias × ${RUNS_PER_CELL}-run`,
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
        lines.push(`[feature-125-block-iteration-pilot][${c.id}]`);
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
          stage: 'block-iteration-pilot-v1-v2-v3',
          variants: variants.map((variant) => {
            const cells = result.byVariant[variant.id] ?? [];
            return {
              variantId: variant.id,
              description: variant.description,
              systemPrompt: variant.systemPrompt,
              userMessage: variant.userMessage,
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
