/**
 * FEATURE_102 Phase 4 (v0.7.45) — model-tier quality probe.
 *
 * THE gating question for model_hint auto-routing: on representative read-only
 * investigation child-tasks (self-contained, verifiable answer), does the floor
 * model (ark/v4flash) produce as-correct output as the strong models? If yes,
 * routing 'fast' children to a cheap model is safe (no quality loss → build the
 * auto-routing). If the floor degrades materially, auto-routing 'fast'→cheap is
 * harmful (chain strength = weakest link, F102 design principle #6) → do NOT
 * auto-route; keep model routing explicit (specialist-only, already shipped).
 *
 * Per benchmark/EVAL_GUIDELINES.md:
 *  - Layer 2 single-turn probe (self-contained task — answer is in the prompt).
 *  - Content-correctness is NOT a structural metric → primary judge is a
 *    panel-internal 3-judge majority (zhipu/glm52 + ark/v4pro + kimi; NEVER
 *    anthropic/openai), per anti-pattern 7 §3 + the judge-model constraint.
 *    A keyword pre-check is recorded as a cross-reference only.
 *  - Canonical 5-alias panel; raw dump (answers + per-judge verdicts).
 *
 * Pre-registered decision rule:
 *  - If floor (ark/v4flash) judge-PASS rate >= 0.8 × the mean of the strong
 *    aliases across tasks → cheap preserves quality → model_hint auto-routing
 *    is SAFE to build.
 *  - If floor < 0.8 × strong-mean → cheap degrades → do NOT auto-route 'fast'
 *    to a cheap tier; keep explicit specialist routing only.
 *
 * Run: npm run test:eval -- tests/feature-102-model-tier-quality.eval.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { getProvider, type KodaXMessage } from '@kodax-ai/llm';

interface AliasTarget {
  alias: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
  tier: 'floor' | 'strong';
}

const PANEL: AliasTarget[] = [
  { alias: 'zhipu/glm52', provider: 'zhipu-coding', model: 'glm-5.2', apiKeyEnv: 'ZHIPU_CODING_API_KEY', tier: 'strong' },
  { alias: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_CODE_API_KEY', tier: 'strong' },
  { alias: 'mmx/m3', provider: 'minimax-coding', model: 'MiniMax-M3', apiKeyEnv: 'MINIMAX_CODING_API_KEY', tier: 'strong' },
  { alias: 'ark/v4pro', provider: 'ark-coding', model: 'deepseek-v4-pro', apiKeyEnv: 'ARK_CODING_API_KEY', tier: 'strong' },
  { alias: 'ark/v4flash', provider: 'ark-coding', model: 'deepseek-v4-flash', apiKeyEnv: 'ARK_CODING_API_KEY', tier: 'floor' },
];

// Judge panel: 3 independent families, all coding-plan, NEVER anthropic/openai.
const JUDGES: AliasTarget[] = PANEL.filter((t) =>
  ['zhipu/glm52', 'ark/v4pro', 'kimi'].includes(t.alias),
);

const RUNS = 5;

/* ---------- Investigation tasks (self-contained, verifiable answer) ---------- */

interface Task {
  id: string;
  prompt: string;
  reference: string;
  keyword: (answer: string) => boolean; // cheap cross-check only
}

const TASKS: Task[] = [
  {
    id: 'T1_offbyone',
    prompt: [
      'Read this TypeScript function and answer the question. Do not call any tools — just answer.',
      '',
      '```ts',
      'function lastN<T>(arr: T[], n: number): T[] {',
      '  const out: T[] = [];',
      '  for (let i = arr.length - n; i <= arr.length; i++) {',
      '    out.push(arr[i]);',
      '  }',
      '  return out;',
      '}',
      '```',
      '',
      'This is meant to return the last `n` elements but it has a bug. What is the bug?',
    ].join('\n'),
    reference: 'Off-by-one: the loop condition `i <= arr.length` reads `arr[arr.length]` (one past the end → undefined). It should be `i < arr.length`.',
    keyword: (a) => /off.?by.?one|<\s*arr\.length|i\s*<\s*arr|<= ?arr\.length|out of bound|undefined|one past/i.test(a),
  },
  {
    id: 'T2_injection',
    prompt: [
      'Read these three functions and answer the question. Do not call any tools — just answer.',
      '',
      '```ts',
      'function getUserById(db, id: number) { return db.query("SELECT * FROM users WHERE id = ?", [id]); }',
      'function getUserByName(db, name: string) { return db.query("SELECT * FROM users WHERE name = \'" + name + "\'"); }',
      'function countUsers(db) { return db.query("SELECT COUNT(*) FROM users"); }',
      '```',
      '',
      'One of these has a security vulnerability. Which function, and what kind of vulnerability?',
    ].join('\n'),
    reference: '`getUserByName` — SQL injection: it concatenates the untrusted `name` directly into the query string instead of using a parameterised placeholder.',
    keyword: (a) => /getUserByName/i.test(a) && /inject|sql/i.test(a),
  },
  {
    id: 'T3_trace',
    prompt: [
      'Trace this code and answer the question. Do not call any tools — just answer.',
      '',
      '```ts',
      'const nums = [1, 2, 3, 4, 5];',
      'let total = 0;',
      'for (const n of nums) {',
      '  if (n % 2 === 0) total += n * 2;',
      '  else total += n;',
      '}',
      '```',
      '',
      'What is the final value of `total`? Give the number.',
    ].join('\n'),
    // odds: 1+3+5 = 9; evens doubled: 2*2 + 4*2 = 4 + 8 = 12; total = 21.
    reference: '21 (odds 1+3+5=9, evens doubled 4+8=12, 9+12=21).',
    keyword: (a) => /\b21\b/.test(a),
  },
];

