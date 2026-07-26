# FEATURE_274 v0.7.77 Human Test Guide

## Scope

Verify that adaptive AMA collaboration remains optional, attributable, and
evidence-driven; that `PatternTrace` is factual rather than a quality receipt;
and that the existing Sidecar remains the sole terminal-answer judge.

## Preconditions

1. Build the repository with `npm run build`.
2. Ensure the Git CLI is available on `PATH`; Actor/worktree regression tests
   invoke it directly.
3. Run the focused F274 tests under `packages/coding/src/orchestration/`,
   `packages/agent/src/actors/controller.test.ts`,
   `packages/coding/src/task-engine/runner-driven.test.ts`,
   `packages/coding/src/tools/agent-collaboration.test.ts`,
   `packages/coding/src/agent-runtime/actor-runtime.test.ts`,
   `packages/coding/src/child-executor.test.ts`, the Sidecar verifier tests,
   and `benchmark/datasets/feature-274/experiment-contract.test.ts`.
4. Use a disposable session. Do not enable paid benchmark generation unless
   the exact pre-call freeze is recorded and the owner separately authorizes
   external model calls.

Focused automation:

```powershell
npx vitest run packages/agent/src/actors/controller.test.ts packages/coding/src/orchestration packages/coding/src/agent-runtime/actor-runtime.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-005-events-complete.contract.test.ts packages/coding/src/agent-runtime/middleware/sidecar-verifier packages/coding/src/agents/worker-role-prompt.test.ts packages/coding/src/task-engine/runner-driven.test.ts packages/coding/src/task-engine/runner-sidecar-verifier-adapter.test.ts packages/coding/src/tools/agent-collaboration.test.ts packages/coding/src/tools/run-workflow-pattern-teaching.test.ts packages/coding/src/child-executor.test.ts benchmark/datasets/feature-274/experiment-contract.test.ts
```

## Checks

### Simple task

Ask for one narrow edit and focused test. Confirm no Agent or Workflow starts
solely to produce strategy telemetry.

### Attributable stage

Start two bounded coverage lanes with the same `stageId`, pattern, and relation.
Confirm their exact Actor Turn references appear in the reconstructed trace.
Attempt to switch a running Actor to a different stage and confirm delivery is
rejected before its mailbox changes.

### Adversarial target

Challenge a completed exact `agent-turn:<path>#turn=<id>` target. Confirm a
running target and a legacy latest-only `agent:<path>` target are rejected for
new adversarial strategy metadata.

### Structured result

Run a filter, judge, or challenger that returns the fixed disposition envelope.
Confirm valid data is stored on the exact Turn. Return invalid prose and confirm
the trace degrades without a hidden repair model call.

### Restart and truncation

Persist the Actor snapshot, restart, and compare serialized `PatternTrace`
bytes. Create enough declared refs to exceed the bounded projection and confirm
`contextProjectionOmitted=true` plus the top-level omitted stage count.

### Sidecar boundary

Use a trivial greeting and confirm the existing gate skips without rebuilding
the trace. Use substantial work and confirm the fired Sidecar receives bounded
quality signals and trace facts. Confirm it may recommend one focused pattern
but neither starts Agents nor treats stage completion as correctness.

## Expected Result

All Runtime checks remain structural and provenance-based. Root owns synthesis,
the Sidecar owns terminal judgment, old sessions receive no fabricated trace,
and optional/unsupported paths degrade honestly.
