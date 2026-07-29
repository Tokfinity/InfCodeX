# ISSUE 224 v0.7.78 Regression Guide

## Purpose

Verify that one durable Session Actor tree has exactly one live Runtime owner,
that a stale controller physically stops its local executors when ownership is
lost, and that Runtime close or Session deletion releases ownership safely.

## Automated Regression

From the repository root:

```powershell
npx vitest run packages/agent/src/actors/controller.test.ts packages/coding/src/agent-runtime/actor-runtime.test.ts packages/coding/src/tools/agent-collaboration.test.ts packages/repl/src/interactive/storage.test.ts src/sdk-runtime.actors.test.ts
npx vitest run src/sdk-runtime.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/host.test.ts src/runtime-daemon/manager.test.ts src/runtime-daemon/process.test.ts src/runtime-daemon/server.test.ts packages/agent/src/external-agents/executor-plane.test.ts src/a2a/client-executor-auth.test.ts
npx tsc -b tsconfig.build.json --force --pretty false
```

Expected:

- All focused tests pass.
- TypeScript reports no errors.
- Two storage instances attempting the same expected Actor revision produce
  exactly one successful write and one `actor_snapshot_conflict`.

## Manual Dual-Runtime Check

1. Create or load one Session through Runtime A.
2. Call `agents.tree(sessionId)` through Runtime A so it claims the Actor tree.
3. Create Runtime B with the same `homeDir` and profile.
4. Call `agents.tree(sessionId)` through Runtime B.
5. Confirm Runtime B receives:

   - `code: actor_owner_conflict`
   - `retryable: false`
   - Runtime A's `ownerRuntimeId`

6. Confirm Runtime A can still spawn, wait for, and interrupt a child Agent.
7. Attempt `sessions.delete(sessionId)` through Runtime B and confirm it fails
   with `actor_owner_conflict` without deleting the Session.
8. Close Runtime A.
9. Retry `agents.tree(sessionId)` through Runtime B and confirm it succeeds.

## Archive and Active-Run Check

1. Start a root Run and keep its coding promise pending.
2. Confirm archive and delete both fail with `code: conflict`.
3. Confirm the Session remains loadable, then abort the Run.
4. Claim a Session Actor tree through Runtime A.
5. Confirm Runtime B cannot archive or delete it while A is the live owner.
6. With no active root Run or child turn, archive it through Runtime A.
7. Confirm Runtime B can unarchive only after A's archive transaction has
   completed and released the owner from the moved file.
8. While archived, confirm both `runs.start` and `agents.tree` fail with
   `code: session_archived`.
9. Confirm settings updates, notices, rewind, active-entry selection, and
   compaction also fail with `code: session_archived`.
10. Confirm the default Session list excludes it and `includeArchived: true`
   contains exactly one copy.
11. Force the sidecar rename to fail after the main file moves. Confirm the main
    file rolls back; if that rollback also fails, confirm both errors are
    surfaced in an `AggregateError`.

## Admission Race Check

1. Pause the first Session load inside `runs.start`, before the Run record is
   inserted into the Runtime active map.
2. Request archive for the same Session.
3. Confirm archive remains pending while Run admission is paused.
4. Release Run admission.
5. Confirm the Run is registered and archive fails with `code: conflict`.
6. Repeat with `agentMode: "sa"` across two Runtime instances and confirm the
   foreign Runtime receives `actor_owner_conflict`.
7. Pause another Run admission, close the Runtime, and confirm close waits for
   admission to settle before releasing the Actor owner; a restarted Runtime
   must then claim the Session successfully.
8. Call close concurrently and confirm both callers share one pending promise.
   Fail one Actor snapshot write, confirm close rejects, restore storage, retry
   close, and confirm a restarted Runtime can claim the Session.
9. Repeat a transient close failure at the daemon client, Worker facade, hosted
   daemon, host/lease, and executor plane. Confirm concurrent callers observe
   the same attempt and a later call completes the unfinished cleanup phase.

## Stale-Controller Check

Use a controlled Actor store or the controller regression fixture:

1. Start a child turn under owner A and retain its executor `AbortSignal`.
2. Replace the durable snapshot with a later revision owned by owner B.
3. Ask owner A to interrupt the child.
4. Confirm:

   - owner A's physical executor signal is aborted;
   - the call does not report a misleading ordinary revision failure;
   - owner A reloads owner B's revision and terminal turn state;
   - an existing waiter observes the durable terminal event;
   - a newly durable completion is republished to the parent mailbox;
   - a later spawn or follow-up from owner A fails with
     `actor_owner_conflict` without another save attempt.

## Session Deletion Check

1. Create a Session and initialize its Actor tree.
2. Delete the Session through the same Runtime.
3. Close the Runtime.
4. Confirm close succeeds without `Session not found` and no Actor owner is
   retained in the registry.
