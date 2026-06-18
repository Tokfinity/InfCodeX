# FEATURE_211 v0.7.53 - Human Test Guide

## Overview

**Feature**: Interactive extension/MCP session state cross-resume persistence  
**Version**: v0.7.53  
**Tester**: Release validation owner  
**Date**: 2026-06-18

FEATURE_211 lets interactive host-owned sessions persist extension/MCP
`extensionState` and `extensionRecords` across `kodax -r` / `kodax -c` resume
flows without forcing every ordinary Ink save through a full JSONL rewrite.

## Environment

- Node.js >= 20
- Repository built with `npm run build`
- A disposable `KODAX_SESSIONS_DIR`
- A small test extension or MCP runtime that writes session state during
  `hydrateSession()` and/or a turn hook
- A provider configured for one short interactive turn

## Test Cases

### TC-001: Interactive resume restores extension state

**Priority**: High  
**Type**: Positive

**Steps**:
1. Start an Ink REPL session with the test extension enabled.
2. Run one prompt that causes the extension to write a visible session key,
   for example `visits = 1`.
3. Exit the REPL.
4. Resume the same session with `kodax -r <session-id>` or `kodax -c`.
5. Trigger the extension to read and increment the same key.

**Expected Results**:
- [ ] The extension observes the previously persisted value.
- [ ] The next saved session JSONL contains updated `extensionState`.
- [ ] The transcript messages are not duplicated or rewound.

### TC-002: Explicit extension state clears persist

**Priority**: High  
**Type**: Regression

**Steps**:
1. Start from a session with a persisted extension key.
2. Run a turn where the extension clears that key.
3. Exit and resume the session.
4. Ask the extension to report the key.

**Expected Results**:
- [ ] The key remains absent after resume.
- [ ] Storage does not restore the old value from the prior meta line.

### TC-003: Hydration wins duplicate-key conflicts

**Priority**: Medium  
**Type**: Compatibility

**Steps**:
1. Seed a session file with `extensionState.ext.phase = "storage"`.
2. Use an extension whose `hydrateSession()` writes
   `extensionState.ext.phase = "hydrate"`.
3. Resume the session and run one short prompt.
4. Inspect the saved session JSONL.

**Expected Results**:
- [ ] The persisted value is `"hydrate"`.
- [ ] Other unrelated keys from storage remain present.

### TC-004: Ordinary turns stay append-only when extension state is unchanged

**Priority**: Medium  
**Type**: Performance / Regression

**Steps**:
1. Start a session that already has persisted extension state.
2. Run a normal prompt where the extension does not modify state or records.
3. Inspect the tail of the session JSONL.

**Expected Results**:
- [ ] The new turn is appended normally.
- [ ] No unnecessary full rewrite is observed.
- [ ] The prior extension state remains readable after resume.

## Summary

| Cases | Pass | Fail | Blocked |
|-------|------|------|---------|
| 4 | - | - | - |

**Feature/Issue ID**: FEATURE_211
