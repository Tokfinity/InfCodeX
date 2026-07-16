# FEATURE_240 v0.7.56 Human Test Guide

## Overview

**Feature**: Cross-Protocol StopReason Normalization + Terminal Semantics
**Version**: v0.7.56
**Test Date**: 2026-06-24
**Tester**: TBD

This guide focuses on user-visible runtime behavior across provider protocols.
The exact classifier mapping and agent-runtime branches are covered by automated
unit and contract tests.

## Environment

- Build from the current workspace.
- Use a temporary KodaX home:
  `set KODAX_HOME=%TEMP%\kodax-f240-manual`
- Configure at least one Anthropic-compatible route and one OpenAI-compatible
  route if real-provider testing is available.
- For deterministic manual checks, prefer a local mock/custom provider that can
  return chosen raw stop reasons: `max_tokens`, `length`, `end_turn`, `stop`,
  `pause_turn`, `refusal`, `content_filter`, and an unknown value.

## Manual Test Cases

### TC-001: OpenAI-compatible truncation auto-continues

**Priority**: High
**Type**: Regression / Runtime

1. Run a prompt against an OpenAI-compatible provider or mock that returns
   text, no tool calls, and raw stop reason `length`.
2. Observe the next runtime action.

**Expected**

- [ ] KodaX treats `length` like Anthropic `max_tokens`.
- [ ] The existing max-token continuation path fires.
- [ ] The user sees a continuation rather than a premature final answer.

### TC-002: OpenAI-compatible clean stop triggers managed-protocol recovery

**Priority**: High
**Type**: Regression / Runtime

1. Start a managed-protocol flow where a protocol block is required.
2. Return text without the block and raw stop reason `stop`.
3. Observe the follow-up turn.

**Expected**

- [ ] KodaX treats `stop` like Anthropic `end_turn`.
- [ ] The managed-protocol auto-continue request fires.
- [ ] No duplicate or confusing terminal output is shown before the recovery.

### TC-003: `pause_turn` terminates cleanly without re-prompt loop

**Priority**: Medium
**Type**: Boundary

1. Use a mock provider that returns raw stop reason `pause_turn`.
2. Ensure the response has no tool blocks.

**Expected**

- [ ] The current turn terminates cleanly.
- [ ] Managed-protocol auto-continue does not fire.
- [ ] The REPL remains responsive for the next user prompt.

### TC-004: Refusal/content filter is visible to the user

**Priority**: High
**Type**: Negative / UX

1. Return raw stop reason `refusal` from an Anthropic-compatible mock.
2. Repeat with raw stop reason `content_filter` from an OpenAI-compatible mock.

**Expected**

- [ ] The turn terminates without retrying.
- [ ] A user-visible decline note is surfaced.
- [ ] The decline does not look like an ordinary successful completion.

### TC-005: Unknown stop reason is diagnosable

**Priority**: Medium
**Type**: Observability

1. Return an arbitrary raw stop reason such as `new_gateway_reason`.
2. Observe terminal/runtime logs.

**Expected**

- [ ] The turn terminates rather than looping.
- [ ] A warning includes the raw stop reason, provider, model, and whether text
      or tool blocks were present.
- [ ] No `console.log` noise is added.

## Test Summary

| Cases | Pass | Fail | Blocked |
|---:|---:|---:|---:|
| 5 | - | - | - |

**Conclusion**: TBD
**Issues Found**: TBD

Feature/Issue ID: FEATURE_240
