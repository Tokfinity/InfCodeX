/**
 * FEATURE_155 idle-yield adoption — Layer 2 dataset (v0.7.39).
 *
 * ## Methodology
 *
 * Layer 2 single-turn probe per [`benchmark/EVAL_GUIDELINES.md`](../../EVAL_GUIDELINES.md):
 *
 *   - **Pre-canned input**: system prompt + canned history that ENDS at
 *     the exact decision boundary the FEATURE_155 prompt is supposed
 *     to teach: Worker has just dispatched a child (or finished
 *     dispatching all children for the request) AND has no remaining
 *     useful interleaved work. The harness owns every byte of input;
 *     the LLM never gets to free-run.
 *   - **Single LLM call per probe**: one `provider.stream` invocation,
 *     no multi-turn loop, no aggregation across turns. Avoids
 *     anti-pattern 2 (let-LLM-run-free).
 *   - **Mechanical assertion**: the response's tool-call count and
 *     text presence. NO regex-on-text, NO human "looks good" judging.
 *     Avoids anti-pattern 7 (regex false-negatives).
 *
 * ## Hypothesis under test
 *
 *   When the Worker prompt teaches IDLE-YIELD (FEATURE_155 wording —
 *   `KODAX_IDLE_YIELD=true` path), and the Worker reaches a state
 *   where there is nothing useful left to do besides waiting on a
 *   dispatched child, the Worker's NEXT response should be:
 *
 *     idle-yielded := response.toolBlocks.length === 0
 *                     && response.textBlocks.length > 0
 *                     && combinedText.trim().length > 0
 *
 *   That is: a brief text status with NO tool calls, which is exactly
 *   the runtime exit condition the runner's idle-yield outer loop
 *   detects (see `_internal/managed-task/idle-yield.ts:detectIdleYield`).
 *
 *   Failure modes the metric catches:
 *     - calling `await_child_task`        → not idle-yielded (legacy reflex)
 *     - calling `bash` to poll status     → not idle-yielded (made-up tool path)
 *     - calling `read` / `grep` again     → not idle-yielded (busy-spin)
 *     - returning empty (no text, no tool) → not idle-yielded (malformed exit)
 *
 * ## Pre-registered SHIP / PARTIAL / REJECT matrix
 *
 *   - **SHIP** — flip `KODAX_IDLE_YIELD` default to `true`:
 *       ≥ 3 of 4 aliases idle-yield on ≥ 12 of 15 cells (≥80%).
 *
 *   - **PARTIAL** — keep flag opt-in, refine prompt, re-run:
 *       2 of 4 aliases ≥ 80%, OR all 4 ≥ 60% with no alias < 50%.
 *
 *   - **REJECT** — revert prompt + banner edits (commits 3828265f),
 *     keep flag opt-in but document idle-yield as a known-unstable
 *     LLM behavior:
 *       ≥ 3 of 4 aliases < 50%, OR any single alias < 30%.
 *
 *   The thresholds are calibrated against FEATURE_148's degenerate-
 *   rate baseline (which measured the OPPOSITE behavior — the rate
 *   models DID call `await_child_task` immediately). FEATURE_148
 *   final post-anti-pattern numbers ranged 30-70% across aliases on
 *   "do X AND Y" cases. Setting the SHIP gate at ≥80% requires the
 *   new wording to genuinely PRODUCE idle-yield, not just suppress
 *   immediate-await — a stricter bar.
 *
 * ## Sample size
 *
 *   N=5 reps per (alias × case). 5 alias × 3 case × 5 reps = 75 probes
 *   ≈ $1.50 (~$0.02/probe averaged across the alias mix). Strict
 *   serial within alias to avoid 429.
 *
 *   N=5 (vs FEATURE_148's N=3) because the "no tool call at all"
 *   decision has higher variance than "did the LLM pick the await
 *   tool" — text-only completions are sensitive to provider sampling
 *   temperature, top_p, and minor system-prompt drift. n=5 keeps the
 *   95% CI on the per-alias rate within ±18pp at p=0.5, which is
 *   tight enough to land the SHIP/PARTIAL/REJECT matrix.
 *
 * ## Raw output preservation
 *
 *   Each probe's full `KodaXStreamResult` (textBlocks + toolBlocks +
 *   stopReason + usage) is dumped to the OS tmpdir under
 *   `feature-155-idle-yield-<timestamp>/<alias>/<case>-<rep>.json`.
 *   The eval test logs the dump path so a follow-up audit (LLM-judge
 *   pass, manual review) can replay any cell without re-running the
 *   whole eval.
 */

