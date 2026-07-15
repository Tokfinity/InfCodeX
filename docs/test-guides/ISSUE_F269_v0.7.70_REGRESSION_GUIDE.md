# F269 v0.7.70 Daemon Management Regression Guide

## Scope

This patch verifies logical daemon-client accounting and the public atomic
daemon-to-inline rollback contract, including reverse-bridge draining and
daemon-owned background work. Use two independently spawned Node processes,
not two client objects in one process.

## Automated baseline

```bash
npx tsc --noEmit
npx vitest run src/runtime-daemon/state.test.ts src/runtime-daemon/host.test.ts \
  src/runtime-daemon/client.test.ts src/runtime-daemon/server.test.ts \
  src/runtime-daemon/schema.test.ts src/runtime-daemon/transport.test.ts
npx vitest run src/sdk-runtime.test.ts src/sdk-runtime.external-agents.test.ts
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
8. Leave a Workflow in `running` and `paused` states. Assert preflight exposes
   it in `activeWorkflows`, reports `active_workflows`, and refuses stop. After
   it reaches a terminal state, assert that blocker clears.
9. Leave an External Agent task non-terminal, including an `unknown` recovery
   state. Assert preflight exposes it in `activeAgentTasks`, reports
   `active_agent_tasks`, and refuses stop. Terminal tasks must clear the blocker.
10. Inspect a clean daemon, then create background work before committing the
    inspected rollback. Assert the management revision advances and the stale
    `stopForInline()` returns typed `conflict` without changing owner policy.
11. While rollback draining is active, attempt credential and Host Tool
    register, revoke, supply, and completion requests. Each request must return
    typed `conflict`; no bridge state may change and no credential/result may
    appear in the operation journal or diagnostics.
12. Race a health probe with daemon shutdown or an owner transition so the
    profile token is removed between discovery and read. The probe must observe
    changed/missing state and retry normally; raw `ENOENT` must not escape to
    `connectKodaXRuntime()`.
13. Keep one mutation in flight and request daemon shutdown. Assert the typed
    `conflict` identifies the active method and count. After the mutation
    settles, retry the atomic shutdown request directly and assert it succeeds
    without a separate preflight/stop race.

Expected result: `1 -> 2 -> 1`, no internal-connection inflation, no stale
stop, no background-work abandonment, no reverse-bridge mutation after
draining, actionable in-flight diagnostics, no token-read race, no dual owner,
two daemon-to-inline-to-daemon cycles, and no run or side-effect replay.
