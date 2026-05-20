/**
 * Eval: FEATURE_178 stall sidecar viability probe
 *
 * **Purpose**: validate that the KodaX main model can serve as its own
 * second-pass stall-detection sidecar. Layer 2 single-turn probe — for
 * each (alias × case × run) we send the sidecar SYSTEM_PROMPT + canned
 * priorMessages (the recent "stuck-looking" history) + a final user
 * message containing the L1 detector signal, and let the model call
 * `report_stall_judgment` with its verdict.
 *
 * **Design + decision matrix**: see
 *   benchmark/datasets/feature-178-stall-sidecar/cases.ts (docstring)
 *
 * **Run modes** (env var `KODAX_F178_PROBE`):
 *   - `pilot`  → ds/v4flash × 2 cases (P1 + N1) × 1 run = 2 calls (~$0.01).
 *                Validates design before scale.
 *   - `scale`  → 5 alias × N cases × 5 runs = 50-150 calls (~$10).
 *                Only run after pilot passes pre-registered gate.
 *
 * **Run**:
 *   KODAX_F178_PROBE=pilot npm run test:eval -- feature-178-stall-sidecar
 *   KODAX_F178_PROBE=scale npm run test:eval -- feature-178-stall-sidecar
 *
 * Skips when API keys absent. Not in regular CI — manual invocation only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  buildSidecarUserMessage,
  CASES,
  classifyJudgment,
  SIDECAR_SYSTEM_PROMPT,
  TOOLS,
} from '../benchmark/datasets/feature-178-stall-sidecar/cases.js';

const MODE = process.env.KODAX_F178_PROBE ?? 'pilot';
const SCALE = MODE === 'scale';

const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ds/v4pro',
  'ds/v4flash',
];

const SCALE_PANEL: readonly ModelAlias[] = process.env.KODAX_F178_ALIASES
  ? (process.env.KODAX_F178_ALIASES.split(',').map((s) => s.trim()) as readonly ModelAlias[])
  : DEFAULT_SCALE_PANEL;

const PILOT_PANEL: readonly ModelAlias[] = ['ds/v4flash'];

const RUNS = SCALE ? 5 : 1;
const REQUESTED = SCALE ? SCALE_PANEL : PILOT_PANEL;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-178-stall-sidecar');

interface ProbeRow {
  caseId: string;
  expectedIsStuck: boolean;
  alias: ModelAlias;
  runIndex: number;
  durationMs: number;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  emittedReport: boolean;
  schemaValid: boolean;
  isStuck: boolean | null;
  suggestedToolValid: boolean;
  primaryPassed: boolean;
}

describe(`Eval: FEATURE_178 stall sidecar (${MODE})`, () => {
  const aliases = availableAliases(...REQUESTED);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all probes and dumps raw output',
    { timeout: SCALE ? 2_400_000 : 600_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const rows: ProbeRow[] = [];
      // Incremental dump path — written after every row so partial runs
      // (timeouts / process kill) preserve data instead of losing all
      // 100+ probe results because the final-write never happened.
      const incrementalDumpPath = join(DUMP_ROOT, `${MODE}-incremental-${Date.now()}.json`);
      const flushIncremental = () => {
        writeFileSync(
          incrementalDumpPath,
          JSON.stringify(
            {
              mode: MODE,
              timestamp: new Date().toISOString(),
              aliases,
              runs: RUNS,
              completedRows: rows.length,
              expectedRows: CASES.length * aliases.length * RUNS,
              rows,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };
      // eslint-disable-next-line no-console
      console.log(`[F178] incremental dump: ${incrementalDumpPath}`);

      for (const c of CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(`[F178] case=${c.id} alias=${alias} run=${runIndex}`);
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: SIDECAR_SYSTEM_PROMPT,
                userMessage: buildSidecarUserMessage(c),
                tools: TOOLS,
                // No priorMessages — the main agent transcript is embedded inside
                // userMessage via renderTranscript, so the sidecar's role separation
                // (judge vs judged) is unambiguous. Passing assistant-role messages
                // via priorMessages caused models to mis-attribute the transcript
                // to themselves (observed during pilot).
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(`[F178] error case=${c.id} alias=${alias}: ${(err as Error).message}`);
              continue;
            }
            const cls = classifyJudgment(result.toolCalls);
            const primaryPassed =
              cls.emittedReport
              && cls.schemaValid
              && cls.isStuck === c.expectedIsStuck
              && cls.suggestedToolValid;
            rows.push({
              caseId: c.id,
              expectedIsStuck: c.expectedIsStuck,
              alias,
              runIndex,
              durationMs: result.durationMs,
              text: result.text,
              toolCalls: result.toolCalls,
              emittedReport: cls.emittedReport,
              schemaValid: cls.schemaValid,
              isStuck: cls.isStuck,
              suggestedToolValid: cls.suggestedToolValid,
              primaryPassed,
            });
            // Flush after every row so a timeout / crash preserves all
            // completed probes (the 2026-05-20 first scale lost 100+
            // probes when the 15min ceiling killed the test before the
            // final-write at the end).
            flushIncremental();
          }
        }
      }

      // Per-(case, alias) summary
      const summary: Record<string, Record<string, { passed: number; total: number }>> = {};
      for (const r of rows) {
        summary[r.caseId] ??= {};
        summary[r.caseId]![r.alias] ??= { passed: 0, total: 0 };
        summary[r.caseId]![r.alias]!.total++;
        if (r.primaryPassed) summary[r.caseId]![r.alias]!.passed++;
      }

      // Dump
      const dumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            mode: MODE,
            timestamp: new Date().toISOString(),
            aliases,
            runs: RUNS,
            rows,
            summary,
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log(`\n=== FEATURE_178 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${dumpPath}`);
      for (const caseId of Object.keys(summary).sort()) {
        // eslint-disable-next-line no-console
        console.log(`\nCase ${caseId}:`);
        for (const a of Object.keys(summary[caseId]!).sort()) {
          const s = summary[caseId]![a]!;
          const pct = ((s.passed / s.total) * 100).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(`  ${a}: ${s.passed}/${s.total} (${pct}%)`);
        }
      }
    },
  );
});
