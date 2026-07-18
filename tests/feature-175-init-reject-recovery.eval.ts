/**
 * Eval: FEATURE_175 (v0.7.42) plan-list resilience —
 * op:'init' dirty-store reject recovery probe.
 *
 * ## Purpose
 *
 * Production session 20260519 exposed: V2 Worker mid-task (2/4 items
 * completed) calls `todo_update({op:"init", items:[...]})` to refine
 * scope; the legacy store.init() unconditionally wiped all status back
 * to pending; plan UI flipped "2/4 completed" → "0/N completed"; user
 * reads it as "the list invalidated itself".
 *
 * Slice 1 (Slice 1 fix #3 in the v0.7.42 plan) ships a tool-layer
 * reject that returns `{ok:false, reason: <structured>}` and names the
 * surgical recovery APIs in the reason field. This probe asks the
 * unobservable question: does the LLM actually pick up the surgical
 * APIs the reject reason names, or does it loop on op:'init'?
 *
 * 2 cases × 5 aliases × 5 runs = 50 LLM calls, ~$2-5.
 *
 * ## Pre-registered SHIP gate
 *
 *   SHIP (keep dirty-reject) IFF all of:
 *     (a) ≥4 of 5 alias达 ≥60% recovery rate on C1 (additive scope)
 *     (b) zhipu/glm52 NOT at 0% on C1 (structural floor → revert)
 *     (c) ≥3 of 5 alias达 ≥40% recovery rate on C2 (pivot scope)
 *     (d) self-judge audit disagreement < 10% on regex-fail samples
 *
 *   REVERT (delete dirty-reject from todo-update.ts:executeInitOp;
 *   keep todo-store.ts init() preserve + runner-driven.ts B2 synth
 *   autoComplete) IFF any of (a)-(d) fails.
 *
 * ## Sample size escalation
 *
 *   5 runs/cell baseline. Cells in the 65-85% statistical-uncertainty
 *   band → operator re-runs RUNS_PER_CELL=10 on affected cells before
 *   SHIP matrix. No auto-escalate.
 *
 * ## Audit
 *
 *   Per anti-pattern 7 §3 + EVAL_GUIDELINES §"Judge 模型选择约束" rule 1:
 *   regex-fail samples are cross-validated by the orchestrating Claude
 *   session (self-judge mode permitted for ≤50 cells). Raw dumps land
 *   at `os.tmpdir()/kodax-eval-dumps/feature-175-init-reject-recovery/`
 *   so the audit can run offline.
 *
 *   The HARNESS CONTEXT in the audit prompt MUST include the binding
 *   `toolCalls` field per [[feedback_audit_binding_priority_in_prompt]]
 *   — empty `text` payloads with non-empty `toolCalls` are PASS, not
 *   FAIL.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-175-init-reject-recovery
 *
 *   Pilot first (anti-pattern 4 + feedback_eval_pilot_before_scale):
 *   set RUNS_PER_CELL=1 and slice ALIASES to ['ds/v4flash'] for a 2-call
 *   pilot before scaling to the full panel.
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
} from '../benchmark/datasets/feature-175-init-reject-recovery/cases.js';

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-175-init-reject-recovery',
);

const STAGE_LABEL = 'phase1-multialias-5run-with-dump';
const RUNS_PER_CELL = 5;

// Canonical 5-alias panel per EVAL_GUIDELINES §"Canonical alias panel"
// (2026-05-19 lock). Same panel as FEATURE_167 / FEATURE_170 — covers
// 4 distinct model families (zhipu / moonshot / minimax / deepseek)
// with deepseek double-tier (flash floor + pro high-end).
const PHASE1_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ds/v4pro',
  'ds/v4flash',
] as const;

describe('Eval: FEATURE_175 v0.7.42 op:init dirty-reject recovery', () => {
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

        const lines: string[] = [];
        lines.push(`[feature-175-init-reject-recovery][${c.id}]`);
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

        // Dump raw outputs for offline self-judge audit (anti-pattern 7 §3 +
        // EVAL_GUIDELINES §"Raw output preservation"). Schema mirrors
        // FEATURE_165 / FEATURE_166 / FEATURE_167 dumps so the audit
        // tooling is uniform across datasets.
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
