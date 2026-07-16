/**
 * FEATURE_189-extended V14 retry-loop OR-list pilot — 2026-05-25
 *
 * Per user follow-up directive: V14 was flagged in Phase A audit as a §2
 * compound (OR-list joining two equivalent actions in a single sentence)
 * in `edit-recovery.ts:164` recovery user-message synth:
 *
 *   Baseline (1 sentence with OR):
 *     "Retry with edit using a smaller unique old_string, or use
 *      insert_after_anchor when you are appending a new section."
 *
 *   Proposed (single concept per sentence per ADR-033 §2):
 *     "Retry with edit using a smaller unique old_string."
 *     "When appending a new section after a unique heading, use
 *      insert_after_anchor instead."
 *
 * Per `feedback_defer_only_for_future_dep` + `feedback_refactor_parity_baseline`,
 * "borderline LOW" is not a valid defer reason. Run a small pilot to verify
 * no regression before shipping.
 *
 * ## Scaffold
 *
 * Edit-recovery message fires AFTER an edit fails (ANCHOR_NOT_FOUND or
 * EDIT_TOO_LARGE). The path under test is the ≤2 attempts branch (lines
 * 161-165) where the OR-list is. We simulate via:
 *   - Standard Worker system prompt + file-mutation tools
 *   - User message describes the failed edit + recovery diagnostic inline
 *     (text-only, no real tool_use/tool_result roundtrip needed — the
 *     model just reads the recovery text and decides which tool to call)
 *
 * Measure: does the model choose `edit` (with smaller anchor) OR
 * `insert_after_anchor` (BOTH PASS — both correctly addressed by recovery)?
 * Failure: escalating to `write` (forbidden) or no tool call at all.
 *
 * ## Panel
 *
 * 1 alias (ark/v4flash) × 1 case × 2 variants × 3 runs = 6 cells (~$0.4).
 * Self-judged per `feedback_self_judge_when_sufficient` (≤50 short rows).
 *
 * ## Pre-registered SHIP gate
 *
 *   Proposed ≥ baseline − 1 cell on edit/insert_after_anchor selection
 *   AND proposed shows 0 write-escalation regressions
 *   → SHIP V14
 *
 * ## Run
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-extended-v14-retry-loop-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-189-extended-v14-retry-loop-pilot',
);

const PILOT_PANEL: readonly ModelAlias[] = ['ark/v4flash'] as const;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// =====================================================================
// Worker system prompt — minimal, just enough that file-mutation tools
// are advertised. The variant differs only in the recovery-message text.
// =====================================================================

const WORKER_SYSTEM = [
  'You are the Worker — KodaX coding agent.',
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  '',
  'File mutation tools available: `edit`, `write`, `insert_after_anchor`.',
  '',
  'When an edit fails with ANCHOR_NOT_FOUND, the system synthesizes a recovery diagnostic and asks you to retry. Do not escalate to `write` to rewrite the file — that bypasses the safety boundary. Use `edit` with a smaller / smarter anchor, or `insert_after_anchor` if you are appending a new section after a unique heading.',
].join('\n');

const SHARED_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'edit',
    description: 'Edit a file by replacing `old_string` with `new_string`. `old_string` must be unique in the file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write',
    description: 'Write file contents (overwrites existing). For new files only — do not use to rewrite existing files after edit failure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'insert_after_anchor',
    description: 'Insert content after a unique anchor without rewriting the whole file. Prefer this for appending new sections to existing docs or configs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        anchor: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'anchor', 'content'],
    },
  },
  {
    name: 'read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

// =====================================================================
// Recovery message variants (the only diff)
// =====================================================================

const RECOVERY_BASELINE = [
  'The previous edit for /repo/README.md failed with ANCHOR_NOT_FOUND.',
  'Do not use write to rewrite the existing file.',
  'Retry with edit using a smaller unique old_string, or use insert_after_anchor when you are appending a new section.',
  '',
  'Best nearby anchor window (42-58):',
  '```text',
  '## Installation',
  '',
  'Run `npm install` to install dependencies.',
  '',
  'See the [contributor guide](./CONTRIBUTING.md) for more details.',
  '',
  '## Configuration',
  '',
  'Default config lives in `config/default.json`.',
  '```',
].join('\n');

const RECOVERY_PROPOSED = [
  'The previous edit for /repo/README.md failed with ANCHOR_NOT_FOUND.',
  'Do not use write to rewrite the existing file.',
  'Retry with edit using a smaller unique old_string.',
  'When appending a new section after a unique heading, use insert_after_anchor instead.',
  '',
  'Best nearby anchor window (42-58):',
  '```text',
  '## Installation',
  '',
  'Run `npm install` to install dependencies.',
  '',
  'See the [contributor guide](./CONTRIBUTING.md) for more details.',
  '',
  '## Configuration',
  '',
  'Default config lives in `config/default.json`.',
  '```',
].join('\n');

// =====================================================================
// User message — simulates a turn where the agent just tried to edit
// README.md with a stale anchor and got the recovery diagnostic back.
// Realistic content: user asked to add "Performance" section after
// "Installation" section.
// =====================================================================

const USER_MESSAGE = (recoveryBlock: string) => [
  'I want to add a new "## Performance" section to /repo/README.md right after the "## Installation" section. The section should briefly note that startup time is <100ms on a modern laptop.',
  '',
  'I attempted this with:',
  '  edit(path="/repo/README.md", old_string="## Installation\\n\\nRun npm install\\n", new_string="...")',
  '',
  'But the edit failed and the system returned this recovery diagnostic:',
  '',
  '---',
  recoveryBlock,
  '---',
  '',
  'Please proceed with the appropriate next step.',
].join('\n');

// =====================================================================
// Judge — PASS if model calls edit or insert_after_anchor; FAIL if
// model calls write (escalation) or no tool at all.
// =====================================================================

function judgeRecoveryChoice(_out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.length === 0) {
    return { passed: false, reason: 'no tool call — model failed to recover' };
  }
  const first = toolCalls[0];
  if (first.name === 'edit' || first.name === 'insert_after_anchor') {
    return { passed: true, reason: `chose ${first.name}` };
  }
  if (first.name === 'write') {
    return { passed: false, reason: 'escalated to write — forbidden recovery path' };
  }
  if (first.name === 'read') {
    // read first is also acceptable as preparation; check subsequent calls
    const next = toolCalls.find((t) => t.name === 'edit' || t.name === 'insert_after_anchor' || t.name === 'write');
    if (!next) return { passed: true, reason: 'read-only (preparation, deferred next step)' };
    if (next.name === 'write') return { passed: false, reason: 'read then escalated to write' };
    return { passed: true, reason: `read then ${next.name}` };
  }
  return { passed: false, reason: `unexpected first tool ${first.name}` };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'recovery_choice', category: 'correctness', judge: judgeRecoveryChoice },
];

// =====================================================================
// Driver
// =====================================================================

describe('FEATURE_189-extended V14 retry-loop OR-list — pilot', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  it(
    `add_performance_section_after_anchor_failure — ${aliases.length} alias × 2 variant × ${RUNS_PER_CELL} runs`,
    { timeout: 10 * 60_000 },
    async () => {
      const variants = [
        {
          id: 'v_baseline_or_list',
          description: 'current production: OR-list joining two equivalent actions in one sentence',
          systemPrompt: WORKER_SYSTEM,
          tools: SHARED_TOOLS,
          priorMessages: [],
          userMessage: USER_MESSAGE(RECOVERY_BASELINE),
        },
        {
          id: 'v_proposed_split',
          description: 'proposed: split into single-concept sentences per ADR-033 §2',
          systemPrompt: WORKER_SYSTEM,
          tools: SHARED_TOOLS,
          priorMessages: [],
          userMessage: USER_MESSAGE(RECOVERY_PROPOSED),
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
      lines.push('[feature-189-extended-v14-retry-loop-pilot]');
      for (const variantId of ['v_baseline_or_list', 'v_proposed_split']) {
        const cells = result.byVariant[variantId] ?? [];
        lines.push(`  --- ${variantId} ---`);
        for (const cell of cells) {
          const passCount = cell.runsRaw.filter((r) =>
            r.judges.find((j) => j.name === 'recovery_choice')?.passed,
          ).length;
          lines.push(
            `    ${cell.alias.padEnd(14)} recovery_choice=${passCount}/${cell.runsRaw.length}`,
          );
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dump = {
        case: 'add_performance_section_after_anchor_failure',
        stage: 'feature-189-extended-v14-retry-loop-pilot',
        startedAt: result.startedAt,
        variants: variants.map((v) => ({
          id: v.id,
          description: v.description,
          systemPrompt: v.systemPrompt,
          toolCount: v.tools.length,
          userMessage: v.userMessage,
        })),
        cells: result.cells.map((cell) => ({
          alias: cell.alias,
          variantId: cell.variantId,
          passRate: cell.passRate,
          runs: cell.runsRaw.map((run) => ({
            runIndex: run.runIndex,
            text: run.text,
            toolCalls: run.toolCalls.map((t) => ({ name: t.name, input: t.input })),
            durationMs: run.durationMs,
            fallbackUsed: run.fallbackUsed,
            regexJudges: run.judges.map((j) => ({ name: j.name, passed: j.passed, reason: j.reason })),
          })),
        })),
      };
      writeFileSync(join(DUMP_ROOT, 'add_performance_section_after_anchor_failure.json'), JSON.stringify(dump, null, 2), 'utf8');
    },
  );
});
