/**
 * Eval: FEATURE_184 Sidecar Verifier vs in-chain Evaluator parity probe
 *
 * **Purpose**: validate that the Sidecar Verifier shape (system prompt
 * + `emit_sidecar_verdict` forced tool call) produces verdict quality
 * at least equal to the in-chain Evaluator shape (system prompt +
 * `emit_verdict` forced tool call) when both run on the same model.
 *
 * **Design + decision matrix**: see
 *   benchmark/datasets/feature-184-sidecar-verifier/cases.ts (docstring)
 *   docs/features/v0.7.45.md §FEATURE_184 Phase D.4
 *
 * **Run modes** (env var `KODAX_F184_PROBE`):
 *   - `pilot` → ark/v4flash × 1 case (B_revise_incomplete) × 1 run × 2
 *               variants = 2 calls (~$0.02). Validates design + trigger
 *               reproducibility before scale.
 *   - `scale` → 5 alias × 4 cases × 5 runs × 2 variants = 200 calls
 *               (~$10-12). Only run after pilot passes pre-registered
 *               gate.
 *   - `baseline` → 5 alias × 4 cases × 5 runs × 1 variant (baseline)
 *                  = 100 calls. Use when measuring main branch baseline
 *                  before C.1 lands.
 *   - `treatment` → 5 alias × 4 cases × 5 runs × 1 variant (treatment)
 *                   = 100 calls. Use after C.1 lands to measure post-
 *                   swap behavior.
 *
 * **Run**:
 *   KODAX_F184_PROBE=pilot     npm run test:eval -- feature-184-sidecar-verifier
 *   KODAX_F184_PROBE=baseline  npm run test:eval -- feature-184-sidecar-verifier
 *   KODAX_F184_PROBE=treatment npm run test:eval -- feature-184-sidecar-verifier
 *   KODAX_F184_PROBE=scale     npm run test:eval -- feature-184-sidecar-verifier
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
  BASELINE_EVALUATOR_SYSTEM_PROMPT,
  BASELINE_EVALUATOR_TOOL,
  CASES,
  VERIFIER_REPORT_TOOL,
  VERIFIER_SYSTEM_PROMPT,
  buildBaselineUserMessage,
  buildTreatmentUserMessage,
  classifyVerdict,
  type SidecarVerifierCase,
  type Variant,
} from '../benchmark/datasets/feature-184-sidecar-verifier/cases.js';

type Mode = 'pilot' | 'scale' | 'baseline' | 'treatment';
const MODE: Mode = (process.env.KODAX_F184_PROBE ?? 'pilot') as Mode;

const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
];

const REQUESTED_PANEL: readonly ModelAlias[] = process.env.KODAX_F184_ALIASES
  ? (process.env.KODAX_F184_ALIASES.split(',').map((s) => s.trim()) as readonly ModelAlias[])
  : MODE === 'pilot'
    ? (['ark/v4flash'] as const)
    : DEFAULT_SCALE_PANEL;

const RUNS = MODE === 'pilot' ? 1 : 5;

// Pilot uses only the case that has the highest discriminative value
// (B — intent-vs-action floor). Other modes use all four.
// KODAX_F184_CASES env var (comma-separated case ids) overrides for
// targeted spot-checks (e.g. `KODAX_F184_CASES=C_blocked_ambiguous,D_accept_via_workaround`).
const REQUESTED_CASES: readonly SidecarVerifierCase[] = (() => {
  if (process.env.KODAX_F184_CASES) {
    const wanted = new Set(process.env.KODAX_F184_CASES.split(',').map((s) => s.trim()));
    return CASES.filter((c) => wanted.has(c.id));
  }
  return MODE === 'pilot' ? CASES.filter((c) => c.id === 'B_revise_incomplete') : CASES;
})();

const VARIANTS_BY_MODE: Record<Mode, readonly Variant[]> = {
  pilot: ['baseline', 'treatment'],
  scale: ['baseline', 'treatment'],
  baseline: ['baseline'],
  treatment: ['treatment'],
};
const REQUESTED_VARIANTS = VARIANTS_BY_MODE[MODE];

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-184-sidecar-verifier');

interface ProbeRow {
  caseId: string;
  expectedVerdict: 'accept' | 'revise' | 'blocked';
  variant: Variant;
  alias: ModelAlias;
  runIndex: number;
  durationMs: number;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  emittedReport: boolean;
  schemaValid: boolean;
  verdict: 'accept' | 'revise' | 'blocked' | null;
  reason: string;
  primaryPassed: boolean;
}

describe(`Eval: FEATURE_184 sidecar verifier vs in-chain evaluator (${MODE})`, () => {
  const aliases = availableAliases(...REQUESTED_PANEL);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all probes and dumps raw output',
    { timeout: MODE === 'pilot' ? 600_000 : 3_600_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const rows: ProbeRow[] = [];
      const incrementalDumpPath = join(DUMP_ROOT, `${MODE}-incremental-${Date.now()}.json`);
      const flushIncremental = () => {
        // Re-create DUMP_ROOT on every flush — Windows tmpdir cleanup can
        // race with long-running evals (~13min for 100 cells) and remove
        // the parent dir between mkdirSync above and the first write.
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(
          incrementalDumpPath,
          JSON.stringify(
            {
              mode: MODE,
              timestamp: new Date().toISOString(),
              aliases,
              variants: REQUESTED_VARIANTS,
              runs: RUNS,
              completedRows: rows.length,
              expectedRows:
                REQUESTED_CASES.length
                * aliases.length
                * RUNS
                * REQUESTED_VARIANTS.length,
              rows,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };
      // eslint-disable-next-line no-console
      console.log(`[F184] incremental dump: ${incrementalDumpPath}`);

      for (const c of REQUESTED_CASES) {
        for (const variant of REQUESTED_VARIANTS) {
          const systemPrompt =
            variant === 'baseline'
              ? BASELINE_EVALUATOR_SYSTEM_PROMPT
              : VERIFIER_SYSTEM_PROMPT;
          const tool =
            variant === 'baseline' ? BASELINE_EVALUATOR_TOOL : VERIFIER_REPORT_TOOL;
          const userMessage =
            variant === 'baseline'
              ? buildBaselineUserMessage(c)
              : buildTreatmentUserMessage(c);

          for (const alias of aliases) {
            for (let runIndex = 0; runIndex < RUNS; runIndex++) {
              // eslint-disable-next-line no-console
              console.log(
                `[F184] case=${c.id} variant=${variant} alias=${alias} run=${runIndex}`,
              );
              let result;
              try {
                result = await runOneShot(alias, {
                  systemPrompt,
                  userMessage,
                  tools: [tool],
                });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  `[F184] error case=${c.id} variant=${variant} alias=${alias}: ${(err as Error).message}`,
                );
                continue;
              }
              const cls = classifyVerdict(variant, c.expectedVerdict, result.toolCalls);
              rows.push({
                caseId: c.id,
                expectedVerdict: c.expectedVerdict,
                variant,
                alias,
                runIndex,
                durationMs: result.durationMs,
                text: result.text,
                toolCalls: result.toolCalls,
                emittedReport: cls.emittedReport,
                schemaValid: cls.schemaValid,
                verdict: cls.verdict,
                reason: cls.reason,
                primaryPassed: cls.primaryPassed,
              });
              flushIncremental();
            }
          }
        }
      }

      // Per-(case, variant, alias) summary
      type CellKey = string; // `${caseId}|${variant}|${alias}`
      const cells = new Map<CellKey, { passed: number; total: number }>();
      for (const r of rows) {
        const key: CellKey = `${r.caseId}|${r.variant}|${r.alias}`;
        const cur = cells.get(key) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        cells.set(key, cur);
      }

      // Per-(case, variant) overall PASS%
      type OverallKey = string; // `${caseId}|${variant}`
      const overall = new Map<OverallKey, { passed: number; total: number }>();
      for (const r of rows) {
        const key: OverallKey = `${r.caseId}|${r.variant}`;
        const cur = overall.get(key) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        overall.set(key, cur);
      }

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            mode: MODE,
            timestamp: new Date().toISOString(),
            aliases,
            variants: REQUESTED_VARIANTS,
            runs: RUNS,
            rows,
            cellSummary: Object.fromEntries(cells),
            overallSummary: Object.fromEntries(overall),
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log(`\n=== FEATURE_184 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${dumpPath}`);
      for (const c of REQUESTED_CASES) {
        // eslint-disable-next-line no-console
        console.log(`\nCase ${c.id} (expect ${c.expectedVerdict}):`);
        for (const variant of REQUESTED_VARIANTS) {
          const o = overall.get(`${c.id}|${variant}`);
          if (!o) continue;
          const pct = ((o.passed / o.total) * 100).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(`  ${variant}: ${o.passed}/${o.total} (${pct}%) overall`);
          for (const alias of aliases) {
            const cell = cells.get(`${c.id}|${variant}|${alias}`);
            if (!cell) continue;
            const apct = ((cell.passed / cell.total) * 100).toFixed(0);
            // eslint-disable-next-line no-console
            console.log(`    ${alias}: ${cell.passed}/${cell.total} (${apct}%)`);
          }
        }
      }

      // Tool emit-rate per variant (SHIP gate (b): ≥90% on Treatment)
      const emitRateByVariant = new Map<Variant, { emitted: number; total: number }>();
      for (const r of rows) {
        const cur = emitRateByVariant.get(r.variant) ?? { emitted: 0, total: 0 };
        cur.total++;
        if (r.emittedReport && r.schemaValid) cur.emitted++;
        emitRateByVariant.set(r.variant, cur);
      }
      // eslint-disable-next-line no-console
      console.log('\nTool emit-rate (SHIP gate (b) ≥90% on treatment):');
      for (const [variant, stats] of emitRateByVariant) {
        const pct = ((stats.emitted / stats.total) * 100).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`  ${variant}: ${stats.emitted}/${stats.total} (${pct}%)`);
      }
    },
  );
});
