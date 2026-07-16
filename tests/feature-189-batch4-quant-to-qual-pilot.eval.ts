/**
 * Pilot — FEATURE_189 Batch 4: Quantitative → Qualitative rewrite.
 *
 * Per ADR-033 §1: hardcoded numerical thresholds (≤80 chars, ~50KB, ≤2 files,
 * 40 lines / 3 depth / 1 sentence, 2-3KB vs 20-200KB) are replaced with
 * qualitative descriptions ("brief imperative title", "too large to include
 * inline", "one or a few known files", "concise and hierarchical, one short
 * sentence per bullet", "much smaller than the equivalent").
 *
 * Risk class: dropping a number anchor can cause models to drift toward
 * verbosity. Pilot first to detect regression.
 *
 * 1 alias (ark/v4flash) × 4 case × 2 variant × 3 runs = 24 cells, ~$0.5.
 *
 * Cases:
 *   C1 — subject brevity (worker-role-prompt:58 + registry.ts:1006/1111
 *                         dropped "≤80 chars")
 *        Task: 4-package audit → model should emit todo_create with short
 *        imperative titles. Regression = subjects > ~120 chars.
 *
 *   C2 — plan structure (registry.ts:955 dropped "40 lines, 3 depth,
 *                        1 sentence per bullet")
 *        Task: plan-mode multi-phase refactor → model emits exit_plan_mode
 *        plan. Regression = wall-of-text or no bullet structure.
 *
 *   C3 — large file decision (worker-role-prompt:119 dropped "~50KB")
 *        Task: process a "too large to include inline" file. Regression =
 *        full Read without offset/limit (model assumed inline-OK).
 *
 *   C4 — multi-file lookup (worker-role-prompt:193 dropped "≤2 files")
 *        Task: search across "one or a few known files". Regression =
 *        switches to module_context / grep when targeted Read is right.
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch4-quant-to-qual-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-batch4-quant-to-qual-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = { 'ark/v4flash': 'ds/v4flash' };
const RUNS_PER_CELL = 3;

// ============================================================
// v_baseline (quantitative numbers preserved)
// ============================================================

const PLAN_CONTRACT_BASELINE = `PLAN-FIRST CONTRACT:
- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call \`todo_create\` / \`todo_update\`.
- Non-trivial tasks (multiple steps OR multiple files / areas / feature threads) → your FIRST tool calls MUST be a batch of \`todo_create\` — one call per planned step — to commit the full plan up front.
- Plan item schema:
    * \`subject\` — REQUIRED. Brief imperative title shown in the plan-list row (≤80 chars, e.g. "Audit handleAuth callers").
    * \`description\` — OPTIONAL. Fuller context.
    * \`activeForm\` — OPTIONAL. Present-continuous form (e.g. "Auditing handleAuth callers").`;

const LARGE_OUTPUT_BASELINE =
  "- LARGE CHILD OUTPUT: when a child's report exceeds the inline envelope budget (~50KB), the `<task-completed>` banner contains a preview + marker. The preview is usually enough — read it first, and only call `Read` on the saved path when you need details beyond the preview.";

const MULTI_FILE_BASELINE = `WHEN TO STICK WITH read/grep over repo-intelligence pull tools:
- Single-file targeted edit or lookup (≤2 files).
- Need exact line numbers or code text.
- Rationale: pull-tool capsules typically run 2-3KB vs 20-200KB for the equivalent multi-file read exploration. Token savings compound across a full task.`;

const PLAN_TOOL_DESC_BASELINE =
  'The finalized plan to present to the user. Include the full plan content, not a summary, so the user can make an informed approval decision. Keep the plan tight: at most 40 lines total, 3 bullet-depth levels, one sentence per bullet. If the plan exceeds this budget, split it into phases and present only the current phase — the user can approve phase-by-phase.';

const SUBJECT_BASELINE = 'Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers"). Keep ≤80 chars.';

// ============================================================
// v_proposed (qualitative replacements)
// ============================================================

const PLAN_CONTRACT_PROPOSED = `PLAN-FIRST CONTRACT:
- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call \`todo_create\` / \`todo_update\`.
- Non-trivial tasks (multiple steps OR multiple files / areas / feature threads) → your FIRST tool calls MUST be a batch of \`todo_create\` — one call per planned step — to commit the full plan up front.
- Plan item schema:
    * \`subject\` — REQUIRED. Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").
    * \`description\` — OPTIONAL. Fuller context.
    * \`activeForm\` — OPTIONAL. Present-continuous form (e.g. "Auditing handleAuth callers").`;

const LARGE_OUTPUT_PROPOSED =
  "- LARGE CHILD OUTPUT: when a child's report is too large to include inline, the `<task-completed>` banner contains a preview + marker. The preview is usually enough — read it first, and only call `Read` on the saved path when you need details beyond the preview.";

const MULTI_FILE_PROPOSED = `WHEN TO STICK WITH read/grep over repo-intelligence pull tools:
- Single-file targeted edit or lookup in one or a few known files.
- Need exact line numbers or code text.
- Rationale: pull-tool capsules are much smaller than the equivalent multi-file read exploration; the token savings compound across a full task.`;

const PLAN_TOOL_DESC_PROPOSED =
  'The finalized plan to present to the user. Include the full plan content, not a summary, so the user can make an informed approval decision. Keep the plan concise and hierarchical, one short sentence per bullet. If the plan is too long for one approval round, split it into phases and present only the current phase — the user can approve phase-by-phase.';

const SUBJECT_PROPOSED = 'Brief imperative title shown in the plan-list row (e.g. "Audit handleAuth callers").';

// ============================================================
// Prompt builders per case
// ============================================================

function buildSubjectPrompt(variant: 'baseline' | 'proposed'): string {
  const contract = variant === 'baseline' ? PLAN_CONTRACT_BASELINE : PLAN_CONTRACT_PROPOSED;
  const subj = variant === 'baseline' ? SUBJECT_BASELINE : SUBJECT_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent.",
    '',
    contract,
    '',
    '## Tools',
    '',
    `\`todo_create\`: Insert ONE new pending item into the visible plan list. Required field: subject. Description: ${subj}`,
    '',
    '`read` / `grep` / `bash` / `write` / `edit`: standard tools.',
  ].join('\n');
}

function buildPlanPrompt(variant: 'baseline' | 'proposed'): string {
  const planDesc = variant === 'baseline' ? PLAN_TOOL_DESC_BASELINE : PLAN_TOOL_DESC_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent.",
    '',
    'You are in PLAN MODE. You MUST present a plan via the `exit_plan_mode` tool BEFORE doing any execution work. Do NOT use any other tool. The plan must contain the full plan content for user approval.',
    '',
    '## Tools',
    '',
    `\`exit_plan_mode(plan: string)\`: ${planDesc}`,
  ].join('\n');
}

function buildLargeOutputPrompt(variant: 'baseline' | 'proposed'): string {
  const large = variant === 'baseline' ? LARGE_OUTPUT_BASELINE : LARGE_OUTPUT_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent.",
    '',
    'FAN-OUT (dispatch_child_task) — coordinator-only:',
    large,
    '',
    '## Tools',
    '',
    '`dispatch_child_task(objective, readOnly?)`: launches a child investigation.',
    '`Read(path, offset?, limit?)`: read a file. Use offset/limit when output may be large.',
    '`grep(pattern, path)`: search for a pattern in a file or directory.',
    '`bash(command)`: run a shell command.',
  ].join('\n');
}

function buildMultiFilePrompt(variant: 'baseline' | 'proposed'): string {
  const mf = variant === 'baseline' ? MULTI_FILE_BASELINE : MULTI_FILE_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent.",
    '',
    'REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):',
    '- `module_context(target_path)` — compact module capsule with deps, entry files, top symbols, tests, docs.',
    '- `symbol_context(symbol)` — definition + probable callers/callees for one symbol.',
    '- `changed_scope()` — list of changed files.',
    '',
    'WHEN TO PREFER REPO-INTEL TOOLS:',
    '- About to read 3+ files in the same module → call `module_context` first.',
    '- About to grep for a symbol\'s callers → call `symbol_context` first.',
    '',
    mf,
    '',
    '## Tools',
    '',
    '`module_context(target_path)` / `symbol_context(symbol)` / `changed_scope()`: repo-intel.',
    '`read(path)` / `grep(pattern, path)`: file/text level tools.',
  ].join('\n');
}

// ============================================================
// Cases
// ============================================================

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly buildPrompt: (variant: 'baseline' | 'proposed') => string;
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

const CASE_C1: CaseBundle = {
  id: 'C1_subject_brevity',
  buildPrompt: buildSubjectPrompt,
  userMessage:
    'Audit the authentication module across our four packages: packages/auth (the core auth library), ' +
    'packages/api (the REST endpoints that consume auth tokens), packages/web (the browser-side login UI), ' +
    'and packages/cli (the CLI tool that prompts for credentials). For each package, identify any inconsistency ' +
    'in handler signatures, decorator usage, error wrapping, or session storage. Produce a written report at ' +
    'the end. Start by committing the plan via todo_create — one call per package.',
};

const CASE_C2: CaseBundle = {
  id: 'C2_plan_structure',
  buildPrompt: buildPlanPrompt,
  userMessage:
    "I want to refactor our cache layer end-to-end. Phase 1: replace the in-memory Map with a layered " +
    "LRU + persistent disk tier. Phase 2: thread cache-key generation through a typed builder so we eliminate " +
    "string concatenation bugs. Phase 3: add TTL + invalidation hooks. Phase 4: instrument hit-rate metrics. " +
    "Please present the plan for my approval before any execution.",
};

const CASE_C3: CaseBundle = {
  id: 'C3_large_file_decision',
  buildPrompt: buildLargeOutputPrompt,
  userMessage:
    "I just ran the integration suite and dumped output to /tmp/integration-run-2026-05-22.log. It's a big " +
    "log file — too large to include inline. Find me the first three test failures (search for FAIL: or " +
    "Error:) and report their file:line and the surrounding context.",
};

const CASE_C4: CaseBundle = {
  id: 'C4_multi_file_lookup',
  buildPrompt: buildMultiFilePrompt,
  userMessage:
    "I want to know what `getUserById` does. It's defined in packages/auth/src/user-repo.ts. Just read " +
    "that exact file and tell me what the function returns and what it depends on.",
};

const CASES: readonly CaseBundle[] = [CASE_C1, CASE_C2, CASE_C3, CASE_C4] as const;

// ============================================================
// Tool-name pattern helpers
// ============================================================

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),
  ];
}
function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

// ============================================================
// Judges
// ============================================================

// C1: PASS if any todo_create subject is reasonably brief (≤140 chars).
// The "Keep ≤80 chars" rule is dropped in proposed; check the model still
// emits brief imperative titles. 140 = 75% margin above original 80.
function judgeC1(out: string, context?: JudgeContext): JudgeResult {
  const todoCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'todo_create');
  if (todoCalls.length === 0) {
    // Text fallback — try to extract subject from XML/JSON-ish syntax
    const subjectMatches = Array.from(out.matchAll(/subject\s*[:=]\s*["']([^"']{1,400})["']/g));
    if (subjectMatches.length === 0) {
      return { passed: false, reason: 'no todo_create invocation or subject markup found' };
    }
    const maxLen = Math.max(...subjectMatches.map((m) => m[1]!.length));
    const subjects = subjectMatches.map((m) => m[1]!);
    if (maxLen <= 140) return { passed: true, reason: `text-fallback max subject ${maxLen} chars across ${subjects.length}` };
    return { passed: false, reason: `text-fallback max subject ${maxLen} chars (>140) across ${subjects.length}` };
  }
  const subjects: string[] = [];
  for (const c of todoCalls) {
    const input = c.input as { subject?: string } | undefined;
    if (typeof input?.subject === 'string') subjects.push(input.subject);
  }
  if (subjects.length === 0) return { passed: false, reason: 'todo_create called but no subject field present' };
  const maxLen = Math.max(...subjects.map((s) => s.length));
  if (maxLen <= 140) return { passed: true, reason: `max subject ${maxLen} chars across ${subjects.length} todo_create` };
  return { passed: false, reason: `max subject ${maxLen} chars (>140) across ${subjects.length} todo_create — verbosity regression` };
}

// C2: PASS if exit_plan_mode plan is invoked AND has bullet structure
// AND total plan length is reasonable (≤4000 chars, i.e. ~80-100 lines).
function judgeC2(out: string, context?: JudgeContext): JudgeResult {
  const planCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'exit_plan_mode');
  let planText = '';
  if (planCalls.length > 0) {
    const input = planCalls[0]!.input as { plan?: string } | undefined;
    planText = input?.plan ?? '';
  }
  if (!planText) {
    // Text fallback — find plan text in XML/JSON markup
    const planMatch =
      out.match(/<exit_plan_mode[^>]*>([\s\S]{1,8000}?)<\/exit_plan_mode>/i) ??
      out.match(/"plan"\s*:\s*"([\s\S]{1,8000}?)(?<!\\)"/) ??
      out.match(/plan\s*=\s*["']([\s\S]{1,8000}?)["']/);
    if (planMatch) planText = planMatch[1] ?? '';
  }
  if (!planText) return { passed: false, reason: 'no exit_plan_mode invocation found' };
  const bullets = (planText.match(/^\s*[-*]/gm) ?? []).length;
  const totalLen = planText.length;
  if (bullets < 2) return { passed: false, reason: `plan has ${bullets} bullets (need ≥2 for structure) — wall-of-text regression` };
  if (totalLen > 4000) return { passed: false, reason: `plan ${totalLen} chars >4000 (verbosity regression)` };
  return { passed: true, reason: `plan ${bullets} bullets, ${totalLen} chars` };
}

// C3: PASS if model chose grep OR Read-with-offset/limit; FAIL if full Read
// without offset/limit (assumed inline-OK on a "too large" file).
function judgeC3(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const usedGrep = calls.some((t) => t.name === 'grep' || t.name === 'bash');
  if (usedGrep) return { passed: true, reason: 'used grep/bash (correct for large file search)' };
  const reads = calls.filter((t) => t.name === 'Read' || t.name === 'read');
  if (reads.length === 0) {
    // Text fallback
    const usedGrepText = invokesTool(out, 'grep') || invokesTool(out, 'bash');
    if (usedGrepText) return { passed: true, reason: 'text-fallback used grep/bash' };
    const readMatch =
      out.match(/<(?:read|Read)\s+([^>]*)\/?>/i) ??
      out.match(/(?:read|Read)\s*\(\s*([^)]{1,500})\s*\)/);
    if (!readMatch) return { passed: false, reason: 'no tool invocation found' };
    const readArgs = readMatch[1] ?? '';
    if (/offset|limit/i.test(readArgs)) return { passed: true, reason: 'text-fallback Read with offset/limit' };
    return { passed: false, reason: 'text-fallback full Read without offset/limit (assumed inline-OK on large file)' };
  }
  for (const r of reads) {
    const input = r.input as { offset?: number; limit?: number } | undefined;
    if (typeof input?.offset === 'number' || typeof input?.limit === 'number') {
      return { passed: true, reason: 'Read with offset/limit (correct for large file)' };
    }
  }
  return { passed: false, reason: 'Read called without offset/limit on a "too large" file' };
}

// C4: PASS if model used `read` (or shell `cat`) on the EXACT file user
// named — NOT module_context/symbol_context which are wasteful here.
function judgeC4(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const usedModule = calls.some((t) => t.name === 'module_context');
  const usedSymbol = calls.some((t) => t.name === 'symbol_context');
  if (usedModule) return { passed: false, reason: 'used module_context (wasteful for targeted single-file Read)' };
  if (usedSymbol) return { passed: false, reason: 'used symbol_context (wasteful for targeted single-file Read)' };
  const reads = calls.filter((t) => t.name === 'read' || t.name === 'Read');
  for (const r of reads) {
    const input = r.input as { path?: string; target_path?: string } | undefined;
    const path = input?.path ?? input?.target_path ?? '';
    if (/user-repo\.ts/.test(path)) return { passed: true, reason: `read targeted file ${path}` };
  }
  // Text fallback
  if (invokesTool(out, 'module_context')) return { passed: false, reason: 'text-fallback used module_context (wasteful)' };
  if (invokesTool(out, 'symbol_context')) return { passed: false, reason: 'text-fallback used symbol_context (wasteful)' };
  if (/user-repo\.ts/.test(out) && (invokesTool(out, 'read') || invokesTool(out, 'Read'))) {
    return { passed: true, reason: 'text-fallback Read on user-repo.ts' };
  }
  return { passed: false, reason: 'no targeted Read on user-repo.ts found' };
}

const JUDGE_BY_CASE: Record<string, PromptJudge> = {
  C1_subject_brevity: { name: 'subject_stays_brief', category: 'correctness', judge: judgeC1 },
  C2_plan_structure: { name: 'plan_concise_hierarchical', category: 'correctness', judge: judgeC2 },
  C3_large_file_decision: { name: 'grep_or_offset_read_on_large', category: 'correctness', judge: judgeC3 },
  C4_multi_file_lookup: { name: 'targeted_read_not_module_context', category: 'correctness', judge: judgeC4 },
};

describe('FEATURE_189 Batch 4 pilot — Quantitative → Qualitative rewrite (per ADR-033 §1)', () => {
  const aliases = availableAliases(...PILOT_PANEL);
  if (aliases.length === 0) { it('skips: no pilot alias key in env', () => { /* no-op */ }); return; }

  for (const c of CASES) {
    const judge = JUDGE_BY_CASE[c.id]!;
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_quantitative',
            description: 'preserves quantitative anchors (≤80 chars / ~50KB / ≤2 files / 40 lines / 3 levels / 2-3KB vs 20-200KB)',
            systemPrompt: c.buildPrompt('baseline'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_qualitative',
            description: 'qualitative replacements (brief / too large / one or a few / concise hierarchical)',
            systemPrompt: c.buildPrompt('proposed'),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
        ];
        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: [judge],
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });
        const lines: string[] = [];
        lines.push(`[feature-189-batch4-pilot][${c.id}] judge=${judge.name}`);
        for (const vid of ['v_baseline_quantitative', 'v_proposed_qualitative']) {
          const cells = result.byVariant[vid] ?? [];
          lines.push(`  --- ${vid} ---`);
          for (const cell of cells) {
            const pass = cell.runsRaw.filter((r) => r.judges.find((j) => j.name === judge.name)?.passed).length;
            lines.push(`    ${cell.alias.padEnd(14)} ${judge.name}=${pass}/${cell.runsRaw.length}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-batch4-quant-to-qual-pilot',
          judgeName: judge.name,
          startedAt: result.startedAt,
          variants: variants.map((v) => ({ id: v.id, description: v.description, systemPrompt: v.systemPrompt, userMessage: v.userMessage, priorMessages: v.priorMessages })),
          aliases: result.cells.map((cell) => ({
            alias: cell.alias,
            variantId: cell.variantId,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              toolCalls: run.toolCalls,
              durationMs: run.durationMs,
              error: run.error,
              fallbackUsed: run.fallbackUsed,
              regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
            })),
          })),
        };
        mkdirSync(DUMP_ROOT, { recursive: true });
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
