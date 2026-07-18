/**
 * Panel — FEATURE_190 Phase 2c text-only termination 5-alias × 4-case × 2-variant × 5-run.
 *
 * 5 canonical alias × 4 case × 2 variant × 5 runs = 200 cells, ~$10, ~30-50 min wall.
 *
 * Cases (per docs/features/v0.7.43.md#feature_190 design):
 *   C1: All-todos-completed scenario (positive — should text-only terminate)
 *   C2: Blocked-state scenario (positive — should text-only terminate with blocker)
 *   C3: Mid-task in-progress scenario (negative — should NOT terminate)
 *   C4: Trivial single-step task completed (positive — should text-only terminate)
 *
 * Variants:
 *   V_baseline: pre-F190 (EVALUATOR HANDOFF + emit_handoff in tools)
 *   V_new: post-F190 (TERMINATION + emit_handoff removed from tools)
 *
 * ## Pilot finding (2026-05-23)
 *
 * Pilot 1×1×1 on ark/v4flash showed V_baseline 1/3 emit_handoff (floor-model
 * inconsistency on "MUST call" instruction per
 * [[feedback_model_structural_floor_not_prompt_tunable]]). V_new 3/3
 * text_only + summary. Pre-registered pilot gate (1) + (3) FAIL on floor;
 * evidence-driven override per [[feedback_pre_registered_gate_saturation]] —
 * panel proceeds to validate high-end alias behavior where V_baseline
 * disagreement signal is expected to emerge.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-190-text-only-termination-panel
 *
 * ## Pre-registered SHIP gate (per docs/features/v0.7.43.md#feature_190 (a-e))
 *
 *   (a) V_new C1+C2+C4 text-only termination rate ≥ 80% per alias
 *   (b) V_new C3 false-termination rate ≤ 20% per alias (anti-trigger)
 *   (c) Summary keyword presence ≥ 80% per case (model still produces summary)
 *   (d) Cross-variant: V_new "task converged" judge rate per-alias
 *       regression ≤ 8pp vs V_baseline
 *   (e) 3-judge LLM majority audit disagreement < 10% (DATA VALID per
 *       EVAL_GUIDELINES anti-pattern 7) — separate `judge-audit` driver
 *
 * DEFER fallbacks per design doc.
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
  'feature-190-text-only-termination-panel',
);

const CANONICAL_PANEL: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4pro': 'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 5;

// === Tool docs ===

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

// === Worker prompt fragments ===

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

// === Cases ===

interface CaseBundle {
  readonly id: string;
  readonly description: string;
  readonly priorMessages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
  /** true = positive case (should terminate). false = negative (should NOT terminate). */
  readonly expectTerminate: boolean;
}

const C1_PRIORS = [
  { role: 'user' as const, content: 'Fix the session-validation bug in packages/auth/handler.ts. Bug: expired sessions still pass when expires_at is null.' },
  { role: 'assistant' as const, content: "I'll plan: 1) read handler.ts, 2) edit null-handling, 3) run tests. (todo_create for each)" },
  { role: 'user' as const, content: '[turn 2 abbreviated — read, edited, tests pass; all 3 todos `completed`]' },
];

const C2_PRIORS = [
  { role: 'user' as const, content: 'Migrate the auth flow in packages/auth to the new OAuth2.1 spec.' },
  { role: 'assistant' as const, content: "Plan: 1) audit current flow, 2) review spec, 3) port handler, 4) write tests. (todo_create for each)" },
  { role: 'user' as const, content: '[turn 2 abbreviated — audited current flow, but step 3 hit a blocker: the new spec requires a refresh-token endpoint our auth provider does not yet expose. todos 1+2 `completed`, todo 3 `failed` with note, todo 4 `pending`.]' },
];

const C3_PRIORS = [
  { role: 'user' as const, content: 'Add a `requestId` field to the request-context type and thread it through 3 modules.' },
  { role: 'assistant' as const, content: "Plan: 1) edit shared/context.ts type, 2) thread through api/log.ts, 3) thread through web/middleware.ts, 4) thread through cli/runner.ts. (todo_create for each)" },
  { role: 'user' as const, content: '[turn 2 abbreviated — todo 1 `completed` (type field added). todos 2+3+4 still `pending`. Mid-task state.]' },
];

const C4_PRIORS = [
  { role: 'user' as const, content: 'Fix the typo in packages/cli/help.ts:42 — "comand" should be "command".' },
];

