/**
 * FEATURE_205-B (v0.7.45) — MCP parallel-emission prompt guidance eval.
 *
 * Hypothesis: adding a "Parallel MCP Emission" guidance block (teaching the LLM
 * to emit multiple INDEPENDENT MCP tool_use in ONE turn, but stay sequential on
 * a dependent pipeline) raises independent-fan-out parallelism WITHOUT breaking
 * dependent ordering.
 *
 * Per benchmark/EVAL_GUIDELINES.md:
 *  - Layer 2 single-turn probe (can't be answered by unit test — it's about the
 *    LLM's first-response tool-emission shape).
 *  - Canonical 5-alias coding-plan panel.
 *  - Mechanical assertion on harness-captured toolBlocks (NOT text regex — so the
 *    anti-pattern 7 false-negative risk is structurally avoided; the ground truth
 *    is the actual tool_use count).
 *  - Production-shaped MCP tool definitions advertised via the tools channel.
 *  - Raw dump to os.tmpdir()/kodax-eval-dumps/feature-205b-mcp-parallel/.
 *  - 3-judge panel-internal LLM audit is run by a companion pass over the dump
 *    (zhipu/glm51 + ark/v4pro + kimi; never anthropic/openai).
 *
 * Pre-registered SHIP gate:
 *  - C1 independent-fan-out: 4/5 alias proposed parallel-rate >= baseline + 30pp.
 *  - C2 dependent-chain: 5/5 alias proposed 0 mis-parallel (does not emit the
 *    dependent second call in the same turn) — regression guard.
 *
 * Run: npm run test:eval -- tests/feature-205b-mcp-parallel.eval.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax-ai/llm';

/* ---------- Canonical 5-alias coding-plan panel ---------- */

interface AliasTarget {
  alias: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
}

const PANEL: AliasTarget[] = [
  { alias: 'zhipu/glm51', provider: 'zhipu-coding', model: 'glm-5.1', apiKeyEnv: 'ZHIPU_API_KEY' },
  { alias: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_API_KEY' },
  { alias: 'mmx/m27', provider: 'minimax-coding', model: 'MiniMax-M2.7', apiKeyEnv: 'MINIMAX_API_KEY' },
  { alias: 'ark/v4pro', provider: 'ark-coding', model: 'deepseek-v4-pro', apiKeyEnv: 'ARK_API_KEY' },
  { alias: 'ark/v4flash', provider: 'ark-coding', model: 'deepseek-v4-flash', apiKeyEnv: 'ARK_API_KEY' },
];

const RUNS = 5;

/* ---------- Production-shaped MCP tools (github + linear style) ---------- */

const MCP_TOOLS: KodaXToolDefinition[] = [
  {
    name: 'github_list_issues',
    description: 'List open issues in a GitHub repository. Returns an array of {number, title} — call github_get_issue_comments per issue number to read its discussion.',
    input_schema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/name' } },
      required: ['repo'],
    },
  },
  {
    name: 'github_get_issue_comments',
    description: 'Fetch the comment thread on a single GitHub issue by number. Independent per issue — fetching issue #1 does not depend on issue #2.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        number: { type: 'number', description: 'issue number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name: 'linear_get_team_by_name',
    description: 'Resolve a Linear team name to its team id. The id is required by linear_get_team_issues.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'team display name' } },
      required: ['name'],
    },
  },
  {
    name: 'linear_get_team_issues',
    description: 'List issues for a Linear team. Requires the teamId returned by linear_get_team_by_name.',
    input_schema: {
      type: 'object',
      properties: { teamId: { type: 'string', description: 'team id from linear_get_team_by_name' } },
      required: ['teamId'],
    },
  },
];

/* ---------- Prompt variants ---------- */

const PARALLEL_GUIDANCE = [
  '=== Parallel MCP Emission ===',
  '',
  'When you need to call multiple INDEPENDENT MCP tools in the same step — emit',
  'them in the same tool_use turn so they execute concurrently. The runtime',
  'parallelizes non-bash tool_use within one turn.',
  '',
  'Fast path:  one turn -> multiple tool_use -> all run concurrently',
  'Slow path:  multiple turns -> one tool_use each -> re-tokenize context each turn',
  '',
  'Only emit sequentially when step N\'s args literally depend on step N-1\'s',
  'output (dependent pipeline). For independent fan-out (you already have the N',
  'item ids, fetch detail for each), emit all N detail calls in one turn.',
].join('\n');

function buildSystemPrompt(withGuidance: boolean): string {
  return [
    'You are a coding agent with access to MCP (Model Context Protocol) tools',
    'for GitHub and Linear. Use the provided tools to accomplish the user\'s request.',
    'Begin by calling the tools you need.',
    ...(withGuidance ? ['', PARALLEL_GUIDANCE] : []),
  ].join('\n');
}

/* ---------- Cases ---------- */

interface EvalCase {
  id: string;
  userMessage: string;
  /** PASS = the prompt produced the desired emission shape. */
  score: (toolCalls: ReadonlyArray<{ name: string }>) => boolean;
  expectation: string;
}

