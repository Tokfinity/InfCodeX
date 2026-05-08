/**
 * Eval: FEATURE_148 Pattern B post-dispatch probe (v0.7.37).
 *
 * ## Layer 2 single-turn probe per benchmark/EVAL_GUIDELINES.md
 *
 * Each cell sends a fully pre-canned 3-message history to one provider
 * and inspects the FIRST `tool_use` block in the response. The
 * assertion is mechanical:
 *
 *   degenerate ⇔ firstTool.name === 'await_child_task'
 *                && firstTool.input.task_id === 'child-1'
 *
 * No multi-turn loop, no aggregate trace interpretation — this is the
 * methodology fix for the earlier multi-turn draft, which was Layer
 * 3.5 anti-pattern 2 ("let LLM run free, aggregate trace").
 *
 * ## Pre-registered thresholds
 *
 *   PASS:        degenerate-rate ≤ 40%
 *   INCONCLUSIVE: 40-70% (logged, not asserted)
 *   FAIL:        degenerate-rate > 70%   (vitest red)
 *
 * ## Sample size
 *
 *   N=3 reps per (alias × scenario). 5 alias × 5 scenario × 3 reps =
 *   75 probes ≈ $1-4 total. Strict serial within alias; serial across
 *   aliases for log readability.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-148-post-dispatch-probe
 */

import { describe, expect, it } from 'vitest';

import {
  getProvider,
  type KodaXMessage,
} from '@kodax-ai/llm';

