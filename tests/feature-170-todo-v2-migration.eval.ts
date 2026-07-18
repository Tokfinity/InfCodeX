/**
 * Eval: FEATURE_170 (v0.7.41) — Todo V2 Migration prompt rewrite.
 *
 * ## Purpose
 *
 * Verifies the v0.7.41 C5 prompt rewrite (`worker-role-prompt.ts` 4 sections
 * + `role-prompt.ts` legacy block + `todo-throttle-reminder.ts` populated-
 * all-terminal branch) effectively teaches the per-item API (`todo_create`,
 * `todo_update({id, content?, status?, ...})`, `todo_update({id,
 * status:"deleted"})`) WITHOUT regressing the existing `op:'init'` batch
 * path and the status-flip backwards-compat.
 *
 * ## Five cases (3 NEW + 1 INITIAL + 1 BACKWARDS-COMPAT)
 *
 *   1. mid_task_insert_via_todo_create — expect todo_create, NOT op:init
 *   2. mid_task_content_patch — expect todo_update({id, content})
 *   3. mid_task_delete_obsolete — expect todo_update({id, status:"deleted"})
 *   4. initial_plan_commitment — accept op:init OR ≥2 todo_create
 *   5. status_flip_backwards_compat — expect todo_update({id, status})
 *
 * ## Pre-registered decision matrix
 *
 *   SHIP iff:
 *     (a) C1+C2+C3 each ≥70% pass rate on v_proposed, ≥3-of-5 alias
 *     (b) C5 NOT regressed >10pp on v_proposed vs v_baseline on any alias
 *     (c) C1+C2+C3 Δ ≥ +20pp on v_proposed vs v_baseline, ≥3-of-5 alias
 *   PARTIAL: runtime ships, keep planFirstContract only, revert other
 *            sections to limit cross-section regression risk
 *   REJECT:  C5 regressed ≥20pp (backwards-compat break) → revert all
 *            prompt changes, keep tool/store/extension paths only
 *
 * ## Pilot → Phase 1
 *
 * KODAX_EVAL_PILOT_ONLY=1: 1 alias × 5 case × 2 variant × 1 run = 10 calls (~$0.40).
 * Full Phase 1:           5 alias × 5 case × 2 variant × 5 runs = 250 calls (~$10).
 *
 * ## Run
 *
 *   KODAX_EVAL_PILOT_ONLY=1 npm run test:eval -- feature-170-todo-v2-migration
 *   npm run test:eval -- feature-170-todo-v2-migration
 *
 * Skips when no provider API keys are present.
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
} from '../benchmark/datasets/feature-170-todo-v2-migration/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-170-todo-v2-migration');

const PHASE1_ALIASES = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/glm51',
  'ds/v4pro',
] as const;
const PILOT_ALIAS = 'ds/v4flash' as const;

const PILOT_ONLY = process.env.KODAX_EVAL_PILOT_ONLY === '1';
const STAGE_LABEL = PILOT_ONLY
  ? 'pilot-1alias-1run'
  : 'phase1-5alias-5run-with-dump';
const RUNS_PER_CELL = PILOT_ONLY ? 1 : 5;

describe('Eval: FEATURE_170 Todo V2 Migration prompt rewrite (v0.7.41)', () => {
  const aliases = PILOT_ONLY
    ? availableAliases(PILOT_ALIAS)
    : availableAliases(...PHASE1_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 45 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const PRIMARY_JUDGE = judges[0]?.name;
        const lines: string[] = [];
        lines.push(`[feature-170-todo-v2-migration][${c.id}]`);
        lines.push(`  polarity:        ${c.polarity}`);
        lines.push(`  behaviour:       ${c.behaviour}`);
        lines.push(`  primary judge:   ${PRIMARY_JUDGE ?? '(none)'}`);

        for (const variantId of ['v_baseline', 'v_proposed']) {
          const cells = result.byVariant[variantId] ?? [];
          let totalRuns = 0;
          let totalPassed = 0;
          lines.push('');
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
              `    ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)` +
                (failureSummary ? `  (failed: ${failureSummary})` : ''),
            );
          }
          const overallRate = totalRuns > 0
            ? ((totalPassed / totalRuns) * 100).toFixed(1)
            : 'n/a';
          lines.push(`    overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const variantList = variants;
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          polarity: c.polarity,
          behaviour: c.behaviour,
          variants: variantList.map((variant) => {
            const cells = result.byVariant[variant.id] ?? [];
            return {
              variantId: variant.id,
              description: variant.description,
              systemPrompt: variant.systemPrompt,
              userMessage: variant.userMessage,
              priorMessages: variant.priorMessages ?? [],
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
          }),
        };
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
