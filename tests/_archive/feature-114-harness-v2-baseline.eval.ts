/**
 * **ARCHIVED — DO NOT RUN.** Retired in FEATURE_155 v0.7.39 Phase 0b
 * follow-up cleanup.
 *
 * Slice 6/7 ship gates this eval was designed to inform are met:
 * Slice 7 flipped `KODAX_HARNESS_V2` default to ON in v0.7.38
 * (commit `2acbf9d0`). The dataset's system prompt still advertises
 * `await_child_task` in DISPATCH RULES + Tool Docs blocks — that tool
 * was deleted in v0.7.38 FEATURE_155 Slice C1, so any re-run would
 * measure Worker behavior against a fictitious contract.
 *
 * `vitest.eval.config.ts` excludes `tests/_archive/**` so
 * `npm run test:eval` no longer picks this file up; it is preserved
 * here as a historical record of the methodology + Slice 6/7
 * decision rationale.
 *
 * Imports below point at the archived dataset path
 * (`benchmark/datasets/_archive/...`) but the file is no longer
 * executed; if you need to resurrect this eval, re-baseline the
 * system prompt against the current tool surface first.
 *
 * --- Original header (kept verbatim) ---
 *
 * Eval: FEATURE_114 v0.7.36 AMA Harness V2 baseline (Slice 6).
 *
 * ## Purpose
 *
 * Verifies the V2-only sections of `buildWorkerInstructions`
 * (`packages/coding/src/agents/worker-role-prompt.ts`) that the
 * sibling FEATURE_151 evals do NOT cover:
 *
 *   1. **plan_complete_emits_handoff** — Worker, after both plan items
 *      completed, must call `emit_handoff` (cannot terminate via text)
 *   2. **multi_step_no_fanout_seeds_plan** — non-trivial 2-step impl in
 *      a single file → expect `op:"init"` ≥2 items, NO fan-out
 *   3. **trivial_lookup_no_handoff** — single-line lookup → expect NO
 *      `op:"init"` AND NO `emit_handoff`
 *
 * Sibling FEATURE_151 evals already cover Worker fan-out plan-granularity
 * (≥3 children) and V1 Generator/Planner/Scout self-seeding (V1 path).
 * This dataset closes the remaining V2-only gaps.
 *
 * ## Run model — Layer 2 single-turn cross-family probe
 *
 * Each run is a single-turn LLM probe via `runOneShot` — NOT a multi-step
 * agent loop. Topology: 4 alias × 3 case × 5 runs = 60 LLM calls (~$1.80).
 *
 * **Pre-registered SHIP/PARTIAL/REJECT decision matrix** (set BEFORE any
 * LLM call, see also `benchmark/datasets/feature-114-harness-v2-baseline/cases.ts`
 * doc-comment + `docs/features/v0.7.36.md §FEATURE_114 Slice 6`):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥80% on EACH positive case
 *              AND ≤20% on the negative case
 *              → ship V2 default flag flip in Slice 7
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending
 *              → ship Slice 7 anyway, document weaker-model behaviour
 *                in test guide; flag remains gateable per-deployment
 *   - REJECT:  0 aliases ≥80% positive, OR negative case >40% on any alias
 *              → keep V2 flag default-off, redesign handoff/plan-first
 *
 * No hard `expect.fail` in this commit — eval records numbers per case
 * for inspection, mirroring the FEATURE_151 sibling pattern. Decision
 * is made offline by reading per-case dump + console output.
 *
 * ## EVAL_GUIDELINES compliance
 *
 *   - n=5 runs/cell (>3 minimum, anti-pattern 4 mitigation)
 *   - Raw output dump to `os.tmpdir()/kodax-eval-dumps/feature-114-harness-v2-baseline/`
 *     (anti-pattern 7 mitigation; per-case JSON for offline LLM-judge audit)
 *   - Negative case 3 carries 3 regex judges; the dump enables LLM-judge
 *     cross-validation of every regex-FAIL on negative cells (the FEATURE_151
 *     Slice I real-case incident — kimi false-negative — happened on the
 *     same shape of judge)
 *   - Pre-registered decision matrix (in dataset doc-comment + this file)
 *
 * ## Run
 *
 *   npm run test:eval -- feature-114-harness-v2-baseline
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-114-harness-v2-baseline/cases.ts (data)
 *   - benchmark/EVAL_GUIDELINES.md (anti-pattern 7, raw-output preservation)
 *   - tests/feature-151-fan-out-plan-granularity.eval.ts (sibling, fan-out branch)
 *   - tests/feature-151-todo-self-seeding.eval.ts (sibling, V1 self-seeding)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases } from '../../benchmark/harness/aliases.js';
import { runBenchmark } from '../../benchmark/harness/harness.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../../benchmark/datasets/_archive/feature-114-harness-v2-baseline/cases.js';

// Raw-output dump root — driver always writes per-case JSON for offline
// LLM-as-judge cross-validation against the regex judges (EVAL_GUIDELINES
// §"Raw output preservation" / anti-pattern 7). Lives under the OS tmp
// directory so the dump is treated as a transient runtime artifact (cleaned
// by OS) and cannot accidentally leak into the repo working tree.
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-114-harness-v2-baseline');

const STAGE_LABEL = 'slice6-baseline-5run-with-dump';
const RUNS_PER_CELL = 5;

// Production-grade aliases (ds/v4flash excluded — already shown to be a
// floor-model in FEATURE_151 phase 1; ark/glm51 excluded — no incremental
// signal vs zhipu/glm51 since both serve the same upstream model). The 4
// remaining aliases span 4 distinct upstream model families (DeepSeek
// v4-pro, Zhipu GLM-5.1, Moonshot Kimi-for-coding, MiniMax M2.7) so a
// 3-of-4 threshold gives 75% cross-family signal which is the relevant
// decision input for "ship V2 default flag flip in Slice 7".
const SLICE6_ALIASES = [
  'ds/v4pro',
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
] as const;

describe('Eval: FEATURE_114 v0.7.36 V2 baseline (Slice 6)', () => {
  const aliases = availableAliases(...SLICE6_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Slice 6 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 4 alias × 5 runs × 60s/call worst case ≈ 20 min/case.
      // Per-call upper bound 300s acceptable per existing convention; total
      // wall for 3 cases ≈ 60 min worst case, typically ~10 min/case.
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

        // Pilot logging mirrors the FEATURE_151 sibling driver — record
        // per-case pass-rate + per-alias status without hard-failing.
        // Decision gate is offline against the pre-registered matrix.
        const lines: string[] = [];
        lines.push(`[feature-114-harness-v2-baseline][${c.id}]`);
        lines.push(`  expectHandoff: ${c.expectHandoff}`);
        lines.push(`  expectInit:    ${c.expectInit}`);
        if (c.minItems !== undefined) {
          lines.push(`  minItems:      ${c.minItems}`);
        }
        lines.push(`  behaviour:     ${c.behaviour}`);
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
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump raw outputs for LLM-as-judge cross-validation. One file per
        // case; lives under os.tmpdir() / kodax-eval-dumps so the OS reaps
        // it as a transient runtime artifact (cannot leak into repo tree).
        // Per EVAL_GUIDELINES anti-pattern 7: every regex-FAIL on a negative
        // cell should be sampled by an LLM-judge (clean context) before
        // any decision is taken — the dump is the input to that audit.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectHandoff: c.expectHandoff,
          expectInit: c.expectInit,
          minItems: c.minItems,
          behaviour: c.behaviour,
          systemPrompt: variant?.systemPrompt ?? '',
          priorMessages: variant?.priorMessages ?? [],
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
