# Issue 256 filesystem-effect slice — v0.7.92 regression guide

This guide covers stale coordinator-ticket, recorded-release, terminal-ordering,
and daemon-exit convergence only. Issue 256's separate lost-ancestor
descendant-closure boundary remains open.

## Automated coverage

1. Run the generic lock tests. Confirm a stale ticket and choosing entry owned
   by the current long-lived PID are reclaimed when they own no exact
   coordinator lock, while an exact active lock remains fenced.
2. Run filesystem-effect queue tests. Confirm the incident shape—stale
   same-PID coordinator ticket plus released same-PID direct owner—admits a new
   shell lease, and that ordinary direct/shell conflicts still fail closed.
3. Run managed Runner and Runtime lifecycle tests. Confirm Session persistence
   completes before managed completion, repo/task maintenance cannot hold the
   terminal Promise, and managed `onComplete` alone cannot terminalize a Run.
4. Run daemon capability-upgrade and orphan-exit tests. Confirm v3/v1 daemons
   are replaced only when management preflight is idle; busy or multi-client
   daemons fail closed with restart guidance.

## Manual incident replay

1. Start one Space-managed daemon and a managed task that performs file
   mutations.
2. Abandon one queued coordinator attempt without releasing its ticket; leave
   the daemon PID alive and ensure that ticket does not own the exact lock.
3. Wait beyond the 30-second stale-proof window, then run a harmless shell
   command and a direct write. Both should acquire through fenced recovery;
   neither should require deleting ProgramData lock files.
4. Repeat while the stale ticket token owns the exact coordinator lock. The new
   command must remain blocked and must not fall back around the fence.
5. Stop the Session. After the canonical terminal result, verify the daemon
   reaches governed idle and exits after the configured orphan grace period.
