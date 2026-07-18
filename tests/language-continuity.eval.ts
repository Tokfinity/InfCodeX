/**
 * ③ Language-continuity — Layer-2 behavioral probe (per benchmark/EVAL_GUIDELINES.md).
 *
 * Question (not answerable by Layer 1): does adding the "answer in the objective's
 * language" rule to the child-agent system prompt make a coding-plan model, given
 * a CHINESE objective over ENGLISH code, actually report in Chinese — the real gap
 * the user hit (dispatch/workflow children defaulting to English)? Layer 1
 * (language-continuity.test.ts) already pins that the rule string is assembled;
 * this measures whether it changes behavior.
 *
 * Design:
 * - v_baseline vs v_proposed differ ONLY by the one added child-prompt line
 *   (baseline strips it), byte-aligned everywhere else (anti-pattern 8 §2).
 * - Production child-agent system prompt bytes (CHILD_AGENT_SYSTEM_PROMPT), and the
 *   real child tool set via the provider tools channel (anti-pattern 8 §1).
 * - STRUCTURAL assertion: the reply is predominantly Chinese := >= 30 CJK chars
 *   (a genuine Chinese review has 100+; an English review that merely echoes the
 *   Chinese objective has ~10-15, so 30 rejects echo-only false positives). This is
 *   a POSITIVE assertion (contains CJK), the low-trap direction (anti-pattern 7);
 *   still sample the raw dump with the orchestrating session as self-judge.
 * - Pilot first (ark/v4flash), then the 5-alias panel.
 * - Raw dump -> os.tmpdir()/kodax-eval-dumps/language-continuity/<variant>.json.
 *
 * Pre-registered gate + classification:
 * - proposed mean chineseRate >= 0.90 (the rule reliably yields the user's language).
 * - If baseline mean is ALSO >= 0.90 -> ceiling saturation: the coding-plan panel
 *   already mirrors the query language for SA-style single children; the rule is a
 *   behaviorally-neutral GUARD (SHIP as hygiene per anti-pattern 9) whose value is
 *   the dispatch/workflow path where the child's objective is authored by another
 *   agent, not the user. If baseline < proposed by >= 0.20 -> real lift.
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=ark/v4flash KODAX_EVAL_RUNS=3 npm run test:eval -- tests/language-continuity.eval.ts
 * Run (panel):  npm run test:eval -- tests/language-continuity.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { getProvider } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';

import { CHILD_AGENT_SYSTEM_PROMPT } from '../packages/coding/src/child-executor.js';
import { resolveAlias } from '../benchmark/harness/aliases.js';
import type { ModelAlias } from '../benchmark/harness/aliases.js';

const PROPOSED_LINE =
  '- Write your final report in the same natural language as the objective you were given, so it reaches the user in their language. Keep code, file paths, and quoted evidence in their source language.';

// Byte-aligned baseline: the production prompt with ONLY the added line removed.
const BASELINE_PROMPT = CHILD_AGENT_SYSTEM_PROMPT.replace(`${PROPOSED_LINE}\n`, '');
const PROPOSED_PROMPT = CHILD_AGENT_SYSTEM_PROMPT;

const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

// A Chinese objective over English code — the drift-prone case: the reasoning
// substance is English identifiers, tempting an English answer.
const CHINESE_OBJECTIVE: KodaXMessage[] = [
  {
    role: 'user',
    content:
      '审查下面这个 TypeScript 函数的错误处理，指出其中的问题并给出改进建议：\n\n' +
      '```ts\n' +
      'async function fetchUser(id) {\n' +
      '  const res = await fetch(`/api/users/${id}`);\n' +
      '  return res.json();\n' +
      '}\n' +
      '```',
  },
];

const CJK = /[一-鿿]/g;
function cjkCount(text: string): number {
  return text.match(CJK)?.length ?? 0;
}
function isPredominantlyChinese(text: string): boolean {
  return cjkCount(text) >= 30;
}

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'language-continuity');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean) as ModelAlias[];
  }
  return ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'] as ModelAlias[];
}

function promptFor(variant: Variant): string {
  return variant === 'baseline' ? BASELINE_PROMPT : PROPOSED_PROMPT;
}

describe('③ language-continuity child-agent behavioral probe', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'a Chinese objective yields a Chinese child report',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // sanity: baseline really lacks the line, proposed really has it.
      expect(BASELINE_PROMPT).not.toContain(PROPOSED_LINE);
      expect(PROPOSED_PROMPT).toContain(PROPOSED_LINE);

      const chineseRate = new Map<Variant, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const system = promptFor(variant);
        const perAlias = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; chineseRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const provider = getProvider(resolveAlias(alias).provider);
          const runs: Array<{ runIndex: number; cjk: number; chinese: boolean; text: string }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              const result = await provider.stream(CHINESE_OBJECTIVE, [], system);
              const text = result.textBlocks.map((b) => b.text).join('\n');
              runs.push({ runIndex: i, cjk: cjkCount(text), chinese: isPredominantlyChinese(text), text });
            } catch (error) {
              runs.push({ runIndex: i, cjk: 0, chinese: false, text: `ERROR: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` });
            }
          }
          const rate = runs.filter((r) => r.chinese).length / Math.max(1, runs.length);
          perAlias.set(alias, rate);
          aliasDumps.push({ alias, chineseRate: rate, runs });
        }
        chineseRate.set(variant, perAlias);
        writeFileSync(join(DUMP_DIR, `${variant}.json`), JSON.stringify({ variant, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = panel.map((a) => `${a}: baseline ${pct(chineseRate.get('baseline')!.get(a) ?? 0)}% -> proposed ${pct(chineseRate.get('proposed')!.get(a) ?? 0)}%`);
      // eslint-disable-next-line no-console
      console.log(`\n[③ language-continuity] panel=${panel.join(',')} runs=${RUNS}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const mean = (v: Variant): number => {
        const m = chineseRate.get(v)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };

      if (panel.length >= 3) {
        // The rule must reliably produce the user's language.
        expect(mean('proposed'), 'proposed mean chineseRate >= 0.90').toBeGreaterThanOrEqual(0.9);
        // Saturation vs lift is classified from the dump (both >= 0.90 => hygiene GUARD; else lift).
      }
    },
    1_800_000,
  );
});
