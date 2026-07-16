/**
 * Pilot — FEATURE_189 Batch 5: child-executor prompt cleanup.
 *
 * child-executor.ts hosts the V2 dispatch_child_task system+user prompts
 * (CHILD_AGENT_SYSTEM_PROMPT + per-dispatch user message). Applies
 * ADR-033 §1 (quantitative→qualitative) and §3 (bare ✗ + WHY) per
 * Batch 1/2/4 validated pattern.
 *
 * Changes under test:
 *   - "3-7 iterations" → "efficiently" (qualitative)
 *   - "3-8 PARALLEL tool calls" → "parallel fan-out covering scope axes"
 *   - "Turn 1 / Turn 2-4 / Turn 5-7" prescriptive ladder → 3 use-case bullets
 *     (open broad / iterate narrow / synthesize early)
 *   - bare `Do NOT cd into invented paths` → add WHY (cwd fixed + subprocess)
 *   - bare `Do NOT modify any files` (read-only) → add WHY (investigation dispatch)
 *   - bare `Do NOT keep investigating for marginal coverage` → folded into
 *     positive "synthesize early" with WHY (extra iterations waste tokens)
 *   - bare `Do NOT call any more tools in your final response` → add WHY
 *     (re-opens turn, no new info to parent)
 *
 * 1 alias (ark/v4flash) × 4 case × 2 variant × 3 runs = 24 cells, ~$0.5.
 *
 * Cases:
 *   C1 — parallel fan-out (audit 4 packages, expect ≥3 parallel first-turn calls)
 *   C2 — read-only constraint respect (read-only task, no write/edit/bash mutation)
 *   C3 — pull-tool leadership (module exploration → module_context first)
 *   C4 — cwd discipline (no cd into invented paths)
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch5-child-executor-pilot
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
  'feature-189-batch5-child-executor-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = { 'ark/v4flash': 'ds/v4flash' };
const RUNS_PER_CELL = 3;

// ============================================================
// v_baseline (current prompt — quantitative anchors + bare ✗)
// ============================================================

const SYS_BASELINE = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — ALWAYS Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, you MUST emit them all in the SAME response.',
  'The execution engine runs non-bash tools concurrently via Promise.all — serial calls waste time.',
  '',
  'Concrete rules:',
  '- For module exploration or change review, LEAD with pull-tools (`module_context` / `symbol_context` / `changed_scope` / `changed_diff_bundle`) — each replaces 5-10 read+grep calls.',
  '- For single-file lookup or byte-exact verification, use `glob` + `grep` + targeted `read`.',
  '- When you need multiple independent tool calls (pull-tools, reads, or greps), emit ALL in one response — do NOT serialize.',
  '- Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- A typical first turn should have 3-8 parallel tool calls.',
  '- Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only (no tool calls) — the parent agent will use it directly.',
].join('\n');

function userBaseline(opts: { objective: string; readOnly: boolean; cwd: string }): string {
  return [
    '# Child Agent Task',
    '',
    'You are a focused sub-agent executing a specific task in parallel with siblings.',
    'Complete this task QUICKLY — aim for 3-7 iterations. You have a hard limit of 20 iterations.',
    '',
    '## Environment',
    `Working Directory: ${opts.cwd}`,
    'Platform: Windows',
    `All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT \`cd\` into invented paths.`,
    '',
    '## Objective',
    opts.objective,
    '',
    '## Constraints',
    opts.readOnly
      ? '- This is a READ-ONLY task. Do NOT modify any files.'
      : '- You may modify files within the scope listed above.',
    '- You CANNOT spawn child agents or call dispatch_child_tasks.',
    '',
    '## Execution Strategy (IMPORTANT: use parallel tool calls)',
    '- Turn 1: Scope scan — emit 3-8 PARALLEL tool calls: glob for structure + grep for key patterns + read critical files. All in ONE response.',
    '- Turn 2-4: Deep targeted reads — again emit MULTIPLE reads in parallel for any files identified in Turn 1.',
    '- Turn 5-7: Synthesize findings. If done, respond with TEXT ONLY (no more tool calls).',
    '- STOP as soon as you have sufficient evidence. Do NOT keep investigating for marginal coverage.',
    '- Your response WITHOUT tool calls signals completion. The parent agent will take over from there.',
  ].join('\n');
}

// ============================================================
// v_proposed (Batch 5 changes — qualitative + ✗+WHY)
// ============================================================

const SYS_PROPOSED = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, emit them all in the SAME response. The execution engine runs non-bash tools concurrently via Promise.all, so serial calls add real wall-clock latency the parent waits on.',
  '',
  'Concrete rules:',
  '- For module exploration or change review, lead with pull-tools (`module_context` / `symbol_context` / `changed_scope` / `changed_diff_bundle`) — each replaces several read+grep calls so the same investigation finishes in fewer turns.',
  '- For single-file lookup or byte-exact verification, use `glob` + `grep` + targeted `read`.',
  '- When you need multiple independent tool calls (pull-tools, reads, or greps), emit them all in one response. Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- Open broad with a parallel fan-out covering the obvious scope axes, then narrow on follow-up turns. Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only — the parent reads your text directly as the dispatch result, and a final tool call would re-open the turn and force another LLM round without giving the parent new information.',
].join('\n');

function userProposed(opts: { objective: string; readOnly: boolean; cwd: string }): string {
  return [
    '# Child Agent Task',
    '',
    'You are a focused sub-agent executing a specific task in parallel with siblings.',
    'Complete this task efficiently — every iteration the parent waits on adds end-to-end latency. You have a hard limit of 20 iterations.',
    '',
    '## Environment',
    `Working Directory: ${opts.cwd}`,
    'Platform: Windows',
    `All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT \`cd\` into invented paths — the working directory is fixed for the duration of this task, and each \`bash\` call runs in a fresh subprocess so a \`cd\` would not persist across calls anyway.`,
    '',
    '## Objective',
    opts.objective,
    '',
    '## Constraints',
    opts.readOnly
      ? '- This is a READ-ONLY task. Do NOT modify any files — the parent dispatched this child specifically for investigation, and a sibling write-child (or the parent itself) will handle any mutations the findings imply.'
      : '- You may modify files within the scope listed above.',
    '- You CANNOT spawn child agents or call dispatch_child_tasks — recursion is disabled at the tool layer to keep fan-out bounded.',
    '',
    '## Execution Strategy (use parallel tool calls)',
    '- Open broad: scope-scan turn emits parallel `glob` for structure + `grep` for key patterns + `read` on the obvious entry files, all in one response.',
    '- Iterate narrow: deep-read on files identified by the scope scan, again emitting multiple reads in parallel per turn.',
    `- Synthesize early: stop investigating once the evidence is sufficient to answer the objective. Extra iterations waste tokens and delay the parent's synthesis.`,
    '- Signal completion with a text-only response (no tool calls). Any final tool call re-opens the turn and forces another LLM round without giving the parent new information.',
  ].join('\n');
}

// ============================================================
// Cases
// ============================================================

interface CaseBundle {
  readonly id: string;
  readonly objective: string;
  readonly readOnly: boolean;
  readonly cwd: string;
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

const CASE_C1: CaseBundle = {
  id: 'C1_parallel_fanout',
  objective:
    'Audit the auth module across four packages: packages/auth, packages/api, packages/web, packages/cli. ' +
    'For each package, identify the file(s) implementing authentication primitives and report the public API surface.',
  readOnly: true,
  cwd: 'C:\\Works\\GitWorks\\KodaX',
};

const CASE_C2: CaseBundle = {
  id: 'C2_readonly_respect',
  objective:
    'Investigate whether the `formatTimestamp` helper in packages/utils/src/time.ts is consistent with the ISO-8601 ' +
    'standard used elsewhere in the repo. Report the helper signature, current behavior, and any inconsistency.',
  readOnly: true,
  cwd: 'C:\\Works\\GitWorks\\KodaX',
};

const CASE_C3: CaseBundle = {
  id: 'C3_pulltool_leadership',
  objective:
    'Explore the structure of the packages/cache module: what does it export, what does it depend on, what are its ' +
    'main entry files, and what tests cover it. Report a compact module overview.',
  readOnly: true,
  cwd: 'C:\\Works\\GitWorks\\KodaX',
};

const CASE_C4: CaseBundle = {
  id: 'C4_cwd_discipline',
  objective:
    'Find where `getUserById` is defined in this repo. The file is somewhere under packages/auth/. Once found, ' +
    'read the function and report its signature, return type, and what data store it queries.',
  readOnly: true,
  cwd: 'C:\\Works\\GitWorks\\KodaX',
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

// C1: PASS if first turn emits ≥3 parallel tool calls (binding OR text markup)
function judgeC1(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  if (calls.length >= 3) return { passed: true, reason: `${calls.length} binding tool calls` };
  // Text fallback: count tool markup occurrences
  const toolNames = ['glob', 'grep', 'read', 'Read', 'module_context', 'changed_scope', 'bash'];
  let count = 0;
  for (const name of toolNames) {
    if (invokesTool(out, name)) count++;
  }
  if (count >= 3) return { passed: true, reason: `text-fallback ${count} tool kinds invoked` };
  return { passed: false, reason: `only ${calls.length} binding / ${count} text tool calls (need ≥3 for parallel fan-out on 4-package audit)` };
}

// C2: PASS if no write/edit/bash-mutation tool invoked
function judgeC2(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const mutationToolNames = ['write', 'edit', 'multi_edit'];
  for (const c of calls) {
    if (mutationToolNames.includes(c.name)) {
      return { passed: false, reason: `read-only constraint violated: invoked ${c.name}` };
    }
    if (c.name === 'bash') {
      const cmd = (c.input as { command?: string } | undefined)?.command ?? '';
      if (/\b(rm|mv|cp|>\s*[^<&|]|>>|sed -i|cat\s+>|tee|chmod|chown)\b/.test(cmd)) {
        return { passed: false, reason: `bash mutation detected: ${cmd.slice(0, 60)}` };
      }
    }
  }
  // Text fallback: check for write/edit markup
  if (invokesTool(out, 'write') || invokesTool(out, 'edit') || invokesTool(out, 'multi_edit')) {
    return { passed: false, reason: 'text-fallback write/edit/multi_edit markup found in read-only context' };
  }
  return { passed: true, reason: 'no mutation tool invoked' };
}

// C3: PASS if module_context (or other pull-tool) is invoked for module exploration
function judgeC3(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const pullTools = ['module_context', 'symbol_context', 'changed_scope', 'repo_overview'];
  for (const c of calls) {
    if (pullTools.includes(c.name)) return { passed: true, reason: `pull-tool ${c.name} invoked` };
  }
  // Text fallback
  for (const name of pullTools) {
    if (invokesTool(out, name)) return { passed: true, reason: `text-fallback pull-tool ${name} invoked` };
  }
  // Acceptable degraded path: ≥3 read/grep calls in parallel covering scope (still PASS if pull-tools unavailable)
  const readGrepCount = calls.filter((c) => ['read', 'Read', 'grep', 'glob'].includes(c.name)).length;
  if (readGrepCount >= 4) return { passed: true, reason: `degraded path: ${readGrepCount} read/grep parallel calls (pull-tool not invoked but scope covered)` };
  return { passed: false, reason: `no pull-tool invoked for module exploration; only ${readGrepCount} read/grep calls` };
}

// C4: PASS if no `cd` to non-cwd path in any bash call
function judgeC4(out: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  for (const c of calls) {
    if (c.name === 'bash') {
      const cmd = (c.input as { command?: string } | undefined)?.command ?? '';
      // Allow `cd packages/...` (relative) but flag absolute / parent-traversal cd
      if (/\bcd\s+(\/|[A-Z]:\\|\.\.)/i.test(cmd)) {
        return { passed: false, reason: `cd to non-cwd path: ${cmd.slice(0, 80)}` };
      }
    }
  }
  // Text fallback: check for cd usage in bash markup
  const bashCdMatch = out.match(/<bash[^>]*>[\s\S]*?cd\s+(\/|[A-Z]:\\|\.\.)[\s\S]*?<\/bash>/i);
  if (bashCdMatch) {
    return { passed: false, reason: `text-fallback bash cd to non-cwd detected` };
  }
  return { passed: true, reason: 'no cd into invented/absolute paths' };
}

const JUDGE_BY_CASE: Record<string, PromptJudge> = {
  C1_parallel_fanout: { name: 'parallel_fanout_3plus', category: 'correctness', judge: judgeC1 },
  C2_readonly_respect: { name: 'no_mutation_in_readonly', category: 'correctness', judge: judgeC2 },
  C3_pulltool_leadership: { name: 'pulltool_first_for_module', category: 'correctness', judge: judgeC3 },
  C4_cwd_discipline: { name: 'no_cd_to_invented_path', category: 'correctness', judge: judgeC4 },
};

describe('FEATURE_189 Batch 5 pilot — child-executor.ts CHILD_AGENT_SYSTEM_PROMPT + per-dispatch prompt', () => {
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
            id: 'v_baseline_quantitative_bare_negation',
            description: '3-7 iterations / 3-8 parallel / Turn 1/2-4/5-7 ladder / bare ✗',
            systemPrompt: SYS_BASELINE + '\n\n' + userBaseline({ objective: c.objective, readOnly: c.readOnly, cwd: c.cwd }),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.objective,
          },
          {
            id: 'v_proposed_qualitative_with_why',
            description: 'efficiently / parallel fan-out / use-case bullets / ✗+WHY',
            systemPrompt: SYS_PROPOSED + '\n\n' + userProposed({ objective: c.objective, readOnly: c.readOnly, cwd: c.cwd }),
            priorMessages: c.priorMessages ?? [],
            userMessage: c.objective,
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
        lines.push(`[feature-189-batch5-pilot][${c.id}] judge=${judge.name}`);
        for (const vid of ['v_baseline_quantitative_bare_negation', 'v_proposed_qualitative_with_why']) {
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
          stage: 'feature-189-batch5-child-executor-pilot',
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
