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
 * ## Run model — Phase 2 cross-family validation (Layer 2, multi-alias)
 *
 * Phase 1 single-alias exploration on ds/v4flash (commits a3ff28c..7c508a2)
 * lifted positive-case pass rate +30pp from v1 (25% avg) to v2 (55% avg) but
 * showed ds/v4flash has an instruction-following ceiling that further
 * prompt iteration would not productively break. Phase 2 evaluates the v2
 * prompt against 5 production-grade aliases to answer the actual decision
 * question: "ship Slice I in v0.7.38?".
 *
 * Each run is a single-turn LLM probe via `runOneShot` — NOT a multi-step
 * agent loop. Topology: 5 alias × 4 case × 5 runs = 100 LLM calls (~$3).
 *
 * **Phase 2 pre-registered decision matrix** (set BEFORE any LLM call —
 * see also `docs/features/v0.7.38.md §FEATURE_151 Slice I`):
 *
 *   - SHIP:    ≥3 of 5 aliases hit ≥80% on EACH positive case
 *              AND ≤20% on EACH negative case
 *              → Slice I final, ship v0.7.38 as designed
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending up
 *              → ship Slice I anyway, document weaker-model behaviour in test guide
 *   - REJECT:  0 aliases ≥80% positive
 *              → revert Slice I, redesign
 *
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
} from '../benchmark/datasets/feature-151-fan-out-plan-granularity/cases.js';

// Raw-output dump root — driver always writes per-case JSON for offline
// LLM-as-judge cross-validation against the regex judges (EVAL_GUIDELINES
// mechanical-assertion compliance check, see §Raw output preservation).
// Lives under the OS tmp directory so the dump is treated as a transient
// runtime artifact (cleaned by OS) and cannot accidentally leak into the
// repo working tree. Run prints the absolute path so an operator can find
// it for offline LLM-judge audit.
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-151-fan-out-plan-granularity');

// EVAL_GUIDELINES — Phase 2 cross-family validation (Layer 2, multi-alias):
//
// Phase 1 (single-alias ds/v4flash, v1+v2 prompt, see commits a3ff28c..7c508a2)
// established that v2 lifts positive-case pass rate +30pp on the weakest model
// (20%→60% on 3-pkg, 30%→50% on 5-pkg). Phase 1 declared PARTIAL/FAIL on the
// strict pre-registered matrix, but diagnosis showed ds/v4flash hits a hard
// instruction-following ceiling that further single-alias prompt iteration
// would not break (matches EVAL_GUIDELINES anti-pattern 5 — micro-tweak
// blind retry). Decision question for the eval is "ship Slice I in v0.7.38?",
// which requires cross-family signal, not perfecting the floor model.
//
// Phase 2 pre-registered decision matrix (set BEFORE running):
//   - SHIP:    ≥3 of 5 aliases hit ≥80% on EACH positive case AND ≤20% on EACH negative
//              → Slice I final, ship v0.7.38 as designed
//   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending up vs Phase 1 v1 baseline
//              → ship Slice I anyway (net-positive), document weaker-model behaviour in test guide
//   - REJECT:  0 aliases ≥80% positive
//              → revert Slice I, redesign
//
// Budget: 4 cases × 5 runs × 5 aliases = 100 calls × ~$0.03/call avg ≈ $3
// ROI: $3 buys one ship-or-revert decision for v0.7.38 — within EVAL_GUIDELINES
//      "$5 实验换一条 production prompt 改动: 值" guidance.
//
// Concurrency: per-alias single-call (反模式 3), cross-alias serial in vitest.
// Aliases: ds/v4flash excluded (Phase 1 floor-model data already in hand).
// Phase 2 RE-RUN with raw-output dump for regex-vs-LLM-judge cross-check.
// Original Phase 2 lost raw outputs (driver only logged aggregates). This
// pass adds disk dump of `runsRaw[].text` per case so an LLM-as-judge can
// audit whether regex pass/fail reflects actual model behaviour — covers
// both kimi negative-case regression suspicion AND mmx 20%/80% split AND
// zhipu's apparent v1→v2 regression all in one run.
const STAGE_LABEL = 'phase2-multialias-5run-with-dump';
const RUNS_PER_CELL = 5;
const PHASE2_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/glm51',
  'ds/v4pro',
] as const;

describe('Eval: FEATURE_151 Slice I fan-out plan granularity (v0.7.38)', () => {
  const aliases = availableAliases(...PHASE2_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Phase 2 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 5 alias × 5 runs × 60s/call worst case = 25 min/case.
      // Per-call upper bound 300s acceptable per user direction; total wall
      // for 4 cases ≈ 100 min worst case, typically ~15 min/case.
      { timeout: 25 * 60_000 },
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

        // Dump raw outputs for LLM-as-judge cross-validation. One file per
        // case; lives under os.tmpdir() / kodax-eval-dumps so the OS reaps
        // it as a transient runtime artifact (cannot leak into repo tree).
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectInit: c.expectInit,
          minItems: c.minItems,
          behaviour: c.behaviour,
          userMessage: variant?.userMessage ?? '',
          systemPromptSha: undefined as string | undefined,
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
