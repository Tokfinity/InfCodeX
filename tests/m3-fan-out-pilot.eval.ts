/**
 * Eval: M3 pilot — wire-level verification.
 *
 * One-shot probe on `mmx/m3` against a single case from the
 * feature-151 fan-out dataset. Purpose: confirm the new `mmx/m3` alias
 * (added to aliases.ts) routes correctly to MiniMax-M3 on the
 * minimax-coding gateway — i.e. the API accepts the `MiniMax-M3` model
 * id we put in `provider-capabilities.json`. Sanity check before
 * spending ~$3 on the 6-alias × 4-case × 5-run comparison panel.
 *
 * Topology: 1 alias × 1 case × 1 run = 1 call (~$0.05).
 * Skips when MINIMAX_CODING_API_KEY is unset.
 *
 * Raw output dumped to `os.tmpdir()/kodax-eval-dumps/m3-pilot/`.
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

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'm3-pilot');
const PILOT_CASE_ID = 'audit_5_packages';

describe('Eval: M3 pilot — wire-level routing verification', () => {
  const aliases = availableAliases('mmx/m3');
  if (aliases.length === 0) {
    it.skip('skips: MINIMAX_CODING_API_KEY not set', () => {});
    return;
  }

  const pilotCase = CASES.find((c) => c.id === PILOT_CASE_ID);
  if (!pilotCase) {
    throw new Error(`Pilot case ${PILOT_CASE_ID} not in CASES`);
  }

  it(
    `${PILOT_CASE_ID} — mmx/m3 pilot 1 call`,
    { timeout: 10 * 60_000 },
    async () => {
      const variants = buildPromptVariants(pilotCase.id);
      const judges = buildJudges(pilotCase.id);
      const result = await runBenchmark({
        variants,
        models: aliases,
        judges,
        runs: 1,
      });

      const cells = result.byVariant['v0.7.38'] ?? [];
      const cell = cells.find((c) => c.alias === 'mmx/m3');
      if (!cell || cell.runsRaw.length === 0) {
        throw new Error('No mmx/m3 cell or runs returned — wire likely failed');
      }
      const run = cell.runsRaw[0]!;
      const lines: string[] = [];
      lines.push(`[m3-pilot][${pilotCase.id}]`);
      lines.push(`  mmx/m3 ${cell.runsRaw.length} run(s)`);
      lines.push(`  regexPassed: ${run.passed}`);
      lines.push(`  durationMs:  ${run.durationMs}`);
      lines.push(`  textLen:     ${run.text.length}`);
      lines.push(`  textPreview: ${run.text.slice(0, 200).replace(/\n/g, ' \\n ')}`);
      if (run.error) lines.push(`  error: ${run.error}`);
      for (const j of run.judges) {
        lines.push(`  judge "${j.name}": ${j.passed ? 'PASS' : 'FAIL'} — ${j.reason ?? ''}`);
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      mkdirSync(DUMP_ROOT, { recursive: true });
      const variant = variants[0];
      const dump = {
        case: pilotCase.id,
        stage: 'm3-pilot-1run',
        expectInit: pilotCase.expectInit,
        minItems: pilotCase.minItems,
        behaviour: pilotCase.behaviour,
        userMessage: variant?.userMessage ?? '',
        aliases: cells.map((c) => ({
          alias: c.alias,
          passRate: c.passRate,
          runs: c.runsRaw.map((r) => ({
            runIndex: r.runIndex,
            text: r.text,
            durationMs: r.durationMs,
            error: r.error,
            regexPassed: r.passed,
            regexJudges: r.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
          })),
        })),
      };
      const dumpPath = join(DUMP_ROOT, `${pilotCase.id}.json`);
      writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`  raw-output dump: ${dumpPath}`);
    },
  );
});
