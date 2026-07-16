/**
 * Pilot — FEATURE_189 Batch 1: ✗ 加 WHY (10 mid-risk bare negations gain mechanism clauses).
 *
 * 1 alias (ark/v4flash, cheapest coding-plan floor) × 4 case × 2 variant ×
 * 3 runs = 24 cells, ~$0.50, ~5 min wall.
 *
 * ## Purpose (per `feedback_eval_pilot_before_scale`)
 *
 * Verify signal exists on at least one case before scaling to 5-alias panel.
 *
 * Variants:
 *   v_baseline_bare    — 9 production bare ✗ clauses preserved as currently in
 *                        registry.ts / worker-role-prompt.ts / system.ts
 *   v_proposed_with_why — 9 bare clauses gain mechanism `because/since` WHY
 *                        per claudecode AgentTool/BashTool because-clause style
 *
 * Cases (one per representative ✗ pattern):
 *   A — scratch file discipline       (worker:106 / system:52 — write target path)
 *   B — multi-independent questions   (registry:880 / system:104 — ask_user_question shape)
 *   C — mid-task send_message         (registry:539 — send_message restraint)
 *   D — edit fail recovery            (registry:293 — don't fallback to write)
 *
 * ## SHIP gate (Batch 1)
 *
 *   (a) per-case PASS rate: v_proposed ≥ v_baseline − 1 cell per alias × case
 *   (b) anti-pattern suppression: v_proposed PASS rate ≥ v_baseline
 *   (c) audit disagreement ≤ 10% → DATA VALID
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch1-anti-pattern-why-pilot
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
  'feature-189-batch1-anti-pattern-why-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// ---------- v_baseline_bare (production bare ✗) ----------

const BASELINE_PROMPT = [
  "You are the Worker — KodaX's primary agent for this task.",
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  '',
  '## Error Handling',
  '',
  'When a tool call returns an error:',
  '1. STOP and READ the error message carefully',
  '2. DO NOT repeat the same tool call with the same parameters',
  '3. Identify what\'s wrong',
  '',
  'If you truly need a script:',
  '- Do NOT create temporary scripts or scratch files in the project root',
  '- Write them to `.agent/tmp/` (relative to the git root)',
  '',
  '## Mutation discipline',
  '',
  '- NEVER route a single known-content file through `bash` heredocs. Use `write` or `edit`.',
  '- Workspace discipline: scratch files go under `.agent/tmp/` (relative to git root). NEVER write scratch to project root or system tmp.',
  '',
  '## Asking user questions',
  '',
  'When you need user input, use `ask_user_question`.',
  '- For **multiple independent questions**, use the `questions` array (1-4 items). Each question has its own `question`, `header`, `options`. Do NOT combine multiple questions into a single question string with pre-combined option combinations.',
  '',
  '## Dispatch',
  '',
  '- `send_message(to=task_id, content)` — append refinement to in-flight child. DO NOT spam (typical pattern: 0-1 send_message per child).',
  '',
  '## Edit recovery',
  '',
  '- If `edit` fails with "old_string not found", retry with a smaller unique snippet or use `insert_after_anchor`; do NOT fall back to `write` for the whole file as a recovery.',
  '',
  'Tools you have on this turn:',
  '',
  '`write({ path: string, content: string })` — create or overwrite file',
  '`edit({ path, old_string, new_string })` — replace exact snippet in file',
  '`bash({ command: string })` — run shell command',
  '`read({ path: string, offset?, limit? })` — read file',
  '`ask_user_question({ questions: [{ question, header, options[] }], OR question, options[] })` — ask user',
  '`dispatch_child_task({ id, objective, readOnly?, model_hint? })` — launch child task',
  '`send_message({ to: task_id, content: string })` — send instruction to running child',
].join('\n');

// ---------- v_proposed_with_why (same prompt + WHY clauses) ----------

const PROPOSED_PROMPT = [
  "You are the Worker — KodaX's primary agent for this task.",
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  '',
  '## Error Handling',
  '',
  'When a tool call returns an error:',
  '1. STOP and READ the error message carefully',
  '2. DO NOT repeat the same tool call with the same parameters — a re-issue with identical params almost always lands in a retry loop that wastes tokens without producing new information. Vary the params or switch to a different tool',
  '3. Identify what\'s wrong',
  '',
  'If you truly need a script:',
  '- Do NOT create temporary scripts or scratch files in the project root — they leak into `git status` and file listings, confusing the user about what was actually changed',
  '- Write them to `.agent/tmp/` (relative to the git root)',
  '',
  '## Mutation discipline',
  '',
  '- NEVER route a single known-content file through `bash` heredocs — use `write` or `edit` instead. Heredoc routing bypasses mutation tracking and diff visibility; the file lands without an edit record so reviewers cannot see what changed.',
  '- Workspace discipline: scratch files go under `.agent/tmp/` (relative to git root). NEVER write scratch to project root or system tmp — project root pollutes the user\'s repo (shows up in `git status` and file listings), and system tmp gets reclaimed by the OS before you can re-read it.',
  '',
  '## Asking user questions',
  '',
  'When you need user input, use `ask_user_question`.',
  '- For **multiple independent questions**, use the `questions` array (1-4 items). Each question has its own `question`, `header`, `options`. Do NOT combine multiple questions into a single question string with pre-combined option combinations, because that forces the user to mentally disambiguate combinations and breaks the option-button UI.',
  '',
  '## Dispatch',
  '',
  '- `send_message(to=task_id, content)` — append refinement to in-flight child. Use it sparingly (typical pattern: 0-1 send_message per child), because a child needing more context mid-flight is usually a planning failure: you did not brief it well enough up front.',
  '',
  '## Edit recovery',
  '',
  '- If `edit` fails with "old_string not found", retry with a smaller unique snippet or use `insert_after_anchor`; do NOT fall back to `write` for the whole file as a recovery, because that discards the partial-edit context and re-streams the entire file — exactly what `edit` was designed to avoid.',
  '',
  'Tools you have on this turn:',
  '',
  '`write({ path: string, content: string })` — create or overwrite file',
  '`edit({ path, old_string, new_string })` — replace exact snippet in file',
  '`bash({ command: string })` — run shell command',
  '`read({ path: string, offset?, limit? })` — read file',
  '`ask_user_question({ questions: [{ question, header, options[] }], OR question, options[] })` — ask user',
  '`dispatch_child_task({ id, objective, readOnly?, model_hint? })` — launch child task',
  '`send_message({ to: task_id, content: string })` — send instruction to running child',
].join('\n');

// ---------- Cases ----------

interface CaseBundle {
  readonly id: string;
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

// Case A: scratch file discipline — model should write to .agent/tmp/ not project root
const CASE_A: CaseBundle = {
  id: 'A_scratch_path',
  userMessage:
    'Write a quick throwaway python script that counts lines in all .ts files under packages/. ' +
    'I just want to see the counts in stdout — no need to keep the script around.',
};

// Case B: multi-independent questions — model should use `questions` array, not combine
const CASE_B: CaseBundle = {
  id: 'B_multi_question',
  userMessage:
    "Before I implement the auth module, ask me two things: (1) database choice between Postgres or MySQL, " +
    "and (2) session storage between Redis or in-memory. They're independent decisions so don't combine them.",
};

// Case C: mid-task send_message — model should NOT spam follow-ups
const CASE_C: CaseBundle = {
  id: 'C_send_message_restraint',
  userMessage:
    'I want to audit auth handlers across packages/auth and packages/api in parallel. Launch two read-only ' +
    "child tasks, one per package. Don't send any follow-up messages to them — the original objective should " +
    'be enough.',
};

// Case D: edit fail recovery — model should retry edit smaller, not write whole file
const CASE_D: CaseBundle = {
  id: 'D_edit_fail_recovery',
  userMessage:
    'Please continue the rename — finish replacing the remaining `oldHandler` occurrences with `newHandler`.',
  priorMessages: [
    {
      role: 'assistant',
      content:
        'I\'ll start by reading the auth.ts file to confirm the rename targets.\n\n' +
        '<tool_call>read({"path":"packages/auth/auth.ts"})</tool_call>',
    },
    {
      role: 'user',
      content:
        '[tool_result] export function oldHandler(req: Request) {\n  return processAuth(req);\n}\n\nexport function processAuth(req: Request) {\n  return req.headers.authorization;\n}',
    },
    {
      role: 'assistant',
      content:
        'Now I will rename `oldHandler` to `newHandler`.\n\n' +
        '<tool_call>edit({"path":"packages/auth/auth.ts","old_string":"function oldHandler","new_string":"function newHandler"})</tool_call>',
    },
    {
      role: 'user',
      content: '[tool_error] edit failed: old_string "function oldHandler" not found (the file content may have shifted).',
    },
  ],
};

const CASES: readonly CaseBundle[] = [CASE_A, CASE_B, CASE_C, CASE_D] as const;

// ---------- Judges (one per case, since each tests different anti-pattern) ----------

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

// Case A: PASS if model avoids creating a file in project root.
//   PASS conditions:
//     - write/bash with path under .agent/tmp/ or /tmp/ or tempfile/mkdtemp
//     - inline shell one-liner (python3 -c, bash -c, no file creation) — markdown code block ok
//     - no file written at all (narration only)
//   FAIL conditions:
//     - write call with project-root path (e.g. write({path:"count.py"}) or similar bare filename)
function judgeCaseA(out: string, context?: JudgeContext): JudgeResult {
  const writeCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'write' || t.name === 'bash');
  // Examine binding write paths for project-root violations
  for (const c of writeCalls) {
    const input = c.input as { path?: string; command?: string } | undefined;
    if (typeof input?.path === 'string') {
      const p = input.path.toLowerCase();
      if (/\.agent\/tmp\/|\/tmp\/|tempfile|mkdtemp/.test(p)) return { passed: true };
      // Project-root violation: bare filename or path not under tmp
      if (/\.(py|sh|ts|js|mjs)$/.test(p) && !/\/tmp\/|\.agent\//.test(p)) {
        return { passed: false, reason: `write to project root: ${input.path}` };
      }
    }
    if (typeof input?.command === 'string') {
      const cmd = input.command;
      // Inline one-liner (no file creation) — PASS
      if (/python3?\s+-c|bash\s+-c|^find\b|^ls\b|^wc\b|^echo\b/i.test(cmd.trim()) && !/\bcat\s*>\s*[^\s|]+\.\w+|\becho\s.*>\s*[^\s|]+\.\w+|\bheredoc\b|<<\s*['"]?EOF/.test(cmd)) {
        return { passed: true };
      }
      // Heredoc to project-root file — FAIL
      if (/<<\s*['"]?EOF[\s\S]+EOF/.test(cmd) || /\bcat\s*>\s*[^\s|]+\.\w+/.test(cmd) || /\becho\s+["'][\s\S]+?["']\s*>\s*[^\s|]+\.\w+/.test(cmd)) {
        return { passed: false, reason: `bash heredoc/redirect creating file in project root: ${cmd.slice(0, 80)}` };
      }
    }
  }
  // Text fallback — check for project-root file creation pattern in raw text
  // PASS: inline one-liner or tmp path used
  if (/\.agent\/tmp\/|\/tmp\/|tempfile|mkdtemp/.test(out)) return { passed: true };
  if (/python3?\s+-c|bash\s+-c/i.test(out) && !/<<\s*['"]?EOF|cat\s*>\s*\S+\.\w+/.test(out)) return { passed: true };
  // FAIL: write tool markup with bare filename
  const badWrite = out.match(/write\s*\(\s*\{\s*[^}]*path[^}]*:\s*['"`]([^'"`]+\.\w+)['"`]/i);
  if (badWrite) {
    const p = badWrite[1]!;
    if (!/\/tmp\/|\.agent\//.test(p)) return { passed: false, reason: `text shows write to project root: ${p}` };
  }
  // Default: no file creation → PASS (model reasonably avoided)
  return { passed: true };
}

// Case B: PASS if ask_user_question called with `questions` array of length ≥2 (any markup form).
//   Accepts: questions={[...]}, "questions":[...], questions: [...], JSON-in-XML variants
//   FAIL: single combined-question form OR no invocation at all
function judgeCaseB(out: string, context?: JudgeContext): JudgeResult {
  // 1. Binding path
  const askCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'ask_user_question');
  for (const c of askCalls) {
    const input = c.input as { questions?: unknown[]; question?: string; options?: unknown[] } | undefined;
    if (Array.isArray(input?.questions) && input.questions.length >= 2) {
      return { passed: true };
    }
    if (typeof input?.question === 'string' && Array.isArray(input?.options)) {
      const combinedQuestion = /\bAND\b|\+|both/i.test(input.question)
        || (Array.isArray(input.options) && input.options.length > 4);
      if (combinedQuestion) return { passed: false, reason: 'combined into single question (anti-pattern)' };
    }
  }
  // 2. Text fallback — match any `questions` (plural) keyword followed eventually by `[`,
  //    AND text contains ≥2 individual `question` (singular, separated by quote/colon) fields
  const hasQuestionsArray = /["']?questions["']?\s*[:=]\s*[{[]/i.test(out)
    || /<\s*ask_user_question[^>]*questions/i.test(out);
  // Accept both quoted "question": and unquoted question: (JS-style object literal)
  const singularQuestionMatches = out.match(/\bquestion\s*:/gi) ?? [];
  if (hasQuestionsArray && singularQuestionMatches.length >= 2) {
    return { passed: true };
  }
  // 3. Detect combined anti-pattern in text
  const combinedAntiPattern = /\bquestion\s*:\s*["'][^"']*\b(?:AND|and|\+|both)\b/i.test(out)
    || /options[\s\S]{0,200}(?:postgres\s*\+|postgres\s*and\s*aws|mysql\s*\+|mysql\s*and\s*gcp)/i.test(out);
  if (combinedAntiPattern) return { passed: false, reason: 'combined questions detected in text (anti-pattern)' };
  if (invokesTool(out, 'ask_user_question')) {
    // Invocation present but no questions[] array → might be single-question form
    return { passed: false, reason: 'ask_user_question invoked but not in questions[] array shape' };
  }
  return { passed: false, reason: 'ask_user_question not invoked' };
}

// Case C: PASS if model dispatches 2 children AND does NOT call send_message
function judgeCaseC(out: string, context?: JudgeContext): JudgeResult {
  const dispatchCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'dispatch_child_task');
  const sendMsgCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'send_message');
  const dispatchInText = (out.match(/\bdispatch_child_task\b/gi) ?? []).length;
  const sendMsgInText = invokesTool(out, 'send_message');
  if (sendMsgCalls.length > 0 || sendMsgInText) {
    return { passed: false, reason: 'send_message invoked despite user saying not to' };
  }
  if (dispatchCalls.length >= 2 || dispatchInText >= 2) {
    return { passed: true };
  }
  if (invokesTool(out, 'dispatch_child_task')) {
    return { passed: false, reason: 'only 1 dispatch found; needs 2 parallel children' };
  }
  return { passed: false, reason: 'no dispatch_child_task invocation' };
}

// Case D: PASS if model emits actual edit/multi_edit/read/insert_after_anchor markup (binding OR text).
//   FAIL if (a) write fallback for whole file, OR (b) pure narration without tool markup
//     ("Let me re-read..." with no actual <tool_call>read(...)</tool_call> is FAIL — model gave up).
//   Aligned with LLM-judge prompt strict rule per
//   `feedback_regex_judge_semantic_must_align`: narration-only = FAIL.
function judgeCaseD(out: string, context?: JudgeContext): JudgeResult {
  const editCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'edit' || t.name === 'multi_edit' || t.name === 'insert_after_anchor');
  const readCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'read');
  const writeCalls = (context?.toolCalls ?? []).filter((t) => t.name === 'write');
  // Anti-pattern: write whole file as recovery
  for (const w of writeCalls) {
    const input = w.input as { content?: string } | undefined;
    if (typeof input?.content === 'string' && input.content.length > 100) {
      return { passed: false, reason: `fell back to write for whole file (anti-pattern, content ${input.content.length} chars)` };
    }
  }
  // PASS if binding has edit/read/multi_edit/insert_after_anchor
  if (editCalls.length > 0 || readCalls.length > 0) return { passed: true };
  // PASS if text has actual tool markup for retry (any of the 7 syntaxes)
  if (invokesTool(out, 'edit') || invokesTool(out, 'multi_edit') || invokesTool(out, 'insert_after_anchor') || invokesTool(out, 'read')) return { passed: true };
  if (invokesTool(out, 'write')) {
    return { passed: false, reason: 'write invoked instead of edit retry' };
  }
  // No tool markup → narration only → FAIL (model gave up without acting)
  return { passed: false, reason: 'narration-only without tool markup (model did not actually retry)' };
}

const JUDGE_BY_CASE: Record<string, PromptJudge> = {
  A_scratch_path: { name: 'scratch_path_discipline', category: 'correctness', judge: judgeCaseA },
  B_multi_question: { name: 'multi_question_shape', category: 'correctness', judge: judgeCaseB },
  C_send_message_restraint: { name: 'send_message_restraint', category: 'correctness', judge: judgeCaseC },
  D_edit_fail_recovery: { name: 'edit_recovery_no_write_fallback', category: 'correctness', judge: judgeCaseD },
};

describe('FEATURE_189 Batch 1 pilot — ✗ 加 WHY (10 mid-risk bare → because-clause)', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    const judge = JUDGE_BY_CASE[c.id]!;
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_bare',
            description: 'current production with bare ✗ clauses',
            systemPrompt: BASELINE_PROMPT,
            priorMessages: c.priorMessages ?? [],
            userMessage: c.userMessage,
          },
          {
            id: 'v_proposed_with_why',
            description: '9 bare ✗ clauses gain because/since WHY mechanism clauses',
            systemPrompt: PROPOSED_PROMPT,
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
        lines.push(`[feature-189-batch1-pilot][${c.id}] judge=${judge.name}`);
        for (const variantId of ['v_baseline_bare', 'v_proposed_with_why']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const pass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === judge.name)?.passed,
            ).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} ${judge.name}=${pass}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-189-batch1-anti-pattern-why-pilot',
          judgeName: judge.name,
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
            userMessage: v.userMessage,
            priorMessages: v.priorMessages,
          })),
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
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
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
