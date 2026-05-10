/**
 * Pattern B Post-Dispatch Probe — Layer 2 dataset for FEATURE_148 (v0.7.37).
 *
 * ## Methodology
 *
 * This dataset is a **Layer 2 single-turn probe** per
 * [`benchmark/EVAL_GUIDELINES.md`](../../EVAL_GUIDELINES.md):
 *
 *   - **Pre-canned input**: system prompt + canned history that ENDS with
 *     a synthetic `task_id:<id> launched` tool_result block. The LLM
 *     never gets to free-run; the harness owns every bit of the input.
 *   - **Single LLM call per probe**: one `provider.stream` invocation,
 *     no multi-turn loop, no aggregation across turns.
 *   - **Mechanical assertion**: the first emitted `tool_use` block's
 *     name + input. No human "looks good" judging.
 *
 * The hypothesis under test:
 *
 *   When the user has explicitly asked for a side-task ("WHILE X runs,
 *   also do Y"), and the assistant has just dispatched X as a child
 *   (so `task_id:child-1 launched` is the most recent tool_result the
 *   LLM has seen), then the LLM's NEXT `tool_use` should NOT be
 *   `await_child_task({task_id:'child-1'})`.
 *
 *   Calling await_child_task immediately at this boundary is the
 *   "派出去 → 立即 await" Pattern B sync-degeneration the FEATURE_148
 *   anti-immediate-await rule is supposed to suppress.
 *
 * ## Why this is Layer 2, not Layer 3.5 (anti-pattern 2)
 *
 * Anti-pattern 2 = "let the LLM run free for N turns and aggregate the
 * trace". An earlier draft of this eval ran a multi-turn loop with a
 * mock executor — that *would* be the anti-pattern, because the LLM
 * makes ≥2 free decisions per cell and prompt-microeffect gets
 * drowned in trajectory noise. This redesign instead probes ONE
 * decision: "given this exact post-dispatch state, what's the next
 * tool_use?". Single decision, mechanical signal.
 *
 * ## Pre-registered metric + threshold
 *
 *   - **Per-cell signal**: `degenerate := firstToolName === 'await_child_task'
 *     && firstToolInput.task_id === 'child-1'`
 *   - **Aggregate**: degenerate-rate (degenerate cells / total cells × 100)
 *
 *   PASS:        degenerate-rate ≤ 40%
 *   INCONCLUSIVE: 40-70% (logged, not a fail)
 *   FAIL:        degenerate-rate > 70%   (asserted; vitest red)
 *
 * The FAIL gate (>70%) is set above the PASS aspiration to give
 * partial wins room to ship; gate can be tightened in future versions
 * once a baseline is established.
 *
 * ## Sample size
 *
 *   N=3 reps per (alias × scenario). Single-turn tool-name decisions
 *   show low within-cell variance in 146-B's data (5 alias × 5 task
 *   gave consistent +/− 12pp swing across two sweeps), so n=3 is
 *   sufficient to filter single-call rate-limit / temperature-jitter
 *   noise without doubling cost. n=5+ would be needed if we were
 *   measuring text quality, not tool-name selection.
 *
 * ## Cost budget
 *
 *   5 alias × 5 scenario × 3 reps = 75 probes × ~$0.01-0.05/probe ≈ $1-4.
 *   Strict serial within alias (avoid 429 per EVAL_GUIDELINES 反模式 3).
 */

