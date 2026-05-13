/**
 * Dataset — FEATURE_151 (v0.7.38) prompt-behavior eval cases.
 *
 * Verifies the Slice B3 prompt updates that taught Generator/Planner/Scout
 * to use `todo_update({op:'init', items:[...]})` when no plan list was
 * seeded by Runner but the task is multi-step. Also pins the negative
 * case: trivial single-step / informational tasks must NOT trigger
 * op:'init' (avoiding plan-list noise).
 *
 * Four cases, balanced 2 positive + 2 negative:
 *
 *   1. **multi_step_audit_init** — Audit packages/llm for security (review
 *      task, ≥2 files). LLM should commit a plan via op:'init'.
 *
 *   2. **rename_3_files_init** — Rename function across 3 files (mutation
 *      task, ≥3 distinct steps). LLM should commit a plan via op:'init'.
 *
 *   3. **trivial_typo_no_init** — Fix a single typo. LLM should NOT call
 *      op:'init' (matches CC TodoWrite "skip for single, straightforward
 *      task" guidance).
 *
 *   4. **info_request_no_init** — "What does git status do?". Pure info,
 *      no work. LLM should NOT call op:'init'.
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention. Stage-1
 * acceptance: 5 alias mean ≥ 80% pass per case. The harness is the same
 * shared infra used by FEATURE_097 / FEATURE_106 / FEATURE_148.
 *
 * Run model: 5 alias × 4 case × 1 run = 20 cells. Pilot is 1 run/cell;
 * post-pilot may bump to 3 if variance warrants.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'multi_step_audit_init'
  | 'rename_3_files_init'
  | 'trivial_typo_no_init'
  | 'info_request_no_init';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** True when the LLM should call op:'init'; false when it should not. */
  readonly expectInit: boolean;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'multi_step_audit_init',
    description:
      'User asks for a multi-file security audit. No plan list was seeded ' +
      '(Scout did not produce ≥2 obligations for this run). LLM should ' +
      'commit a plan via todo_update({op:"init", items:[...]}) before ' +
      'starting the audit work.',
    behaviour:
      'output mentions todo_update with op:"init" AND >= 2 items in the items array',
    expectInit: true,
  },
  {
    id: 'rename_3_files_init',
    description:
      'User asks to rename a function across 3 files. No plan list was ' +
      'seeded. LLM should commit a 3+ step plan via op:"init".',
    behaviour:
      'output mentions todo_update with op:"init" AND >= 3 items in the items array',
    expectInit: true,
  },
  {
    id: 'trivial_typo_no_init',
    description:
      'User asks to fix a single typo in a single file. Trivial single-step ' +
      'task. LLM should NOT call op:"init" — proceed with the edit directly.',
    behaviour:
      'output does NOT mention op:"init" OR todo_update; goes straight to fix',
    expectInit: false,
  },
  {
    id: 'info_request_no_init',
    description:
      'User asks an informational question (no work to do). LLM should ' +
      'NOT call op:"init" — answer the question directly.',
    behaviour: 'output does NOT mention op:"init" OR todo_update; answers directly',
    expectInit: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.38"). Single-variant
// runs surface as a flat acceptance matrix; no A/B comparison axis here.
// ---------------------------------------------------------------------------

const TODO_UPDATE_TOOL_BLURB = [
  'You have a `todo_update` tool with two operating modes:',
  '',
  '  Mode A — `op: "init"` (FEATURE_151, v0.7.38):',
  '    Commit / replace the visible plan list. Use when (a) the task is',
  '    multi-step but no plan was pre-seeded for you, OR (b) the scope',
  '    shifted and you need to replace the existing plan.',
  '    Input:   { op: "init", items: [{id: string, content: string, activeForm?: string}, ...] }',
  '    Each item id non-empty + unique within the list; content non-empty.',
  '    Output:  {ok: true, count: N} on success.',
  '',
  '  Mode B — `op: "update"` (default; omit `op` for back-compat):',
  '    Single-item state transition.',
  '    Input:   { id: string, status: "in_progress"|"completed"|"failed"|"skipped", note?: string, activeForm?: string }',
  '    Output:  {ok: true} on success.',
  '',
  '  When to use Mode A:',
  '    - Task has ≥ 2 distinct execution steps (e.g. multi-file mutation,',
  '      multi-area review, multi-step investigation).',
  '    - You realised mid-task that the work is more involved than a',
  '      single step.',
  '',
  '  When NOT to use Mode A:',
  '    - Single, straightforward task (single typo / single edit / single',
  '      lookup / one-sentence answer).',
  '    - Purely conversational or informational request.',
  '    - The task can be completed in less than 3 trivial steps.',
].join('\n');

const GENERATOR_HEADER = [
  'You are KodaX Generator — the executor stage of an AMA pipeline.',
  '',
  'No plan list was seeded for this run (Scout did not produce ≥ 2',
  'execution obligations). You may proceed without a plan, OR — for',
  'genuinely multi-step tasks — commit a plan via todo_update op:"init".',
  '',
  TODO_UPDATE_TOOL_BLURB,
].join('\n');

function buildMultiStepAuditVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Multi-file security audit, expect op:init',
    systemPrompt: GENERATOR_HEADER,
    userMessage:
      'Please audit packages/llm/ for security issues. The audit should ' +
      'cover: (1) input validation in provider adapters, (2) secret ' +
      'handling in the cost-tracker module, (3) error message leakage in ' +
      'the retry-after logic. Walk through your plan first, then start.',
  };
}

