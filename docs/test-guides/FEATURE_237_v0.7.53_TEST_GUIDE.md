# FEATURE_237 v0.7.53 - Human Test Guide

## Overview

**Feature**: Todo-drift nudge (warn-only unclaimed-work reminder)  
**Version**: v0.7.53  
**Tester**: Release validation owner  
**Date**: 2026-06-19

FEATURE_237 adds a warn-only observer that detects when the Worker starts real
work while its todo list has pending items but nothing marked `in_progress`. It
arms a one-shot `<system-reminder>` for the next turn and surfaces a
`KodaXTodoDriftWarningEvent` to the host. It must never mutate the todo store,
never block a run, and never nag a Worker that is keeping its list in sync.

## Environment

- Node.js >= 20
- Repository built with `npm run build`
- A provider/model capable of multi-step tool use (AMA/Worker mode)
- A task that naturally produces a todo plan with multiple steps

## Test Cases

### TC-001: Drift produces exactly one reminder

**Priority**: High  
**Type**: Positive

**Steps**:
1. Give the Worker a multi-step task so it creates a todo list with several
   `pending` items.
2. Steer it to perform a real edit/write before marking any item `in_progress`.
3. Observe the next turn.

**Expected Results**:
- [ ] Exactly one drift reminder is armed for the episode (not one per tool).
- [ ] The model is nudged to call `todo_update` (or `todo_list` / `todo_get`).
- [ ] The reminder text is never shown to the user in the transcript.
- [ ] A `onTodoDriftWarning` event / `todoDriftWarnings` entry is recorded.

### TC-002: A Worker that claims work is never nagged

**Priority**: High  
**Type**: Negative

**Steps**:
1. Run the same multi-step task.
2. This time the Worker marks the matching item `in_progress` before doing the
   work.

**Expected Results**:
- [ ] No drift reminder is armed.
- [ ] `todoDriftWarnings` stays empty for the run.

### TC-003: Meta / read-only tools do not trigger

**Priority**: Medium  
**Type**: Negative

**Steps**:
1. With pending-but-unclaimed todos, let the Worker run only read-only / meta
   tools (e.g. a read, `get_goal`, `ask_user_question`).

**Expected Results**:
- [ ] No reminder is armed (detection requires a successful real-work tool).

### TC-004: Self-correction clears the armed state

**Priority**: Medium  
**Type**: Positive

**Steps**:
1. Trigger a drift episode (TC-001).
2. Before the next work tool, let the Worker call `todo_update` successfully.

**Expected Results**:
- [ ] The armed reminder is cleared and not re-emitted on the next turn.

## Automated Coverage

- Unit: `packages/coding/src/task-engine/todo-drift-reminder.test.ts`
- Prompt eval (gated on API keys): `tests/todo-drift-reminder.eval.ts`

## Sign-off

- [ ] All high-priority cases pass.
- [ ] No todo-store mutation observed.
- [ ] No run blocked or failed by the observer.
