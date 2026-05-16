/**
 * Eval Suite 0 — Worker dispatch objective quality (F0a + F0b validation).
 *
 * ## Purpose
 *
 * Layer 1 production scan (2026-05-15) of 4 post-F7 review sessions found
 * 17 real `dispatch_child_task` invocations. 3 of 17 (18%) contained
 * explicit bash directives in the objective text ("使用 git diff ..."),
 * and 0 of 17 mentioned any pull-tool. Hypothesis: Worker hand-feeds
 * exploration commands to children, bypassing whatever pull-tool teaching
 * the child has (or could have via F1). The dispatch objective text is a
 * user-message-equivalent input that overrides child-prompt teaching.
 *
 * F0a: teach Worker NOT to hand-feed bash commands in dispatch objectives.
 * F0b: teach Worker to recommend pull-tools in dispatch objectives (when
 *      relevant — qualifier added per design review to avoid bloat).
 *
 * ## Why not Layer 1 (EVAL_GUIDELINES checklist item 1)
 *
 * Layer 1 ALREADY measured the BASELINE problem: 18% bash directive rate,
 * 0% pull-tool mention rate across 17 production dispatches. What Layer 1
 * CANNOT answer is "does adding F0a/F0b change Worker behavior in a way
 * that holds across the multi-alias panel?" That requires LLM probe.
 *
 * ## Method — Layer 2 single-turn probe
 *
 * Input: Worker system prompt (+/- F0a +/- F0b) + a real user review request.
 * Output: parse the assistant response; extract `dispatch_child_task`
 * tool_use entries; analyze `input.objective` for:
 *   - bash-directive density (regex pre-verdict + mandatory LLM judge)
 *   - pull-tool recommendation density + correctness (regex + LLM judge)
 *
 * ## Variants (3 — narrow to avoid 反模式 5 large-scale iteration)
 *
 * - `A_baseline`: current Worker prompt (FEATURE_161 F7 included)
 * - `B_F0a`: + F0a section
 * - `C_F0a_plus_F0b`: B + F0b section
 *
 * ## Cases — 5 explicit fan-out requests (REDESIGN v2 2026-05-16)
 *
 * Prior version (v1) used open-ended review prompts. Single-turn probe
 * couldn't trigger dispatch — 90/90 runs returned text-only or direct
 * tool execution, never invoking `dispatch_child_task`. F0a/F0b are
 * about objective TEXT QUALITY conditional on dispatch happening —
 * the eval must guarantee dispatch occurs to test the axis at all.
 *
 * Fix: user message explicitly tells the Worker to `dispatch_child_task`
 * fan-out N parallel children. The model's choice-of-fan-out is a
 * non-trivial decision in production multi-turn but is NOT what F0a/F0b
 * target. Treating fan-out as a fixed precondition matches the canonical
 * Layer 2 template "INPUT: system prompt + canned history + user task".
 *
 * Cases are designed so each invites 3-5 children with distinct scopes
 * (matching production trace patterns from sessions 20260514_181503,
 * 20260515_103836/132437/162035 — observed fan-out shapes).
 *
 * ## Sample size justification (EVAL_GUIDELINES checklist item 5)
 *
 * 6 aliases × 3 variants × 3 runs × 5 cases = 270 calls.
 * Per-alias-per-variant n = 15 runs has weak statistical power
 * (~40% to detect 15pp delta). Therefore the suite verdict's
 * PRIMARY signal is the POOLED rate across all 6 aliases per variant
 * (n ≈ 90), which has ~85% power to detect 15pp. Per-alias rates are
 * SECONDARY signals — checked for monotonicity and outlier detection
 * only, not for ship/no-ship gating.
 *
 * ## Cost budget (EVAL_GUIDELINES checklist item 7)
 *
 * 270 calls × $0.01–0.10 per Chinese-coding-plan call = $3–27.
 * Worth one prompt-change ship/reject decision (EVAL_GUIDELINES
 * "$5 实验换一条 production prompt 改动: 值").
 *
 * ## Pre-registered decision matrix (locked before any LLM call)
 *
 * PRIMARY signals (pooled across panel, n=90 per variant):
 * - SHIP_F0a:     pooled_bash(B) <= 5% AND pooled_bash(A) >= 10% AND
 *                 pooled_dispatch_rate(B) - pooled_dispatch_rate(A) <= 15pp.
 * - SHIP_F0b:     pooled_pull_correct(C) >= 50% AND
 *                 pooled_bash(C) <= 5% (no F0a regression).
 * - F0a_REJECT:   pooled_dispatch_rate(B) - pooled_dispatch_rate(A) > 20pp
 *                 (F0a accidentally suppressed dispatch).
 *
 * SECONDARY signals (per-alias, for outlier detection):
 * - Flag any alias where bash_B > bash_A + 10pp (anti-correlation outlier).
 * - Flag any alias where C bash rate > B bash rate + 10pp (F0b regresses F0a).
 *
 * ## LLM judge plan (per EVAL_GUIDELINES anti-pattern 7 §3, MANDATORY)
 *
 * The regex `hasBashDirective` is acknowledged to have false negatives
 * (Chinese subject-after-verb structures, JSON/XML wrapped commands,
 * indirect phrasing). Therefore:
 *
 * 1. The suite verdict computed here is a PRELIMINARY REGEX VERDICT.
 * 2. After the eval runs and raw dumps land, an orchestrator self-judge
 *    pass MUST read every dispatched objective and independently classify
 *    (bash_directive: yes/no, pull_tool_correct_mention: yes/no, reason).
 * 3. Self-judge audit writes `_self-judge-audit.json` and a final verdict
 *    file reconciling regex + judge.
 * 4. If regex/judge disagreement on bash classification > 10% of cases,
 *    the entire suite is invalid and must be rerun (per anti-pattern 7 §3).
 *
 * Audit harness reference: `tests/repointel-worker-dispatch-objective.audit.mjs`
 * (created alongside this file; orchestrator runs after eval completes).
 *
 * ## Run
 *
 *   npm run test:eval -- repointel-worker-dispatch-objective
 *   node tests/repointel-worker-dispatch-objective.audit.mjs  # post-run self-judge
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

const TOOLS: readonly KodaXToolDefinition[] = [
  { name: 'repo_overview', description: 'Summarize the repository structure, key areas, entry hints, and stored repo-intelligence snapshot.', input_schema: { type: 'object', properties: { target_path: { type: 'string' } } } },
  { name: 'changed_scope', description: 'Analyze which files, areas, and categories are touched by the current git diff or a comparison range.', input_schema: { type: 'object', properties: { target_path: { type: 'string' }, scope: { type: 'string' }, base_ref: { type: 'string' } } } },
  { name: 'changed_diff', description: 'Read a paged diff slice for a specific changed file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'changed_diff_bundle', description: 'Read diff slices for multiple changed files in one call. Prefer this for large reviews.', input_schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
  { name: 'module_context', description: 'Return a module capsule with dependencies, entry files, symbols, tests, docs.', input_schema: { type: 'object', properties: { module: { type: 'string' }, target_path: { type: 'string' } } } },
  { name: 'symbol_context', description: 'Return definition, callers/callees, imports for a repository symbol.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'process_context', description: 'Return a static execution capsule for an entry symbol or module.', input_schema: { type: 'object', properties: { entry: { type: 'string' } } } },
  { name: 'impact_estimate', description: 'Estimate blast radius for a symbol, path, or module.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  {
    name: 'dispatch_child_task',
    description: 'Dispatch a focused investigation/edit to a child agent.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        objective: { type: 'string' },
        scope_summary: { type: 'string' },
        readOnly: { type: 'boolean' },
        model_hint: { type: 'string', enum: ['fast', 'balanced', 'deep'] },
      },
      required: ['id', 'objective'],
    },
  },
  { name: 'todo_update', description: 'Init / mutate / complete plan items.', input_schema: { type: 'object', properties: { op: { type: 'string' } } } },
  { name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'grep', description: 'Search file contents.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'glob', description: 'File pattern matching.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'bash', description: 'Execute a bash command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const PULL_TOOL_NAMES = new Set(['repo_overview', 'changed_scope', 'changed_diff', 'changed_diff_bundle', 'module_context', 'symbol_context', 'process_context', 'impact_estimate']);

// ---------------------------------------------------------------------------
// Worker system prompt — truncated faithful representation
// ---------------------------------------------------------------------------

const WORKER_BASE = [
  'You are the Worker — KodaX\'s single primary agent for this task.',
  '',
  'Routing decision summary:',
  '- Primary task: review',
  '- Work intent: review/explain',
  '- Risk: low',
  '- Complexity: moderate',
  '',
  'PLAN-FIRST CONTRACT:',
  '- Non-trivial tasks (>=2 distinct execution steps OR touching >=2 files / areas) -> your FIRST tool call MUST be `todo_update` with the full plan.',
  '- Trivial tasks -> answer or execute directly.',
  '',
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model):',
  '- RULE A — read-only fan-out: when you need >=3 independent investigations, launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: dispatch as a child if >=45s.',
  '- IDLE-YIELD: after dispatch, end your turn with ONE short status sentence. The runner resumes you when a child completes.',
  '',
  'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — compact module capsule. Replaces 5-10 `read`/`grep` calls.',
  '- `symbol_context(symbol)` — definition + callers/callees + imports.',
  '- `impact_estimate(symbol|module|path)` — blast-radius. Use BEFORE rename/refactor.',
  '- `process_context(entry|module)` — static execution trace.',
  '- `repo_overview()` — workspace-wide structure snapshot.',
  '- `changed_scope()` — list of changed files with area/category labels.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files. Use for review tasks instead of multiple `bash git diff` calls.',
  '- `changed_diff(path)` — paged diff for one file.',
  '',
  'WHEN TO PREFER REPO-INTEL TOOLS:',
  '- About to read 3+ files in the same module -> call `module_context` first.',
  '- About to review a multi-file change -> call `changed_scope` + `changed_diff_bundle` instead of `git diff` + N reads.',
  '',
  'Repo context: TypeScript monorepo at `C:/Works/GitWorks/KodaX-author/KodaX`.',
].join('\n');

// F0a — anti hand-feeding bash. Phrased as constraint (not absolute prohibition)
// to reduce chain-of-thought leak risk per review feedback.
const F0A_SECTION = [
  '',
  'DISPATCH OBJECTIVE QUALITY (F0a):',
  '- When writing a `dispatch_child_task` objective, prefer stating the goal abstractly. Avoid hand-feeding specific bash commands ("use `git diff X`", "run `git log`") — the child picks its own tools and hand-feeding bash bypasses the child\'s pull-tool guidance.',
  '- If you need to convey a specific git revision or scope (e.g., v0.7.39..HEAD), state it as data ("scope: v0.7.39..HEAD") rather than a command directive.',
].join('\n');

// F0b — qualified recommendation. "when relevant" qualifier per review feedback
// to avoid objective bloat on trivial tasks.
const F0B_SECTION = [
  '',
  'DISPATCH OBJECTIVE GUIDANCE (F0b):',
  '- WHEN RELEVANT (review / change-audit / module-exploration objectives only — not trivial probes), briefly note the recommended pull-tool family in the objective. Examples:',
  '  - Review tasks: "scope via `changed_scope`, then drill specific files with `changed_diff_bundle`"',
  '  - Module exploration: "use `module_context` to map the module surface before reading individual files"',
  '  - Symbol tracing: "start with `symbol_context` to find callers"',
  '  - Process flow / execution trace: "use `process_context` to map the flow before reading runner files"',
  '  - Rename / refactor impact: "use `impact_estimate` to estimate blast radius first"',
].join('\n');

const SYSTEM_A_BASELINE = WORKER_BASE;
const SYSTEM_B_F0A = WORKER_BASE + F0A_SECTION;
const SYSTEM_C_F0A_PLUS_F0B = WORKER_BASE + F0A_SECTION + F0B_SECTION;

// ---------------------------------------------------------------------------
// Cases — 5 review/exploration scenarios
// ---------------------------------------------------------------------------

interface CaseSpec {
  readonly id: string;
  readonly userMessage: string;
  readonly description: string;
  readonly preferredPullToolsForChild: readonly string[];
}

const CASES: readonly CaseSpec[] = [
  {
    id: 'fanout_unreleased_review',
    description: 'Forced fan-out: 5 parallel children, one per package, review v0.7.39..HEAD.',
    userMessage: '我在准备 v0.7.41 release 的最终 review。请用 dispatch_child_task fan-out 5 个并行 readOnly child，每个 child 负责一个 package 的 v0.7.39..HEAD 改动 review：packages/coding, packages/agent, packages/repl, packages/llm, packages/mcp。每个 child 自己挑工具完成 review，最后给每 child 一份独立的 [OK]/[WARN]/[ISSUE] 报告。fan-out 5 个 dispatch_child_task 调用，不要自己跑 review。',
    preferredPullToolsForChild: ['changed_scope', 'changed_diff_bundle', 'changed_diff'],
  },
  {
    id: 'fanout_module_files',
    description: 'Forced fan-out: 3 parallel children, one per file in MessageQueue module.',
    userMessage: '我要 review packages/agent/src/messaging/ 这三个新文件：queue.ts, types.ts, queue.test.ts。请用 dispatch_child_task fan-out 3 个并行 readOnly child，每个负责一个文件的深度 review（竞争条件、filter 语义、API surface、test 覆盖）。请发起 3 个 dispatch_child_task 调用，不要自己读文件。',
    preferredPullToolsForChild: ['module_context', 'changed_diff_bundle', 'changed_diff'],
  },
  {
    id: 'fanout_cross_version',
    description: 'Forced fan-out: 4 parallel children, one per area, compare with v0.7.39.',
    userMessage: '0.7.41 release 前我担心功能退化。请用 dispatch_child_task fan-out 4 个并行 readOnly child 对比当前 HEAD 与 v0.7.39 的差异，每个 child 负责一个领域：(1) packages/coding 任务引擎层, (2) packages/agent 消息层, (3) packages/repl UI 层, (4) packages/llm provider 层。每个 child 自己找差异并报告功能退化风险。发起 4 个 dispatch_child_task。',
    preferredPullToolsForChild: ['changed_scope', 'changed_diff_bundle', 'impact_estimate'],
  },
  {
    id: 'fanout_rename_impact',
    description: 'Forced fan-out: 3 parallel children scope a rename impact in different dimensions.',
    userMessage: '我打算把 `dispatch_child_task` 工具重命名为 `dispatch_worker_task`。在动手前请用 dispatch_child_task fan-out 3 个并行 readOnly child 分析影响范围：(1) production 代码调用点（哪些模块要改）, (2) 测试代码（哪些测试要改 + child name 在 test 描述里的出现）, (3) 文档（docs/ + AGENTS.md + CLAUDE.md + worker-role-prompt 等 prompt 文本）。每个 child 输出具体的 file:line 清单。',
    preferredPullToolsForChild: ['impact_estimate', 'symbol_context'],
  },
  {
    id: 'fanout_process_trace',
    description: 'Forced fan-out: 3 parallel children trace different entry points.',
    userMessage: '我要加一个新的 runtime middleware step。在动手前请用 dispatch_child_task fan-out 3 个并行 readOnly child trace 3 条独立执行链：(1) 用户 prompt 从 REPL InkREPL.tsx 输入到 Worker 第一个 tool call, (2) Worker dispatch_child_task 从 worker turn 到 child runner-driven 启动, (3) tool_result 从 tool handler 完成到 assistant 看到结果。每个 child 列出主要模块 + 函数 + file:line。',
    preferredPullToolsForChild: ['process_context', 'module_context'],
  },
];

// ---------------------------------------------------------------------------
// Extract dispatch objectives — multi-syntax per anti-pattern 7 §4
// ---------------------------------------------------------------------------

interface DispatchObjective {
  readonly source: 'binding' | 'text-json' | 'text-xml';
  readonly objective: string;
}

function isObjectiveContainer(value: unknown): value is { objective: string } {
  return typeof value === 'object' && value !== null
    && 'objective' in value
    && typeof (value as { objective: unknown }).objective === 'string';
}

function extractDispatchObjectives(
  toolCalls: readonly { name: string; input: unknown }[],
  rawText: string,
): DispatchObjective[] {
  const out: DispatchObjective[] = [];
  for (const c of toolCalls) {
    if (c.name !== 'dispatch_child_task') continue;
    if (isObjectiveContainer(c.input)) {
      out.push({ source: 'binding', objective: c.input.objective });
    } else if (typeof c.input === 'string') {
      // Some providers stringify the input
      try {
        const parsed: unknown = JSON.parse(c.input);
        if (isObjectiveContainer(parsed)) {
          out.push({ source: 'binding', objective: parsed.objective });
        }
      } catch { /* ignore */ }
    }
  }
  if (out.length > 0) return out;

  // Text fallback — JSON style
  const jsonRe = /"name"\s*:\s*"dispatch_child_task"[\s\S]{0,800}?"objective"\s*:\s*"((?:[^"\\]|\\.){10,2000})"/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRe.exec(rawText)) !== null) {
    out.push({ source: 'text-json', objective: m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') });
  }
  // Text fallback — XML style
  const xmlRe = /<dispatch_child_task[\s\S]{0,500}?<objective[^>]*>([\s\S]{10,2000}?)<\/objective>/g;
  while ((m = xmlRe.exec(rawText)) !== null) {
    out.push({ source: 'text-xml', objective: m[1] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regex pre-verdicts — INTENTIONALLY conservative. Self-judge audit MUST run
// after eval to catch false negatives. Suite verdict is "preliminary regex
// verdict" only.
// ---------------------------------------------------------------------------

function hasBashDirective(objective: string): boolean {
  // Cover multiple syntactic patterns. Still conservative — self-judge
  // expected to catch indirect cases per anti-pattern 7 §3.
  const patterns: RegExp[] = [
    // Imperative verb prefix: "use git diff", "run git log", "执行 git X"
    /(?:使用|use|run|execute|执行|跑|invoke|call)\s*[`"']?git\s+(?:diff|log|show|status|tag|branch|cherry-pick|rebase)\b/i,
    // Through-construction: "通过 git diff 来"
    /通过\s*[`"']?git\s+(?:diff|log|show)\b/i,
    // Reverse Chinese: "可以让 child 跑 git diff"
    /(?:跑|执行|输入)\s*[`"']?git\s+(?:diff|log|show)\b/i,
    // Bare backticked command in instruction context
    /[`'"](git\s+(?:diff|log|show)(?:\s+[\w@\-\^.\/~]+){1,5})[`'"]/i,
    // Command as code block / inline-code reference with imperative context
    /(?:command|命令|指令)[:：]?\s*[`'"]?git\s+(?:diff|log|show)\b/i,
  ];
  return patterns.some((re) => re.test(objective));
}

function mentionedPullTools(objective: string): string[] {
  const found: string[] = [];
  for (const name of PULL_TOOL_NAMES) {
    // Tolerate backticks, XML tags, brackets. Use non-capturing alternation
    // outside the char class — `\b` INSIDE `[...]` is a literal backspace
    // (U+0008), not a word boundary.
    const re = new RegExp(`(?:^|[<\`(\\s'"])${name}\\b`);
    if (re.test(objective)) found.push(name);
  }
  return found;
}

function hasPullToolCorrectMention(objective: string, preferredForCase: readonly string[]): boolean {
  const mentioned = mentionedPullTools(objective);
  if (mentioned.length === 0) return false;
  // Correctness: at least one mentioned pull-tool is in the case's preferred set.
  // This penalizes Worker hallucinating an irrelevant pull-tool just to satisfy F0b.
  return mentioned.some((t) => preferredForCase.includes(t));
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const STAGE_LABEL = 'phase2-f0-worker-dispatch-objective-fanout-redesign-3variants-3runs';
const RUNS_PER_CELL = 3;
const PANEL_ALIASES = ['zhipu/glm51', 'kimi', 'mmx/m27', 'ark/glm51', 'ds/v4pro', 'ds/v4flash'] as const;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-worker-dispatch-objective');

describe('Eval Suite 0: Worker dispatch objective quality (F0a + F0b)', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {});
    return;
  }

  type Run = {
    runIndex: number;
    dispatchObjectives: DispatchObjective[];
    bashDirectiveCount: number;
    pullCorrectMentionCount: number;
    pullAnyMentionCount: number;
    didDispatch: boolean;
    durationMs: number;
    text: string;
    error?: string;
  };
  type Cell = {
    caseId: string;
    alias: string;
    variant: 'A_baseline' | 'B_F0a' | 'C_F0a_plus_F0b';
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
          for (const variant of ['A_baseline', 'B_F0a', 'C_F0a_plus_F0b'] as const) {
            const systemPrompt =
              variant === 'A_baseline' ? SYSTEM_A_BASELINE
              : variant === 'B_F0a' ? SYSTEM_B_F0A
              : SYSTEM_C_F0A_PLUS_F0B;
            const runs: Run[] = [];
            for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
              try {
                const out = await runOneShot(alias, { systemPrompt, userMessage: c.userMessage, tools: TOOLS });
                const objectives = extractDispatchObjectives(out.toolCalls, out.text);
                const bashCount = objectives.filter((o) => hasBashDirective(o.objective)).length;
                const pullCorrect = objectives.filter((o) => hasPullToolCorrectMention(o.objective, c.preferredPullToolsForChild)).length;
                const pullAny = objectives.filter((o) => mentionedPullTools(o.objective).length > 0).length;
                runs.push({
                  runIndex,
                  dispatchObjectives: objectives,
                  bashDirectiveCount: bashCount,
                  pullCorrectMentionCount: pullCorrect,
                  pullAnyMentionCount: pullAny,
                  didDispatch: objectives.length > 0,
                  durationMs: out.durationMs,
                  text: out.text,
                });
              } catch (err) {
                runs.push({
                  runIndex, dispatchObjectives: [], bashDirectiveCount: 0,
                  pullCorrectMentionCount: 0, pullAnyMentionCount: 0,
                  didDispatch: false, durationMs: 0, text: '',
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            cellRows.push({ caseId: c.id, alias, variant, runs });
            overall.push(cellRows[cellRows.length - 1]);
          }
        }
        // Console summary
        const lines: string[] = [`[suite-0][${c.id}] preferredPullTools: ${c.preferredPullToolsForChild.join(', ')}`];
        for (const alias of aliases) {
          const stats = (variant: Cell['variant']): { bash: number; pullCorrect: number; disp: number; n: number } => {
            const cell = cellRows.find((r) => r.alias === alias && r.variant === variant);
            if (!cell) return { bash: 0, pullCorrect: 0, disp: 0, n: 0 };
            let totDisp = 0, totBash = 0, totPullCorrect = 0, runsWithDisp = 0;
            for (const r of cell.runs) {
              totDisp += r.dispatchObjectives.length;
              totBash += r.bashDirectiveCount;
              totPullCorrect += r.pullCorrectMentionCount;
              if (r.didDispatch) runsWithDisp++;
            }
            return {
              bash: totDisp > 0 ? totBash / totDisp : 0,
              pullCorrect: totDisp > 0 ? totPullCorrect / totDisp : 0,
              disp: runsWithDisp / RUNS_PER_CELL,
              n: totDisp,
            };
          };
          const A = stats('A_baseline'), B = stats('B_F0a'), C = stats('C_F0a_plus_F0b');
          lines.push(`  ${alias.padEnd(13)} bash%  A=${Math.round(A.bash*100)} B=${Math.round(B.bash*100)} C=${Math.round(C.bash*100)} | pullCorrect%  A=${Math.round(A.pullCorrect*100)} B=${Math.round(B.pullCorrect*100)} C=${Math.round(C.pullCorrect*100)} | disp%  A=${Math.round(A.disp*100)} B=${Math.round(B.disp*100)} C=${Math.round(C.disp*100)}`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify({
          case: c.id, stage: STAGE_LABEL, userMessage: c.userMessage,
          preferredPullToolsForChild: c.preferredPullToolsForChild,
          cells: cellRows.map((row) => ({
            alias: row.alias, variant: row.variant,
            runs: row.runs,
          })),
        }, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }

  it('suite verdict (PRELIMINARY — regex only; self-judge audit MUST run after)', () => {
    // POOLED across panel — primary statistical signal (n ~= 90 per variant).
    type PooledMetrics = {
      totDispatches: number;
      bashRate: number;
      pullCorrectRate: number;
      pullAnyRate: number;
      runsWithDispatch: number;
      totalRuns: number;
      dispatchRate: number;
      avgDurationMs: number;
    };
    function pool(variant: Cell['variant']): PooledMetrics {
      let totDisp = 0, totBash = 0, totPullCorrect = 0, totPullAny = 0;
      let runsWithDisp = 0, totalRuns = 0, totalDuration = 0;
      for (const cell of overall) {
        if (cell.variant !== variant) continue;
        for (const r of cell.runs) {
          totalRuns++;
          totalDuration += r.durationMs;
          totDisp += r.dispatchObjectives.length;
          totBash += r.bashDirectiveCount;
          totPullCorrect += r.pullCorrectMentionCount;
          totPullAny += r.pullAnyMentionCount;
          if (r.didDispatch) runsWithDisp++;
        }
      }
      return {
        totDispatches: totDisp,
        bashRate: totDisp > 0 ? totBash / totDisp : 0,
        pullCorrectRate: totDisp > 0 ? totPullCorrect / totDisp : 0,
        pullAnyRate: totDisp > 0 ? totPullAny / totDisp : 0,
        runsWithDispatch: runsWithDisp,
        totalRuns,
        dispatchRate: totalRuns > 0 ? runsWithDisp / totalRuns : 0,
        avgDurationMs: totalRuns > 0 ? totalDuration / totalRuns : 0,
      };
    }
    const A = pool('A_baseline'), B = pool('B_F0a'), C = pool('C_F0a_plus_F0b');

    // PRIMARY F0a verdict (pooled, regex pre-verdict):
    // SHIP_F0a: B bashRate <=5% AND A bashRate >=10% AND dispatch rate didn't collapse
    let f0aVerdict: 'SHIP_F0A_PRELIM' | 'F0A_INSUFFICIENT' | 'F0A_BASELINE_LOW' | 'F0A_REJECT';
    if ((B.dispatchRate - A.dispatchRate) > 0.20) f0aVerdict = 'F0A_REJECT';
    else if (A.bashRate < 0.10) f0aVerdict = 'F0A_BASELINE_LOW';
    else if (B.bashRate <= 0.05 && (B.dispatchRate - A.dispatchRate) <= 0.15) f0aVerdict = 'SHIP_F0A_PRELIM';
    else f0aVerdict = 'F0A_INSUFFICIENT';

    // PRIMARY F0b verdict (pooled, regex pre-verdict):
    // SHIP_F0b: C pullCorrectRate >=50% AND C bashRate <=5% (no F0a regression).
    let f0bVerdict: 'SHIP_F0B_PRELIM' | 'F0B_INSUFFICIENT' | 'F0B_REGRESSES_F0A';
    if (C.bashRate > B.bashRate + 0.10) f0bVerdict = 'F0B_REGRESSES_F0A';
    else if (C.pullCorrectRate >= 0.50 && C.bashRate <= 0.05) f0bVerdict = 'SHIP_F0B_PRELIM';
    else f0bVerdict = 'F0B_INSUFFICIENT';

    // SECONDARY signals — per-alias outlier flags
    type AliasFlags = { alias: string; bash_A: number; bash_B: number; bash_C: number; pull_C: number; antiCorrelation: boolean; f0bRegressesF0a: boolean };
    const perAliasFlags: AliasFlags[] = aliases.map((alias) => {
      const aliasPool = (variant: Cell['variant']): { bash: number; pullCorrect: number; n: number } => {
        let totDisp = 0, totBash = 0, totPullCorrect = 0;
        for (const cell of overall) {
          if (cell.alias !== alias || cell.variant !== variant) continue;
          for (const r of cell.runs) {
            totDisp += r.dispatchObjectives.length;
            totBash += r.bashDirectiveCount;
            totPullCorrect += r.pullCorrectMentionCount;
          }
        }
        return { bash: totDisp > 0 ? totBash / totDisp : 0, pullCorrect: totDisp > 0 ? totPullCorrect / totDisp : 0, n: totDisp };
      };
      const a = aliasPool('A_baseline'), b = aliasPool('B_F0a'), cc = aliasPool('C_F0a_plus_F0b');
      return {
        alias,
        bash_A: a.bash, bash_B: b.bash, bash_C: cc.bash, pull_C: cc.pullCorrect,
        antiCorrelation: b.bash > a.bash + 0.10,
        f0bRegressesF0a: cc.bash > b.bash + 0.10,
      };
    });

    const summaryDumpPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(summaryDumpPath, JSON.stringify({
      stage: STAGE_LABEL, aliases_run: aliases,
      pooled: { A_baseline: A, B_F0a: B, C_F0a_plus_F0b: C },
      perAliasFlags,
      f0aVerdict, f0bVerdict,
      caveat: 'These are PRELIMINARY regex-based verdicts. Final verdict requires self-judge audit pass (run repointel-worker-dispatch-objective.audit.mjs after this eval). If audit regex/judge disagreement > 10%, suite is invalid and must be rerun (EVAL_GUIDELINES anti-pattern 7 §3).',
      decisionMatrix: {
        SHIP_F0A_PRELIM: 'pooled_bash(B) <= 5% AND pooled_bash(A) >= 10% AND dispatch_rate_delta(B-A) <= 15pp',
        F0A_REJECT: 'pooled_dispatch_rate(B) - pooled_dispatch_rate(A) > 20pp',
        F0A_BASELINE_LOW: 'pooled_bash(A) < 10% — eval baseline too clean to test',
        SHIP_F0B_PRELIM: 'pooled_pullCorrect(C) >= 50% AND pooled_bash(C) <= 5%',
        F0B_REGRESSES_F0A: 'pooled_bash(C) > pooled_bash(B) + 10pp',
      },
    }, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE 0 PRELIMINARY VERDICT (regex-only) ===`);
    // eslint-disable-next-line no-console
    console.log(`F0a: ${f0aVerdict} | F0b: ${f0bVerdict}`);
    // eslint-disable-next-line no-console
    console.log(`Pooled metrics (n=${A.totalRuns} runs / ~${A.totDispatches} dispatches per variant):`);
    // eslint-disable-next-line no-console
    console.log(`  A bash=${Math.round(A.bashRate*100)}% pullCorrect=${Math.round(A.pullCorrectRate*100)}% disp=${Math.round(A.dispatchRate*100)}% avgMs=${Math.round(A.avgDurationMs)}`);
    // eslint-disable-next-line no-console
    console.log(`  B bash=${Math.round(B.bashRate*100)}% pullCorrect=${Math.round(B.pullCorrectRate*100)}% disp=${Math.round(B.dispatchRate*100)}% avgMs=${Math.round(B.avgDurationMs)}`);
    // eslint-disable-next-line no-console
    console.log(`  C bash=${Math.round(C.bashRate*100)}% pullCorrect=${Math.round(C.pullCorrectRate*100)}% disp=${Math.round(C.dispatchRate*100)}% avgMs=${Math.round(C.avgDurationMs)}`);
    // eslint-disable-next-line no-console
    console.log(`Per-alias outliers (antiCorrelation = bash_B > bash_A + 10pp, f0bRegress = bash_C > bash_B + 10pp):`);
    for (const f of perAliasFlags) {
      // eslint-disable-next-line no-console
      console.log(`  ${f.alias.padEnd(13)} bash A=${Math.round(f.bash_A*100)} B=${Math.round(f.bash_B*100)} C=${Math.round(f.bash_C*100)} pullCorrect C=${Math.round(f.pull_C*100)}  ${f.antiCorrelation ? '⚠ANTI-CORR' : ''} ${f.f0bRegressesF0a ? '⚠F0B-REGRESS' : ''}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n>>> RUN tests/repointel-worker-dispatch-objective.audit.mjs AFTER THIS EVAL for self-judge audit. <<<`);
    // eslint-disable-next-line no-console
    console.log(`suite summary: ${summaryDumpPath}`);
  });
});
