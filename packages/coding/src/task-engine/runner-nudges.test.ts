/**
 * FEATURE_114 v0.7.36 — runner-nudges plan-first contract tests.
 */
import { describe, expect, it } from 'vitest';
import {
  createRunnerNudgeState,
  maybeAppendPlanNudge,
  observeToolCall,
} from './runner-nudges.js';

describe('createRunnerNudgeState', () => {
  it('starts at zero reads, no todo_update, no nudge', () => {
    const s = createRunnerNudgeState();
    expect(s.readsSinceLastTodoUpdate).toBe(0);
    expect(s.anyTodoUpdateFired).toBe(false);
    expect(s.nudgeAlreadyEmitted).toBe(false);
  });
});

describe('observeToolCall', () => {
  it('counts read/grep/glob as reads', () => {
    let s = createRunnerNudgeState();
    s = observeToolCall({ state: s, toolName: 'read' });
    s = observeToolCall({ state: s, toolName: 'grep' });
    s = observeToolCall({ state: s, toolName: 'glob' });
    expect(s.readsSinceLastTodoUpdate).toBe(3);
  });

  it('counts code_search and semantic_lookup as reads', () => {
    let s = createRunnerNudgeState();
    s = observeToolCall({ state: s, toolName: 'code_search' });
    s = observeToolCall({ state: s, toolName: 'semantic_lookup' });
    expect(s.readsSinceLastTodoUpdate).toBe(2);
  });

  it('does not count write/edit/bash as reads', () => {
    let s = createRunnerNudgeState();
    s = observeToolCall({ state: s, toolName: 'write' });
    s = observeToolCall({ state: s, toolName: 'edit' });
    s = observeToolCall({ state: s, toolName: 'bash' });
    expect(s.readsSinceLastTodoUpdate).toBe(0);
  });

  it('todo_update resets reads counter and marks anyTodoUpdateFired', () => {
    let s = createRunnerNudgeState();
    s = observeToolCall({ state: s, toolName: 'read' });
    s = observeToolCall({ state: s, toolName: 'read' });
    expect(s.readsSinceLastTodoUpdate).toBe(2);
    s = observeToolCall({ state: s, toolName: 'todo_update' });
    expect(s.readsSinceLastTodoUpdate).toBe(0);
    expect(s.anyTodoUpdateFired).toBe(true);
  });
});

describe('maybeAppendPlanNudge', () => {
  it('does not nudge below threshold', () => {
    let s = createRunnerNudgeState();
    for (let i = 0; i < 4; i++) {
      s = observeToolCall({ state: s, toolName: 'read' });
    }
    const result = maybeAppendPlanNudge({ state: s });
    expect(result.nudge).toBeUndefined();
    expect(result.nextState.nudgeAlreadyEmitted).toBe(false);
  });

  it('nudges once at threshold and never again', () => {
    let s = createRunnerNudgeState();
    for (let i = 0; i < 5; i++) {
      s = observeToolCall({ state: s, toolName: 'read' });
    }
    const first = maybeAppendPlanNudge({ state: s });
    expect(first.nudge).toContain('committing a plan');
    expect(first.nextState.nudgeAlreadyEmitted).toBe(true);

    // Continued reads do NOT re-emit.
    let next = first.nextState;
    next = observeToolCall({ state: next, toolName: 'read' });
    next = observeToolCall({ state: next, toolName: 'read' });
    const second = maybeAppendPlanNudge({ state: next });
    expect(second.nudge).toBeUndefined();
  });

  it('does not nudge once todo_update has fired', () => {
    let s = createRunnerNudgeState();
    for (let i = 0; i < 5; i++) {
      s = observeToolCall({ state: s, toolName: 'read' });
    }
    s = observeToolCall({ state: s, toolName: 'todo_update' });
    // Reads start counting again, but anyTodoUpdateFired is sticky.
    for (let i = 0; i < 6; i++) {
      s = observeToolCall({ state: s, toolName: 'read' });
    }
    const result = maybeAppendPlanNudge({ state: s });
    expect(result.nudge).toBeUndefined();
  });

  it('respects custom readThreshold', () => {
    let s = createRunnerNudgeState();
    s = observeToolCall({ state: s, toolName: 'read' });
    s = observeToolCall({ state: s, toolName: 'read' });
    const result = maybeAppendPlanNudge({ state: s, readThreshold: 2 });
    expect(result.nudge).toContain('committing a plan');
  });
});