const CASES: EvalCase[] = [
  {
    id: 'C1_independent_fanout',
    // IDs given up front so the FIRST response can fan out the detail calls.
    userMessage:
      'In repo acme/app, issues #11, #12, #13 and #14 are all open. Fetch the comment thread on each of these four issues and summarize the discussion per issue.',
    expectation: '>=2 github_get_issue_comments in the first response (parallel fan-out)',
    score: (toolCalls) =>
      toolCalls.filter((t) => t.name === 'github_get_issue_comments').length >= 2,
  },
  {
    id: 'C2_dependent_chain',
    userMessage:
      'List the open issues for the Linear team named "Platform". (You must resolve the team name to an id first.)',
    expectation: 'first response emits ONLY linear_get_team_by_name (no dependent get_team_issues same turn)',
    score: (toolCalls) => {
      const names = toolCalls.map((t) => t.name);
      const hasResolve = names.includes('linear_get_team_by_name');
      const hasDependent = names.includes('linear_get_team_issues');
      // Correct: resolve first, do NOT emit the dependent call in the same turn.
      return hasResolve && !hasDependent;
    },
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
  variant: 'baseline' | 'proposed';
  caseId: string;
  passRate: string;
  runs: RunRecord[];
}

const DUMP_DIR = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-205b-mcp-parallel');

async function runCell(
  target: AliasTarget,
  variant: 'baseline' | 'proposed',
  evalCase: EvalCase,
): Promise<CellRecord> {
  const systemPrompt = buildSystemPrompt(variant === 'proposed');
  const messages: KodaXMessage[] = [{ role: 'user', content: evalCase.userMessage }];
  const provider = getProvider(target.provider as Parameters<typeof getProvider>[0]);
  const runs: RunRecord[] = [];
  let passes = 0;

  for (let i = 0; i < RUNS; i++) {
    try {
      const result = await provider.stream(messages, MCP_TOOLS, systemPrompt, undefined, {
        modelOverride: target.model,
      });
      const toolCalls = result.toolBlocks.map((b) => ({ name: b.name }));
      const passed = evalCase.score(toolCalls);
      if (passed) passes += 1;
      runs.push({
        runIndex: i,
        text: result.textBlocks.map((b) => b.text).join('').slice(0, 800),
        toolCalls: toolCalls.map((t) => t.name),
        passed,
      });
    } catch (err) {
      runs.push({
        runIndex: i,
        text: '',
        toolCalls: [],
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    alias: target.alias,
    variant,
    caseId: evalCase.id,
    passRate: `${passes}/${RUNS}`,
    runs,
  };
}

describe('FEATURE_205-B: MCP parallel emission prompt', () => {
  const available = PANEL.filter((t) => process.env[t.apiKeyEnv]);

  if (available.length === 0) {
    it('skips: no coding-plan API keys in env', () => {
      console.warn('[eval] No panel API keys found; set ZHIPU/KIMI/MINIMAX/ARK keys.');
      expect(true).toBe(true);
    });
    return;
  }

  it(
    `panel: ${available.length} alias x 2 variant x ${CASES.length} case x ${RUNS} runs`,
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const cells: CellRecord[] = [];

      for (const evalCase of CASES) {
        for (const target of available) {
          for (const variant of ['baseline', 'proposed'] as const) {
            console.log(`[eval] ${evalCase.id} | ${target.alias} | ${variant} ...`);
            const cell = await runCell(target, variant, evalCase);
            cells.push(cell);
            console.log(`       ${variant} passRate=${cell.passRate}`);
          }
        }
        // Dump per case (re-mkdir guard against tmp cleanup mid-run).
        mkdirSync(DUMP_DIR, { recursive: true });
        const caseCells = cells.filter((c) => c.caseId === evalCase.id);
        writeFileSync(
          path.join(DUMP_DIR, `${evalCase.id}.json`),
          JSON.stringify({ case: evalCase.id, expectation: evalCase.expectation, cells: caseCells }, null, 2),
        );
      }

      // Summary table: per case, baseline vs proposed pass-rate per alias.
      console.log('\n========== FEATURE_205-B RESULTS ==========');
      for (const evalCase of CASES) {
        console.log(`\n${evalCase.id} — ${evalCase.expectation}`);
        for (const target of available) {
          const base = cells.find((c) => c.caseId === evalCase.id && c.alias === target.alias && c.variant === 'baseline');
          const prop = cells.find((c) => c.caseId === evalCase.id && c.alias === target.alias && c.variant === 'proposed');
          console.log(`  ${target.alias.padEnd(13)} baseline=${base?.passRate ?? 'n/a'}  proposed=${prop?.passRate ?? 'n/a'}`);
        }
      }
      console.log(`\n[eval] raw dump: ${DUMP_DIR}`);

      expect(cells.length).toBe(CASES.length * available.length * 2);
    },
    30 * 60 * 1000,
  );
});
