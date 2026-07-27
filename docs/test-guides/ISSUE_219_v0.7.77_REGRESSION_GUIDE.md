# Issue 219 v0.7.77 Regression Guide

## Scope

Verify daemon startup does not return a successful health result before the
matching durable owner state reaches `status: "ready"`.

## Deterministic Startup Boundary

1. Supply startup health observers whose first result has a live PID, reachable
   endpoint, matching identity, and `state.status: "starting"`.
2. Return the same owner with `state.status: "ready"` on the next poll.
3. Verify the owned-child path unrefs only after `ready`, the competing-owner
   path terminates only the losing child after the winner reaches `ready`, and
   a pre-existing owner is awaited without spawning or terminating a process.
4. Verify pre-existing-owner timeout and cancellation are bounded, and an
   identity change is rejected.

## Real CLI Smoke

1. Start a daemon under a unique temporary home/profile while its real socket is
   reachable but its internal test fence keeps the durable state at `starting`.
2. Launch a concurrent `kodax daemon start` and
   `connectKodaXRuntime({ autoStart: true })`; verify neither settles early.
3. Release the fence and verify the first start returns healthy/ready, the
   second reports `already_running` with ready state, and the SDK connects to
   that owner with the expected capabilities.
4. Close the SDK connection, stop the daemon, and verify its state is released.

## Commands

```bash
npx vitest run src/runtime-daemon/process.test.ts
npx vitest run src/kodax_cli.daemon-smoke.test.ts \
  -t "does not become ready before initial A2A reconciliation completes"
```
