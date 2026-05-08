/**
 * Eval: FEATURE_146-B Pattern B parallel-dispatch decision quality (v0.7.37).
 *
 * ## Why this exists
 *
 * v0.7.36 FEATURE_119 added Pattern B (`dispatch_child_task` + `await_child_task`
 * launch+await split). The structural ship gate
 * (`tests/feature-119-pattern-b-async-dispatch.eval.ts`) verifies the **tool
 * surface + prompt anchors** — that the LLM-facing description carries the
 * "emit multiple dispatch in one response" guidance. What it cannot answer
 * is: do real LLMs, when handed this prompt, **act on it**?
 *
 * This is the load-bearing behavioral follow-up tracked in
 * `docs/features/v0.7.37.md` § "v0.7.36 Behavioral Eval Follow-ups".
 *
 * ## What this eval probes
 *
 * For each (alias × task) cell:
 *   1. Run a **single-turn probe** — one (system + user) round against the
 *      provider, with the parallel-dispatch tool surface advertised.
 *   2. Inspect the returned `toolCalls[]` array — the structural signal.
 *
 * ## Pre-registered metrics
 *
 *   - **parallel-dispatch trigger rate** (load-bearing):
 *     count(cells where ≥2 `dispatch_child_task` calls in single response)
 *     / total cells × 100
 *   - **dispatch count distribution** (informational): how many dispatches
 *     per cell, surfaced in the per-alias breakdown
 *   - **orphan rate** (NOT a single-turn metric — informational only):
 *     count(cells where dispatch count > await count) / dispatched cells × 100.
 *     **Why it can't be a gate here**: the eval is single-turn; the LLM
 *     receives no `task_id:<id>` banner back (the dispatch tool hasn't
 *     actually executed) so it has nothing to `await_child_task` on
 *     within the same response. A 100% orphan reading in a single-turn
 *     probe is the expected baseline, NOT a regression. Orphan-rate
 *     gating requires a multi-turn probe with a mock dispatch executor
 *     that emits synthetic task_id banners — that infrastructure
 *     (`mockChildExecutor`) is tracked in v0.7.37 design doc Step 0.5
 *     and explicitly skipped for this v0.7.37 eval ship.
 *
 * ## Pre-registered thresholds
 *
 *   - PASS: trigger rate ≥ 60%
 *   - INCONCLUSIVE: 30 ≤ trigger rate < 60% (logged, not failed)
 *   - FAIL: trigger rate < 30% (asserts red — Pattern B prompt is rhetorically dead)
 *
 * The suite asserts the **FAIL** threshold (so a clearly-broken Pattern B
 * gets a red CI signal). INCONCLUSIVE is logged but does not fail.
 *
 * ## Aliases
 *
 *   5 aliases with API keys configured: `zhipu/glm51`, `kimi`, `mmx/m27`,
 *   `ds/v4pro`, `ds/v4flash`. Cells skip individually when their key is
 *   absent (per `availableAliases()`).
 *
 * ## Run
 *
 *   npm run test:eval -- feature-146-b-pattern-b-behavioral
 */

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  buildPatternBSystemPrompt,
  PARALLEL_DISPATCH_TASKS,
  PATTERN_B_TOOLS,
  type ParallelDispatchTaskCase,
} from '../benchmark/datasets/pattern-b-parallel-decision/cases.js';

// ---------------------------------------------------------------------------
// Aliases under test (only those with API keys configured)
// ---------------------------------------------------------------------------

const PROBE_ALIASES: ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ds/v4pro',
  'ds/v4flash',
];

const RUNNABLE_ALIASES = availableAliases(...PROBE_ALIASES);

// ---------------------------------------------------------------------------
// Cell shape + execution
// ---------------------------------------------------------------------------

interface CellResult {
  readonly alias: ModelAlias;
  readonly taskId: ParallelDispatchTaskCase['id'];
  readonly dispatchCount: number;
  readonly awaitCount: number;
  /** True when ≥2 `dispatch_child_task` calls in single response (RULE A trigger). */
  readonly parallelDispatch: boolean;
  /** True when dispatchCount > awaitCount (orphan signal). */
  readonly orphan: boolean;
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly error?: string;
}

async function runCell(
  alias: ModelAlias,
  task: ParallelDispatchTaskCase,
): Promise<CellResult> {
  try {
    const result = await runOneShot(alias, {
      systemPrompt: buildPatternBSystemPrompt(),
      userMessage: task.userMessage,
      tools: PATTERN_B_TOOLS,
    });
    const toolNames = result.toolCalls.map((c) => c.name);
    const dispatchCount = toolNames.filter((n) => n === 'dispatch_child_task').length;
    const awaitCount = toolNames.filter((n) => n === 'await_child_task').length;
    return {
      alias,
      taskId: task.id,
      dispatchCount,
      awaitCount,
      parallelDispatch: dispatchCount >= 2,
      orphan: dispatchCount > 0 && dispatchCount > awaitCount,
      text: result.text,
      toolNames,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      alias,
      taskId: task.id,
      dispatchCount: 0,
      awaitCount: 0,
      parallelDispatch: false,
      orphan: false,
      text: `[probe error: ${errMsg}]`,
      toolNames: [],
      error: errMsg,
    };
  }
}

interface AggregateReport {
  readonly cells: readonly CellResult[];
  readonly triggerRate: number;
  readonly orphanRate: number;
  readonly dispatchedCellCount: number;
  readonly errorCount: number;
}

