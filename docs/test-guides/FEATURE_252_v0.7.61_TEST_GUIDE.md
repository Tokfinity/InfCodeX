# FEATURE_252_v0.7.61 Test Guide

## Scope

FEATURE_252 is narrowed to deterministic workflow contract preflight only.
It must not emit model-visible quality warnings for review/verifier shape,
generic prompts, generic synthesis rubrics, or unused `outputSchema`.

## Automated Baseline

Run from the repository root:

```bash
npm run test -w @kodax-ai/agent -- src/workflow/quality-lint.test.ts src/workflow/script-runner.test.ts src/workflow/run-manager.test.ts
npm run test -w @kodax-ai/coding -- src/workflows/host.test.ts src/tools/run-workflow.test.ts
npm run test -w @kodax-ai/repl -- src/commands/workflow-command-cleanup.test.ts
npm run build
```

## Test Cases

### TC-001: Unawaited workflow command truthiness fails preflight

Steps:
1. Create an inline workflow that assigns `const result = wf.runAgent(...)`
   without `await`.
2. Use `if (result)` or `result && ...`.
3. Start it through `run_workflow`.

Expected:
- The workflow is rejected before the run starts.
- The error mentions that workflow command variables must be awaited before
  boolean checks.
- No workflow run is registered.

### TC-002: Schema top-level field misuse fails preflight

Steps:
1. Create a child with `outputSchema.properties.findings`.
2. Return or map `reviewer.findings`.
3. Repeat with `reviewer.structured.findings`.

Expected:
- `reviewer.findings` is rejected before the run starts.
- The error tells the author to use `reviewer.structured.findings`.
- `reviewer.structured.findings` passes preflight.
- Metadata fields such as `reviewer.limitReached` remain allowed.

### TC-003: Static agent fanout above cap fails preflight

Steps:
1. Set workflow host or manifest `maxAgents` to `2`.
2. Use `wf.parallel([a, b, c])` where each item calls `wf.runAgent`.
3. Repeat with `wf.parallel([1, 2, 3].map(...wf.runAgent...))`.

Expected:
- Both agent fanouts are rejected before the run starts.
- The error mentions `literal fanout` and the maxAgents cap.
- Non-agent literal parallel or pipeline work, such as artifact/string
  transformations, does not count against `maxAgents`.

### TC-004: Review/verifier heuristics do not block or warn

Steps:
1. Start a review/audit workflow with multiple reviewers and direct synthesis.
2. Start a workflow whose manifest declares `adversarial-verification` but whose
   verifier shape is not statically obvious.
3. Start a workflow with verifier logic nested inside `parallel(map(...))`.

Expected:
- The workflows are not blocked by review/verifier shape lint.
- `run_workflow` output does not contain `Workflow quality warning(s)`.
- Host process metadata does not include `workflowQualityWarning*` fields for
  these heuristics.

### TC-005: Generic prompt and unused outputSchema do not warn

Steps:
1. Start a workflow with a child prompt such as `review`.
2. Start a workflow that declares `outputSchema` but only reads `finalText`.

Expected:
- The workflows are not blocked by these heuristics.
- `run_workflow` output does not contain `Workflow quality warning(s)`.
- No model-visible warning asks the Worker to rewrite the workflow.

### TC-006: Workflow live cleanup does not crash on rejected completion

Steps:
1. Run `npm run test -w @kodax-ai/repl -- src/commands/workflow-command-cleanup.test.ts`.
2. Optionally force a managed workflow `done` promise to reject in a local dev
   run.

Expected:
- The process does not emit an unhandled rejection.
- Terminal control returns normally; no raw mouse/control sequences are left at
  the PowerShell prompt.

## Result

Record any deviations here before release.