import type {
  KodaXMessage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

export type PostDispatchProbeId =
  | 'long-test-with-side-read'
  | 'three-fanout-with-side-readme'
  | 'slow-grep-with-side-tsconfig'
  | 'long-build-with-side-changelog'
  | 'parallel-research-with-side-package';

export interface PostDispatchProbeCase {
  readonly id: PostDispatchProbeId;
  readonly description: string;
  /**
   * The full canned message history sent to the provider. The LAST
   * message MUST be a user-role `tool_result` block carrying a
   * synthetic `task_id:child-1 launched` banner — that is the exact
   * decision boundary the probe measures.
   */
  readonly cannedHistory: readonly KodaXMessage[];
  /**
   * The set of tool names that would be a CORRECT non-degenerate
   * next move (informational — the actual gate is just "not
   * await_child_task on child-1"). For per-cell logging only.
   */
  readonly suggestedNextTools: readonly string[];
}

const TASK_ID = 'child-1';

const launchedBanner = (taskId: string): string =>
  `task_id:${taskId} launched. The child is running asynchronously in the background. ` +
  `You may continue with other tools (read / grep / glob / bash / additional dispatch_child_task) ` +
  `while it runs. Reclaim the result with await_child_task({task_id: "${taskId}"}) ` +
  `when you actually need it.`;

/**
 * 5 scenarios. Each one constructs a canned (user-task → assistant-
 * dispatch → user-tool_result) sequence where the user message
 * EXPLICITLY names a cheap independent side-task to do while the
 * dispatched child runs. The assistant's canned text is intentionally
 * neutral ("I'll dispatch …") — it does NOT pre-commit to a "next
 * I'll …" plan, so the LLM's decision is driven only by the system
 * prompt + user task + the just-arrived task_id banner.
 */
export const POST_DISPATCH_PROBE_CASES: readonly PostDispatchProbeCase[] =
  Object.freeze([
    {
      id: 'long-test-with-side-read',
      description:
        'After dispatching `npm test` (~90s), should do the explicitly-asked package.json read instead of immediately awaiting',
      suggestedNextTools: ['read'],
      cannedHistory: [
        {
          role: 'user',
          content:
            'Run the full `npm test` suite for `packages/coding` — it takes about 90 seconds. ' +
            'WHILE that is running, also read `packages/coding/package.json` and tell me what the ' +
            'declared test script line is. ' +
            'These two things are independent — the read does not depend on the test result. ' +
            'When the test finishes, report whether it passed and what the test script declaration is.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "I'll dispatch the test as a background child task.",
            },
            {
              type: 'tool_use',
              id: 'tool_dispatch_1',
              name: 'dispatch_child_task',
              input: {
                prompt:
                  'Run `npm test` for `packages/coding` and report whether it passed plus any failure details.',
                readOnly: false,
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
              content: launchedBanner(TASK_ID),
            },
          ],
        },
      ],
    },
    {
      id: 'three-fanout-with-side-readme',
      description:
        'After dispatching the FIRST of three independent test-suite children, should dispatch the other two (or read README) instead of awaiting child-1',
      suggestedNextTools: ['dispatch_child_task', 'read'],
      cannedHistory: [
        {
          role: 'user',
          content:
            'For each of these three packages, run their test suite (each takes 30-90s and is independent): ' +
            '`packages/agent`, `packages/coding`, `packages/repl`. ' +
            'WHILE those are running, also read `README.md` from the repo root and summarize the listed ' +
            'supported LLM providers (one-line list). ' +
            'Final report: pass/fail per package + the provider summary.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "I'll start by dispatching the first test child.",
            },
            {
              type: 'tool_use',
              id: 'tool_dispatch_1',
              name: 'dispatch_child_task',
              input: {
                prompt:
                  'Run `npm test` for `packages/agent` and report whether it passed plus any failure details.',
                readOnly: false,
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
              content: launchedBanner(TASK_ID),
            },
          ],
        },
      ],
    },
    {
      id: 'slow-grep-with-side-tsconfig',
      description:
        'After dispatching deep repo-wide grep, should read tsconfig.json (the side-task) instead of awaiting',
      suggestedNextTools: ['read'],
      cannedHistory: [
        {
          role: 'user',
          content:
            'I need a repo-wide regex grep for the symbol `KodaXBaseProvider` across ALL files in the repo ' +
            '(no path filter — full sweep, this is slow because it scans node_modules indirectly). ' +
            'WHILE the grep is running, also read `packages/coding/tsconfig.json` and tell me whether ' +
            '`compilerOptions.strict` is enabled. ' +
            'Report (a) the file list of matches and (b) the strict-flag value.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "I'll dispatch the deep grep as a background child task.",
            },
            {
              type: 'tool_use',
              id: 'tool_dispatch_1',
              name: 'dispatch_child_task',
              input: {
                prompt:
                  'Run a repo-wide grep for the symbol `KodaXBaseProvider` across ALL files (no path filter). Report the file list of matches.',
                readOnly: true,
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
              content: launchedBanner(TASK_ID),
            },
          ],
        },
      ],
    },
    {
      id: 'long-build-with-side-changelog',
      description:
        'After dispatching full monorepo build (~60s), should read CHANGELOG.md (the side-task) instead of awaiting',
      suggestedNextTools: ['read'],
      cannedHistory: [
        {
          role: 'user',
          content:
            'Run the full monorepo build (`npm run build`) — it takes about 60s and rebuilds all 10 packages. ' +
            'WHILE that is running, also read `CHANGELOG.md` from the repo root and report what version is ' +
            'mentioned in the most recent entry. ' +
            'When the build finishes, report whether it succeeded and the latest changelog version.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "I'll dispatch the build as a background child task.",
            },
            {
              type: 'tool_use',
              id: 'tool_dispatch_1',
              name: 'dispatch_child_task',
              input: {
                prompt:
                  'Run `npm run build` at the repo root. Report whether the build succeeded and any errors.',
                readOnly: false,
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
              content: launchedBanner(TASK_ID),
            },
          ],
        },
      ],
    },
    {
      id: 'parallel-research-with-side-package',
      description:
        'After dispatching the FIRST of two independent research children, should dispatch the second (or read package.json side-task) instead of awaiting child-1',
      suggestedNextTools: ['dispatch_child_task', 'read'],
      cannedHistory: [
        {
          role: 'user',
          content:
            'Investigate two things in parallel (each is a deep-read research task — dispatch them as ' +
            'read-only children since they are independent): ' +
            '(1) which packages export a class named `KodaXBaseProvider`; ' +
            '(2) which packages declare `vitest` as a devDependency. ' +
            'WHILE those run, also read `package.json` from the repo root and report the top-level ' +
            'declared `name` field. ' +
            'Final report: (a) findings from the two research tasks, (b) the root package name.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "I'll start with the first research child.",
            },
            {
              type: 'tool_use',
              id: 'tool_dispatch_1',
              name: 'dispatch_child_task',
              input: {
                prompt:
                  'Investigate which packages in the monorepo export a class named `KodaXBaseProvider`. Search the source tree and report the file paths.',
                readOnly: true,
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
              content: launchedBanner(TASK_ID),
            },
          ],
        },
      ],
    },
  ]);