import type {
  KodaXMessage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

export type IdleYieldCaseId =
  | 'single-dispatch-no-side-task'
  | 'side-task-already-done'
  | 'fan-out-all-dispatched';

export interface IdleYieldCase {
  readonly id: IdleYieldCaseId;
  readonly description: string;
  /**
   * The full canned message history sent to the provider. The LAST
   * message is the user-side tool_result that closes the loop and
   * leaves the Worker at a decision point where idle-yield is the
   * intended response.
   */
  readonly cannedHistory: readonly KodaXMessage[];
}

const TASK_ID = 'child-1';
const TASK_ID_2 = 'child-2';
const TASK_ID_3 = 'child-3';

/**
 * Banner the dispatch tool returns to the LLM under
 * `KODAX_IDLE_YIELD=true` (mirrors `dispatch-child-tasks.ts`'s
 * idle-yield branch). The eval probes the SAME wording the LLM
 * sees in production with the flag on, so an adoption regression
 * caught here is also a real-world adoption regression.
 */
const idleYieldLaunchedBanner = (taskId: string): string =>
  `task_id:${taskId}\n` +
  `Child task "${taskId}" is running in the background. ` +
  `Do whatever interleaved work is useful (more dispatches, side-reads, drafting). ` +
  `When you have nothing else useful to do, end your turn with one short status sentence and NO tool calls — ` +
  `the runner will resume you when this child finishes (you will see a <task-completed task_id="${taskId}">…</task-completed> block in your next user message). ` +
  `Do NOT call await_child_task to wait for this id.`;

/**
 * Three cases, each ending at the moment idle-yield is the intended
 * next move. The Worker has been positioned by the canned history
 * such that there is genuinely nothing else useful to do — calling
 * any tool at this point is a regression.
 */
export const IDLE_YIELD_CASES: readonly IdleYieldCase[] = Object.freeze([
  // ----- Case 1 ----------------------------------------------------
  // Single dispatch (RULE B), no side-task. The user asked ONLY for
  // a long-running thing; Worker has dispatched it; there is no
  // independent work to interleave. The IDLE-YIELD section says:
  // end the turn text-only.
  {
    id: 'single-dispatch-no-side-task',
    description:
      'User asked for ONE long-running task; Worker dispatched it; nothing else to do. Idle-yield is the intended next move.',
    cannedHistory: [
      {
        role: 'user',
        content:
          'Run the full `npm test` suite for `packages/coding`. It takes about 90 seconds. ' +
          'Report whether it passed and, if not, what failed.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Dispatching the test suite as a background child task.',
          },
          {
            type: 'tool_use',
            id: 'tool_dispatch_1',
            name: 'dispatch_child_task',
            input: {
              objective:
                'Run `npm test` for `packages/coding` and report whether it passed plus any failure details.',
              read_only: false,
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_dispatch_1',
            content: idleYieldLaunchedBanner(TASK_ID),
          },
        ],
      },
    ],
  },
  // ----- Case 2 ----------------------------------------------------
  // The side-task is ALREADY DONE. User asked X (slow) AND Y (cheap).
  // Worker dispatched X, then read Y (a file). Now both threads are
  // accounted for; the only remaining work is to wait on X. The
  // IDLE-YIELD section says: end the turn text-only.
  {
    id: 'side-task-already-done',
    description:
      'User asked X (slow dispatch) AND Y (cheap read). Worker dispatched X, completed Y, now nothing remains but waiting on X.',
    cannedHistory: [
      {
        role: 'user',
        content:
          'Run the full `npm run build` at the repo root (~60s) AND, in parallel, read `CHANGELOG.md` ' +
          'from the repo root and tell me what version is mentioned in the most recent entry. ' +
          'When the build finishes, report whether it succeeded and the latest changelog version.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Dispatching the build, then reading the changelog while it runs.',
          },
          {
            type: 'tool_use',
            id: 'tool_dispatch_1',
            name: 'dispatch_child_task',
            input: {
              objective:
                'Run `npm run build` at the repo root. Report whether the build succeeded and any errors.',
              read_only: false,
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_dispatch_1',
            content: idleYieldLaunchedBanner(TASK_ID),
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Now reading the changelog.',
          },
          {
            type: 'tool_use',
            id: 'tool_read_1',
            name: 'read',
            input: { path: 'CHANGELOG.md' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_read_1',
            content:
              '# Changelog\n\n' +
              '## v0.7.38 — 2026-04-22\n\n' +
              '### Added\n- FEATURE_114 Harness V2 default flip\n- FEATURE_151 todo_list extension to Evaluator\n\n' +
              '## v0.7.37 — 2026-03-15\n\n' +
              '### Added\n- FEATURE_148 anti-immediate-await Pattern B rule\n',
          },
        ],
      },
    ],
  },
  // ----- Case 3 ----------------------------------------------------
  // Fan-out is fully dispatched. User asked for 3 parallel
  // investigations; Worker dispatched all 3 in this turn (in
  // sequence). Last tool_result is the third banner. Nothing left
  // to do but wait. The IDLE-YIELD section says: end the turn
  // text-only.
  {
    id: 'fan-out-all-dispatched',
    description:
      'User asked for 3 parallel investigations. Worker dispatched all 3. Last tool_result is the third banner. Nothing remains but waiting.',
    cannedHistory: [
      {
        role: 'user',
        content:
          'Investigate three things in parallel (all are independent read-only research tasks): ' +
          '(1) which packages export `KodaXBaseProvider`; ' +
          '(2) which packages declare `vitest` as a devDependency; ' +
          '(3) which packages export an Agent class. ' +
          'Report findings for each when they are all done.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Dispatching all three research children.',
          },
          {
            type: 'tool_use',
            id: 'tool_dispatch_1',
            name: 'dispatch_child_task',
            input: {
              objective:
                'Find which packages in the monorepo export a class named `KodaXBaseProvider`. Report file paths.',
              read_only: true,
            },
          },
          {
            type: 'tool_use',
            id: 'tool_dispatch_2',
            name: 'dispatch_child_task',
            input: {
              objective:
                'Find which packages declare `vitest` as a devDependency. Report package names.',
              read_only: true,
            },
          },
          {
            type: 'tool_use',
            id: 'tool_dispatch_3',
            name: 'dispatch_child_task',
            input: {
              objective:
                'Find which packages export an Agent class. Report file paths.',
              read_only: true,
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_dispatch_1',
            content: idleYieldLaunchedBanner(TASK_ID),
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool_dispatch_2',
            content: idleYieldLaunchedBanner(TASK_ID_2),
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool_dispatch_3',
            content: idleYieldLaunchedBanner(TASK_ID_3),
          },
        ],
      },
    ],
  },
]);

