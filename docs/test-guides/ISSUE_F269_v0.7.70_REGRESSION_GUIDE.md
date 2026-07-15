# F269 v0.7.70 Daemon Management Regression Guide

## Scope

This patch verifies logical daemon-client accounting and the public atomic
daemon-to-inline rollback contract. Use two independently spawned Node
processes, not two client objects in one process.

## Automated baseline

```bash
npx tsc --noEmit
npx vitest run src/runtime-daemon/state.test.ts src/runtime-daemon/host.test.ts \
  src/runtime-daemon/client.test.ts src/runtime-daemon/server.test.ts \
  src/runtime-daemon/schema.test.ts src/runtime-daemon/transport.test.ts
npx vitest run src/kodax_cli.daemon-smoke.test.ts \
  -t "counts process-distinct logical clients"
npm run build
```

## Process-distinct acceptance

1. Connect the first `connectKodaXRuntime({ autoStart: true })` facade and
   assert `status.preflight().clientCount === 1` and `canStop === true`.
2. Connect a second process and assert `clientCount === 2`, `blockers` contains
   `connected_clients`, and `canStop === false`.
3. Save `runtime.daemon.inspect()` before the second process connects. Attempt
   `stopForInline()` with that stale state and assert typed `conflict`, a live
   daemon, and unchanged daemon owner policy.
4. Await the second process's `runtime.close()` and poll preflight for a bounded
   interval. Assert the count returns to one. Internal daemon owner sockets,
   CLI status probes, and daemon health probes must not increase the count.
5. Inspect again and commit `stopForInline()` with the exact Runtime,
   management revision, and owner-policy revision. Use
   `getKodaXRuntimeOwnerState()` to verify the daemon fence is released before
   acquiring `acquireKodaXInlineOwner()`.
6. Release inline ownership, call `enableKodaXDaemonOwner()` without an
   expected revision, and reconnect. Repeat the complete rollback/resume cycle
   once more.
7. Close the final facade normally and assert the daemon remains healthy;
   `runtime.close()` remains detach-only.

Expected result: `1 -> 2 -> 1`, no internal-connection inflation, no stale
stop, no dual owner, two daemon-to-inline-to-daemon cycles, and no run or
side-effect replay.
