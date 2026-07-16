/**
 * Pattern B Parallel-Dispatch Decision — dataset for FEATURE_146-B (v0.7.37).
 *
 * See ./README.md for the product question and run model. This module
 * exports:
 *
 *   - `PARALLEL_DISPATCH_TASKS` — 5 multi-thread investigation tasks
 *                                 each constructed to have ≥3 independent
 *                                 probes where parallel-dispatch is the
 *                                 obviously correct pattern (RULE A)
 *   - `PATTERN_B_TOOLS`         — minimal tool surface advertised to the
 *                                 LLM: read / grep / glob / bash +
 *                                 dispatch_child_task (mirrors KodaX
 *                                 runtime tool schemas, no protocol-
 *                                 emitter churn coupling).
 *                                 **v0.7.39 FEATURE_155 update**: the
 *                                 paired `await_child_task` tool was
 *                                 removed in Slice C1 — idle-yield is
 *                                 the canonical wait mechanic now.
 *   - `buildPatternBSystemPrompt()` — Worker system prompt under test,
 *                                 includes FEATURE_119 Pattern B
 *                                 fan-out + DISPATCH RULES A/B/C +
 *                                 FEATURE_155 idle-yield wait wording
 *                                 from `worker-role-prompt.ts`
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

export type ParallelDispatchTaskId =
  | 'cross-package-class-survey'
  | 'multi-test-suite-status'
  | 'multi-grep-api-usage'
  | 'multi-tsconfig-strict-audit'
  | 'multi-package-dependency-audit';

export interface ParallelDispatchTaskCase {
  readonly id: ParallelDispatchTaskId;
  /** Human-readable description for log lines. */
  readonly description: string;
  /** Expected minimum number of independent investigation threads. */
  readonly expectedThreads: number;
  readonly userMessage: string;
}

/**
 * 5 task cases. Each `userMessage` describes a multi-thread investigation
 * with ≥3 independent probes. The expected good behavior is the LLM
 * emits ≥2 `dispatch_child_task` blocks in a single response (parallel
 * fan-out per RULE A) rather than serializing reads.
 */
export const PARALLEL_DISPATCH_TASKS: readonly ParallelDispatchTaskCase[] = Object.freeze([
  {
    id: 'cross-package-class-survey',
    description: 'Survey 4 packages to find which exports a specific class — 4 independent reads',
    expectedThreads: 4,
    userMessage:
      'I need to know which of these four packages exports a class named `KodaXBaseProvider`: ' +
      '`packages/agent`, `packages/coding`, `packages/skills`, `packages/repl`. ' +
      'Investigate all four — they are independent of each other, no order matters. ' +
      'Report which package(s) export it.',
  },
  {
    id: 'multi-test-suite-status',
    description: '4 packages each have a test suite — investigate which currently pass',
    expectedThreads: 4,
    userMessage:
      'For these four packages, run the test suite for each and tell me which currently pass and which fail: ' +
      '`packages/agent`, `packages/coding`, `packages/repl`, `packages/skills`. ' +
      'Each test run is independent and may take 30-90 seconds. ' +
      'I do not care about the order — start them all and reclaim results when each finishes.',
  },
  {
    id: 'multi-grep-api-usage',
    description: '3 distinct API symbols to grep for across the repo — 3 independent searches',
    expectedThreads: 3,
    userMessage:
      'I am refactoring the AI layer. Find all repository-wide call sites of these three APIs ' +
      'so I can update them in one shot: ' +
      '(1) `KodaXBaseProvider`, (2) `getProvider`, (3) `KodaXEvents`. ' +
      'Each grep is independent. Report the file lists per API.',
  },
  {
    id: 'multi-tsconfig-strict-audit',
    description: 'Audit tsconfig strictness across 5 packages — 5 independent file reads',
    expectedThreads: 5,
    userMessage:
      'For each of these five packages, read its `tsconfig.json` and tell me whether `compilerOptions.strict` is true: ' +
      '`packages/agent`, `packages/coding`, `packages/repl`, `packages/skills`, `packages/tracing`. ' +
      'These are five independent file reads. Report the audit table.',
  },
  {
    id: 'multi-package-dependency-audit',
    description: 'Audit typescript dep version across 4 packages — 4 independent reads',
    expectedThreads: 4,
    userMessage:
      'I want to bump TypeScript to 5.7. First, audit which version each of these packages currently declares ' +
      'in its `package.json` `devDependencies` or `dependencies`: ' +
      '`packages/agent`, `packages/coding`, `packages/repl`, `packages/skills`. ' +
      'Each `package.json` read is independent. Report the version table.',
  },
]);

