# FEATURE_254_v0.7.65 Test Guide

## Scope

FEATURE_254 hardens the embedded runtime into the canonical host lifecycle for
SDK, ACP, and REPL host paths. It does not add a daemon.

## Automated Baseline

Run from the repository root:

```bash
npx vitest run src/sdk-runtime.test.ts src/acp_server.test.ts
npx tsc --noEmit --project tsconfig.json
npm run build
npm pack --dry-run
```

Expected:

- Runtime tests cover queueing, status snapshots, persistent event replay,
  permission broker behavior, and hydrated terminal run status.
- ACP tests prove prompt options still reach the coding layer after ACP routes
  through runtime.
- Type check and build pass.
- The package still includes `@kodax-ai/kodax/runtime`.

## Test Cases

### TC-001: Same-session FIFO

1. Create a runtime and one session.
2. Start two long-running runs in the same session.
3. Inspect `runtime.runs.get()` for both run IDs.

Expected:

- First run is `running`.
- Second run is `queued`.
- The second run starts only after the first reaches a terminal phase.

### TC-002: Multi-session concurrency

1. Create two sessions.
2. Start one run in each session.
3. Subscribe to each session's events.

Expected:

- Both runs can be active at the same time.
- Events do not cross session boundaries.
- Aborting one run does not abort the other.

### TC-003: Persistent replay

1. Create a runtime with a fixed `homeDir`.
2. Start and complete a run.
3. Close the runtime.
4. Create a new runtime with the same `homeDir`.
5. Call `events.replay({ runId })` and `runs.get(runId)`.

Expected:

- Replay returns persisted events including the terminal run event.
- `runs.get(runId)` returns the hydrated terminal status.

### TC-004: Permission broker

1. Start a run that triggers `beforeToolExecute`.
2. Listen for `permission.requested`.
3. Call `runtime.permissions.respond(requestId, { type: 'allow_once' })`.

Expected:

- The tool approval resolves.
- Pending permissions list becomes empty.
- Reusing the same request ID returns `false`.

### TC-005: ACP lifecycle

1. Start an ACP session.
2. Send a prompt.
3. Cancel while a run is active.

Expected:

- ACP prompt starts through runtime.
- Cancel maps to `runtime.runs.abort(runId)`.
- ACP still sends assistant, thinking, tool, and permission protocol updates.

### TC-006: REPL lifecycle

1. Start classic REPL and Ink REPL through the root CLI.
2. Submit a prompt.
3. Stop an active prompt from the UI.

Expected:

- Root CLI injects a runtime-backed managed-task runner.
- REPL package does not import the root runtime.
- UI cancellation reaches runtime-managed task cancellation.

## Regression Checks

- Existing `runKodaX()` and `startKodaX()` SDK paths still work.
- Existing `/session` commands still read and write the same session storage.
- `packages/repl` does not import `@kodax-ai/kodax/runtime` or root `src`.
- No new workspace package is added.