function buildRename3FilesVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: '3-file rename, expect op:init with ≥3 items',
    systemPrompt: GENERATOR_HEADER,
    userMessage:
      'Rename the function `getCwd` to `getCurrentWorkingDirectory` ' +
      'across 3 files: src/cli.ts, src/utils.ts, and src/repl.ts. ' +
      'Each file has multiple call sites. Plan first, then execute.',
  };
}

function buildTrivialTypoVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Single typo fix, expect NO op:init',
    systemPrompt: GENERATOR_HEADER,
    userMessage:
      'Fix the typo in README.md: line 42 has "documentaion" — should be "documentation".',
  };
}

function buildInfoRequestVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Pure information request, expect NO op:init',
    systemPrompt: GENERATOR_HEADER,
    userMessage:
      'What does the `git status` command do? Just explain in one or two sentences.',
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'multi_step_audit_init':
      return buildMultiStepAuditVariant();
    case 'rename_3_files_init':
      return buildRename3FilesVariant();
    case 'trivial_typo_no_init':
      return buildTrivialTypoVariant();
    case 'info_request_no_init':
      return buildInfoRequestVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic, zero-LLM. We test the structural intent of the
// LLM's output; tool-call binding is not present in the harness, so we look
// for `op:"init"` / `op: "init"` literal substrings in the model's output
// text (model may include the call as a JSON block / tool_use markdown).
// ---------------------------------------------------------------------------

const OP_INIT_PATTERN = /op["\s:]+["']?init["']?/i;
const TODO_UPDATE_PATTERN = /todo_update/i;

function judgesExpectInit(minItems: number): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_op_init',
      category: 'correctness',
      judge: (out) => {
        return OP_INIT_PATTERN.test(out)
          ? { passed: true }
          : { passed: false, reason: "output does not reference op:'init'" };
      },
    },
    {
      name: `mentions_at_least_${minItems}_items`,
      category: 'correctness',
      judge: (out) => {
        // Heuristic: count `id:` or `id":` occurrences as a rough proxy
        // for distinct item entries in the items array.
        const matches = out.match(/id["\s:]+["']?todo_/gi);
        const itemCount = matches ? matches.length : 0;
        if (itemCount >= minItems) return { passed: true };
        return {
          passed: false,
          reason: `expected ≥${minItems} todo items in op:'init' payload, found ${itemCount}`,
        };
      },
    },
  ];
}

function judgesExpectNoInit(): readonly PromptJudge[] {
  return [
    {
      name: 'does_not_call_op_init',
      category: 'correctness',
      judge: (out) => {
        return OP_INIT_PATTERN.test(out)
          ? {
              passed: false,
              reason: "output references op:'init' on a task that should not need a plan list",
            }
          : { passed: true };
      },
    },
    {
      name: 'does_not_call_todo_update',
      category: 'correctness',
      judge: (out) => {
        return TODO_UPDATE_PATTERN.test(out)
          ? {
              passed: false,
              reason: 'output references todo_update on a trivial / informational task',
            }
          : { passed: true };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'multi_step_audit_init':
      return judgesExpectInit(2);
    case 'rename_3_files_init':
      return judgesExpectInit(3);
    case 'trivial_typo_no_init':
      return judgesExpectNoInit();
    case 'info_request_no_init':
      return judgesExpectNoInit();
  }
}