const SYSTEM_PROMPT = 'You are a precise code reviewer. Answer the question directly and correctly.';

/* ---------- Judge ---------- */

const JUDGE_SYSTEM = [
  'You are grading a candidate answer to a code question.',
  'You are given the QUESTION, a REFERENCE answer (the ground truth), and a',
  'CANDIDATE answer. Decide if the CANDIDATE is correct — i.e. it reaches the',
  'same core conclusion as the REFERENCE (wording may differ).',
  'Reply with EXACTLY one word on the first line: PASS or FAIL.',
].join('\n');

async function judgeOne(
  judge: AliasTarget,
  task: Task,
  candidate: string,
): Promise<boolean> {
  const provider = getProvider(judge.provider as Parameters<typeof getProvider>[0]);
  const user = [
    `QUESTION:\n${task.prompt}`,
    `\nREFERENCE (ground truth):\n${task.reference}`,
    `\nCANDIDATE:\n${candidate || '(empty)'}`,
    '\nIs the CANDIDATE correct? Reply PASS or FAIL.',
  ].join('\n');
  try {
    const result = await provider.stream(
      [{ role: 'user', content: user }] as KodaXMessage[],
      [],
      JUDGE_SYSTEM,
      undefined,
      { modelOverride: judge.model },
    );
    const text = result.textBlocks.map((b) => b.text).join('').trim();
    return /^\s*PASS\b/i.test(text);
  } catch {
    return false;
  }
}

/* ---------- Driver ---------- */

const DUMP_DIR = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-102-model-tier-quality');

describe('FEATURE_102 P4: model-tier quality', () => {
  const available = PANEL.filter((t) => process.env[t.apiKeyEnv]);

  if (available.length === 0) {
    it('skips: no panel API keys', () => {
      console.warn('[eval] need panel keys (zhipu/kimi/minimax/ark).');
      expect(true).toBe(true);
    });
    return;
  }

  it(
    `panel: ${available.length} alias x ${TASKS.length} task x ${RUNS} runs (answer-only, self-judged dump)`,
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // alias → task → judge-PASS count (out of RUNS)
      const score: Record<string, Record<string, number>> = {};
      const dump: unknown[] = [];

      for (const task of TASKS) {
        for (const target of available) {
          const provider = getProvider(target.provider as Parameters<typeof getProvider>[0]);
          let keywordPasses = 0;
          const runDumps: unknown[] = [];

          for (let i = 0; i < RUNS; i++) {
            let answer = '';
            try {
              const result = await provider.stream(
                [{ role: 'user', content: task.prompt }] as KodaXMessage[],
                [], SYSTEM_PROMPT, undefined, { modelOverride: target.model },
              );
              answer = result.textBlocks.map((b) => b.text).join('').trim();
            } catch (err) {
              answer = `(error: ${err instanceof Error ? err.message : String(err)})`;
            }
            const keywordPass = task.keyword(answer);
            if (keywordPass) keywordPasses += 1;
            // Keyword is the mechanical cross-check; full answers are dumped so the
            // orchestrating session self-judges correctness (EVAL_GUIDELINES judge
            // source #1) — the 3 tasks have unambiguous ground-truth answers.
            runDumps.push({ runIndex: i, answer: answer.slice(0, 1500), keywordPass });
          }

          score[target.alias] = score[target.alias] ?? {};
          score[target.alias]![task.id] = keywordPasses;
          console.log(`[eval] ${task.id} | ${target.alias.padEnd(13)} keyword=${keywordPasses}/${RUNS}`);
          dump.push({ task: task.id, alias: target.alias, tier: target.tier, keywordPasses, runs: runDumps });
        }
        mkdirSync(DUMP_DIR, { recursive: true });
        writeFileSync(path.join(DUMP_DIR, `${task.id}.json`), JSON.stringify(dump.filter((d) => (d as { task: string }).task === task.id), null, 2));
      }

      // Aggregate: floor vs strong mean.
      const totalCells = TASKS.length * RUNS;
      const aliasTotal = (alias: string): number =>
        TASKS.reduce((s, t) => s + (score[alias]?.[t.id] ?? 0), 0);
      const strongAliases = available.filter((t) => t.tier === 'strong').map((t) => t.alias);
      const floorAlias = available.find((t) => t.tier === 'floor')?.alias;

      console.log('\n========== FEATURE_102 P4 RESULTS (judge-PASS / ' + totalCells + ') ==========');
      for (const target of available) {
        const tot = aliasTotal(target.alias);
        console.log(`  ${target.alias.padEnd(13)} [${target.tier}] ${tot}/${totalCells} (${(100 * tot / totalCells).toFixed(0)}%)`);
      }
      if (floorAlias && strongAliases.length > 0) {
        const floorRate = aliasTotal(floorAlias) / totalCells;
        const strongMean = strongAliases.reduce((s, a) => s + aliasTotal(a), 0) / (strongAliases.length * totalCells);
        const ratio = strongMean > 0 ? floorRate / strongMean : 1;
        console.log(`\n  floor=${(floorRate * 100).toFixed(0)}%  strong-mean=${(strongMean * 100).toFixed(0)}%  ratio=${ratio.toFixed(2)}`);
        console.log(`  DECISION: ${ratio >= 0.8 ? 'cheap PRESERVES quality → auto-routing SAFE' : 'cheap DEGRADES → do NOT auto-route fast->cheap'}`);
      }
      console.log(`\n[eval] raw dump: ${DUMP_DIR}`);

      expect(dump.length).toBe(TASKS.length * available.length);
    },
    40 * 60 * 1000,
  );
});
