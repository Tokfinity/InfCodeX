/**
 * FEATURE_205-A (v0.7.45) — cyclic_dependencies tool discoverability eval.
 *
 * Question: given the production tool descriptions, does the LLM (a) pick
 * cyclic_dependencies for a "is there a dependency cycle" task, and (b) NOT
 * over-trigger it on adjacent tasks (1-hop impact / repo overview) that the
 * other repo-intel tools own?
 *
 * Per benchmark/EVAL_GUIDELINES.md:
 *  - Layer 2 single-turn probe (which tool does the LLM pick — can't unit-test).
 *  - Production tool bytes: imports the REAL KODAX_TOOLS definitions (anti-pattern
 *    8), advertised via the tools channel — not hand-stubbed.
 *  - Structural assertion on harness-captured toolBlocks (anti-pattern 7 N/A).
 *  - Canonical 5-alias panel; raw dump; self-judge audit over the dump.
 *  - Single variant (a tool addition, not a prompt comparison) — measures the
 *    usage / false-trigger rate.
 *
 * Pre-registered gate (design 205-A acceptance d):
 *  - C1 cycle task: cyclic_dependencies invoked >= 80% on >= 4/5 alias.
 *  - C2/C3 adjacent tasks: cyclic_dependencies false-trigger <= 20% on 5/5 alias.
 *
 * Run: npm run test:eval -- tests/feature-205a-cyclic-deps.eval.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax-ai/llm';
import { KODAX_TOOLS } from '@kodax-ai/coding';

/* ---------- Canonical 5-alias coding-plan panel ---------- */

interface AliasTarget {
  alias: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
}

const PANEL: AliasTarget[] = [
  { alias: 'zhipu/glm51', provider: 'zhipu-coding', model: 'glm-5.1', apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  { alias: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_CODE_API_KEY' },
  { alias: 'mmx/m27', provider: 'minimax-coding', model: 'MiniMax-M2.7', apiKeyEnv: 'MINIMAX_CODING_API_KEY' },
  { alias: 'ark/v4pro', provider: 'ark-coding', model: 'deepseek-v4-pro', apiKeyEnv: 'ARK_CODING_API_KEY' },
  { alias: 'ark/v4flash', provider: 'ark-coding', model: 'deepseek-v4-flash', apiKeyEnv: 'ARK_CODING_API_KEY' },
];

const RUNS = 5;

/* ---------- Production tools (real bytes, anti-pattern 8) ---------- */

// Advertise the repo-intel choice set + generic read/grep/glob so the model has
// a realistic decision between cyclic_dependencies and its neighbours.
const CHOICE_SET = new Set([
  'repo_overview', 'module_context', 'symbol_context', 'process_context',
  'impact_estimate', 'cyclic_dependencies',
  'read', 'grep', 'glob',
]);
const TOOLS: KodaXToolDefinition[] = KODAX_TOOLS.filter((t) => CHOICE_SET.has(t.name));

const SYSTEM_PROMPT = [
  'You are a coding agent working in a TypeScript monorepo. Use the available',
  'tools to investigate the user\'s request. Call the most appropriate tool(s)',
  'for the task. Begin now.',
].join('\n');

/* ---------- Cases ---------- */

interface EvalCase {
  id: string;
  userMessage: string;
  /** PASS = correct tool-choice behaviour for this case. */
  score: (toolNames: readonly string[]) => boolean;
  expectation: string;
}

const CASES: EvalCase[] = [
  {
    id: 'C1_cycle_positive',
    userMessage:
      'I just moved several modules around and I\'m worried I introduced a circular import between packages. Are there any dependency cycles in this codebase?',
    expectation: 'invokes cyclic_dependencies',
    score: (names) => names.includes('cyclic_dependencies'),
  },
  {
    id: 'C2_impact_negative',
    userMessage:
      'I want to rename the function `handleAuth`. What is the blast radius — which call sites and packages would I need to update?',
    expectation: 'does NOT invoke cyclic_dependencies (this is 1-hop impact, not a cycle question)',
    score: (names) => !names.includes('cyclic_dependencies'),
  },
  {
    id: 'C3_overview_negative',
    userMessage:
      'Give me a high-level overview of how this repository is structured — the main modules and what they do.',
    expectation: 'does NOT invoke cyclic_dependencies (this is an overview question)',
    score: (names) => !names.includes('cyclic_dependencies'),
  },
];

/* ---------- Driver ---------- */

interface RunRecord {
  runIndex: number;
  text: string;
  toolCalls: string[];
  passed: boolean;
  error?: string;
}

interface CellRecord {
  alias: string;
  caseId: string;
  passRate: string;
  runs: RunRecord[];
}

const DUMP_DIR = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-205a-cyclic-deps');

async function runCell(target: AliasTarget, evalCase: EvalCase): Promise<CellRecord> {
  const messages: KodaXMessage[] = [{ role: 'user', content: evalCase.userMessage }];
  const provider = getProvider(target.provider as Parameters<typeof getProvider>[0]);
  const runs: RunRecord[] = [];
  let passes = 0;

  for (let i = 0; i < RUNS; i++) {
    try {
      const result = await provider.stream(messages, TOOLS, SYSTEM_PROMPT, undefined, {
        modelOverride: target.model,
      });
      const toolNames = result.toolBlocks.map((b) => b.name);
      const passed = evalCase.score(toolNames);
      if (passed) passes += 1;
      runs.push({
        runIndex: i,
        text: result.textBlocks.map((b) => b.text).join('').slice(0, 600),
        toolCalls: toolNames,
        passed,
      });
    } catch (err) {
      runs.push({
        runIndex: i, text: '', toolCalls: [], passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { alias: target.alias, caseId: evalCase.id, passRate: `${passes}/${RUNS}`, runs };
}

describe('FEATURE_205-A: cyclic_dependencies discoverability', () => {
  const available = PANEL.filter((t) => process.env[t.apiKeyEnv]);

  if (available.length === 0) {
    it('skips: no coding-plan API keys in env', () => {
      console.warn('[eval] No panel API keys found.');
      expect(true).toBe(true);
    });
    return;
  }

  it(
    `panel: ${available.length} alias x ${CASES.length} case x ${RUNS} runs`,
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      console.log(`[eval] advertising ${TOOLS.length} production tools (incl. cyclic_dependencies)`);
      const cells: CellRecord[] = [];

      for (const evalCase of CASES) {
        for (const target of available) {
          console.log(`[eval] ${evalCase.id} | ${target.alias} ...`);
          const cell = await runCell(target, evalCase);
          cells.push(cell);
          console.log(`       passRate=${cell.passRate}`);
        }
        mkdirSync(DUMP_DIR, { recursive: true });
        writeFileSync(
          path.join(DUMP_DIR, `${evalCase.id}.json`),
          JSON.stringify({ case: evalCase.id, expectation: evalCase.expectation, cells: cells.filter((c) => c.caseId === evalCase.id) }, null, 2),
        );
      }

      console.log('\n========== FEATURE_205-A RESULTS ==========');
      for (const evalCase of CASES) {
        console.log(`\n${evalCase.id} — ${evalCase.expectation}`);
        for (const target of available) {
          const cell = cells.find((c) => c.caseId === evalCase.id && c.alias === target.alias);
          console.log(`  ${target.alias.padEnd(13)} ${cell?.passRate ?? 'n/a'}`);
        }
      }
      console.log(`\n[eval] raw dump: ${DUMP_DIR}`);

      expect(cells.length).toBe(CASES.length * available.length);
    },
    30 * 60 * 1000,
  );
});
