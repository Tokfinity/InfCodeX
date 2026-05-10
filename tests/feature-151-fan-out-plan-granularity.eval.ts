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
 * ## Run model — Phase 1 exploration (Layer 2, single alias)
 *
 * Per `benchmark/EVAL_GUIDELINES.md` (反模式 4: "探索期就开多 alias"), prompt
 * effectiveness is probed on ONE cheap/fast alias (`ds/v4flash`) with N=10
 * before any multi-alias generalization. Each run is a single-turn LLM probe
 * via `runOneShot` — NOT a multi-step agent loop.
 *
 * Topology: 1 alias × 4 case × 10 runs = 40 LLM calls (~$0.4 budget).
 *
 * **Phase 1 pre-registered decision matrix** (set BEFORE any LLM call —
 * see also `docs/features/v0.7.38.md §FEATURE_151 Slice I`):
 *
 *   - PASS:    positive (review_3_modules + audit_5_packages) ≥80%
 *              AND negative (single_lookup + single_grep) ≤20%
 *              → promote to Phase 2 multi-alias generalization
 *   - PARTIAL: positive 60–80% OR negative 20–40%
 *              → tighten Slice I prompt, repeat Phase 1 on same alias
 *   - FAIL:    positive <60%
 *              → rewrite Slice I prompt, repeat Phase 1 on same alias
 *
 * Phase 2 (multi-alias) is a SEPARATE run with its own pre-registered budget.
 * No hard `expect.fail` in this commit — eval records numbers per case for
 * inspection, mirroring the sibling self-seeding pilot pattern.
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

// EVAL_GUIDELINES compliance — exploration phase (Layer 2, single alias):
// Per `benchmark/EVAL_GUIDELINES.md` 反模式 4 ("探索期就开多 alias"), prompt
// effectiveness is first probed on ONE cheap/fast alias with N=10 to establish
// baseline. Multi-alias generalization is a separate Phase 2 only entered if
// Phase 1 clears the pre-registered thresholds below.
//
// Pre-registered decision matrix (set BEFORE running, per checklist item 6):
//   - Phase 1 PASS:  positive cases ≥80% AND negative cases ≤20%
//                    → promote to Phase 2 multi-alias (separate run, separate budget)
//   - Phase 1 PARTIAL: positive 60–80% OR negative 20–40%
//                    → tighten Slice I prompt, re-run Phase 1 on same alias
//   - Phase 1 FAIL:  positive <60%
//                    → rewrite Slice I prompt, re-run Phase 1 on same alias
//
// Budget: 4 cases × 10 runs × 1 alias = 40 calls × ~$0.01/call ≈ $0.4
// ROI: $0.4 buys one production-prompt decision (Slice I keep / strengthen / rewrite).
const STAGE_LABEL = 'phase1-explore-1alias-10run';
const RUNS_PER_CELL = 10;
const EXPLORE_ALIAS = 'ds/v4flash';

describe('Eval: FEATURE_151 Slice I fan-out plan granularity (v0.7.38)', () => {
  const aliases = availableAliases(EXPLORE_ALIAS);
  if (aliases.length === 0) {
    it(`skips: no API key for exploration alias ${EXPLORE_ALIAS}`, () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 15-min cap: 1 alias × 10 runs × ~10s/call ≈ 100s/case worst case;
      // 15min gives 9× headroom for provider hiccups without inviting the
      // 60min runaway we hit on the prior multi-alias attempt.
      { timeout: 15 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        // NOTE: harness field is `runs`, not `runsPerCell` (the sibling
        // feature-151-todo-self-seeding eval mistakenly uses `runsPerCell`,
        // which the harness ignores — silently falls back to
        // DEFAULT_BENCHMARK_RUNS = 3. Track-fix scoped to that file's
        // next pass; this driver gets the parameter name right.
        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
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
          const cellRate = cellTotal > 0
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
        const overallRate = totalRuns > 0
          ? ((totalPassed / totalRuns) * 100).toFixed(1)
          : 'n/a';
        lines.push(`  overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
      },
    );
  }
});
