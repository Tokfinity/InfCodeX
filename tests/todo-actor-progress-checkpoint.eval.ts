/**
 * F270 Todo / Actor progress checkpoint — Layer 2 pilot v3 — 2026-07-22.
 *
 * Why Layer 1 is insufficient: unit tests prove that mailbox-delivered
 * structured task-result metadata injects the production reminder exactly once,
 * but only a model probe can show whether the combined prompt changes the next
 * plan decision without encouraging premature completion.
 *
 * Revision note: v1 preserved under the OS temp dump root used
 * `maxOutputTokens=512`; 8/16 calls exhausted that cap with no public output,
 * making the pilot eval-invalid. v2 changes only the output budget and reruns
 * affected cells: both aliases for phase_finished, plus zhipu for support_only.
 * The four uncapped MMX support_only samples from v1 are reused during review.
 *
 * Frozen v2 budget:
 *   - affected cells only = maxProviderCalls 6
 *   - maxCallsPerCell 1; maxRoundsPerCell 1
 *   - maxOutputTokensPerCall 2048; timeoutMs 90_000
 *   - maxTotalTokens 120_000; maxExternalSpendUsd 1.50
 *   - no retries, fallbacks, tool execution, or panel expansion
 *
 * Pre-registered analysis:
 *   - phase_finished diagnoses timely `todo_1 → completed` before another wait;
 *   - support_only diagnoses no premature completion and no Actor-shaped Todo,
 *     while still waiting for the remaining result;
 *   - mechanical tool-call scores are diagnostic. The main session reviews the
 *     paired raw outputs (including at least one pass/fail per cell when present)
 *     before mapping blinded arm ids to baseline/candidate.
 *   - recommend-ship only when the candidate is materially clearer overall and
 *     has no credible premature-completion regression. Provider errors are
 *     provider-noise; an invalid scenario/scorer is eval-invalid, not a prompt
 *     verdict.
 *
 * Post-run scorer audit (no generation rerun): the original support_only
 * diagnostic required `wait_agent` specifically. Raw review found a safe
 * response that kept todo_1 `in_progress` and recorded why it was waiting, so
 * the scorer now accepts either that visible reconciliation or an actual wait.
 * The safety gates (no completion, no Actor-shaped Todo) are unchanged.
 *
 * v3 rebases the production substrate onto FEATURE_273's mailbox-driven
 * `wait_agent`. Historical v2 raw output remains preserved under its OS-temp
 * dump root and is not reused for a future prompt decision because the
 * Worker/tool bytes changed. The comparison still isolates F270's Todo
 * checkpoint rules; mailbox semantics are common to both arms.
 *
 * Run:
 *   KODAX_EVAL_TODO_ACTOR_PROGRESS=1 npm run test:eval -- todo-actor-progress-checkpoint
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark, type PromptVariant } from '../benchmark/harness/harness.js';
import type { JudgeContext, JudgeResult, PromptJudge } from '../benchmark/harness/judges.js';
import { buildWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { createTodoStore } from '../packages/coding/src/task-engine/todo-store.js';
import {
  consumeAgentCompletionTodoReminderText,
  createTodoDriftReminderState,
} from '../packages/coding/src/task-engine/todo-drift-reminder.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import type { KodaXTaskRoutingDecision } from '../packages/coding/src/types.js';

const ENABLE_ENV = 'KODAX_EVAL_TODO_ACTOR_PROGRESS';
const RUNS_PER_CELL = 1;
const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 2_048;
const PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'mmx/m3'];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'todo-actor-progress-checkpoint-v3', RUN_ID);
const RAW_PATH = join(DUMP_DIR, 'raw.jsonl');

const DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'review',
  workIntent: 'inspect',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.9,
  reason: 'Actor-assisted review',
  requiresBrainstorm: false,
};

const CURRENT_WORKER_PROMPT = buildWorkerInstructions(DECISION, undefined, false, {
  maxConcurrentThreads: 4,
  activeNonRootTurns: 1,
});

const CURRENT_TERMINATION = '- Before writing the final summary, perform a final consistency check: update only genuinely finished items that are still open. This is a safety net, not the normal update point; progress updates belong at each milestone boundary.';
const BASELINE_TERMINATION = '- Before writing that final summary, mark every finished item `completed` as your closing tool calls — this is the only way the plan reflects your progress in real time. The runner force-completes any still-open items on an accept verdict, but that correction is invisible to you and lands only after the user has already watched the list sit stale.';
const CURRENT_PLAN_GRANULARITY = '- Todo items are user-visible semantic milestones, not Actor instances. Several Agents may support one milestone; create separate items only for genuinely separate deliverables.';
const CURRENT_MILESTONE_CADENCE = '- After a milestone is actually finished, update it before starting the next item, calling `wait_agent` again, or writing the final response. Do not defer multiple status changes to final cleanup.';
const CURRENT_AGENT_CHECKPOINT = '- After a terminal Agent result arrives, integrate its evidence and reconcile the affected semantic plan milestone before calling `wait_agent` again or starting a different plan milestone. Do not mark a milestone completed merely because one supporting Agent finished; keep it `in_progress` when other work or synthesis remains.';

function releasedWorkerPrompt(): string {
  const baseline = CURRENT_WORKER_PROMPT
    .replace(`${CURRENT_PLAN_GRANULARITY}\n`, '')
    .replace(`${CURRENT_MILESTONE_CADENCE}\n`, '')
    .replace(`${CURRENT_AGENT_CHECKPOINT}\n`, '')
    .replace(CURRENT_TERMINATION, BASELINE_TERMINATION);
  if (
    baseline === CURRENT_WORKER_PROMPT
    || baseline.includes(CURRENT_PLAN_GRANULARITY)
  ) {
    throw new Error('Baseline Worker prompt revert is stale');
  }
  return baseline;
}

function productionTool(name: string): KodaXToolDefinition {
  const definition = getToolDefinition(name);
  if (!definition) throw new Error(`Missing production tool definition: ${name}`);
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.input_schema,
  };
}

const CURRENT_WAIT_SUFFIX = ' After mailbox evidence arrives, integrate it and reconcile the affected semantic plan milestone before waiting again.';
const CURRENT_CREATE_RULE = '- BEFORE spawning several child Agents via `spawn_agent` — capture the user-visible semantic milestones, not one item per child Agent. Several Agents may support one milestone; split rows only when they produce genuinely separate deliverables.';
const BASELINE_CREATE_RULE = '- BEFORE spawning several child Agents via `spawn_agent` — the plan list is the natural anchor for the work each child will execute.';

function baselineTool(definition: KodaXToolDefinition): KodaXToolDefinition {
  let description = definition.description;
  if (definition.name === 'wait_agent') {
    description = description.replace(CURRENT_WAIT_SUFFIX, '');
    if (description === definition.description) {
      throw new Error('Baseline wait_agent description revert is stale');
    }
  }
  if (definition.name === 'todo_create') {
    description = description.replace(CURRENT_CREATE_RULE, BASELINE_CREATE_RULE);
    if (description === definition.description) {
      throw new Error('Baseline todo_create description revert is stale');
    }
  }
  return { ...definition, description };
}

const PRODUCTION_TOOLS = [
  'todo_create',
  'todo_update',
  'todo_get',
  'wait_agent',
].map(productionTool);
const BASELINE_TOOLS = PRODUCTION_TOOLS.map(baselineTool);

function productionCompletionReminder(): string {
  const store = createTodoStore();
  store.init([
    { id: 'todo_1', subject: 'Collect independent review evidence' },
    { id: 'todo_2', subject: 'Synthesize the recommendation' },
  ]);
  store.updateStatus('todo_1', 'in_progress');
  const state = createTodoDriftReminderState();
  consumeAgentCompletionTodoReminderText(state, store, []);
  const reminder = consumeAgentCompletionTodoReminderText(state, store, [{
    role: 'user',
    content: '<agent-completed>result</agent-completed>',
    _synthetic: true,
    _source: 'agent-completed',
    _taskResult: {
      type: 'task_result',
      source: 'child_task',
      taskId: 'eval-turn',
      status: 'completed',
    },
  }]);
  if (!reminder) throw new Error('Production Agent completion reminder was not generated');
  return reminder;
}

const COMPLETION_REMINDER = productionCompletionReminder();

function freshTodoSnapshot(): readonly KodaXMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'todo-get-1',
        name: 'todo_get',
        input: { id: 'todo_1' },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'todo-get-1',
        content: JSON.stringify({
          ok: true,
          item: {
            id: 'todo_1',
            subject: 'Collect independent review evidence',
            status: 'in_progress',
          },
        }),
      }],
    },
  ];
}

interface EvalCase {
  readonly id: 'phase_finished' | 'support_only';
  readonly state: string;
  readonly completionMessage: KodaXMessage;
  readonly judge: PromptJudge;
}

function isCompletedTodoOne(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const record = input as Readonly<Record<string, unknown>>;
  return record.id === 'todo_1' && record.status === 'completed';
}

function keepsTodoOneInProgress(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const record = input as Readonly<Record<string, unknown>>;
  return record.id === 'todo_1' && record.status === 'in_progress';
}

function positiveJudge(_output: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  const createsActorRow = calls.some((call) => call.name === 'todo_create');
  const completionIndex = calls.findIndex(
    (call) => call.name === 'todo_update' && isCompletedTodoOne(call.input),
  );
  const waitIndex = calls.findIndex((call) => call.name === 'wait_agent');
  if (createsActorRow) return { passed: false, reason: 'created an Actor-shaped Todo row' };
  if (completionIndex < 0) return { passed: false, reason: 'did not complete todo_1 in this response' };
  if (waitIndex >= 0 && waitIndex < completionIndex) {
    return { passed: false, reason: 'waited again before reconciling todo_1' };
  }
  return { passed: true };
}

function negativeJudge(_output: string, context?: JudgeContext): JudgeResult {
  const calls = context?.toolCalls ?? [];
  if (calls.some((call) => call.name === 'todo_create')) {
    return { passed: false, reason: 'created an Actor-shaped Todo row' };
  }
  if (calls.some((call) => call.name === 'todo_update' && isCompletedTodoOne(call.input))) {
    return { passed: false, reason: 'prematurely completed todo_1 after one supporting result' };
  }
  const waitsForRemaining = calls.some((call) => call.name === 'wait_agent');
  const recordsVisibleOngoingProgress = calls.some(
    (call) => call.name === 'todo_update' && keepsTodoOneInProgress(call.input),
  );
  if (!waitsForRemaining && !recordsVisibleOngoingProgress) {
    return { passed: false, reason: 'neither waited nor recorded the still-in-progress milestone' };
  }
  return { passed: true };
}

const CASES: readonly EvalCase[] = [
  {
    id: 'phase_finished',
    state: [
      'CURRENT AUTHORITATIVE STATE:',
      '- todo_1 in_progress: Collect independent review evidence',
      '- todo_2 pending: Synthesize the recommendation',
      'Both required review Agents have now completed. Their two reports below cover every evidence lane required by todo_1. No local collection work remains. todo_2 has not started.',
    ].join('\n'),
    completionMessage: {
      role: 'user',
      content: [
        '<agent-completed path="/root/api-review" turn_id="turn-api" state="completed">API review complete; evidence and affected files are listed.</agent-completed>',
        '<agent-completed path="/root/runtime-review" turn_id="turn-runtime" state="completed">Runtime review complete; lifecycle findings and tests are listed.</agent-completed>',
      ].join('\n\n'),
      _synthetic: true,
      _source: 'agent-completed',
      _taskResults: [
        { type: 'task_result', source: 'child_task', taskId: 'turn-api', status: 'completed' },
        { type: 'task_result', source: 'child_task', taskId: 'turn-runtime', status: 'completed' },
      ],
    },
    judge: { name: 'timely_semantic_completion', category: 'correctness', judge: positiveJudge },
  },
  {
    id: 'support_only',
    state: [
      'CURRENT AUTHORITATIVE STATE:',
      '- todo_1 in_progress: Collect independent review evidence',
      '- todo_2 pending: Synthesize the recommendation',
      'The API review Agent has completed, but the equally required Runtime review Agent is still running. todo_1 therefore remains incomplete. There is no useful local work until the Runtime report arrives.',
    ].join('\n'),
    completionMessage: {
      role: 'user',
      content: '<agent-completed path="/root/api-review" turn_id="turn-api" state="completed">API review complete; evidence and affected files are listed.</agent-completed>',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: {
        type: 'task_result',
        source: 'child_task',
        taskId: 'turn-api',
        status: 'completed',
      },
    },
    judge: { name: 'no_premature_actor_shaped_progress', category: 'correctness', judge: negativeJudge },
  },
];

function variantsFor(testCase: EvalCase): readonly PromptVariant[] {
  const baseline: PromptVariant = {
    id: testCase.id === 'phase_finished' ? 'arm_a' : 'arm_b',
    description: 'blinded arm',
    systemPrompt: `${releasedWorkerPrompt()}\n\n${testCase.state}`,
    priorMessages: [...freshTodoSnapshot(), testCase.completionMessage],
    userMessage: 'Continue.',
    tools: BASELINE_TOOLS,
    reasoning: { effort: 'medium' },
  };
  const candidate: PromptVariant = {
    id: testCase.id === 'phase_finished' ? 'arm_b' : 'arm_a',
    description: 'blinded arm',
    systemPrompt: `${CURRENT_WORKER_PROMPT}\n\n${testCase.state}\n\n${COMPLETION_REMINDER}`,
    priorMessages: [...freshTodoSnapshot(), testCase.completionMessage],
    userMessage: 'Continue.',
    tools: PRODUCTION_TOOLS,
    reasoning: { effort: 'medium' },
  };
  return [baseline, candidate];
}

describe('Eval: F270 Todo / Actor progress checkpoint', () => {
  const enabled = process.env[ENABLE_ENV] === '1';
  const aliases = availableAliases(...PANEL);
  const hasFullPanel = PANEL.every((alias) => aliases.includes(alias));

  it.skipIf(!enabled || !hasFullPanel)(
    'runs the frozen single-turn pilot and preserves blinded raw evidence',
    { timeout: 12 * 60_000 },
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const summaries: unknown[] = [];
      let providerCalls = 0;
      let totalTokens = 0;

      for (const testCase of CASES) {
        const variants = variantsFor(testCase);
        const caseAliases = testCase.id === 'support_only'
          ? aliases.filter((alias) => alias === 'zhipu/glm52')
          : aliases;
        if (caseAliases.length === 0) continue;
        const result = await runBenchmark({
          variants,
          models: caseAliases,
          judges: [testCase.judge],
          runs: RUNS_PER_CELL,
          timeoutMs: TIMEOUT_MS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          onRun: (run) => {
            providerCalls += 1;
            if (providerCalls > 6) throw new Error('Frozen maxProviderCalls exceeded');
            if (!run.usage && !run.error) {
              throw new Error('Provider omitted usage; token budget cannot be enforced');
            }
            totalTokens += run.usage?.totalTokens ?? 0;
            if (totalTokens > 120_000) throw new Error('Frozen maxTotalTokens exceeded');
            appendFileSync(RAW_PATH, `${JSON.stringify({ caseId: testCase.id, ...run })}\n`, 'utf8');
          },
        });
        summaries.push({
          caseId: testCase.id,
          cells: result.cells.map((cell) => ({
            arm: cell.variantId,
            alias: cell.alias,
            passRate: cell.passRate,
            runs: cell.runsRaw.length,
          })),
        });
      }

      writeFileSync(join(DUMP_DIR, 'summary.blinded.json'), JSON.stringify({
        experiment: 'todo-actor-progress-checkpoint-v2',
        budget: {
          maxProviderCalls: 6,
          maxCallsPerCell: 1,
          maxRoundsPerCell: 1,
          maxOutputTokensPerCall: MAX_OUTPUT_TOKENS,
          maxTotalTokens: 120_000,
          maxExternalSpendUsd: 1.5,
          timeoutMs: TIMEOUT_MS,
        },
        aliases,
        providerCalls,
        totalTokens,
        summaries,
      }, null, 2), 'utf8');
      writeFileSync(join(DUMP_DIR, 'arm-mapping.json'), JSON.stringify({
        phase_finished: { arm_a: 'released-baseline', arm_b: 'candidate' },
        support_only: { arm_a: 'candidate', arm_b: 'released-baseline' },
      }, null, 2), 'utf8');

      process.stdout.write(`Todo/Actor progress eval dump: ${DUMP_DIR}\n`);
      expect(summaries).toHaveLength(CASES.length);
    },
  );
});