/**
 * Tool surface advertised to the LLM. Mirrors the FEATURE_146-B set
 * so the only delta vs that eval is the canned history (post-dispatch
 * state) and the assertion target (next-tool-name vs parallel-trigger).
 */
export const POST_DISPATCH_PROBE_TOOLS: readonly KodaXToolDefinition[] =
  Object.freeze([
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
        'one investigation will take ≥45 seconds (RULE B). ' +
        'CRITICAL — DO NOT immediately await the dispatched task on the next turn if there is OTHER ' +
        'useful work you can do (read related context, dispatch additional children, draft a summary). ' +
        'Awaiting on the very next turn collapses async into sync and defeats Pattern B. ' +
        'Reclaim results with `await_child_task({task_id})` only when you have run out of useful ' +
        'interleaved work or actually need the result to proceed.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The sub-task instructions for the child agent.',
          },
          readOnly: {
            type: 'boolean',
            description: 'Whether the child should run in read-only mode (RULE A fan-out).',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'await_child_task',
      description:
        'Reclaim the result of a previously-dispatched child task. ' +
        'WHEN TO USE: after launching one or more `dispatch_child_task` calls, emit `await_child_task` ' +
        'for each `task_id:<id>` banner you received WHEN you actually need the result. ' +
        'Do NOT call `await_child_task` on the very next turn after dispatch when you still have ' +
        'useful independent work to do (additional dispatches, a side read the user asked for, a ' +
        'summary draft) — that flattens Pattern B back to sync. ' +
        'A `<task-completed>` background notification will arrive at the next yielding tool boundary; ' +
        'you may also `await_child_task` proactively when you actually need the value.',
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
 * Build the system prompt under test. Mirrors the load-bearing parts
 * of `packages/coding/src/agents/worker-role-prompt.ts`'s
 * `dispatchRules` block + the FEATURE_148 anti-immediate-await rule
 * the v0.7.37 patch adds. The eval thus probes the SAME prompt
 * surface ship users see in production.
 */
export function buildPostDispatchProbeSystemPrompt(): string {
  return [
    'You are the Worker — a coding agent investigating tasks in a TypeScript monorepo.',
    '',
    'DISPATCH RULES (`dispatch_child_task` / `await_child_task`):',
    '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
    '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs. Reclaim the result with `await_child_task({task_id})` when needed.',
    '- RULE C — write fan-out: NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
    '- Pattern B (FEATURE_119): `dispatch_child_task` returns a `task_id:<id>` immediately and runs in the background. A `<task-completed>` notification arrives at the next yielding tool boundary; you may also `await_child_task` proactively when you need the result.',
    '- ANTI-PATTERN — DO NOT IMMEDIATELY AWAIT (FEATURE_148): after `dispatch_child_task` returns a `task_id:<id>`, your IMMEDIATE next move must NOT be `await_child_task` on that id when there is OTHER USEFUL WORK to do. Useful work includes: dispatching ADDITIONAL independent children, doing the SIDE-READS the user asked for in the same request, drafting a synthesis plan in text, OR reading context that will let you act on the child result faster once it arrives. Only call `await_child_task` when (a) you actually need the result to proceed and have run out of interleaved work, or (b) the user explicitly asked for the dispatched probe and nothing else. Concretely: if the user asks "do X (slow) AND also do Y (cheap)" — dispatch X, then DO Y, then await X. Awaiting X immediately after dispatch and only then doing Y collapses Pattern B back to a sync call with extra steps.',
  ].join('\n');
}
