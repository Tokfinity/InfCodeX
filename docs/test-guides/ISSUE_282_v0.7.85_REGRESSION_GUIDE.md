# Issue 282 v0.7.85 Regression Guide

## Goal

Verify that a delayed Actor snapshot cannot leave a root Run executing for
minutes, reject all new input, or misreport a same-runtime durability fence as
foreign ownership.

## Automated gates

Run from the KodaX repository root:

```powershell
npx vitest run packages/agent/src/actors/controller.test.ts
npx vitest run packages/coding/src/agent-runtime/actor-runtime.test.ts
npx vitest run src/sdk-runtime.test.ts
npx vitest run src/runtime-daemon/server.test.ts src/sdk-runtime-daemon-upgrade.test.ts
```

Required observations:

- Concurrent child progress produces one controller-wide durable batch.
- Known queue wait does not consume the five-second terminal-save deadline.
- A permanently blocked queue head enters durability unknown within its
  separate bounded fence.
- Unknown durability aborts the root executor and all child work.
- A same-owner late save repairs automatically; foreign owner, missing
  snapshot, and permanent write failure remain fail-closed.
- A late-tail timeout is retried with bounded exponential backoff, while a
  foreign-owner reconciliation stops retrying and never attempts takeover.
- Stop arriving before the Actor self-fence still installs durability repair;
  it converges without a second Stop and preserves the Stop failure cause.
- Spawn after self-fence returns `actor_settlement_not_persisted`, not
  `actor_owner_conflict`.
- A query submitted as `after_turn` is accepted once, stays queued, and runs
  only after same-owner repair establishes the logical root fence and the old
  provider Promise has settled. An abort-ignoring provider cannot release the
  Session route while a pre-fence tool or filesystem effect may still be in
  flight; its post-fence callbacks and new effects remain suppressed.
- Healthy after-turn input following a managed task defaults to coding mode;
  managed-mode inheritance occurs only for a successor draining behind the
  durability repair.
- Shared-daemon transport accepts only `after_turn` behind
  `actor_settlement_not_persisted`; `interrupt` and unrelated unknown states
  remain `stale_run`.
- A pre-fence Promise result/failure is retained; post-fence output, memory,
  mid-turn input, plan approval, AskUser, and success callbacks are suppressed
  and cannot override the infrastructure failure.
- An active durable progress waiter rejects immediately when the controller
  self-fences instead of hanging behind the late snapshot write.

## Packaged Windows fault injection

1. Build or install the exact package bytes that advertise
   `actorSettlementConvergence:1`; use an isolated `KODAX_HOME` and a Session
   large enough to exercise real `FileSessionStorage` rewrites.
2. Delay the first child terminal `saveActorSnapshot` beyond five seconds while
   three children have emitted bursts of progress.
3. Confirm that the root is aborted, the Run briefly reports factual unknown,
   and a new after-turn query is accepted without being executed early.
4. Release the delayed save. Confirm automatic same-owner repair, zero active
   non-root turns, one failed prior terminal, and one completed queued Run after
   the old root Promise settles. Repeat with a provider Promise that ignores
   AbortSignal and remains pending; the successor must remain queued until that
   Promise settles.
5. Repeat without releasing the save. Confirm the Run remains unknown and Stop
   remains available; no successor Run starts and no completion is fabricated.
6. Repeat with a genuinely different owner. Confirm the owner conflict remains
   fail-closed and no automatic takeover occurs.

## Pass criteria

All automated gates pass from source and from the packaged Worker/daemon bytes.
No run emits more than one terminal event, no post-fence delta is replayed, and
the Session is reused only after durable Actor convergence.
