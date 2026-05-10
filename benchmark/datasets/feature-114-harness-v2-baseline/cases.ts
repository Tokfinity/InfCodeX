/**
 * Dataset — FEATURE_114 v0.7.36 AMA Harness V2 baseline eval cases (Slice 6).
 *
 * Verifies the Worker role-prompt sections that the parallel-thread
 * `feature-151-fan-out-plan-granularity` and `feature-151-todo-self-seeding`
 * evals do NOT cover:
 *
 *   - **EVALUATOR HANDOFF** — when plan items are all completed, Worker
 *     MUST call `emit_handoff` (cannot terminate via plain text).
 *   - **PLAN-FIRST CONTRACT non-fan-out branch** — non-trivial 2-step
 *     implementation that uses NO `dispatch_child_task`. The fan-out
 *     dataset only covers ≥3 children; this dataset closes the
 *     `≥2 distinct execution steps OR ≥2 files` clause that does not
 *     trigger fan-out.
 *   - **Trivial → no handoff/no plan** — single-step lookup must NOT
 *     emit_handoff and must NOT call op:"init". The fan-out dataset
 *     already covers this for the fan-out path; this case re-confirms
 *     it under the V2 prompt context (different baseline state).
 *
 * Three cases, balanced 2 positive + 1 negative:
 *
 *   1. **plan_complete_emits_handoff** — prior turn established a plan
 *      with all items marked completed; current ask is to wrap up →
 *      expect `emit_handoff` mention.
 *
 *   2. **multi_step_no_fanout_seeds_plan** — 2-step implementation in
 *      a single file (read → edit → build verify). No fan-out trigger
 *      → expect `op:"init"` with ≥2 items, NO `dispatch_child_task`.
 *
 *   3. **trivial_lookup_no_handoff** — single-line lookup. Expect NO
 *      `emit_handoff` AND NO `op:"init"`.
 *
 * **Design source**: `docs/features/v0.7.36.md#feature_114` (Worker role)
 * + `packages/coding/src/agents/worker-role-prompt.ts` (handoffRules,
 * planFirstContract).
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention. Runs
 * via `runBenchmark` with `runs: 5` per cell — the EVAL_GUIDELINES n≥3
 * minimum, bumped to 5 to give negative-case false-positive estimates
 * tighter confidence intervals (anti-pattern 7 mitigation).
 *
 * **Pre-registered SHIP/PARTIAL/REJECT decision matrix** (set BEFORE
 * any LLM call, per EVAL_GUIDELINES §5):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥80% on EACH positive case
 *              AND ≤20% on the negative case
 *              → ship V2 default flag flip in Slice 7
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending OK
 *              → ship Slice 7 anyway, document weaker-model behaviour
 *                in test guide; flag stays gateable per-deployment.
 *   - REJECT:  0 aliases ≥80% positive, OR negative case >40% on any alias
 *              → keep V2 flag default-off, redesign handoff/plan-first wording
 *
 * **EVAL_GUIDELINES compliance**:
 *   - n=5 runs/cell (>3 minimum, anti-pattern 4 mitigation)
 *   - Raw output dump to `os.tmpdir()/kodax-eval-dumps/feature-114-harness-v2-baseline/`
 *     (anti-pattern 7 mitigation; driver writes per-case JSON)
 *   - Negative case carries dual judges: regex-based + LLM-judge audit
 *     guidance in driver doc-comment
 *   - Pre-registered decision matrix (this file) — no post-hoc threshold tuning
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'plan_complete_emits_handoff'
  | 'multi_step_no_fanout_seeds_plan'
  | 'trivial_lookup_no_handoff';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** True when LLM should emit_handoff (plan complete). */
  readonly expectHandoff: boolean;
  /** True when LLM should call op:'init'. */
  readonly expectInit: boolean;
  /** Minimum item count for op:'init' positive cases. Ignored otherwise. */
  readonly minItems?: number;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'plan_complete_emits_handoff',
    description:
      'Prior turn shows a 2-item plan, both items marked completed. ' +
      'User asks Worker to wrap up. Per EVALUATOR HANDOFF section, the ' +
      'next move MUST be `emit_handoff` — Worker cannot terminate the ' +
      'run with plain text.',
    behaviour:
      'output mentions emit_handoff (final structural gate to Evaluator)',
    expectHandoff: true,
    expectInit: false,
  },
  {
    id: 'multi_step_no_fanout_seeds_plan',
    description:
      'User asks for a 2-3 step implementation in a single file (read → ' +
      'edit → build verify). No fan-out trigger (single file, no ≥3 ' +
      'independent investigations). Per PLAN-FIRST CONTRACT: ≥2 distinct ' +
      'execution steps → first tool call MUST be `todo_update({op:"init"})` ' +
      'with ≥2 items. NO `dispatch_child_task`.',
    behaviour:
      'output mentions todo_update with op:"init" AND ≥2 items AND does NOT mention dispatch_child_task',
    expectHandoff: false,
    expectInit: true,
    minItems: 2,
  },
  {
    id: 'trivial_lookup_no_handoff',
    description:
      'User asks Worker to look up one specific line in one file. Single ' +
      'trivial step. Per PLAN-FIRST CONTRACT trivial branch + EVALUATOR ' +
      'HANDOFF (which only fires when plan exists): execute directly, NO ' +
      'todo_update / op:"init" / emit_handoff.',
    behaviour:
      'output does NOT mention op:"init" / todo_update / emit_handoff; goes straight to read',
    expectHandoff: false,
    expectInit: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.38"). Single-variant
// runs surface as a flat acceptance matrix; A baseline ("Worker prompt
// without §EVALUATOR HANDOFF") is unnecessary at Slice 6 because Slice 5's
// e2e runner test already pins the structural runner contract — eval is
// measuring whether the prompt CONVEYS the contract to the LLM.
// ---------------------------------------------------------------------------

/**
 * Replicated essence of `buildWorkerInstructions` keyed to v0.7.36 (FEATURE_114).
 * Source of truth lives in `packages/coding/src/agents/worker-role-prompt.ts`;
 * this is a controlled snapshot. Per EVAL_GUIDELINES Layer 2 §"controlled
 * input": the LLM input is the exact bytes the model sees, not a re-derivation
 * through `runKodaX`. Embedding the prompt text here makes the eval
 * reproducible and makes the failure surface unambiguous.
 *
 * Drift guard: `cases.test.ts` greps the runtime worker-role-prompt source for
 * the same anchor strings (`EVALUATOR HANDOFF`, `PLAN-FIRST CONTRACT`,
 * `emit_handoff`) so any future rename of those anchors will fail Layer 1
 * before this snapshot can silently desync.
 */
const WORKER_PROMPT_V2_SECTIONS = [
  "You are the Worker — KodaX's single primary agent for this task. Routing decision summary:",
  '- Primary task: implement',
  '- Work intent: implement',
  '- Risk: low',
  '- Complexity: moderate',
  '- Brainstorm required: no',
  '',
  'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36):',
  '- Trivial tasks (single typo / single-line edit / single-question lookup / pure conversational answer) → answer or execute directly. Do NOT call `todo_update`.',
  '- Non-trivial tasks (≥2 distinct execution steps OR touching ≥2 files / areas / feature threads) → your FIRST tool call MUST be `todo_update` with the full plan.',
  '- If a task you started as trivial turns out to be multi-step mid-flight, call `todo_update` AT THAT MOMENT to retrofit the plan — do not silently grow scope.',
  '- Each non-trivial item should carry a status (`pending` / `in_progress` / `completed` / `failed` / `cancelled`). Mark exactly ONE item `in_progress` at a time.',
  "- Items with verifiable acceptance gates may carry an optional `evaluator` hint: `'build' | 'test' | 'lint'`. The runner runs the corresponding deterministic check on `pending → completed`; failure surfaces stderr in your next tool result so you can self-correct. Use sparingly — only on milestone steps with a real ground-truth check.",
  '- Replan iteratively: insert / cancel / adjust items via `todo_update` as the picture firms up. Do NOT reset the entire list mid-task; reserve full reset for explicit "start over" decisions.',
  '',
  'CONCRETE FIRST-TURN EXAMPLE (non-fan-out multi-step — single file, 2-3 steps):',
  '  todo_update({op:"init", items:[',
  '    {id:"todo_1", content:"Read packages/core/src/timeout.ts to locate withTimeout", activeForm:"Reading timeout.ts"},',
  '    {id:"todo_2", content:"Add negative-timeout guard to withTimeout",                  activeForm:"Adding guard"},',
  '    {id:"todo_3", content:"Run build to verify the change typechecks",                  activeForm:"Running build", evaluator:"build"}',
  '  ]})',
  '  [then proceed with read / edit / bash to execute the plan]',
  '',
  'ANTI-PATTERNS for plan commit (NEVER emit any of these on a non-trivial task):',
  '  BAD (silent narration):    "I\'ll plan first. Step 1: read X. Step 2: edit Y. Step 3: build."  [then directly calls read]',
  '  BAD (markdown header):     "## Plan\\n- Read X\\n- Edit Y\\n- Run build"                          (markdown is not a tool call)',
  '  BAD (delayed init):        [reads X, edits Y, builds, THEN calls todo_update at the end]      (the plan list is invisible during the work)',
  '  GOOD: `todo_update({op:"init", items:[...]})` as the FIRST tool call, BEFORE any read/edit/bash.',
  '',
  '- Why this matters: the realtime plan list (TodoListSurface) only renders AFTER `todo_update({op:"init"})` is parsed. Markdown bullets in your text response do not drive the UI — the user sees a blank screen for 30+ seconds while you investigate, cannot intervene, cannot trust you\'re on track. "Plan in markdown only" is structurally equivalent to "no plan at all" from the user\'s point of view.',
  '',
  'DISPATCH RULES (`dispatch_child_task` / `await_child_task`):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations, launch each as a child task with `readOnly: true`.',
  '- RULE C — write fan-out: NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children.',
  '- DO NOT dispatch a single child task — the coordination cost is wasted on N=1.',
  '',
  'EVALUATOR HANDOFF (KodaX structural gate, preserved as an independent role):',
  '- When your plan is complete (all non-cancelled items `completed`), call `emit_handoff` with the artifacts you want the Evaluator to audit.',
  '- The Evaluator runs in a fresh read-only session, audits your changes, and returns `accept` (terminal success), `revise` (your turn again — fix the called-out issues), or `blocked` (terminal failure).',
  '- You CANNOT bypass the Evaluator. Trying to terminate the run with a final text answer instead of `emit_handoff` will be rejected by the runner.',
].join('\n');

const TOOL_DOCS_BLURB = [
  '## Available Tools',
  '',
  '`todo_update`:',
  '  Mode A — `op:"init"` — commit / replace plan list.',
  '    Input:  { op:"init", items:[{id:string, content:string, activeForm?:string, evaluator?:"build"|"test"|"lint"}, ...] }',
  '  Mode B — `op:"update"` — single-item state transition.',
  '    Input:  { id:string, status:"in_progress"|"completed"|"failed"|"cancelled" }',
  '',
  '`emit_handoff`:',
  '  Input:  { summary:string, artifacts?:string[] }',
  '  Hands the run off to the Evaluator. ONLY call this when your plan is complete.',
  '',
  '`dispatch_child_task` / `await_child_task`:',
  '  See DISPATCH RULES — only use when ≥3 independent children are warranted.',
  '',
  '`read` / `grep` / `edit`:',
  '  Standard file inspection / mutation tools.',
].join('\n');

const SYSTEM_PROMPT = [WORKER_PROMPT_V2_SECTIONS, '', TOOL_DOCS_BLURB].join(
  '\n',
);

function buildPlanCompleteEmitsHandoffVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description:
      'Plan complete (2/2 items completed) → expect emit_handoff in next move',
    systemPrompt: SYSTEM_PROMPT,
    // Use priorMessages to establish that the LLM has already executed a
    // 2-item plan. The user's final turn explicitly asks "what next" so the
    // model is forced to articulate its terminal move.
    priorMessages: [
      { role: 'user', content: 'Add input validation to `parseConfig` in `packages/core/src/config.ts`.' },
      {
        role: 'assistant',
        content:
          'I will plan first, then execute.\n\n' +
          'todo_update({op:"init", items:[\n' +
          '  {id:"todo_1", content:"Read packages/core/src/config.ts to locate parseConfig", activeForm:"Reading config.ts"},\n' +
          '  {id:"todo_2", content:"Add input validation in parseConfig", activeForm:"Adding validation", evaluator:"build"}\n' +
          ']})',
      },
      { role: 'user', content: '(tool_result) Plan committed: 2 items pending.' },
      {
        role: 'assistant',
        content:
          'todo_update({id:"todo_1", status:"in_progress"})\n\n' +
          'read({path:"packages/core/src/config.ts"})',
      },
      { role: 'user', content: '(tool_result) [file contents shown — parseConfig at line 42]\n\ntodo_update updated: todo_1 → in_progress.' },
      {
        role: 'assistant',
        content:
          'todo_update({id:"todo_1", status:"completed"})\n' +
          'todo_update({id:"todo_2", status:"in_progress"})\n\n' +
          'edit({path:"packages/core/src/config.ts", old_string:"function parseConfig(input) {", new_string:"function parseConfig(input) {\\n  if (typeof input !== \'object\' || input === null) throw new TypeError(\'parseConfig requires an object\');"})',
      },
      { role: 'user', content: '(tool_result) edit applied. todo_1: completed, todo_2: in_progress.\n\nDeterministic evaluator (build) ran on todo_2 transition: PASS.\n\ntodo_update({id:"todo_2", status:"completed"})' },
    ],
    userMessage:
      'Both plan items are now completed (1/1 → completed, 2/2 → completed, build evaluator passed). What is your next move?',
  };
}

