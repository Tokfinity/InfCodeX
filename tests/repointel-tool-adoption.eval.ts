/**
 * Eval: Repointel pull-tool adoption — F7 prompt change validation.
 *
 * ## Purpose
 *
 * Independent investigation (2026-05-14) found 0 pull-tool calls
 * (`repo_overview` / `changed_scope` / `changed_diff` / `changed_diff_bundle`
 * / `module_context` / `symbol_context` / `process_context` / `impact_estimate`)
 * across 210 recent Worker sessions, despite Layer 1 byte-cost analysis
 * showing pull-tools deliver 3-70x cluster token savings (median 15.4x) over
 * the read+grep exploration the Worker actually performs.
 *
 * Root cause hypothesis: Worker role-prompt (default since v0.7.38 Slice 7)
 * never names these 8 tools. The repo-intel context section pushes daemon
 * results into prompt, but the LLM has no instruction telling it the pull
 * surface exists.
 *
 * **F7 candidate fix** (this eval): add a `REPO INTELLIGENCE TOOLS` block
 * to Worker prompt naming the 8 tools + economics framing
 * (`module_context` ≈ 5+ reads of equivalent info).
 *
 * ## Method — Layer 2 single-turn probe
 *
 * Constructed input (per EVAL_GUIDELINES §Layer 2):
 * - Fixed Worker-style system prompt with full tool surface (8 pull tools +
 *   read/grep/glob/bash) advertised.
 * - Canned user message representing a module-exploration task.
 * - Single LLM turn; the model's FIRST tool_use is judged.
 *
 * Two variants per case:
 * - `A_baseline`: prompt without F7 section.
 * - `B_with_f7`: prompt with F7 REPO INTELLIGENCE TOOLS section.
 *
 * ## Pre-registered decision matrix (locked before any LLM call)
 *
 * - SHIP F7:    `B_with_f7` selects a pull-tool (one of the 8) as FIRST tool
 *               in ≥60% of runs (15/25 across 5 cases × 5 runs), AND
 *               `A_baseline` selects a pull-tool in ≤20% (5/25).
 * - PARTIAL:    B 40-59% (10-14/25), A still ≤20% → ship F7 but iterate
 *               wording.
 * - REJECT:     B <40% (<10/25) → F7 wording fails to teach the surface;
 *               redesign before any prompt change lands.
 *
 * Cross-case sanity: a healthy F7 lifts pull-tool rate WITHOUT making the
 * model invent garbage tool calls. Mechanical judges audit both axes.
 *
 * ## Budget
 *
 * 5 cases × 2 variants × 5 runs × 1 alias (zhipu/glm51 per user direction) =
 * 50 calls ≈ $1. Worth one prompt-change ship/reject decision per
 * EVAL_GUIDELINES §"$5 实验换一条 production prompt 改动: 值".
 *
 * ## Multi-syntax tool detection (反模式 7 §4 compliance)
 *
 * Tool-name detection must cover 4+ syntaxes. zhipu/glm51 in particular
 * emits `<tool_name>(...)`, `<tool_call>{"name":"tool_name",...}</tool_call>`,
 * etc. Both regex judge AND self-judge cross-check the raw dump.
 *
 * ## Run
 *
 *   npm run test:eval -- repointel-tool-adoption
 *
 * Raw dumps land under `os.tmpdir()/kodax-eval-dumps/repointel-tool-adoption/`
 * for orchestrator-side self-judge audit.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

// ---------------------------------------------------------------------------
// Tool definitions advertised to the LLM. Includes the 8 repointel pull
// tools (so the model CAN call them) plus read/grep/glob/bash so it has the
// fallback path it's used to. Schemas copied from
// packages/coding/src/tools/registry.ts:941-1073.
// ---------------------------------------------------------------------------

const PULL_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'repo_overview',
    description: 'Summarize the repository structure, key areas, entry hints, and stored repo-intelligence snapshot for the current workspace.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string' },
        refresh: { type: 'boolean' },
      },
    },
  },
  {
    name: 'changed_scope',
    description: 'Analyze which files, areas, and categories are touched by the current git diff or a comparison range.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string' },
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'] },
        base_ref: { type: 'string' },
      },
    },
  },
  {
    name: 'changed_diff',
    description: 'Read a paged diff slice for a specific changed file. Prefer this over broad git diff output during large reviews.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'changed_diff_bundle',
    description: 'Read diff slices for multiple changed files in one call. Prefer this for large reviews before drilling down with changed_diff.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        limit_per_path: { type: 'number' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'module_context',
    description: 'Return a task-shaped module capsule with dependencies, entry files, symbols, tests, docs, and follow-up handles.',
    input_schema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  {
    name: 'symbol_context',
    description: 'Return definition, probable callers/callees, imports, and alternatives for a repository symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  {
    name: 'process_context',
    description: 'Return an approximate static execution/process capsule for an entry symbol, module, or path.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string' },
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  {
    name: 'impact_estimate',
    description: 'Estimate blast radius for a symbol, path, or module using local intelligence plus changed-scope overlap.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        module: { type: 'string' },
        path: { type: 'string' },
      },
    },
  },
  // Standard tools (so model has the fallback path it knows from pretraining).
  {
    name: 'read',
    description: 'Read a file from the local filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents using ripgrep.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Fast file pattern matching.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a bash command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
];

const PULL_TOOL_NAMES = new Set<string>([
  'repo_overview', 'changed_scope', 'changed_diff', 'changed_diff_bundle',
  'module_context', 'symbol_context', 'process_context', 'impact_estimate',
]);

// ---------------------------------------------------------------------------
// System prompt — baseline Worker essence.
// ---------------------------------------------------------------------------

const WORKER_BASE = [
  'You are the Worker — KodaX\'s single primary agent for this task.',
  '',
  'Routing decision summary:',
  '- Primary task: investigate',
  '- Work intent: review/explain',
  '- Risk: low',
  '- Complexity: moderate',
  '',
  'PLAN-FIRST CONTRACT:',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas) → your FIRST tool call MUST be `todo_update` with the full plan.',
  '- Trivial tasks (single typo / single-line edit / single-question lookup) → answer or execute directly.',
  '',
  'MUTATION DISCIPLINE:',
  '- `read` first when the file is non-trivial.',
  '- Prefer `edit` over `write` for existing files.',
  '',
  'Repo context already injected: this workspace is a TypeScript monorepo at `C:/Works/GitWorks/KodaX-author/KodaX`. Active modules include `packages/coding/src/*`, `packages/repl/src/*`, `packages/agent/src/*`.',
].join('\n');

// F7 candidate addition.
const F7_SECTION = [
  '',
  'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
  '- `module_context(target_path|module)` — returns a compact capsule with module deps, entry files, top symbols, tests, docs. Replaces 5-10 `read`/`grep` calls when you need to understand "what does this module do / what does it depend on".',
  '- `symbol_context(symbol)` — definition + probable callers/callees + imports for one symbol. Replaces multiple `grep -n "symbolName"` + `read` rounds when tracing usage.',
  '- `impact_estimate(symbol|module|path)` — blast-radius estimate combining symbol/module info with current changed-scope overlap. Use BEFORE planning a rename/refactor instead of guessing from grep.',
  '- `process_context(entry|module)` — static execution trace from an entry point. Use to understand "how does this flow execute" instead of chasing N file reads.',
  '- `repo_overview()` — workspace-wide structure snapshot. Use ONCE if onboarding to a new area.',
  '- `changed_scope()` — list of changed files in current git state, with area/category labels. Use before any review/audit task to scope.',
  '- `changed_diff_bundle(paths[])` — paged diff for multiple changed files in one call. Use for review tasks instead of multiple `bash git diff` calls.',
  '- `changed_diff(path)` — paged diff for one file. Use when one file dominates the review.',
  '',
  'WHEN TO PREFER REPO-INTEL TOOLS:',
  '- About to read 3+ files in the same module → use `module_context` first.',
  '- About to grep for a symbol\'s callers → use `symbol_context` first.',
  '- About to estimate impact of a change → use `impact_estimate` first.',
  '- About to review a multi-file change → use `changed_scope` + `changed_diff_bundle` instead of `git diff` + N reads.',
  '',
  'WHEN TO STICK WITH read/grep:',
  '- Single-file targeted edit or lookup (≤2 files).',
  '- Need exact line numbers / code text (capsules summarize, files give you exact bytes).',
].join('\n');

const SYSTEM_A_BASELINE = WORKER_BASE;
const SYSTEM_B_WITH_F7 = WORKER_BASE + F7_SECTION;

// FEATURE_163 (F2) verification — does the old `reasoning.ts:3090`
// "validate with direct file evidence" wording suppress F7's teaching
// when both are present in the system prompt? Production Worker
// receives BOTH F7 (worker-role-prompt) AND the routing-notes overlay
// (which includes reasoning.ts:3090 when `repoSignals.lowConfidence`
// fires). If the old wording dominates F7, the production observation
// "0 pull-tool calls in 210 sessions" is partly explained by the
// overlay text overriding the prompt-section teaching.
//
// Two variants compare wording semantics with F7 held constant:
//
//   C_OLD_REVERSE: F7 + the legacy reverse-guidance ("validate with
//     direct file evidence") — what production currently produces
//     when lowConfidence fires.
//
//   D_NEW_TOOLS_FIRST: F7 + the FEATURE_163 wording ("re-query
//     `module_context` / `symbol_context` / `impact_estimate` first;
//     raw `read`/`grep` only when load-bearing") — what production
//     produces after F2 ships.
//
// Decision question: does D preserve F7's pull-tool rate or does it
// still suppress under the routing-notes load? Pre-registered:
//   D ≥ B - 10pp → F2 SHIPS (new wording doesn't suppress)
//   D < B - 10pp → F2 needs rewording before ship
//   C  < B - 10pp AND D ≥ B - 5pp → confirms old wording suppressed AND new wording fixes it
const ROUTING_OVERLAY_OLD_REVERSE = [
  '',
  '## Routing notes',
  'Repository intelligence for the active area is low-confidence; validate critical conclusions with direct file evidence.',
].join('\n');

const ROUTING_OVERLAY_NEW_TOOLS_FIRST = [
  '',
  '## Routing notes',
  'Repository intelligence for the active area is low-confidence; re-query `module_context` / `symbol_context` (or `impact_estimate` for blast-radius questions) for a refined capsule before falling back to raw `read`/`grep`. Use direct file evidence only when a specific load-bearing claim needs byte-level verification.',
].join('\n');

const SYSTEM_C_OLD_REVERSE = WORKER_BASE + F7_SECTION + ROUTING_OVERLAY_OLD_REVERSE;
const SYSTEM_D_NEW_TOOLS_FIRST = WORKER_BASE + F7_SECTION + ROUTING_OVERLAY_NEW_TOOLS_FIRST;

// ---------------------------------------------------------------------------
// Cases — 5 module-exploration scenarios drawn from observed cluster data
// (clusters-20260514-100417.json under %LOCALAPPDATA%/Temp/kodax-repointel-roi).
// All cases are "positive" — F7 hypothesis says these should trigger pull-tool.
// ---------------------------------------------------------------------------

interface CaseSpec {
  readonly id: string;
  readonly description: string;
  readonly userMessage: string;
  /** Expected pull-tool names that would be a "good" first pick. */
  readonly preferredPullTools: readonly string[];
}

