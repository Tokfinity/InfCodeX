# Issue 183 v0.7.72 Regression Guide

## Purpose

Verify that failed or cancelled daemon startup reclaims only the candidate
process, test-worker loss cannot strand test daemons, and healthy shared daemons
remain persistent after ordinary client detach.

## Automated Gate

Run from the repository root:

```powershell
npx vitest run src/runtime-daemon/process.test.ts
npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "shuts down a test-owned daemon|SDK auto-start owns|process-distinct concurrent|prints JSON"
npx vitest run src/sdk-runtime.test.ts -t "Space-style daemon client"
npx tsc --noEmit --pretty false
```

Expected results:

- a cancelled pending startup terminates once and is never unreferenced;
- an explicitly test-owned daemon removes state/lock and exits after its parent;
- closing the creating SDK client leaves a healthy daemon available;
- concurrent starters converge on one owner;
- CLI start, restart, status, logs, and stop remain functional;
- no TypeScript errors are reported.

## Manual Persistence Check

Use a temporary home and profile. Do not target a normal user daemon.

```powershell
$issue183Home = Join-Path $env:TEMP "kodax-issue-183-manual"
$issue183Profile = "issue-183-manual"
New-Item -ItemType Directory -Force -Path $issue183Home | Out-Null

npm run dev -- daemon start --home $issue183Home --profile $issue183Profile --provider mock-provider --timeout-ms 30000 --json
npm run dev -- daemon status --home $issue183Home --profile $issue183Profile --json
npm run dev -- daemon stop --home $issue183Home --profile $issue183Profile --timeout-ms 30000 --json
```

Acceptance criteria:

- start and status report `health: "healthy"` with the same daemon PID;
- the start command itself returns while that PID remains healthy;
- stop reports `health: "missing"` and removes the profile state and lock;
- no unrelated Node process is terminated.

## Residue Audit

After the automated or manual checks, inspect only KodaX daemon command lines:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'kodax_cli\.(ts|js).*daemon.*serve' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

Expected result after explicit test/manual cleanup: no matching process. Never
use a broad `node.exe` kill; Codex, MCP servers, and unrelated applications also
run under Node.

## Non-Goals

- Do not expect `runtime.close()` to stop a healthy shared daemon.
- Do not add or validate a production zero-client idle reaper.
- Do not attribute high CPU to `mock-provider` without a captured CPU profile or
  stack from a live reproduction.
