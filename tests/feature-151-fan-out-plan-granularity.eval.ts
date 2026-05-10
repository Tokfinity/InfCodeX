/**
 * Eval: FEATURE_151 Slice I — fan-out plan granularity (v0.7.38).
 *
 * ## Purpose
 *
 * Verifies the `FAN-OUT PLAN GRANULARITY` section added to Worker
 * role-prompt in v0.7.38 (`packages/coding/src/agents/worker-role-prompt.ts`,
 * `fanOutPlanGranularity` constant). The section's contract is that when
 * the Worker plans to dispatch ≥3 children (`dispatch_child_task` per
 * RULE A or RULE C), it must expand the plan to ONE item per child's
 * objective — not collapse N dispatches into a single "fan out" item.
 *
 *   1. review_3_modules    — 3-package parallel review,  expect op:init ≥3 items
 *   2. audit_5_packages    — 5-package parallel audit,   expect op:init ≥5 items
 *   3. single_lookup       — single function lookup,     expect NO op:init
 *   4. single_grep         — single grep,                expect NO op:init
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. 5 alias × 4
 * case × 1 run = 20 cells. Pilot stage; post-pilot may bump to 3 run/cell
 * if variance warrants.
 *
 * **Stage-1 acceptance gate** (per design `docs/features/v0.7.38.md
 * §FEATURE_151 Slice I — Decision matrix`):
 *
 *   - Pass: C1 + C2 ≥ 80% probe call op:'init' with sufficient items.
 *   - Pass: C3 + C4 ≤ 20% probe call op:'init' (defends against
 *     over-trigger on trivial tasks).
 *   - Cross-alias max-min spread ≤ 15pp (FEATURE_109 AHE standard).
 *
 * No hard `expect.fail` in this commit — eval records numbers per case
 * for inspection, mirroring the FEATURE_097 / FEATURE_106 / FEATURE_148 /
 * sibling FEATURE_151 self-seeding pilot pattern. Stage gating to
 * `expect.fail` is promoted post-pilot once thresholds are calibrated.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-151-fan-out-plan-granularity
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-151-fan-out-plan-granularity/cases.ts (data)
 *   - docs/features/v0.7.38.md#feature_151... Slice I (design + acceptance criteria)
 *   - tests/feature-151-todo-self-seeding.eval.ts (sibling eval, same theme)
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-151-fan-out-plan-granularity/cases.js';

const STAGE_LABEL = 'pilot-1run';
const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_151 Slice I fan-out plan granularity (v0.7.38)', () => {
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

        // Pilot logging mirrors feature-151-todo-self-seeding.eval.ts —
        // record per-case pass-rate + per-alias status to the test
        // console without hard-failing. Threshold gating is post-pilot.
        const lines: string[] = [];
        lines.push(`[feature-151-fan-out-plan-granularity][${c.id}]`);
        lines.push(`  expectInit: ${c.expectInit}`);
        if (c.minItems !== undefined) {
          lines.push(`  minItems:   ${c.minItems}`);
        }
        lines.push(`  behaviour:  ${c.behaviour}`);
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
