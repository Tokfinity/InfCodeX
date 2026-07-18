/**
 * Dataset — FEATURE_165 (v0.7.41) Worker prompt `HARD PRECONDITION` for
 * `emit_handoff` while children pending.
 *
 * ## What this validates
 *
 * The runtime gate at `packages/coding/src/task-engine/runner-driven.ts`
 * around line 2402 deterministically rejects `emit_handoff` when
 * `ctx.childTaskRegistry.size > 0` (returns `isError:true` with no
 * metadata). The gate is the hard backstop; this eval validates the
 * **complementary prompt change**: an explicit HARD PRECONDITION line
 * in `worker-role-prompt.ts` `handoffRules` that teaches the Worker
 * to defer `emit_handoff` text-only until every dispatched child has
 * returned a `<task-completed>` banner.
 *
 * The prompt addition is a "nice-to-have" — the gate covers the bug
 * even if the LLM ignores the new line. But because the addition sits
 * in the same paragraph as the existing emit_handoff trigger rules,
 * it has known cross-case regression risk (cf. memory feedback
 * `feedback_prompt_strengthening_cross_case_regression` — FEATURE_120
 * v3 strengthened send_message at the cost of -60pp on task_stop).
 *
 * ## Cases (5: 3 positive + 2 negative)
 *
 * Each case is a single-turn LLM probe — fixed system prompt + canned
 * priorMessages + canned userMessage → assert the LLM's NEXT response
 * tool-call shape via mechanical regex (per EVAL_GUIDELINES anti-pattern
 * 7 §4 — multi-syntax tool-name detection).
 *
 *   POSITIVE (must-call emit_handoff — checks no cross-case regression
 *   from the new prompt addition):
 *
 *     A. `pos_no_dispatch_history` — Worker did pure read/grep work, no
 *        `dispatch_child_task` ever, plan items all completed. The
 *        natural next move is `emit_handoff(status="ready")`.
 *
 *     B. `pos_all_children_returned` — Worker dispatched 3 children,
 *        all returned `<task-completed>` banners, plan items all
 *        completed. Natural next move: `emit_handoff(status="ready")`.
 *
 *     C. `pos_blocked_after_stop_completed` — Worker dispatched 1 child,
 *        decided to abandon, `task_stop`'d it, received the
 *        `<task-completed task_id="…" error="stopped: …">` banner. Plan
 *        flagged blocked. Natural next move: `emit_handoff(status="blocked")`.
 *
 *   NEGATIVE (must-NOT call emit_handoff — primary signal that the
 *   prompt addition is doing useful work):
 *
 *     D. `neg_pending_with_incomplete_plan` — Worker dispatched 3
 *        children, has not yet seen any `<task-completed>` banner,
 *        plan items still in_progress. Calling emit_handoff here is
 *        the production bug we're addressing (2026-05-15 trace).
 *
 *     E. `neg_just_dispatched_no_idle_work` — Worker just dispatched 2
 *        children in the last turn, has nothing else useful to do.
 *        The temptation to emit_handoff "to wrap up" is highest here.
 *        Correct behaviour per prompt: end text-only ("waiting for
 *        children") with NO tool calls.
 *
 * ## Variants — two per case
 *
 *   - `v_baseline` — current `worker-role-prompt.ts` `handoffRules`,
 *     verbatim. The existing language teaches "when your plan is
 *     complete, call emit_handoff" but does NOT explicitly tell the
 *     model what "complete" means when children are pending.
 *
 *   - `v_proposed` — `v_baseline` + the HARD PRECONDITION + task_stop
 *     escape-hatch lines (drafted in the v0.7.41 design doc). Same
 *     handoffRules paragraph, identical surrounding context.
 *
 * Both variants render through an identical SYSTEM_PROMPT skeleton
 * (worker role-prompt's IDLE-YIELD + DISPATCH RULES sections are
 * verbatim) so the LLM sees the same conversational frame — the only
 * delta is the HARD PRECONDITION text.
 *
 * ## Source of truth
 *
 * `worker-role-prompt.ts` is the production source. The variants below
 * are CONTROLLED SNAPSHOTS keyed to v0.7.41. If the source diverges
 * (anyone edits the relevant prompt sections), the structural pinning
 * test `worker-role-prompt.test.ts` should fail and force a snapshot
 * update here too — same coupling pattern as FEATURE_120's dataset.
 *
 * ## See also
 *
 *   - `docs/features/v0.7.41.md` §FEATURE_165 — design + acceptance
 *     matrix
 *   - `tests/feature-165-handoff-wait-gate.eval.ts` — driver
 *   - `benchmark/datasets/feature-120-child-steering/cases.ts` —
 *     sibling pattern (multi-syntax tool detection,
 *     `buildToolNamePatterns`)
 *   - EVAL_GUIDELINES.md anti-pattern 7 — why negative cases require
 *     LLM-judge audit on every regex-fail
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'pos_no_dispatch_history'
  | 'pos_all_children_returned'
  | 'pos_blocked_after_stop_completed'
  | 'neg_pending_with_incomplete_plan'
  | 'neg_just_dispatched_no_idle_work';

export interface CaseSpec {
  readonly id: CaseId;
  /** Mechanical assertion intent: does the response invoke emit_handoff or not? */
  readonly polarity: 'must_call_emit_handoff' | 'must_not_call_emit_handoff';
  readonly description: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'pos_no_dispatch_history',
    polarity: 'must_call_emit_handoff',
    description:
      'Worker completed pure read/grep work; plan items all completed; ' +
      'no dispatch_child_task in transcript. Natural next move: emit_handoff(ready).',
  },
  {
    id: 'pos_all_children_returned',
    polarity: 'must_call_emit_handoff',
    description:
      'Worker dispatched 3 children; all 3 <task-completed> banners arrived; ' +
      'plan items all completed. Natural next move: emit_handoff(ready).',
  },
  {
    id: 'pos_blocked_after_stop_completed',
    polarity: 'must_call_emit_handoff',
    description:
      'Worker dispatched 1 child, task_stop\'d it, received the stopped ' +
      '<task-completed> banner; plan reflects blocked. Natural next move: ' +
      'emit_handoff(blocked). The escape-hatch path the proposed prompt teaches.',
  },
  {
    id: 'neg_pending_with_incomplete_plan',
    polarity: 'must_not_call_emit_handoff',
    description:
      'Worker dispatched 3 children; NO <task-completed> banner has arrived ' +
      'yet; plan items still in_progress. Calling emit_handoff here orphans ' +
      'the children — this is the production bug (2026-05-15 trace).',
  },
  {
    id: 'neg_just_dispatched_no_idle_work',
    polarity: 'must_not_call_emit_handoff',
    description:
      'Worker dispatched 2 children one turn ago, has nothing else useful to ' +
      'do. Temptation to emit_handoff "to wrap up" peaks here. Correct: ' +
      'text-only "waiting for children" with no tool calls.',
  },
] as const;

