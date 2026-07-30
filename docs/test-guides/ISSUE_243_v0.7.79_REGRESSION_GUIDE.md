# ISSUE_243 v0.7.79 Regression Guide

## Scope

Verify that a Worker-hosted embedded Runtime can opt into the built-in
configured A2A integration and that catalog visibility represents real
execution authority.

## Automated Regression

Build the sidecar before running the Worker test because source-mode tests
prefer an existing `dist/runtime-worker.js`:

```powershell
npm run build:bundle
npx vitest run src/sdk-runtime.test.ts -t "loads configured A2A inside the Worker owner"
```

Expected:

- Worker initialization advertises `externalAgents`;
- `listDispatchable` contains `external:worker-a2a`;
- external Actor spawn sends `SendMessage`;
- output reaches `completed`;
- Worker and test server close cleanly.

Run the surrounding Runtime and A2A regressions:

```powershell
npx vitest run src/sdk-runtime.test.ts src/a2a/runtime-config.test.ts
npm run build
```

## SDK Acceptance

Create the Worker with:

```ts
const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  worker: { configuredA2A: true },
  requirements: { externalAgents: true },
});
```

With an enabled Agent in `<homeDir>/.kodax/integrations/a2a.json`, verify:

1. `runtime.agents.listDispatchable(...)` contains `external:<name>`.
2. `runtime.agents.describe(...)` returns the same registration.
3. `runtime.agents.spawn(...)` with `kind: 'external'` and matching
   `metadata.agentId` completes through the remote Agent.
4. `runtime.close()` exits without leaving a live Worker or config watcher.

## Negative Boundary

Omit `worker.configuredA2A` while requiring `externalAgents`.

Expected: initialization fails closed with a missing required capability; the
parent never receives a catalog-only external Agent projection.
