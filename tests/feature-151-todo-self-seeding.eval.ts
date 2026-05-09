/**
 * Eval: FEATURE_151 todo self-seeding (v0.7.38).
 *
 * ## Purpose
 *
 * Verifies the Slice B3 prompt updates that taught Generator/Planner/Scout
 * to use `todo_update({op:'init', items:[...]})` when no plan list was
 * seeded by Runner but the task is multi-step. Also pins the negative
 * case: trivial single-step / informational tasks must NOT trigger
 * op:'init'.
 *
 *   1. multi_step_audit_init   — security audit, expect op:init ≥2 items
 *   2. rename_3_files_init     — 3-file rename, expect op:init ≥3 items
 *   3. trivial_typo_no_init    — single typo, expect NO op:init
 *   4. info_request_no_init    — informational, expect NO op:init
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. 5 alias × 4
 * case × 1 run = 20 cells. Pilot stage; post-pilot may bump to 3 run/cell
 * if variance warrants.
 *
 * **Stage-1 acceptance gate** (per design `docs/features/v0.7.38.md
 * §FEATURE_151`):
 *
 *   - 5 alias mean ≥ 80% pass per case.
 *   - No regression on negative cases — false-positive rate (LLM calls
 *     op:init for trivial / informational tasks) ≤ 20% across alias.
 *
 * No hard `expect.fail` in this commit — the eval records numbers per
 * case for inspection, mirroring the FEATURE_097 / FEATURE_106 / FEATURE_148
 * pilot pattern. Stage gating to `expect.fail` is promoted post-pilot
 * once thresholds are calibrated.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-151-todo-self-seeding
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-151-todo-self-seeding/cases.ts (data)
 *   - docs/features/v0.7.38.md#feature_151... (design + acceptance criteria)
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-151-todo-self-seeding/cases.js';

const STAGE_LABEL = 'pilot-1run';
const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_151 todo self-seeding (v0.7.38)', () => {
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
          runsPerCell: RUNS_PER_CELL,
        });

        // Pilot logging mirrors feature-097-prompt-behaviors.eval.ts —
        // record per-case pass-rate + per-alias status to the test
        // console without hard-failing. Threshold gating is post-pilot.
        const lines: string[] = [];
        lines.push(`[feature-151-todo-self-seeding][${c.id}]`);
        lines.push(`  expectInit: ${c.expectInit}`);
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
