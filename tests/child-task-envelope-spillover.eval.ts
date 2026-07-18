/**
 * Eval: FEATURE_121 v0.7.40 — child-task envelope spillover dispatch bullet.
 *
 * ## Purpose
 *
 * Verifies the `LARGE CHILD OUTPUT (FEATURE_121 v0.7.40)` dispatch-rules
 * bullet added to `packages/coding/src/agents/worker-role-prompt.ts`
 * (`dispatchRules` constant). The bullet's contract is that the Worker
 * uses the preview embedded in the `<task-completed>` banner as the
 * primary source AND only invokes `Read` on the spillover path when the
 * user's task genuinely needs detail beyond the preview.
 *
 * Three cases, one positive + two negative:
 *
 *   1. **preview_sufficient**   — brief yes/no ask, preview answers it →
 *      expect `ACTION: respond_inline`, NO `ACTION: Read(...)`.
 *   2. **detail_required**      — user explicitly wants every issue with
 *      paths + line numbers → expect `ACTION: Read("/tmp/kodax/...")`.
 *   3. **inline_no_spillover**  — no spillover marker present → expect
 *      `ACTION: respond_inline`, NO `ACTION: Read(...)` (defends against
 *      blanket-Read regression).
 *
 * The output contract pins detection to `ACTION:` prefix + parens, which
 * keeps the negative-case detector mechanical AND immune to chain-of-
 * thought confusion (EVAL_GUIDELINES anti-pattern 7 §1 "absolute
 * structural assertion as alternative to LLM-judge pair").
 *
 * ## Run model — Layer 2 cross-family validation
 *
 * Each run is a single-turn LLM probe via `runOneShot` (via `runBenchmark`).
 * Topology: 4 alias × 3 case × 5 runs = 60 LLM calls (~$2).
 *
 * **Pre-registered decision matrix** (set BEFORE any LLM call):
 *
 *   - SHIP:    ≥3 of 4 panel aliases hit ≥80% on EACH case
 *              AND cross-alias max-min spread ≤ 15pp
 *              → ship FEATURE_121 dispatch bullet as designed
 *   - PARTIAL: 1-2 aliases ≥80%, others <80% but ≥60%
 *              → ship anyway, document weak-model behaviour in test guide
 *   - REJECT:  0 aliases ≥80% OR spread >25pp
 *              → revise prompt bullet (next iteration scope)
 *
 * No hard `expect.fail` — eval records numbers per case for inspection;
 * decision is taken from the printed table + raw-output dumps. Matches
 * the sibling FEATURE_151 / FEATURE_120 driver convention.
 *
 * ## Run
 *
 *   KODAX_EVAL_F121_SPILLOVER=1 npm run test:eval -- child-task-envelope-spillover
 *
 * Skipped by default (gated on `KODAX_EVAL_F121_SPILLOVER=1`) so CI
 * without paid keys never burns budget on Layer 2 runs. Also skips
 * per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## Judge audit
 *
 * Raw outputs land at `os.tmpdir()/kodax-eval-dumps/feature-121-envelope-
 * spillover/<case>.json` (EVAL_GUIDELINES §Raw output preservation). If
 * the regex pass-rate looks suspicious, an operator can spin up a sibling
 * panel-internal LLM-judge audit (zhipu/glm52 + ds/v4pro + kimi 2/3
 * majority) over those dumps — the FEATURE_120 child-steering pair
 * (`tests/feature-120-child-steering-judge-audit.eval.ts`) is the
 * reference implementation.
 *
 * ## Cost budget
 *
 *   Layer 1 (unit test):          $0 — worker-role-prompt.test.ts pins
 *                                       the prompt segment text + ordering.
 *   Layer 2 (this driver):        4 alias × 3 case × 5 runs ≈ $2 — buys
 *                                       a SHIP/REVISE decision on the
 *                                       v0.7.40 dispatch bullet.
 *   Layer 3 (judge audit, opt.):  60 cells × 3 judges ≈ $1 — only if
 *                                       regex disagreement is suspected.
 *   Total worst case:             ~$3 for one prompt bullet — within
 *                                 EVAL_GUIDELINES "$5 实验换一条 production
 *                                 prompt 改动: 值".
 *
 * ## See also
 *
 *   - `benchmark/datasets/feature-121-envelope-spillover/cases.ts` (data)
 *   - `packages/coding/src/agents/worker-role-prompt.ts` (source of truth)
 *   - `packages/coding/src/agents/worker-role-prompt.test.ts` (Layer 1 pin)
 *   - `docs/features/v0.7.40.md#feature_121` (design + acceptance criteria)
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
} from '../benchmark/datasets/feature-121-envelope-spillover/cases.js';

// Raw-output dump root — driver always writes per-case JSON for offline
// LLM-as-judge cross-validation against the regex judges (EVAL_GUIDELINES
// mechanical-assertion compliance check, see §Raw output preservation).
// Lives under the OS tmp directory so the dump is a transient runtime
// artifact (cleaned by OS) and cannot accidentally leak into the repo
// working tree. Run prints the absolute path so an operator can find
// it for offline LLM-judge audit.
const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-121-envelope-spillover',
);

const GATE_ENV = 'KODAX_EVAL_F121_SPILLOVER';
const STAGE_LABEL = 'v0.7.40-panel-5run-with-dump';
const RUNS_PER_CELL = 5;

// Panel-internal, multi-family (4 independent vendor families per
// EVAL_GUIDELINES 2026-05-12 judge-model-selection clause — zhipu /
// kimi-code / deepseek / minimax). No anthropic / openai.
const PANEL_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'ds/v4flash',
  'mmx/m3',
] as const;

describe('Eval: FEATURE_121 envelope-spillover dispatch bullet (v0.7.40)', () => {
  const live = process.env[GATE_ENV] === '1';
  if (!live) {
    it.skip(`gated by ${GATE_ENV}=1 (skip default in CI)`, () => {});
    return;
  }

  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it.skip(
      `no provider API keys in env for any panel alias (${PANEL_ALIASES.join(', ')})`,
      () => {},
    );
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 25-min cap: 4 alias × 5 runs × 60s/call worst case ≈ 20 min/case.
      // Per-call upper bound 300s acceptable; typical ~10 min/case.
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

        // Pilot logging mirrors feature-151-fan-out-plan-granularity.eval.ts:
        // record per-case pass-rate + per-alias status to the test console
        // without hard-failing. Threshold gating is a human read of the
        // pre-registered SHIP/PARTIAL/REJECT matrix above.
        const lines: string[] = [];
        lines.push(`[feature-121-envelope-spillover][${c.id}]`);
        lines.push(`  expectRead: ${c.expectRead}`);
        lines.push(`  behaviour:  ${c.behaviour}`);

        const cells = result.byVariant['v0.7.40'] ?? [];
        let totalRuns = 0;
        let totalPassed = 0;
        const perAliasRate: number[] = [];
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
            cellTotal > 0 ? (cellPassed / cellTotal) * 100 : 0;
          perAliasRate.push(cellRate);
          const failureSummary = Object.entries(failureCount)
            .map(([name, n]) => `${name}×${n}`)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate.toFixed(0)}%)` +
              (failureSummary ? `  (failed: ${failureSummary})` : ''),
          );
        }
        const overallRate =
          totalRuns > 0 ? ((totalPassed / totalRuns) * 100).toFixed(1) : 'n/a';
        const spread =
          perAliasRate.length > 0
            ? Math.max(...perAliasRate) - Math.min(...perAliasRate)
            : 0;
        lines.push(`  overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        lines.push(`  cross-alias max-min spread: ${spread.toFixed(0)}pp`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump raw outputs for LLM-as-judge cross-validation. One file
        // per case; lives under os.tmpdir() so the OS reaps it as a
        // transient runtime artifact (cannot leak into repo tree).
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          expectRead: c.expectRead,
          behaviour: c.behaviour,
          userMessage: variant?.userMessage ?? '',
          systemPrompt: variant?.systemPrompt ?? '',
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