// ---------------------------------------------------------------------------
// Worker prompt snapshots — keyed to v0.7.41.
//
// PROMPT_BODY_SHARED is the parts of the Worker system prompt that don't
// change between v_baseline and v_proposed (role ack, IDLE-YIELD rules,
// existing handoffRules header). HANDOFF_RULES_BASELINE / _PROPOSED are
// the two competing tail blocks. The dataset asserts on the LLM's
// response to the SAME priorMessages + userMessage, so the ONLY input
// delta between variants is HANDOFF_RULES.
//
// Source-of-truth divergence guard: a structural pinning test in
// `worker-role-prompt.test.ts` (added alongside FEATURE_165) MUST
// contain the literal HARD PRECONDITION sentence. If anyone edits
// either side, the pin breaks and the snapshot here must be updated.
// ---------------------------------------------------------------------------

const PROMPT_BODY_SHARED = [
  "You are the Worker — KodaX's single primary agent for this task. Routing decision summary:",
  '- Primary task: investigate',
  '- Work intent: review',
  '- Risk: low',
  '- Complexity: moderate',
  '- Brainstorm required: no',
  '',
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful. When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will resume you on the next `<task-completed task_id="…">…</task-completed>` banner.',
  '',
  'ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — `send_message` + `task_stop`):',
  '- `task_stop(task_id, reason="…")` — request the child to exit gracefully. Its currently-executing tool finishes atomically; the child then sees a `<coordinator-stop-request>` reminder and emits a final summary.',
].join('\n');

