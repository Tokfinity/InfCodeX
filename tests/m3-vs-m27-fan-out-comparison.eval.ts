/**
 * Eval: MiniMax-M3 vs MiniMax-M2.7 fan-out plan + dispatch comparison.
 *
 * ## Purpose
 *
 * User-observation diagnostic: "刚接入的 M3，不直接提示他不怎么列计划列表
 * 和调用子 Agent" — does M3 have a tool-conservative structural floor
 * relative to M2.7 and the canonical panel?
 *
 * Reuses `feature-151-fan-out-plan-granularity` cases (the closest
 * existing eval to the user's observed behaviour: 2 positive cases
 * "fan out → expect op:init with ≥N items", 2 negative cases "trivial
 * task → expect NO op:init"). Adds `mmx/m3` to the panel and reruns
 * against the canonical 5 to give M3 cross-family context.
 *
 * ## Topology
 *
 *   6 aliases × 4 cases × 5 runs = 120 calls
 *   Aliases: zhipu/glm51, kimi, mmx/m27, mmx/m3, ark/v4pro, ark/v4flash
 *   Estimated cost ~$3.60, wall time ~30-60 min.
 *
 * ## Pre-registered decision matrix (set BEFORE LLM calls)
 *
 *   - M3 pass-rate within ±1 cell of M2.7 on all 4 cases
 *       → user observation not reproducible in this eval; possibly
 *         scenario-specific. Document and stop.
 *   - M3 < M2.7 ≥ 2 cells on BOTH positive cases AND M3 ≤ ark/v4flash
 *       → structural tool-conservative floor (`feedback_model_structural_
 *         floor_not_prompt_tunable`). Document, do NOT prompt-iterate.
 *   - M3 < M2.7 ≥ 2 cells but M3 > ark/v4flash
 *       → M3 weaker than M2.7 on fan-out but still functional.
 *         Add M3 to canonical panel for future prompt iteration.
 *   - M3 ≥ M2.7 + 2 cells on positive AND ≤ M2.7 + 1 on negative
 *       → M3 actually stronger on this dimension — user observation was
 *         likely scenario-specific.
 *
 * ## Anti-pattern compliance
 *
 *   - §3 same-provider concurrency: harness serializes per provider
 *     (mmx pair runs sequentially, ark trio runs sequentially).
 *   - §5 prompt iteration: this is NOT a prompt-iteration eval. We're
 *     measuring an unmodified production prompt against a new model.
 *   - §7 raw dump: per-case JSON to os.tmpdir for offline LLM audit.
 *   - §8 tools channel: feature-151 dataset uses production tool
 *     definitions through the harness `tools` slot.
 *
 * ## See also
 *
 *   - tests/feature-151-fan-out-plan-granularity.eval.ts (original 5-alias)
 *   - benchmark/datasets/feature-151-fan-out-plan-granularity/cases.ts
 *   - benchmark/EVAL_GUIDELINES.md §Canonical alias panel
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

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'm3-vs-m27-fan-out');
const STAGE_LABEL = 'm3-comparison-6alias-5run';
const RUNS_PER_CELL = 5;

// Canonical 5 (per EVAL_GUIDELINES §Canonical alias panel) + mmx/m3.
const PANEL_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
] as const;

describe('Eval: M3 vs M2.7 fan-out plan + dispatch comparison', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it.skip('skips: no provider API keys set for any panel alias', () => {});
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap mirrors feature-151 driver — same case shape.
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

        // Per-cell pass-rate report.
        const lines: string[] = [];
        lines.push(`[m3-vs-m27-fan-out][${c.id}]`);
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
            `  ${cell.alias.padEnd(14)} ${cellPassed}/${cellTotal} (${cellRate}%)` +
              (failureSummary ? `  (failed: ${failureSummary})` : ''),
          );
        }
        const overallRate = totalRuns > 0
          ? ((totalPassed / totalRuns) * 100).toFixed(1)
          : 'n/a';
        lines.push(`  overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectInit: c.expectInit,
          minItems: c.minItems,
          behaviour: c.behaviour,
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
