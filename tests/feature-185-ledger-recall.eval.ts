/**
 * Eval: FEATURE_185 ledger recall pilot.
 *
 * Validates that LLMs, when given a `[Post-compact: recent operations]`
 * system message containing structured grep hits / bash exit_code+tail
 * (the F185 v0.7.42 enrichment), will answer follow-up questions by
 * citing the ledger directly rather than re-running grep / npm.
 *
 * Design + decision matrix: see
 *   benchmark/datasets/feature-185-ledger-recall/cases.ts
 *
 * Run modes (env `KODAX_F185_PROBE`):
 *   - `pilot` (default) → ds/v4flash × 2 cases × 1 run = 2 calls (~$0.01).
 *                          Validates the ledger format is parseable + the
 *                          PASS-criteria fire before scale.
 *   - `scale`            → 5 alias × 2 cases × 5 runs = 50 calls (~$0.50).
 *                          Only after pilot validates.
 *
 * Run:
 *   KODAX_F185_PROBE=pilot npm run test:eval -- feature-185-ledger-recall
 *   KODAX_F185_PROBE=scale npm run test:eval -- feature-185-ledger-recall
 *
 * Skips when API keys absent; not in regular CI.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  TOOLS,
  buildPriorMessages,
  classifyResponse,
  type LedgerRecallCase,
} from '../benchmark/datasets/feature-185-ledger-recall/cases.js';

const MODE = (process.env.KODAX_F185_PROBE ?? 'pilot') as 'pilot' | 'scale';
const SCALE = MODE === 'scale';

const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ds/v4pro',
  'ds/v4flash',
];

const SCALE_PANEL: readonly ModelAlias[] = process.env.KODAX_F185_ALIASES
  ? (process.env.KODAX_F185_ALIASES.split(',').map((s) => s.trim()) as readonly ModelAlias[])
  : DEFAULT_SCALE_PANEL;

const PILOT_PANEL: readonly ModelAlias[] = ['ds/v4flash'];

const RUNS = SCALE ? 5 : 1;
const REQUESTED = SCALE ? SCALE_PANEL : PILOT_PANEL;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-185-ledger-recall');

interface ProbeRow {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly runIndex: number;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly invokedDerivativeTool: boolean;
  readonly citedLedger: boolean;
  readonly matchedKeywords: readonly string[];
  readonly invokedToolName?: string;
  readonly primaryPassed: boolean;
}

describe(`Eval: FEATURE_185 ledger recall (${MODE})`, () => {
  const aliases = availableAliases(...REQUESTED);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all probes and dumps raw output',
    { timeout: SCALE ? 1_800_000 : 300_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const rows: ProbeRow[] = [];
      const incrementalDumpPath = join(DUMP_ROOT, `${MODE}-incremental-${Date.now()}.json`);
      const flushIncremental = (): void => {
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
      console.log(`[F185] incremental dump: ${incrementalDumpPath}`);

      for (const c of CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(`[F185] case=${c.id} alias=${alias} run=${runIndex}`);
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: c.systemPrompt,
                userMessage: c.userMessage,
                tools: TOOLS,
                priorMessages: buildPriorMessages(c),
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[F185] error case=${c.id} alias=${alias}: ${(err as Error).message}`,
              );
              continue;
            }
            const cls = classifyResponse(c, result.text, result.toolCalls);
            rows.push({
              caseId: c.id,
              alias,
              runIndex,
              durationMs: result.durationMs,
              text: result.text,
              toolCalls: result.toolCalls,
              invokedDerivativeTool: cls.invokedDerivativeTool,
              citedLedger: cls.citedLedger,
              matchedKeywords: cls.matchedKeywords,
              invokedToolName: cls.invokedToolName,
              primaryPassed: cls.primaryPassed,
            });
            flushIncremental();
          }
        }
      }

      // Per-(case, alias) summary
      const summary: Record<string, Record<string, { passed: number; total: number; cited: number; reInvoked: number }>> = {};
      for (const r of rows) {
        summary[r.caseId] ??= {};
        summary[r.caseId]![r.alias] ??= { passed: 0, total: 0, cited: 0, reInvoked: 0 };
        const s = summary[r.caseId]![r.alias]!;
        s.total++;
        if (r.primaryPassed) s.passed++;
        if (r.citedLedger) s.cited++;
        if (r.invokedDerivativeTool) s.reInvoked++;
      }

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
      console.log(`\n=== FEATURE_185 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${dumpPath}`);
      for (const caseId of Object.keys(summary).sort()) {
        // eslint-disable-next-line no-console
        console.log(`\nCase ${caseId}:`);
        for (const a of Object.keys(summary[caseId]!).sort()) {
          const s = summary[caseId]![a]!;
          const passPct = ((s.passed / s.total) * 100).toFixed(0);
          const citePct = ((s.cited / s.total) * 100).toFixed(0);
          const reInvPct = ((s.reInvoked / s.total) * 100).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(
            `  ${a}: PASS ${s.passed}/${s.total} (${passPct}%) | cited ${citePct}% | re-invoked tool ${reInvPct}%`,
          );
        }
      }
    },
  );
});

// Local LedgerRecallCase reference to satisfy import-or-fail (keeps the
// types module reachable for tsc even when the test body is gated off).
const _typeAnchor: LedgerRecallCase | undefined = undefined;
void _typeAnchor;
