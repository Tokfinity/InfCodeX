/**
 * Eval: FEATURE_196 (v0.7.43) — Sidecar Verifier content-aware fire gate.
 *
 * **Layer 2 scope** (per benchmark/EVAL_GUIDELINES.md):
 *
 * The F196 gate is **deterministic** — `composeGateDecision` is a pure
 * function. Gate logic itself is exhaustively covered by Layer 1 unit
 * tests at `packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.test.ts`
 * (23 unit tests). Layer 2 answers ONLY the empirical multi-family
 * questions:
 *   - Do real Worker LLM outputs across 5 provider families produce
 *     `KodaXContentBlock[]` shapes the gate handles correctly?
 *   - Do real model families respond to canonical user-message inputs
 *     with the response patterns the case categories assume? (Realism
 *     check.)
 *
 * Gate decision per cell is computed offline ($0). Layer 2 only buys
 * realistic tuples from each model family.
 *
 * **Run modes** (env var `KODAX_F196_PROBE`):
 *   - `pilot` → ark/v4flash × 4 cases × 1 run = 4 calls (~$0.10).
 *               Validates trigger + tuple realism before scaling.
 *   - `panel` → 5 alias × 12 cases × 1 run = 60 cells (~$2-3). Final
 *               Layer 2 fidelity check across 4 provider families.
 *
 * **Run**:
 *   KODAX_F196_PROBE=pilot npm run test:eval -- feature-196-sidecar-content-gate
 *   KODAX_F196_PROBE=panel npm run test:eval -- feature-196-sidecar-content-gate
 *
 * Skips when API keys absent. Not in regular CI — manual invocation only.
 *
 * **Pre-registered SHIP gate**:
 *   (a) C1 skip rate ≥ 95% per alias (Layer 2 conversational-intent
 *       detector works on real model reciprocations)
 *   (b) C2 fire rate ≥ 95% per alias (imperative-verb guard preserves
 *       F184 contract — zhipu floor still fires sidecar)
 *   (c) C3 fire rate = 100% per alias (length cap is deterministic)
 *   (d) C4 fire rate = 100% per alias (prefix guard is deterministic)
 *   (e) 5/5 alias meet (a)+(b) → SHIP / 4/5 → evidence override / ≤3/5 → DEFER
 *
 * Per [[feedback_pre_registered_gate_saturation]] and
 * [[feedback_model_structural_floor_not_prompt_tunable]].
 *
 * Raw dump path: `<tmpdir>/kodax-eval-dumps/feature-196-sidecar-content-gate/`
 * per EVAL_GUIDELINES.md §Raw output preservation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import type { KodaXMessage } from '@kodax-ai/llm';
import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  WORKER_SYSTEM_PROMPT,
  WORKER_TOOLS,
  type ContentGateCase,
} from '../benchmark/datasets/feature-196-sidecar-content-gate/cases.js';
import { composeGateDecision } from '../packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.js';

type Mode = 'pilot' | 'panel';
const MODE: Mode = (process.env.KODAX_F196_PROBE ?? 'pilot') as Mode;

const DEFAULT_PANEL: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
];

const REQUESTED_PANEL: readonly ModelAlias[] =
  MODE === 'pilot' ? (['ark/v4flash'] as const) : DEFAULT_PANEL;

const RUNS = 1; // 1 run per cell is sufficient — gate decision is
// deterministic from the captured tuple; replication wouldn't add
// signal (only checking model-output variation in tuple shape).

const DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-196-sidecar-content-gate',
);

interface CellRow {
  readonly caseId: string;
  readonly category: ContentGateCase['category'];
  readonly userMessage: string;
  readonly expectedDecision: 'skip' | 'fire';
  readonly alias: ModelAlias;
  readonly runIndex: number;
  readonly durationMs: number;
  readonly workerText: string;
  readonly workerToolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  /** Decision the gate produced when fed this case's (user_msg, worker_response). */
  readonly actualDecision: 'skip' | 'fire';
  readonly actualReason: string;
  /** Did the gate match the case's pre-registered expected decision? */
  readonly passed: boolean;
}

