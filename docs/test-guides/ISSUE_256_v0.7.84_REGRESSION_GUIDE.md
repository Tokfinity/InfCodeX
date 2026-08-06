# Issue 256 daemon-containment regression guide

This guide covers the Windows daemon-owned slice shipped in v0.7.83. The broader Worker
owner-lease work remains open and is still targeted for v0.7.84.

## Automated checks

1. Run `npx vitest run src/runtime-daemon/windows-job-supervisor.test.ts`.
   The target must be assigned before it runs, a detached descendant must be terminated, and the
   supervisor must exit only after the Job is empty.
   Review the assignment-failure path as well: a process that is still suspended when Job
   assignment fails must be terminated before its handles are closed.
2. Run
   `npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "SDK auto-start owns a daemon process outside the embedding process"`.
   The detached bootstrap must keep the PowerShell Job owner and daemon alive after the short-lived
   SDK caller exits.
3. Run `npx vitest run src/runtime-daemon/shutdown-verifier.test.ts`.
   Exact successful and failed durable outcomes must be distinguished, and a live containment
   supervisor must prevent success.
4. Run `npx vitest run packages/agent/src/runtime/managed-child-processes.test.ts`.
   Incomplete current-owner records may be retired only when Job containment is explicit.
5. Run
   `npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "prints JSON for real start/stop commands and releases daemon state"`.
   On Windows, both the original and restarted supervisors must be gone after their respective
   stop boundaries.
6. Run `npx vitest run src/sdk-runtime-daemon-upgrade.test.ts`. Normal auto-start attachment must
   keep a legacy daemon usable for Session recovery, while an explicit shutdown-verification
   requirement must refuse unsafe in-place migration.
7. Run
   `npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "does not report a legacy uncontained daemon as safely stopped"`.
   On Windows, a successful daemon cleanup outcome without Job-containment metadata must remain
   `cleanup_unverified`.
8. Run `npm run build`.

## Manual acceptance

Start a daemon-backed Run that launches several shell, MCP, or language-server descendants. Stop
the daemon, then verify that the CLI does not report success until the daemon and its containment
supervisor are gone. Repeating the scenario must not accumulate process-exit listener warnings or
leave daemon-owned descendants running.

Do not use this result as evidence for Worker-owned child closure; that is outside this slice.
