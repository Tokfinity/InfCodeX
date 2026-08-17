# Issue 295 / v0.7.91 Runtime Exit Settlement Regression Guide

## Purpose

Verify that a complete Runtime exit either proves cleanup, autonomously repairs
the exact Windows residue, or remains visibly blocked without destructive
guessing.

## Automated gates

Run:

```text
vitest run src/runtime-daemon/exit-settlement.test.ts
vitest run src/runtime-daemon/state.test.ts src/runtime-daemon/shutdown-verifier.test.ts
vitest run src/sandbox-runtime.test.ts
vitest run src/sdk-runtime-daemon-upgrade.test.ts src/sdk-runtime.shared-daemon.test.ts
vitest run packages/agent/src/runtime/process-tree.test.ts
vitest run src/kodax_cli.interactive-exit.test.ts
```

Required assertions:

1. Active work returns `blocked/keep-open` before a ticket or stop mutation.
2. A clean exit requires the exact durable success outcome.
3. Windows escalation uses the exact daemon process-start identity, waits for
   the Job supervisor to exit, and never kills a bare supervisor PID.
4. PID reuse, missing identity, foreign/corrupt markers, and active containment
   remain blocked with the ticket and markers preserved.
5. ACL recovery never uses `--force`, never uninstalls WFP, and clears only
   exact primary/legacy marker files after the `recovered` phase is durable.
6. A crash at every ticket phase is retryable and terminal retries are
   idempotent.
7. macOS/Linux stuck-daemon paths send no cached PID/PGID signal.
8. A memory-review drain that exceeds the generic two-second cleanup phase cap
   but completes within its 15-second contract does not fail daemon shutdown;
   the fixed public settlement deadline also covers the full orderly cleanup
   budget and preserves a Windows Job-drain tail.
9. Public declarations expose neither a caller-controlled settlement timeout
   nor dependency/process/ACL recovery injection seams.
10. Hanging inspect, stop response, and Runtime close phases terminate within
    their SDK budgets; a stop timeout is resumed from the exact durable
    inline-policy transition.
11. Concurrent calls stop an owner once, accepted/recovered ticket phases never
    downgrade, and corrupt lock/state files never produce a false `clean`.
12. A prepared retry uses a fresh control-journal operation ID while preserving
    the stable settlement ticket; a late stop cannot race replacement startup.
13. The fixed 480-second transaction passes bounded remaining budgets to exact
    process-tree, ACL-recovery, and marker-clear phases.

## Windows manual fault injection

1. Start a daemon Runtime under a disposable `configHome` and verify its lock
   records process-start identity, `windows-job`, and supervisor PID.
2. Block Runtime close after stop acceptance while leaving a sandbox
   descendant alive.
3. Call `settleKodaXRuntimeExit`. Verify the exact daemon tree is terminated,
   the supervisor exits only through Job cleanup, matching ACL markers are
   recovered, and the result is `recovered`.
4. Relaunch and call the API without a Runtime object. Verify the pending ticket
   resumes and completes without creating a replacement daemon first.
5. Repeat with a foreign marker and with a reused daemon PID. Verify both remain
   blocked and neither process nor marker is modified.

## Clean-up

Use only the disposable config home. Do not delete machine-global ACL markers
manually during the test; their retention is part of the safety assertion.

## macOS/Linux reboot recovery

1. Under a disposable config home, retain a `stop_accepted` ticket while the
   daemon cannot be proved gone. Verify no cached PID/PGID signal is sent.
2. Reboot the operating system without deleting the ticket, profile, lock, or
   Session data.
3. Launch the host normally. Verify the SDK observes the changed boot identity,
   removes only the exact retained owner/state, restores daemon policy, returns
   `recovered`, and leaves Session history readable.
