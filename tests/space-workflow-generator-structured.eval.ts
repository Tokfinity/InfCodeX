/**
 * Space empty-findings — GENERATOR path: teach "read result.structured" (Layer 2 A/B).
 *
 * Companion to space-workflow-structured-read.eval.ts, which covered the
 * run_workflow / AMAW path (tool-definitions.ts). That path already mentioned
 * result.structured (buried), so deep models read it correctly even on baseline.
 *
 * THIS eval covers the OTHER changed path: the blind generator
 * (buildWorkflowGenerationUserPrompt, reached by /workflow revise and by
 * embedders that call generateWorkflowFromOptions directly). Before the fix that
 * prompt taught result.structured NOWHERE — so when a model declares an
 * outputSchema on a reviewer panel it has no idea the validated object lands on
 * result.structured, and reads invented top-level fields (result.summary /
 * result.findings) that are undefined → the "总评:(无)/发现:无" empty report a
 * real KodaX-Space AMAW run hit (run-mr4oxcg4).
 *
 * Design (per benchmark/EVAL_GUIDELINES.md):
 * - v_baseline vs v_proposed differ ONLY in the generator user prompt: baseline
 *   strips ALL of the added outputSchema/result.structured teaching (the two
 *   bullets, the Return-shapes `structured?` field, the two API-signature
 *   `outputSchema` fields, and the structured worked example) — reverting to the
 *   pre-fix zero-teaching prompt. A fail-loud assertion guarantees the strip is
 *   complete (no residual `.structured`/`outputSchema`), so the two variants are
 *   a clean A/B.
 * - Single generation call per cell (no tools, no replay) — cheaper than path ①.
 * - STRUCTURAL assertion on the generated source text (declares a schema? reads
 *   .structured?); the authored source is dumped for LLM-judging the reads.
 * - Pilot FIRST (anti-pattern 4): 1 alias × 1 run, baseline+proposed.
 *
 * Pre-registered gate (panel >= 3 aliases) — LIFT metric:
 * - mean structuredCorrectRate(proposed) - baseline >= 0.25
 * - mean structuredCorrectRate(proposed) >= 0.60
 *   where structuredCorrect := generated source declares outputSchema AND reads .structured.
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=ds/v4flash KODAX_EVAL_RUNS=1 npm run test:eval -- tests/space-workflow-generator-structured.eval.ts
 * Run (panel):  npm run test:eval -- tests/space-workflow-generator-structured.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, resolveAlias, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
  buildWorkflowGenerationUserPrompt,
} from '../packages/coding/src/workflows/generator.js';

/** Revert the generator user prompt to the pre-fix, zero-`.structured`-teaching baseline. */
function makeBaselineGeneratorPrompt(proposed: string): string {
  let s = proposed;
  // 1. API-signature lines: drop the outputSchema field (2 occurrences).
  const sigCount = s.split('verification, outputSchema })').length - 1;
  s = s.split('verification, outputSchema })').join('verification })');
  // 2. Return shapes: drop the structured? field.
  s = s.replace('finalText, structured?, digest?', 'finalText, digest?');
  // 3. The two structured teaching bullets.
  s = s.replace(
    /\n- When a spawn declared outputSchema[\s\S]*?the validated object lives only on result\.structured\./,
    '',
  );
  // 4. The structured-output worked example.
  s = s.replace(
    /\nStructured-output example;[\s\S]*?\n {2}return \{ synthesis: synthesis\.text \};\n\}/,
    '',
  );
  // Fail loud on prompt drift: the strip must be complete → zero teaching remains.
  if (sigCount !== 2) throw new Error(`baseline strip: expected 2 outputSchema sig lines, found ${sigCount}`);
  if (/outputSchema/.test(s) || /\.structured/.test(s)) {
    throw new Error('baseline strip incomplete — residual outputSchema/.structured teaching remains; update the eval.');
  }
  return s;
}

