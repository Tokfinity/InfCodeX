/**
 * Space empty-findings — run_workflow "read result.structured" teaching eval (Layer 3, real fixture).
 *
 * Question (not answerable by Layer 1): when a coding-plan model authors a REVIEW
 * workflow that declares an `outputSchema` on its child reviewers, does the
 * run_workflow tool DESCRIPTION make it read the validated fields off
 * `result.structured` — instead of inventing top-level reads like `result.summary`
 * / `result.findings`, which are undefined and produce the "总评:(无)/发现:无"
 * empty report a real KodaX-Space AMAW run hit (run-mr4oxcg4)?
 *
 * Why a real-session fixture (not a synthetic single-turn prompt): authoring a
 * workflow requires the model to have scouted real files first (scout-then-author,
 * which the description itself mandates). A from-scratch probe just re-scouts, so
 * it cannot observe the authored source. We replay the SAME real /workflow review
 * fixture used by feature-246-pattern-composition, truncated to the messages just
 * BEFORE the authoring turn — full scouted context in hand.
 *
 * Design (per benchmark/EVAL_GUIDELINES.md):
 * - v_baseline vs v_proposed differ ONLY in the run_workflow description's
 *   result.structured clause (baseline = the pre-change one-liner "comes back on
 *   result.structured;"); byte-aligned everywhere else, schema identical.
 * - Production tool bytes via provider.stream's tools channel (anti-pattern 8).
 * - STRUCTURAL assertion on the authored source string (anti-pattern 7): does it
 *   declare outputSchema, and does it read `.structured`?
 * - 2-turn replay (mirrors the real trajectory: bookkeeping turn, then authoring).
 * - Pilot FIRST (anti-pattern 4): 1 alias × 1 run, baseline+proposed. Confirm the
 *   baseline reproduces the top-level-read bug and the proposed fixes it, THEN scale.
 *
 * Pre-registered gate (panel >= 3 aliases) — LIFT metric:
 * - among runs that declared a schema, mean structuredReadRate(proposed)
 *   - mean structuredReadRate(baseline) >= 0.25
 * - mean structuredReadRate(proposed) >= 0.60 (reading result.structured is reachably taught)
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=ds/v4flash KODAX_EVAL_RUNS=1 npm run test:eval -- tests/space-workflow-structured-read.eval.ts
 * Run (panel):  npm run test:eval -- tests/space-workflow-structured-read.eval.ts
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { getProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases, resolveAlias } from '../benchmark/harness/aliases.js';
import type { ModelAlias } from '../benchmark/harness/aliases.js';
import { getAllRegisteredTools } from '@kodax-ai/coding';

interface Fixture {
  readonly system: string;
  readonly messages: KodaXMessage[];
  readonly realPatternsDeclared: readonly string[];
}

function loadFixture(): Fixture {
  const path = fileURLToPath(
    new URL('../benchmark/datasets/feature-246-review-fixture/pre-authoring.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

// The proposed change appends a WHY clause after the existing result.structured
// mention. Baseline reverts to the pre-change one-liner so the two variants differ
// ONLY in this clause (everything else byte-identical, schema identical).
const PROPOSED_CLAUSE =
  'the parsed validated object comes back on result.structured, so read your declared fields off result.structured (e.g. result.structured.findings) and never off the top-level result, which is undefined for those fields and yields an empty report;';
const BASELINE_CLAUSE = 'the parsed validated object comes back on result.structured;';

/** Revert the run_workflow description's result.structured clause to the baseline line. */
function makeBaselineDescription(proposed: string): string {
  if (!proposed.includes(PROPOSED_CLAUSE)) {
    throw new Error('run_workflow result.structured clause marker not found — update the eval baseline swap.');
  }
  return proposed.replace(PROPOSED_CLAUSE, BASELINE_CLAUSE);
}

function toolsForVariant(variant: 'baseline' | 'proposed'): KodaXToolDefinition[] {
  const all = getAllRegisteredTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  if (variant === 'proposed') return all;
  return all.map((t) =>
    t.name === 'run_workflow' ? { ...t, description: makeBaselineDescription(t.description) } : t,
  );
}

const CANONICAL_PANEL: readonly ModelAlias[] = ['zhipu/glm51', 'kimi', 'mmx/m27', 'ark/v4pro', 'ark/v4flash'];
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4pro': 'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

function resolvePanel(): ModelAlias[] {
  const override = process.env.KODAX_EVAL_ALIASES;
  if (override && override.trim().length > 0) {
    return availableAliases(...(override.split(',').map((s) => s.trim()) as ModelAlias[]));
  }
  return availableAliases(...CANONICAL_PANEL);
}

const RUNS = Number(process.env.KODAX_EVAL_RUNS ?? '3');
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'space-workflow-structured-read');
const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

/** The authored orchestration source string, if run_workflow was emitted. */
function authoredSource(input: unknown): string | undefined {
  const source = (input as { source?: unknown })?.source;
  return typeof source === 'string' ? source : undefined;
}