const CASES: readonly CaseSpec[] = [
  {
    id: 'module_understanding',
    description: 'User asks Worker to understand a TypeScript module they have not seen before. Classic case where module_context replaces 5-10 reads.',
    userMessage: 'Help me understand the `packages/coding/src/context` module — what does it do, what files are entry points, and what does it depend on? I have not touched this area before.',
    preferredPullTools: ['module_context', 'repo_overview'],
  },
  {
    id: 'symbol_usage_trace',
    description: 'User asks for callers of a function — classic symbol_context case (replaces grep + read rounds).',
    userMessage: 'Find all callers of the function `buildWorkerInstructions` in `packages/coding/src/agents/worker-role-prompt.ts`. I want to know which roles invoke it.',
    preferredPullTools: ['symbol_context', 'impact_estimate'],
  },
  {
    id: 'rename_impact',
    description: 'User asks impact analysis before a rename — exactly the impact_estimate use case.',
    userMessage: 'If I rename `dispatch_child_task` to `dispatch_worker_task` everywhere, what is the blast radius? I want to know affected modules and call sites before I start.',
    preferredPullTools: ['impact_estimate', 'symbol_context'],
  },
  {
    id: 'review_changes',
    description: 'User asks to review current uncommitted changes — classic changed_scope + changed_diff_bundle case.',
    userMessage: 'Review the uncommitted changes in the current working directory. Tell me what files changed, what areas they touch, and whether the diff looks risky.',
    preferredPullTools: ['changed_scope', 'changed_diff_bundle', 'changed_diff'],
  },
  {
    id: 'process_trace',
    description: 'User asks how a flow executes — process_context case.',
    userMessage: 'Explain how a request flows through `packages/coding/src/task-engine/runner-driven.ts` from entry to first tool call. I am trying to add a new middleware step.',
    preferredPullTools: ['process_context', 'module_context', 'symbol_context'],
  },
];

