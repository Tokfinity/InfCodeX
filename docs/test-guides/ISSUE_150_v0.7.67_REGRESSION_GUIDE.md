# Issue 150 v0.7.67 Regression Guide

## Scope

This guide verifies the rebuilt v0.7.67 external-Agent routing and lifecycle
contract after the initial GitHub release/tag was withdrawn. npm was not
published before the correction.

## Automated gate

Run from the repository root:

```powershell
npx vitest run packages/agent/src/workflow/script-runner.test.ts packages/agent/src/external-agents/executor-plane.test.ts packages/coding/src/tools/external-agent-tools.test.ts packages/coding/src/workflows/builtin/scoped-review.test.ts benchmark/datasets/feature-259/cases.test.ts
npm run build
```

Expected: every test passes and all package/type builds complete.

## TC-001: Restricted-script routing

1. Run a restricted Workflow script whose `wf.runAgent()` input contains
   `phase: "review"` and
   `target: { agentId: "external:reviewer", expectedConfigurationRevision: "v2" }`.
2. Inspect the trusted host callback input.
3. Repeat with a blank `agentId`, then a blank revision.

Expected:

- The valid values are preserved byte-for-byte at the host boundary.
- Invalid values fail before any child dispatch.
- Omitting `target` preserves the existing native Workflow path.

## TC-002: Executor-plane close

1. Start a reference-executor task that remains nonterminal.
2. Call `tasks.wait(taskId)` without a timeout.
3. Close the plane and observe the waiter.
4. Call registration, catalog, preflight, and task methods after close.
5. Call `close()` again.

Expected:

- The pending waiter rejects with `Agent executor plane is closed.`
- Every later service call rejects with the same lifecycle error.
- The second close succeeds without recreating or disposing executors twice.

## TC-003: Review and ledger boundaries

1. Return a malformed object from a built-in scoped-review primary.
2. Complete a native child while forcing `agentTasks.updateLocal()` to reject.
3. Build every Feature 259 baseline variant.

Expected:

- Scoped review reports a schema validation error rather than an opaque
  property-access failure.
- The native child result/error remains authoritative; only a warning
  diagnostic reports the failed ledger mirror.
- Baselines contain no `scopeSummary`, `constraints`, `terseResult`, or malformed
  `schema: true` fragment, and all exact rewrites are frozen by hash.

## Release acceptance

- Full local tests and build pass.
- GitHub branch CI is green on Node.js 20 and 22.
- The five supported release-platform preflights pass.
- The recreated v0.7.67 release assets match `SHA256SUMS.txt`.
- npm remains an explicit operator step.

---

*Feature/Issue ID: ISSUE_150*
