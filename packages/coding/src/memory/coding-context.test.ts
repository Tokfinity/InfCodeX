import { describe, expect, it } from 'vitest';

import { createTodoStore } from '../task-engine/todo-store.js';
import { buildCodingMemoryContext } from './coding-context.js';

describe('FEATURE_260 coding memory context', () => {
  it('projects open authoritative state without mutating its sources', () => {
    const todos = createTodoStore();
    todos.init([
      { id: 'todo_1', subject: 'Run tests' },
      { id: 'todo_2', subject: 'Already done' },
    ]);
    todos.updateStatus('todo_2', 'completed');
    const before = todos.getAll();

    const context = buildCodingMemoryContext({
      objective: 'Ship memory support',
      decisionIntent: 'implementation',
      actionSignature: 'tool:test',
      todoStore: todos,
      artifacts: [{
        id: 'artifact-1',
        kind: 'check_result',
        target: 'typecheck',
        summary: 'Typecheck failed',
        timestamp: '2026-07-12T00:00:00.000Z',
      }],
      childSummaries: ['Reviewer found a stale scope check'],
      verifierOutcome: 'revise: add tenant isolation',
      observationSequence: 4,
    });

    expect(context.text).toContain('Todo todo_1 (pending): Run tests');
    expect(context.text).not.toContain('Already done');
    expect(context.text).toContain('Artifact check_result: Typecheck failed');
    expect(context.text).toContain('Reviewer found a stale scope check');
    expect(context.throughSequence).toBe(4);
    expect(todos.getAll()).toEqual(before);
  });

  it('is deterministic and bounded', () => {
    const input = {
      objective: 'x'.repeat(1_000),
      decisionIntent: 'implementation',
      childSummaries: Array.from({ length: 20 }, (_, index) => `${index}:${'y'.repeat(1_000)}`),
      observationSequence: 0,
    } as const;
    const first = buildCodingMemoryContext(input);
    const second = buildCodingMemoryContext(input);

    expect(first).toEqual(second);
    expect(first.text.length).toBeLessThanOrEqual(6_000);
  });

  it('redacts restricted values before optional semantic recall can see the context', () => {
    const context = buildCodingMemoryContext({
      objective: 'Investigate token=super-secret-value',
      decisionIntent: 'diagnose',
      verifierOutcome: 'authorization: bearer abc123',
      observationSequence: 0,
    });

    expect(context.text).toContain('[restricted]');
    expect(context.text).not.toContain('super-secret-value');
    expect(context.text).not.toContain('abc123');
  });
});
