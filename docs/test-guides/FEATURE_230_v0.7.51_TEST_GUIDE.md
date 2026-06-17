# FEATURE_230 v0.7.51 - Human Test Guide

## Overview

**Feature**: Durable TUI Tool Transcript Replay
**Version**: v0.7.51
**Tester**: Release validation owner
**Date**: 2026-06-17

FEATURE_230 persists sanitized terminal tool cards in session `uiHistory` and
reconstructs tool cards from canonical `tool_use` / `tool_result` messages when
no TUI replay cache exists. It is session transcript replay only; workflow live
progress remains on `WorkflowProcessSnapshot` and lifecycle APIs.

## Environment

- Node.js >= 18
- Repository built with `npm run build`
- A configured provider for one real REPL tool-using turn
- Disposable sessions directory or scratch project
- Terminal capable of running interactive KodaX commands

## Test Cases

### TC-001: REPL resume preserves terminal tool cards

**Priority**: High
**Type**: Positive

**Steps**:
1. Start an interactive REPL session.
2. Ask for a task that triggers at least one visible tool call, such as reading a small file.
3. Exit after the assistant final answer is displayed.
4. Resume the same session with continue/resume.

**Expected Results**:
- [ ] The restored transcript includes the prior tool card, not only assistant text.
- [ ] Tool card status is terminal (`success`, `error`, or `cancelled`), not `executing`.
- [ ] The restored text order remains user -> thinking/tool card -> assistant.
- [ ] No duplicate tool cards appear after resume.

### TC-002: Session JSONL stores bounded sanitized tool metadata

**Priority**: High
**Type**: Positive / Security

**Steps**:
1. Run a tool-using REPL turn where tool input includes a harmless key plus a sensitive-looking key such as `apiKey`.
2. Open the session JSONL meta/update lines. The default file is under:
   `~/.kodax/sessions/projects/<project-key>/<session-id>.jsonl`
   (or the configured `KODAX_SESSIONS_DIR` / `createSessionManager({ sessionsDir })` root).
3. Inspect `uiHistory`.

Example quick inspection:

```powershell
Get-Content <session-file>.jsonl |
  Select-String '"uiHistory"' |
  Select-Object -Last 1
```

**Expected Results**:
- [ ] `uiHistory` may contain `{ "type": "tool_group", "tools": [...] }`.
- [ ] Tool input keeps harmless fields needed for display.
- [ ] Sensitive-looking fields are redacted as `[redacted]`.
- [ ] Live-only fields such as progress lines are not persisted.
- [ ] Large output/error text is bounded.

### TC-003: SDK session types expose replay schema

**Priority**: Medium
**Type**: Positive

**Steps**:
1. In a TypeScript host sample, import `KodaXSessionUiHistoryItem` from `@kodax-ai/kodax/session`.
2. Type-check a value containing a text item and a `tool_group` item.
3. Build the sample.

**Expected Results**:
- [ ] The import resolves without using REPL UI types.
- [ ] The type accepts `tool_group.tools[].status` values `success`, `error`, `cancelled`, and `awaiting_approval`.
- [ ] Non-terminal runtime statuses such as `executing` are rejected in persisted session data.

### TC-004: Headless SDK sessions reconstruct tool cards from messages

**Priority**: High
**Type**: Positive

**Steps**:
1. Run a headless SDK session that persists canonical messages but has no TUI-authored `uiHistory`.
2. Ensure the transcript contains an assistant `tool_use` followed by a user `tool_result`.
3. Load the session and render/replay the transcript.

**Expected Results**:
- [ ] Tool cards can be reconstructed from canonical messages.
- [ ] `tool_result.is_error === true` displays as an error tool.
- [ ] Missing results display as cancelled/incomplete, not running forever.
- [ ] Synthetic `tool_result` user messages do not become user prompt bubbles.

### TC-005: Workflow boundary stays on process APIs

**Priority**: High
**Type**: Negative / Regression

**Steps**:
1. Start a workflow run from the REPL or SDK.
2. Resume or reload the session after the run has emitted child digests/final text.
3. Inspect both session replay and workflow lifecycle snapshots.

**Expected Results**:
- [ ] Session replay restores durable chat facts such as child digest text and final answer.
- [ ] Session `uiHistory` does not store workflow process snapshots, lifecycle controls, retention state, or live progress rows.
- [ ] Run ownership is read from `WorkflowProcessSnapshot.hostMetadata` when present, not inferred from session replay.
- [ ] `/workflow runs/show/stop` behavior remains driven by workflow lifecycle APIs.
