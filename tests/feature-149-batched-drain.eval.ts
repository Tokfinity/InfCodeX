/**
 * Eval: FEATURE_149 (v0.7.38) Phase B3 batched-drain — release gate.
 *
 * ## Purpose
 *
 * `runQueuedPromptSequence` now collapses N pending follow-ups into a
 * single batched user message joined by `\n\n---\n\n`. This eval verifies
 * that LLMs across 5 alias families still:
 *
 *   1. address ALL distinct sub-tasks instead of dropping all but the
 *      first or the last,
 *   2. honor a "scratch that, do Y instead" redirect inside the same
 *      batched message,
 *   3. preserve cohesion across mixed-genre tasks (lookup + count +
 *      summarize in one go).
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. 5 alias ×
 * 4 case = 20 cells. 1 run/cell pilot.
 *
 * **Stage-1 acceptance gate** (per design §"验收标准 #6 跨 family 不退化"):
 *
 *   - 5 alias mean ≥ 75% pass per case.
 *   - max-min spread ≤ 20pp.
 *
 * No hard `expect.fail` in this commit — pass-rate is logged for each
 * cell. Stage-2 promotion to `expect.fail` happens after the first
 * production run calibrates the threshold (mirrors FEATURE_106 / 112
 * transition pattern).
 *
 * ## Run
 *
 *   npm run test:eval -- feature-149-batched-drain
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-149-batched-drain/cases.ts (data)
 *   - packages/repl/src/ui/utils/queued-prompt-sequence.ts (production join)
 *   - docs/features/v0.7.38.md#feature_149-queued-prompt-injection-latency--mid-turn-ux-parity
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-149-batched-drain/cases.js';

const STAGE_LABEL = 'pilot-1run';
const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_149 batched-drain (v0.7.38)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `feature-149-batched-drain--${STAGE_LABEL}--${c.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        const lines: string[] = [];
        lines.push(`[feature-149-batched-drain][${c.id}]`);
        lines.push(`  behaviour: ${c.behaviour}`);
        const cells = result.byVariant['v0.7.38'] ?? [];
        let passCount = 0;
        for (const cell of cells) {
          const firstRun = cell.runsRaw[0];
          if (!firstRun) continue;
          if (firstRun.passed) passCount++;
          const status = firstRun.passed ? 'PASS' : 'FAIL';
          const failedJudges = firstRun.judges
            .filter((j) => !j.passed)
            .map((j) => j.name)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} ${status}` +
              (failedJudges ? `  (failed: ${failedJudges})` : ''),
          );
        }
        const passRate = cells.length > 0
          ? ((passCount / cells.length) * 100).toFixed(1)
          : 'n/a';
        lines.push(`  pass-rate: ${passCount}/${cells.length} (${passRate}%)`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
      },
    );
  }
});