5. Confirm the delete path first quiesces physical executors while retaining
   the owner, then performs no storage write after the file is removed.
6. Let sidecar staging succeed, then force the authoritative main-file rename
   to fail. Confirm deletion reports
   `session_delete_failed`, the authoritative main snapshot remains, and the
   sidecar has been rolled back before the same Runtime accesses the Actor tree.
7. Close that Runtime and confirm a restarted Runtime can claim the retained
   Session, proving the failed delete did not orphan its owner.

## External Start Cancellation Check

1. Persist an external Agent task, then pause its executor `start()` before it
   returns a reference.
2. Interrupt its Runtime Actor turn and confirm cancellation returns promptly
   with `requested`, while the executor's start `AbortSignal` is aborted.
3. Make an executor ignore the signal and resolve start with a working
   reference. Confirm KodaX sends formal cancellation exactly once without a
   status poll or further mailbox input.
4. Repeat with an executor that rejects after observing abort. Confirm the task
   is durably `unknown` with cancellation `unknown`; KodaX must not claim that a
   reference-less, ambiguously accepted remote task was canceled.
5. Pause executor preflight before durable admission and interrupt the Actor.
   Confirm the caller-facing start settles promptly, no remote start occurs,
   and the physical Actor turn exits without polling an `unknown` task forever.
6. Queue starts A, B, and C for one external Agent. Abort B while A is pending
   and confirm C remains behind A even though B's caller has already settled.
7. Interrupt after the remote reference is durable but before formal
   cancellation. Confirm the signal path and explicit task-cancel path coalesce
   and invoke the remote executor's `cancel()` exactly once.

## Read-Only Preflight Check

1. Create an unowned Session through Runtime A.
2. Persist a positive consecutive-error count and an incomplete final tool call.
   Record the Session file bytes and mtime.
3. Run daemon status preflight through Runtime B.
4. Confirm bytes and mtime are unchanged, then confirm Runtime A can claim the
   Session Actor tree; Runtime B's observation must not persist an owner or run
   automatic Session recovery.

## Recovery-Write and Maintenance Check

1. Trigger ordinary incomplete-tool recovery on an active and an archived
   ownerless terminal Session. Confirm recovery re-reads under the Session lock
   and the archived file remains only in `archived/`.
   Repeat an ordinary full save and island maintenance on the archived Session
   and confirm neither creates an active duplicate.
2. Repeat with a schema-v2 durable owner and with an ownerless non-terminal
   handoff snapshot. Confirm load does not rewrite either Session.
3. Call raw storage archive, unarchive, delete, and retention cleanup against a
   live owner. Confirm all paths preserve the authoritative file; only the
   matching Runtime-owned variants may move or delete it.
4. Force unmatched-turn recovery to fail after a new owner claim. Confirm the
   claim is released, then retry the same controller instance and confirm
   recovery succeeds.
5. Load a stale full Session snapshot, advance its Actor snapshot through the
   CAS API, then save the stale full snapshot. Confirm the newer Actor revision
   and owner remain unchanged.
6. Fail both the unmatched-turn recovery write and its first owner-release
   write. Confirm Runtime cleanup retries with the same owner token and removes
   the fence before a later Runtime attempts to claim the Session.

## Cross-Process Append and Delete Atomicity Check

1. Load one Session through two independent `FileSessionStorage` instances.
2. Extend each stale lineage with a distinct message and append concurrently.
3. Reload full lineage and confirm each new entry exists exactly once.
4. Repeat with different same-length lineage rewrites and confirm identity-based
   merge keeps both valid branches and parent links.
5. Archive the Session through one storage instance, then append and run raw
   active-entry/rewind/label mutations through a stale instance. Confirm every
   write stays on the archived path and no active duplicate appears.
6. Create an island sidecar, stage it for deletion, and fail main-file staging.
7. Confirm both canonical files are restored and no failed API result has lost
   compacted history.

## Owner Liveness Probe Check

1. Persist a schema-v2 owner for a live Runtime.
2. Make the PID probe fail with `EPERM`, `EACCES`, or an unknown/transient
   error and confirm takeover fails with `actor_owner_conflict`.
3. Make the probe fail with `ESRCH` and confirm dead-owner takeover is allowed.

## Crash-Recovery Check

1. Persist a schema-v2 Actor snapshot with a running turn and an owner PID that
   is no longer alive.
2. Initialize a new owner-aware controller.
3. Confirm it claims ownership by CAS before recovering the unmatched turn.
4. Confirm the turn becomes `interrupted` with
   `runtime_recovered_without_executor`.

## Upgrade Note

Fully stop pre-v0.7.78 Runtime processes cleanly during upgrade. An
owner-aware v0.7.78 Runtime must reject a schema-v1 snapshot that still has
non-terminal turns with `actor_owner_unknown`; it cannot prove whether those
turns belong to an older live process. A terminal schema-v1 snapshot upgrades
to schema v2 automatically.
