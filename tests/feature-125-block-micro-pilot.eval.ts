/**
 * Eval: FEATURE_125 (v0.7.41) — V2 decomposition micro-pilot.
 *
 * ## Purpose
 *
 * The 2026-05-17 V1/V2/V3 block iteration pilot showed V2 gave kimi case 2
 * +60pp (0%→60%) but tanked kimi case 1 -60pp (100%→40%). V2 changed TWO
 * things simultaneously in the `recentlyModifiedFiles` guidance line:
 *
 *   - Change A (tone): "may have just changed" → "have likely changed
 *                      since you last saw them"
 *   - Change B (verb): "re-read before relying on memory of their content"
 *                   → "Read the current content before reasoning about them."
 *                      (also splits semicolon-clause into 2 sentences)
 *
 * This micro-pilot isolates which change drives which effect:
 *
 *   V1  (control)  = neither change
 *   V2  (replicate)= both changes (kimi c2 +60 / c1 -60)
 *   V2a (tone)     = Change A only
 *   V2b (verb)     = Change B only
 *
 * ## Pilot scope
 *
 *   4 variants × 2 cases (c1+c2) × 2 aliases (kimi=target, zhipu=intermediate)
 *   × 5 runs = 80 calls, ~$2.
 *
 * Drop ds/v4pro (was 100% across all V1/V2/V3 variants — saturated, no
 * decomposition signal). Focus budget on the 2 aliases that actually
 * exhibited a response to V2.
 *
 * ## Pre-registered SHIP gate (same as parent pilot)
 *
 *   Replace V1 with V_k iff ALL three conditions met:
 *
 *   (1) Target lift: kimi c2 V_k ≥ V1 + 20pp
 *   (2) Cross-case non-regression: every (alias × case) cell V_k ≥ V1 - 10pp
 *   (3) LLM judge audit disagreement ≤ 10%
 *
 *   Decomposition hypothesis: V2a passes if tone is harmless / V2b fails if
 *   verb is the trigger (or vice versa). If neither single-factor variant
 *   passes, the cross-case regression is non-decomposable — V2 must
 *   permanently DEFER.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-125-block-micro-pilot
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
  buildPromptVariantsMicroPilot,
} from '../benchmark/datasets/feature-125-team-mode-awareness/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-125-block-micro-pilot');

const PILOT_ALIASES = ['kimi', 'zhipu/glm52'] as const;
const RUNS_PER_CELL = 5;

describe('Eval: FEATURE_125 block V2-decomposition micro-pilot (v0.7.41) — V1/V2/V2a/V2b × c1+c2 × kimi/zhipu × 5', () => {
  const aliases = availableAliases(...PILOT_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {});
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — V1/V2/V2a/V2b × ${aliases.length}-alias × ${RUNS_PER_CELL}-run`,
      { timeout: 45 * 60_000 },
      async () => {
        const variants = buildPromptVariantsMicroPilot(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-125-block-micro-pilot][${c.id}]`);
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
          stage: 'block-micro-pilot-v1-v2-v2a-v2b',
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