interface AuthorSignals {
  readonly emitted: boolean;
  readonly declaresSchema: boolean;
  readonly readsStructured: boolean;
  /** declared a schema but never reads .structured ⇒ reading the top-level result (the bug). */
  readonly buggyTopLevelRead: boolean;
  readonly source: string;
}

function assessSource(source: string | undefined): AuthorSignals {
  if (source === undefined) {
    return { emitted: false, declaresSchema: false, readsStructured: false, buggyTopLevelRead: false, source: '' };
  }
  const declaresSchema = /outputSchema/.test(source);
  const readsStructured = /\.structured\b/.test(source);
  return {
    emitted: true,
    declaresSchema,
    readsStructured,
    buggyTopLevelRead: declaresSchema && !readsStructured,
    source,
  };
}

/** Replay the real pre-authoring context; take a 2nd turn if turn 1 was bookkeeping. */
async function replayAuthoring(
  alias: ModelAlias,
  fixture: Fixture,
  tools: KodaXToolDefinition[],
): Promise<AuthorSignals & { turns: number }> {
  const runOne = async (target: ModelAlias): Promise<AuthorSignals & { turns: number }> => {
    const provider = getProvider(resolveAlias(target).provider);
    const sys = `${fixture.system}\n\nYou are the Worker. Continue the task.`;
    let msgs: KodaXMessage[] = [...fixture.messages];
    let result = await provider.stream(msgs, tools, sys);
    let wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
    let turns = 1;
    if (!wf && result.toolBlocks.length > 0) {
      msgs = [
        ...msgs,
        {
          role: 'assistant',
          content: [
            ...result.textBlocks.map((b) => ({ type: 'text' as const, text: b.text })),
            ...result.toolBlocks.map((b) => ({ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input })),
          ],
        },
        {
          role: 'user',
          content: result.toolBlocks.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: 'ok' })),
        },
      ] as KodaXMessage[];
      result = await provider.stream(msgs, tools, sys);
      wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
      turns = 2;
    }
    return { ...assessSource(wf ? authoredSource(wf.input) : undefined), turns };
  };
  try {
    return await runOne(alias);
  } catch (primary) {
    const fb = ALIAS_FALLBACK[alias];
    if (!fb) throw primary;
    return await runOne(fb);
  }
}

describe('Space empty-findings — run_workflow reads result.structured (real review fixture)', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'the proposed run_workflow description makes the authored review workflow read result.structured, not the top-level result',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const fixture = loadFixture();
      // sanity: proposed contains the WHY clause; baseline swap removes it cleanly.
      const proposedDesc = toolsForVariant('proposed').find((t) => t.name === 'run_workflow')!.description;
      expect(proposedDesc).toContain(PROPOSED_CLAUSE);
      expect(makeBaselineDescription(proposedDesc)).toContain(BASELINE_CLAUSE);
      expect(makeBaselineDescription(proposedDesc)).not.toContain('never off the top-level result');

      // among runs that declared a schema, the rate that read .structured.
      const structuredReadRate = new Map<Variant, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const tools = toolsForVariant(variant);
        const perAlias = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; structuredReadRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<AuthorSignals & { runIndex: number; turns: number }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              const r = await replayAuthoring(alias, fixture, tools);
              runs.push({ runIndex: i, ...r });
            } catch (error) {
              runs.push({
                runIndex: i,
                emitted: false,
                declaresSchema: false,
                readsStructured: false,
                buggyTopLevelRead: false,
                source: '',
                turns: 0,
              });
              // eslint-disable-next-line no-console
              console.log(
                `[${variant}] ${alias} run ${i} ERROR: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
              );
            }
          }
          const declared = runs.filter((r) => r.declaresSchema);
          const rate = declared.length > 0 ? declared.filter((r) => r.readsStructured).length / declared.length : 0;
          perAlias.set(alias, rate);
          aliasDumps.push({
            alias,
            structuredReadRate: rate,
            // keep the full authored source in the dump for LLM-judging the reads
            runs,
          });
        }
        structuredReadRate.set(variant, perAlias);
        writeFileSync(
          join(DUMP_DIR, `${variant}.json`),
          JSON.stringify({ variant, aliases: aliasDumps }, null, 2),
          'utf8',
        );
      }

      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = panel.map(
        (a) =>
          `${a}: baseline ${pct(structuredReadRate.get('baseline')!.get(a) ?? 0)}% -> proposed ${pct(structuredReadRate.get('proposed')!.get(a) ?? 0)}%`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `\n[space structured-read] panel=${panel.join(',')} runs=${RUNS}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`,
      );

      const mean = (v: Variant): number => {
        const m = structuredReadRate.get(v)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };

      if (panel.length >= 3) {
        const lift = mean('proposed') - mean('baseline');
        expect(lift, 'structured-read LIFT (proposed - baseline) >= 0.25').toBeGreaterThanOrEqual(0.25);
        expect(mean('proposed'), 'reading result.structured reachably taught (proposed mean >= 0.60)').toBeGreaterThanOrEqual(0.6);
      }
    },
    1_800_000,
  );
});