const HANDOFF_RULES_BASELINE = [
  'EVALUATOR HANDOFF (KodaX structural gate, preserved as an independent role):',
  '- When your plan is complete (all non-cancelled items `completed`), call `emit_handoff` with the artifacts you want the Evaluator to audit.',
  '- The Evaluator runs in a fresh read-only session, audits your changes, and returns `accept` (terminal success), `revise` (your turn again — fix the called-out issues), or `blocked` (terminal failure).',
  '- You CANNOT bypass the Evaluator. Trying to terminate the run with a final text answer instead of `emit_handoff` will be rejected by the runner.',
].join('\n');

const HANDOFF_RULES_PROPOSED = [
  'EVALUATOR HANDOFF (KodaX structural gate, preserved as an independent role):',
  '- When your plan is complete (all non-cancelled items `completed`), call `emit_handoff` with the artifacts you want the Evaluator to audit.',
  '- HARD PRECONDITION — every `dispatch_child_task` you fired this run MUST have produced a matching `<task-completed task_id="…">` block in your transcript before you call `emit_handoff`. If ANY child is still in flight, DO NOT call `emit_handoff` this turn — end with text only and let the runner wake you on the next `<task-completed>`. Calling emit_handoff with pending children orphans their work and ships a half-finished run to the Evaluator.',
  '- To abandon a child instead of waiting, call `task_stop(task_id, reason="…")` first; emit_handoff only after the resulting `<task-completed>` arrives (it carries `error="stopped: …"`).',
  '- The Evaluator runs in a fresh read-only session, audits your changes, and returns `accept` (terminal success), `revise` (your turn again — fix the called-out issues), or `blocked` (terminal failure).',
  '- You CANNOT bypass the Evaluator. Trying to terminate the run with a final text answer instead of `emit_handoff` will be rejected by the runner.',
].join('\n');

const TOOL_DOCS_BLURB = [
  '## Available Tools',
  '',
  '`dispatch_child_task`:  Input { id, objective, readOnly }; returns { task_id }. Runs in background.',
  '`task_stop`:            Input { task_id, reason? }; signals child to exit gracefully.',
  '`emit_handoff`:         Input { status: "ready"|"incomplete"|"blocked", summary?, evidence?[], followup?[] }; hands off to Evaluator.',
  '`read` / `grep` / `glob`: standard read-only file inspection tools.',
  '`todo_update`:          Input { op: "init"|"set", items?, id?, status? }; manages plan list.',
].join('\n');

