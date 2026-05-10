/**
 * Dataset — FEATURE_151 Slice I (v0.7.38) fan-out plan granularity eval cases.
 *
 * Verifies the `FAN-OUT PLAN GRANULARITY` section added to Worker
 * role-prompt in v0.7.38 (see `packages/coding/src/agents/worker-role-prompt.ts`
 * `fanOutPlanGranularity` constant). The section's contract:
 *
 *   When the plan involves dispatching ≥3 children (`dispatch_child_task`
 *   per RULE A or RULE C), expand the plan to ONE item per child's
 *   objective. Mark each item `in_progress` just before the corresponding
 *   `await_child_task`, and `completed` when the child returns.
 *
 * Four cases, balanced 2 positive (fan-out, expect ≥N items) + 2 negative
 * (trivial lookup, expect NO todo_update at all):
 *
 *   1. **review_3_modules**   — Review 3 packages independently → expect
 *      op:'init' with ≥3 items, each item content referencing a package.
 *
 *   2. **audit_5_packages**   — Audit 5 modules in parallel → expect
 *      op:'init' with ≥5 items.
 *
 *   3. **single_lookup**      — Find function definition → expect NO
 *      todo_update (single trivial step).
 *
 *   4. **single_grep**        — Grep one literal pattern → expect NO
 *      todo_update.
 *
 * **Design source**: `docs/features/v0.7.38.md#feature_151...` Slice I.
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention. Stage-1
 * acceptance per design (decision matrix in v0.7.38.md Slice I):
 *
 *   - Pass: C1 + C2 ≥ 80% probe call op:'init' with sufficient items.
 *   - Pass: C3 + C4 ≤ 20% probe call op:'init' (defends against
 *     over-trigger on trivial tasks).
 *   - Cross-alias max-min spread ≤ 15pp (FEATURE_109 AHE standard).
 *
 * Run model: 5 alias × 4 case × 1 run = 20 cells. Pilot is 1 run/cell;
 * post-pilot may bump to 3 if variance warrants (mirrors sibling eval
 * `tests/feature-151-todo-self-seeding.eval.ts`).
 *
 * **Why this lives next to the existing `feature-151-todo-self-seeding`
 * dataset**: both verify FEATURE_151's prompt-driven plan-list behavior.
 * Self-seeding tests "LLM seeds plan when Scout didn't"; this tests
 * "Worker plan-first granularity in fan-out scenarios". Same FEATURE_151
 * theme, distinct prompt section + distinct case shape, so two separate
 * datasets keep the `expectInit` boolean shape simple.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'review_3_modules'
  | 'audit_5_packages'
  | 'single_lookup'
  | 'single_grep';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** True when the LLM should call op:'init' (fan-out); false when it should not (trivial). */
  readonly expectInit: boolean;
  /** For positive cases: minimum items the LLM should commit. Ignored for negative. */
  readonly minItems?: number;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'review_3_modules',
    description:
      'User asks for parallel review of 3 independent packages. LLM is the ' +
      'Worker primary agent with `dispatch_child_task` available. Per ' +
      'FAN-OUT PLAN GRANULARITY: expand plan to ONE item per child\'s ' +
      'objective (3 packages → ≥3 items in op:"init").',
    behaviour:
      'output mentions todo_update with op:"init" AND ≥3 items in items array',
    expectInit: true,
    minItems: 3,
  },
  {
    id: 'audit_5_packages',
    description:
      'User asks for parallel audit of 5 modules. Worker should fan out via ' +
      'dispatch_child_task and pre-commit a 5-item plan via op:"init".',
    behaviour:
      'output mentions todo_update with op:"init" AND ≥5 items in items array',
    expectInit: true,
    minItems: 5,
  },
  {
    id: 'single_lookup',
    description:
      'User asks Worker to find a single function definition. Single trivial ' +
      'step — no fan-out, no plan list needed. Per PLAN-FIRST CONTRACT ' +
      'trivial branch: answer/execute directly without todo_update.',
    behaviour:
      'output does NOT mention op:"init" / todo_update; goes straight to read or grep',
    expectInit: false,
  },
  {
    id: 'single_grep',
    description:
      'User asks Worker to grep for one literal pattern and count matches. ' +
      'Single trivial step. LLM should NOT call op:"init" / todo_update.',
    behaviour:
      'output does NOT mention op:"init" / todo_update; runs single grep',
    expectInit: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.38"). Single-variant
// runs surface as a flat acceptance matrix; no A/B comparison axis here
// (the A baseline would be "Worker prompt without Slice I", but the change
// is small enough that A/B is unnecessary at pilot stage).
// ---------------------------------------------------------------------------

/**
 * Replicated essence of the worker-role-prompt sections relevant to fan-out
 * plan-granularity behaviour. Source of truth lives in
 * `packages/coding/src/agents/worker-role-prompt.ts`; this is a controlled
 * snapshot keyed to v0.7.38 Slice I. The unit test
 * `worker-role-prompt.test.ts` (`emits the FAN-OUT PLAN GRANULARITY section`)
 * pins the source-side text so any divergence between source and this
 * snapshot will be caught when the unit test is updated to match a future
 * source change.
 *
 * Per EVAL_GUIDELINES Layer 2 §"controlled input": the LLM input is the
 * exact bytes the model sees, not a re-derivation through `runKodaX`.
 * Embedding the prompt text here makes the eval reproducible and makes
 * the failure surface unambiguous (a fail = the LLM failed to follow this
 * exact prompt, not "the runner stitched something wrong").
 */
const WORKER_PROMPT_FANOUT_SECTIONS = [
  'You are the Worker — KodaX\'s single primary agent for this task. Routing decision summary:',
  '- Primary task: investigate',
  '- Work intent: review',
  '- Risk: low',
  '- Complexity: moderate',
  '- Brainstorm required: no',
  '',
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update` with the full plan.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled`). Mark exactly ONE item `in_progress` at a time.',
  '',
  'DISPATCH RULES (`dispatch_child_task` / `await_child_task`):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE C — write fan-out: NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children.',
  '- Pattern B (FEATURE_119): `dispatch_child_task` returns a `task_id:<id>` immediately and runs in the background.',
  '',
  'FAN-OUT PLAN GRANULARITY (FEATURE_151 Slice I, v0.7.38):',
  '- When your plan involves dispatching ≥3 children (`dispatch_child_task` per RULE A or RULE C), expand the plan to ONE item per child\'s objective — mirror each child\'s `bundle.objective` literally. Do NOT collapse N dispatches into one "fan out" item.',
  '  GOOD: `todo_update({op:"init", items:[',
  '          {id:"todo_1", content:"Review packages/foo", activeForm:"Reviewing packages/foo"},',
  '          {id:"todo_2", content:"Review packages/bar", activeForm:"Reviewing packages/bar"},',
  '          ... one item per dispatched child ...',
  '        ]})`',
  '  BAD:  `todo_update({op:"init", items:[{content:"Fan out review across 5 packages"}]})`',
  '- Mark each item `in_progress` just before the corresponding `await_child_task`, and `completed` when that child returns successfully (`failed` if the child crashes / times out).',
  '- Rationale: the plan list IS the user\'s progress dashboard during 30-60s fan-outs. Collapsing N dispatches into a single item turns parallel work into a black box and hides 30+ seconds of progress. The plan-first contract above (≥2 distinct steps → todo_update) interpreted strictly: "dispatching 5 children" IS 5 distinct steps from the user\'s viewpoint, not 1.',
].join('\n');