// ---------------------------------------------------------------------------
// Multi-syntax tool-name extraction from raw text (反模式 7 §4).
// Covers: tool_name(...), "name":"tool_name", <tool_name>, name=tool_name,
//         name: tool_name.
// ---------------------------------------------------------------------------

function extractFirstToolNameFromText(text: string): string | null {
  if (!text) return null;
  // Try each syntax in order and collect (name, position) tuples; return earliest.
  const candidates: Array<{ name: string; pos: number }> = [];

  // Syntax 1: tool_name(  — but exclude bare words; require it's preceded by whitespace/newline/[/`/"
  const re1 = /(?:^|[\s\[\`"({,>])([a-z_][a-z_0-9]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) {
    candidates.push({ name: m[1], pos: m.index });
  }
  // Syntax 2: "name":"tool_name"
  const re2 = /"name"\s*:\s*"([a-z_][a-z_0-9]*)"/g;
  while ((m = re2.exec(text)) !== null) {
    candidates.push({ name: m[1], pos: m.index });
  }
  // Syntax 3: <tool_name> or <tool_name ...>
  const re3 = /<([a-z_][a-z_0-9]*)[\s>]/g;
  while ((m = re3.exec(text)) !== null) {
    candidates.push({ name: m[1], pos: m.index });
  }
  // Syntax 4: name=tool_name / name: tool_name
  const re4 = /\bname\s*[=:]\s*["']?([a-z_][a-z_0-9]*)["']?/g;
  while ((m = re4.exec(text)) !== null) {
    candidates.push({ name: m[1], pos: m.index });
  }

  // Filter to known tool names (avoid false positives from prose).
  const knownNames = new Set<string>([
    ...PULL_TOOL_NAMES,
    'read', 'grep', 'glob', 'bash', 'todo_update', 'dispatch_child_task',
    'write', 'edit', 'multi_edit',
  ]);
  const filtered = candidates.filter((c) => knownNames.has(c.name));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.pos - b.pos);
  return filtered[0].name;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const STAGE_LABEL = 'phase3-f7-plus-f2-multialias-5cases-3runs';
// 3 runs/cell × 4 variants × 5 cases × 6 aliases = 360 calls (~$8). Drop from
// 5 runs/cell to keep budget for the 4-variant grid within the
// EVAL_GUIDELINES "$5 实验换一条 production prompt 改动" guideline.
const RUNS_PER_CELL = 3;
const PANEL_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/glm51',
  'ds/v4pro',
  'ds/v4flash',
] as const;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption');

describe('Eval: Repointel pull-tool adoption (F7 prompt validation)', () => {
  const aliases = availableAliases(...PANEL_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op makes skip visible.
    });
    return;
  }

  // Aggregator across all cases × variants × aliases.
  type Run = {
    runIndex: number;
    firstToolCallName: string | null;
    firstToolFromBinding: string | null;
    firstToolFromTextRegex: string | null;
    isPullTool: boolean;
    text: string;
    durationMs: number;
    error?: string;
  };
  type Cell = {
    caseId: string;
    alias: string;
    variant: 'A_baseline' | 'B_with_f7' | 'C_old_reverse' | 'D_new_tools_first';
    runs: Run[];
    pullToolRate: number;
  };
  const overall: Cell[] = [];

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // Worst case: 6 aliases × 2 variants × 5 runs × ~30s = 30 min/case.
      { timeout: 45 * 60_000 },
      async () => {
        const cellRows: Cell[] = [];
        for (const alias of aliases) {
          for (const variant of ['A_baseline', 'B_with_f7', 'C_old_reverse', 'D_new_tools_first'] as const) {
            const systemPrompt =
              variant === 'A_baseline' ? SYSTEM_A_BASELINE
              : variant === 'B_with_f7' ? SYSTEM_B_WITH_F7
              : variant === 'C_old_reverse' ? SYSTEM_C_OLD_REVERSE
              : SYSTEM_D_NEW_TOOLS_FIRST;
            const runs: Run[] = [];
            let pullToolHits = 0;
            for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
              try {
                const out = await runOneShot(alias, {
                  systemPrompt,
                  userMessage: c.userMessage,
                  tools: PULL_TOOLS,
                });
                const firstToolFromBinding = out.toolCalls[0]?.name ?? null;
                const firstToolFromTextRegex = extractFirstToolNameFromText(out.text);
                const firstToolCallName = firstToolFromBinding ?? firstToolFromTextRegex;
                const isPullTool = firstToolCallName !== null && PULL_TOOL_NAMES.has(firstToolCallName);
                if (isPullTool) pullToolHits++;
                runs.push({
                  runIndex,
                  firstToolCallName,
                  firstToolFromBinding,
                  firstToolFromTextRegex,
                  isPullTool,
                  text: out.text,
                  durationMs: out.durationMs,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                runs.push({
                  runIndex,
                  firstToolCallName: null,
                  firstToolFromBinding: null,
                  firstToolFromTextRegex: null,
                  isPullTool: false,
                  text: '',
                  durationMs: 0,
                  error: msg,
                });
              }
            }
            const cell: Cell = {
              caseId: c.id,
              alias,
              variant,
              runs,
              pullToolRate: pullToolHits / RUNS_PER_CELL,
            };
            cellRows.push(cell);
            overall.push(cell);
          }
        }

        // Per-case console summary, grouped by alias.
        const lines: string[] = [];
        lines.push(`[repointel-tool-adoption][${c.id}]`);
        lines.push(`  preferred: ${c.preferredPullTools.join(', ')}`);
        for (const alias of aliases) {
          const A = cellRows.find((row) => row.alias === alias && row.variant === 'A_baseline');
          const B = cellRows.find((row) => row.alias === alias && row.variant === 'B_with_f7');
          const C = cellRows.find((row) => row.alias === alias && row.variant === 'C_old_reverse');
          const D = cellRows.find((row) => row.alias === alias && row.variant === 'D_new_tools_first');
          if (!A || !B || !C || !D) continue;
          lines.push(`  ${alias.padEnd(13)} A=${Math.round(A.pullToolRate * 100)}% B=${Math.round(B.pullToolRate * 100)}% C=${Math.round(C.pullToolRate * 100)}% D=${Math.round(D.pullToolRate * 100)}%`);
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Per-case raw dump.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          dumpPath,
          JSON.stringify({
            case: c.id,
            stage: STAGE_LABEL,
            description: c.description,
            preferredPullTools: c.preferredPullTools,
            userMessage: c.userMessage,
            cells: cellRows.map((row) => ({
              alias: row.alias,
              variant: row.variant,
              pullToolRate: row.pullToolRate,
              runs: row.runs,
            })),
          }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }

  // Suite-level verdict computed in a final test.
  it('suite verdict against pre-registered matrix', () => {
    // Per-alias aggregation across all 4 variants.
    type AliasAgg = {
      alias: string;
      baseline: { hits: number; total: number; rate: number };
      with_f7: { hits: number; total: number; rate: number };
      old_reverse: { hits: number; total: number; rate: number };
      new_tools_first: { hits: number; total: number; rate: number };
      f7_lift_pp: number;
      // FEATURE_163 verification:
      // suppression_pp = C - B (negative means old reverse guidance suppressed F7)
      suppression_pp: number;
      // recovery_pp = D - C (positive means new wording recovered toward F7 level)
      recovery_pp: number;
    };
    const perAlias: AliasAgg[] = aliases.map((alias) => {
      const aggVariant = (v: Cell['variant']) => {
        let hits = 0, total = 0;
        for (const cell of overall) {
          if (cell.alias !== alias || cell.variant !== v) continue;
          for (const r of cell.runs) {
            total++;
            if (r.isPullTool) hits++;
          }
        }
        return { hits, total, rate: total > 0 ? hits / total : 0 };
      };
      const a = aggVariant('A_baseline');
      const b = aggVariant('B_with_f7');
      const c = aggVariant('C_old_reverse');
      const d = aggVariant('D_new_tools_first');
      return {
        alias,
        baseline: a,
        with_f7: b,
        old_reverse: c,
        new_tools_first: d,
        f7_lift_pp: Math.round((b.rate - a.rate) * 100),
        suppression_pp: Math.round((c.rate - b.rate) * 100),
        recovery_pp: Math.round((d.rate - c.rate) * 100),
      };
    });

    // Pre-registered decision matrix (locked before run; question-shifted
    // after Phase 1 zhipu/glm51 found baseline 88% — we now want to know:
    // does baseline hold across panel, or does it collapse on weaker models?
    //
    // - BASELINE_SUFFICIENT: ≥4 of 6 aliases hit ≥80% A_baseline rate
    //   → F7 unnecessary on the panel; root cause of production 0-rate
    //     must be in environment outside the eval input (reasoning.ts:3090
    //     reverse guidance, repo-intel context pre-injection, etc.).
    //
    // - F7_USEFUL_FOR_WEAK: ≥2 aliases have A_baseline <80% AND B_with_f7
    //   lifts them to ≥80%
    //   → F7 has value as a floor lifter; safe to ship as low-cost prompt
    //     improvement.
    //
    // - F7_INSUFFICIENT: ≥3 aliases stay <80% even with B_with_f7
    //   → F7 wording doesn't teach the surface effectively; need
    //     redesign before any prompt change lands.
    const aliasesAtBaseline80 = perAlias.filter((a) => a.baseline.rate >= 0.8).length;
    const aliasesLiftedToBetween = perAlias.filter((a) => a.baseline.rate < 0.8 && a.with_f7.rate >= 0.8).length;
    const aliasesUnder80WithF7 = perAlias.filter((a) => a.with_f7.rate < 0.8).length;

    let verdict: 'BASELINE_SUFFICIENT' | 'F7_USEFUL_FOR_WEAK' | 'F7_INSUFFICIENT' | 'MIXED';
    if (aliasesAtBaseline80 >= 4) verdict = 'BASELINE_SUFFICIENT';
    else if (aliasesLiftedToBetween >= 2 && aliasesUnder80WithF7 <= 1) verdict = 'F7_USEFUL_FOR_WEAK';
    else if (aliasesUnder80WithF7 >= 3) verdict = 'F7_INSUFFICIENT';
    else verdict = 'MIXED';

    const summaryDumpPath = join(DUMP_ROOT, '_suite-summary.json');
    writeFileSync(
      summaryDumpPath,
      JSON.stringify({
        stage: STAGE_LABEL,
        aliases_run: aliases,
        perAlias,
        aliasesAtBaseline80,
        aliasesLiftedToBetween,
        aliasesUnder80WithF7,
        verdict,
        decisionMatrix: {
          BASELINE_SUFFICIENT: '>=4 of 6 aliases hit >=80% A_baseline',
          F7_USEFUL_FOR_WEAK: '>=2 aliases lifted from <80% A to >=80% B AND <=1 alias still <80% B',
          F7_INSUFFICIENT: '>=3 aliases still <80% with B_with_f7',
          MIXED: 'none of the above',
        },
      }, null, 2),
      'utf8',
    );

    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE VERDICT (F7): ${verdict} ===`);
    // eslint-disable-next-line no-console
    console.log(`  per-alias breakdown:`);
    for (const a of perAlias) {
      // eslint-disable-next-line no-console
      console.log(`    ${a.alias.padEnd(13)} A=${Math.round(a.baseline.rate * 100)}% B=${Math.round(a.with_f7.rate * 100)}% C=${Math.round(a.old_reverse.rate * 100)}% D=${Math.round(a.new_tools_first.rate * 100)}%  | F7lift=${a.f7_lift_pp >= 0 ? '+' : ''}${a.f7_lift_pp}pp suppress(C-B)=${a.suppression_pp >= 0 ? '+' : ''}${a.suppression_pp}pp recover(D-C)=${a.recovery_pp >= 0 ? '+' : ''}${a.recovery_pp}pp`);
    }
    // eslint-disable-next-line no-console
    console.log(`  F7: aliasesAtBaseline80=${aliasesAtBaseline80} liftedFromBelow=${aliasesLiftedToBetween} stillUnder80WithF7=${aliasesUnder80WithF7}`);

    // FEATURE_163 (F2) verdict against pre-registered matrix.
    //  F2_SHIP: D rate >= B rate - 10pp (avg across aliases) — new wording
    //           preserves F7 teaching even when low-conf overlay is present.
    //  F2_NEEDED_AND_FIXED: avg(B - C) >= 10pp AND avg(D - C) >= 5pp.
    //  F2_INSUFFICIENT: D < B - 10pp — new wording still suppresses.
    const avgB = perAlias.reduce((s, a) => s + a.with_f7.rate, 0) / perAlias.length;
    const avgC = perAlias.reduce((s, a) => s + a.old_reverse.rate, 0) / perAlias.length;
    const avgD = perAlias.reduce((s, a) => s + a.new_tools_first.rate, 0) / perAlias.length;
    const oldSuppress = avgB - avgC;
    const newPreserve = avgB - avgD;
    const recovery = avgD - avgC;
    let f2Verdict: 'F2_SHIP' | 'F2_NEEDED_AND_FIXED' | 'F2_INSUFFICIENT' | 'F2_NEUTRAL';
    if (newPreserve <= 0.10 && oldSuppress >= 0.10 && recovery >= 0.05) f2Verdict = 'F2_NEEDED_AND_FIXED';
    else if (newPreserve <= 0.10) f2Verdict = 'F2_SHIP';
    else if (newPreserve > 0.10) f2Verdict = 'F2_INSUFFICIENT';
    else f2Verdict = 'F2_NEUTRAL';

    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE VERDICT (F2 = reasoning.ts:3090 wording fix): ${f2Verdict} ===`);
    // eslint-disable-next-line no-console
    console.log(`  avg B(F7)=${Math.round(avgB * 100)}%  C(old reverse)=${Math.round(avgC * 100)}%  D(new tools-first)=${Math.round(avgD * 100)}%`);
    // eslint-disable-next-line no-console
    console.log(`  oldSuppress(B-C)=${Math.round(oldSuppress * 100)}pp  newPreserve(B-D)=${Math.round(newPreserve * 100)}pp  recovery(D-C)=${Math.round(recovery * 100)}pp`);
    // eslint-disable-next-line no-console
    console.log(`  suite summary: ${summaryDumpPath}`);
  });
});
