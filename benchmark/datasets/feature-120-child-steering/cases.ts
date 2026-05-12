/**
 * Dataset — FEATURE_120 Phase 5b (v0.7.39) async-child-steering eval cases.
 *
 * Verifies the `ASYNC CHILD STEERING` section added to Worker
 * role-prompt in v0.7.39 Phase 5a (see
 * `packages/coding/src/agents/worker-role-prompt.ts` `childSteeringRules`
 * constant). The section teaches when to reach for `send_message`
 * (push instruction to an in-flight child) and `task_stop` (graceful
 * abort), and the anti-patterns the prompt explicitly forbids.
 *
 * Two cases, both POSITIVE (model SHOULD reach for the steering tool):
 *
 *   1. **send_message_trigger** — user adds a follow-up requirement mid-
 *      task while a security-audit child is in flight. Worker should
 *      `send_message(to=<task_id>, content="…")` to push the requirement
 *      into the child's queue, NOT redispatch a new child and NOT just
 *      answer the user in text.
 *
 *   2. **task_stop_trigger** — a read-only child has clearly gone off-
 *      scope (it started invoking write tools). Worker should
 *      `task_stop(<task_id>, reason="…")` to abort it gracefully, NOT
 *      let it keep burning context.
 *
 * Per EVAL_GUIDELINES anti-pattern 7 (negative-regex assertions need an
 * LLM-judge tiebreak): both cases here are POSITIVE assertions ("must
 * mention `send_message` / `task_stop` AND must reference the in-flight
 * `task_id`"). No negative-regex case — that anti-pattern is the reason
 * FEATURE_120's `model_hint` is INTENTIONALLY excluded from this eval.
 * `model_hint` is a no-op for routing in v0.7.39 (FEATURE_102 v0.7.45
 * will wire it up); evaluating "model picks the right hint" today would
 * be testing a property that has no observable production effect.
 *
 * **Design source**: `docs/features/v0.7.39.md` Phase 5b §"Layer 2 probe".
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention. The
 * canned priorMessages establish a worker turn that has already
 * `dispatch_child_task`'d a child and received its `task_id`. The user
 * message is the trigger event (follow-up requirement / off-scope
 * tool-call leak). The mechanical assertion checks that the LLM's NEXT
 * tool call is the right steering tool against the right task_id.
 *
 * Stage-1 acceptance per design (pre-registered, BEFORE any LLM call):
 *
 *   - SHIP:    ≥3 of 5 aliases hit ≥80% pass on EACH positive case
 *              → ship Phase 5b prompt in v0.7.39 as designed
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but mention the
 *              right tool name in text without committing the tool call
 *              → ship anyway, document weaker-model behaviour in the
 *              test guide; revisit prompt in v0.7.40 if user reports
 *              missed steerings in prod
 *   - REJECT:  0 aliases ≥80% positive
 *              → revert Phase 5a prompt block, redesign
 *
 * **Why this lives next to fan-out plan-granularity / todo-self-seeding
 * datasets**: same Worker role-prompt source, same single-turn probe
 * shape, same `runBenchmark` driver, same per-alias raw-output dump
 * pattern. Distinct case shape (must-call vs must-not-call) keeps this
 * file separate from the FEATURE_151 datasets.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId = 'send_message_trigger' | 'task_stop_trigger';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** Tool name the model is expected to call (mechanical assertion target). */
  readonly expectTool: 'send_message' | 'task_stop';
  /** Task id present in the canned priorMessages that the model must target. */
  readonly expectTaskId: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'send_message_trigger',
    description:
      "User adds a within-scope constraint refinement mid-task. A security-" +
      "audit child for `packages/coding` is in flight (task_id=task_001). " +
      "The user's follow-up is a CONSTRAINT on the SAME audit ('skip the " +
      "vendored libraries under packages/coding/vendor/'), not a new module " +
      "— so a sibling dispatch would be wrong (no new investigation scope) " +
      "and a text-only answer leaves the child working in the wrong scope. " +
      "Worker should push the constraint into the child's queue via " +
      "`send_message(to=task_001, content=...)`.\n" +
      "\n" +
      "**Case-design note (v0.7.39 Phase 5b second-pass)**: an earlier " +
      "version of this case used 'also check the auth module' — that " +
      "phrasing turned out to be ambiguous between 'widen task_001's scope' " +
      "(send_message) and 'fan out a parallel sibling' (dispatch_child_task), " +
      "and 3/5 aliases chose the parallel-dispatch strategy as a valid " +
      "architectural alternative. Switching to a within-scope constraint " +
      "refinement removes the ambiguity: no sibling task can be dispatched " +
      "because there's no new investigation scope to dispatch INTO.",
    behaviour:
      'output references `send_message` AND mentions the in-flight task id `task_001`',
    expectTool: 'send_message',
    expectTaskId: 'task_001',
  },
  {
    id: 'task_stop_trigger',
    description:
      'A read-only child has clearly gone off-scope: it was dispatched with ' +
      '`readOnly: true` to investigate `packages/coding`, but its first tool ' +
      'call was `write` on `packages/coding/src/index.ts`. Worker should ' +
      'abort it gracefully via `task_stop(task_002, reason=...)`, not let it ' +
      'keep burning context.',
    behaviour:
      'output references `task_stop` AND mentions the off-scope task id `task_002`',
    expectTool: 'task_stop',
    expectTaskId: 'task_002',
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.39"). Single-variant
// runs surface as a flat acceptance matrix; no A/B comparison axis here
// (the A baseline would be "Worker prompt without ASYNC CHILD STEERING",
// but that block is small enough that A/B is unnecessary at pilot stage).
//
// The SYSTEM_PROMPT replicates the essence of the Worker role-prompt
// sections that are RELEVANT to async-child-steering decisions. Source
// of truth lives in `packages/coding/src/agents/worker-role-prompt.ts`;
// this is a controlled snapshot keyed to v0.7.39 Phase 5a. The unit
// test `worker-role-prompt.test.ts` (`emits the ASYNC CHILD STEERING
// section`) pins the source-side text so any divergence between source
// and this snapshot will surface when the unit test is updated to
// match a future source change.
//
// Per EVAL_GUIDELINES Layer 2 §"controlled input": the LLM input is
// the exact bytes the model sees, not a re-derivation through
// `runKodaX`. Embedding the prompt text here makes the eval
// reproducible and makes the failure surface unambiguous (a fail =
// the LLM failed to follow THIS exact prompt, not "the runner stitched
// something wrong").
// ---------------------------------------------------------------------------

const WORKER_PROMPT_STEERING_SECTIONS = [
  "You are the Worker — KodaX's single primary agent for this task. Routing decision summary:",
  '- Primary task: investigate',
  '- Work intent: review',
  '- Risk: low',
  '- Complexity: moderate',
  '- Brainstorm required: no',
  '',
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations, launch each as a child with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take ≥45s, dispatch as a child and continue with other tools while it runs.',
  '- IDLE-YIELD: after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful. When out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner resumes you on `<task-completed task_id="…">…</task-completed>` banners.',
  '',
  'ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — `send_message` + `task_stop`):',
  'After `dispatch_child_task` launches a child, you may steer it while it runs:',
  '- `send_message(to=task_id, content="…")` — append an instruction to the child\'s queue. The child sees it as a `<coordinator-instruction>` block at its next LLM turn boundary. Use SPARINGLY: a child that needed more context is a planning failure — the typical pattern is 0-1 send_message calls per child.',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully. Its currently-executing tool finishes atomically (no hard kill of a 90s `npm test` mid-run); the child then sees a `<coordinator-stop-request>` reminder and emits a final summary.',
  '',
  'WHEN TO `send_message`:',
  '- The user added a follow-up requirement mid-task that materially affects an in-flight child (e.g., "also check the auth module" while a security-audit child is running).',
  '- You realized the child needs a constraint you forgot to set (e.g., "ignore vendored libraries under `third_party/`").',
  '- DO NOT use it to chat with the child or to ask follow-up questions — the child has no idle wait for your reply; the next message just lands in its queue at the next drain.',
  '',
  'WHEN TO `task_stop`:',
  '- The child went off-scope (e.g., started writing files when launched read-only, or wandered into unrelated modules).',
  '- The user cancelled the parent task that justified this child.',
  '- The child is pathologically slow with no progress signal AND a faster path exists.',
  '- DO NOT task_stop a child just because it is slow but progressing — wait for it. Premature task_stop wastes the work already done.',
  '',
  'PROMPT-INVARIANT: both tools are no-ops in sync-mode dispatch (no childTaskRegistry / childAbortControllers). Async dispatch is the default; sync only fires when `KODAX_ASYNC_DISPATCH=0` is set. Calling either tool in sync mode returns `[Tool Error]`.',
].join('\n');

const TOOL_DOCS_BLURB = [
  '## Available Tools',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly:boolean, scope_summary?:string, model_hint?:"fast"|"balanced"|"deep" }',
  '  Output: { task_id:string }   (returns immediately; runs in background)',
  '',
  '`send_message`:',
  '  Input:  { to:string, content:string }',
  '  Effect: pushes `content` onto child `to`\'s queue. Visible to the child at its next turn boundary as a `<coordinator-instruction>` block.',
  '',
  '`task_stop`:',
  '  Input:  { task_id:string, reason?:string }',
  '  Effect: signals child `task_id` to exit gracefully after its currently-running tool finishes.',
  '',
  '`read` / `grep` / `glob`:',
  '  Standard read-only file inspection tools.',
].join('\n');

