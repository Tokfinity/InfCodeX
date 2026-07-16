/**
 * Eval: Tool-schema slim variants (v0.7.41) — full panel.
 *
 * Tests whether v2_slim (~half-size) and v3_aggressive (~quarter-size)
 * preserve model behavior on `ask_user_question` + `todo_create` calls.
 *
 * See `benchmark/datasets/tool-schema-slim/cases.ts` for full design,
 * pre-registered SHIP gate, variant definitions, and case rationale.
 *
 * ## Pilot finding (2026-05-17)
 *
 *   ds/v4flash v1_orig hit 3/3 positive + 3/3 negative on the revised
 *   forced-framing cases. Trigger signal confirmed; safe to scale to
 *   the 4-alias × 3-variant × 9-scenario panel.
 *
 * ## Panel
 *
 *   4 aliases × 3 variants × 9 scenarios × 5 runs = 540 calls
 *
 * ## Run
 *
 *   npm run test:eval -- tool-schema-slim
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
} from '../benchmark/datasets/tool-schema-slim/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim');

const PANEL_ALIASES = ['kimi', 'zhipu/glm51', 'ds/v4flash', 'mmx/m27'] as const;
const RUNS_PER_CELL = 5;

describe('Eval: tool-schema slim (v0.7.41) — v1_orig / v2_slim / v3_aggressive × 4 alias × 9 scenarios × 5 runs', () => {
  const aliases = availableAliases(...PANEL_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {});
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} (${c.polarity}) — v1/v2/v3 × ${aliases.length}-alias × ${RUNS_PER_CELL}-run`,
      { timeout: 30 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const lines: string[] = [];
        lines.push(`[tool-schema-slim][${c.id}] polarity=${c.polarity}`);
        for (const judge of judges) {
          lines.push(`  judge: ${judge.name}`);
        }

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
          polarity: c.polarity,
          stage: 'panel-v1-v2-v3',
          variants: variants.map((variant) => {
            const cells = result.byVariant[variant.id] ?? [];
            return {
              variantId: variant.id,
              description: variant.description,
              systemPrompt: variant.systemPrompt,
              userMessage: variant.userMessage,
              priorMessages: variant.priorMessages,
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
