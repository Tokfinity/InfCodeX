/**
 * FEATURE_246 — run_workflow pattern-COMBINATION teaching eval (Layer 2/3, real fixture).
 *
 * Question (not answerable by Layer 1): does the run_workflow tool DESCRIPTION's
 * composition teaching make a coding-plan model, when it authors a REVIEW
 * workflow, COMBINE fan-out-and-synthesize with adversarial-verification
 * (declare both in manifest.patterns) instead of a single pattern?
 *
 * Why a real-session fixture (not a synthetic single-turn prompt): authoring a
 * workflow requires the model to have scouted real files first (scout-then-author,
 * which the description itself mandates). Pilots confirmed that synthetic thin
 * scope makes every model re-scout instead of author, so a from-scratch probe
 * can't observe the authored manifest. Instead we replay a REAL /workflow review
 * session (20260630_204735, zai-coding/glm-5.2) truncated to the messages just
 * BEFORE its run_workflow authoring turn — full real scouted context in hand. The
 * real turn declared patterns:['fan-out-and-synthesize'] only (the bug this fixes).
 *
 * Design (per benchmark/EVAL_GUIDELINES.md):
 * - v_baseline vs v_proposed differ ONLY in the run_workflow description (the
 *   composition block is reverted to the pre-change one-liner); byte-aligned
 *   everywhere else, schema identical (anti-pattern 8 §2).
 * - Production tool bytes via provider.stream's tools channel (anti-pattern 8).
 * - STRUCTURAL assertion on the authored manifest.patterns — no regex-on-text
 *   (anti-pattern 7). "combined" := patterns includes BOTH ids.
 * - 2-turn replay: from the real pre-authoring context, turn 1 does the model's
 *   own todo bookkeeping, then synthetic tool_results are injected and turn 2 is
 *   the authoring (matches the real trajectory, whose authoring turn was
 *   todo_update + run_workflow together).
 * - Pilot (ds/v4flash + zhipu/glm52, 1 run) already showed baseline 0/2 combined
 *   -> proposed 2/2 combined. Raw dump -> os.tmpdir()/kodax-eval-dumps/...
 *
 * Pre-registered gate (panel >= 3 aliases) — LIFT metric, no floor-override:
 * - mean combinedRate(proposed) - mean combinedRate(baseline) >= 0.25
 * - mean combinedRate(proposed) >= 0.40 (combination is reachably taught)
 *
 * Run (panel):    npm run test:eval -- tests/feature-246-pattern-composition.eval.ts
 * Run (pilot):    KODAX_EVAL_ALIASES=ds/v4flash,zhipu/glm52 KODAX_EVAL_RUNS=1 npm run test:eval -- tests/feature-246-pattern-composition.eval.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const path = fileURLToPath(new URL('../benchmark/datasets/feature-246-review-fixture/pre-authoring.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

// The pre-change one-liner the proposed composition block replaced.
const BASELINE_SENTENCE =
  'The most common shape is pipeline(items, find, verify) that verifies each finding the moment it is found and ends with .filter(Boolean).';

/** Revert the run_workflow description's composition block to the baseline line. */
function makeBaselineDescription(proposed: string): string {
  const start = proposed.indexOf('Reach for more than one of these');
  const end = proposed.indexOf('Prefer dispatch_child_task');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('run_workflow composition-block markers not found — update the eval baseline swap.');
  }
  return `${proposed.slice(0, start)}${BASELINE_SENTENCE} ${proposed.slice(end)}`;
}

function toolsForVariant(variant: 'baseline' | 'proposed'): KodaXToolDefinition[] {
  const all = getAllRegisteredTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (variant === 'proposed') return all;
  return all.map((t) => (t.name === 'run_workflow' ? { ...t, description: makeBaselineDescription(t.description) } : t));
}

const CANONICAL_PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = { 'ark/v4pro': 'ds/v4pro', 'ark/v4flash': 'ds/v4flash' };

function resolvePanel(): ModelAlias[] {
  const override = process.env.KODAX_EVAL_ALIASES;
  if (override && override.trim().length > 0) return availableAliases(...(override.split(',').map((s) => s.trim()) as ModelAlias[]));
  return availableAliases(...CANONICAL_PANEL);
}