function buildMultiStepNoFanoutSeedsPlanVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description:
      'Multi-step single-file implementation, expect op:init with ≥2 items, no fan-out',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'In `packages/core/src/timeout.ts`, find the function `withTimeout` ' +
      'and add a guard that throws if the timeout is negative. After the ' +
      'edit, run the build to verify the change typechecks. Plan first.',
  };
}

function buildTrivialLookupNoHandoffVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Single-line lookup, expect no op:init, no emit_handoff',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'What does line 42 of `packages/core/src/config.ts` say? Just paste ' +
      'the one line back to me.',
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'plan_complete_emits_handoff':
      return buildPlanCompleteEmitsHandoffVariant();
    case 'multi_step_no_fanout_seeds_plan':
      return buildMultiStepNoFanoutSeedsPlanVariant();
    case 'trivial_lookup_no_handoff':
      return buildTrivialLookupNoHandoffVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic, zero-LLM. Tool-call binding is not present in the
// harness, so we look for literal tool-name substrings in the model's output
// text (model may emit the call as a JSON block / tool_use markdown / fenced
// code). Mirrors sibling `feature-151-fan-out-plan-granularity` patterns.
//
// Per EVAL_GUIDELINES anti-pattern 7: negative-case judges (does NOT mention
// X) are the high-risk category for false-negatives. The driver complements
// these with raw-output dump for offline LLM-judge cross-validation.
// ---------------------------------------------------------------------------

