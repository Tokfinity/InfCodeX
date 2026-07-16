/**
 * Eval: FEATURE_192 v0.7.44 — Goal lifecycle prompt-signal probe
 *  (SCAFFOLDED for v0.7.44; full panel rerun lands in v0.7.45 once
 *  goalContext + lifecycle composer wire up in `runner-driven.ts`).
 *
 * **Why scaffolded only**: v0.7.44 Phase D ships
 *   - `/goal` slash command + lineage persistence
 *   - goal tools registered in registry with disabled-fallback context
 * but does NOT wire goalContext through `runner-driven.ts` or hang
 * `withGoalBeforeNextTurn` / `withGoalStopHook` off the dispatch
 * lifecycle. Without that wiring, an end-to-end runtime eval would
 * measure prompt-shape only — which is exactly what this driver does.
 * Running the full 100-call panel now would burn ~$3-5 for data that
 * still has to be revisited after Phase F lands. The driver + dataset
 * exist so v0.7.45 Phase F can re-run with one env-flip and no new
 * scaffolding work.
 *
 * **Design** (see also benchmark/datasets/feature-192-goal-lifecycle/cases.ts):
 *   - 4 cases × N runs × M alias.
 *   - System prompt = GOAL_EVAL_SYSTEM_PROMPT (self-contained — no
 *     dependency on the full KodaX system prompt builder, so the
 *     measurement isolates goal-tool understanding from other prompt
 *     layers).
 *   - Tools = GOAL_TOOL_DEFINITIONS (3 goal tools).
 *   - Primary metric: did at least one expectedPositiveSignal regex
 *     hit the model's response text OR a relevant tool call? (Tool
 *     calls satisfy the C3 signal "update_goal" trivially; regex on
 *     text catches the C1/C2/C4 reasoning shape.)
 *
 * **Modes** (env `KODAX_F192_MODE`):
 *   - `pilot`  → ark/v4flash × C1 × 1 run = 1 call (~$0.01). Confirms
 *                the prompt produces a usable response shape.
 *   - `scale`  → 5 alias × 4 case × 5 run = 100 calls (~$3-5).
 *   - default  → SKIP (no env, no spend).
 *
 * **Run**:
 *   KODAX_F192_MODE=pilot npm run test:eval -- feature-192-goal-lifecycle
 *   KODAX_F192_MODE=scale npm run test:eval -- feature-192-goal-lifecycle
 *
 * Skips when API keys absent. Not in regular CI — manual invocation
 * only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  GOAL_EVAL_CASES,
  GOAL_EVAL_SYSTEM_PROMPT,
  GOAL_TOOL_DEFINITIONS,
  type GoalEvalCase,
} from '../benchmark/datasets/feature-192-goal-lifecycle/cases.js';

type Mode = 'pilot' | 'scale' | 'skip';
const MODE: Mode = (process.env.KODAX_F192_MODE ?? 'skip') as Mode;

const DEFAULT_SCALE_PANEL: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
];

// Pilot defaults to kimi when ARK is unavailable (CodingPlan subscription
// may lapse) — falls back to ark/v4flash when KODAX_F192_PILOT_ALIAS is set.
const PILOT_ALIAS: ModelAlias = (process.env.KODAX_F192_PILOT_ALIAS as ModelAlias) ?? 'kimi';
const REQUESTED_PANEL: readonly ModelAlias[] =
  MODE === 'pilot' ? [PILOT_ALIAS] : DEFAULT_SCALE_PANEL;

const REQUESTED_CASES: readonly GoalEvalCase[] =
  MODE === 'pilot'
    ? GOAL_EVAL_CASES.filter((c) => c.id === 'C1_simple_continuation')
    : GOAL_EVAL_CASES;

const RUNS = MODE === 'pilot' ? 1 : 5;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-192-goal-lifecycle');

interface ProbeRow {
  caseId: string;
  alias: ModelAlias;
  runIndex: number;
  durationMs: number;
  text: string;
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  matchedSignals: readonly string[];
  primaryPassed: boolean;
}

/**
 * Primary scoring: any expected positive signal hits the response
 * text OR appears as a tool-call name. Loose regex match (case-
 * insensitive). The point is signal detection — strict gating waits
 * for the v0.7.45 LLM-judge audit.
 */
