# FEATURE_234 v0.7.51 - Human Test Guide

## Overview

**Feature**: Workflow Run Host Attribution (`hostMetadata`)
**Version**: v0.7.51
**Tester**: Release validation owner
**Date**: 2026-06-17

FEATURE_234 adds an opaque host-owned `hostMetadata?: Record<string, string>`
field to workflow run process metadata. The field is stamped at workflow start,
persisted in `run.json`, and echoed through live and restored
`WorkflowProcessSnapshot` values. KodaX stores and returns the map; it does not
interpret session ids, tags, or surface names.

## Environment

- Repository built with `npm run build`
- A scratch project or disposable workflow run directory
- Optional SDK host sample using `@kodax-ai/kodax/coding`

## Automated Gate

Run the focused regression suites:

```powershell
npx vitest run `
  packages/agent/src/workflow/process.test.ts `
  packages/coding/src/workflows/run-graph.test.ts `
  packages/coding/src/workflows/workflow-runner.test.ts `
  packages/coding/src/workflows/run-manager.test.ts `
  packages/coding/src/workflows/lifecycle-controller.test.ts `
  packages/repl/src/commands/workflow-command-builder.test.ts

npm run build
```

Expected:

- [ ] All focused tests pass.
- [ ] Build succeeds, including bundled `.d.ts` output.
- [ ] `dist/sdk-agent.d.ts` exposes `WorkflowProcessSnapshot.hostMetadata`.
- [ ] `dist/sdk-coding.d.ts` exposes `WorkflowRunProcessMetadata` with
      `hostMetadata`.

## Test Cases

### TC-001: Live snapshot echoes stamped host metadata

**Priority**: High
**Type**: Positive

**Steps**:
1. Start a workflow through `createWorkflowRunManager().startFromOptions()`.
2. Pass `processMetadata.hostMetadata`, for example:
   `{ sessionId: 'session-1', tag: 'coder' }`.
3. Subscribe with `subscribeWorkflowProcess()`.
4. Observe the first `workflow_started` event and at least one update event.

**Expected Results**:
- [ ] `event.snapshot.hostMetadata` equals the stamped string map.
- [ ] Mutating the returned snapshot object does not mutate future snapshots.
- [ ] Existing fields such as `source`, `sourceRunId`, and `displayName` keep
      their old values.

### TC-002: Persisted run restores host metadata after restart

**Priority**: High
**Type**: Positive

**Steps**:
1. Complete or stop a workflow run with stamped `hostMetadata`.
2. Inspect the run directory's `run.json`.
3. Create a fresh lifecycle controller pointed at the same run directory.
4. Call `getWorkflowProcessSnapshot(runId)` and
   `listWorkflowProcessSnapshots()`.

**Expected Results**:
- [ ] `run.json.processMetadata.hostMetadata` contains the stamped string map.
- [ ] Restored snapshots include the same map after the controller is recreated.
- [ ] `listWorkflowProcessSnapshots()` can be used by a host to attach the run
      back to the original session or surface without an external side table.

### TC-003: Unstamped and old runs stay compatible

**Priority**: High
**Type**: Compatibility

**Steps**:
1. Load a pre-v0.7.51 run or create a run with no `hostMetadata`.
2. Call `getWorkflowProcessSnapshot(runId)`.
3. Call `listWorkflowProcessSnapshots()`.

**Expected Results**:
- [ ] The run loads successfully.
- [ ] Snapshot `hostMetadata` is `undefined`.
- [ ] No fallback owner is inferred from `source`, saved workflow name, or
      session transcript text.

### TC-004: Malformed metadata is normalized defensively

**Priority**: Medium
**Type**: Negative / Compatibility

**Steps**:
1. Edit a disposable `run.json` so `hostMetadata` includes non-string values,
   more than 16 keys, very long keys, and very long values.
2. Load the run through the lifecycle controller.

**Expected Results**:
- [ ] Non-string values are dropped.
- [ ] Only the first 16 string entries are kept.
- [ ] Keys are truncated to 64 characters and values to 512 characters.
- [ ] An empty normalized map becomes `undefined`.
- [ ] Loading malformed metadata does not throw.

### TC-005: REPL command builder can stamp host metadata

**Priority**: Medium
**Type**: SDK / REPL integration

**Steps**:
1. Build workflow process metadata through the REPL command builder with
   `hostMetadata`.
2. Start a generated or saved workflow using that metadata.
3. Observe the corresponding snapshot.

**Expected Results**:
- [ ] The builder returns a defensive copy of `hostMetadata`.
- [ ] REPL-started workflows can carry the same attribution field as SDK runs.
- [ ] Deleting, showing, rerunning, or renaming workflows does not remove
      host attribution from existing persisted runs.
