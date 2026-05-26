/**
 * FEATURE_199 v0.7.44 — `task_id:<id>` evidence_refs prefix prompt-signal eval.
 *
 * Scope: when a sibling child has just completed and the parent Worker is
 * about to dispatch a follow-up child whose work directly consumes the
 * sibling's findings, does the Worker discover the new
 * `evidence_refs: ["task_id:<sibling_id>"]` shape from the tool's schema
 * description alone? (No worker-role-prompt teaching block.)
 *
 * **Test surface**:
 *
 *   - Tool description bytes are byte-identical to the production
 *     `packages/coding/src/tools/registry.ts:471` registration after the
 *     FEATURE_199 schema edit (per EVAL_GUIDELINES anti-pattern 8 —
 *     "must include production `KodaXToolDefinition.description` bytes",
 *     not a brief stub). Keeping the bytes byte-aligned is what lets the
 *     pilot generalise from this synthetic surface to production.
 *
 *   - The user message embeds a `<task-completed task_id="hooks-audit">` block
 *     carrying a concrete file list the follow-up child needs. This
 *     mirrors the runtime envelope the Worker actually sees when an async
 *     dispatch resolves (see `dispatch-child-tasks.ts` — the final
 *     `enqueueChildTaskNotification` body is rendered into the next user
 *     message as a `<task-completed>` block, per FEATURE_155).
 *
 *   - The accompanying user follow-up question is intentionally minimal:
 *     "Now refactor those 5 files." The Worker must decide on its own
 *     to forward the hooks-audit's findings rather than re-narrate them.
 *
 * **Cases**:
 *
 *   C1 — `task_id` reference adoption (positive). PASS when the next
 *   `dispatch_child_task` call's `evidence_refs` array contains any
 *   string starting with `"task_id:"`. Tolerates id mis-spellings (the
 *   pilot question is "does the model pick the prefix shape at all",
 *   not "does it copy the literal id" — runtime visible-error feedback
 *   handles id typos at production time).
 *
 * **Mode** (env `KODAX_F199_MODE`):
 *
 *   - `pilot`  → ark/v4flash × C1 × 3 runs = 3 calls (~$0.03-0.05).
 *                Pre-registered trigger: ≥ 1/3 PASS = SHIP signal.
 *   - `audit`  → same panel as pilot, plus 3-judge majority audit
 *                replays each raw text dump through 3 panel-internal
 *                judges (zhipu/glm51 + ark/v4pro + kimi) per
 *                EVAL_GUIDELINES anti-pattern 7 §3.
 *   - default  → SKIP (no env, no spend).
 *
 * **Run**:
 *
 *   KODAX_F199_MODE=pilot npm run test:eval -- feature-199-task-id-evidence-ref
 *   KODAX_F199_MODE=audit npm run test:eval -- feature-199-task-id-evidence-ref
 *
 * Skips when API keys are absent. Not part of regular CI — manual.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

export type F199CaseId = 'C1_task_id_adoption';

/**
 * Production-byte dispatch_child_task description (FEATURE_199 schema).
 * MUST stay byte-aligned with `packages/coding/src/tools/registry.ts:471`
 * — when the registry description is edited the byte-equality check at
 * the top of the eval driver fails fast (per anti-pattern 8 §1).
 */
export const DISPATCH_CHILD_TASK_TOOL: KodaXToolDefinition = {
  name: 'dispatch_child_task',
  description:
    'Execute a single child agent for an independent sub-task. The child runs its own multi-turn investigation loop and returns findings. Call multiple times in parallel for concurrent sub-tasks — each call appears as a separate tool with its own status in the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique child task identifier' },
      objective: { type: 'string', description: 'Detailed multi-step goal for this child agent' },
      readOnly: { type: 'boolean', description: 'true (default): child can only read files. false: child may edit files (Generator/Worker only); use for non-conflicting file-level edits across modules.' },
      scope_summary: { type: 'string', description: 'Optional scope hint (e.g. "packages/llm/src/")' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: 'Optional known evidence. Prefixed strings: "file:path" inlines the first 200 lines of a working-tree file, "diff:path" inlines the git diff against HEAD, "finding:text" transcribes a fact you already know, "task_id:<child_id>" forwards a completed sibling child\'s output verbatim — use this after dispatching one child whose findings feed the next so the new child sees the sibling\'s full report without you re-narrating it. An unknown prefix is surfaced as an error in the next dispatch tool_result so you can correct it.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
      model_hint: {
        type: 'string',
        enum: ['fast', 'balanced', 'deep'],
        description: 'Optional hint for routing this child to a tier-appropriate model. "fast" for short focused lookups (reading a handful of files, a simple grep); "balanced" (default; same as omit) for normal subtasks; "deep" for heavy reasoning (multi-file analysis, complex audit). Routing is currently a no-op (every child runs on the parent\'s model); a future routing feature will activate the hint. Mark "fast" only for trivial focused lookups; mark "deep" only for multi-file research or analytical synthesis; when in doubt, omit.',
      },
      subagent_type: {
        type: 'string',
        description: 'When the task matches a registered specialist (e.g., db-reviewer for SQL changes, e2e-runner for browser tests), dispatch as that specialist instead of a generic child.',
      },
    },
    required: ['objective'],
  },
};

