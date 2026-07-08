# FEATURE_253_v0.7.64 Test Guide

## Scope

FEATURE_253 introduces the embedded KodaX runtime contract exposed from
`@kodax-ai/kodax/runtime`.

This guide verifies that SDK hosts can use one in-process runtime object to
manage sessions, runs, normalized events, permission requests, and workflow
snapshots without adding a daemon, transport server, or fifth workspace
package.

## Automated Baseline

Run from the repository root:

```bash
npx vitest run src/sdk-runtime.test.ts
npx tsc --noEmit --project tsconfig.json
npm run build:bundle
npm run build:dts
```

Expected:

- All four commands pass.
- `dist/sdk-runtime.js` and `dist/sdk-runtime.d.ts` are generated.
- `package.json` exports `./runtime`.
- `dist/sdk-runtime.d.ts` does not expose unresolved internal workspace paths
  that would make the SDK subpath unusable for consumers.

Run the compatibility set before release:

```bash
npx vitest run packages/coding/src/running-session.test.ts src/sdk-session.test.ts packages/repl/src/session/public-api.test.ts tests/tracker-consistency.test.ts
npx vitest run tests/kodax_core.test.ts packages/coding/src/agent.provider-policy.test.ts packages/coding/src/agent.stop-reason.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-003-events-session-start.contract.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-005-events-complete.contract.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-006-events-error.contract.test.ts
npm run build
node --input-type=module -e "const m = await import('@kodax-ai/kodax/runtime'); console.log(typeof m.createKodaXRuntime);"
npm pack --dry-run
```

Expected:

- Existing `startKodaX()` and selected `runKodaX()` tests pass unchanged.
- Full build emits `dist/sdk-runtime.js` and `dist/sdk-runtime.d.ts`.
- The self-reference import prints `function`.
- The dry-run tarball includes the runtime JS and declaration files.

## Test Cases

### TC-001: Runtime subpath imports

Steps:

