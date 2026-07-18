/**
 * Eval: FEATURE_120 Phase 5b — async child-steering prompt (v0.7.39).
 *
 * ## Purpose
 *
 * Verifies the `ASYNC CHILD STEERING` section added to Worker
 * role-prompt in v0.7.39 Phase 5a (see
 * `packages/coding/src/agents/worker-role-prompt.ts` `childSteeringRules`
 * constant). The section's contract is that when the user's mid-task
 * follow-up or an off-scope child progress report arrives, the Worker
 * reaches for the right coordinator tool:
 *
 *   1. send_message_trigger   — user mid-task addendum,  expect send_message(task_001)
 *   2. task_stop_trigger      — off-scope child progress, expect task_stop(task_002)
 *
 * Both cases are POSITIVE (must-call). The intentionally-dropped
 * `model_hint` case is documented in `cases.ts`: it would be a negative
 * regex against a property that has NO observable production effect in
 * v0.7.39 (routing is no-op until FEATURE_102 v0.7.45), so it would
 * burn budget on a property we cannot ship a decision against —
 * EVAL_GUIDELINES anti-pattern 7 (negative regex without LLM-judge
 * tiebreak) AND anti-pattern 5 (micro-tweak blind retry on noise).
 *
 * ## Run model — Phase 1 cross-family validation (Layer 2, multi-alias)
 *
 * Each run is a single-turn LLM probe via `runBenchmark` — NOT a multi-
 * step agent loop. Topology: 5 alias × 2 case × 5 runs = 50 LLM calls
 * (~$1.5).
 *
 * **Pre-registered decision matrix** (set BEFORE any LLM call — see
 * also `docs/features/v0.7.39.md` Phase 5b §"Layer 2 probe"):
 *
 *   - SHIP:    ≥3 of 5 aliases hit ≥80% on EACH positive case
 *              → Phase 5b prompt final, ship v0.7.39 as designed
 *   - PARTIAL: 1-2 aliases ≥80% on each case, others <80% but mention
 *              the right tool name in text without committing the tool
 *              call → ship anyway, document weaker-model behaviour in
 *              the test guide; revisit prompt in v0.7.40 if user
 *              reports missed steerings in prod
 *   - REJECT:  0 aliases ≥80% positive
 *              → revert Phase 5a prompt block, redesign
 *
 * No hard `expect.fail` in this commit — eval records numbers per case
 * for inspection, mirroring the sibling fan-out / self-seeding eval
 * pattern. The decision is taken by reading the printed pass-rate
 * matrix and matching it against the matrix above.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-120-child-steering
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-120-child-steering/cases.ts (data)
 *   - docs/features/v0.7.39.md Phase 5b (design + acceptance criteria)
 *   - tests/feature-151-fan-out-plan-granularity.eval.ts (sibling pattern)
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
} from '../benchmark/datasets/feature-120-child-steering/cases.js';

// Raw-output dump root — driver always writes per-case JSON for offline
// LLM-as-judge cross-validation against the regex judges (EVAL_GUIDELINES
// mechanical-assertion compliance check, §"Raw output preservation").
// Lives under the OS tmp directory so the dump is treated as a transient
// runtime artifact (cleaned by OS) and cannot accidentally leak into the
// repo working tree. Run prints the absolute path so an operator can find
// it for offline LLM-judge audit.
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-120-child-steering');

// EVAL_GUIDELINES — Phase 1 cross-family validation (Layer 2, multi-alias):
//
// First-pass exploration goes straight to 5 aliases at 5 runs/cell. The
// child-steering prompt block is small (~25 lines) and the assertion is
// crisp (specific tool name + specific task_id substring), so the noise
// floor is low enough that we don't need a 1-alias exploratory pass first.
//
// Budget: 2 cases × 5 runs × 5 aliases = 50 calls × ~$0.03/call avg ≈ $1.5
// ROI: $1.5 buys one ship-or-revert decision for FEATURE_120 Phase 5b
// prompt — well within EVAL_GUIDELINES "$5 实验换一条 production prompt
// 改动: 值" guidance.
//
// Concurrency: per-alias single-call (反模式 3), cross-alias serial in vitest.
// Aliases: same set as feature-151 Phase 2 — 5 production aliases excluding
// ds/v4flash (floor-model bias already documented; not needed for ship
// decision when 5 aliases above it cover the space).
const STAGE_LABEL = 'phase1-multialias-5run-with-dump';
const RUNS_PER_CELL = 5;
const PHASE1_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/glm51',
  'ds/v4pro',
] as const;

describe('Eval: FEATURE_120 Phase 5b async child steering (v0.7.39)', () => {
  const aliases = availableAliases(...PHASE1_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Phase 1 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 5 alias × 5 runs × 60s/call worst case = 25 min/case.
      // Per-call upper bound 300s acceptable per user direction; total wall
      // for 2 cases ≈ 50 min worst case, typically ~10 min/case.
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

        // Per-case pass-rate + per-alias status to the test console
        // without hard-failing. Threshold gating is post-pilot —
        // operator reads the matrix and matches against the pre-
        // registered SHIP/PARTIAL/REJECT decision matrix above.
        const lines: string[] = [];
        lines.push(`[feature-120-child-steering][${c.id}]`);
        lines.push(`  expectTool:   ${c.expectTool}`);
        lines.push(`  expectTaskId: ${c.expectTaskId}`);
        lines.push(`  behaviour:    ${c.behaviour}`);
        const cells = result.byVariant['v0.7.39'] ?? [];
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

        // Dump raw outputs for LLM-as-judge cross-validation. One file
        // per case; lives under os.tmpdir() / kodax-eval-dumps so the
        // OS reaps it as a transient runtime artifact (cannot leak
        // into repo tree). EVAL_GUIDELINES §"Raw output preservation"
        // mandates this for any regex-judge'd eval that drives a ship
        // decision — operator MUST be able to spot-check whether the
        // regex pass/fail reflects actual model behaviour.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectTool: c.expectTool,
          expectTaskId: c.expectTaskId,
          behaviour: c.behaviour,
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
