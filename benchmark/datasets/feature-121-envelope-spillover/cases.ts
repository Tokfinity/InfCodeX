/**
 * Dataset — FEATURE_121 v0.7.40 envelope-spillover dispatch-bullet eval.
 *
 * Verifies the `LARGE CHILD OUTPUT (FEATURE_121 v0.7.40)` dispatch-rules
 * bullet added to `packages/coding/src/agents/worker-role-prompt.ts`. The
 * bullet's contract: after a child returns with a preview + spillover
 * marker (`[Tool output truncated. ... Full output saved to: <path>]`),
 * the Worker must decide whether to `Read` the spillover file based on
 * what the user actually asked, NOT blindly read every spillover.
 *
 *   - Case A `preview_sufficient`   — user wants a brief yes/no answer
 *     and the preview clearly answers it → Worker MUST NOT call `Read`.
 *   - Case B `detail_required`      — user explicitly asks for the FULL
 *     list of every issue (preview cuts off mid-list) → Worker MUST call
 *     `Read` on the spillover path.
 *   - Case C `inline_no_spillover`  — envelope is inline (no marker) →
 *     Worker MUST NOT call `Read` (no path to read).
 *
 * **Layer 2 single-turn probe** per EVAL_GUIDELINES §三层实验金字塔.
 * Output contract pins detection to a mechanical surface:
 *
 *     ACTION: Read("/absolute/path")     ← positive trigger
 *     ACTION: respond_inline             ← negative trigger
 *
 * Negative case A combines BOTH `ACTION: Read(...)` absent AND
 * `ACTION: respond_inline` present — pairs structural-assertion-only
 * detection (anti-pattern 7 §1 "absolute structural assertion as
 * alternative to LLM-judge pair"). The output contract is rigid enough
 * that chain-of-thought "I should not call Read" can't be misread as
 * a Read invocation — Workers must emit one of the two `ACTION:` lines
 * literally.
 *
 * **Pre-registered decision matrix** (set BEFORE running):
 *
 *   - SHIP:    ≥3 of 4 panel aliases hit ≥80% on EACH case
 *              AND cross-alias max-min spread ≤ 15pp
 *              → ship FEATURE_121 dispatch bullet as designed
 *   - PARTIAL: 1-2 aliases ≥80%, others <80% but ≥60%
 *              → ship anyway, document weak-model behaviour in test guide
 *   - REJECT:  0 aliases ≥80% OR spread >25pp
 *              → revise prompt bullet (next iteration scope)
 *
 * Run model: 4 alias × 3 case × 5 runs = 60 calls × ~$0.03/call avg ≈ $2.
 * ROI: $2 buys a SHIP/REVISE decision for the v0.7.40 dispatch bullet —
 * within EVAL_GUIDELINES "$5 实验换一条 production prompt 改动: 值".
 *
 * Concurrency: per-alias single-call (anti-pattern 3), cross-alias serial.
 * Aliases (panel-internal, no anthropic/openai per 2026-05-12 rule):
 *   zhipu/glm51 + kimi + ds/v4flash + mmx/m27 — 4 independent families.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'preview_sufficient'
  | 'detail_required'
  | 'inline_no_spillover';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** True when the Worker MUST call `Read` on the spillover path. */
  readonly expectRead: boolean;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'preview_sufficient',
    description:
      'User dispatched an audit child and asks ONLY whether anything ' +
      'blocks release (one-sentence answer). The preview in the ' +
      '<task-completed> banner explicitly says "None are critical or ' +
      'block release." A spillover marker is present BUT the preview ' +
      'already answers the user. Worker must NOT `Read` — preview is sufficient.',
    behaviour:
      'output emits `ACTION: respond_inline` and does NOT emit `ACTION: Read(...)`',
    expectRead: false,
  },
  {
    id: 'detail_required',
    description:
      'User dispatched a deep audit child and asks for the COMPLETE list ' +
      'of every issue with file paths + line numbers (they need to file ' +
      'tickets per issue). Preview shows only the high-level summary; ' +
      'detail lives in the spillover file. Worker MUST `Read` the path.',
    behaviour:
      'output emits `ACTION: Read("/tmp/kodax/tool-results/...")` pointing at the spillover path',
    expectRead: true,
  },
  {
    id: 'inline_no_spillover',
    description:
      'Envelope is fully inline — no spillover marker present. User asks ' +
      'for everything the child found. Worker must NOT `Read` (there is ' +
      'no saved path to read). Defends against blanket-Read regression ' +
      'where Worker reads even when no spillover marker exists.',
    behaviour:
      'output emits `ACTION: respond_inline` and does NOT emit `ACTION: Read(...)`',
    expectRead: false,
  },
] as const;