const HANDOFF_PATTERN = /emit_handoff/i;
const OP_INIT_PATTERN = /op["\s:]+["']?init["']?/i;
const TODO_UPDATE_PATTERN = /todo_update/i;
const DISPATCH_PATTERN = /dispatch_child_task/i;

function judgesPlanCompleteEmitsHandoff(): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_emit_handoff',
      category: 'correctness',
      judge: (out) =>
        HANDOFF_PATTERN.test(out)
          ? { passed: true }
          : { passed: false, reason: 'plan complete but output does not mention emit_handoff' },
    },
  ];
}

function judgesMultiStepNoFanoutSeedsPlan(minItems: number): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_op_init',
      category: 'correctness',
      judge: (out) =>
        OP_INIT_PATTERN.test(out)
          ? { passed: true }
          : { passed: false, reason: "multi-step task but output does not reference op:'init'" },
    },
    {
      name: `mentions_at_least_${minItems}_items`,
      category: 'correctness',
      judge: (out) => {
        // Anti-pattern 7 fix (post-2026-05-10 hardening): the original
        // regex required the `todo_` prefix that only appears in the
        // dataset's WORKED EXAMPLE. Production LLMs commonly emit
        // `id:"1"`, `id:"2"`, ... instead, and that's still a valid
        // op:"init" item. Count any quoted-id occurrence inside an
        // `items` array region — bounded to the items region so prose
        // mentions of "id" outside the call don't inflate the count.
        const lower = out.toLowerCase();
        const itemsIdx = lower.indexOf('items');
        if (itemsIdx < 0) return { passed: false, reason: 'no items array found' };
        const tail = out.slice(itemsIdx);
        // Take a generous window after `items` — most calls fit within
        // a few KB. We cap at 4kB so a runaway prose response that
        // happens to contain `items` and unrelated `id:` later doesn't
        // false-pass.
        const region = tail.slice(0, 4096);
        const matches = region.match(/\bid\s*:?\s*["'`]/gi);
        const itemCount = matches ? matches.length : 0;
        if (itemCount >= minItems) return { passed: true };
        return {
          passed: false,
          reason: `expected ≥${minItems} todo items in op:'init' payload, found ${itemCount}`,
        };
      },
    },
    {
      name: 'does_not_mention_dispatch_child_task',
      category: 'correctness',
      judge: (out) =>
        DISPATCH_PATTERN.test(out)
          ? {
              passed: false,
              reason: 'single-file 2-step task should NOT trigger fan-out (dispatch_child_task)',
            }
          : { passed: true },
    },
  ];
}

function judgesTrivialNoHandoff(): readonly PromptJudge[] {
  return [
    {
      name: 'does_not_call_op_init',
      category: 'correctness',
      judge: (out) =>
        OP_INIT_PATTERN.test(out)
          ? {
              passed: false,
              reason: "output references op:'init' on a trivial single-step task",
            }
          : { passed: true },
    },
    {
      name: 'does_not_call_todo_update',
      category: 'correctness',
      judge: (out) =>
        TODO_UPDATE_PATTERN.test(out)
          ? {
              passed: false,
              reason: 'output references todo_update on a trivial single-step task',
            }
          : { passed: true },
    },
    {
      name: 'does_not_emit_handoff',
      category: 'correctness',
      judge: (out) =>
        HANDOFF_PATTERN.test(out)
          ? {
              passed: false,
              reason: 'output references emit_handoff on a task that has no plan',
            }
          : { passed: true },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'plan_complete_emits_handoff':
      return judgesPlanCompleteEmitsHandoff();
    case 'multi_step_no_fanout_seeds_plan':
      return judgesMultiStepNoFanoutSeedsPlan(2);
    case 'trivial_lookup_no_handoff':
      return judgesTrivialNoHandoff();
  }
}