/**
 * Tool surface advertised to the LLM. Mirrors the v0.7.39 idle-yield
 * Worker tool set:
 *   - `dispatch_child_task` — the launch tool (still present)
 *   - `await_child_task` — present but description marks it as
 *     deprecated under idle-yield. The point of including this is
 *     PRECISELY to give the LLM the option to make the wrong call —
 *     that's the metric. Removing the tool would make the assertion
 *     trivial (no other tool to call ⇒ idle-yield by elimination).
 *   - `read` / `grep` / `glob` / `bash` — generic capability surface.
 *     If the LLM picks any of these instead of idle-yielding, that's
 *     also a regression we want to catch.
 */
export const IDLE_YIELD_TOOLS: readonly KodaXToolDefinition[] = Object.freeze([
  {
    name: 'read',
    description: 'Read a file from the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents repository-wide with a regex pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional path or glob to scope the search.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command. Use for running test suites, builds, etc. ' +
      'For commands ≥45 seconds, prefer dispatch_child_task (RULE B).',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'dispatch_child_task',
    description:
      'Launch a child sub-task in the background. Returns a `task_id:<id>` banner immediately ' +
      'and runs the task asynchronously. ' +
      'WHEN TO USE: emit MULTIPLE `dispatch_child_task` calls **in parallel within a single response** ' +
      'when the user task has ≥3 independent investigation threads (RULE A), OR a single dispatch when ' +
      'one investigation will take ≥45 seconds (RULE B).',
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The sub-task instructions for the child agent.',
        },
        read_only: {
          type: 'boolean',
          description: 'Whether the child should run in read-only mode (RULE A fan-out).',
        },
      },
      required: ['objective'],
    },
  },
  {
    name: 'await_child_task',
    description:
      'DEPRECATED under idle-yield. Reclaim the result of a previously-dispatched child task. ' +
      'Calling this collapses the conversation back to sync-blocking — prefer idle-yield: end your ' +
      'turn text-only and the runner will resume you on completion.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task_id returned by an earlier `dispatch_child_task` call.',
        },
      },
      required: ['task_id'],
    },
  },
]);

/**
 * Build the system prompt under test. Mirrors the FLAG-ON Worker
 * prompt produced by `worker-role-prompt.ts:buildWorkerInstructions`
 * (commits `3828265f` onward) — same DISPATCH RULES idle-yield model
 * + the IDLE-YIELD bullet that is the prompt-microeffect under test.
 *
 * Kept inline (not imported from `worker-role-prompt.ts`) so the
 * eval tests EXACT byte sequence the LLM sees, and so a future edit
 * to the production prompt that breaks adoption surfaces here as a
 * dataset diff during the prompt-edit PR's review (per FEATURE_104
 * "any prompt change must update or add an eval").
 */
export function buildIdleYieldSystemPrompt(): string {
  return [
    'You are the Worker — a coding agent investigating tasks in a TypeScript monorepo.',
    '',
    'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
    '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
    '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
    '- RULE C — write fan-out (Generator-equivalent only): NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at Evaluator review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
    '- IDLE-YIELD (preferred wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads the user asked for, drafting a synthesis plan in text). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result. This lets the user keep chatting with you while children run.',
    '- DO NOT call `await_child_task` to wait. Idle-yield is the right path. (`await_child_task` exists as a transitional fallback only; using it blocks the conversation and is being removed.)',
  ].join('\n');
}