const TOOL_DOCS_BLURB = [
  '## Available Tools',
  '',
  '`todo_update`:',
  '  Mode A — `op:"init"` — commit / replace plan list.',
  '    Input:  { op:"init", items:[{id:string, content:string, activeForm?:string}, ...] }',
  '  Mode B — `op:"update"` — single-item state transition.',
  '    Input:  { id:string, status:"in_progress"|"completed"|"failed"|"skipped" }',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly:boolean, scope_summary?:string }',
  '  Output: { task_id:string }  (returns immediately; runs in background — Pattern B)',
  '',
  '`await_child_task`:',
  '  Input:  { task_id:string }',
  '  Output: child\'s final summary text once the child completes.',
  '',
  '`read` / `grep` / `glob`:',
  '  Standard read-only file inspection tools.',
].join('\n');

const SYSTEM_PROMPT = [WORKER_PROMPT_FANOUT_SECTIONS, '', TOOL_DOCS_BLURB].join('\n');

function buildReview3ModulesVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Parallel review of 3 packages, expect op:init with ≥3 items',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Review the following 3 packages independently and report findings: ' +
      '`packages/ai`, `packages/agent`, `packages/coding`. They have no ' +
      'cross-package dependencies in this scope, so the reviews can run ' +
      'in parallel. Plan first, then dispatch.',
  };
}

function buildAudit5PackagesVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Parallel audit of 5 packages, expect op:init with ≥5 items',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Audit these 5 packages for security issues — input validation, ' +
      'secret handling, error message leakage. Each package is independent ' +
      'so this fan-outs cleanly: `packages/ai`, `packages/agent`, ' +
      '`packages/coding`, `packages/repl`, `packages/skills`. ' +
      'Plan first, then run the audits in parallel.',
  };
}

function buildSingleLookupVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Single function lookup, expect NO op:init',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Find the definition of the function `getCwd` in `src/`. I just ' +
      'need the file path and the line number — nothing else.',
  };
}

function buildSingleGrepVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Single grep, expect NO op:init',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Grep for the literal string `TODO` in `src/` and tell me how many ' +
      'matches. One number is fine.',
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'review_3_modules':
      return buildReview3ModulesVariant();
    case 'audit_5_packages':
      return buildAudit5PackagesVariant();
    case 'single_lookup':
      return buildSingleLookupVariant();
    case 'single_grep':
      return buildSingleGrepVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic, zero-LLM. We test the structural intent of the
// LLM's output against the FAN-OUT PLAN GRANULARITY contract. Tool-call
// binding is not present in the harness, so we look for `op:"init"` /
// `op: "init"` literal substrings in the model's output text (model may
// include the call as a JSON block / tool_use markdown / fenced code).
//
// Judge patterns mirror the sibling `feature-151-todo-self-seeding`
// dataset for consistency — same regex shapes, same item-count heuristic.
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
        // Heuristic: count `id:` or `id":` occurrences as a proxy for
        // distinct item entries in the items array (mirrors sibling eval).
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
              reason: "output references op:'init' on a trivial single-step task",
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
              reason: 'output references todo_update on a trivial single-step task',
            }
          : { passed: true };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'review_3_modules':
      return judgesExpectInit(3);
    case 'audit_5_packages':
      return judgesExpectInit(5);
    case 'single_lookup':
      return judgesExpectNoInit();
    case 'single_grep':
      return judgesExpectNoInit();
  }
}