// ---------------------------------------------------------------------------
// System prompt — controlled snapshot keyed to v0.7.40. Source of truth
// lives in `packages/coding/src/agents/worker-role-prompt.ts` (the
// `dispatchRules` constant); this is a verbatim subset of that constant
// embedded for reproducibility. The companion unit test
// `worker-role-prompt.test.ts` (`emits the LARGE CHILD OUTPUT dispatch-
// rules bullet`) pins the source-side text so any divergence between
// source and this snapshot will be caught the next time the unit test
// is updated to match a source change.
//
// Per EVAL_GUIDELINES Layer 2 §"controlled input": the LLM input is the
// exact bytes the model sees, not a re-derivation through `runKodaX`.
// Embedding the prompt text here makes the eval reproducible and makes
// the failure surface unambiguous (a fail = the LLM failed to follow
// this exact prompt, not "the runner stitched something wrong").
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are the Worker — KodaX\'s primary coding agent.',
  '',
  'DISPATCH RULES (`dispatch_child_task` — idle-yield model):',
  '- After `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful, then end your turn text-only when out of work. The runner resumes you when a child completes; your next user message will start with one or more <task-completed task_id="…">…</task-completed> blocks carrying the result.',
  '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40): when a child\'s report exceeds the inline envelope budget (~50KB), the `<task-completed>` banner contains a preview + a marker like `[Tool output truncated. ... Full output saved to: <ABSOLUTE_PATH>. Use the Read tool to view full output.]`. The preview is usually enough — read it first, and only call `Read` on the saved path when you need details beyond what the preview shows (e.g., specific code snippets the child cited, or items below the cutoff). Do NOT blindly Read every spillover path; that wastes context.',
  '',
  'You have tools: `Read(path)` to read a file, `dispatch_child_task` to launch children, and standard editing tools.',
  '',
  'Output rules — ALWAYS reply with EXACTLY two lines:',
  '- Line 1: either `ACTION: Read("/absolute/path/to/file")` (call Read on the saved spillover path) OR `ACTION: respond_inline` (no tool call, answer the user directly using the preview).',
  '- Line 2: one short sentence explaining your decision.',
  'Do not output anything before Line 1 or after Line 2. Do not wrap in code fences.',
].join('\n');

const SPILLOVER_PATH = '/tmp/kodax/tool-results/2026-05-13T06-00-abc123.txt';

const PREVIEW_ENOUGH_PREVIEW = [
  '# Audit Report — packages/coding/src/orchestration',
  'Found 4 issues across 3 files:',
  '- 1 race condition in dispatchChildTask cleanup (low risk)',
  '- 2 incorrect Map.delete timing (cosmetic)',
  '- 1 missing null check in normalizeWorkerResult (low risk)',
  'None are critical or block release.',
].join('\n');

const PREVIEW_INSUFFICIENT_PREVIEW = [
  '# Deep audit — KodaX packages (29 issues)',
  '## Summary',
  'Audited packages/{ai,agent,coding,repl,skills}. 29 findings total.',
  '## Findings (showing first 4 of 29)',
  '1. packages/ai/src/providers/zhipu.ts:142 — missing timeout on stream',
  '2. packages/agent/src/dispatch.ts:88 — TOCTOU on child registry lookup',
  '3. packages/coding/src/tools/grep.ts:51 — unbounded buffer growth',
  '4. packages/repl/src/keypress.ts:203 — stale closure over input ref',
  '[... 25 more findings truncated, see saved file ...]',
].join('\n');

const ENVELOPE_PREVIEW_SUFFICIENT = [
  '<task-completed task_id="audit-1">',
  PREVIEW_ENOUGH_PREVIEW,
  '',
  `[Tool output truncated. Showing 8 of 2400 lines (1.5KB of 78KB). Full output saved to: ${SPILLOVER_PATH}. Use the Read tool to view full output.]`,
  '</task-completed>',
].join('\n');

const ENVELOPE_DETAIL_REQUIRED = [
  '<task-completed task_id="audit-2">',
  PREVIEW_INSUFFICIENT_PREVIEW,
  '',
  `[Tool output truncated. Showing 10 of 1800 lines (2.0KB of 95KB). Full output saved to: ${SPILLOVER_PATH}. Use the Read tool to view full output.]`,
  '</task-completed>',
].join('\n');

