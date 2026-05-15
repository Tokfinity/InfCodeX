/**
 * Eval: FEATURE_165 (v0.7.41) Worker `HARD PRECONDITION` for emit_handoff
 * — Layer 2 single-turn probe for the proposed prompt addition.
 *
 * ## Purpose
 *
 * The runtime gate at `runner-driven.ts` line 2402 is the deterministic
 * backstop — it rejects `emit_handoff` with `isError:true` whenever
 * `ctx.childTaskRegistry.size > 0`. This eval validates the
 * COMPLEMENTARY prompt change: an explicit HARD PRECONDITION line in
 * `worker-role-prompt.ts` `handoffRules` so the LLM avoids emitting
 * a doomed-to-fail handoff in the first place (cleaner trace, no
 * wasted turn).
 *
 * 5 cases × 2 variants × 3 aliases × 5 runs/cell = 150 LLM calls
 * (~$5-8 at zhipu/glm51 + kimi + ds/v4pro pricing).
 *
 * ## Pre-registered decision matrix
 *
 *   SHIP the prompt addition iff ALL of:
 *
 *     (a) Negative cases (D + E) on v_proposed pass-rate ≥ 80% on ≥ 2/3 aliases.
 *     (b) Negative cases (D + E) on v_proposed − v_baseline ≥ +10pp on ≥ 2/3 aliases
 *         (real improvement, not noise — δ < 10pp is below the noise
 *         floor per EVAL_GUIDELINES anti-pattern 6).
 *     (c) Positive cases (A + B + C) on v_proposed ≥ v_baseline − 10pp on
 *         every alias (no cross-case regression on the emit_handoff main
 *         path — memory `feedback_prompt_strengthening_cross_case_regression`
 *         is the explicit precedent).
 *
 *   PARTIAL — drop the prompt addition, keep the runtime gate only.
 *   The gate alone closes the user-visible bug; the prompt was
 *   nice-to-have for cleaner LLM behaviour. Not shipping the prompt
 *   has zero correctness cost — the worst outcome is one wasted LLM
 *   turn per premature handoff attempt.
 *
 *   REJECT (regression) — actively roll the prompt back. Should only
 *   happen if the test driver itself is buggy (because v_baseline IS
 *   the current production prompt). If REJECT triggers, audit the
 *   driver before touching the prompt.
 *
 * ## Audit requirements (EVAL_GUIDELINES anti-pattern 7 §3)
 *
 * Every negative-case regex-fail MUST be cross-validated by an LLM
 * judge before being trusted. The driver dumps raw text + toolCalls
 * per cell to `os.tmpdir()/kodax-eval-dumps/feature-165-handoff-wait-gate/`
 * so the audit can run offline. Judges:
 *
 *   1. Allowed (per `EVAL_GUIDELINES.md` §"Judge 模型选择约束"):
 *      Self-judge by the orchestrating Claude session (audit JSON dump),
 *      OR panel-internal majority vote (zhipu/glm51 + ds/v4pro + kimi).
 *
 *   2. Forbidden: anthropic claude / openai gpt — they're outside the
 *      panel distribution and bias the judgement (over-tolerant of
 *      zhipu's syntax / over-strict on other axes).
 *
 *   3. Disagreement threshold: if regex-vs-LLM-judge disagree > 10% on
 *      any case × alias × variant cell, the cell's data is INVALID;
 *      redesign the canned history or judge before treating the
 *      number as evidence.
 *
 * ## Status
 *
 * Drafted with the runtime gate (see
 * `packages/coding/src/task-engine/runner-driven.ts:2402` + sibling
 * unit tests in `runner-driven.test.ts`'s FEATURE_165 describe block).
 *
 * **NOT YET RUN.** The actual prompt change to `worker-role-prompt.ts`
 * is gated on this eval producing data above the SHIP thresholds.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-165-handoff-wait-gate
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-165-handoff-wait-gate/cases.ts (data)
 *   - docs/features/v0.7.41.md §FEATURE_165 (design)
 *   - packages/coding/src/task-engine/runner-driven.ts:2402 (the gate)
 *   - tests/feature-120-child-steering.eval.ts (sibling pattern)
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
} from '../benchmark/datasets/feature-165-handoff-wait-gate/cases.js';

// Raw-output dump root — OS-managed transient location per
// EVAL_GUIDELINES §"Raw output preservation".
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-165-handoff-wait-gate');

// Panel-internal alias set covering 5 production-tier aliases:
//   - zhipu/glm51   — known intent-vs-action floor (memory
//                     `project_zhipu_send_message_floor`); the highest-
//                     risk alias for prompt cross-case regression.
//   - kimi          — separate family, validates portability.
//   - ds/v4pro      — DeepSeek high-tier; separate family.
//   - ds/v4flash    — DeepSeek floor-tier; cheapest, useful to bound
//                     the weakest-model behaviour we ship for.
//   - mmx/m27       — MiniMax family, broadens panel coverage so the
//                     SHIP decision generalises across 4 distinct
//                     model families (zhipu / moonshot / deepseek /
//                     minimax) — directly per memory
//                     `feedback_eval_partial_alias_expansion`.
//
// Cost target ~$7.50-$12.50 (5 cases × 2 variants × 5 aliases × 5
// runs/cell = 250 calls × ~$0.03-$0.05 avg). EVAL_GUIDELINES
// anti-pattern 4: 5 aliases is the verification-tier panel breadth
// the FEATURE_120 / FEATURE_151 sibling probes settled on; matches
// the budget envelope for a single SHIP/PARTIAL/REJECT decision.
const STAGE_LABEL = 'phase1-multialias-5run-with-dump';
const RUNS_PER_CELL = 5;
const PHASE1_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'ds/v4pro',
  'ds/v4flash',
  'mmx/m27',
] as const;

describe('Eval: FEATURE_165 v0.7.41 emit_handoff HARD PRECONDITION prompt addition', () => {
  const aliases = availableAliases(...PHASE1_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Phase 1 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} (${c.polarity}) — ${STAGE_LABEL}`,
      // 25-min cap: 3 alias × 5 runs × 2 variants × 60s/call worst case = 30 min/case.
      { timeout: 30 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        // Per-case + per-variant pass-rate matrix to test console.
        // Pre-registered SHIP/PARTIAL/REJECT decision (see file header)
        // is read off this matrix; no hard expect.fail here — eval
        // collects data, operator decides.
        const lines: string[] = [];
        lines.push(`[feature-165-handoff-wait-gate][${c.id}]`);
        lines.push(`  polarity:    ${c.polarity}`);
        lines.push(`  description: ${c.description}`);
        for (const variantId of ['v_baseline', 'v_proposed'] as const) {
          const cells = result.byVariant[variantId] ?? [];
          let totalRuns = 0;
          let totalPassed = 0;
          lines.push(`  --- variant: ${variantId} ---`);
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
              `    ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)`
                + (failureSummary ? `  (failed: ${failureSummary})` : ''),
            );
          }
          const overallRate = totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(1)
            : 'n/a';
          lines.push(`    overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump raw outputs for offline audit. Schema extends
        // feature-120-child-steering's shape with a `variants` wrapper
        // (the case has 2 variants vs 120's 1) and a placeholder
        // `auditJudges` slot per run: when the operator runs the
        // panel-internal LLM-judge audit (anti-pattern 7 §3), the
        // results land in `auditJudges` so the dump remains the
        // single source of truth for both regex + audit verdicts.
        // EVAL_GUIDELINES §"Raw output preservation" requires the
        // judge findings be persisted alongside the run, not held in
        // ephemeral conversation context.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dump = {
          case: c.id,
          polarity: c.polarity,
          description: c.description,
          stage: STAGE_LABEL,
          variants: variants.map((variant) => ({
            variantId: variant.id,
            userMessage: variant.userMessage,
            priorMessages: variant.priorMessages,
            aliases: (result.byVariant[variant.id] ?? []).map((cell) => ({
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
                // Filled by the offline panel-internal audit step
                // (see file header: ≥1 regex-fail per cell × case ×
                // variant must be cross-validated; >10% disagreement
                // invalidates the cell). Empty when this driver
                // writes the dump — populated by the audit script.
                auditJudges: [] as Array<{
                  readonly judge: string;
                  readonly passed: boolean;
                  readonly reason?: string;
                }>,
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