const SYSTEM_PROMPT = [
  WORKER_PROMPT_STEERING_SECTIONS,
  '',
  TOOL_DOCS_BLURB,
].join('\n');

function buildSendMessageTriggerVariant(): PromptVariant {
  return {
    id: 'v0.7.39',
    description:
      'User adds within-scope constraint refinement; expect send_message(to=task_001)',
    systemPrompt: SYSTEM_PROMPT,
    priorMessages: [
      {
        role: 'user',
        content:
          'Run a security audit of `packages/coding` — look for input ' +
          'validation gaps, secret handling, and error-message leakage.',
      },
      {
        role: 'assistant',
        content:
          "I'll dispatch this as a read-only child task so we can keep " +
          "going if you have follow-ups.\n\n" +
          '<tool_call>dispatch_child_task({id:"sec-audit-coding", ' +
          'objective:"Security audit of packages/coding: input validation, ' +
          'secret handling, error-message leakage", readOnly:true})</tool_call>\n\n' +
          'Child dispatched: task_id=task_001. Running now.',
      },
    ],
    // Within-scope constraint refinement. A sibling dispatch is NOT a valid
    // alternative here — there is no new investigation scope to dispatch
    // into; the constraint applies only to the SAME audit already running.
    // Matches the prompt's own second `send_message` use case ("you realized
    // the child needs a constraint you forgot to set").
    userMessage:
      'One thing I forgot — skip the vendored libraries under ' +
      '`packages/coding/vendor/`. Those aren\'t ours and the findings ' +
      'would just be noise.',
  };
}

