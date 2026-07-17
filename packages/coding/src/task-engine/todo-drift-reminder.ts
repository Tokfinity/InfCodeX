/**
 * Warn-only todo drift detector.
 *
 * Detects the soft-contract violation where the Worker has a visible
 * pending plan, no item is marked in_progress, and a successful real
 * work tool just completed. The detector never mutates TodoStore; it
 * only records telemetry and arms a one-shot system reminder for the
 * next LLM turn.
 *
 * LLM-facing reminder text is paired with
 * `tests/todo-drift-reminder.eval.ts`.
 */

import type {
  RunnerToolCall,
  RunnerToolObserver,
  RunnerToolResult,
} from '@kodax-ai/agent';
import type { KodaXTodoDriftWarningEvent } from '../types.js';
import { isVisibleToolName } from '../agent-runtime/event-emitter.js';
import { isToolResultErrorContent } from '../agent-runtime/tool-result-classify.js';
import {
  matchesShellPattern,
  SHELL_WRITE_PATTERNS,
  VERIFICATION_SHELL_PATTERNS,
} from './_internal/managed-task/tool-policy.js';
import type { TodoStore } from './todo-store.js';

const NON_WORK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user_question',
  'create_goal',
  'exit_plan_mode',
  'get_goal',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  'update_goal',
]);

const SHELL_STATE_CHANGE_PATTERNS: readonly string[] = [
  '\\bgit\\s+(?:add|commit|push|merge|rebase|reset|rm)\\b',
  '\\b(?:npm|pnpm|yarn)\\s+(?:install|publish|update|rm|add|remove)\\b',
];

export interface TodoDriftReminderState {
  readonly pendingReminder: { current: KodaXTodoDriftWarningEvent | undefined };
  readonly warnings: { current: KodaXTodoDriftWarningEvent[] };
  readonly workStartedWithoutClaimedTodoCount: { current: number };
  readonly lastUnclaimedWorkTool: { current: string | undefined };
  readonly lastUnclaimedWorkSequence: { current: number | undefined };
}

export function createTodoDriftReminderState(): TodoDriftReminderState {
  return {
    pendingReminder: { current: undefined },
    warnings: { current: [] },
    workStartedWithoutClaimedTodoCount: { current: 0 },
    lastUnclaimedWorkTool: { current: undefined },
    lastUnclaimedWorkSequence: { current: undefined },
  };
}

export function clearTodoDriftReminderState(state: TodoDriftReminderState): void {
  state.pendingReminder.current = undefined;
}

export function hasPendingTodoWithoutActive(todoStore: TodoStore): boolean {
  const items = todoStore.getAll();
  return items.some((item) => item.status === 'pending')
    && !items.some((item) => item.status === 'in_progress');
}

function isWriteAgentSpawn(input: Record<string, unknown>): boolean {
  return (input.read_only ?? input.readOnly) === false;
}

function isBashWorkSignal(input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return false;
  return matchesShellPattern(command, SHELL_WRITE_PATTERNS)
    || matchesShellPattern(command, VERIFICATION_SHELL_PATTERNS)
    || matchesShellPattern(command, SHELL_STATE_CHANGE_PATTERNS);
}

export function isRealWorkToolCall(call: RunnerToolCall): boolean {
  const normalized = call.name.toLowerCase();
  if (!isVisibleToolName(normalized)) return false;
  if (NON_WORK_TOOL_NAMES.has(normalized)) return false;
  if (normalized === 'spawn_agent') {
    return isWriteAgentSpawn(call.input);
  }
  if (normalized === 'bash') {
    return isBashWorkSignal(call.input);
  }
  return true;
}

