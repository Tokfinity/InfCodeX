import type {
  RunnerToolCall,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { describe, expect, it, vi } from 'vitest';

import { createTodoStore } from './todo-store.js';
import {
  buildTodoDriftReminderText,
  consumeTodoDriftReminderText,
  createTodoDriftObserver,
  createTodoDriftReminderState,
  getTodoDriftWarnings,
  hasPendingTodoWithoutActive,
  isRealWorkToolCall,
  observeTodoDriftAfterToolResult,
} from './todo-drift-reminder.js';

function call(
  name: string,
  input: Record<string, unknown> = {},
  id = `${name}-1`,
): RunnerToolCall {
  return { id, name, input };
}

function okResult(content = 'ok'): RunnerToolResult {
  return { content };
}

function seededPendingStore(): ReturnType<typeof createTodoStore> {
  const store = createTodoStore();
  store.init([
    { id: 'todo_1', subject: 'Inspect implementation' },
    { id: 'todo_2', subject: 'Run tests' },
  ]);
  return store;
}

describe('todo drift pending/active predicate', () => {
  it('returns true only when at least one pending item exists and no item is active', () => {
    const store = seededPendingStore();
    expect(hasPendingTodoWithoutActive(store)).toBe(true);

    store.updateStatus('todo_1', 'in_progress');
    expect(hasPendingTodoWithoutActive(store)).toBe(false);

    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'completed');
    expect(hasPendingTodoWithoutActive(store)).toBe(false);
  });
});

describe('real work tool classification', () => {
  it('counts regular visible work tools', () => {
    expect(isRealWorkToolCall(call('read', { file_path: 'a.ts' }))).toBe(true);
    expect(isRealWorkToolCall(call('grep', { pattern: 'todo' }))).toBe(true);
    expect(isRealWorkToolCall(call('edit', { path: 'a.ts' }))).toBe(true);
  });

  it('excludes todo scaffolding and coordinator/control tools', () => {
    expect(isRealWorkToolCall(call('todo_update', { id: 'todo_1' }))).toBe(false);
    expect(isRealWorkToolCall(call('todo_create', { subject: 'Step' }))).toBe(false);
    expect(isRealWorkToolCall(call('send_message', { task_id: 'worker' }))).toBe(false);
    expect(isRealWorkToolCall(call('task_stop', { task_id: 'child-1' }))).toBe(false);
    expect(isRealWorkToolCall(call('ask_user_question', { question: 'Continue?' }))).toBe(false);
  });

  it('counts dispatch_child_task only when the child may write', () => {
    expect(isRealWorkToolCall(call('dispatch_child_task', { objective: 'Inspect' }))).toBe(false);
    expect(isRealWorkToolCall(call('dispatch_child_task', {
      objective: 'Patch bug',
      readOnly: false,
    }))).toBe(true);
    expect(isRealWorkToolCall(call('dispatch_child_task', {
      objective: 'Patch bug',
      read_only: false,
    }))).toBe(true);
  });

  it('counts bash write and verification commands but not empty shell input', () => {
    expect(isRealWorkToolCall(call('bash', { command: 'npm test -- --runInBand' }))).toBe(true);
    expect(isRealWorkToolCall(call('bash', { command: 'git add packages/coding/src/x.ts' }))).toBe(true);
    expect(isRealWorkToolCall(call('bash', { command: '   ' }))).toBe(false);
  });
});

describe('todo drift observer', () => {
  it('records warn-only drift and arms a one-shot reminder without mutating todo statuses', () => {
    const store = seededPendingStore();
    const state = createTodoDriftReminderState();
    const before = store.getAll();

    const event = observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read', { file_path: 'packages/coding/src/x.ts' }),
      result: okResult('file contents'),
    });

    expect(event).toMatchObject({
      kind: 'work_started_without_claimed_todo',
      toolName: 'read',
      count: 1,
      pendingCount: 2,
      firstPendingTodoId: 'todo_1',
    });
    expect(state.workStartedWithoutClaimedTodoCount.current).toBe(1);
    expect(state.pendingReminder.current?.toolName).toBe('read');
    expect(getTodoDriftWarnings(state)).toEqual([event]);
    expect(store.getAll()).toEqual(before);
  });

  it('does not arm when a todo is already in_progress', () => {
    const store = seededPendingStore();
    store.updateStatus('todo_1', 'in_progress');
    const state = createTodoDriftReminderState();

    const event = observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('grep', { pattern: 'x' }),
      result: okResult(),
    });

    expect(event).toBeUndefined();
    expect(state.pendingReminder.current).toBeUndefined();
  });

  it('does not arm on tool errors or error-looking content', () => {
    const store = seededPendingStore();
    const state = createTodoDriftReminderState();

    const explicit = observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read'),
      result: { content: 'boom', isError: true },
    });
    const contentError = observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read'),
      result: okResult('[Tool Error] read: missing file'),
    });

    expect(explicit).toBeUndefined();
    expect(contentError).toBeUndefined();
    expect(state.pendingReminder.current).toBeUndefined();
  });

  it('clears a pending reminder after a successful todo_update', () => {
    const store = seededPendingStore();
    const state = createTodoDriftReminderState();
    observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read'),
      result: okResult(),
    });
    expect(state.pendingReminder.current).toBeDefined();

    observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('todo_update', { id: 'todo_1', status: 'in_progress' }),
      result: okResult('{"ok":true}\n\n[evaluator:todo_1] pass'),
    });

    expect(state.pendingReminder.current).toBeUndefined();
    expect(getTodoDriftWarnings(state)).toHaveLength(1);
  });

  it('emits telemetry through the observer callback', () => {
    const store = seededPendingStore();
    const state = createTodoDriftReminderState();
    const onWarning = vi.fn();
    const observer = createTodoDriftObserver({ todoStore: store, state, onWarning });

    observer.onToolResult?.(call('grep', { pattern: 'TODO' }), okResult('matches'));

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toMatchObject({
      kind: 'work_started_without_claimed_todo',
      toolName: 'grep',
      count: 1,
    });
  });
});

describe('todo drift reminder text', () => {
  it('builds a system-reminder that asks for explicit todo_update', () => {
    const text = buildTodoDriftReminderText({
      kind: 'work_started_without_claimed_todo',
      toolName: 'read',
      toolCallId: 'r1',
      count: 1,
      pendingCount: 2,
      openCount: 2,
      firstPendingTodoId: 'todo_1',
      firstPendingTodoSubject: 'Inspect implementation',
    });

    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text).toContain('no item marked in_progress');
    expect(text).toContain('call todo_update now');
    expect(text).toContain('Do not invent progress');
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('consumes the reminder once and suppresses it after the plan is claimed', () => {
    const store = seededPendingStore();
    const state = createTodoDriftReminderState();
    observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read'),
      result: okResult(),
    });

    expect(consumeTodoDriftReminderText(state, store)).toContain('call todo_update now');
    expect(consumeTodoDriftReminderText(state, store)).toBeUndefined();

    observeTodoDriftAfterToolResult({
      state,
      todoStore: store,
      call: call('read'),
      result: okResult(),
    });
    store.updateStatus('todo_1', 'in_progress');
    expect(consumeTodoDriftReminderText(state, store)).toBeUndefined();
  });
});
