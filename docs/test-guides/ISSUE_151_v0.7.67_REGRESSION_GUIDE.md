# Issue 151 v0.7.67 Regression Guide

## Scope

Verify that KodaX process-oriented tests clean up their own detached daemon and
long-running fixtures without changing the persistent daemon product contract.

## Automated gate

```powershell
npx vitest run src/sdk-runtime.config.test.ts packages/coding/src/tools/bash.test.ts packages/agent/src/runtime/managed-child-processes.test.ts --maxWorkers=1
```

Expected: all tests pass. Capture Node PIDs before and after the command; the
set difference must be empty after a short process-exit grace period.

## Ownership diagnosis

For a suspicious Node PID, inspect its command line, parent PID, parent process,
and start time. Classify it before cleanup:

- `kodax_cli.ts daemon serve --profile config-*` with a dead parent is a leaked
  KodaX config-test daemon;
- a command containing `child-pid:` with a dead parent is a KodaX background
  fixture;
- `mcp/server.mjs` whose live parent is `codex.exe` belongs to Codex MCP hosting,
  not KodaX;
- a normal user daemon profile remains alive after `runtime.close()` by design.

Never terminate every `node.exe` process by name.

## Test daemon cleanup

1. Create a unique daemon `homeDir + profile` with `autoStartDaemon: true`.
2. Exercise the Runtime config surface.
3. Call `runtime.close()` to detach the test client.
4. Connect to the recorded daemon state with its local token and request
   `runtime.shutdown`.
5. Wait until daemon state disappears, then delete the temporary home.

Expected: no owner process or state/lock file remains. A test failure still
triggers the same cleanup from `afterEach`.

## Abnormal fixture cleanup

1. Start each parent-watched infinite child fixture.
2. Verify normal managed cleanup and abort behavior still pass.
3. In an isolated manual run, terminate the fixture's test parent.

Expected: the child notices the original parent is gone and exits within the
watchdog interval instead of surviving indefinitely.

## User daemon operation

`runtime.close()` only detaches from a shared process daemon. Stop an intended
daemon explicitly:

```powershell
kodax daemon status --profile default --json
kodax daemon stop --profile default --json
```

---

*Feature/Issue ID: ISSUE_151*
