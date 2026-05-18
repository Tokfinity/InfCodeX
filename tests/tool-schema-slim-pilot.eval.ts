/**
 * Eval: Tool-schema slim variants pilot (v0.7.41).
 *
 * Per EVAL_GUIDELINES anti-pattern 4 (探索期就开多 alias = wrong)
 * + feedback_eval_pilot_before_scale: run 1 alias × 2 cases × 3 runs FIRST
 * to confirm v1_orig actually triggers the expected tool call before
 * scaling to the full 4-alias × 3-variant × 9-case panel.
 *
 * Cheap alias: `ds/v4flash` (DeepSeek flash — fastest, cheapest of the 4).
 *
 * Pilot cases: AUQ_1_positive_single (must-call) + AUQ_4_negative_trivial
 * (must-not-call). If v1_orig fails BOTH the must-call positive and the
 * must-not-call negative on the cheap alias, the case design is wrong
 * — abort before spending budget on the full panel.
 *
 * ## Run
 *
 *   npm run test:eval -- tool-schema-slim-pilot
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
} from '../benchmark/datasets/tool-schema-slim/cases.js';

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim-pilot');

const PILOT_ALIASES = ['ds/v4flash'] as const;
const PILOT_CASE_IDS = ['AUQ_1_positive_single', 'AUQ_4_negative_trivial'] as const;
const RUNS_PER_CELL = 3;

describe('Eval: tool-schema slim pilot — v1_orig only × 1 alias × 2 cases × 3 runs', () => {
  const aliases = availableAliases(...PILOT_ALIASES);

  if (aliases.length === 0) {
    it('skips: no provider API keys in env for the requested alias set', () => {});
    return;
  }

  for (const caseId of PILOT_CASE_IDS) {
    const caseSpec = CASES.find((c) => c.id === caseId);
    if (!caseSpec) {
      it(`skips ${caseId} — not found in CASES`, () => {});
      continue;
    }
    it(
      `${caseId} — v1_orig only × ${aliases.length}-alias × ${RUNS_PER_CELL}-run (pilot, trigger check)`,
      { timeout: 10 * 60_000 },
      async () => {
        // Pilot: only test v1_orig to verify case triggers correctly.
        const allVariants = buildPromptVariants(caseId);
        const v1 = allVariants.find((v) => v.id === 'v1_orig');
        if (!v1) throw new Error('v1_orig variant missing');
        const judges = buildJudges(caseId);

        const result = await runBenchmark({
          variants: [v1],
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const lines: string[] = [];
        lines.push(`[tool-schema-slim-pilot][${caseId}] polarity=${caseSpec.polarity}`);
        for (const judge of judges) {
          lines.push(`  judge: ${judge.name}`);
        }
        const cells = result.byVariant['v1_orig'] ?? [];
        lines.push('');
        lines.push('  --- variant: v1_orig (pilot) ---');
        for (const cell of cells) {
          const passed = cell.runsRaw.filter((r) => r.passed).length;
          const total = cell.runsRaw.length;
          const rate = total > 0 ? ((passed / total) * 100).toFixed(0) : 'n/a';
          lines.push(`    ${cell.alias.padEnd(13)} ${passed}/${total} (${rate}%)`);
          // Per-run reason if any failed
          for (const run of cell.runsRaw) {
            if (!run.passed) {
              const failed = run.judges.filter((j) => !j.passed).map((j) => `${j.name}: ${j.reason ?? ''}`);
              lines.push(`      run#${run.runIndex}: ${failed.join(' | ')}`);
            }
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dump = {
          case: caseId,
          polarity: caseSpec.polarity,
          stage: 'pilot-v1-only',
          variants: [
            {
              variantId: 'v1_orig',
              description: v1.description,
              systemPrompt: v1.systemPrompt,
              userMessage: v1.userMessage,
              priorMessages: v1.priorMessages,
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
            },
          ],
        };
        const dumpPath = join(DUMP_ROOT, `${caseId}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