const CASES: readonly CaseBundle[] = [
  {
    id: 'C1_all_todos_completed',
    description: 'positive: all 3 plan items completed → text-only summary expected',
    priorMessages: C1_PRIORS,
    userMessage: 'Confirmed — the fix looks good and tests pass. All 3 plan items are now `completed`. Please give me a brief summary of what was done.',
    expectTerminate: true,
  },
  {
    id: 'C2_blocked_state',
    description: 'positive: irrecoverable blocker → text-only blocker summary expected',
    priorMessages: C2_PRIORS,
    userMessage: 'Understood — the missing refresh-token endpoint is an external blocker that needs the auth provider to expose it. Please summarize what was done and what blocks the rest.',
    expectTerminate: true,
  },
  {
    id: 'C3_mid_task_negative',
    description: 'negative: mid-task with pending todos → should NOT terminate, should keep working',
    priorMessages: C3_PRIORS,
    userMessage: 'The type addition looks good. Please continue with the next steps.',
    expectTerminate: false,
  },
  {
    id: 'C4_trivial_completed',
    description: 'positive: trivial single-step task done → text-only confirmation expected',
    priorMessages: C4_PRIORS,
    userMessage: 'I checked the file — your edit on line 42 fixed the typo correctly. Anything else needed?',
    expectTerminate: true,
  },
] as const;

// === Extended regex (post-pilot finding) ===

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
    // FEATURE_190 pilot finding: ark/v4flash emits `tool_name\n{...}` syntax.
    new RegExp(`(^|\\n)\\s*${esc}\\s*\\n\\s*\\{`, 'm'),
    new RegExp(`(^|\\n)\\s*${esc}\\s*\\{`, 'm'),
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

// === Judges ===

function judgeEmitHandoffCalled(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.some((t) => t.name === 'emit_handoff')) return { passed: true };
  if (invokesTool(out, 'emit_handoff')) return { passed: true };
  return { passed: false, reason: 'emit_handoff NOT invoked (binding + 11-syntax regex empty)' };
}

function judgeTextOnlyTermination(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.length > 0) {
    return { passed: false, reason: `tool_use blocks present (${toolCalls.map((t) => t.name).join(',')})` };
  }
  for (const tool of ['emit_handoff', 'read', 'grep', 'bash', 'write', 'edit', 'todo_update']) {
    if (invokesTool(out, tool)) {
      return { passed: false, reason: `text contains tool-call syntax for ${tool}` };
    }
  }
  return { passed: true };
}

function judgeSummaryContent(out: string): JudgeResult {
  const keywords = ['done', 'completed', 'summary', 'finished', 'wrap', 'fixed', 'applied', 'changes', 'block', 'pending', 'next'];
  const lower = out.toLowerCase();
  if (keywords.some((k) => lower.includes(k))) return { passed: true };
  return { passed: false, reason: `no summary/blocker/continuation keyword found (${out.slice(0, 100)}…)` };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'emit_handoff_called', category: 'correctness', judge: judgeEmitHandoffCalled },
  { name: 'text_only_termination', category: 'correctness', judge: judgeTextOnlyTermination },
  { name: 'summary_content', category: 'correctness', judge: judgeSummaryContent },
];

// === Driver ===

describe('FEATURE_190 Phase 2c panel — text-only termination 5×4×2×5', () => {
  const aliases = availableAliases(...CANONICAL_PANEL);

  if (aliases.length === 0) {
    it('skips: no canonical panel alias key in env', () => { /* no-op */ });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
      { timeout: 30 * 60_000 },
      async () => {
        const variants = [
          {
            id: 'v_baseline_evaluator_handoff',
            description: 'pre-F190: EVALUATOR HANDOFF + emit_handoff in tools',
            systemPrompt: buildSystemPrompt(HANDOFF_RULES_BASELINE, TOOL_DOCS_WITH_EMIT_HANDOFF),
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
          },
          {
            id: 'v_new_text_only_termination',
            description: 'post-F190: TERMINATION + emit_handoff removed from tools',
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
        lines.push(`[feature-190-panel][${c.id}] expectTerminate=${c.expectTerminate}`);
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
              `    ${cell.alias.padEnd(14)} emit=${emitPass}/${cell.runsRaw.length}  text_only=${textOnlyPass}/${cell.runsRaw.length}  summary=${summaryPass}/${cell.runsRaw.length}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'feature-190-text-only-termination-panel',
          startedAt: result.startedAt,
          expectTerminate: c.expectTerminate,
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
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