/** Stand-in tools advertised alongside dispatch_child_task so the Worker
 * has plausible alternatives (re-grep, re-read) rather than being forced
 * into the dispatch shape. Mirrors the F123 dataset pattern. Descriptions
 * are intentionally terse — they are filler, not the surface under test. */
export const READ_TOOL: KodaXToolDefinition = {
  name: 'read',
  description: 'Read a file by absolute path. Returns up to 2000 lines.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

export const GREP_TOOL: KodaXToolDefinition = {
  name: 'grep',
  description: 'Search file contents with a regex pattern.',
  input_schema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
    required: ['pattern'],
  },
};

/** `task_output` is the existing mid-flight polling tool (FEATURE_177).
 * Including it gives the model a plausible "ask hooks-audit's snapshot via
 * tool" alternative — the eval is whether the dispatch-time
 * `task_id:<id>` shape wins out for the "forward-into-next-child" use
 * case. If the model uses `task_output` first and THEN dispatches with
 * the result inlined as `finding:`, that's the re-narrate path the new
 * prefix replaces. */
export const TASK_OUTPUT_TOOL: KodaXToolDefinition = {
  name: 'task_output',
  description: 'Peek at the current state of a dispatched child task by task_id. Returns status, recent tool calls, and (if terminal) the final output text. Use to poll a child mid-flight.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      block: { type: 'boolean' },
      timeout_ms: { type: 'number' },
    },
    required: ['task_id'],
  },
};

export const F199_SYSTEM_PROMPT = `You are the parent Worker agent in a coding assistant. You coordinate by dispatching child agents that run focused sub-tasks in parallel and return findings as text-only summaries.

You have access to several tools; choose the one that fits the next concrete step.

When you decide to dispatch a follow-up child whose work builds on a sibling child that has already completed, prefer the most direct way to forward the sibling's findings into the new child's briefing — re-narrating a sibling's report by hand is lossy. Each tool's description lists the shapes it supports.

Reply with the single next tool call (no chain-of-thought commentary). If the situation does not call for a tool, reply with a one-sentence text-only acknowledgement.`;

export interface F199Case {
  readonly id: F199CaseId;
  readonly description: string;
  readonly userMessage: string;
  /** Pre-registered regex for the primary mechanical signal. Must match
   * a string in `evidence_refs` array starting with `task_id:`. */
  readonly primarySignal: RegExp;
}

const C1_USER_MESSAGE = `Earlier I asked you to find every place using the deprecated \`useLayoutEffect\` with synchronous cleanup. You dispatched a read-only sibling child task with task_id="hooks-audit" and it just completed.

Here is the completion block you would see at your next yield:

<task-completed task_id="hooks-audit">
Scope: packages/ui, packages/forms, packages/admin (.tsx files only)

Found 5 files using useLayoutEffect with a synchronous cleanup function (each could be safely replaced with useEffect to avoid blocking the render):

- packages/ui/src/Modal.tsx (line 12) — focus-trap cleanup
- packages/ui/src/Dropdown.tsx (line 34) — outside-click listener cleanup
- packages/forms/src/AutoSave.tsx (line 56) — debounce timer cleanup
- packages/forms/src/DateField.tsx (line 78) — popper teardown
- packages/admin/src/UserPanel.tsx (line 90) — websocket subscription cleanup

Each file's cleanup function returns synchronously and does not touch DOM measurements before commit, so useEffect is a safe drop-in. No other useLayoutEffect uses in scope were found.
</task-completed>

Now refactor those 5 files. Dispatch a single child to do the refactor.

Emit your next tool call.`;

export const F199_CASES: readonly F199Case[] = [
  {
    id: 'C1_task_id_adoption',
    description:
      'After a sibling hooks-audit child completes with a concrete file list, the Worker dispatches a follow-up refactor child. PASS when the new dispatch_child_task call carries an evidence_refs entry starting with "task_id:" (any id — the floor test is shape adoption, not literal-id correctness).',
    userMessage: C1_USER_MESSAGE,
    primarySignal: /"?task_id"?\s*:\s*[a-zA-Z0-9_\-]+/,
  },
];

/** Helper for the driver: pull the dispatch_child_task call out of a
 * tool_calls list and check whether ANY evidence_refs entry starts with
 * `task_id:`. Tolerates JSON-stringified strings and unparsed text
 * shape (rare on coding-plan providers but cheap to guard against). */
export function evidenceRefsContainsTaskIdPrefix(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { matched: boolean; matchedRef: string | undefined } {
  const dispatch = toolCalls.find((t) => t.name === 'dispatch_child_task');
  if (!dispatch) return { matched: false, matchedRef: undefined };
  const input = dispatch.input as { evidence_refs?: unknown };
  const refs = input?.evidence_refs;
  if (!Array.isArray(refs)) return { matched: false, matchedRef: undefined };
  for (const r of refs) {
    if (typeof r === 'string' && r.trim().toLowerCase().startsWith('task_id:')) {
      return { matched: true, matchedRef: r };
    }
  }
  return { matched: false, matchedRef: undefined };
}