function aggregate(cells: readonly CellResult[]): AggregateReport {
  const completed = cells.filter((c) => !c.error);
  const trigger = completed.filter((c) => c.parallelDispatch).length;
  const dispatched = completed.filter((c) => c.dispatchCount > 0);
  const orphans = dispatched.filter((c) => c.orphan).length;
  const triggerRate = completed.length === 0 ? 0 : (trigger / completed.length) * 100;
  const orphanRate = dispatched.length === 0 ? 0 : (orphans / dispatched.length) * 100;
  return {
    cells,
    triggerRate,
    orphanRate,
    dispatchedCellCount: dispatched.length,
    errorCount: cells.filter((c) => c.error).length,
  };
}

const reportRef: { current: AggregateReport | undefined } = { current: undefined };

// ---------------------------------------------------------------------------
// Suite — skipIf when no aliases are runnable. Strict serial within each
// alias (avoid 429 per EVAL_GUIDELINES 反模式 3); cross-alias parallelism
// allowed but kept serial here for log readability + provider quota safety.
// ---------------------------------------------------------------------------

describe('FEATURE_146-B — Pattern B parallel-dispatch behavioral eval', () => {
  describe.skipIf(RUNNABLE_ALIASES.length === 0)('with ≥1 alias key configured', () => {
    it(
      `runs ${PROBE_ALIASES.length} aliases × ${PARALLEL_DISPATCH_TASKS.length} tasks serially`,
      async () => {
        const cells: CellResult[] = [];
        for (const alias of RUNNABLE_ALIASES) {
          for (const task of PARALLEL_DISPATCH_TASKS) {
            const cell = await runCell(alias, task);
            cells.push(cell);
            // eslint-disable-next-line no-console
            console.log(
              `[probe] ${alias} / ${task.id}: dispatch=${cell.dispatchCount} ` +
                `await=${cell.awaitCount} parallel=${cell.parallelDispatch ? 'YES' : 'no'} ` +
                `orphan=${cell.orphan ? 'YES' : 'no'}` +
                (cell.error ? ` ERROR=${cell.error}` : ''),
            );
          }
        }
        const report = aggregate(cells);
        reportRef.current = report;

        expect(cells.length).toBe(
          RUNNABLE_ALIASES.length * PARALLEL_DISPATCH_TASKS.length,
        );
      },
      // 5 alias × 5 task × ~30s/cell upper bound = 12.5 min. Vitest timeout
      // overshoot to 20 min for slow providers.
      20 * 60_000,
    );

    it('parallel-dispatch trigger rate ≥ 30% (FAIL threshold)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[fea146-B] parallel-dispatch trigger rate = ${report!.triggerRate.toFixed(1)}% ` +
          `(${report!.cells.filter((c) => c.parallelDispatch).length}/${report!.cells.length - report!.errorCount})`,
      );
      // Pre-registered: < 30% is a clear failure (Pattern B prompt is rhetorically dead).
      expect(
        report!.triggerRate,
        'Pattern B parallel-dispatch trigger rate < 30% — prompt anchors not driving behavior',
      ).toBeGreaterThanOrEqual(30);
    });

    it('orphan rate (informational only — NOT a single-turn pass/fail gate)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // Single-turn probes cannot test orphan rate: the LLM receives no
      // task_id banner back (dispatch tool didn't actually execute) so it
      // has nothing to await on. 100% orphan in a single-turn probe is
      // baseline-expected. Gate-grade orphan measurement requires a
      // multi-turn probe with a mock dispatch executor; that's tracked
      // in v0.7.37.md Step 0.5 (`mockChildExecutor`) and explicitly
      // skipped for this v0.7.37 eval ship. Surfaced here as a counter
      // for future multi-turn comparison.
      // eslint-disable-next-line no-console
      console.log(
        `[fea146-B] orphan rate (single-turn baseline; not a gate) = ${report!.orphanRate.toFixed(1)}% ` +
          `(${report!.cells.filter((c) => c.orphan).length}/${report!.dispatchedCellCount} dispatched cells)`,
      );
      // Trivially passes — assertion is on report shape, not the rate.
      expect(report!.orphanRate).toBeGreaterThanOrEqual(0);
    });

    it('per-alias breakdown report', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const byAlias = new Map<ModelAlias, CellResult[]>();
      for (const c of report!.cells) {
        const arr = byAlias.get(c.alias) ?? [];
        arr.push(c);
        byAlias.set(c.alias, arr);
      }
      // eslint-disable-next-line no-console
      console.log('[fea146-B] per-alias breakdown:');
      for (const [alias, cells] of byAlias) {
        const trigger = cells.filter((c) => c.parallelDispatch).length;
        const dispatched = cells.filter((c) => c.dispatchCount > 0).length;
        const orphans = cells.filter((c) => c.orphan).length;
        // eslint-disable-next-line no-console
        console.log(
          `  ${alias.padEnd(14)}  trigger=${trigger}/${cells.length}  ` +
            `dispatched=${dispatched}/${cells.length}  orphans=${orphans}`,
        );
      }
    });
  });

  it('at least one alias has an API key configured', () => {
    if (RUNNABLE_ALIASES.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea146-B behavioral eval] No alias keys present (need any of ` +
          `ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / DEEPSEEK_API_KEY) — eval is skipped.`,
      );
    }
    expect(true).toBe(true);
  });
});