1. Build bundle and declarations with the automated baseline above.
2. In a local consumer script, import:

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';
```

3. Create a runtime with a temporary session directory:

```ts
const runtime = await createKodaXRuntime({
  sessionsDir: '<temporary-dir>',
  defaultProvider: '<configured-provider>',
});
await runtime.close();
```

Expected:

- The import resolves from the public package subpath.
- `createKodaXRuntime()` returns an object with `identity`, `sessions`,
  `runs`, `events`, `permissions`, `workflows`, and `close`.
- `identity.mode` is `embedded`.

### TC-002: Session lifecycle through runtime

Steps:

1. Create a runtime with a temporary `sessionsDir`.
2. Call `runtime.sessions.create({ title, projectPath, surface, profileId })`.
3. Call `runtime.sessions.list({ limit: 10 })`.
4. Call `runtime.sessions.load(session.id)`.
5. Call `runtime.sessions.transcript(session.id)`.
6. Call `runtime.sessions.fork({ sessionId: session.id, title: 'Fork' })`.

Expected:

- Created and forked sessions have stable IDs and requested titles.
- `list()` includes the created session.
- `load()` returns the same session ID.
- `transcript()` works for an empty session and returns an empty transcript
  rather than throwing.
- Runtime events include `session.created` for both the original session and
  the fork.

### TC-003: Run lifecycle and normalized events

Steps:

1. Create a runtime with `defaultProvider` set.
2. Create a session.
3. Subscribe to `runtime.events.subscribe({ sessionId }, listener)`.
4. Start a text run with:

```ts
const handle = await runtime.runs.start({
  sessionId,
  input: { type: 'text', text: 'hello runtime' },
});
```

5. Wait for `handle.result`.
6. Call `runtime.runs.get(handle.runId)`.
7. Call `runtime.events.replay({ runId: handle.runId })`.

Expected:

- `runs.start()` returns a handle immediately.
- The run reaches `completed`, `failed`, or `cancelled`.
- Every replayed event includes `id`, `seq`, `time`, `type`, `sessionId`, and
  `runId`.
- Coding callbacks are normalized into runtime events such as `run.started`,
  `turn.started`, `assistant.delta`, `tool.started`, `tool.finished`, and a
  terminal run event.
- Replay filtered by `runId` does not include events from other runs.

### TC-004: No event cross-talk between sessions

Steps:

1. Create two runtime sessions.
2. Subscribe once with `{ sessionId: first.id }` and once with
   `{ sessionId: second.id }`.
3. Start one run in each session.
4. Replay events for each `runId`.

Expected:

- Each subscription receives only events for its own session.
- Each replay result contains only the requested `runId`.
- Aborting one run does not cancel or mutate the other run.

### TC-005: Targeted abort

Steps:

1. Start two long-running runs in two different sessions.
2. Call `runtime.runs.abort(firstRun.runId, 'manual test abort')`.
3. Inspect both run statuses.

Expected:

- The first run becomes `cancelled`.
- The second run remains `running` until it naturally completes or is aborted.
- A `run.cancelled` event is emitted only for the aborted run.

### TC-006: Permission request registry

Steps:

1. Start a run with an existing `events.beforeToolExecute` approval hook.
2. Trigger a tool that requires the hook.
3. Call `runtime.permissions.listPending({ runId })` while the hook is pending.
4. Resolve the original hook.
5. Replay `permission.requested` and `permission.resolved` events.

Expected:

- One pending permission request is visible while the host approval hook is
  pending.
- The pending request is removed after the hook resolves.
- Runtime permission events are emitted without changing the host hook result.
- If no host approval hook is provided, FEATURE_253 does not introduce a new
  approval prompt by itself.

### TC-007: Workflow service is a thin host view

Steps:

1. Call `runtime.workflows.list({})`.
2. If a workflow run exists, call `runtime.workflows.get(runId)`.
3. Subscribe with `runtime.workflows.subscribe({}, listener)`.
4. Pause, resume, or stop an existing workflow run only if the current manager
   reports that action as supported by the existing workflow lifecycle.

Expected:

- The runtime delegates to the existing workflow run manager.
- No duplicate workflow state store is created in FEATURE_253.
- Missing workflow IDs return `undefined` or existing manager errors; they do
  not crash the runtime.

### TC-008: Optional real-provider smoke

Prerequisite:

- A valid provider configuration is available in the local environment.

Steps:

1. Create a runtime with `defaultProvider` and, if needed, `defaultModel`.
2. Create a session in a temporary directory.
3. Start a small prompt such as `Say "runtime ok" and stop.`.
4. Subscribe to events and wait for `handle.result`.

Expected:

- The run completes using the existing coding layer provider path.
- Transcript/session behavior remains the same as the existing SDK path.
- Provider errors are surfaced as `run.failed`, not swallowed.

### TC-009: Missing session rejection

Steps:

1. Create a runtime with a temporary `sessionsDir` and `defaultProvider`.
2. Call `runtime.runs.start({ sessionId: 'missing-session', prompt: 'x' })`.

Expected:

- The call rejects with `Session not found`.
- The coding layer is not called.

### TC-010: Abort/result race remains cancelled

Steps:

1. Start a long-running runtime run.
2. Abort the run through `runtime.runs.abort(runId)`.
3. Let the underlying coding promise resolve successfully after the abort.
4. Await `handle.result` and inspect `runtime.runs.get(runId)`.

Expected:

- Both the handle result and status remain `cancelled`.
- Only `run.cancelled` is emitted as the terminal event.
- No later `run.completed` event is emitted for the same run.

### TC-011: Runtime permission response unblocks approval

Steps:

1. Start a run whose existing `beforeToolExecute` approval hook stays pending.
2. Listen for `permission.requested`.
3. Call `runtime.permissions.respond(requestId, { type: 'allow_once' })`.

Expected:

- The original pending approval resolves to `true`.
- The pending request is removed.
- Responding again with the same ID returns `false`.
- Responding to a missing ID returns `false`.

## Regression Checks

- Existing root SDK exports still work:

```ts
import { runKodaX, startKodaX } from '@kodax-ai/kodax';
```

- Existing package subpaths still work:

```ts
import { startKodaX } from '@kodax-ai/kodax/coding';
import { createSessionManager } from '@kodax-ai/kodax/session';
```

- No new workspace package appears under `packages/`.
- `packages/coding` does not import `@kodax-ai/repl`.
- `packages/repl` does not import `@kodax-ai/coding`.

## Result

Record any deviations here before releasing `v0.7.64`.
