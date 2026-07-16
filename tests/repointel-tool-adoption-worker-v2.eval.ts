/**
 * Eval Suite B — Worker prompt F2 + F3 validation (review-task bash fallback fix).
 *
 * ## Purpose
 *
 * The existing F7 (FEATURE_161, shipped v0.7.41) added a REPO INTELLIGENCE
 * TOOLS section to the Worker prompt. Initial F7 eval
 * (`repointel-tool-adoption.eval.ts`, 2026-05-14) showed 4 of 6 aliases
 * lifted to ≥80% pull-tool first-tool rate on module-exploration tasks.
 *
 * However, Layer 1 production trace audit (2026-05-15, 5 post-F7 review
 * sessions) found Worker STILL falls back to `bash git diff` in non-dispatch
 * review paths (6 of 6 sessions had ≥1 `bash git diff` call before any
 * pull-tool — and 4 of 6 never called a pull-tool at all in the entire
 * review). F7 teaches that pull-tools exist; it does not teach a
 * preference RANKING for review tasks specifically. Worker still treats
 * `bash git diff` as the canonical "compare changes" affordance because
 * its training data does.
 *
 * F2 = Tool Preference Order section (3-tier ranking: pull-tools / read+grep+glob
 *   / bash). Generic — not review-specific.
 * F3 = Positive reframe for change-review specifically: "For change review,
 *   prefer changed_diff/changed_diff_bundle/changed_scope over bash. Bash
 *   git is for non-review ops (status, commit, tag, push)."
 *
 * ## Why not Layer 1
 *
 * Layer 1 measured the BASELINE problem (6/6 sessions had bash-git-diff
 * before pull-tool on review tasks). Layer 1 cannot predict whether
 * F2/F3 prompt additions move the needle without an LLM probe.
 *
 * ## Method — Layer 2 single-turn probe
 *
 * Input: Worker system prompt variant + a review/change-audit user message.
 * Output: assistant response's FIRST tool call. Pull-tool = SHIP signal.
 * Bash-git-diff = legacy failure mode. Read+grep = neutral fallback.
 *
 * Important: we want to measure FIRST TOOL (not first 3) because the
 * production failure mode is "first tool is bash git diff → reads
 * pour in → never circles back to pull-tools". The first tool sets the
 * exploration rhythm for the rest of the turn.
 *
 * ## Variants (3 — narrow per 反模式 5)
 *
 * - `A_F7_baseline`: current Worker prompt with F7 (shipped v0.7.41)
 * - `B_F2`: + Tool Preference Order section (generic 3-tier ranking)
 * - `C_F2_plus_F3`: B + change-review positive reframe
 *
 * ## Cases — 4 review (positive) + 2 negative
 *
 * Positive cases use real top-level user messages from production
 * sessions 20260514_181503, 20260515_103836, 20260515_132437,
 * 20260515_162035 (extracted via `c:/tmp/extract-real-objectives.mjs`).
 * These are the EXACT review requests where production Worker
 * fell to bash-git-diff.
 *
 * Negative cases test over-trigger:
 *  - `negative_status_check` — `git status` IS the right answer (bash OK)
 *  - `negative_recent_commits` — `git log` IS the right answer (bash OK)
 *
 * Why negative cases use bash-correctly: F3 specifically carves out
 * "non-review git ops (status, commit, tag, push)" — we MUST verify it
 * doesn't over-suppress legitimate bash.
 *
 * ## Sample size justification
 *
 * 6 aliases × 3 variants × 3 runs × 6 cases = 324 calls.
 * Pooled per variant: positives n=72, negatives n=36.
 * Per-alias-per-case n=3 (descriptive only — used for monotonicity check).
 *
 * ## Cost budget
 *
 * 324 calls × $0.01–0.10 = $3–32. Per EVAL_GUIDELINES "$5 实验换一条
 * production prompt 改动: 值" — worth one ship/reject decision.
 *
 * ## Pre-registered decision matrix (locked before LLM call)
 *
 * POSITIVE cases (4 cases, 72 runs per variant pooled):
 * - SHIP_F2_PRELIM:           pos_pullRate(B) >= pos_pullRate(A) + 20pp AND
 *                             pos_bashRate(B) <= pos_bashRate(A) - 15pp AND
 *                             ≥4 aliases monotonic A<B on pull-rate.
 * - SHIP_F3_ON_TOP_PRELIM:    pos_pullRate(C) >= pos_pullRate(B) + 10pp AND
 *                             pos_bashRate(C) <= pos_bashRate(B) - 5pp.
 *
 * NEGATIVE cases (2 cases, 36 runs per variant pooled):
 * - NEG_OK_F2:                neg_bashRate(B) >= 50%  (bash still allowed
 *                             for legitimate git status/log).
 * - NEG_OK_F3:                neg_bashRate(C) >= 50%  (F3 reframe MUST
 *                             carve out status/log/commit ops).
 * - F3_OVER_SUPPRESS_REJECT:  neg_bashRate(C) < 30%   (F3 wording broke
 *                             legitimate bash use → reject).
 *
 * ## LLM judge plan (mandatory)
 *
 * Self-judge audit post-run. Audit ≥1 regex-pass + ≥1 regex-fail per cell.
 * Multi-syntax tool detection (anti-pattern 7 §4) covers binding output +
 * 4 text-fallback patterns. Negative cases get per-run LLM judge to catch
 * verbose chain-of-thought false positives (e.g., model says
 * "I should use changed_scope here" but actually calls `bash git status`).
 *
 * Audit script: `tests/repointel-tool-adoption-worker-v2.audit.mjs`
 *
 * ## Run
 *
 *   npm run test:eval -- repointel-tool-adoption-worker-v2
 *   node tests/repointel-tool-adoption-worker-v2.audit.mjs  # post-run audit
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

// ---------------------------------------------------------------------------
// Tool surface (mirrors Suite 0 — Worker-equivalent surface)
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
const READ_GREP_GLOB = new Set(['read', 'grep', 'glob']);

// ---------------------------------------------------------------------------
// Worker prompt — A_F7_baseline mirrors current production
// ---------------------------------------------------------------------------

const WORKER_F7_BASELINE = [
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

// F2 — generic 3-tier tool preference order.
const F2_SECTION = [
  '',
  'TOOL PREFERENCE ORDER (FEATURE_162 — review/exploration rhythm):',
  '- Tier 1 (preferred for module-level work and change review): repo-intel pull-tools — `module_context`, `symbol_context`, `changed_scope`, `changed_diff_bundle`, `changed_diff`, `repo_overview`, `impact_estimate`, `process_context`.',
  '- Tier 2 (fallback for targeted file work): `read`, `grep`, `glob`.',
  '- Tier 3 (last resort for shell ops that have no first-class tool): `bash` — git status / commit / push / tag / npm test / build commands.',
  '- Within a tier, pick the MOST SPECIFIC tool. Do not over-broaden (don\'t call `repo_overview` when `module_context(target_path=X)` is what you need).',
].join('\n');

// F3 — positive reframe specifically for change-review.
const F3_SECTION = [
  '',
  'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_162 — review-specific):',
  '- For ANY task framed as "review", "audit", "compare changes", "check diff", or "what changed since X": your first scope-acquisition tool MUST be `changed_scope` (one call), followed by `changed_diff_bundle(paths[])` for the files you need to read.',
  '- Do NOT use `bash git diff ...` for change review — that pattern reads opaque text the repo-intelligence tools already structured for you.',
  '- `bash git ...` is reserved for NON-review git ops: status, commit, tag, push, log of unrelated history, branch operations.',
].join('\n');

const SYSTEM_A_BASELINE = WORKER_F7_BASELINE;
const SYSTEM_B_F2 = WORKER_F7_BASELINE + F2_SECTION;
const SYSTEM_C_F2_PLUS_F3 = WORKER_F7_BASELINE + F2_SECTION + F3_SECTION;

// ---------------------------------------------------------------------------
// Cases — 4 real production review requests + 2 negative (legitimate bash)
// ---------------------------------------------------------------------------

// Tool_use/tool_result block types (subset of KodaXContentBlock).
type PriorTextBlock = { readonly type: 'text'; readonly text: string };
type PriorToolUseBlock = { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> };
type PriorToolResultBlock = { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

type PriorMessage =
  | { readonly role: 'user' | 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: ReadonlyArray<PriorTextBlock | PriorToolUseBlock> }
  | { readonly role: 'user'; readonly content: ReadonlyArray<PriorToolResultBlock> };

interface CaseSpec {
  readonly id: string;
  readonly description: string;
  readonly userMessage: string;
  // v2 redesign 2026-05-16: positive cases inject plan-completed history with
  // REAL todo_update tool_use + tool_result blocks (pilot v1 with text-only
  // history failed — zhipu re-issued todo_update because the plan wasn't
  // "actually" in the system). Plan items list STEP NAMES only, never tool
  // names, to avoid F2/F3 signal contamination. Negative cases leave this
  // empty (trivial tasks shouldn't plan).
  readonly priorMessages: ReadonlyArray<PriorMessage>;
  readonly preferredFirstTools: readonly string[];
  readonly isNegative: boolean;
  readonly negativeExpectedTools: readonly string[];
}

// Helper: build plan-completed prior history with real tool_use/tool_result.
function makePlanCompletedHistory(
  originalRequest: string,
  toolUseId: string,
  planItems: ReadonlyArray<{ id: string; content: string }>,
): ReadonlyArray<PriorMessage> {
  return [
    { role: 'user' as const, content: originalRequest },
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: '我先把这个 review 的步骤计划落到 todo_update。' },
        {
          type: 'tool_use' as const,
          id: toolUseId,
          name: 'todo_update',
          input: {
            op: 'init',
            items: planItems.map((p, i) => ({
              id: p.id,
              content: p.content,
              status: i === 0 ? 'in_progress' : 'pending',
            })),
          },
        },
      ],
    },
    {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: `todo_update: plan initialized with ${planItems.length} items. ${planItems[0].id} set to in_progress.`,
        },
      ],
    },
  ];
}

// Original review request (used as turn-1 user message in priorMessages)
const POS1_ORIGINAL_REQUEST = '请 review 一下所有未 release 的提交和改动（v0.7.39..HEAD 以及工作区未提交的部分），看看有没有引入问题或功能退化。重点关注 packages/coding 和 packages/agent 下的关键模块。';
const POS2_ORIGINAL_REQUEST = '请 review 一下 packages/agent/src/messaging/ 目录下新加的 MessageQueue 实现（queue.ts / types.ts / queue.test.ts）。看看竞争条件、filter 语义、dequeue 顺序、API surface 清不清晰。';
const POS3_ORIGINAL_REQUEST = '当前正在做 0.7.41 版本，我担心有功能错漏。帮我对比当前所有未 release 的提交以及未提交改动 与 v0.7.39 对应模块的差异，找出可能的功能退化。';
const POS4_ORIGINAL_REQUEST = '审查 packages/repl 和 packages/llm 中自 v0.7.39 以来的代码改动，重点检查：\n\npackages/repl:\n1. paste/ 目录下的所有新文件 — 图片粘贴功能，检查文件路径处理安全性、临时文件清理、编码问题\n2. StreamingContext.tsx — MessageQueue 作为单一数据源的改造，检查是否有状态不一致\n3. InkREPL.tsx — transcript rendering starvation 修复，检查 useDeferredValue 移除的影响\n\npackages/llm:\n1. providers/gemini-cli.ts — 新文件，检查 vision 注入是否有路径注入风险\n2. providers/registry.ts — multimodal flag 扩展，检查 provider 兼容性\n\n只做分析，不做改动。';

const CASES: readonly CaseSpec[] = [
  // Positive 1 — comprehensive unreleased review (real production)
  {
    id: 'positive_unreleased_review',
    description: 'Real production: comprehensive review. Plan-completed history (real tool_use/tool_result).',
    priorMessages: makePlanCompletedHistory(POS1_ORIGINAL_REQUEST, 'toolu_plan_pos1', [
      { id: 'step1', content: '扫描 v0.7.39..HEAD + 工作区改动范围' },
      { id: 'step2', content: '深读 packages/coding 核心改动文件' },
      { id: 'step3', content: '深读 packages/agent 核心改动文件' },
      { id: 'step4', content: '检查测试覆盖' },
      { id: 'step5', content: '汇总 [OK]/[WARN]/[ISSUE] 报告' },
    ]),
    userMessage: 'plan 已落到 todo_update（5 个 step，step1 in_progress）。现在执行 step1 的第一个 exploration tool 调用。',
    preferredFirstTools: ['changed_scope', 'changed_diff_bundle', 'changed_diff'],
    isNegative: false,
    negativeExpectedTools: [],
  },
  // Positive 2 — focused module review (real production)
  {
    id: 'positive_focused_module_review',
    description: 'Real production: focused module review. Plan-completed history (real tool_use/tool_result).',
    priorMessages: makePlanCompletedHistory(POS2_ORIGINAL_REQUEST, 'toolu_plan_pos2', [
      { id: 'step1', content: '了解 messaging 模块整体结构和依赖' },
      { id: 'step2', content: '深读 queue.ts 主实现' },
      { id: 'step3', content: '检查 types.ts 类型定义和 queue.test.ts 覆盖' },
      { id: 'step4', content: '汇总 [OK]/[WARN]/[ISSUE] 报告' },
    ]),
    userMessage: 'plan 已落到 todo_update（4 个 step，step1 in_progress）。现在执行 step1 的第一个 exploration tool 调用。',
    preferredFirstTools: ['module_context', 'changed_scope', 'changed_diff_bundle'],
    isNegative: false,
    negativeExpectedTools: [],
  },
  // Positive 3 — cross-version compare (real production)
  {
    id: 'positive_cross_version_compare',
    description: 'Real production: cross-version compare. Plan-completed history (real tool_use/tool_result).',
    priorMessages: makePlanCompletedHistory(POS3_ORIGINAL_REQUEST, 'toolu_plan_pos3', [
      { id: 'step1', content: '列出 v0.7.39..HEAD 所有变更的模块范围' },
      { id: 'step2', content: '深读核心变更文件' },
      { id: 'step3', content: '对比关键 API 行为变化' },
      { id: 'step4', content: '汇总潜在退化风险' },
    ]),
    userMessage: 'plan 已落到 todo_update（4 个 step，step1 in_progress）。现在执行 step1 的第一个 exploration tool 调用。',
    preferredFirstTools: ['changed_scope', 'changed_diff_bundle', 'impact_estimate'],
    isNegative: false,
    negativeExpectedTools: [],
  },
  // Positive 4 — multi-package review with security focus (real production)
  {
    id: 'positive_multipackage_security',
    description: 'Real production: multi-package security review. Plan-completed history (real tool_use/tool_result).',
    priorMessages: makePlanCompletedHistory(POS4_ORIGINAL_REQUEST, 'toolu_plan_pos4', [
      { id: 'step1', content: '扫描 packages/repl + packages/llm 自 v0.7.39 的所有变更范围' },
      { id: 'step2', content: '深读 packages/repl/paste 安全相关文件' },
      { id: 'step3', content: '深读 packages/repl/StreamingContext.tsx + InkREPL.tsx' },
      { id: 'step4', content: '深读 packages/llm 新增/修改的 provider 文件' },
      { id: 'step5', content: '汇总安全风险报告' },
    ]),
    userMessage: 'plan 已落到 todo_update（5 个 step，step1 in_progress）。现在执行 step1 的第一个 exploration tool 调用。',
    preferredFirstTools: ['changed_scope', 'changed_diff_bundle', 'module_context'],
    isNegative: false,
    negativeExpectedTools: [],
  },
  // Negative 1 — git status is the right answer (trivial, no plan needed)
  {
    id: 'negative_status_check',
    description: 'Working tree status check — bash is correct, trivial single-question.',
    priorMessages: [],
    userMessage: '当前工作区有哪些文件没提交？有 untracked 的吗？',
    preferredFirstTools: [],
    isNegative: true,
    negativeExpectedTools: ['bash'],
  },
  // Negative 2 — git log is the right answer (trivial, no plan needed)
  {
    id: 'negative_recent_commits',
    description: 'Recent commit log — bash git log is correct, trivial single-question.',
    priorMessages: [],
    userMessage: '帮我看下最近 5 条提交的标题和作者，按时间倒序。我想知道最近谁在动这个 repo。',
    preferredFirstTools: [],
    isNegative: true,
    negativeExpectedTools: ['bash'],
  },
];

// ---------------------------------------------------------------------------
// Multi-syntax tool detection (anti-pattern 7 §4)
// ---------------------------------------------------------------------------

// Collect ordered list of known tool names referenced in text (matches the
// audit script's syntax tolerance). Returns the ORDERED list — caller chooses
// whether to skip plan-step tool names like `todo_update`.
function extractToolSequenceFromText(text: string): string[] {
  if (!text) return [];
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
    ...PULL_TOOL_NAMES, ...READ_GREP_GLOB, 'bash', 'todo_update', 'dispatch_child_task', 'write', 'edit',
  ]);
  return candidates.filter((c) => known.has(c.name)).sort((a, b) => a.pos - b.pos).map((c) => c.name);
}

// Skip leading `todo_update` plan step — audit prompts judge "first
// non-plan tool", so the regex side must match to avoid systematic
// regex/judge disagreement on plan-first runs. Returns the first
// EXPLORATION tool call (binding-aware) AND its text-fallback name.
function pickFirstNonPlanTool(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  textSequence: readonly string[],
): {
  name: string | null;
  fromBinding: string | null;
  fromText: string | null;
  bindingCall: { name: string; input: unknown } | null;
} {
  const bindingCall = toolCalls.find((c) => c.name !== 'todo_update') ?? null;
  const fromBinding = bindingCall?.name ?? null;
  const fromText = textSequence.find((n) => n !== 'todo_update') ?? null;
  return { name: fromBinding ?? fromText, fromBinding, fromText, bindingCall };
}

// Inspect a bash binding-call's `command` arg to discriminate review-fallback
// (git diff/show) from review-neutral git ops (status/log/branch/tag) vs
// non-git shell. Returns null when the input isn't a bash call (or its
// command isn't parseable).
function classifyBashCommand(call: { name: string; input: unknown } | null):
  'git_diff_or_show' | 'git_other_op' | 'non_git' | null {
  if (!call || call.name !== 'bash') return null;
  if (typeof call.input !== 'object' || call.input === null) return null;
  const cmd = (call.input as { command?: unknown }).command;
  if (typeof cmd !== 'string') return null;
  if (/\bgit\s+(diff|show)\b/i.test(cmd)) return 'git_diff_or_show';
  if (/\bgit\s+(status|log|branch|tag|stash|fetch|remote|rev-parse|describe)\b/i.test(cmd)) return 'git_other_op';
  return 'non_git';
}

function classifyFirstTool(
  toolName: string | null,
  bindingCall: { name: string; input: unknown } | null,
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): 'pull' | 'bash_git_diff' | 'bash_git_other' | 'bash_non_git' | 'bash_unknown' | 'read_grep_glob' | 'plan_only' | 'dispatch' | 'other' | 'none' {
  if (!toolName) {
    const hasTodoOnly = toolCalls.length > 0 && toolCalls.every((c) => c.name === 'todo_update');
    return hasTodoOnly ? 'plan_only' : 'none';
  }
  if (PULL_TOOL_NAMES.has(toolName)) return 'pull';
  if (toolName === 'dispatch_child_task') return 'dispatch';
  if (READ_GREP_GLOB.has(toolName)) return 'read_grep_glob';
  if (toolName === 'bash') {
    const sub = classifyBashCommand(bindingCall);
    if (sub === 'git_diff_or_show') return 'bash_git_diff';
    if (sub === 'git_other_op') return 'bash_git_other';
    if (sub === 'non_git') return 'bash_non_git';
    // text-fallback path (no binding) — try to detect git diff/show in text
    return 'bash_unknown';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const STAGE_LABEL = 'phase2-f2-f3-worker-plancompleted-history-3variants-3runs';
const RUNS_PER_CELL = 3;
const PANEL_ALIASES = ['zhipu/glm51', 'kimi', 'mmx/m27', 'ark/glm51', 'ds/v4pro', 'ds/v4flash'] as const;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-worker-v2');

describe('Eval Suite B: Worker prompt F2 + F3 — pull-tool preference for review tasks', () => {
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
    firstToolClass: ReturnType<typeof classifyFirstTool>;
    isPullTool: boolean;
    isBashGitDiff: boolean;
    isExpectedNegativeTool: boolean;
    text: string;
    durationMs: number;
    error?: string;
  };
  type Cell = {
    caseId: string;
    isNegative: boolean;
    alias: string;
    variant: 'A_F7_baseline' | 'B_F2' | 'C_F2_plus_F3';
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
          for (const variant of ['A_F7_baseline', 'B_F2', 'C_F2_plus_F3'] as const) {
            const systemPrompt =
              variant === 'A_F7_baseline' ? SYSTEM_A_BASELINE
              : variant === 'B_F2' ? SYSTEM_B_F2
              : SYSTEM_C_F2_PLUS_F3;
            const runs: Run[] = [];
            for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
              try {
                const out = await runOneShot(alias, {
                  systemPrompt,
                  userMessage: c.userMessage,
                  tools: TOOLS,
                  priorMessages: c.priorMessages,
                });
                const textSequence = extractToolSequenceFromText(out.text);
                // First non-plan tool = the exploration choice that gates ship/no-ship
                // (audit prompts also skip `todo_update` plan step to match).
                const picked = pickFirstNonPlanTool(out.toolCalls, textSequence);
                const firstToolFromBinding = picked.fromBinding;
                const firstToolFromTextRegex = picked.fromText;
                const firstToolName = picked.name;
                const firstToolClass = classifyFirstTool(firstToolName, picked.bindingCall, out.toolCalls);
                const isPullTool = firstToolClass === 'pull';
                const isBashGitDiff = firstToolClass === 'bash_git_diff';
                // Negative-case correctness: model is "correct" only if it
                // emits bash with a LEGITIMATE non-review git op (status/log/etc).
                // Matches the audit prompt's stricter definition; a raw bash
                // call with `git diff` on a "what's uncommitted?" question is
                // wrong even though it's still bash.
                const isExpectedNegativeTool = c.isNegative
                  && (firstToolClass === 'bash_git_other'
                    // Allow text-fallback bash if user said "git status"/"git log"
                    // appears in raw text (best-effort; audit will reconcile).
                    || (firstToolClass === 'bash_unknown'
                      && /\bgit\s+(status|log|branch|tag)\b/i.test(out.text)));
                runs.push({
                  runIndex, firstToolName, firstToolFromBinding, firstToolFromTextRegex,
                  firstToolClass, isPullTool, isBashGitDiff, isExpectedNegativeTool,
                  text: out.text, durationMs: out.durationMs,
                });
              } catch (err) {
                runs.push({
                  runIndex, firstToolName: null, firstToolFromBinding: null, firstToolFromTextRegex: null,
                  firstToolClass: 'none', isPullTool: false, isBashGitDiff: false, isExpectedNegativeTool: false,
                  text: '', durationMs: 0,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            cellRows.push({ caseId: c.id, isNegative: c.isNegative, alias, variant, runs });
            overall.push(cellRows[cellRows.length - 1]);
          }
        }

        const lines: string[] = [`[suite-B][${c.id}]${c.isNegative ? ' [NEG]' : ''} preferred: ${c.isNegative ? c.negativeExpectedTools.join(',') : c.preferredFirstTools.join(',')}`];
        for (const alias of aliases) {
          const stats = (variant: Cell['variant']): { pullRate: number; bashGitRate: number; negRight: number } => {
            const cell = cellRows.find((r) => r.alias === alias && r.variant === variant);
            if (!cell) return { pullRate: 0, bashGitRate: 0, negRight: 0 };
            const pull = cell.runs.filter((r) => r.isPullTool).length;
            const bashGit = cell.runs.filter((r) => r.isBashGitDiff).length;
            const negR = cell.runs.filter((r) => r.isExpectedNegativeTool).length;
            return { pullRate: pull / RUNS_PER_CELL, bashGitRate: bashGit / RUNS_PER_CELL, negRight: negR / RUNS_PER_CELL };
          };
          const A = stats('A_F7_baseline'), B = stats('B_F2'), C = stats('C_F2_plus_F3');
          if (c.isNegative) {
            lines.push(`  ${alias.padEnd(13)} bash%(expected)  A=${Math.round(A.negRight*100)} B=${Math.round(B.negRight*100)} C=${Math.round(C.negRight*100)}`);
          } else {
            lines.push(`  ${alias.padEnd(13)} pull%  A=${Math.round(A.pullRate*100)} B=${Math.round(B.pullRate*100)} C=${Math.round(C.pullRate*100)}  |  bash_git_diff%  A=${Math.round(A.bashGitRate*100)} B=${Math.round(B.bashGitRate*100)} C=${Math.round(C.bashGitRate*100)}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify({
          case: c.id, stage: STAGE_LABEL, userMessage: c.userMessage,
          priorMessages: c.priorMessages,
          isNegative: c.isNegative, preferredFirstTools: c.preferredFirstTools,
          negativeExpectedTools: c.negativeExpectedTools,
          cells: cellRows.map((row) => ({ alias: row.alias, variant: row.variant, runs: row.runs })),
        }, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }

  it('suite verdict (PRELIMINARY — regex only; self-judge audit MUST run after)', () => {
    type Pooled = { pullRate: number; bashGitRate: number; negRightRate: number; n: number };
    function poolByVariantAndType(variant: Cell['variant'], isNegative: boolean): Pooled {
      let totalRuns = 0, pullHits = 0, bashGitHits = 0, negRightHits = 0;
      for (const cell of overall) {
        if (cell.variant !== variant || cell.isNegative !== isNegative) continue;
        for (const r of cell.runs) {
          totalRuns++;
          if (r.isPullTool) pullHits++;
          if (r.isBashGitDiff) bashGitHits++;
          if (r.isExpectedNegativeTool) negRightHits++;
        }
      }
      return {
        pullRate: totalRuns > 0 ? pullHits / totalRuns : 0,
        bashGitRate: totalRuns > 0 ? bashGitHits / totalRuns : 0,
        negRightRate: totalRuns > 0 ? negRightHits / totalRuns : 0,
        n: totalRuns,
      };
    }
    const posA = poolByVariantAndType('A_F7_baseline', false);
    const posB = poolByVariantAndType('B_F2', false);
    const posC = poolByVariantAndType('C_F2_plus_F3', false);
    const negA = poolByVariantAndType('A_F7_baseline', true);
    const negB = poolByVariantAndType('B_F2', true);
    const negC = poolByVariantAndType('C_F2_plus_F3', true);

    // Per-alias monotonicity on positive cases
    const perAliasPosLift = aliases.map((alias) => {
      const aliasVar = (variant: Cell['variant']) => {
        let runs = 0, pull = 0, bashGit = 0;
        for (const cell of overall) {
          if (cell.alias !== alias || cell.variant !== variant || cell.isNegative) continue;
          for (const r of cell.runs) {
            runs++;
            if (r.isPullTool) pull++;
            if (r.isBashGitDiff) bashGit++;
          }
        }
        return { pullRate: runs > 0 ? pull / runs : 0, bashGitRate: runs > 0 ? bashGit / runs : 0 };
      };
      const a = aliasVar('A_F7_baseline'), b = aliasVar('B_F2'), cc = aliasVar('C_F2_plus_F3');
      return { alias, A: a, B: b, C: cc };
    });
    const aliasesMonotonicAB = perAliasPosLift.filter((a) => a.B.pullRate > a.A.pullRate).length;

    // F2 verdict — three-band: REJECT (<30%) / NEG_UNHEALTHY (30-50%) / OK (≥50%).
    // Matches docstring "NEG_OK_F2 >= 50%" health floor.
    let f2Verdict: 'SHIP_F2_PRELIM' | 'F2_INSUFFICIENT' | 'F2_NEG_UNHEALTHY' | 'F2_OVER_SUPPRESS_REJECT';
    if (negB.negRightRate < 0.30) f2Verdict = 'F2_OVER_SUPPRESS_REJECT';
    else if (negB.negRightRate < 0.50) f2Verdict = 'F2_NEG_UNHEALTHY';
    else if (
      posB.pullRate >= posA.pullRate + 0.20
      && posB.bashGitRate <= posA.bashGitRate - 0.15
      && aliasesMonotonicAB >= 4
    ) f2Verdict = 'SHIP_F2_PRELIM';
    else f2Verdict = 'F2_INSUFFICIENT';

    let f3Verdict: 'SHIP_F3_ON_TOP_PRELIM' | 'F3_INSUFFICIENT' | 'F3_NEG_UNHEALTHY' | 'F3_OVER_SUPPRESS_REJECT';
    if (negC.negRightRate < 0.30) f3Verdict = 'F3_OVER_SUPPRESS_REJECT';
    else if (negC.negRightRate < 0.50) f3Verdict = 'F3_NEG_UNHEALTHY';
    else if (
      posC.pullRate >= posB.pullRate + 0.10
      && posC.bashGitRate <= posB.bashGitRate - 0.05
    ) f3Verdict = 'SHIP_F3_ON_TOP_PRELIM';
    else f3Verdict = 'F3_INSUFFICIENT';

    const summaryDumpPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(summaryDumpPath, JSON.stringify({
      stage: STAGE_LABEL, aliases_run: aliases,
      positives: { A: posA, B: posB, C: posC },
      negatives: { A: negA, B: negB, C: negC },
      perAliasPositiveLift: perAliasPosLift,
      aliasesMonotonicAB,
      f2Verdict, f3Verdict,
      caveat: 'PRELIMINARY regex-based verdicts. Self-judge audit REQUIRED — see tests/repointel-tool-adoption-worker-v2.audit.mjs.',
      decisionMatrix: {
        SHIP_F2_PRELIM: 'pos_pullRate(B) >= pos_pullRate(A)+20pp AND pos_bashGitRate(B) <= pos_bashGitRate(A)-15pp AND >=4 aliases monotonic A<B AND neg_bashRate(B) >= 50%',
        SHIP_F3_ON_TOP_PRELIM: 'pos_pullRate(C) >= pos_pullRate(B)+10pp AND pos_bashGitRate(C) <= pos_bashGitRate(B)-5pp AND neg_bashRate(C) >= 50%',
        F2_NEG_UNHEALTHY: '30% <= neg_bashRate(B) < 50% (legitimate bash partially suppressed — investigate before ship)',
        F3_NEG_UNHEALTHY: '30% <= neg_bashRate(C) < 50% (legitimate bash partially suppressed — investigate before ship)',
        F2_OVER_SUPPRESS_REJECT: 'neg_bashRate(B) < 30% (broke legitimate bash use)',
        F3_OVER_SUPPRESS_REJECT: 'neg_bashRate(C) < 30% (broke legitimate bash use)',
      },
    }, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE B PRELIMINARY VERDICT ===`);
    // eslint-disable-next-line no-console
    console.log(`F2: ${f2Verdict} | F3: ${f3Verdict}`);
    // eslint-disable-next-line no-console
    console.log(`Positives pooled (n=${posA.n}): pull%  A=${Math.round(posA.pullRate*100)} B=${Math.round(posB.pullRate*100)} C=${Math.round(posC.pullRate*100)}`);
    // eslint-disable-next-line no-console
    console.log(`Positives pooled (n=${posA.n}): bash_git_diff%  A=${Math.round(posA.bashGitRate*100)} B=${Math.round(posB.bashGitRate*100)} C=${Math.round(posC.bashGitRate*100)} (lower is better)`);
    // eslint-disable-next-line no-console
    console.log(`Negatives pooled (n=${negA.n}): bash-expected%  A=${Math.round(negA.negRightRate*100)} B=${Math.round(negB.negRightRate*100)} C=${Math.round(negC.negRightRate*100)} (>=50% is healthy)`);
    // eslint-disable-next-line no-console
    console.log(`Aliases with A<B (positive monotonic on pull-rate): ${aliasesMonotonicAB}/${aliases.length}`);
    for (const a of perAliasPosLift) {
      // eslint-disable-next-line no-console
      console.log(`  ${a.alias.padEnd(13)} pull% A=${Math.round(a.A.pullRate*100)} B=${Math.round(a.B.pullRate*100)} C=${Math.round(a.C.pullRate*100)}  bashGit% A=${Math.round(a.A.bashGitRate*100)} B=${Math.round(a.B.bashGitRate*100)} C=${Math.round(a.C.bashGitRate*100)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n>>> RUN self-judge audit AFTER this eval. <<<`);
    // eslint-disable-next-line no-console
    console.log(`suite summary: ${summaryDumpPath}`);
  });
});
