/**
 * Eval: FEATURE_167 (v0.7.41) Evaluator terminal-verdict fallback —
 * Layer 2 probe measuring tool-call incidence across 5 production
 * aliases to gate B0 / B1 / B2 SHIP decisions.
 *
 * ## Purpose
 *
 * Production session 20260515_185354 exposed: Evaluator emits text-only
 * response (no `emit_verdict` tool call); run terminates with
 * `recorder.verdict === undefined`; `deriveFinalStatus` at
 * runner-driven.ts:4146 falls back to `signal:'COMPLETE'`. Failed audits
 * are silently reported as successes — a functional bug, not lineage-only.
 *
 * This probe answers three independent questions, one per case:
 *
 *   C1 baseline rate: how often does Evaluator naturally call emit_verdict
 *      on its first turn after a clean Worker handoff?
 *      → Drives B1 retry-gate SHIP decision.
 *
 *   C2 retry recovery: after a turn-1 text-only response + injected
 *      EVALUATOR_VERDICT_RETRY_PROMPT, does turn 2 call emit_verdict?
 *      → Drives B1 cap-tuning and feasibility.
 *
 *   C3 fenced-block emission: how often does Evaluator emit a parseable
 *      ```kodax-task-verdict``` fenced block when it skips the tool call?
 *      → Drives B0 dead-code-activation SHIP decision.
 *
 * 3 cases × 5 aliases × 5 runs = 75 LLM calls, ~$2-4.
 *
 * ## Pre-registered SHIP matrix (per layer, decoupled)
 *
 *   B0 SHIPS iff: C3 emission rate > 5% on ≥ 1 alias
 *      SKIPS if C3 = 0% on all aliases (leave parser dead-coded, add a
 *      comment noting the probe data justified non-activation)
 *
 *   B1 SHIPS iff: C1 < 80% on ≥ 1 alias AND C2 ≥ 80% on ≥ 3/5 alias
 *      SKIPS if C1 ≥ 80% on all aliases (baseline already adequate)
 *      OR C2 < 50% on majority (retry ineffective — wasted budget)
 *      Special: zhipu/glm51 with C2 < 30% gets alias-specific cap=1
 *      (intent floor unrecoverable; do not waste two retries)
 *
 *   B2 SHIPS unconditionally — smoking-gun fix; the false-COMPLETE
 *      regression on line 4146 must not stand regardless of B0/B1.
 *
 * ## Sample size escalation
 *
 * 5 runs/cell baseline is thin for the 65-85% statistical-uncertainty
 * band. If any cell lands in that range on first run, the operator
 * should re-invoke this driver with RUNS_PER_CELL=10 on the affected
 * cases. The driver itself does not auto-escalate; the decision is
 * operator-controlled because the budget impact (3× cost) deserves
 * explicit approval.
 *
 * ## Audit requirements
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §3: every regex-fail must be
 * cross-validated by an LLM-judge (panel-internal majority vote)
 * before being trusted. Raw outputs dump to
 * `os.tmpdir()/kodax-eval-dumps/feature-167-evaluator-verdict-fallback/`
 * so the offline audit (`feature-167-...-judge-audit.eval.ts`) can
 * process them without rerunning the probe.
 *
 * Judge model constraint (EVAL_GUIDELINES §"Judge 模型选择约束"):
 * panel-internal 3-way majority on zhipu/glm51 + ds/v4pro + kimi.
 * Anthropic claude / OpenAI gpt are FORBIDDEN as judges.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-167-evaluator-verdict-fallback
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
} from '../benchmark/datasets/feature-167-evaluator-verdict-fallback/cases.js';

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-167-evaluator-verdict-fallback',
);

const STAGE_LABEL = 'phase1-multialias-5run-with-dump';
const RUNS_PER_CELL = 5;

// Same 5-alias verification-tier panel as FEATURE_165 / FEATURE_166
// design — covers 4 distinct model families (zhipu / moonshot / deepseek
// / minimax) so SHIP decisions generalise. Per memory
// `feedback_eval_partial_alias_expansion` if a PARTIAL outcome emerges,
// the next step is alias expansion before prompt iteration.
const PHASE1_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'ds/v4pro',
  'ds/v4flash',
  'mmx/m27',
] as const;

describe('Eval: FEATURE_167 v0.7.41 Evaluator terminal-verdict fallback', () => {
  const aliases = availableAliases(...PHASE1_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Phase 1 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} (${c.assertion}) — ${STAGE_LABEL}`,
      // 30-min cap: 5 alias × 5 runs × 60s/call worst case = 25 min/case.
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

        // Per-alias pass-rate matrix to console. SHIP matrix is
        // applied post-hoc by reading this output — driver collects
        // data only, no hard expect.fail.
        const lines: string[] = [];
        lines.push(`[feature-167-evaluator-verdict-fallback][${c.id}]`);
        lines.push(`  assertion:   ${c.assertion}`);
        lines.push(`  description: ${c.description}`);
        for (const variant of variants) {
          const cells = result.byVariant[variant.id] ?? [];
          let totalRuns = 0;
          let totalPassed = 0;
          lines.push(`  --- variant: ${variant.id} ---`);
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
            // Flag cells that land in the 65-85% statistical-uncertainty
            // band — operator should consider re-running with N=10 on
            // these alias × case pairs before applying the SHIP matrix.
            const cellPct = cellTotal > 0 ? (cellPassed / cellTotal) * 100 : 0;
            if (cellPct >= 65 && cellPct <= 85 && cellTotal > 0) {
              lines.push(
                `      ⚠ ${cell.alias} at ${cellPct.toFixed(0)}% — within `
                  + `65-85% uncertainty band. Consider re-running with `
                  + `RUNS_PER_CELL=10 before applying SHIP matrix.`,
              );
            }
          }
          const overallRate = totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(1)
            : 'n/a';
          lines.push(`    overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump raw outputs for offline LLM-judge audit (anti-pattern 7 §3).
        // Same schema as FEATURE_165 / FEATURE_166 dumps so the judge
        // audit driver can read all three datasets uniformly.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dump = {
          case: c.id,
          assertion: c.assertion,
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
                // Populated by the offline panel-internal audit step.
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
