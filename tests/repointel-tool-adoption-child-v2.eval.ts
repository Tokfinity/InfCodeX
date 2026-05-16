/**
 * Eval Suite A — Child prompt F1v2 + F2 validation (with real production
 * objectives as input + negative cases).
 *
 * ## Purpose
 *
 * Production trace audit (2026-05-15, 5 review sessions) found 0 pull-tool
 * calls in dispatched child agents despite F7 (FEATURE_161) on Worker prompt.
 * Root cause: `CHILD_AGENT_SYSTEM_PROMPT` (packages/coding/src/child-executor.ts:478)
 * has reverse-steering line `"A typical first turn should have 3-8 parallel
 * tool calls (glob + grep + key file reads)."` since v0.7.18 (2026-04-14).
 *
 * Prior eval (`repointel-tool-adoption-child.eval.ts`, this conversation
 * earlier) used CANNED objectives and found baseline 63% pull-tool rate
 * — but production shows 0% with real Worker-written objectives. This
 * suite uses REAL `dispatch_child_task.objective` text extracted from
 * production session jsonl.
 *
 * F1v2: REPHRASE (not delete) the reverse-steering line — replace
 *   "glob + grep + key file reads" example with pull-tool-first guidance
 *   while preserving parallel-call discipline.
 * F2: Add explicit "Tool preference order" line (v0.7.14 had similar).
 *
 * ## Why not Layer 1
 *
 * Layer 1 already measured production (0% pull-tool rate with current
 * CHILD_AGENT_SYSTEM_PROMPT). Cannot predict whether F1v2+F2 changes
 * model behavior without LLM probe.
 *
 * ## Method — Layer 2 single-turn probe
 *
 * Input: child system prompt (variant) + a real production dispatch objective
 * as user message. Output: model's first tool call.
 *
 * ## Variants
 *
 * - `A_baseline`: current `CHILD_AGENT_SYSTEM_PROMPT` (reverse-steering intact)
 * - `B_F1v2`: rephrase reverse-steering line (positive pull-tool example)
 * - `C_F1v2_plus_F2`: B + "Tool preference order" line
 *
 * ## Cases — 4 positive (real production objectives) + 2 negative
 *
 * Positive cases use real `dispatch_child_task.objective` text extracted
 * from sessions 20260514_181503, 20260515_103836, 20260515_132437,
 * 20260515_162035 (file `c:/tmp/real-objectives-pick.json`):
 *  1. `review_with_bash_directive` — real, contains "使用 git diff" directive
 *  2. `review_committed_changes` — real, neutral comprehensive review
 *  3. `messaging_module_review` — real, focused module review (note: same
 *     scope as #2 in source but different objective text — disambiguated
 *     post-pick)
 *  4. `repl_paste_review` — real, multi-package with paste focus
 *
 * Negative cases (synthetic — production didn't have these, but they test
 * over-trigger risk):
 *  5. `single_file_lookup` — expects `read`, not pull-tool
 *  6. `exact_string_search` — expects `grep`, not pull-tool
 *
 * ## Sample size justification
 *
 * 6 aliases × 3 variants × 3 runs × 6 cases = 324 calls. Pooled across
 * panel (n=18 per variant per case) is primary signal. Per-alias-per-case
 * (n=3) is descriptive only.
 *
 * ## Cost budget
 *
 * 324 calls × $0.01–0.10 = $3–32. Worth one prompt-change ship/reject
 * decision per EVAL_GUIDELINES.
 *
 * ## Pre-registered decision matrix
 *
 * POSITIVE cases (4 cases, 72 runs per variant pooled across panel + cases):
 * - SHIP_F1v2_PRELIM: pool_pull(B) >= pool_pull(A) + 25pp AND >=4 aliases
 *   show monotonic lift A < B
 * - SHIP_F2_ON_TOP_PRELIM: pool_pull(C) >= pool_pull(B) + 10pp
 *
 * NEGATIVE cases (2 cases, 36 runs per variant pooled):
 * - NEG_OK_F1v2: pool_pull(B) <= 20% on negative cases (no over-trigger)
 * - NEG_OK_F2: pool_pull(C) <= 25% on negative cases (allow small over-trigger
 *   penalty for F2 explicit listing — bigger than F1v2 tolerance is allowed
 *   since F2 is the more explicit nudge)
 *
 * Final ship requires PRELIM verdict from regex AND self-judge audit
 * agreement >= 90%.
 *
 * ## LLM judge plan (mandatory)
 *
 * Self-judge by orchestrating Claude post-run. Audit ≥1 regex-pass +
 * ≥1 regex-fail per cell. Negative cases get LLM judge per-run (not
 * just sampled) to catch anti-pattern 7 §1 verbose chain-of-thought
 * false negatives (e.g., "I should not use module_context here" said
 * AFTER actually calling module_context).
 *
 * ## Run
 *
 *   npm run test:eval -- repointel-tool-adoption-child-v2
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const TOOLS: readonly KodaXToolDefinition[] = [
  { name: 'repo_overview', description: 'Summarize the repository structure.', input_schema: { type: 'object', properties: { target_path: { type: 'string' } } } },
  { name: 'changed_scope', description: 'List of changed files with area/category labels.', input_schema: { type: 'object', properties: { target_path: { type: 'string' }, scope: { type: 'string' }, base_ref: { type: 'string' } } } },
  { name: 'changed_diff', description: 'Paged diff for one file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'changed_diff_bundle', description: 'Paged diff for multiple changed files.', input_schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
  { name: 'module_context', description: 'Module capsule with deps, entry files, symbols, tests, docs.', input_schema: { type: 'object', properties: { module: { type: 'string' }, target_path: { type: 'string' } } } },
  { name: 'symbol_context', description: 'Definition + callers/callees + imports.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'process_context', description: 'Static execution trace.', input_schema: { type: 'object', properties: { entry: { type: 'string' } } } },
  { name: 'impact_estimate', description: 'Blast radius estimate.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'grep', description: 'Search file contents using ripgrep.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'glob', description: 'File pattern matching.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'bash', description: 'Execute a bash command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const PULL_TOOL_NAMES = new Set(['repo_overview', 'changed_scope', 'changed_diff', 'changed_diff_bundle', 'module_context', 'symbol_context', 'process_context', 'impact_estimate']);

// Child baseline prompt — VERBATIM from child-executor.ts:478-505 (commit 87f98a2c)
const CHILD_BASELINE_PROMPT = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — ALWAYS Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, you MUST emit them all in the SAME response.',
  'The execution engine runs non-bash tools concurrently via Promise.all — serial calls waste time.',
  '',
  'Concrete rules:',
  '- When you need to read/grep/glob multiple files, emit ALL calls in one response — do NOT wait for results between independent reads.',
  '- Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- A typical first turn should have 3-8 parallel tool calls (glob + grep + key file reads).',
  '- Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only (no tool calls) — the parent agent will use it directly.',
  '',
  '## Output Format',
  'Respond with a concise report covering:',
  '- Key findings with specific file:line references',
  '- Severity or priority assessment (if applicable)',
  '- Concrete recommendations',
  '',
  'Keep the report focused — the parent will relay it to the user.',
].join('\n');

// F1v2 — REPHRASE the reverse-steering line. Replace the original
// "Concrete rules" block while preserving parallel-call discipline.
const CHILD_F1V2_PROMPT = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — ALWAYS Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, you MUST emit them all in the SAME response.',
  'The execution engine runs non-bash tools concurrently via Promise.all — serial calls waste time.',
  '',
  'Concrete rules:',
  '- For module exploration or change review, LEAD with pull-tools (module_context / symbol_context / changed_scope / changed_diff_bundle) — each replaces 5-10 read+grep calls.',
  '- For single-file lookup or byte-exact verification, use glob + grep + targeted read.',
  '- When you need multiple independent tool calls (whether pull-tools, reads, or grepps), emit ALL in one response — do NOT serialize.',
  '- Only serialize when a later call genuinely depends on an earlier result.',
  '- A typical first turn should have 3-8 parallel tool calls.',
  '- Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only (no tool calls) — the parent agent will use it directly.',
  '',
  '## Output Format',
  'Respond with a concise report covering:',
  '- Key findings with specific file:line references',
  '- Severity or priority assessment (if applicable)',
  '- Concrete recommendations',
  '',
  'Keep the report focused — the parent will relay it to the user.',
].join('\n');

// F2 — append the tool preference order line
const F2_TOOL_ORDER_LINE = [
  '',
  '## Tool Preference Order',
  '- Tier 1 (preferred for module-level work): repo-intel pull-tools — module_context, symbol_context, changed_scope, changed_diff_bundle, changed_diff, repo_overview, impact_estimate, process_context',
  '- Tier 2 (fallback for targeted file work): read, grep, glob',
  '- Tier 3 (last resort for git operations): bash',
  '- Pick the most SPECIFIC tool for the task. Within a tier, do not over-broaden (don\'t call `repo_overview` when `module_context(target_path=X)` is what you need).',
].join('\n');

const SYSTEM_A_BASELINE = CHILD_BASELINE_PROMPT;
const SYSTEM_B_F1V2 = CHILD_F1V2_PROMPT;
const SYSTEM_C_F1V2_PLUS_F2 = CHILD_F1V2_PROMPT + '\n' + F2_TOOL_ORDER_LINE;

// ---------------------------------------------------------------------------
// Cases — 4 real production objectives + 2 negative
// ---------------------------------------------------------------------------

interface CaseSpec {
  readonly id: string;
  readonly description: string;
  readonly userMessage: string;
  readonly preferredPullTools: readonly string[]; // empty for negative cases
  readonly negativePreferred: readonly string[];  // expected non-pull tool for negative cases
  readonly isNegative: boolean;
}

const CASES: readonly CaseSpec[] = [
  // Real production objective with explicit bash directive (worst case)
  {
    id: 'real_review_with_bash_directive',
    description: 'Real production objective containing "使用 git diff" directive.',
    userMessage: '审查 packages/coding 中自 v0.7.39 以来的核心代码改动，重点检查：\n1. compaction.ts — AMA in-turn compaction parity 改动，检查 microcompact 逻辑、snapshot-aware trigger、graceful fallback 是否有边界问题\n2. round-boundary.ts — tool_use/tool_result 链保持逻辑是否有遗漏场景\n3. dispatch-child-tasks.ts — queue filter scope 修改是否引入了消息过滤错误\n4. query-fallback.ts — OSS query-fallback symbol confidence 改动是否有类型安全问题\n\n使用 git diff v0.7.39..HEAD -- packages/coding/ 查看改动，并阅读关键文件。只做分析，不做改动。输出格式：按文件列出发现的问题，每个问题标注严重程度 (CRITICAL/HIGH/MEDIUM/LOW) 和具体行号。',
    preferredPullTools: ['changed_diff_bundle', 'changed_diff', 'changed_scope'],
    negativePreferred: [],
    isNegative: false,
  },
  // Real neutral comprehensive review
  {
    id: 'real_review_committed_neutral',
    description: 'Real production objective, neutral phrasing without bash directive.',
    userMessage: 'Review committed (v0.7.39..HEAD) changes in the agent messaging module — specifically:\n1. packages/agent/src/messaging/queue.ts — new MessageQueue implementation\n2. packages/agent/src/messaging/types.ts — new types\n3. packages/agent/src/messaging/queue.test.ts — new tests\n\nFocus on:\n- Logic correctness: race conditions, filter semantics, dequeuing order\n- API surface: are the exported types clean and minimal?\n- Test coverage: are edge cases (empty queue, concurrent enqueue/dequeue, filter that matches nothing) covered?\n- Any functional regression risk compared to the pre-v0.7.39 state?\n\nReport findings as a structured list: [OK], [WARN], [ISSUE] per file.',
    preferredPullTools: ['module_context', 'changed_diff_bundle', 'changed_diff'],
    negativePreferred: [],
    isNegative: false,
  },
  // Real focused module review
  {
    id: 'real_module_focused_review',
    description: 'Real production objective, focused on specific files with line counts.',
    userMessage: 'Review committed (v0.7.39..HEAD) changes in the coding task-engine and compaction modules — specifically:\n1. packages/coding/src/task-engine/runner-driven.ts — major refactor (159 line change)\n2. packages/coding/src/task-engine/_internal/round-boundary.ts — 200 line change\n3. packages/coding/src/runtime-middleware/_internal/managed-task/compaction.ts — 376 line change\n\nFocus on:\n- Compaction logic correctness: does microcompact preserve tool_use/tool_result pairing?\n- Round boundary: is the queued-followup predicate correct? Does it handle all verdict types?\n- runner-driven.ts: is the flow from round-boundary → compaction → followup correct?\n- Any off-by-one or missing edge cases in snapshot-aware triggers?\n\nReport findings as a structured list: [OK], [WARN], [ISSUE] per file.',
    preferredPullTools: ['module_context', 'changed_diff_bundle', 'changed_diff', 'process_context'],
    negativePreferred: [],
    isNegative: false,
  },
  // Real multi-package review (paste functionality)
  {
    id: 'real_multi_package_review',
    description: 'Real production objective, multi-package scope with security focus.',
    userMessage: '审查 packages/repl 和 packages/llm 中自 v0.7.39 以来的代码改动，重点检查：\n\npackages/repl:\n1. paste/ 目录下的所有新文件 — 图片粘贴功能，检查文件路径处理安全性、临时文件清理、编码问题\n2. StreamingContext.tsx — MessageQueue 作为单一数据源的改造，检查是否有状态不一致\n3. InkREPL.tsx — transcript rendering starvation 修复，检查 useDeferredValue 移除的影响\n\npackages/llm:\n1. providers/gemini-cli.ts — 新文件，检查 vision 注入是否有路径注入风险\n2. providers/registry.ts — multimodal flag 扩展，检查 provider 兼容性\n\n只做分析，不做改动。输出格式：按文件列出发现的问题，每个问题标注严重程度。',
    preferredPullTools: ['changed_diff_bundle', 'changed_scope', 'module_context'],
    negativePreferred: [],
    isNegative: false,
  },
  // NEGATIVE: single file lookup — expects read, not pull-tool
  {
    id: 'negative_single_file_lookup',
    description: 'Single-file targeted lookup — pull-tool over-trigger check.',
    userMessage: '请打开 packages/coding/src/types.ts 文件，告诉我 `KodaXOptions` 这个 interface 长什么样（字段、类型、注释）。不需要看其它文件，只要这一个文件的内容。',
    preferredPullTools: [],
    negativePreferred: ['read'],
    isNegative: true,
  },
  // NEGATIVE: exact string search — expects grep, not pull-tool
  {
    id: 'negative_exact_string_search',
    description: 'Byte-exact string search — pull-tool over-trigger check.',
    userMessage: '在整个 codebase 里搜索字面量字符串 "KODAX_HARNESS_V2"，列出每个出现位置（文件:行号）。我需要精确的 byte-level 匹配，不要语义近似的结果。',
    preferredPullTools: [],
    negativePreferred: ['grep'],
    isNegative: true,
  },
];

// ---------------------------------------------------------------------------
// Multi-syntax tool detection (anti-pattern 7 §4)
// ---------------------------------------------------------------------------

function extractFirstToolNameFromText(text: string): string | null {
  if (!text) return null;
  const candidates: Array<{ name: string; pos: number }> = [];
  const re1 = /(?:^|[\s\[\`"({,>])([a-z_][a-z_0-9]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re2 = /"name"\s*:\s*"([a-z_][a-z_0-9]*)"/g;
  while ((m = re2.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re3 = /<([a-z_][a-z_0-9]*)[\s>]/g;
  while ((m = re3.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const re4 = /\bname\s*[=:]\s*["']?([a-z_][a-z_0-9]*)["']?/g;
  while ((m = re4.exec(text)) !== null) candidates.push({ name: m[1], pos: m.index });
  const known = new Set<string>([
    ...PULL_TOOL_NAMES, 'read', 'grep', 'glob', 'bash', 'todo_update', 'dispatch_child_task', 'write', 'edit',
  ]);
  const filtered = candidates.filter((c) => known.has(c.name));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.pos - b.pos);
  return filtered[0].name;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const STAGE_LABEL = 'phase1-f1v2-f2-child-realobj-negcases-3variants-3runs';
const RUNS_PER_CELL = 3;
const PANEL_ALIASES = ['zhipu/glm51', 'kimi', 'mmx/m27', 'ark/glm51', 'ds/v4pro', 'ds/v4flash'] as const;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-child-v2');

describe('Eval Suite A: Repointel pull-tool adoption — CHILD (F1v2 + F2) with real production objectives', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {});
    return;
  }

  type Run = {
    runIndex: number;
    firstToolName: string | null;
    firstToolFromBinding: string | null;
    firstToolFromTextRegex: string | null;
    isPullTool: boolean;
    isExpectedNegativeTool: boolean;
    text: string;
    durationMs: number;
    error?: string;
  };
  type Cell = {
    caseId: string;
    isNegative: boolean;
    alias: string;
    variant: 'A_baseline' | 'B_F1v2' | 'C_F1v2_plus_F2';
    runs: Run[];
  };
  const overall: Cell[] = [];

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 30 * 60_000 },
      async () => {
        const cellRows: Cell[] = [];
        for (const alias of aliases) {
          for (const variant of ['A_baseline', 'B_F1v2', 'C_F1v2_plus_F2'] as const) {
            const systemPrompt =
              variant === 'A_baseline' ? SYSTEM_A_BASELINE
              : variant === 'B_F1v2' ? SYSTEM_B_F1V2
              : SYSTEM_C_F1V2_PLUS_F2;
            const runs: Run[] = [];
            for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
              try {
                const out = await runOneShot(alias, { systemPrompt, userMessage: c.userMessage, tools: TOOLS });
                const firstToolFromBinding = out.toolCalls[0]?.name ?? null;
                const firstToolFromTextRegex = extractFirstToolNameFromText(out.text);
                const firstToolName = firstToolFromBinding ?? firstToolFromTextRegex;
                const isPullTool = firstToolName !== null && PULL_TOOL_NAMES.has(firstToolName);
                const isExpectedNegativeTool = c.isNegative && firstToolName !== null
                  && c.negativePreferred.includes(firstToolName);
                runs.push({
                  runIndex, firstToolName, firstToolFromBinding, firstToolFromTextRegex,
                  isPullTool, isExpectedNegativeTool,
                  text: out.text, durationMs: out.durationMs,
                });
              } catch (err) {
                runs.push({
                  runIndex, firstToolName: null, firstToolFromBinding: null, firstToolFromTextRegex: null,
                  isPullTool: false, isExpectedNegativeTool: false, text: '', durationMs: 0,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            cellRows.push({ caseId: c.id, isNegative: c.isNegative, alias, variant, runs });
            overall.push(cellRows[cellRows.length - 1]);
          }
        }

        const lines: string[] = [`[suite-A][${c.id}]${c.isNegative ? ' [NEG]' : ''} preferred: ${c.isNegative ? c.negativePreferred.join(',') : c.preferredPullTools.join(',')}`];
        for (const alias of aliases) {
          const stats = (variant: Cell['variant']): { pullRate: number; negRightRate: number } => {
            const cell = cellRows.find((r) => r.alias === alias && r.variant === variant);
            if (!cell) return { pullRate: 0, negRightRate: 0 };
            const pullCount = cell.runs.filter((r) => r.isPullTool).length;
            const negRight = cell.runs.filter((r) => r.isExpectedNegativeTool).length;
            return { pullRate: pullCount / RUNS_PER_CELL, negRightRate: negRight / RUNS_PER_CELL };
          };
          const A = stats('A_baseline'), B = stats('B_F1v2'), C = stats('C_F1v2_plus_F2');
          if (c.isNegative) {
            lines.push(`  ${alias.padEnd(13)} pull%  A=${Math.round(A.pullRate*100)} B=${Math.round(B.pullRate*100)} C=${Math.round(C.pullRate*100)}  |  expected%  A=${Math.round(A.negRightRate*100)} B=${Math.round(B.negRightRate*100)} C=${Math.round(C.negRightRate*100)}`);
          } else {
            lines.push(`  ${alias.padEnd(13)} pull%  A=${Math.round(A.pullRate*100)} B=${Math.round(B.pullRate*100)} C=${Math.round(C.pullRate*100)}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify({
          case: c.id, stage: STAGE_LABEL, userMessage: c.userMessage,
          isNegative: c.isNegative, preferredPullTools: c.preferredPullTools, negativePreferred: c.negativePreferred,
          cells: cellRows.map((row) => ({ alias: row.alias, variant: row.variant, runs: row.runs })),
        }, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }

  it('suite verdict (PRELIMINARY — regex only; self-judge audit MUST run after)', () => {
    type Pooled = { pullRate: number; negRightRate: number; n: number };
    function poolByVariantAndType(variant: Cell['variant'], isNegative: boolean): Pooled {
      let totalRuns = 0, pullHits = 0, negRightHits = 0;
      for (const cell of overall) {
        if (cell.variant !== variant || cell.isNegative !== isNegative) continue;
        for (const r of cell.runs) {
          totalRuns++;
          if (r.isPullTool) pullHits++;
          if (r.isExpectedNegativeTool) negRightHits++;
        }
      }
      return {
        pullRate: totalRuns > 0 ? pullHits / totalRuns : 0,
        negRightRate: totalRuns > 0 ? negRightHits / totalRuns : 0,
        n: totalRuns,
      };
    }
    const posA = poolByVariantAndType('A_baseline', false);
    const posB = poolByVariantAndType('B_F1v2', false);
    const posC = poolByVariantAndType('C_F1v2_plus_F2', false);
    const negA = poolByVariantAndType('A_baseline', true);
    const negB = poolByVariantAndType('B_F1v2', true);
    const negC = poolByVariantAndType('C_F1v2_plus_F2', true);

    // Per-alias monotonicity check (for ≥4 aliases lift A<B on positives)
    const perAliasPosLift = aliases.map((alias) => {
      const aliasVar = (variant: Cell['variant']) => {
        let runs = 0, hits = 0;
        for (const cell of overall) {
          if (cell.alias !== alias || cell.variant !== variant || cell.isNegative) continue;
          for (const r of cell.runs) { runs++; if (r.isPullTool) hits++; }
        }
        return runs > 0 ? hits / runs : 0;
      };
      return { alias, A: aliasVar('A_baseline'), B: aliasVar('B_F1v2'), C: aliasVar('C_F1v2_plus_F2') };
    });
    const aliasesMonotonicAB = perAliasPosLift.filter((a) => a.B > a.A).length;

    let f1v2Verdict: 'SHIP_F1V2_PRELIM' | 'F1V2_INSUFFICIENT' | 'F1V2_NEGATIVE_REGRESSION';
    if (negB.pullRate > 0.20) f1v2Verdict = 'F1V2_NEGATIVE_REGRESSION';
    else if (posB.pullRate >= posA.pullRate + 0.25 && aliasesMonotonicAB >= 4) f1v2Verdict = 'SHIP_F1V2_PRELIM';
    else f1v2Verdict = 'F1V2_INSUFFICIENT';

    let f2Verdict: 'SHIP_F2_ON_TOP_PRELIM' | 'F2_INSUFFICIENT' | 'F2_NEGATIVE_REGRESSION';
    if (negC.pullRate > 0.25) f2Verdict = 'F2_NEGATIVE_REGRESSION';
    else if (posC.pullRate >= posB.pullRate + 0.10) f2Verdict = 'SHIP_F2_ON_TOP_PRELIM';
    else f2Verdict = 'F2_INSUFFICIENT';

    const summaryDumpPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(summaryDumpPath, JSON.stringify({
      stage: STAGE_LABEL, aliases_run: aliases,
      positives: { A: posA, B: posB, C: posC },
      negatives: { A: negA, B: negB, C: negC },
      perAliasPositiveLift: perAliasPosLift,
      aliasesMonotonicAB,
      f1v2Verdict, f2Verdict,
      caveat: 'PRELIMINARY regex-based verdicts. Self-judge audit pass REQUIRED — see audit script.',
      decisionMatrix: {
        SHIP_F1V2_PRELIM: 'pos_pullRate(B) >= pos_pullRate(A) + 25pp AND >=4 aliases show A<B AND neg_pullRate(B) <= 20%',
        SHIP_F2_ON_TOP_PRELIM: 'pos_pullRate(C) >= pos_pullRate(B) + 10pp AND neg_pullRate(C) <= 25%',
        F1V2_NEGATIVE_REGRESSION: 'B over-triggers pull-tool on negative cases (>20%)',
        F2_NEGATIVE_REGRESSION: 'C over-triggers pull-tool on negative cases (>25%)',
      },
    }, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE A PRELIMINARY VERDICT ===`);
    // eslint-disable-next-line no-console
    console.log(`F1v2: ${f1v2Verdict} | F2: ${f2Verdict}`);
    // eslint-disable-next-line no-console
    console.log(`Positives pooled (n=${posA.n}): A=${Math.round(posA.pullRate*100)}% B=${Math.round(posB.pullRate*100)}% C=${Math.round(posC.pullRate*100)}%`);
    // eslint-disable-next-line no-console
    console.log(`Negatives pooled (n=${negA.n}): A=${Math.round(negA.pullRate*100)}% B=${Math.round(negB.pullRate*100)}% C=${Math.round(negC.pullRate*100)}% (lower is better — pull-tool over-trigger)`);
    // eslint-disable-next-line no-console
    console.log(`Aliases with A<B (positive monotonic): ${aliasesMonotonicAB}/${aliases.length}`);
    for (const a of perAliasPosLift) {
      // eslint-disable-next-line no-console
      console.log(`  ${a.alias.padEnd(13)} pos pull% A=${Math.round(a.A*100)} B=${Math.round(a.B*100)} C=${Math.round(a.C*100)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n>>> RUN self-judge audit AFTER this eval. <<<`);
    // eslint-disable-next-line no-console
    console.log(`suite summary: ${summaryDumpPath}`);
  });
});
