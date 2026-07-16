# FEATURE 259 v0.7.67 Human Test Guide

## Goal

Verify that Workflow review uses immutable scoped packets, reads each packet
once per ordinary primary, verifies only candidate findings, preserves full
reports, and writes an inspectable efficiency report without changing direct
`/review` behavior.

## Preconditions

- Build the workspace with Node.js 20 or newer.
- Use a disposable Git worktree with at least two changed files in different
  areas, including one intentional review finding.
- Start KodaX in AMA/AMAW mode with Workflow support enabled.
- Do not use confidential content: review packets are local scratch artifacts.

## Case 1: Direct review remains direct

1. Run `/review` with uncommitted changes.
2. Confirm one normal review prompt runs and no Workflow approval/progress UI is shown.
3. Confirm the response cites the bounded diff and no review-packet directory is needed.

Expected: the existing single-reviewer path is unchanged.

## Case 2: Workflow review uses captured packets

1. Run `/review --workflow -- focus on API compatibility`.
2. Approve the built-in Workflow if approval mode asks; confirm no Workflow-generation phase appears.
3. Inspect `.agent/tmp/sessions/<session>/review-packets/<rangeId>/`.
4. Confirm packet names and hashes are stable when the same captured diff is reviewed again.
5. Change one diff byte and rerun; confirm a new `rangeId` directory is created.

Expected: files are partitioned into non-overlapping scope packets; each changed
file appears in exactly one primary packet. No controller prompt contains the
full diff.

## Case 3: Packet-read enforcement and topology

1. Observe Workflow progress for a packet with a planted issue.
2. Confirm one `primary-review` starts for an ordinary packet.
3. With multiple packets, confirm independent packet lanes can overlap rather than waiting serially.
4. Confirm a `verifier` starts only after the primary returns candidate findings.
5. Confirm a clean packet with no findings does not start a verifier.
6. In a developer run, remove one packet/chunk read from a reviewer and confirm
   the task fails with `required review evidence was not read` and contributes
   no accepted verdict.

Expected: review is primary → conditional verifier → final synthesis, not four
broad lens reviewers. A second primary occurs only when an upstream caller
explicitly supplies authoritative `routingRisk: high`; `/review` does not guess it.

## Case 4: Finding disposition fidelity

Use fixtures that produce confirmed, refuted, and unresolved findings.

- Confirmed findings appear in the actionable final report.
- Refuted findings remain in the audit artifact but not the actionable list.
- Unresolved findings remain visibly unresolved and prevent unqualified approval.
- A verifier severity change includes a reason; synthesis does not silently downgrade it.

## Case 5: Digest and full-result preservation

1. Run a KodaX-generated structured child whose valid summary is 1–4 lines.
2. Confirm its presentation digest uses that summary with zero digest tokens.
3. Inspect the task/run graph and confirm `finalText` still contains the full original report.
4. Run a saved/inline third-party workflow with the same `summary` schema.

Expected: the third-party workflow still uses the normal self-distill fallback;
schema shape alone cannot claim trusted digest reuse.

## Case 6: Efficiency report readback

Open the completed workflow's `run.json` and inspect `efficiencyReport`.

Expected fields include total/input/cache-read/output/digest tokens, token
coverage, starts by role/tier, route facts in terminal events, primary and
duplicate packet reads, verifier/synthesis reads, quality outcomes, and wall
clock duration. Missing local usage fails coverage; unavailable external-agent
usage is listed as excluded and is never estimated.

## Automated regression commands

```powershell
npx tsc -b packages/agent/tsconfig.json packages/coding/tsconfig.json packages/repl/tsconfig.json --pretty false
npx vitest run packages/agent/src/workflow/script-runner.test.ts packages/agent/src/workflow/runtime.test.ts packages/coding/src/agents/worker-role-prompt.test.ts packages/coding/src/tools/feature-259-prompt-contract.test.ts packages/coding/src/workflows/review-packet.test.ts packages/coding/src/workflows/scoped-review.test.ts packages/coding/src/workflows/builtin/scoped-review.test.ts packages/coding/src/workflows/cost-report.test.ts packages/coding/src/workflows/agent-adapter.test.ts packages/coding/src/child-executor.test.ts packages/coding/src/workflows/host.test.ts packages/coding/src/workflows/run-graph.test.ts packages/repl/src/commands/review-command.test.ts packages/repl/src/commands/workflow-command.test.ts benchmark/datasets/feature-259/experiment-contract.test.ts
```

## Release limitation

These checks prove deterministic implementation behavior only. FEATURE 259
must remain `InProgress` until its pre-registered Layer-2/Layer-3 external-model
evaluation is explicitly authorized, executed within the $75 hard cap, manually
audited, and all quality/token gates pass.