const RUNS = Number(process.env.KODAX_EVAL_RUNS ?? '3');
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'feature-246-pattern-composition');
const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

function authoredPatterns(input: unknown): string[] {
  const manifest = (input as { manifest?: unknown })?.manifest;
  const patterns = (manifest as { patterns?: unknown })?.patterns;
  return Array.isArray(patterns) ? patterns.filter((p): p is string => typeof p === 'string') : [];
}
function combines(patterns: readonly string[]): boolean {
  return patterns.includes('fan-out-and-synthesize') && patterns.includes('adversarial-verification');
}

/** Replay the real pre-authoring context; take a 2nd turn if turn 1 was bookkeeping. */
async function replayAuthoring(
  alias: ModelAlias,
  fixture: Fixture,
  tools: KodaXToolDefinition[],
): Promise<{ emitted: boolean; patterns: string[]; turns: number }> {
  const runOne = async (target: ModelAlias) => {
    const provider = getProvider(resolveAlias(target).provider);
    const sys = `${fixture.system}\n\nYou are the Worker. Continue the task.`;
    let msgs: KodaXMessage[] = [...fixture.messages];
    let result = await provider.stream(msgs, tools, sys);
    let wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
    let turns = 1;
    if (!wf && result.toolBlocks.length > 0) {
      msgs = [
        ...msgs,
        { role: 'assistant', content: [
          ...result.textBlocks.map((b) => ({ type: 'text' as const, text: b.text })),
          ...result.toolBlocks.map((b) => ({ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input })),
        ] },
        { role: 'user', content: result.toolBlocks.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: 'ok' })) },
      ] as KodaXMessage[];
      result = await provider.stream(msgs, tools, sys);
      wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
      turns = 2;
    }
    const patterns = wf ? authoredPatterns(wf.input) : [];
    return { emitted: !!wf, patterns, turns };
  };
  try {
    return await runOne(alias);
  } catch (primary) {
    const fb = ALIAS_FALLBACK[alias];
    if (!fb) throw primary;
    return await runOne(fb);
  }
}

describe('FEATURE_246 run_workflow pattern-combination teaching (real review fixture)', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'the proposed run_workflow description makes the authored review workflow combine fan-out + adversarial-verification',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const fixture = loadFixture();
      // sanity: the proposed description must still contain the composition block.
      expect(toolsForVariant('proposed').find((t) => t.name === 'run_workflow')!.description).toContain('Reach for more than one of these');

      const combinedRate = new Map<Variant, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const tools = toolsForVariant(variant);
        const perAlias = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; combinedRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<{ runIndex: number; emitted: boolean; patterns: string[]; combined: boolean; turns: number }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              const r = await replayAuthoring(alias, fixture, tools);
              runs.push({ runIndex: i, ...r, combined: combines(r.patterns) });
            } catch (error) {
              runs.push({ runIndex: i, emitted: false, patterns: [], combined: false, turns: 0 });
              // eslint-disable-next-line no-console
              console.log(`[${variant}] ${alias} run ${i} ERROR: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`);
            }
          }
          const rate = runs.filter((r) => r.combined).length / Math.max(1, runs.length);
          perAlias.set(alias, rate);
          aliasDumps.push({ alias, combinedRate: rate, runs });
        }
        combinedRate.set(variant, perAlias);
        writeFileSync(join(DUMP_DIR, `${variant}.json`), JSON.stringify({ variant, realPatternsDeclared: fixture.realPatternsDeclared, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = panel.map((a) => `${a}: baseline ${pct(combinedRate.get('baseline')!.get(a) ?? 0)}% -> proposed ${pct(combinedRate.get('proposed')!.get(a) ?? 0)}%`);
      // eslint-disable-next-line no-console
      console.log(`\n[FEATURE_246 pattern-combination] panel=${panel.join(',')} runs=${RUNS}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const mean = (v: Variant): number => {
        const m = combinedRate.get(v)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };

      if (panel.length >= 3) {
        const lift = mean('proposed') - mean('baseline');
        expect(lift, 'combination LIFT (proposed - baseline) >= 0.25').toBeGreaterThanOrEqual(0.25);
        expect(mean('proposed'), 'combination reachably taught (proposed mean >= 0.40)').toBeGreaterThanOrEqual(0.4);
      }
    },
    1_800_000,
  );
});
