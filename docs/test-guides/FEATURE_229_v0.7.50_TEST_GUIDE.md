# FEATURE_229 v0.7.50 - Human Test Guide

## Overview

**Feature**: Workflow Process Events + SDK/System Progress Surface  
**Version**: v0.7.50  
**Tester**: TBD  
**Date**: TBD

FEATURE_229 turns workflow progress into a shared agent-layer process contract.
REPL, SDK hosts, and future Space-style surfaces should consume the same
workflow snapshots, lifecycle controls, identity resolver, and retention
results without parsing terminal text.

## Environment

- Node.js >= 18
- Repository built with `npm run build`
- At least one configured provider for real workflow generation
- A clean scratch repository or disposable branch for workflow run artifacts
- Terminal capable of running interactive KodaX commands

## Test Cases

### TC-001: SDK process subscription and polling

**Priority**: High  
**Type**: Positive

**Steps**:
1. Start a workflow through the coding SDK or an explicit `/workflow create` command.
2. Subscribe to workflow process events.
3. Poll the same run through the lifecycle controller.

**Expected Results**:
- [ ] `workflow_started`, `workflow_updated`, and terminal event snapshots are emitted.
- [ ] Polled snapshots agree with subscribed snapshots for `runId`, `status`, phase, item counts, and result summary.
- [ ] Snapshot payloads do not contain ANSI or REPL-only view model fields.

### TC-002: Host policy for AMAW auto-start

**Priority**: High  
**Type**: Positive / Negative

**Steps**:
1. Run a natural-language complex task with host policy `autoStart: off`.
2. Repeat with `autoStart: confirm`.
3. Repeat with `autoStart: on`.
4. Run explicit `/workflow create` while policy is off.

**Expected Results**:
- [ ] `off` does not auto-start AMAW workflow.
- [ ] `confirm` asks before workflow start.
- [ ] `on` can auto-start when invocation policy classifies the request as workflow-worthy.
- [ ] Explicit `/workflow` commands still work and keep normal permission gates.

### TC-003: Lifecycle controller controls an active workflow

**Priority**: High  
**Type**: Positive

**Steps**:
1. Start a workflow that launches multiple child agents.
2. Call pause, resume, and stop through the lifecycle controller or matching REPL commands.
3. Inspect `/workflow runs` and `/workflow show`.

**Expected Results**:
- [ ] Pause prevents future child launches without pretending active children are checkpointed.
- [ ] Resume allows scheduling to continue.
- [ ] Stop aborts active work and ends as a terminal cancelled/stopped state.
- [ ] Terminal runs no longer appear as active.

### TC-004: Result and artifact reads

**Priority**: High  
**Type**: Positive

**Steps**:
1. Run a workflow that writes an artifact and returns a final synthesis.
2. Read the final result and artifact through SDK lifecycle APIs.
3. Compare with `/workflow show --full`.

**Expected Results**:
- [ ] SDK result read returns the same final workflow summary users see.
- [ ] SDK artifact read returns the stored artifact data.
- [ ] `/workflow show --full` remains the detailed terminal view, not the only source of truth.

### TC-005: Rename run display name and saved capsule name

**Priority**: Medium  
**Type**: Positive / Boundary

**Steps**:
1. Save a generated workflow as `audit-one`.
2. Rename a completed run display name.
3. Rename saved capsule `audit-one` to `audit-two`.
4. Rerun by the new saved name.

**Expected Results**:
- [ ] Run `runId` stays unchanged while display name changes.
- [ ] Saved capsule file and manifest identity update to the new safe name.
- [ ] Old saved name no longer resolves; new saved name runs the capsule.
- [ ] Ambiguous run-id/saved-name targets fail closed.

### TC-006: Revise creates a new capsule by default

**Priority**: High  
**Type**: Positive

**Steps**:
1. Save a generated workflow as `audit-base`.
2. Run `/workflow revise audit-base add final verification`.
3. Approve the generated revision.
4. List saved workflows.

**Expected Results**:
- [ ] A new saved capsule is created.
- [ ] Original `audit-base` remains unchanged and runnable.
- [ ] The new capsule records revision provenance.
- [ ] Historical run graphs are not mutated.

### TC-007: Revise with `--replace` moves the saved name safely

**Priority**: High  
**Type**: Positive / Regression

**Steps**:
1. Save a generated workflow as `audit-base`.
2. Run `/workflow revise --replace audit-base add final verification`.
3. Approve the generated revision.
4. Inspect `.kodax/workflows/audit-base.workflow.json`.
5. Inspect `.kodax/workflows/.revisions/audit-base/`.
6. Rerun `/workflow audit-base`.

**Expected Results**:
- [ ] The saved workflow name `audit-base` now points to the revised capsule.
- [ ] The previous capsule is archived under `.revisions/audit-base/`.
- [ ] The revised capsule manifest name remains `audit-base`.
- [ ] Provenance records `revisionOf` and `replacesWorkflowName`.
- [ ] Rerun uses the revised capsule, not the archived one.

### TC-008: Retention protects active workflow runs

**Priority**: Medium  
**Type**: Negative / Safety

**Steps**:
1. Create several completed workflow runs and one running or paused run.
2. Run prune dry-run with a low keep count.
3. Run prune for real.
4. List runs again.

**Expected Results**:
- [ ] Dry-run reports candidates without deleting.
- [ ] Real prune deletes only terminal candidate runs.
- [ ] Running and paused runs are protected.
- [ ] SDK/REPL retention result explains deleted and protected counts.

## Summary

| Case Count | Passed | Failed | Blocked |
|---:|---:|---:|---:|
| 8 | TBD | TBD | TBD |

**Conclusion**: TBD

