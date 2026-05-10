/**
 * Eval: FEATURE_114 Slice 8b — Scout TRIVIAL-EXEMPTION boundary probe.
 *
 * ## Purpose
 *
 * Slice 8a (commit 1ce8ebb) pinned the existing TRIVIAL-EXEMPTION + EMIT
 * TIMING wording at the role-prompt source via 6 mechanical regression
 * tests. This eval is the Layer 2 behavioural counterpart: does that
 * wording actually drive Scout's tool choice in cross-family LLM probes?
 *
 *   1. **single_step_lookup_no_emit**       — single-line lookup → expect
 *                                              NO `emit_scout_verdict`
 *   2. **two_file_investigation_emits**     — cross-file compare → expect
 *                                              `emit_scout_verdict` with
 *                                              `executionObligations` ≥2
 *   3. **explain_how_x_works_emits**        — cross-file explanation →
 *                                              expect `emit_scout_verdict`
 *                                              with `executionObligations` ≥2
 *
 * ## Run model — Layer 2 single-turn cross-family probe
 *
 * Each run is a single-turn LLM probe via `runOneShot`. Topology:
 * 4 alias × 3 case × 5 runs = 60 LLM calls (~$1.80).
 *
 * **Pre-registered SHIP/PARTIAL/REJECT decision matrix** (set BEFORE any
 * LLM call, see also `benchmark/datasets/feature-114-scout-trivial-exemption/cases.ts`
 * doc-comment):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥80% on EACH positive case
 *              AND ≤20% on the negative case
 *              → Slice 8a wording is final; no Scout-side regression
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending OK
 *              → log behaviour in test guide; do NOT change wording
 *                without a fresh re-eval (anti-pattern 5)
 *   - REJECT:  0 aliases ≥80% positive, OR negative case >40% on any alias
 *              → wording is broken — open separate prompt-iteration slice
 *                (NOT in v0.7.38 scope)
 *
 * No hard `expect.fail` — eval records numbers per case for inspection.
 * Decision is taken offline against the matrix above.
 *
 * ## EVAL_GUIDELINES compliance
 *
 *   - n=5 runs/cell (>3 minimum, anti-pattern 4 mitigation)
 *   - Raw output dump to `os.tmpdir()/kodax-eval-dumps/feature-114-scout-trivial-exemption/`
 *     (anti-pattern 7; per-case JSON for offline LLM-judge audit)
 *   - Negative case (single_step_lookup_no_emit) is the high-false-negative-
 *     risk shape per the FEATURE_151 Slice I kimi incident. Driver dumps
 *     enable LLM-judge cross-validation of every regex-FAIL on that cell
 *     before any decision is taken.
 *   - Pre-registered decision matrix (in dataset doc-comment + this file)
 *
 * ## Run
 *
 *   npm run test:eval -- feature-114-scout-trivial-exemption
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-114-scout-trivial-exemption/cases.ts (data)
 *   - benchmark/EVAL_GUIDELINES.md (anti-pattern 7, raw-output preservation)
 *   - packages/coding/src/task-engine/_internal/managed-task/role-prompt.test.ts
 *     (Slice 8a Layer 1 mechanical regression gate)
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
} from '../benchmark/datasets/feature-114-scout-trivial-exemption/cases.js';

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-114-scout-trivial-exemption',
);

const STAGE_LABEL = 'slice8b-scout-trivial-exemption-5run-with-dump';
const RUNS_PER_CELL = 5;

// Same 4 aliases as Slice 6 to make cross-slice comparison meaningful
// (production-grade families: DeepSeek v4-pro, Zhipu GLM-5.1, Moonshot
// Kimi-for-coding, MiniMax M2.7). Specifically includes kimi which had
// the FEATURE_151 Slice I false-negative incident — re-confirms the
// regex+LLM-judge pattern catches that shape.
const SLICE8B_ALIASES = [
  'ds/v4pro',
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
] as const;

describe('Eval: FEATURE_114 Slice 8b Scout TRIVIAL-EXEMPTION boundary', () => {
  const aliases = availableAliases(...SLICE8B_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Slice 8b alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 4 alias × 5 runs × 60s/call worst case ≈ 20 min/case.
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
        lines.push(`[feature-114-scout-trivial-exemption][${c.id}]`);
        lines.push(`  expectEmit: ${c.expectEmit}`);
        if (c.minObligations !== undefined) {
          lines.push(`  minObligations: ${c.minObligations}`);
        }
        lines.push(`  behaviour: ${c.behaviour}`);
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

        // Raw output dump — see EVAL_GUIDELINES anti-pattern 7. The negative
        // case (single_step_lookup_no_emit) is exactly the shape where regex
        // judges produced false negatives on kimi during FEATURE_151 Slice I
        // verification; the dump is mandatory input to the offline LLM-judge
        // audit before any ship-or-revert decision.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectEmit: c.expectEmit,
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
