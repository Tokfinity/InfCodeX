# FEATURE_174 v0.7.53 - Human Test Guide

## Overview

**Feature**: `kodax sessions dedupe`  
**Version**: v0.7.53  
**Tester**: Release validation owner  
**Date**: 2026-06-18

FEATURE_174 adds a dry-run-first cleanup command for historical `runner-*.jsonl`
ghost sessions. It must never delete canonical user sessions and must only move
unique ghost matches when `--apply` is explicitly passed.

## Environment

- Node.js >= 20
- Repository built with `npm run build`
- A disposable `KODAX_SESSIONS_DIR`
- PowerShell or another shell that can inspect JSONL files

## Test Cases

### TC-001: Dry-run does not mutate a missing sessions directory

**Priority**: High  
**Type**: Safety

**Steps**:
1. Pick a non-existent temp directory.
2. Run `KODAX_SESSIONS_DIR=<temp>/sessions kodax sessions dedupe`.
3. Check whether `<temp>/sessions` was created.

**Expected Results**:
- [ ] The command exits successfully.
- [ ] Output reports zero scanned sessions.
- [ ] The sessions directory is still absent.

### TC-002: Dry-run reports a unique runner ghost without moving files

**Priority**: High  
**Type**: Positive

**Steps**:
1. Create a disposable sessions directory with one canonical user session and
   one matching `runner-*.jsonl` ghost in the same project directory.
2. Run `kodax sessions dedupe` against that directory.
3. Inspect both files after the command.

**Expected Results**:
- [ ] Output shows one runner candidate and one match.
- [ ] Both original files remain in place.
- [ ] No `.dedupe-archive` directory is created.

### TC-003: Apply moves only the uniquely matched runner ghost

**Priority**: High  
**Type**: Positive

**Steps**:
1. Reuse the fixture from TC-002.
2. Run `kodax sessions dedupe --apply`.
3. Inspect the project directory and `.dedupe-archive`.

**Expected Results**:
- [ ] The canonical session remains in its original location.
- [ ] The `runner-*.jsonl` ghost is moved under `.dedupe-archive`.
- [ ] The archive path preserves the original relative path.
- [ ] Running the command again is safe and reports no additional moves.

### TC-004: Ambiguous candidates are skipped

**Priority**: Medium  
**Type**: Negative

**Steps**:
1. Create one `runner-*.jsonl` ghost and two plausible canonical matches.
2. Run `kodax sessions dedupe --apply`.

**Expected Results**:
- [ ] Output marks the runner candidate as ambiguous.
- [ ] No files are moved.

## Summary

| Cases | Pass | Fail | Blocked |
|-------|------|------|---------|
| 4 | - | - | - |

**Feature/Issue ID**: FEATURE_174
