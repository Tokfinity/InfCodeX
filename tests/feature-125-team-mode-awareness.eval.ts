/**
 * Eval: FEATURE_125 (v0.7.41) — Team Mode awareness prompt.
 *
 * ## Purpose
 *
 * Verifies that the `=== Other active KodaX sessions ===` block injected
 * by the runner-driven adapter (via `buildOtherInstancesPromptBlock`,
 * threaded through `rolePromptContext.teamModeSection`) actually
 * influences the Worker LLM's first tool call.
 *
 * Two cases, both POSITIVE (must `read` the sibling-flagged file FIRST):
 *
 *   1. peer_active_file_acknowledge_read_first — sibling's activeFiles
 *      flagged `src/auth.ts`; user asks for an edit on the same file.
 *      Expect: first tool call is `read("src/auth.ts")` before any edit.
 *   2. peer_recently_modified_reread — sibling's recentlyModifiedFiles
 *      flagged `src/utils.ts` 15 s ago; user asks to describe a function
 *      in that file and explicitly hints "check the actual current
 *      implementation". Expect: first tool call is `read("src/utils.ts")`.
 *
 * ## Pre-registered decision matrix (per EVAL_GUIDELINES anti-pattern 6)
 *
 *   - SHIP:    ≥3 of 5 aliases hit ≥60% pass rate on EACH case.
 *              Threshold 60% (not 80%) because the regex catches only
 *              the `read` arm of the design's "避让 / 协作 / re-read"
 *              success envelope; alternative valid behaviors (propose
 *              different file, ask user to coordinate) are NOT
 *              regex-detectable without LLM judge.
 *              → Ship Team Mode block as-is.
 *   - PARTIAL: 1-2 aliases ≥60%, others 30-60% on each case.
 *              → Ship anyway — the team-mode block is informational
 *              (no MUST language) and the safety net layers
 *              (content-hash + active-file-warning) hard-block the
 *              dangerous behaviors regardless. Document for v0.7.42
 *              prompt iteration.
 *   - REJECT:  0 aliases ≥40% on either case.
 *              → Investigate prompt-block wording; revert to inline
 *              guidance only if redesign cannot lift the floor.
 *
 * ## Pilot → Phase 1
 *
 * Per memory `feedback_eval_pilot_before_scale` (2026-05-15 lesson:
 * Suite 0 v1 270 calls all 0% dispatch, data废, $13.5 wasted), this
 * driver starts with a **single-cell pilot** (1 alias × 1 case × 1 run,
 * ~$0.10) gated by the `KODAX_EVAL_PILOT_ONLY=1` env-var. If the
 * pilot triggers the expected behavior (or proves the wiring works at
 * all), `KODAX_EVAL_PILOT_ONLY=0` (or unset) runs the full 5-alias
 * matrix.
 *
 * ## Run
 *
 *   # Pilot only (~$0.10, ~30 s)
 *   KODAX_EVAL_PILOT_ONLY=1 npm run test:eval -- feature-125-team-mode-awareness
 *
 *   # Phase 1 multi-alias (~$1.5, ~10 min)
 *   npm run test:eval -- feature-125-team-mode-awareness
 *
 * Skips when no provider API keys are present (FEATURE_104 standard).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-125-team-mode-awareness/cases.ts (data)
 *   - docs/features/v0.7.41.md FEATURE_125 §Step 5 / §"acceptance criteria"
 *   - packages/agent/src/team/system-prompt-injection.ts (block formatter)
 *   - packages/coding/src/task-engine/runner-driven.ts (W4 wiring site)
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
} from '../benchmark/datasets/feature-125-team-mode-awareness/cases.js';

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-125-team-mode-awareness',
);

// Phase 1 panel — 5 aliases covering 4 independent provider families
// (zhipu, kimi, mimo, minimax, deepseek) per memory
// `feedback_eval_partial_alias_expansion`: PARTIAL eval often resolves
// by widening alias panel rather than iterating the prompt.
const PHASE1_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/glm51',
  'ds/v4pro',
] as const;

// Pilot — 1 alias, 1 run, 2 cases = 2 LLM calls (~$0.10). Cheapest
// alias that is also Anthropic-distinct (so the wiring exercises the
// non-Anthropic provider path that the panel uses for real). `ds/v4flash`
// is the floor model; if it triggers the `read-first` behavior even
// occasionally, the wiring is sound and we can scale up.
const PILOT_ALIAS = 'ds/v4flash' as const;

const PILOT_ONLY = process.env.KODAX_EVAL_PILOT_ONLY === '1';
const STAGE_LABEL = PILOT_ONLY
  ? 'pilot-1alias-1run'
  : 'phase1-5alias-5run-with-dump';
const RUNS_PER_CELL = PILOT_ONLY ? 1 : 5;

describe('Eval: FEATURE_125 Team Mode awareness (v0.7.41)', () => {
  const aliases = PILOT_ONLY
    ? availableAliases(PILOT_ALIAS)
    : availableAliases(...PHASE1_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 5 alias × 5 runs × 60s/call worst case = 25 min/case.
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

        // SHIP gate: the FIRST judge returned by `buildJudges` is the
        // primary `read_first_on_<target>` assertion. The SECOND is
        // the diagnostic `mentions_sibling_pid_<n>` (does the model
        // verbalize the context, in addition to acting on it). Per
        // §"Pre-registered decision matrix" above, only the primary
        // judge gates SHIP; we still print the secondary for
        // diagnostic visibility into "aware vs acting" splits.
        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-125-team-mode-awareness][${c.id}]`);
        lines.push(`  expectReadTarget: ${c.expectReadTarget}`);
        lines.push(`  siblingPid:       ${c.siblingPid}`);
        lines.push(`  behaviour:        ${c.behaviour}`);
        lines.push(`  SHIP-gate judge:  ${PRIMARY_JUDGE ?? '(none)'}`);
        const cells = result.byVariant['v0.7.41'] ?? [];
        let totalRuns = 0;
        let totalPrimaryPassed = 0;
        let totalSecondaryPassed = 0;
        for (const cell of cells) {
          let cellPrimaryPassed = 0;
          let cellSecondaryPassed = 0;
          const failureCount: Record<string, number> = {};
          for (const run of cell.runsRaw) {
            totalRuns++;
            const primary = run.judges.find((j) => j.name === PRIMARY_JUDGE);
            if (primary?.passed) {
              totalPrimaryPassed++;
              cellPrimaryPassed++;
            }
            const secondary = run.judges.find(
              (j) => j.name !== PRIMARY_JUDGE,
            );
            if (secondary?.passed) {
              totalSecondaryPassed++;
              cellSecondaryPassed++;
            }
            for (const j of run.judges) {
              if (!j.passed) {
                failureCount[j.name] = (failureCount[j.name] ?? 0) + 1;
              }
            }
          }
          const cellTotal = cell.runsRaw.length;
          const primaryRate = cellTotal > 0
            ? ((cellPrimaryPassed / cellTotal) * 100).toFixed(0)
            : 'n/a';
          const secondaryRate = cellTotal > 0
            ? ((cellSecondaryPassed / cellTotal) * 100).toFixed(0)
            : 'n/a';
          const failureSummary = Object.entries(failureCount)
            .map(([name, n]) => `${name}×${n}`)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} primary=${cellPrimaryPassed}/${cellTotal} (${primaryRate}%)  secondary=${cellSecondaryPassed}/${cellTotal} (${secondaryRate}%)` +
              (failureSummary ? `  (failed: ${failureSummary})` : ''),
          );
        }
        const primaryOverallRate = totalRuns > 0
          ? ((totalPrimaryPassed / totalRuns) * 100).toFixed(1)
          : 'n/a';
        const secondaryOverallRate = totalRuns > 0
          ? ((totalSecondaryPassed / totalRuns) * 100).toFixed(1)
          : 'n/a';
        lines.push(
          `  overall: primary=${totalPrimaryPassed}/${totalRuns} (${primaryOverallRate}%)  ` +
            `secondary=${totalSecondaryPassed}/${totalRuns} (${secondaryOverallRate}%)`,
        );
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectReadTarget: c.expectReadTarget,
          siblingPid: c.siblingPid,
          behaviour: c.behaviour,
          systemPrompt: variant?.systemPrompt ?? '',
          userMessage: variant?.userMessage ?? '',
          priorMessages: variant?.priorMessages ?? [],
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
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