const ENVELOPE_INLINE = [
  '<task-completed task_id="audit-3">',
  '# Quick scan complete. No critical issues found in packages/coding/src/agents.',
  '3 minor style nits in worker-role-prompt.ts (line lengths >120).',
  '</task-completed>',
].join('\n');

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'preview_sufficient':
      return {
        id: 'v0.7.40',
        description: 'Preview is sufficient — expect ACTION: respond_inline (no Read)',
        systemPrompt: SYSTEM_PROMPT,
        userMessage:
          `${ENVELOPE_PREVIEW_SUFFICIENT}\n\n` +
          'I dispatched an audit child. Tell me ONLY: is there anything critical that blocks release? One sentence.',
      };
    case 'detail_required':
      return {
        id: 'v0.7.40',
        description: 'User needs full detail — expect ACTION: Read(spillover path)',
        systemPrompt: SYSTEM_PROMPT,
        userMessage:
          `${ENVELOPE_DETAIL_REQUIRED}\n\n` +
          'I dispatched a deep audit child. Show me the COMPLETE list of every issue found with file paths and line numbers — I need to file tickets for each one.',
      };
    case 'inline_no_spillover':
      return {
        id: 'v0.7.40',
        description: 'No spillover marker — expect ACTION: respond_inline (no Read)',
        systemPrompt: SYSTEM_PROMPT,
        userMessage:
          `${ENVELOPE_INLINE}\n\n` +
          'I dispatched a quick scan child. Tell me everything it found.',
      };
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic regex with output-contract pinning. The rigid
// `ACTION: Read(...)` / `ACTION: respond_inline` contract makes detection
// mechanical and isolates positive/negative cases from chain-of-thought
// confusion (the source of anti-pattern 7's regex false-negatives).
//
// Negative cases use a paired judge: must contain `respond_inline` AND
// must NOT contain `Read(`. Pairing structural-positive with structural-
// negative is the EVAL_GUIDELINES §1 "absolute structural assertion"
// alternative to LLM-judge — both halves must hit for a negative-case PASS.
// ---------------------------------------------------------------------------

const READ_ACTION_RE = /ACTION:\s*Read\s*\(\s*["']?([^"')]+)["']?\s*\)/i;
const INLINE_ACTION_RE = /ACTION:\s*respond_inline/i;

/** Exported for shape-test reuse — keep aligned with judges below. */
export const READ_DETECTOR = READ_ACTION_RE;
export const INLINE_DETECTOR = INLINE_ACTION_RE;

function judgeExpectRead(): readonly PromptJudge[] {
  return [
    {
      name: 'emits_action_read',
      category: 'correctness',
      judge: (out) => {
        if (READ_ACTION_RE.test(out)) return { passed: true };
        return {
          passed: false,
          reason: 'output does not emit `ACTION: Read(...)` on detail-required case',
        };
      },
    },
    {
      name: 'read_target_is_spillover_path',
      category: 'correctness',
      judge: (out) => {
        const match = out.match(READ_ACTION_RE);
        if (!match) return { passed: false, reason: 'no ACTION: Read match' };
        const path = match[1] ?? '';
        if (path.includes('/kodax/tool-results/') || path.includes('kodax-tool-results')) {
          return { passed: true };
        }
        return {
          passed: false,
          reason: `Read target "${path}" is not the spillover path`,
        };
      },
    },
    {
      name: 'does_not_emit_respond_inline',
      category: 'correctness',
      judge: (out) => {
        if (INLINE_ACTION_RE.test(out)) {
          return {
            passed: false,
            reason: 'emits respond_inline on detail-required case',
          };
        }
        return { passed: true };
      },
    },
  ];
}

function judgeExpectNoRead(): readonly PromptJudge[] {
  return [
    {
      name: 'emits_action_respond_inline',
      category: 'correctness',
      judge: (out) => {
        if (INLINE_ACTION_RE.test(out)) return { passed: true };
        return {
          passed: false,
          reason: 'output does not emit `ACTION: respond_inline`',
        };
      },
    },
    {
      name: 'does_not_emit_action_read',
      category: 'correctness',
      judge: (out) => {
        if (READ_ACTION_RE.test(out)) {
          return {
            passed: false,
            reason: 'emits ACTION: Read(...) on preview-sufficient / no-spillover case',
          };
        }
        return { passed: true };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'preview_sufficient':
      return judgeExpectNoRead();
    case 'detail_required':
      return judgeExpectRead();
    case 'inline_no_spillover':
      return judgeExpectNoRead();
  }
}
