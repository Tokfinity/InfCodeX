/**
 * Eval - todo drift reminder nudge.
 *
 * Checks that the production `<system-reminder>` text nudges models toward an
 * explicit todo follow-up after real work starts while no item is in_progress.
 *
 * Pilot mode: one alias x two variants x three runs. Raw benchmark summaries
 * are printed by the harness; no files are written.
 */

import { describe, it } from 'vitest';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark, type PromptVariant } from '../benchmark/harness/harness.js';
import type { PromptJudge } from '../benchmark/harness/judges.js';
import { buildTodoDriftReminderText } from '../packages/coding/src/task-engine/todo-drift-reminder.js';

const TODO_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'todo_update',
    description: 'Update the status of an existing todo item.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'completed'] },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'todo_list',
    description: 'List visible todo items when you need to refresh state.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'todo_get',
    description: 'Fetch one todo item before updating it when uncertain.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

const BASE_SYSTEM = [
  'You are a coding agent.',
  'When a system reminder asks you to call an available tool, call that tool in this response instead of answering in prose first.',
  'Visible todo list:',
  '- todo_1 pending: Inspect implementation',
  '- todo_2 pending: Run focused tests',
  'You just read packages/coding/src/task-engine/todo-drift-reminder.ts.',
].join('\n');

const REMINDER = buildTodoDriftReminderText({
  kind: 'work_started_without_claimed_todo',
  toolName: 'read',
  toolCallId: 'read-1',
  count: 1,
  pendingCount: 2,
  openCount: 2,
  firstPendingTodoId: 'todo_1',
  firstPendingTodoSubject: 'Inspect implementation',
});

const VARIANTS: readonly PromptVariant[] = [
  {
    id: 'v_baseline',
    description: 'Visible pending todos, no drift reminder.',
    systemPrompt: BASE_SYSTEM,
    userMessage: 'Continue with the task.',
    tools: TODO_TOOLS,
  },
  {
    id: 'v_with_drift_reminder',
    description: 'Production todo drift reminder appended.',
    systemPrompt: `${BASE_SYSTEM}\n\n${REMINDER}`,
    userMessage: 'Continue with the task.',
    tools: TODO_TOOLS,
  },
];

const TODO_FOLLOWUP_JUDGE: PromptJudge = {
  name: 'todo_followup_tool_call',
  category: 'correctness',
  judge(output, context) {
    const toolNames = context?.toolCalls?.map((call) => call.name) ?? [];
    const lower = output.toLowerCase();
    const found = toolNames.some((name) =>
      name === 'todo_update' || name === 'todo_list' || name === 'todo_get'
    ) || lower.includes('todo_update') || lower.includes('todo_list') || lower.includes('todo_get');
    return found
      ? { passed: true }
      : { passed: false, reason: `expected todo_update, todo_list, or todo_get; got ${toolNames.join(', ') || 'none'}` };
  },
};

describe('Eval: todo drift reminder', () => {
  const aliases = availableAliases('ark/v4flash');

  if (aliases.length === 0) {
    it('skips: no provider API key in env for ark/v4flash', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  it(
    'nudges explicit todo follow-up',
    { timeout: 10 * 60_000 },
    async () => {
      const result = await runBenchmark({
        variants: VARIANTS,
        models: aliases,
        judges: [TODO_FOLLOWUP_JUDGE],
        runs: 3,
      });

      const lines: string[] = ['[todo-drift-reminder]'];
      for (const variant of VARIANTS) {
        const cells = result.byVariant[variant.id] ?? [];
        for (const cell of cells) {
          const passed = cell.runsRaw.filter((run) => run.passed).length;
          lines.push(`  ${variant.id} ${cell.alias}: ${passed}/${cell.runsRaw.length}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
  );
});
