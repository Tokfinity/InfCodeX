/**
 * Eval: FEATURE_114 V1 baseline comparison (Slice 7 decision input).
 *
 * ## Purpose
 *
 * Slice 6 V2 Worker on `multi_step_no_fanout_seeds_plan` measured 45%
 * overall pass rate (Kimi 0%, MMX 60%, ds/v4pro 80%, zhipu 40%) on the
 * "edit a file + run build" multi-step task. Pre-Slice-7 question: is
 * V1 Scout BETTER on the same task (→ V2 ship would be a regression
 * for weak-model users → keep flag default-OFF) or SIMILAR (→ V2 ship
 * is neutral on plan visibility → flag flip safe)?
 *
 * Apples-to-apples: same user message, same 4 aliases, same n=5 runs;
 * only the system prompt differs (V1 Scout sections vs V2 Worker
 * sections).
 *
 * ## Pre-registered decision matrix
 *
 *   - V1 ≥ V2 + 10pp on overall pass rate → V2 is regression on weak
 *     models → keep V2 flag default-OFF (Slice 7 = no flip)
 *   - V1 within ±10pp of V2 → V2 ship is neutral on plan visibility →
 *     flag flip safe (Slice 7 = flip default-ON)
 *   - V1 ≤ V2 − 10pp → V2 is improvement on weak models → flag flip
 *     definitely safe (Slice 7 = flip + advertise improvement)
 *
 * Topology: 1 case × 4 alias × 5 runs = 20 LLM calls ≈ $0.60.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-114-v1-baseline-comparison
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-114-v1-baseline-comparison/cases.ts
 *   - tests/feature-114-harness-v2-baseline.eval.ts (V2 side of comparison)
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
} from '../benchmark/datasets/feature-114-v1-baseline-comparison/cases.js';

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-114-v1-baseline-comparison',
);

const STAGE_LABEL = 'slice7-decision-input-5run-with-dump';
const RUNS_PER_CELL = 5;

// SAME 4 aliases as Slice 6 V2 baseline so per-alias comparison is clean.
const SLICE7_ALIASES = [
  'ds/v4pro',
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
] as const;

describe('Eval: FEATURE_114 V1 baseline comparison (Slice 7 decision input)', () => {
  const aliases = availableAliases(...SLICE7_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 25 * 60_000 },
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
        lines.push(`[feature-114-v1-baseline-comparison][${c.id}]`);
        lines.push(`  minObligations: ${c.minObligations}`);
        lines.push(`  behaviour: ${c.behaviour}`);
        const cells = result.byVariant['v1-baseline'] ?? [];
        let totalRuns = 0;
        let totalPassed = 0;
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
          const cellRate =
            cellTotal > 0
              ? ((cellPassed / cellTotal) * 100).toFixed(0)
              : 'n/a';
          const failureSummary = Object.entries(failureCount)
            .map(([name, n]) => `${name}×${n}`)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)` +
              (failureSummary ? `  (failed: ${failureSummary})` : ''),
          );
        }
        const overallRate =
          totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(1)
            : 'n/a';
        lines.push(`  overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);

        // V2 reference numbers (Slice 6 multi_step_no_fanout_seeds_plan,
        // post-revert): ds/v4pro 80% / zhipu 40% / kimi 0% / mmx 60% — overall 45%
        lines.push('');
        lines.push('  Reference V2 numbers (Slice 6 post-revert):');
        lines.push('    ds/v4pro      4/5 (80%)');
        lines.push('    zhipu/glm51   2/5 (40%)');
        lines.push('    kimi          0/5 (0%)');
        lines.push('    mmx/m27       3/5 (60%)');
        lines.push('    overall:      9/20 (45.0%)');
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          minObligations: c.minObligations,
          behaviour: c.behaviour,
          systemPrompt: variant?.systemPrompt ?? '',
          userMessage: variant?.userMessage ?? '',
          aliases: cells.map((cell) => ({
            alias: cell.alias,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
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
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
