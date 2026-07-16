# FEATURE_229 v0.7.50 - Human Test Guide

## Overview

**Feature**: Workflow Process Events + SDK/System Progress Surface  
**Version**: v0.7.50  
**Tester**: Codex automated release validation
**Date**: 2026-06-17

FEATURE_229 turns workflow progress into a shared agent-layer process contract.
REPL, SDK hosts, and future Space-style surfaces should consume the same
workflow snapshots, lifecycle controls, identity resolver, and retention
results without parsing terminal text.

## Environment

- Node.js >= 20
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
- [ ] Tool callbacks, including progress updates, include workflow correlation metadata for child-agent work.
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
5. Attempt `/workflow delete <running-or-paused-runId>`.
6. For a confirmed stale non-terminal record, attempt `/workflow delete --force <runId>`.

**Expected Results**:
- [ ] Dry-run reports candidates without deleting.
- [ ] Real prune deletes only terminal candidate runs.
- [ ] Running and paused runs are protected.
- [ ] `/workflow delete` refuses active non-terminal runs and leaves the run directory intact.
- [ ] `/workflow delete --force` removes a stale non-terminal persisted record only after explicit operator intent.
- [ ] SDK/REPL retention result explains deleted and protected counts, including active protected runs.

### TC-009: Workflow child activity stays in the live surface

**Priority**: High
**Type**: UX / Regression

**Steps**:
1. Start an AMAW or explicit workflow that launches at least one child agent.
2. Watch live output while the child runs tools and emits thinking/text.
3. Let the workflow finish and inspect the scrollback/session history.

**Expected Results**:
- [ ] Workflow live progress remains visible and shows active child-agent status.
- [ ] Child text/thinking/tool/progress callbacks are attributable through workflow correlation metadata.
- [ ] Child runs do not inherit unscoped parent lifecycle callbacks such as compaction/retry history or parent iteration start.
- [ ] Raw child thinking/tool chatter does not become ordinary assistant history.
- [ ] The durable history contains the workflow launch/progress summary, child final digest or fallback notice, and final synthesis.
- [ ] Async digest pending completions are not rendered as final "extracted summary" messages; the final child summary appears when `agent_summary_updated` arrives.
- [ ] Async digest is allowed a longer best-effort window than the old blocking digest path; a child should remain completed while its digest is still pending.
- [ ] If async digest fails or times out, `agent_summary_updated` still carries a bounded fallback summary and the transcript labels it as smart-summary-unavailable/local excerpt instead of dropping the child completion report.

### TC-010: Normal child activity coexists with TodoList

**Priority**: High
**Type**: UX / SDK Boundary

**Steps**:
1. Run a normal non-workflow task that creates a TodoList and dispatches at least one `dispatch_child_task` child.
2. Observe the live area while the main agent plan and child activity are both active.
3. Repeat in a narrow terminal height.
4. In an SDK harness, attach `KodaXEvents` callbacks and record child tool/progress metadata.

**Expected Results**:
- [ ] The TodoList remains the main work-plan surface and is not replaced by child-agent telemetry.
- [ ] Child-agent activity renders as a bounded live-only surface under the plan or active dispatch tool.
- [ ] Narrow viewports collapse child activity to a compact summary instead of pushing the prompt/status bar off-screen.
- [ ] SDK consumers can distinguish workflow-correlated child events and normal child activity from main-agent events.
- [ ] JSONL/SDK iteration-end telemetry preserves `scope:'worker'` for child/worker turns instead of overwriting parent context state.
- [ ] Raw child telemetry is not appended to the normal conversation by default.

### TC-011: Generated harness errors are caught before launch

**Priority**: High
**Type**: UX / Regression

**Steps**:
1. Generate a workflow whose source would otherwise fail at startup, for example
   a multi-line prompt in an ordinary string or a `wf.runAgent` call missing
   `prompt`.
2. Repeat with a saved `.workflow.json` capsule whose source is syntactically
   invalid or does not define `async function run(wf, args)`.
3. Start or preflight the workflow through REPL and SDK paths.

**Expected Results**:
- [ ] Generated-source syntax and restricted-runner contract errors enter the
  generator validation/repair loop before a run id is launched.
- [ ] Early harness/API-shape failures are caught by safe smoke validation and
  repaired or reported as builder failures.
- [ ] Capsule preflight reports invalid source as `workflow:source` before user
  approval.
- [ ] If a harness still fails before any child agent is spawned, the UI labels
  it as a workflow harness/capsule failure rather than a child-agent task
  failure.
- [ ] `/workflow rerun <runId>` messaging makes clear that rerun repeats the
  saved script snapshot and does not regenerate a broken harness.

## Summary

| Scope | Passed | Failed | Notes |
|---|---:|---:|---|
| Automated release gate | 5 | 0 | `npm run build`, `npm test`, `npm test -- --coverage`, `npm pack --dry-run`, `git diff --check` |
| Manual host/provider checklist | - | - | The 11 cases above remain the optional provider-backed human QA checklist and were not re-run interactively in this pass. |

### Automated Release Gate

| Check | Result | Notes |
|---|---|---|
| `npm run build` | Passed | Build, bundle, and DTS generation completed. |
| `npm test` | Passed | Default full Vitest suite passed. |
| `npm test -- --coverage` | Passed | Coverage mode now caps Vitest workers at 4 on Windows to avoid worker RPC starvation under V8 coverage load. |
| `npm pack --dry-run` | Passed | Produced `kodax-ai-kodax-0.7.50.tgz`; `@kodax-ai/kodax@0.7.50`, 1.9 MB package size, 92 files. |
| `git diff --check` | Passed | No whitespace errors; Git reported line-ending normalization warnings only. |

**Conclusion**: Automated release validation passed on 2026-06-17 and `v0.7.50` shipped the same day (npm `latest` + git tag `v0.7.50` + GitHub Release with five-platform binaries).
