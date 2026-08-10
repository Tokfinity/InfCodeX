# Issue 287 — v0.7.85 Regression Guide

> Scope: terminal Run startup must not replay complete event journals when the
> persisted terminal status is already authoritative and no interrupt input is
> queued.

## Automated regression

From the repository root:

```bash
npx vitest run src/sdk-runtime.test.ts -t "migrates run statuses once and bounds later startup reads to the durable index"
```

Expected result: the test passes, startup reads the bounded status index, and
the seeded terminal `events.jsonl` is not opened. Runs with queued interrupt
input remain on the durable reconciliation path.

## Manual smoke

1. Prepare a KodaX home containing many completed Runs with large
   `events.jsonl` histories.
2. Start `kodax` against that home and confirm the first prompt appears without
   a full replay delay.
3. Confirm `kodax sessions` and `kodax runs` still list the terminal Runs and
   that a Run with queued interrupt input still reconciles its delivery.

Record the home layout, Run count, event-journal size, startup time, and any
warning emitted during recovery.
