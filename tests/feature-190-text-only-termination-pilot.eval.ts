/**
 * Pilot — FEATURE_190 Phase 2b text-only termination trigger validation.
 *
 * 1 alias (ark/v4flash) × 1 case × 2 variant × 3 runs = 6 cells, ~$0.30,
 * ~3-5 min wall.
 *
 * Purpose per `feedback_eval_pilot_before_scale`: verify both V_baseline
 * (current EVALUATOR HANDOFF + emit_handoff in tools) and V_new
 * (TERMINATION + emit_handoff removed) trigger DIFFERENT behavior on
 * the canonical "all-todos-completed" scenario. If pilot signal is
 * clear, proceed to the 200-cell panel; if pilot shows V_baseline
 * doesn't reliably call emit_handoff or V_new doesn't reliably go
 * text-only → rewrite case before panel.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-190-text-only-termination-pilot
 *
 * ## Pre-registered pilot pass criteria
 *
 *   - V_baseline: ≥2/3 runs call emit_handoff (regex OR binding)
 *   - V_new: ≥2/3 runs produce text-only response (NO emit_handoff,
 *     NO other tool call), AND ≥2/3 runs contain a summary keyword
 *     (done / completed / summary / finished / wrap)
 *   - Disagreement between V_baseline and V_new on emit_handoff
 *     invocation ≥2/3 runs (the prompt + tool removal MUST measurably
 *     change behavior)
 *
 * If ANY of the above fails → DEFER F190 Phase 2 prompt change pending
 * prompt iteration. The Phase 0+1 architecture changes already shipped
 * are independent and stay live.
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
  'feature-190-text-only-termination-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// Tools advertised to the model. V_baseline keeps emit_handoff;
// V_new removes it (matching the post-F190 Phase 3 tool surface).
const TOOL_DOCS_WITH_EMIT_HANDOFF = [
  'Tools you have on this turn:',
  '',
  '`emit_handoff`:',
  '  Input:  { status:"ready"|"incomplete"|"blocked", summary:string, evidence?:string[], followup?:string[] }',
  '  Output: signals the Generator handoff to the Evaluator.',
  '',
  '`read` / `grep` / `bash` / `write` / `edit` / `todo_update`: standard tools.',
].join('\n');

const TOOL_DOCS_WITHOUT_EMIT_HANDOFF = [
  'Tools you have on this turn:',
  '',
  '`read` / `grep` / `bash` / `write` / `edit` / `todo_update`: standard tools.',
  '',
  'NOTE: There is no `emit_handoff` tool. To terminate, end your turn with',
  'a text-only summary — no tool call required.',
].join('\n');

// Worker prompt fragments — extracted from the production prompt
// (worker-role-prompt.ts) to keep the pilot prompt LLM-equivalent to
// the production turn while staying single-turn-probe sized.
const WORKER_PREAMBLE = [
  "You are the Worker — KodaX's single primary agent for this task. Routing decision summary:",
  '- Primary task: edit',
  '- Work intent: bug-fix',
  '- Risk: low',
  '- Complexity: medium',
  '- Brainstorm required: no',
].join('\n');

const HANDOFF_RULES_BASELINE = [
  'EVALUATOR HANDOFF (KodaX structural gate, preserved as an independent role):',
  '- When your plan is complete (all non-cancelled items `completed`), call `emit_handoff` with the artifacts you want the Evaluator to audit.',
  '- The Evaluator runs in a fresh read-only session, audits your changes, and returns `accept` (terminal success), `revise` (your turn again — fix the called-out issues), or `blocked` (terminal failure).',
  '- You CANNOT bypass the Evaluator. Trying to terminate the run with a final text answer instead of `emit_handoff` will be rejected by the runner.',
].join('\n');

const TERMINATION_RULES_NEW = [
  'TERMINATION:',
  '- When all non-cancelled plan items are `completed`, end your turn with a brief text-only summary covering what you did, what changed (files / behavior), and any caveats. No tool call needed to terminate — the absence of a `tool_use` block on your final assistant message IS the terminal signal.',
  '- If you cannot proceed (e.g. user-input blocker, irrecoverable failure), end your turn with a text-only summary of the blocker. Mark the affected plan items `failed` with a note BEFORE the final summary turn so the dashboard reflects the blocked state.',
  '- After your terminal turn, an independent Sidecar Verifier reads your work in a fresh read-only session and decides accept (success) / revise (your turn again, fix the called-out issues) / blocked (terminal failure). You do not call the verifier — it runs automatically.',
].join('\n');

function buildSystemPrompt(handoffOrTermination: string, toolDocs: string): string {
  return [
    WORKER_PREAMBLE,
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    handoffOrTermination,
    '',
    toolDocs,
  ].join('\n');
}

// Canonical "all-todos-completed" case (C1).
// Multi-turn priorMessages establish state; final user message asks
// Worker to converge.
const PRIOR_MESSAGES_C1 = [
  {
    role: 'user' as const,
    content:
      'Fix the session-validation bug in packages/auth/handler.ts. The bug is that ' +
      'expired sessions still pass validation when the `expires_at` field is null.',
  },
  {
    role: 'assistant' as const,
    content:
      "I'll plan this work and then execute. Three steps:\n" +
      "1. Read packages/auth/handler.ts to see current validation logic.\n" +
      "2. Edit to handle the null expires_at case.\n" +
      "3. Verify with the test suite.\n\n" +
      '(turn 1 — planning, todos created via todo_create)',
  },
  {
    role: 'user' as const,
    content: '[turn 2 abbreviated — assistant read the file, edited it, ran tests; all 3 todos now `completed`]',
  },
];

const USER_MESSAGE_C1 =
  "Confirmed — the fix looks good and tests all pass. All 3 plan items are now `completed`. " +
  "Please give me a brief summary of what was done.";

interface CaseBundle {
  readonly id: string;
  readonly priorMessages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
}

const CASES: readonly CaseBundle[] = [
  {
    id: 'all_todos_completed_summarize',
    priorMessages: PRIOR_MESSAGES_C1,
    userMessage: USER_MESSAGE_C1,
  },
] as const;

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

// Judges (mechanical, regex + binding-aware per EVAL_GUIDELINES anti-pattern 7).
function judgeEmitHandoffCalled(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.some((t) => t.name === 'emit_handoff')) return { passed: true };
  if (invokesTool(out, 'emit_handoff')) return { passed: true };
  return { passed: false, reason: 'emit_handoff NOT invoked (binding + 4-syntax regex empty)' };
}

function judgeTextOnlyTermination(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.length > 0) {
    return { passed: false, reason: `tool_use blocks present (${toolCalls.map((t) => t.name).join(',')})` };
  }
  // Negative regex sweep — no tool-call syntax in text either (4-syntax).
  for (const tool of ['emit_handoff', 'read', 'grep', 'bash', 'write', 'edit', 'todo_update']) {
    if (invokesTool(out, tool)) {
      return { passed: false, reason: `text contains tool-call syntax for ${tool}` };
    }
  }
  return { passed: true };
}

function judgeSummaryContent(out: string): JudgeResult {
  // Positive content check — model must produce summary-shape text.
  const keywords = ['done', 'completed', 'summary', 'finished', 'wrap', 'fixed', 'applied', 'changes'];
  const lower = out.toLowerCase();
  if (keywords.some((k) => lower.includes(k))) return { passed: true };
  return { passed: false, reason: `no summary keyword found in output (${out.slice(0, 100)}…)` };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'emit_handoff_called', category: 'correctness', judge: judgeEmitHandoffCalled },
  { name: 'text_only_termination', category: 'correctness', judge: judgeTextOnlyTermination },
  { name: 'summary_content', category: 'correctness', judge: judgeSummaryContent },
];

describe('FEATURE_190 Phase 2b pilot — text-only termination trigger validation', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_evaluator_handoff',
            description: 'pre-F190 prompt: EVALUATOR HANDOFF + emit_handoff in tools',
            systemPrompt: buildSystemPrompt(HANDOFF_RULES_BASELINE, TOOL_DOCS_WITH_EMIT_HANDOFF),
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
          },
          {
            id: 'v_new_text_only_termination',
            description: 'post-F190 prompt: TERMINATION + emit_handoff removed from tools',
            systemPrompt: buildSystemPrompt(TERMINATION_RULES_NEW, TOOL_DOCS_WITHOUT_EMIT_HANDOFF),
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
          },
        ];

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges: JUDGES,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        const lines: string[] = [];
        lines.push(`[feature-190-pilot][${c.id}]`);
        for (const variantId of ['v_baseline_evaluator_handoff', 'v_new_text_only_termination']) {
          const cells = result.byVariant[variantId] ?? [];
          lines.push(`  --- ${variantId} ---`);
          for (const cell of cells) {
            const emitPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'emit_handoff_called')?.passed,
            ).length;
            const textOnlyPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'text_only_termination')?.passed,
            ).length;
            const summaryPass = cell.runsRaw.filter((r) =>
              r.judges.find((j) => j.name === 'summary_content')?.passed,
            ).length;
            lines.push(
              `    ${cell.alias.padEnd(14)} emit_handoff=${emitPass}/${cell.runsRaw.length}  text_only=${textOnlyPass}/${cell.runsRaw.length}  summary=${summaryPass}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-190-text-only-termination-pilot',
          startedAt: result.startedAt,
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPrompt: v.systemPrompt,
            priorMessages: v.priorMessages,
            userMessage: v.userMessage,
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
