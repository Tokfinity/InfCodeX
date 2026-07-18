/**
 * Eval — FEATURE_104 v0.7.42 plan-list hygiene Layer 2 panel.
 *
 * Validates that v0.7.42 Steps 5 (Worker prompt PLAN-LIST HYGIENE) +
 * 6 (todo_update tool reminder field) actually shift behavior on the
 * canonical 5-alias panel.
 *
 * Three cases × two variants × N runs per cell:
 *   - Pilot mode (KODAX_EVAL_PILOT_ONLY=1): 1 alias × 3 case × 2 variant × 1 run = 6 calls (~$0.30).
 *   - Full panel:                            5 alias × 3 case × 2 variant × 5 runs = 150 calls (~$10).
 *
 * Pre-registered SHIP gate — see cases.ts header docblock.
 *
 * Raw dump: `os.tmpdir()/kodax-eval-dumps/feature-104-v0742-hygiene/<case>.json`.
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
} from '../benchmark/datasets/feature-104-v0742-hygiene/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-104-v0742-hygiene');

const PHASE1_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
] as const;
const PILOT_ALIAS = 'ark/v4flash' as const;

const PILOT_ONLY = process.env.KODAX_EVAL_PILOT_ONLY === '1';
const STAGE_LABEL = PILOT_ONLY
  ? 'pilot-1alias-1run'
  : 'phase1-5alias-5run-with-dump';
const RUNS_PER_CELL = PILOT_ONLY ? 1 : 5;

describe('Eval: FEATURE_104 v0.7.42 plan-list hygiene (Steps 5+6)', () => {
  const aliases = PILOT_ONLY
    ? availableAliases(PILOT_ALIAS)
    : availableAliases(...PHASE1_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  for (const c of CASES) {
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
        });

        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-104-v0742-hygiene][${c.id}]`);
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
                totalPassed++;
                cellPassed++;
              } else {
                for (const j of run.judges) {
                  if (!j.passed) {
                    failureCount[j.name] = (failureCount[j.name] ?? 0) + 1;
                  }
                }
              }
            }
            const cellTotal = cell.runsRaw.length;
            const cellRate = cellTotal > 0
              ? ((cellPassed / cellTotal) * 100).toFixed(0)
              : 'n/a';
            const failureSummary = Object.entries(failureCount)
              .map(([name, n]) => `${name}×${n}`)
              .join(',');
            lines.push(
              `    ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)` +
                (failureSummary ? `  (failed: ${failureSummary})` : ''),
            );
          }
          const overallRate = totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(1)
            : 'n/a';
          lines.push(`    overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const variantList = variants;
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          polarity: c.polarity,
          behaviour: c.behaviour,
          variants: variantList.map((variant) => {
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