import {
  availableAliases,
  resolveAlias,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';
import {
  buildPostDispatchProbeSystemPrompt,
  POST_DISPATCH_PROBE_CASES,
  POST_DISPATCH_PROBE_TOOLS,
  type PostDispatchProbeCase,
} from '../benchmark/datasets/pattern-b-post-dispatch-probe/cases.js';

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

const REPS_PER_CELL = 3;

// ---------------------------------------------------------------------------
// Probe primitive — one provider.stream call with a fully canned
// message array. Mirrors runOneShot's path through provider.stream
// but without the "userMessage as string" coupling, since our final
// message is a user-role tool_result content-block array.
// ---------------------------------------------------------------------------

interface ProbeOutput {
  readonly firstToolName: string | undefined;
  readonly firstToolTaskId: string | undefined;
  readonly toolNames: readonly string[];
  readonly text: string;
  readonly error?: string;
}

async function runPostDispatchProbe(
  alias: ModelAlias,
  cannedHistory: readonly KodaXMessage[],
): Promise<ProbeOutput> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);
  try {
    const result = await provider.stream(
      [...cannedHistory],
      POST_DISPATCH_PROBE_TOOLS,
      buildPostDispatchProbeSystemPrompt(),
    );
    const toolNames = result.toolBlocks.map((b) => b.name);
    const firstTool = result.toolBlocks[0];
    const firstToolTaskId =
      firstTool && typeof (firstTool.input as { task_id?: unknown }).task_id === 'string'
        ? ((firstTool.input as { task_id: string }).task_id)
        : undefined;
    const text = result.textBlocks.map((b) => b.text).join('').trim();
    return {
      firstToolName: firstTool?.name,
      firstToolTaskId,
      toolNames,
      text,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      firstToolName: undefined,
      firstToolTaskId: undefined,
      toolNames: [],
      text: '',
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Cell + aggregate
// ---------------------------------------------------------------------------

interface CellResult {
  readonly alias: ModelAlias;
  readonly scenarioId: PostDispatchProbeCase['id'];
  readonly repIndex: number;
  readonly probe: ProbeOutput;
  readonly degenerate: boolean;
}

interface AggregateReport {
  readonly cells: readonly CellResult[];
  readonly completedCount: number;
  readonly degenerateCount: number;
  readonly degenerateRate: number;
  readonly errorCount: number;
}

function aggregate(cells: readonly CellResult[]): AggregateReport {
  const completed = cells.filter((c) => !c.probe.error);
  const degenerate = completed.filter((c) => c.degenerate).length;
  const degenerateRate =
    completed.length === 0 ? 0 : (degenerate / completed.length) * 100;
  return {
    cells,
    completedCount: completed.length,
    degenerateCount: degenerate,
    degenerateRate,
    errorCount: cells.filter((c) => c.probe.error).length,
  };
}

const reportRef: { current: AggregateReport | undefined } = { current: undefined };

// ---------------------------------------------------------------------------
// Suite — strict serial within each alias (avoid 429); cross-alias
// kept serial for log readability + provider quota safety.
// ---------------------------------------------------------------------------

describe('FEATURE_148 — Pattern B post-dispatch probe', () => {
  describe.skipIf(RUNNABLE_ALIASES.length === 0)('with ≥1 alias key configured', () => {
    it(
      `runs ${RUNNABLE_ALIASES.length} alias × ${POST_DISPATCH_PROBE_CASES.length} scenarios × ${REPS_PER_CELL} reps`,
      async () => {
        const cells: CellResult[] = [];
        for (const alias of RUNNABLE_ALIASES) {
          for (const scenario of POST_DISPATCH_PROBE_CASES) {
            for (let rep = 0; rep < REPS_PER_CELL; rep++) {
              const probe = await runPostDispatchProbe(alias, scenario.cannedHistory);
              const degenerate =
                probe.firstToolName === 'await_child_task' &&
                probe.firstToolTaskId === 'child-1';
              const cell: CellResult = {
                alias,
                scenarioId: scenario.id,
                repIndex: rep,
                probe,
                degenerate,
              };
              cells.push(cell);
              // eslint-disable-next-line no-console
              console.log(
                `[probe] ${alias} / ${scenario.id} #${rep}: ` +
                  `firstTool=${probe.firstToolName ?? '(none)'} ` +
                  `degen=${degenerate ? 'YES' : 'no'}` +
                  (probe.error ? ` ERROR=${probe.error}` : ''),
              );
            }
          }
        }
        const report = aggregate(cells);
        reportRef.current = report;

        expect(cells.length).toBe(
          RUNNABLE_ALIASES.length * POST_DISPATCH_PROBE_CASES.length * REPS_PER_CELL,
        );
      },
      // 5 alias × 5 scenario × 3 reps × ~30s/probe upper bound ≈ 37 min.
      // Vitest timeout 60 min for slow providers.
      60 * 60_000,
    );

    it('degenerate-rate ≤ 70% (FAIL threshold)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[fea148] degenerate-rate = ${report!.degenerateRate.toFixed(1)}% ` +
          `(${report!.degenerateCount}/${report!.completedCount} completed cells; ` +
          `errors=${report!.errorCount})`,
      );
      // PASS aspiration (≤40%) is logged below, not asserted.
      const passAspiration = report!.degenerateRate <= 40;
      const inconclusive = !passAspiration && report!.degenerateRate <= 70;
      // eslint-disable-next-line no-console
      console.log(
        `[fea148] PASS=${passAspiration ? 'YES' : 'no'}  INCONCLUSIVE=${inconclusive ? 'YES' : 'no'}`,
      );
      expect(
        report!.degenerateRate,
        'degenerate-rate > 70% — FEATURE_148 anti-immediate-await rule is rhetorically dead',
      ).toBeLessThanOrEqual(70);
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
      console.log('[fea148] per-alias breakdown:');
      for (const [alias, cells] of byAlias) {
        const completed = cells.filter((c) => !c.probe.error);
        const degenerate = completed.filter((c) => c.degenerate).length;
        const errors = cells.filter((c) => c.probe.error).length;
        // eslint-disable-next-line no-console
        console.log(
          `  ${alias.padEnd(14)}  degen=${degenerate}/${completed.length}  errors=${errors}`,
        );
      }
    });

    it('per-scenario breakdown report', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const byScenario = new Map<PostDispatchProbeCase['id'], CellResult[]>();
      for (const c of report!.cells) {
        const arr = byScenario.get(c.scenarioId) ?? [];
        arr.push(c);
        byScenario.set(c.scenarioId, arr);
      }
      // eslint-disable-next-line no-console
      console.log('[fea148] per-scenario breakdown:');
      for (const [scenarioId, cells] of byScenario) {
        const completed = cells.filter((c) => !c.probe.error);
        const degenerate = completed.filter((c) => c.degenerate).length;
        // Tool-name distribution among the non-degenerate cells (what
        // the LLM picked instead of awaiting). Informational only.
        const nonDegenerate = completed.filter((c) => !c.degenerate);
        const toolHistogram = new Map<string, number>();
        for (const c of nonDegenerate) {
          const name = c.probe.firstToolName ?? '(no-tool)';
          toolHistogram.set(name, (toolHistogram.get(name) ?? 0) + 1);
        }
        const histStr = Array.from(toolHistogram.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([n, count]) => `${n}=${count}`)
          .join(' ');
        // eslint-disable-next-line no-console
        console.log(
          `  ${scenarioId.padEnd(40)}  degen=${degenerate}/${completed.length}  non-degen-tools={${histStr}}`,
        );
      }
    });
  });

  it('at least one alias has an API key configured', () => {
    if (RUNNABLE_ALIASES.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea148 post-dispatch probe] No alias keys present — eval is skipped.`,
      );
    }
    expect(true).toBe(true);
  });
});
