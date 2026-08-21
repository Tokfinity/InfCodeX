# Runtime daemon recovery regression guide — v0.7.95

> Status: source candidate; not part of published v0.7.94
>
> Scope: KodaX SDK and daemon only. Product-specific host UI documentation is
> outside this guide.

## Automated gates

1. Run the SDK terminal-settlement regressions. Verify a failed event append
   does not replace a durable terminal, and total terminal persistence failure
   returns `unknown` / `run_settlement_not_persisted` without leaving
   `handle.result` pending.
2. Run sandbox and managed-child lifecycle regressions. Inject termination and
   process-tree drain failures; confirm every rejection is observed and the
   diagnostic/fail-closed evidence remains available.
3. Run daemon transport regressions. Confirm pending requests and lifecycle
   subscribers receive matching disconnect code, `connectionId`, and
   `reconnectable`; confirm malformed inbound and oversized outbound frames are
   distinguished.
4. Run credential failure tests. Confirm `failureKind` is one of the public
   bounded categories and raw provider error text is not persisted.

## Embedder recovery acceptance

1. Start one Run and record the returned `runId`.
2. Drop the transport after admission but before `handle.result` settles.
3. Attach a replacement Runtime and call `runs.get(runId)` followed by
   `runs.await(runId)`.
4. Confirm the original terminal is returned and `runs.start()` was called
   exactly once.
5. Repeat with a second disconnect during `runs.get()` or `runs.await()`.
6. Repeat with one transient daemon-health initialization failure, then a
   successful replacement.
7. Repeat with a permanent replacement initialization error and with explicit
   host close. Both must settle the waiting result promptly; no timer or waiter
   may remain.

## Documentation drift gate

Query `kodax_manual` for `sdk` and `troubleshooting`. Confirm it reports
`run_settlement_not_persisted`, `RuntimeDaemonDisconnectCode`, bounded
`failureKind`, exact-`runId` `runs.get()` / `runs.await()` recovery, and the
rule that an admitted Run is never restarted.