function buildTaskStopTriggerVariant(): PromptVariant {
  return {
    id: 'v0.7.39',
    description:
      'Read-only child invoked a write tool (off-scope); expect task_stop(task_002)',
    systemPrompt: SYSTEM_PROMPT,
    priorMessages: [
      {
        role: 'user',
        content:
          'Investigate `packages/coding` for unused exports — just give me ' +
          'a list, no changes.',
      },
      {
        role: 'assistant',
        content:
          "Dispatching as a read-only child.\n\n" +
          '<tool_call>dispatch_child_task({id:"unused-exports-coding", ' +
          'objective:"List unused exports in packages/coding (read-only)", ' +
          'readOnly:true})</tool_call>\n\n' +
          'Child dispatched: task_id=task_002. Running now.',
      },
      {
        role: 'user',
        content:
          '<child-progress task_id="task_002">First tool call: ' +
          '`write({path:"packages/coding/src/index.ts", ' +
          'content:"// auto-cleanup of unused exports\\n..."})`. ' +
          'This child was dispatched read-only — write is off-scope.' +
          '</child-progress>',
      },
    ],
    userMessage:
      'That child is going off the rails — it should be read-only but it ' +
      "just tried to write to `packages/coding/src/index.ts`. Shut it down.",
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'send_message_trigger':
      return buildSendMessageTriggerVariant();
    case 'task_stop_trigger':
      return buildTaskStopTriggerVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic, zero-LLM. Tool-call binding is not exposed
// through `runOneShot.text` (only `toolCalls`), so we look for the tool
// name as a literal substring AND the target task_id as a literal
// substring in the model's output text. The model may surface the call
// as a JSON block / tool_use markdown / fenced code / inline mention —
// the regex pattern is permissive enough to catch all four shapes.
//
// Mirrors the sibling FEATURE_151 dataset judge style (regex on text
// output), not toolCalls inspection — that keeps the eval portable
// across providers that don't all surface tool calls via the same
// streaming shape.
// ---------------------------------------------------------------------------

function buildSendMessageJudges(taskId: string): readonly PromptJudge[] {
  const toolPattern = /send_message\s*\(/i;
  const taskIdPattern = new RegExp(`\\b${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return [
    {
      name: 'mentions_send_message_tool',
      category: 'correctness',
      judge: (out) => {
        return toolPattern.test(out)
          ? { passed: true }
          : { passed: false, reason: 'output does not call `send_message`' };
      },
    },
    {
      name: `mentions_target_task_id_${taskId}`,
      category: 'correctness',
      judge: (out) => {
        return taskIdPattern.test(out)
          ? { passed: true }
          : { passed: false, reason: `output does not reference target task id ${taskId}` };
      },
    },
  ];
}

function buildTaskStopJudges(taskId: string): readonly PromptJudge[] {
  const toolPattern = /task_stop\s*\(/i;
  const taskIdPattern = new RegExp(`\\b${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return [
    {
      name: 'mentions_task_stop_tool',
      category: 'correctness',
      judge: (out) => {
        return toolPattern.test(out)
          ? { passed: true }
          : { passed: false, reason: 'output does not call `task_stop`' };
      },
    },
    {
      name: `mentions_target_task_id_${taskId}`,
      category: 'correctness',
      judge: (out) => {
        return taskIdPattern.test(out)
          ? { passed: true }
          : { passed: false, reason: `output does not reference target task id ${taskId}` };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'send_message_trigger':
      return buildSendMessageJudges('task_001');
    case 'task_stop_trigger':
      return buildTaskStopJudges('task_002');
  }
}
