# Issue 291 — v0.7.86 Inline Owner Crash Recovery Regression Guide

> Release: `v0.7.86`

## Automated gates

1. Run `npx vitest run src/runtime-daemon/state.test.ts`.
2. Run `npx vitest run src/sdk-runtime.shared-daemon.test.ts`.
3. Run `npm run build:packages`.

The tests must prove that dead inline owners and PID-reused inline records are
recovered atomically, while live, daemon-kind, malformed, and unverifiable
owners remain untouched. They must also prove a failed inline close can be
retried after owner-policy coordination clears.

## Manual macOS regression

1. Select Embedded mode and confirm the `coder` profile owns an inline fence.
2. Terminate the owning process without running normal close.
3. Start a daemon-mode client for the same home/profile.
4. Confirm startup restores daemon policy without deleting `~/.kodax`, and
   existing sessions and configuration remain available.
5. Repeat while the inline process is still alive; daemon enable must fail and
   must not modify the owner fence or policy.

Do not test recovery by deleting `~/.kodax`; that removes unrelated user data
and bypasses the owner protocol under test.