function buildSystemPrompt(variant: 'baseline' | 'proposed'): string {
  return [
    PROMPT_BODY_SHARED,
    '',
    variant === 'proposed' ? HANDOFF_RULES_PROPOSED : HANDOFF_RULES_BASELINE,
    '',
    TOOL_DOCS_BLURB,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-case canned histories. Each `buildCaseScene` returns the
// `(priorMessages, userMessage)` pair shared across both variants.
// SystemPrompt is variant-specific and built above.
// ---------------------------------------------------------------------------

interface SceneFragment {
  readonly priorMessages: PromptVariant['priorMessages'];
  readonly userMessage: string;
}

function sceneNoDispatchHistory(): SceneFragment {
  return {
    priorMessages: [
      {
        role: 'user',
        content:
          'Summarize what `packages/coding/README.md` says about the runner-driven path.',
      },
      {
        role: 'assistant',
        content:
          "I'll plan, read the file, then summarize.\n\n" +
          '<tool_call>todo_update({op:"init", items:[' +
          '{id:"todo_1", content:"Read packages/coding/README.md", activeForm:"Reading README"},' +
          '{id:"todo_2", content:"Extract runner-driven path notes", activeForm:"Extracting notes"}' +
          ']})</tool_call>\n\n' +
          '<tool_call>read({path:"packages/coding/README.md"})</tool_call>\n\n' +
          'Read complete. Key points: the runner-driven path is the default since v0.7.38; ' +
          'Worker is the V2 single-loop primary; emit_handoff hands to Evaluator.\n\n' +
          '<tool_call>todo_update({op:"set", id:"todo_1", status:"completed"})</tool_call>\n' +
          '<tool_call>todo_update({op:"set", id:"todo_2", status:"completed"})</tool_call>\n\n' +
          'Plan complete. Both items marked done.',
      },
    ],
    userMessage: 'Looks good — proceed.',
  };
}

function sceneAllChildrenReturned(): SceneFragment {
  return {
    priorMessages: [
      {
        role: 'user',
        content:
          'Audit `packages/llm`, `packages/agent`, and `packages/coding` for unused exports — read-only.',
      },
      {
        role: 'assistant',
        content:
          'Three independent read-only investigations — fan out as children.\n\n' +
          '<tool_call>todo_update({op:"init", items:[' +
          '{id:"todo_1", content:"Audit packages/llm", activeForm:"Auditing llm"},' +
          '{id:"todo_2", content:"Audit packages/agent", activeForm:"Auditing agent"},' +
          '{id:"todo_3", content:"Audit packages/coding", activeForm:"Auditing coding"}' +
          ']})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-llm", objective:"unused exports in packages/llm", readOnly:true})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-agent", objective:"unused exports in packages/agent", readOnly:true})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-coding", objective:"unused exports in packages/coding", readOnly:true})</tool_call>\n\n' +
          'Children dispatched: task_id=task_001 (llm), task_id=task_002 (agent), task_id=task_003 (coding). ' +
          'Idling until they return.',
      },
      {
        role: 'user',
        content:
          '<task-completed task_id="task_001">' +
          'packages/llm: 3 unused exports — `LegacyToolBinding` (ai-providers/index.ts), ' +
          '`__internal_resetClient` (testing.ts), `KodaXBetaFlags` (flags.ts). No callers in monorepo.' +
          '</task-completed>\n' +
          '<task-completed task_id="task_002">' +
          'packages/agent: 1 unused export — `experimentalSpanProvider` ' +
          '(tracing/internal.ts). Marked @internal; safe to drop.' +
          '</task-completed>\n' +
          '<task-completed task_id="task_003">' +
          'packages/coding: 5 unused exports — full list in child output. Notable: ' +
          '`KodaXLegacyBudgetSnapshot`, `_resetCompactionBookkeeping`. Recommend ' +
          'staged removal (split between this and the next release).' +
          '</task-completed>',
      },
      {
        role: 'assistant',
        content:
          'All three audits returned. Findings consolidated.\n\n' +
          '<tool_call>todo_update({op:"set", id:"todo_1", status:"completed"})</tool_call>\n' +
          '<tool_call>todo_update({op:"set", id:"todo_2", status:"completed"})</tool_call>\n' +
          '<tool_call>todo_update({op:"set", id:"todo_3", status:"completed"})</tool_call>\n\n' +
          'Plan complete. Total: 9 unused exports across 3 packages.',
      },
    ],
    userMessage: 'Great — wrap it up.',
  };
}

function sceneBlockedAfterStopCompleted(): SceneFragment {
  return {
    priorMessages: [
      {
        role: 'user',
        content:
          'Investigate `packages/coding/src/legacy-evaluator.ts` for the source of the H1 revise-loop bug.',
      },
      {
        role: 'assistant',
        content:
          'This may take a while — dispatching as a probe child.\n\n' +
          '<tool_call>todo_update({op:"init", items:[' +
          '{id:"todo_1", content:"Diagnose H1 revise-loop in legacy-evaluator.ts", activeForm:"Diagnosing"}' +
          ']})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"legacy-eval-probe", objective:"Find the H1 revise-loop root cause in legacy-evaluator.ts", readOnly:true})</tool_call>\n\n' +
          'Dispatched: task_id=task_010. Will idle until it returns.',
      },
      {
        role: 'user',
        content:
          '<system-reminder>child task_010 has now been running for 90s with no progress signal. The user just cancelled the wider investigation.</system-reminder>',
      },
      {
        role: 'assistant',
        content:
          'User cancelled — aborting the probe.\n\n' +
          '<tool_call>task_stop({task_id:"task_010", reason:"user cancelled wider investigation"})</tool_call>\n\n' +
          'Waiting for the stopped banner.',
      },
      {
        role: 'user',
        content:
          '<task-completed task_id="task_010" error="stopped: user cancelled wider investigation">' +
          'No findings produced — task was aborted before producing a summary.' +
          '</task-completed>',
      },
      {
        role: 'assistant',
        content:
          'Probe child reached the stopped banner.\n\n' +
          '<tool_call>todo_update({op:"set", id:"todo_1", status:"failed"})</tool_call>\n\n' +
          'Plan reflects the blocked state — no diagnosis was produced.',
      },
    ],
    userMessage: 'Yeah, mark it blocked and let the Evaluator know.',
  };
}

function scenePendingWithIncompletePlan(): SceneFragment {
  return {
    priorMessages: [
      {
        role: 'user',
        content:
          'Audit `packages/llm`, `packages/agent`, and `packages/coding` for unused exports — read-only.',
      },
      {
        role: 'assistant',
        content:
          'Three independent read-only investigations — fan out as children.\n\n' +
          '<tool_call>todo_update({op:"init", items:[' +
          '{id:"todo_1", content:"Audit packages/llm", activeForm:"Auditing llm"},' +
          '{id:"todo_2", content:"Audit packages/agent", activeForm:"Auditing agent"},' +
          '{id:"todo_3", content:"Audit packages/coding", activeForm:"Auditing coding"}' +
          ']})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-llm", objective:"unused exports in packages/llm", readOnly:true})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-agent", objective:"unused exports in packages/agent", readOnly:true})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-coding", objective:"unused exports in packages/coding", readOnly:true})</tool_call>\n\n' +
          'Children dispatched: task_id=task_001 (llm), task_id=task_002 (agent), task_id=task_003 (coding). ' +
          'All three in_progress. Idling until they return.',
      },
    ],
    // No <task-completed> banners have arrived. Neutral status query —
    // does NOT contain instruction-style language like "wrap up" / "hand
    // off" that the model could legitimately follow REGARDLESS of
    // pending children. Designed so the only correct answer is a
    // text-only "still waiting" — any tool call (especially
    // emit_handoff) is unambiguous evidence the model ignored the
    // pending-children precondition. Earlier draft used "Are you done?
    // Let's wrap up." which sub-agent review (2026-05-15) flagged as
    // ambiguous: a model emitting emit_handoff in response could
    // plausibly be obeying the user instruction, making the regex-fail
    // hard to disentangle from a genuine HARD PRECONDITION violation.
    userMessage: 'Status check — what\'s in flight right now?',
  };
}

function sceneJustDispatchedNoIdleWork(): SceneFragment {
  return {
    priorMessages: [
      {
        role: 'user',
        content:
          'Probe the boundary between `packages/agent` and `packages/coding` ' +
          'for layering violations — split into 2 read-only investigations.',
      },
      {
        role: 'assistant',
        content:
          'Two independent probes — both read-only children.\n\n' +
          '<tool_call>todo_update({op:"init", items:[' +
          '{id:"todo_1", content:"Probe agent → coding imports", activeForm:"Probing"},' +
          '{id:"todo_2", content:"Probe coding → agent imports", activeForm:"Probing"}' +
          ']})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"a-to-c", objective:"Find any imports from packages/agent into packages/coding", readOnly:true})</tool_call>\n' +
          '<tool_call>dispatch_child_task({id:"c-to-a", objective:"Find any imports from packages/coding into packages/agent that bypass the public surface", readOnly:true})</tool_call>\n\n' +
          'Dispatched: task_id=task_100, task_id=task_101. Both in_progress.',
      },
    ],
    // The classic "no more useful work, children still in flight"
    // boundary. Per prompt: end text-only with one short status
    // sentence. Premature emit_handoff is the failure mode.
    userMessage:
      'OK — nothing else for you to read on my side. Continue when you can.',
  };
}

function buildSceneForCase(caseId: CaseId): SceneFragment {
  switch (caseId) {
    case 'pos_no_dispatch_history': return sceneNoDispatchHistory();
    case 'pos_all_children_returned': return sceneAllChildrenReturned();
    case 'pos_blocked_after_stop_completed': return sceneBlockedAfterStopCompleted();
    case 'neg_pending_with_incomplete_plan': return scenePendingWithIncompletePlan();
    case 'neg_just_dispatched_no_idle_work': return sceneJustDispatchedNoIdleWork();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  const scene = buildSceneForCase(caseId);
  const variantOf = (id: 'v_baseline' | 'v_proposed'): PromptVariant => ({
    id,
    description:
      id === 'v_baseline'
        ? 'Current worker-role-prompt.ts handoffRules (no HARD PRECONDITION line)'
        : 'Proposed handoffRules with HARD PRECONDITION + task_stop escape-hatch lines',
    systemPrompt: buildSystemPrompt(id === 'v_proposed' ? 'proposed' : 'baseline'),
    priorMessages: scene.priorMessages,
    userMessage: scene.userMessage,
  });
  return [variantOf('v_baseline'), variantOf('v_proposed')];
}

// ---------------------------------------------------------------------------
// Judges — multi-syntax tool-name detection per EVAL_GUIDELINES
// anti-pattern 7 §4. Same `buildToolNamePatterns` shape as
// `benchmark/datasets/feature-120-child-steering/cases.ts` —
// duplicated locally (not re-imported) so each dataset stays
// self-contained and can be reviewed in isolation.
//
// Positive cases: regex pass when emit_handoff is invoked.
// Negative cases: regex pass when emit_handoff is NOT invoked. Per
// anti-pattern 7, negative-regex judges MUST be paired with an LLM-
// judge audit on EVERY regex-fail cell — the driver dumps raw
// `text` + `toolCalls` per cell so this audit runs offline.
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'),                              // tool_name(
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),   // "name":"tool_name"  (quoted key + quoted value, JSON form)
    // Sub-agent review (2026-05-15) flagged: zhipu/glm52 sometimes
    // emits the unquoted-key + quoted-value YAML-ish hybrid form,
    // e.g. `<tool_call>name:"emit_handoff" arguments:{...}</tool_call>`.
    // The original 4-syntax set did not cover this and would log
    // false negatives on legitimate emit_handoff calls (positive case
    // regression mis-read as cross-case prompt damage). Add the
    // unquoted-key + quoted-value variant explicitly.
    new RegExp(`\\bname\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),             // name: "tool_name"   (unquoted key + quoted value)
    new RegExp(`<${esc}\\b`, 'i'),                                    // <tool_name>
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),                  // name: tool_name     (unquoted on both sides)
  ];
}

function emitHandoffMentioned(output: string): boolean {
  return buildToolNamePatterns('emit_handoff').some((p) => p.test(output));
}

function buildPositiveJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_calls_emit_handoff`,
    category: 'correctness',
    judge: (out) => {
      if (emitHandoffMentioned(out)) return { passed: true };
      return {
        passed: false,
        reason: `output does not invoke emit_handoff (checked fn-call / JSON / XML / kw syntax)`,
      };
    },
  };
}

function buildNegativeJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_does_not_call_emit_handoff`,
    category: 'correctness',
    judge: (out) => {
      if (!emitHandoffMentioned(out)) return { passed: true };
      return {
        passed: false,
        reason:
          `output invokes emit_handoff despite pending children — premature ` +
          `handoff failure mode (regex pass on emit_handoff syntax). MUST be ` +
          `LLM-judge audited per EVAL_GUIDELINES anti-pattern 7 §3 (≥1 fail ` +
          `cell per alias × case under panel-internal majority).`,
      };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) throw new Error(`unknown case id ${caseId}`);
  return spec.polarity === 'must_call_emit_handoff'
    ? [buildPositiveJudge(caseId)]
    : [buildNegativeJudge(caseId)];
}