describe(`Eval: FEATURE_196 content-aware sidecar gate (${MODE})`, () => {
  const aliases = availableAliases(...REQUESTED_PANEL);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all probes and dumps raw output',
    { timeout: MODE === 'pilot' ? 600_000 : 1_800_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const rows: CellRow[] = [];
      const incrementalDumpPath = join(
        DUMP_ROOT,
        `${MODE}-incremental-${Date.now()}.json`,
      );
      const flushIncremental = () => {
        // Re-create DUMP_ROOT on every flush per
        // [[feedback_audit_dump_dir_vanishes]] — Windows tmpdir cleanup
        // can race with long-running evals and remove the parent dir.
        mkdirSync(DUMP_ROOT, { recursive: true });
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
      console.log(`[F196] incremental dump: ${incrementalDumpPath}`);

      for (const c of CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(
              `[F196] case=${c.id} alias=${alias} run=${runIndex} expected=${c.expectedDecision}`,
            );
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: WORKER_SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: WORKER_TOOLS,
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[F196] error case=${c.id} alias=${alias}: ${(err as Error).message}`,
              );
              continue;
            }

            // Reconstruct a StopHookContext-like from the Worker output.
            // The gate only consults `transcript` (looks at last user
            // message + last assistant content). Build a minimal
            // 2-message transcript.
            const assistantContent =
              result.toolCalls.length > 0
                ? [
                    ...(result.text
                      ? [{ type: 'text' as const, text: result.text }]
                      : []),
                    ...result.toolCalls.map((tc, idx) => ({
                      type: 'tool_use' as const,
                      id: `t-${idx}`,
                      name: tc.name,
                      input: tc.input as Record<string, unknown>,
                    })),
                  ]
                : result.text;
            const transcript: KodaXMessage[] = [
              { role: 'user', content: c.userMessage },
              { role: 'assistant', content: assistantContent },
            ];

            // Pass empty env so the escape hatch doesn't fire. Tests
            // the gate decision against ONLY the case-supplied tuple.
            const decision = composeGateDecision(
              {
                transcript,
                lastAssistantText: result.text,
                signal: 'natural-end',
                reanimateCount: 0,
                reanimateBudget: 2,
              },
              {},
            );

            const actualDecision: 'skip' | 'fire' = decision.fire ? 'fire' : 'skip';
            const passed = actualDecision === c.expectedDecision;

            rows.push({
              caseId: c.id,
              category: c.category,
              userMessage: c.userMessage,
              expectedDecision: c.expectedDecision,
              alias,
              runIndex,
              durationMs: result.durationMs,
              workerText: result.text,
              workerToolCalls: result.toolCalls,
              actualDecision,
              actualReason: decision.reason,
              passed,
            });
            flushIncremental();
          }
        }
      }

      // Aggregate per (alias, category) pass-rate.
      type CellKey = string; // `${category}|${alias}`
      const cells = new Map<
        CellKey,
        { passed: number; total: number; cases: string[] }
      >();
      for (const r of rows) {
        const key: CellKey = `${r.category}|${r.alias}`;
        const cur = cells.get(key) ?? { passed: 0, total: 0, cases: [] };
        cur.total++;
        if (r.passed) cur.passed++;
        cur.cases.push(`${r.caseId}=${r.actualDecision}${r.passed ? '✓' : '✗'}`);
        cells.set(key, cur);
      }

      const cellSummary = Array.from(cells.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => ({
          cell: key,
          rate: `${v.passed}/${v.total}`,
          cases: v.cases.join(', '),
        }));

      // Final dump (includes summary).
      const finalDumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        finalDumpPath,
        JSON.stringify(
          {
            mode: MODE,
            timestamp: new Date().toISOString(),
            aliases,
            runs: RUNS,
            totalRows: rows.length,
            cellSummary,
            rows,
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log(`[F196] final dump: ${finalDumpPath}`);
      // eslint-disable-next-line no-console
      console.log(`[F196] cell summary (${cellSummary.length} cells):`);
      for (const c of cellSummary) {
        // eslint-disable-next-line no-console
        console.log(`  ${c.cell}: ${c.rate}  ${c.cases}`);
      }
    },
  );
});
