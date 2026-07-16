/**
 * Dataset — FEATURE_177 (v0.7.45) `task_output` Worker prompt RULE D eval.
 *
 * Verifies that the Worker prompt RULE D (gated behind
 * `KODAX_TASK_OUTPUT_PROMPT=1`) effectively teaches the Worker LLM the
 * `task_output(task_id, block?, timeout_ms?)` peek pattern WITHOUT
 * regressing the existing RULE A (read-only fan-out), RULE C (write
 * fan-out), or IDLE-YIELD wait mechanic. Per
 * `feedback_prompt_strengthening_cross_case_regression`, a prompt
 * addition that adds a new wait/peek mechanic must be panel-validated
 * for cross-case regression before the env-flag default flips.
 *
 * ## Five cases (2 POSITIVE + 1 BLOCK-MISUSE NEGATIVE + 2 CROSS-REGRESSION)
 *
 *   1. **C1 peek_running_child_user_asked** — Worker dispatched 3 children
 *      ~90 s ago; one child (`task_C`) has not produced `<task-completed>`
 *      yet; user asks "could you check what task_C is doing right now?".
 *      Expected: `task_output({task_id:"task_C", block:false})` (or
 *      omitted block).
 *
 *   2. **C2 peek_long_running_user_wonders** — Worker dispatched a deep
 *      research child ~120 s ago; user message: "is everything still
 *      running?". Worker has no other useful work pending. Expected:
 *      `task_output({task_id:"…", block:false})`.
 *
 *   3. **C3 idle_yield_not_block_true** — Worker just dispatched 2
 *      children for a fan-out; no other useful work; user message
 *      implicit ("continue"). Expected: text-only idle-yield (NO tool
 *      calls). MUST NOT call `task_output(block:true)` as a wait
 *      substitute.
 *
 *   4. **C4 read_only_fanout_not_polling** — User asks for an audit
 *      spanning 4 independent packages ("audit auth handlers in
 *      packages/auth, packages/api, packages/web, packages/cli").
 *      Expected: 4 `dispatch_child_task({readOnly:true})` calls (or a
 *      batch close enough — RULE A). MUST NOT substitute with
 *      `task_output` polling against pre-existing tasks (no tasks
 *      exist yet — this case has empty in-flight state).
 *
 *   5. **C5 write_fanout_not_polling** — User asks for 3 independent
 *      file edits ("add `experimental_v2` flag to packages/auth/config,
 *      packages/api/config, and packages/cli/config — same change in
 *      each"). Expected: 3 `dispatch_child_task({readOnly:false})`
 *      calls (RULE C). MUST NOT substitute with `task_output`.
 *
 * ## Variants
 *
 * `v_baseline` (RULE D OFF — pre-FEATURE_177 prompt) vs `v_proposed`
 * (RULE D ON — FEATURE_177 prompt teaches task_output). Tool surface
 * is identical across both variants (both have `task_output` in the
 * advertised tool list); only the prompt section differs. This
 * isolates prompt impact from tool wiring.
 *
 * ## Pre-registered SHIP gate
 *
 *   SHIP iff:
 *     (a) C1+C2 (positive) each ≥60% PASS on v_proposed, ≥4-of-5 alias
 *         (accommodates `feedback_model_structural_floor_not_prompt_tunable`
 *          — kimi may floor on text-only-intent for some cases)
 *     (b) C3 (block:true misuse) ≥80% PASS on v_proposed, ≥4-of-5 alias
 *     (c) C4+C5 (cross-case regression) — pass rate on v_proposed NOT
 *         degraded by >10pp vs v_baseline on any alias
 *     (d) LLM-judge majority-vote disagreement ≤10%
 *
 *   PARTIAL: (a) met but (c) shows 10-20pp regression on one alias →
 *            keep prompt OFF by default; ship runtime only (already done
 *            in Slice A); re-design RULE D wording in commit 3/n
 *   REVERT:  (b) or (c) violation (>20pp regression OR <50% PASS on C3)
 *            → drop RULE D entirely; runtime tool stays callable for
 *            programmatic SDK consumers, prompt teaching is deferred
 *            indefinitely
 *
 * Per `feedback_eval_pilot_before_scale`: pilot 1×1×1 (`ark/v4flash` ×
 * C1 × 1 run) before scale-out. Pilot confirms trigger fires before
 * burning $5-8 on full panel.
 *
 * ## Cost
 *
 *   Pilot:    1 alias × 1 case × 2 variant × 1 run  =  2 calls   (~$0.05)
 *   Phase 1:  5 alias × 5 case × 2 variant × 5 runs = 250 calls  (~$10)
 *
 * ## Tool-name regex panel (per EVAL_GUIDELINES.md §反模式 7)
 *
 * Uses the 9-pattern audit-corrected set from feature-170 to detect
 * `task_output` / `dispatch_child_task` invocations across kimi `tool:N>`,
 * mmx `[TOOL_CALL]{tool=>}`, ark `<tool_call>tool<arg_key>`, zhipu
 * `<tool_name>tool</tool_name>`, etc. C3 (negative) additionally uses
 * a "no tool_use AND no JSON schema invocation" guard — if the assistant
 * text contains ANY tool name reference at first non-text position, it
 * fails.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { JudgeContext, JudgeResult, PromptJudge } from '../../harness/judges.js';
import type { KodaXMessage } from '@kodax-ai/llm';

export type CaseId =
  | 'peek_running_child_user_asked'
  | 'peek_long_running_user_wonders'
  | 'idle_yield_not_block_true'
  | 'read_only_fanout_not_polling'
  | 'write_fanout_not_polling';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  readonly polarity:
    | 'must_call_task_output'
    | 'must_idle_yield_text_only'
    | 'must_dispatch_readonly_fanout'
    | 'must_dispatch_write_fanout';
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'peek_running_child_user_asked',
    description:
      'Worker dispatched 3 children ~90 s ago for a multi-package security audit. Two children have ' +
      'returned `<task-completed>`; the third (`task_C`) has not. User asks: "could you check what ' +
      'task_C is doing right now? it\'s been a while". Worker must call `task_output({task_id:"task_C", ' +
      'block:false})` (or block omitted = false) and report what it shows. MUST NOT use ' +
      '`task_output(block:true)` (user wants a status check, not a wait), MUST NOT call `task_stop` ' +
      '(no signal of trouble yet, just a check-in), MUST NOT redispatch.',
    behaviour:
      'first tool_use invokes `task_output` with `task_id:"task_C"` and `block` omitted or set to `false`',
    polarity: 'must_call_task_output',
  },
  {
    id: 'peek_long_running_user_wonders',
    description:
      'Worker dispatched ONE deep-research child ~120 s ago to map a flow across 8 modules. No other ' +
      'children in flight; no other useful work pending. User asks: "is everything still running?". ' +
      'Worker must peek via `task_output({task_id:"…", block:false})` to give the user a real status ' +
      '(iterations / recent tool calls), NOT just claim "yes still running" without checking, NOT ' +
      'idle-yield (user asked an explicit question), NOT use `block:true`.',
    behaviour:
      'first tool_use invokes `task_output` with `block` omitted or set to `false`',
    polarity: 'must_call_task_output',
  },
  {
    id: 'idle_yield_not_block_true',
    description:
      'Worker just dispatched 2 children for a parallel investigation (read-only fan-out across two ' +
      'packages). No prior `<task-completed>` yet, no follow-up user message, no other useful work. ' +
      'The runner expects the canonical IDLE-YIELD wait: end turn with a short status sentence + NO ' +
      'tool calls; runner will resume on `<task-completed>`. MUST NOT call `task_output(block:true)` ' +
      'as a wait substitute (defeats idle-yield: the model burns its turn blocking instead of ' +
      'releasing for user chat).',
    behaviour:
      'no tool_use invocations in the response; assistant emits a short status sentence (text-only end)',
    polarity: 'must_idle_yield_text_only',
  },
  {
    id: 'read_only_fanout_not_polling',
    description:
      'Fresh task — empty in-flight state, no prior children. User asks: "audit the auth handler ' +
      'patterns across packages/auth, packages/api, packages/web, and packages/cli — show me ' +
      'inconsistencies". Worker must dispatch 4 read-only children (RULE A — independent ' +
      'investigations across package boundaries). MUST NOT substitute with `task_output` polling ' +
      '(there is nothing to poll yet — no children dispatched), MUST NOT do all 4 audits serially ' +
      'in the parent.',
    behaviour:
      'first tool_use invokes `dispatch_child_task` with `readOnly:true` (one of ≥3 dispatches expected)',
    polarity: 'must_dispatch_readonly_fanout',
  },
  {
    id: 'write_fanout_not_polling',
    description:
      'Fresh task — empty in-flight state. User asks: "add an `experimental_v2` feature flag to the ' +
      'config in three packages — packages/auth/config.ts, packages/api/config.ts, and ' +
      'packages/cli/config.ts. Same flag shape, same default false". Worker must dispatch 3 write ' +
      'children (RULE C — non-conflicting file-level edits across ≥3 modules). MUST NOT substitute ' +
      'with `task_output`, MUST NOT do the edits serially in the parent.',
    behaviour:
      'first tool_use invokes `dispatch_child_task` with `readOnly:false` (one of ≥3 dispatches expected)',
    polarity: 'must_dispatch_write_fanout',
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — RULE D OFF (baseline, pre-FEATURE_177) vs RULE D ON (proposed,
// FEATURE_177 v0.7.45 prompt teaches task_output peek).
//
// Tool surface is IDENTICAL across both variants — both have task_output
// in TOOL_DOCS so the model can theoretically invoke it without prompt
// teaching. ONLY the prompt section differs. This isolates prompt impact
// from tool wiring.
// ---------------------------------------------------------------------------

const TOOL_DOCS = [
  '## Available Tools',
  '',
  '`dispatch_child_task`:',
  '  Input:  { id:string, objective:string, readOnly?:boolean, model_hint?:"fast"|"balanced"|"deep" }',
  '  Output: returns a `task_id:<id>` banner immediately; the child runs asynchronously and its',
  '          result arrives as a `<task-completed task_id="…">…</task-completed>` block in your',
  '          next user message.',
  '',
  '`task_output` (FEATURE_177 v0.7.45):',
  '  Input:  { task_id:string, block?:boolean (default false), timeout_ms?:number (default 30000, max 120000) }',
  '  Output: structured envelope (<retrieval_status>, <status>, <iterations>, <recent_tool_calls>,',
  '          <output>/<error>). When block=true and the child is still in flight, waits up to',
  '          timeout_ms before returning. Default block=false returns the current snapshot',
  '          immediately.',
  '',
  '`task_stop`:',
  '  Input:  { task_id:string, reason?:string }',
  '  Output: requests graceful exit of a specific in-flight child task launched via',
  '          dispatch_child_task. Use when a child went off-scope or is stuck with no progress.',
  '',
  '`send_message`:',
  '  Input:  { to:string, content:string }',
  '  Output: enqueue a coordinator instruction for an in-flight child.',
  '',
  '`read` / `grep` / `bash`: standard read-only / mutation tools.',
].join('\n');

const DISPATCH_RULES_BASELINE = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result.',
].join('\n');

const DISPATCH_RULES_PROPOSED = [
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
  '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
  '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
  '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
  '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result.',
  '- RULE D — peek at in-flight children (FEATURE_177): you may call `task_output({task_id:"…", block:false})` to read a snapshot of a child\'s recent tool-call breadcrumbs + iteration count. Use sparingly — children\'s final results arrive automatically as `<task-completed>` blocks; only peek when deciding whether to dispatch a sibling, call `task_stop`, or report back to the user mid-flight ("the auth-audit child has run 12 iterations and is still in `grep`"). IDLE-YIELD is the canonical wait — do NOT use `task_output(block:true)` as a wait substitute, and do NOT replace a planned fan-out (`dispatch_child_task`) with `task_output` polling.',
].join('\n');

export type PromptVariantKind = 'baseline' | 'proposed';

function buildSystemPrompt(variant: PromptVariantKind): string {
  const dispatchRules =
    variant === 'baseline' ? DISPATCH_RULES_BASELINE : DISPATCH_RULES_PROPOSED;
  return [
    "You are the Worker — KodaX's primary agent for this task.",
    '',
    '## Environment',
    'Working Directory: /repo',
    'Platform: Linux (5.15)',
    '',
    dispatchRules,
    '',
    TOOL_DOCS,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Canned prior-state Worker transcripts.
// ---------------------------------------------------------------------------

const THREE_CHILDREN_DISPATCHED_TWO_RETURNED: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user' as const,
    content:
      "Audit the auth handler patterns across packages/auth, packages/api, and packages/web — " +
      'show me any inconsistencies.',
  },
  {
    role: 'assistant' as const,
    content:
      "I'll fan out to three read-only children in parallel.\n\n" +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_A","objective":"Audit auth handlers in packages/auth — list handler signatures, decorators, error-handling patterns","readOnly":true}}\n</tool_call>\n\n' +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_B","objective":"Audit auth handlers in packages/api — list handler signatures, decorators, error-handling patterns","readOnly":true}}\n</tool_call>\n\n' +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_C","objective":"Audit auth handlers in packages/web — list handler signatures, decorators, error-handling patterns","readOnly":true}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>task_id:task_A\nChild task "task_A" is running in the background.</tool_result>\n' +
      '<tool_result>task_id:task_B\nChild task "task_B" is running in the background.</tool_result>\n' +
      '<tool_result>task_id:task_C\nChild task "task_C" is running in the background.</tool_result>\n' +
      '<task-completed task_id="task_A">\n' +
      'packages/auth: 4 handlers — handleLogin / handleLogout / handleRefresh / handleResetPassword. ' +
      'Decorator pattern: @authRequired on all except handleLogin. Error wrap: try/catch → next(err).\n' +
      '</task-completed>\n' +
      '<task-completed task_id="task_B">\n' +
      'packages/api: 3 handlers — apiHandleAuth / apiHandleSession / apiHandleToken. ' +
      'Decorator pattern: @authRequired + @rateLimit. Error wrap: try/catch → res.status(500).json(...).\n' +
      '</task-completed>',
  },
];

const ONE_DEEP_RESEARCH_CHILD_120S: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user' as const,
    content:
      "Map the request lifecycle from REST handler through middleware → controller → service → " +
      'repository for the auth module — I want a flow diagram with every transformation.',
  },
  {
    role: 'assistant' as const,
    content:
      "This is a deep multi-module trace — dispatching as a single long-running child to keep my context " +
      'free for follow-up questions.\n\n' +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_flow","objective":"Map the auth-module request lifecycle: REST handler → middleware → controller → service → repository. Use process_context to map the flow before reading runner files. Report transformations at each layer.","readOnly":true,"model_hint":"deep"}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>task_id:task_flow\nChild task "task_flow" is running in the background. ' +
      'Do whatever interleaved work is useful; the runner will resume you when this child finishes.</tool_result>',
  },
];

const TWO_CHILDREN_JUST_DISPATCHED: ReadonlyArray<KodaXMessage> = [
  {
    role: 'user' as const,
    content:
      "Probe how the throttle reminder is generated in packages/coding vs how it's rendered in " +
      'packages/repl — I want a quick comparison.',
  },
  {
    role: 'assistant' as const,
    content:
      "I'll dispatch two read-only children to investigate in parallel.\n\n" +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_coding","objective":"Find where the throttle reminder is generated in packages/coding — file path + function name + the message template","readOnly":true}}\n</tool_call>\n\n' +
      '<tool_call>\n{"name":"dispatch_child_task","arguments":{"id":"task_repl","objective":"Find where the throttle reminder is rendered in packages/repl — file path + component name + how it consumes the message from packages/coding","readOnly":true}}\n</tool_call>',
  },
  {
    role: 'user' as const,
    content:
      '<tool_result>task_id:task_coding\nChild task "task_coding" is running in the background.</tool_result>\n' +
      '<tool_result>task_id:task_repl\nChild task "task_repl" is running in the background.</tool_result>',
  },
];

function buildVariantForCase(
  caseId: CaseId,
  variant: PromptVariantKind,
): PromptVariant {
  const systemPrompt = buildSystemPrompt(variant);
  switch (caseId) {
    case 'peek_running_child_user_asked':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'baseline prompt — no RULE D; model unaware of task_output peek pattern'
            : 'proposed prompt — RULE D teaches task_output(block:false) as the peek primitive',
        systemPrompt,
        priorMessages: THREE_CHILDREN_DISPATCHED_TWO_RETURNED,
        userMessage:
          "Could you check what task_C is doing right now? it's been a while.",
      };
    case 'peek_long_running_user_wonders':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'baseline prompt — no RULE D; model likely guesses or idle-yields when asked about status'
            : 'proposed prompt — RULE D teaches task_output for explicit status check',
        systemPrompt,
        priorMessages: ONE_DEEP_RESEARCH_CHILD_120S,
        userMessage:
          "Is everything still running? It's been about two minutes.",
      };
    case 'idle_yield_not_block_true':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'baseline prompt — idle-yield is the only wait mechanic, model has no block:true to mis-use'
            : 'proposed prompt — RULE D includes "do NOT use block:true as wait substitute" guard',
        systemPrompt,
        priorMessages: TWO_CHILDREN_JUST_DISPATCHED,
        // No follow-up user message — the runner expects idle-yield here.
        // We use a minimal "continue" prompt to give the model a turn slot
        // without injecting new requirements.
        userMessage:
          'Continue with whatever useful work you have left; otherwise end your turn and wait for the children.',
      };
    case 'read_only_fanout_not_polling':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'baseline prompt — RULE A teaches read-only fan-out; no RULE D to confuse with'
            : 'proposed prompt — RULE D present, but cross-case must not substitute for RULE A',
        systemPrompt,
        priorMessages: [],
        userMessage:
          "Audit the auth handler patterns across packages/auth, packages/api, packages/web, and " +
          'packages/cli — show me any inconsistencies in handler signatures, decorators, or error wrapping.',
      };
    case 'write_fanout_not_polling':
      return {
        id: variantIdOf(variant),
        description:
          variant === 'baseline'
            ? 'baseline prompt — RULE C teaches write fan-out; no RULE D to confuse with'
            : 'proposed prompt — RULE D present, but cross-case must not substitute for RULE C',
        systemPrompt,
        priorMessages: [],
        userMessage:
          "Add an `experimental_v2` feature flag to the config in three packages: " +
          "packages/auth/config.ts, packages/api/config.ts, and packages/cli/config.ts. " +
          'Same flag shape, default false, exported under `config.featureFlags.experimental_v2`.',
      };
  }
}

function variantIdOf(v: PromptVariantKind): string {
  return v === 'baseline' ? 'v_baseline' : 'v_proposed';
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [
    buildVariantForCase(caseId, 'baseline'),
    buildVariantForCase(caseId, 'proposed'),
  ];
}

// ---------------------------------------------------------------------------
// Judges — 9-pattern tool-name detection (audit-corrected set from
// FEATURE_125 2026-05-16 + FEATURE_170 lessons). Per-case polarity-
// specific assertion.
// ---------------------------------------------------------------------------

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

function invokesBlockTrue(text: string): boolean {
  // Match `block:true`, `"block":true`, `block: true`, `block = true` — all
  // shapes the wrappers might emit. The negative case judges this to
  // distinguish the misuse pattern from a correct `task_output(block:false)`
  // or `task_output` with `block` omitted.
  return /["'`]?block["'`]?\s*[:=]\s*true\b/i.test(text);
}

function invokesReadOnlyTrue(text: string): boolean {
  return /["'`]?read[_ ]?only["'`]?\s*[:=]\s*true\b/i.test(text)
    || /\breadOnly\s*[:=]\s*true\b/i.test(text);
}

function invokesReadOnlyFalse(text: string): boolean {
  return /["'`]?read[_ ]?only["'`]?\s*[:=]\s*false\b/i.test(text)
    || /\breadOnly\s*[:=]\s*false\b/i.test(text);
}

type BindingCall = { readonly name: string; readonly input: unknown };

function bindingCalls(context?: JudgeContext): readonly BindingCall[] {
  return context?.toolCalls ?? [];
}

function judgePeekRunningChild(out: string, context?: JudgeContext): JudgeResult {
  // Prefer harness-captured tool calls when present (binding ground
  // truth per `feedback_audit_must_see_binding`). Fall back to regex
  // when binding is empty.
  const toolCalls = bindingCalls(context);
  const bindingHasTaskOutput = toolCalls.some((t) => t.name === 'task_output');
  if (bindingHasTaskOutput) {
    const call = toolCalls.find((t) => t.name === 'task_output');
    const input = call?.input as Record<string, unknown> | undefined;
    if (input?.block === true) {
      return { passed: false, reason: 'task_output invoked but with block:true — not appropriate for a status check' };
    }
    return { passed: true };
  }
  if (!invokesTool(out, 'task_output')) {
    return { passed: false, reason: '`task_output` not invoked (no binding, no regex match)' };
  }
  if (invokesBlockTrue(out)) {
    return { passed: false, reason: '`task_output` invoked with block:true — wrong shape for status check' };
  }
  return { passed: true };
}

function judgePeekLongRunning(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = bindingCalls(context);
  const bindingHasTaskOutput = toolCalls.some((t) => t.name === 'task_output');
  if (bindingHasTaskOutput) {
    const call = toolCalls.find((t) => t.name === 'task_output');
    const input = call?.input as Record<string, unknown> | undefined;
    if (input?.block === true) {
      return { passed: false, reason: 'task_output invoked but with block:true — user wants a status snapshot, not a wait' };
    }
    return { passed: true };
  }
  if (!invokesTool(out, 'task_output')) {
    return { passed: false, reason: '`task_output` not invoked (no binding, no regex match)' };
  }
  if (invokesBlockTrue(out)) {
    return { passed: false, reason: '`task_output` invoked with block:true — wrong shape for status check' };
  }
  return { passed: true };
}

function judgeIdleYield(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = bindingCalls(context);
  // Strict: NO tool calls at all. Idle-yield is the canonical wait —
  // anything else (task_output(block:true), redundant dispatches, etc.)
  // fails. This is the cross-case anti-pattern we explicitly probe.
  if (toolCalls.length > 0) {
    const names = toolCalls.map((t) => t.name).join(',');
    return {
      passed: false,
      reason: `expected idle-yield (no tool calls); model invoked: ${names}`,
    };
  }
  // Regex fallback for providers that don't expose binding cleanly.
  // Check for any of: task_output / dispatch_child_task / task_stop /
  // send_message — those are the in-flight steering tools the misuse
  // pattern would reach for.
  const steeringTools = ['task_output', 'dispatch_child_task', 'task_stop', 'send_message'];
  for (const tn of steeringTools) {
    if (invokesTool(out, tn)) {
      return {
        passed: false,
        reason: `expected idle-yield (no tool invocations); regex matched ${tn}`,
      };
    }
  }
  // Also specifically guard block:true even if no clear tool-name hit
  // (some models emit `block: true` in a half-formed call).
  if (invokesBlockTrue(out)) {
    return {
      passed: false,
      reason: 'expected idle-yield; text contains `block:true` (likely a misformed task_output call)',
    };
  }
  return { passed: true };
}

function judgeReadOnlyFanout(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = bindingCalls(context);
  // Binding ground truth: count dispatch_child_task calls with readOnly:true.
  const dispatches = toolCalls.filter((t) => t.name === 'dispatch_child_task');
  if (dispatches.length > 0) {
    // Cross-case anti-pattern guard: NO task_output call (nothing in flight
    // yet, so any task_output call is a misuse).
    if (toolCalls.some((t) => t.name === 'task_output')) {
      return { passed: false, reason: 'task_output invoked alongside dispatch — no in-flight task to peek at' };
    }
    // Binding-path parity with regex-fallback: reject explicit readOnly:false
    // on a pure-audit task (omission is accepted, mirroring the regex branch
    // which accepts when invokesReadOnlyFalse returns false).
    const hasExplicitReadOnlyFalse = dispatches.some((d) => {
      const input = d.input as Record<string, unknown> | undefined;
      return input?.readOnly === false;
    });
    if (hasExplicitReadOnlyFalse) {
      return { passed: false, reason: 'dispatched with readOnly:false on a pure audit task — RULE A expects readOnly:true' };
    }
    return { passed: true };
  }
  // Regex fallback.
  if (!invokesTool(out, 'dispatch_child_task')) {
    return { passed: false, reason: '`dispatch_child_task` not invoked (binding empty + no regex match)' };
  }
  if (invokesTool(out, 'task_output')) {
    return { passed: false, reason: '`task_output` invoked — no in-flight task to peek at; substituting for fan-out' };
  }
  // RULE A is read-only fan-out — at least one readOnly:true marker.
  // Accept either explicit true OR omission (some models default to true
  // when the objective is investigation-only).
  if (invokesReadOnlyFalse(out)) {
    return { passed: false, reason: 'dispatched with readOnly:false on a pure audit task — RULE A expects readOnly:true' };
  }
  return { passed: true };
}

function judgeWriteFanout(out: string, context?: JudgeContext): JudgeResult {
  const toolCalls = bindingCalls(context);
  const dispatches = toolCalls.filter((t) => t.name === 'dispatch_child_task');
  if (dispatches.length > 0) {
    if (toolCalls.some((t) => t.name === 'task_output')) {
      return { passed: false, reason: 'task_output invoked alongside dispatch — no in-flight task to peek at' };
    }
    // For RULE C, at least one dispatch should be readOnly:false. Accept
    // missing readOnly only if the dispatch input contains an edit-tool
    // reference; this is lenient because some models omit readOnly and
    // pick it up from objective phrasing.
    const writeDispatches = dispatches.filter((d) => {
      const input = d.input as Record<string, unknown> | undefined;
      return input?.readOnly === false;
    });
    if (writeDispatches.length === 0) {
      // No explicit readOnly:false — accept only if at least one objective
      // mentions writing (the model picked up RULE C without flagging).
      const wroteSomething = dispatches.some((d) => {
        const input = d.input as Record<string, unknown> | undefined;
        const obj = typeof input?.objective === 'string' ? input.objective : '';
        return /\b(add|edit|write|insert|create|update|patch|append)\b/i.test(obj);
      });
      if (!wroteSomething) {
        return { passed: false, reason: 'dispatched but readOnly:false absent AND no write verb in objective — RULE C unclear' };
      }
    }
    return { passed: true };
  }
  // Regex fallback.
  if (!invokesTool(out, 'dispatch_child_task')) {
    return { passed: false, reason: '`dispatch_child_task` not invoked (binding empty + no regex match)' };
  }
  if (invokesTool(out, 'task_output')) {
    return { passed: false, reason: '`task_output` invoked — no in-flight task to peek at; substituting for fan-out' };
  }
  if (!invokesReadOnlyFalse(out)) {
    return { passed: false, reason: '`dispatch_child_task` invoked but no `readOnly:false` — RULE C expects write fan-out' };
  }
  return { passed: true };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) {
    throw new Error(`Unknown FEATURE_177 case id: ${caseId}`);
  }
  switch (caseId) {
    case 'peek_running_child_user_asked':
      return [{ name: 'invokes_task_output_block_false', category: 'correctness', judge: judgePeekRunningChild }];
    case 'peek_long_running_user_wonders':
      return [{ name: 'invokes_task_output_block_false', category: 'correctness', judge: judgePeekLongRunning }];
    case 'idle_yield_not_block_true':
      return [{ name: 'idle_yield_no_tool_calls', category: 'correctness', judge: judgeIdleYield }];
    case 'read_only_fanout_not_polling':
      return [{ name: 'rule_a_read_only_fanout', category: 'correctness', judge: judgeReadOnlyFanout }];
    case 'write_fanout_not_polling':
      return [{ name: 'rule_c_write_fanout', category: 'correctness', judge: judgeWriteFanout }];
  }
}
