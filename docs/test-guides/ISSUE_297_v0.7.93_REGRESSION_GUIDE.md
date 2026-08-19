# Issue 297 / v0.7.93 Runtime Exit Fast-Failure Regression Guide

## Automated checks

1. Seed an exact Windows daemon owner and a durable failed shutdown outcome.
   Settlement must not call process-exit waiting with the 170-second orderly
   budget and must use the existing exact process-tree recovery path.
2. Persist the same exact failure after stop acceptance while process-exit
   observation remains pending. Settlement must notice it without waiting for
   the process timeout.
3. Recovery must still require matching process start identity and Windows Job
   containment. Missing, corrupt, foreign, or reused-PID evidence remains
   blocked and must not signal a process. The losing process-exit observation
   must be cancelled before that blocked result returns.
4. A slow daemon with no durable terminal failure retains the full orderly-exit
   budget.
5. POSIX behavior remains unchanged and never signals a cached PID/PGID during
   same-boot recovery.

## Windows manual acceptance

1. Start an idle daemon through Space and request complete exit.
2. Fault-inject a sandbox cleanup failure that writes the exact daemon's durable
   failed shutdown outcome while leaving the daemon alive.
3. Verify settlement enters exact recovery shortly after the outcome is
   durable instead of waiting approximately 170 seconds.
4. Verify the original failed outcome remains available as audit evidence, the
   exact owner/state/ticket are settled, and no daemon, Job wrapper, supervisor,
   or sandbox helper remains.
5. Repeat with a legitimate slow cleanup that produces no failed outcome.
   Settlement must preserve the normal safety window rather than escalating
   early.