function stringifyToolResultContent(content: RunnerToolResult['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item) => item.type === 'text')
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('');
}

function isSuccessfulToolResult(result: RunnerToolResult): boolean {
  if (result.isError === true) return false;
  return !isToolResultErrorContent(stringifyToolResultContent(result.content));
}

function isSuccessfulTodoUpdate(call: RunnerToolCall, result: RunnerToolResult): boolean {
  if (call.name !== 'todo_update') return false;
  if (!isSuccessfulToolResult(result)) return false;
  if (typeof result.content !== 'string') return false;
  try {
    const envelope = result.content.split('\n', 1)[0]?.trim() ?? '';
    const parsed = JSON.parse(envelope) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

function buildWarningEvent(
  state: TodoDriftReminderState,
  todoStore: TodoStore,
  call: RunnerToolCall,
): KodaXTodoDriftWarningEvent {
  const items = todoStore.getAll();
  const pending = items.filter((item) => item.status === 'pending');
  const open = items.filter(
    (item) => item.status === 'pending'
      || item.status === 'in_progress'
      || item.status === 'failed',
  );
  const count = state.workStartedWithoutClaimedTodoCount.current + 1;
  const firstPending = pending[0];
  return {
    kind: 'work_started_without_claimed_todo',
    toolName: call.name,
    toolCallId: call.id,
    count,
    pendingCount: pending.length,
    openCount: open.length,
    ...(firstPending
      ? {
        firstPendingTodoId: firstPending.id,
        firstPendingTodoSubject: firstPending.subject,
      }
      : {}),
  };
}

export function observeTodoDriftAfterToolResult(params: {
  readonly state: TodoDriftReminderState;
  readonly todoStore: TodoStore;
  readonly call: RunnerToolCall;
  readonly result: RunnerToolResult;
}): KodaXTodoDriftWarningEvent | undefined {
  const { state, todoStore, call, result } = params;

  if (isSuccessfulTodoUpdate(call, result)) {
    clearTodoDriftReminderState(state);
    return undefined;
  }

  if (!isSuccessfulToolResult(result)) return undefined;
  if (!hasPendingTodoWithoutActive(todoStore)) return undefined;
  if (!isRealWorkToolCall(call)) return undefined;

  const event = buildWarningEvent(state, todoStore, call);
  state.workStartedWithoutClaimedTodoCount.current = event.count;
  state.warnings.current.push(event);
  state.lastUnclaimedWorkTool.current = event.toolName;
  state.lastUnclaimedWorkSequence.current = event.count;
  if (!state.pendingReminder.current) {
    state.pendingReminder.current = event;
  }
  return event;
}

export function getTodoDriftWarnings(
  state: TodoDriftReminderState,
): readonly KodaXTodoDriftWarningEvent[] {
  return [...state.warnings.current];
}

export function buildTodoDriftReminderText(event: KodaXTodoDriftWarningEvent): string {
  const pendingSummary = event.firstPendingTodoId && event.firstPendingTodoSubject
    ? `First pending item: ${event.firstPendingTodoId}: ${event.firstPendingTodoSubject}.`
    : `There are ${event.pendingCount} pending items.`;
  return [
    '<system-reminder>',
    `You just completed a real work tool call (${event.toolName}) while the visible todo list has pending items but no item marked in_progress.`,
    pendingSummary,
    'If that work corresponds to a listed item, call todo_update now to mark the matching item in_progress or completed.',
    'If uncertain, call todo_list or todo_get first, then update the matching item. Do not invent progress.',
    'NEVER mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n');
}

export function consumeTodoDriftReminderText(
  state: TodoDriftReminderState,
  todoStore: TodoStore,
): string | undefined {
  const event = state.pendingReminder.current;
  if (!event) return undefined;
  state.pendingReminder.current = undefined;
  if (!hasPendingTodoWithoutActive(todoStore)) return undefined;
  return buildTodoDriftReminderText(event);
}

export function createTodoDriftObserver(params: {
  readonly todoStore: TodoStore;
  readonly state: TodoDriftReminderState;
  readonly onWarning?: (event: KodaXTodoDriftWarningEvent) => void;
}): RunnerToolObserver {
  return {
    onToolResult: (call, result) => {
      const event = observeTodoDriftAfterToolResult({
        state: params.state,
        todoStore: params.todoStore,
        call,
        result,
      });
      if (event) params.onWarning?.(event);
    },
  };
}
