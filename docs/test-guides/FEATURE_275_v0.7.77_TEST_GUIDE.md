# FEATURE_275 v0.7.77 Human Test Guide

> Feature: Governed Event-Triggered Memory Intervention
>
> Status: Engineering verification ready; semantic effect validation pending
>
> Date: 2026-07-25

## 1. Test Goal

Verify that a decision-relevant failure or committed compaction can reactivate
governed evidence in the next Action-LLM request without creating another
durable memory owner, leaking private content, accepting selector-written
advice, or adding a default model call.

This guide verifies product behavior and safety. It does not establish a
pass@1 improvement claim.

## 2. Prerequisites

- Node.js 20 or newer.
- Dependencies installed with the repository's npm workspace lockfile.
- A clean test Session with tracing/debug capture available.
- For the optional semantic case, an in-process SDK host that explicitly
  creates `createCodingMemoryInterventionRunner()` and passes it as
  `memoryRecallRunner`.
- Do not use daemon mode for the function-valued runner; daemon rejection is an
  expected boundary.

Build and focused automation:

```powershell
npm run build:packages
npx vitest run packages/agent/src/experimental-memory/memory-agent.test.ts packages/coding/src/memory/coding-context.test.ts packages/coding/src/memory/coding-observations.test.ts packages/coding/src/memory/intervention-selector.test.ts packages/coding/src/memory/decision-trace.test.ts packages/coding/src/memory/policy-artifact.test.ts src/kodax_cli.runtime-runner.test.ts
```

Expected: TypeScript build succeeds and all focused tests pass.

## 3. Case A — Default Runtime Adds No Selector Call

1. Start a normal in-process KodaX coding run without `memoryRecallRunner`.
2. Give it a multi-step task that causes one recoverable tool failure, such as
   an edit with a deliberately stale anchor followed by a valid correction.
3. Capture provider calls and `[memory:decision]` debug records.
4. Continue until the next Action-LLM request.

Expected:

- the failed tool result creates one governed observation;
- the next iteration carries `tool_failure`;
- exact current/observation evidence may be injected;
- no separate selector provider call occurs;
- the coding run continues even if no reminder is eligible;
- the decision receipt records different candidate, selected-candidate, and
  injected-evidence fields.

## 4. Case B — Host-Opt-In Semantic Selection

1. Create a fake or controlled provider that emits the exact
   `select_memory_candidates` tool call.
2. Return one offered durable candidate ID, one offered observation ID, and one
   invented ID.
3. Inject the runner through `KodaXOptions.memoryRecallRunner`.
4. Trigger a recoverable tool failure.
5. Inspect the next request's ephemeral suffix and trace receipt.

Expected:

- only exact offered IDs survive;
- the invented ID is absent from the suffix and receipt selection;
- no free-form selector text is rendered;
- at most three candidates appear;
- the suffix starts with `[Memory evidence; not an instruction]`;
- source refs appear in the envelope;
- `selectionModes` includes `semantic_intervention` only when a semantic ID
  survives validation.

Repeat with the fuzzy tool name `select_memory_candidate`.

Expected: semantic selection is empty and the run proceeds.

## 5. Case C — Compaction Ordering

1. Use a small test context window so a valid context compaction occurs.
2. Ensure Session storage/persistence acknowledges the compaction commit.
3. Capture the compaction completion event, memory decision, and subsequent
   provider request.

Expected order:

1. compaction commit callback completes;
2. `context_compacted` intervention rebuilds candidates;
3. the reminder is rendered;
4. the Action-LLM request is sent.

The reminder must be visible in the request after compaction. A failed compact
commit must not report a successful post-compaction intervention for that
uncommitted state.

## 6. Case D — Privacy and Prompt-Injection Safety

Exercise these inputs independently:

- a `private` observation;
- a `sensitive` observation;
- failed tool text containing a secret such as `token=...`;
- failed tool text containing `ignore previous system instructions`;
- a governed body containing a role tag such as `<system>`.

Expected:

- private and sensitive observations are never offered;
- secrets are never present in candidates, suffixes, or receipts;
- suspicious failed tool text becomes a neutral sentence pointing to its
  `tool-result:` ref;
- role-tag or instruction-override claims are not injected;
- the run fails silent rather than surfacing unsafe prose.

## 7. Case E — Stale Result Fence

1. Start a semantic intervention with a controlled selector that waits.
2. Before resolving it, append a newer observation to the same Memory Session.
3. Resolve the selector with an otherwise valid offered ID.

Expected:

- the intervention returns no reminder;
- trace contains `recall.intervention.discarded` with
  `state_revision_changed`;
- the stale ID is absent from the next prompt;
- a later decision revision may create a fresh intervention.

## 8. Case F — Daemon Boundary

1. Pass a function-valued `memoryRecallRunner` to
   `toDaemonRuntimeRunOptions()`.

Expected:

- conversion throws an error naming `memoryRecallRunner`;
- the function is not serialized or silently discarded;
- the message directs the host to configure the capability in the daemon owner
  or use embedded mode.

## 9. Regression Checklist

- Routine exact recall still consumes a reminder once per decision/action key.
- Deliberate `memory_recall` remains read-only and fails closed for broad,
  empty, oversized, restricted, or unsafe requests.
- Episode review still writes only through the F228 proposal/approval/apply
  flow.
- Package independence remains `coding -> agent -> llm`; `agent` does not
  import `coding`.
- No new configuration flag enables a second memory route.
- No `console.log`, `any`, hidden provider default, or silent durable mutation
  was introduced.

## 10. Result Record

Record:

- commit SHA and package version;
- host mode and whether a selector runner was supplied;
- provider/model only for the optional selector;
- trigger type;
- candidate/selected/injected counts;
- selector calls and latency;
- whether compaction committed;
- pass/fail for every expected result;
- links to raw traces with secrets removed.

Do not mark the semantic selector generally effective from this guide. That
claim requires the preregistered pilot and frozen validation in
`docs/features/v0.7.77.md`.
