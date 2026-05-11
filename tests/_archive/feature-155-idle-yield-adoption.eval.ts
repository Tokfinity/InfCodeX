/**
 * **ARCHIVED — DO NOT RUN.** Retired in FEATURE_155 v0.7.39 Phase 0b
 * follow-up cleanup.
 *
 * Slice B1.D ship gate is met (commits `1a08de10` + `6a63d986`,
 * v0.7.38): `KODAX_IDLE_YIELD` flipped to default-ON, then retired in
 * Slice C3 (`isIdleYieldEnabled()` hard-codes `true`). The dataset
 * tested LLM behavior in the transitional state when `await_child_task`
 * was still present in the tool list but the prompt taught idle-yield
 * as the preferred path — Slice C1 deleted the tool entirely, so the
 * "transitional fallback" scenario this eval measures is no longer
 * reproducible against current production.
 *
 * `vitest.eval.config.ts` excludes `tests/_archive/**` so
 * `npm run test:eval` no longer picks this file up; it is preserved
 * here as a historical record of how the idle-yield adoption ship
 * gate was cleared.
 *
 * --- Original header (kept verbatim) ---
 *
 * Eval: FEATURE_155 idle-yield adoption (v0.7.39).
 *
 * ## Layer 2 single-turn probe per benchmark/EVAL_GUIDELINES.md
 *
 * Each cell sends a fully pre-canned message history to one provider
 * and inspects the FIRST `tool_use` block (or absence thereof) in the
 * response. The assertion is mechanical:
 *
 *   idleYielded ⇔ result.toolBlocks.length === 0
 *                 && result.textBlocks.length > 0
 *                 && combinedText.trim().length > 0
 *
 * That is: a brief text status with NO tool calls — the exact runtime
 * exit condition the runner-driven outer loop's `detectIdleYield`
 * predicate keys on (see
 * `packages/coding/src/task-engine/_internal/managed-task/idle-yield.ts`).
 *
 * ## Pre-registered SHIP / PARTIAL / REJECT decision matrix
 *
 *   - SHIP — flip `KODAX_IDLE_YIELD` default to `true`:
 *       ≥ 3 of 4 aliases idle-yield on ≥ 12 of 15 cells (≥80%).
 *
 *   - PARTIAL — keep flag opt-in, refine prompt, re-run:
 *       2 of 4 aliases ≥ 80%, OR all 4 ≥ 60% with no alias < 50%.
 *
 *   - REJECT — revert prompt + banner edits (commits 3828265f),
 *     keep flag opt-in but document idle-yield as a known-unstable
 *     LLM behavior:
 *       ≥ 3 of 4 aliases < 50%, OR any single alias < 30%.
 *
 * Vitest assertion enforces only the REJECT floor (no alias <30%).
 * SHIP / PARTIAL is decided by reading the per-alias breakdown log
 * line, NOT by automated assertions — by design, so the eval doesn't
 * pre-empt the human ship decision.
 *
 * ## Sample size
 *
 *   N=5 reps per (alias × case). 5 alias × 3 case × 5 reps = 75
 *   probes ≈ $1.50. Strict serial within alias to avoid 429.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-155-idle-yield-adoption
 *
 * ## Raw dump
 *
 *   Each probe's full `KodaXStreamResult` (textBlocks + toolBlocks +
 *   stopReason + usage) is written to:
 *     <os.tmpdir()>/feature-155-idle-yield-<timestamp>/<alias>/<case>-<rep>.json
 *   The first test logs the dump root so a follow-up audit can read
 *   any cell without re-running the whole eval.
 */

import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getProvider,
  type KodaXMessage,
  type KodaXStreamResult,
} from '@kodax-ai/llm';

import {
  availableAliases,
  resolveAlias,
  type ModelAlias,
} from '../../benchmark/harness/aliases.js';
import {
  buildIdleYieldSystemPrompt,
  IDLE_YIELD_CASES,
  IDLE_YIELD_TOOLS,
  type IdleYieldCase,
} from '../../benchmark/datasets/_archive/feature-155-idle-yield-adoption/cases.js';

