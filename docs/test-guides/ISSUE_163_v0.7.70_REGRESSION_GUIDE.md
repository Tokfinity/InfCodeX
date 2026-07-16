# ISSUE 163 v0.7.70 A2A Boundary Regression Guide

## Scope

Verify A2A endpoint trust, concrete read and child-execution ceilings, original-
run input continuation, bounded task lifecycle, A2A 1.0 stream correlation, and
the explicit artifact-publication boundary added in v0.7.70.

## Automated baseline

```bash
npx vitest run src/a2a/a2a.test.ts src/a2a/product.test.ts \
  src/a2a/runtime-config.test.ts src/a2a/safe-fetch.test.ts \
  src/a2a/task-store.test.ts src/runtime-agent-binding.test.ts
npx vitest run packages/agent/src/session-lineage/compaction/file-tracker.test.ts \
  packages/coding/src/child-executor.test.ts \
  packages/coding/src/tools/grep.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: all tests pass and TypeScript reports no error.

## Trust and protocol acceptance

1. Discover a Card whose selected interface changes origin. Discovery must fail
   before credential resolution. A same-origin interface is accepted only when
   it also satisfies the configured transport policy.
2. Configure a `credentialRef` against a Card with and without the A2A 1.0
   Bearer declaration. Only the advertised Bearer case may resolve/send it.
3. Subscribe through authenticated SSE. Reject mismatched JSON-RPC IDs,
   versions, task IDs, or context IDs. If the stream ends normally before a
   terminal event, confirm bounded polling reaches the same task.
4. Stream multiple `artifactUpdate` chunks with `append=true`. Confirm the final
   artifact contains all chunks in order and no later chunk overwrites an
   earlier one.

## Runtime and storage acceptance

1. Put a task into `INPUT_REQUIRED`, supply input, and confirm the pending
   interaction on the original Runtime run is resumed; no second run starts.
2. Exercise history length, list filters, and the opaque task cursor. Reject
   invalid values; insert/delete records between pages and confirm the cursor
   does not duplicate or skip the stable continuation set.
3. Exceed per-principal retention with a mix of working and terminal tasks.
   Only the oldest terminal records may be pruned. Terminal subscriptions and
   failed starts must release their owned resources.
4. Run `read`, `grep`, and `glob` over a tree containing an unauthorized concrete
   file or symlink. Each enumerated file must be checked. A child run must not
   gain read, tool, Skill, or Skill-script authority beyond its parent.

## Artifact acceptance

1. Return a direct remote Message file Part and an authorized remote task
   artifact. Confirm both become bounded artifact references without leaking a
   credential or local path.
2. Produce one file through the context output broker and one declared output
   from a successfully admitted isolated Skill script. Confirm both are
   published only after regular-file, real-workspace, size, and output-mode
   checks.
3. Declare the same Skill output but fail the script, then create another file
   with ordinary `write`/`edit` outside `.kodax-a2a-staging`. Neither file may be
   published implicitly. A disappearing staged file must not change an already
   successful task into failure.

Expected: protocol state remains correlated and bounded, continuation preserves
run identity, task cleanup does not abandon live work, and only explicitly
admitted bytes cross the A2A artifact boundary.