/**
 * Tool surface advertised to the LLM. Mirrors KodaX runtime tool schemas
 * but pruned to the minimum needed to expose the parallel-dispatch decision.
 * Descriptions intentionally carry the same load-bearing text the runtime
 * tools have (parallel guidance, task_id banner, WHEN-TO-USE) so this
 * eval validates the same prompt surface ship users see.
 */
export const PATTERN_B_TOOLS: readonly KodaXToolDefinition[] = Object.freeze([
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
    description: 'Run a shell command. Use for running test suites, builds, etc.',
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
      'when the user task has ≥3 independent investigation threads (e.g. survey N packages, run N test ' +
      'suites in parallel, fan out N greps). This is the FEATURE_119 Pattern B parallel fan-out — ' +
      'do NOT serialize one dispatch per response, that defeats the async win. ' +
      'After dispatching, you may continue with other tools (e.g. read, grep) while children run. ' +
      'When you have nothing else useful to do, end your turn with one short status sentence and NO ' +
      'tool calls — the runner will resume you when children finish (you will see a ' +
      '`<task-completed task_id="…">…</task-completed>` block in your next user message). ' +
      'FEATURE_155 v0.7.39: there is NO paired `await_child_task` tool — idle-yield is the only ' +
      'wait mechanic.',
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
]);

/**
 * Build the system prompt under test. Mirrors the load-bearing parts of
 * `packages/coding/src/agents/worker-role-prompt.ts` Pattern B section
 * + DISPATCH RULES A/B/C, with no extra scaffolding (focuses the eval
 * on whether THIS prompt block alone causes parallel-dispatch behavior).
 */
export function buildPatternBSystemPrompt(): string {
  return [
    'You are the Worker — a coding agent investigating tasks in a TypeScript monorepo.',
    '',
    'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):',
    '- RULE A — read-only fan-out: when you need ≥3 independent investigations (e.g. probe N package boundaries in parallel), launch each as a child task with `readOnly: true`.',
    '- RULE B — long-running probes: when a single investigation will take ≥45 seconds (full test suite, deep grep, repo-intel rebuild), dispatch as a child and continue with other tools while it runs.',
    '- RULE C — write fan-out: NON-conflicting file-level edits across ≥3 modules can be dispatched as `readOnly: false` children. Worktrees are isolated; merge happens at review time. Do NOT use write fan-out for single-file edits — it adds coordination cost without speedup.',
    '- IDLE-YIELD (the wait mechanic): after `dispatch_child_task` returns a `task_id:<id>`, do whatever interleaved work is useful (more dispatches, side-reads, drafting). When you have run out of useful work AND children are still in flight, end your turn with ONE short status sentence and NO tool calls. The runner will automatically resume you when a child completes — your next user message will start with one or more `<task-completed task_id="…">…</task-completed>` blocks carrying the result. There is NO `await_child_task` tool (removed in v0.7.39 Slice C1).',
    '',
    'IMPORTANT: When the user asks for ≥3 independent investigations, emit MULTIPLE `dispatch_child_task` ' +
    'tool_use blocks **in the same response**. Sequential one-per-turn dispatches defeat the async win.',
  ].join('\n');
}