// ---------------------------------------------------------------------------
// Aliases under test (only those with API keys configured)
// ---------------------------------------------------------------------------

const PROBE_ALIASES: ModelAlias[] = [
  'ds/v4flash',
  'ds/v4pro',
  'kimi',
  'mmx/m27',
  'zhipu/glm51',
];

const RUNNABLE_ALIASES = availableAliases(...PROBE_ALIASES);

const REPS_PER_CELL = 5;

// ---------------------------------------------------------------------------
// Raw dump root — anti-pattern 7 mitigation. One root per eval run; per-
// alias / per-case-rep file underneath.
// ---------------------------------------------------------------------------

const DUMP_ROOT = path.join(
  os.tmpdir(),
  `feature-155-idle-yield-${Date.now()}`,
);

async function writeRawDump(
  alias: ModelAlias,
  caseId: IdleYieldCase['id'],
  rep: number,
  payload: unknown,
): Promise<void> {
  const dir = path.join(DUMP_ROOT, alias.replace('/', '__'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${caseId}-${rep}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Probe primitive — one provider.stream call with a fully canned
// message array.
// ---------------------------------------------------------------------------

interface ProbeOutput {
  readonly idleYielded: boolean;
  readonly firstToolName: string | undefined;
  readonly toolNames: readonly string[];
  readonly text: string;
  readonly stopReason: string | undefined;
  readonly error?: string;
}

async function runIdleYieldProbe(
  alias: ModelAlias,
  cannedHistory: readonly KodaXMessage[],
  caseId: IdleYieldCase['id'],
  rep: number,
): Promise<ProbeOutput> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);
  try {
    const result: KodaXStreamResult = await provider.stream(
      [...cannedHistory],
      IDLE_YIELD_TOOLS,
      buildIdleYieldSystemPrompt(),
    );
    const toolNames = result.toolBlocks.map((b) => b.name);
    const firstTool = result.toolBlocks[0];
    const text = result.textBlocks.map((b) => b.text).join('').trim();
    const idleYielded =
      result.toolBlocks.length === 0
      && result.textBlocks.length > 0
      && text.length > 0;

    // Raw dump for audit (anti-pattern 7).
    await writeRawDump(alias, caseId, rep, {
      alias,
      caseId,
      rep,
      idleYielded,
      firstToolName: firstTool?.name,
      toolNames,
      textPreview: text.slice(0, 500),
      textLength: text.length,
      stopReason: result.stopReason,
      usage: result.usage,
      // Full block dump for forensic replay.
      textBlocks: result.textBlocks,
      toolBlocks: result.toolBlocks,
    });

    return {
      idleYielded,
      firstToolName: firstTool?.name,
      toolNames,
      text,
      stopReason: result.stopReason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeRawDump(alias, caseId, rep, {
      alias,
      caseId,
      rep,
      error: message,
    }).catch(() => undefined);
    return {
      idleYielded: false,
      firstToolName: undefined,
      toolNames: [],
      text: '',
      stopReason: undefined,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Cell + aggregate
// ---------------------------------------------------------------------------

interface CellResult {
  readonly alias: ModelAlias;
  readonly caseId: IdleYieldCase['id'];
  readonly repIndex: number;
  readonly probe: ProbeOutput;
}

interface AliasReport {
  readonly alias: ModelAlias;
  readonly completed: number;
  readonly idleYielded: number;
  readonly idleYieldRate: number;
  readonly errors: number;
  readonly nonYieldFirstTools: ReadonlyMap<string, number>;
}

interface AggregateReport {
  readonly cells: readonly CellResult[];
  readonly perAlias: ReadonlyMap<ModelAlias, AliasReport>;
  readonly totalCompleted: number;
  readonly totalIdleYielded: number;
  readonly totalErrors: number;
  readonly overallIdleYieldRate: number;
}

function aggregate(cells: readonly CellResult[]): AggregateReport {
  const perAlias = new Map<ModelAlias, AliasReport>();
  const aliasSet = new Set<ModelAlias>();
  for (const cell of cells) aliasSet.add(cell.alias);
  for (const alias of aliasSet) {
    const aliasCells = cells.filter((c) => c.alias === alias);
    const completed = aliasCells.filter((c) => !c.probe.error);
    const idleYielded = completed.filter((c) => c.probe.idleYielded).length;
    const idleYieldRate = completed.length === 0 ? 0 : (idleYielded / completed.length) * 100;
    const errors = aliasCells.filter((c) => c.probe.error).length;
    const nonYieldFirstTools = new Map<string, number>();
    for (const c of completed) {
      if (c.probe.idleYielded) continue;
      const name = c.probe.firstToolName ?? '(no-tool-no-text)';
      nonYieldFirstTools.set(name, (nonYieldFirstTools.get(name) ?? 0) + 1);
    }
    perAlias.set(alias, {
      alias,
      completed: completed.length,
      idleYielded,
      idleYieldRate,
      errors,
      nonYieldFirstTools,
    });
  }
  const completed = cells.filter((c) => !c.probe.error);
  const idleYielded = completed.filter((c) => c.probe.idleYielded).length;
  return {
    cells,
    perAlias,
    totalCompleted: completed.length,
    totalIdleYielded: idleYielded,
    totalErrors: cells.filter((c) => c.probe.error).length,
    overallIdleYieldRate: completed.length === 0 ? 0 : (idleYielded / completed.length) * 100,
  };
}

const reportRef: { current: AggregateReport | undefined } = { current: undefined };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FEATURE_155 — idle-yield adoption (Layer 2)', () => {
  describe.skipIf(RUNNABLE_ALIASES.length === 0)('with ≥1 alias key configured', () => {
    it(
      `runs ${RUNNABLE_ALIASES.length} alias × ${IDLE_YIELD_CASES.length} case × ${REPS_PER_CELL} reps`,
      async () => {
        // eslint-disable-next-line no-console
        console.log(`[fea155] raw dump root: ${DUMP_ROOT}`);
        const cells: CellResult[] = [];
        for (const alias of RUNNABLE_ALIASES) {
          for (const ic of IDLE_YIELD_CASES) {
            for (let rep = 0; rep < REPS_PER_CELL; rep++) {
              const probe = await runIdleYieldProbe(alias, ic.cannedHistory, ic.id, rep);
              const cell: CellResult = {
                alias,
                caseId: ic.id,
                repIndex: rep,
                probe,
              };
              cells.push(cell);
              // eslint-disable-next-line no-console
              console.log(
                `[probe] ${alias} / ${ic.id} #${rep}: `
                + `idleYielded=${probe.idleYielded ? 'YES' : 'no'} `
                + `firstTool=${probe.firstToolName ?? '(none)'} `
                + `textLen=${probe.text.length}`
                + (probe.error ? ` ERROR=${probe.error}` : ''),
              );
            }
          }
        }
        const report = aggregate(cells);
        reportRef.current = report;

        expect(cells.length).toBe(
          RUNNABLE_ALIASES.length * IDLE_YIELD_CASES.length * REPS_PER_CELL,
        );
      },
      // 4 alias × 3 case × 5 reps × ~30s/probe upper bound ≈ 30 min.
      // Vitest timeout 60 min for slow providers.
      60 * 60_000,
    );

    it('REJECT floor: no alias < 30% idle-yield rate', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const violators: string[] = [];
      for (const [, a] of report!.perAlias) {
        if (a.completed === 0) continue; // all errors → not a real signal
        if (a.idleYieldRate < 30) {
          violators.push(`${a.alias}=${a.idleYieldRate.toFixed(1)}%`);
        }
      }
      expect(
        violators,
        `idle-yield REJECT threshold breached for: ${violators.join(', ')}. ` +
        `Revert FEATURE_155 prompt + banner edits and rethink wording.`,
      ).toEqual([]);
    });

    it('per-alias breakdown report (decision input — read this to decide SHIP/PARTIAL/REJECT)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();

      const aliases = [...report!.perAlias.values()].sort(
        (a, b) => b.idleYieldRate - a.idleYieldRate,
      );
      // eslint-disable-next-line no-console
      console.log(`\n[fea155] === per-alias breakdown ===`);
      let aliasesOver80 = 0;
      let aliasesOver60 = 0;
      let aliasesUnder50 = 0;
      let minRate = 100;
      for (const a of aliases) {
        const histStr = Array.from(a.nonYieldFirstTools.entries())
          .sort((x, y) => y[1] - x[1])
          .map(([n, c]) => `${n}=${c}`)
          .join(' ') || '(none)';
        // eslint-disable-next-line no-console
        console.log(
          `  ${a.alias.padEnd(14)} `
          + `idle-yield=${a.idleYielded}/${a.completed} (${a.idleYieldRate.toFixed(1)}%) `
          + `errors=${a.errors} `
          + `non-yield-first-tools={${histStr}}`,
        );
        if (a.idleYieldRate >= 80) aliasesOver80++;
        if (a.idleYieldRate >= 60) aliasesOver60++;
        if (a.idleYieldRate < 50) aliasesUnder50++;
        if (a.idleYieldRate < minRate) minRate = a.idleYieldRate;
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n[fea155] overall idle-yield rate = ${report!.overallIdleYieldRate.toFixed(1)}% `
        + `(${report!.totalIdleYielded}/${report!.totalCompleted}; errors=${report!.totalErrors})`,
      );
      // Pre-registered decision evaluation — informational, not asserted.
      const ship = aliasesOver80 >= 3;
      const partial = !ship && (aliasesOver80 >= 2 || (aliasesOver60 === aliases.length && aliasesUnder50 === 0));
      const reject = !ship && !partial && (aliasesUnder50 >= 3 || minRate < 30);
      // eslint-disable-next-line no-console
      console.log(
        `[fea155] decision matrix: SHIP=${ship ? 'YES' : 'no'}  `
        + `PARTIAL=${partial ? 'YES' : 'no'}  REJECT=${reject ? 'YES' : 'no'}`,
      );
    });

    it('per-case breakdown report (failure-mode triage)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const byCase = new Map<IdleYieldCase['id'], CellResult[]>();
      for (const c of report!.cells) {
        const arr = byCase.get(c.caseId) ?? [];
        arr.push(c);
        byCase.set(c.caseId, arr);
      }
      // eslint-disable-next-line no-console
      console.log(`\n[fea155] === per-case breakdown ===`);
      for (const [caseId, cs] of byCase) {
        const completed = cs.filter((c) => !c.probe.error);
        const yielded = completed.filter((c) => c.probe.idleYielded).length;
        const histogram = new Map<string, number>();
        for (const c of completed) {
          if (c.probe.idleYielded) continue;
          const name = c.probe.firstToolName ?? '(no-tool-no-text)';
          histogram.set(name, (histogram.get(name) ?? 0) + 1);
        }
        const histStr = Array.from(histogram.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}=${c}`)
          .join(' ') || '(none)';
        const rate = completed.length === 0 ? 0 : (yielded / completed.length) * 100;
        // eslint-disable-next-line no-console
        console.log(
          `  ${caseId.padEnd(34)} idle-yield=${yielded}/${completed.length} (${rate.toFixed(1)}%) `
          + `non-yield-first-tools={${histStr}}`,
        );
      }
    });
  });

  it('at least one alias has an API key configured (skip-or-run notice)', () => {
    if (RUNNABLE_ALIASES.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea155 idle-yield] No alias keys present — eval is skipped. `
        + `Set provider keys (e.g. DEEPSEEK_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY) to run.`,
      );
    }
    expect(true).toBe(true);
  });
});