// A structured multi-module review request — the shape that broke in run-mr4oxcg4
// (each reviewer returns structured per-module findings, then a synthesis folds them).
const REQUEST = [
  '审查这个代码库的若干核心模块的代码质量。把审查按模块拆成若干个 reviewer 子 agent 并行进行,',
  '每个 reviewer 用结构化输出返回该模块的评审结果:一句话总评(summary),以及一组 findings',
  '(每条含 severity、category、title、detail、evidence 的 file:line、confidence)。',
  '最后综合所有模块的结构化结果,产出一份按严重度排序的中文 review 报告。只读代码,不要改动任何文件。',
].join('');

const CANONICAL_PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];
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
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'space-workflow-generator-structured');
const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

interface GenSignals {
  readonly declaresSchema: boolean;
  readonly readsStructured: boolean;
  readonly structuredCorrect: boolean;
  /** declared a schema but never reads .structured ⇒ reads the top-level result (the bug). */
  readonly buggyTopLevelRead: boolean;
  readonly text: string;
}

function assess(text: string): GenSignals {
  const declaresSchema = /outputSchema/.test(text);
  const readsStructured = /\.structured\b/.test(text);
  return {
    declaresSchema,
    readsStructured,
    structuredCorrect: declaresSchema && readsStructured,
    buggyTopLevelRead: declaresSchema && !readsStructured,
    text,
  };
}

async function generate(alias: ModelAlias, userMessage: string): Promise<GenSignals> {
  const run = async (target: ModelAlias): Promise<GenSignals> => {
    const out = await runOneShot(target, { systemPrompt: WORKFLOW_GENERATION_SYSTEM_PROMPT, userMessage });
    return assess(out.text);
  };
  try {
    return await run(alias);
  } catch (primary) {
    const fb = ALIAS_FALLBACK[alias];
    if (!fb) throw primary;
    return await run(fb);
  }
}

describe('Space empty-findings — generator teaches reading result.structured', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'the proposed generator prompt makes a structured reviewer panel read result.structured, not the top-level result',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const proposedPrompt = buildWorkflowGenerationUserPrompt(REQUEST);
      const baselinePrompt = makeBaselineGeneratorPrompt(proposedPrompt);
      // sanity: clean A/B — proposed teaches, baseline does not.
      expect(proposedPrompt).toContain('result.structured');
      expect(baselinePrompt).not.toContain('result.structured');
      expect(baselinePrompt).not.toContain('outputSchema');

      const promptFor: Record<Variant, string> = { baseline: baselinePrompt, proposed: proposedPrompt };
      const correctRate = new Map<Variant, Map<ModelAlias, number>>();

      for (const variant of VARIANTS) {
        const perAlias = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; correctRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<GenSignals & { runIndex: number }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              runs.push({ runIndex: i, ...(await generate(alias, promptFor[variant])) });
            } catch (error) {
              runs.push({
                runIndex: i,
                declaresSchema: false,
                readsStructured: false,
                structuredCorrect: false,
                buggyTopLevelRead: false,
                text: `[ERROR] ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
              });
            }
          }
          const rate = runs.filter((r) => r.structuredCorrect).length / Math.max(1, runs.length);
          perAlias.set(alias, rate);
          aliasDumps.push({ alias, correctRate: rate, runs });
        }
        correctRate.set(variant, perAlias);
        writeFileSync(join(DUMP_DIR, `${variant}.json`), JSON.stringify({ variant, request: REQUEST, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = panel.map(
        (a) =>
          `${a}: baseline ${pct(correctRate.get('baseline')!.get(a) ?? 0)}% -> proposed ${pct(correctRate.get('proposed')!.get(a) ?? 0)}%`,
      );
      // eslint-disable-next-line no-console
      console.log(`\n[space generator structured-read] panel=${panel.join(',')} runs=${RUNS}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const mean = (v: Variant): number => {
        const m = correctRate.get(v)!;
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