function scoreResponse(
  c: GoalEvalCase,
  text: string,
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { matchedSignals: readonly string[]; primaryPassed: boolean } {
  const toolText = toolCalls
    .map((t) => `${t.name} ${JSON.stringify(t.input)}`)
    .join(' ');
  const haystack = `${text}\n${toolText}`;
  const matched: string[] = [];
  for (const sig of c.expectedPositiveSignals) {
    try {
      const re = new RegExp(sig, 'i');
      if (re.test(haystack)) matched.push(sig);
    } catch {
      if (haystack.toLowerCase().includes(sig.toLowerCase())) matched.push(sig);
    }
  }
  return { matchedSignals: matched, primaryPassed: matched.length > 0 };
}

describe(`Eval: FEATURE_192 goal lifecycle prompt-signal (${MODE})`, () => {
  if (MODE === 'skip') {
    it('skips: KODAX_F192_MODE not set (set pilot|scale to run)', () => {
      // no-op
    });
    return;
  }

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
        // Re-mkdir on every flush — Windows tmpdir cleanup can race with
        // long-running evals and remove the parent dir between writes
        // (see feedback_audit_dump_dir_vanishes).
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(
          incrementalDumpPath,
          JSON.stringify(
            {
              mode: MODE,
              timestamp: new Date().toISOString(),
              aliases,
              cases: REQUESTED_CASES.map((c) => c.id),
              runs: RUNS,
              completedRows: rows.length,
              expectedRows: REQUESTED_CASES.length * aliases.length * RUNS,
              rows,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };
      // eslint-disable-next-line no-console
      console.log(`[F192] incremental dump: ${incrementalDumpPath}`);

      for (const c of REQUESTED_CASES) {
        for (const alias of aliases) {
          for (let runIndex = 0; runIndex < RUNS; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(`[F192] case=${c.id} alias=${alias} run=${runIndex}`);
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: GOAL_EVAL_SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: GOAL_TOOL_DEFINITIONS,
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[F192] error case=${c.id} alias=${alias}: ${(err as Error).message}`,
              );
              continue;
            }
            const score = scoreResponse(c, result.text, result.toolCalls);
            rows.push({
              caseId: c.id,
              alias,
              runIndex,
              durationMs: result.durationMs,
              text: result.text,
              toolCalls: result.toolCalls,
              matchedSignals: score.matchedSignals,
              primaryPassed: score.primaryPassed,
            });
            flushIncremental();
          }
        }
      }

      // Per-(case, alias) cell summary
      const cells = new Map<string, { passed: number; total: number }>();
      for (const r of rows) {
        const key = `${r.caseId}|${r.alias}`;
        const cur = cells.get(key) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        cells.set(key, cur);
      }
      // Per-case overall
      const overall = new Map<string, { passed: number; total: number }>();
      for (const r of rows) {
        const cur = overall.get(r.caseId) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.primaryPassed) cur.passed++;
        overall.set(r.caseId, cur);
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
            cases: REQUESTED_CASES.map((c) => c.id),
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
      console.log(`\n=== FEATURE_192 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${dumpPath}`);
      for (const c of REQUESTED_CASES) {
        const o = overall.get(c.id);
        if (!o) continue;
        const pct = ((o.passed / o.total) * 100).toFixed(0);
        // eslint-disable-next-line no-console
        console.log(`\nCase ${c.id}: ${o.passed}/${o.total} (${pct}%) overall`);
        for (const alias of aliases) {
          const cell = cells.get(`${c.id}|${alias}`);
          if (!cell) continue;
          const apct = ((cell.passed / cell.total) * 100).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(`    ${alias}: ${cell.passed}/${cell.total} (${apct}%)`);
        }
      }
    },
  );
});
