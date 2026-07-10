# FEATURE_255_v0.7.66 Test Guide

## Scope

FEATURE_255 introduces the local KodaX runtime daemon and the SDK daemon
transport used by REPL, ACP, SDK hosts, Space, and IDE-style clients.

This guide verifies:

- daemon lifecycle commands: `start`, `status`, `logs`, `stop`, `restart`;
- local transport on Windows named pipes and Unix domain sockets;
- SDK `embedded` and `daemon` modes;
- multi-client and multi-session daemon behavior;
- permission prompt subscriptions and cross-client responses;
- admin/catalog/artifact/diagnostic methods needed by Space;
- release package surface for `@kodax-ai/kodax/runtime`.

## Automated Baseline

Run from the KodaX repository root:

```bash
npm test -- src/runtime-daemon/protocol.test.ts src/runtime-daemon/schema.test.ts src/runtime-daemon/state.test.ts src/runtime-daemon/lifecycle.test.ts src/runtime-daemon/manager.test.ts src/runtime-daemon/server.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/transport.test.ts src/runtime-daemon/host.test.ts src/sdk-runtime.test.ts src/sdk-runtime.config.test.ts src/acp_server.test.ts src/kodax_cli.interactive-exit.test.ts src/kodax_cli.daemon-smoke.test.ts packages/repl/src/interactive/commands-status.test.ts
npm run test:eval -- tests/tool-exposure-bridge-reachability.eval.ts tests/tool-exposure-ordinary-agent.eval.ts tests/tool-exposure-repo-intel.eval.ts tests/tool-exposure-small-window.eval.ts
npx tsc -p tsconfig.json --noEmit
npm run build
npm pack --dry-run --json
node scripts/release.mjs --pack-only --skip-build
```

Expected:

- Runtime/daemon/SDK/ACP/REPL gate passes with the current F255 test count.
- Context/tool-exposure evals pass.
- Type check and build pass.
- GitHub CI on Ubuntu Node 22 also runs the `Runtime daemon Unix socket gate`,
  which imports `@kodax-ai/kodax/runtime` from the built package surface and
  proves Unix socket transport, two SDK daemon clients, shared session status,
  permission prompt fanout, cross-client permission response, and zero pending
  permissions after resolution.
- The dry-run tarball includes `dist/sdk-runtime.js`,
  `dist/sdk-runtime.d.ts`, `dist/kodax_cli.js`, and
  `scripts/kodax-bin.cjs`.
- `kodax-ai-kodax-0.7.66.tgz` is produced by the release pack-only path after
  bundle import and semantic-worker sidecar guards pass.

## Tarball Consumer Gate

After `node scripts/release.mjs --pack-only --skip-build`, verify that the
published package shape works outside the monorepo:

```powershell
$consumer = Join-Path $env:TEMP ('kodax-sdk-consumer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $consumer | Out-Null
Push-Location $consumer
npm init -y
npm install C:\Works\GitWorks\KodaX-author\KodaX\kodax-ai-kodax-0.7.66.tgz
@'
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createKodaXRuntime, connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-0766-consumer-'));
const profile = `consumer-${process.pid}-${Date.now()}`;
const capabilities = { richEvents: true, permissionPrompts: true, contextDiagnostics: true };
let first;
let second;
try {
  first = await createKodaXRuntime({
    mode: 'daemon',
    homeDir,
    profile,
    defaultProvider: 'mock-provider',
    clientInfo: { name: 'consumer-a', version: '0.7.66' },
    capabilities,
  });
  second = await connectKodaXRuntime({
    homeDir,
    profile,
    clientInfo: { name: 'consumer-b', version: '0.7.66' },
    capabilities,
  });
  const events = [];
  second.events.subscribe({}, (event) => {
    events.push(event.type);
    if (event.type !== 'permission.requested') return;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return;
    void second.permissions.respond(payload.id, { type: 'allow_once' }, { runId: payload.runId });
  });
  const session = await first.sessions.create({ title: '0.7.66 consumer smoke', projectPath: homeDir });
  const decision = await first.permissions.request({
    sessionId: session.id,
    runId: 'consumer-permission-run',
    toolName: 'bash',
    inputPreview: 'echo ok',
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const status = await second.status.snapshot();
  console.log(JSON.stringify({
    version: first.identity.version,
    sameRuntime: first.identity.runtimeId === second.identity.runtimeId,
    sessions: status.sessions.length,
    decision,
    hasPermissionEvents: events.includes('permission.requested') && events.includes('permission.resolved'),
    pending: (await second.permissions.listPending({ runId: 'consumer-permission-run' })).length,
  }));
} finally {
  await second?.close();
  await first?.close();
  await rm(homeDir, { recursive: true, force: true });
}
'@ | node --input-type=module
Pop-Location
Remove-Item -LiteralPath $consumer -Recurse -Force
```

Expected:

- The script prints `version: "0.7.66"`.
- `sameRuntime` is `true`.
- `sessions` is `1`.
- `decision.type` is `allow_once`.
- `hasPermissionEvents` is `true`.
- `pending` is `0`.

## Unix-Like Host Gate

Run this on Linux or macOS, not on Windows or WSL until WSL is healthy:

```bash
npm test -- src/runtime-daemon/transport.test.ts src/runtime-daemon/state.test.ts src/runtime-daemon/lifecycle.test.ts src/runtime-daemon/manager.test.ts src/runtime-daemon/host.test.ts src/kodax_cli.daemon-smoke.test.ts src/sdk-runtime.test.ts
npm run build
node --input-type=module <<'NODE'
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createKodaXRuntime, connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-f255-unix-'));
const profile = `unix-${process.pid}-${Date.now()}`;
let first;
let second;
try {
  first = await createKodaXRuntime({
    mode: 'daemon',
    homeDir,
    profile,
    defaultProvider: 'mock-provider',
    clientInfo: { name: 'unix-smoke-a', version: '0.7.66' },
    capabilities: { permissionPrompts: true, contextDiagnostics: true },
  });
  second = await connectKodaXRuntime({
    homeDir,
    profile,
    clientInfo: { name: 'unix-smoke-b', version: '0.7.66' },
    capabilities: { permissionPrompts: true, contextDiagnostics: true },
  });
  const session = await first.sessions.create({ title: 'Unix Smoke', projectPath: homeDir });
  const status = await second.status.snapshot();
  console.log(JSON.stringify({
    sameRuntime: first.identity.runtimeId === second.identity.runtimeId,
    profile: status.profile,
    sessions: status.sessions.length,
    sessionId: session.id,
  }));
} finally {
  await second?.close();
  await first?.close();
  await rm(homeDir, { recursive: true, force: true });
}
NODE
```

Expected:

- The transport tests exercise `endpoint.kind === "unix"`.
- CLI smoke starts and stops a daemon with a Unix domain socket endpoint.
- The SDK smoke prints `sameRuntime: true`, the requested profile, and one
  visible session.
- After close, the daemon state and socket path are removed or reusable.

## Windows Host Gate

Run on Windows:

```powershell
npm test -- src/runtime-daemon/transport.test.ts src/runtime-daemon/state.test.ts src/runtime-daemon/lifecycle.test.ts src/runtime-daemon/manager.test.ts src/runtime-daemon/host.test.ts src/kodax_cli.daemon-smoke.test.ts src/sdk-runtime.test.ts
npm run build
```

Expected:

- The default endpoint is a named pipe under `\\.\pipe\kodax-runtime-*`.
- Two concurrent daemon starters converge on one owner.
- `kodax daemon start/status/logs/stop/restart --json` works with a temporary
  `--home` and profile.
- `stop --force` cleans verified stale ownership and refuses an unverified live
  pid.

## Space / IDE SDK Gate

After `npm run build` in KodaX, refresh the Space dev link:

```powershell
cd C:\Works\GitWorks\KodaX-author\KodaX-Space
npm run link:kodax
```

Run from the Space repository:

```powershell
node --test --import tsx/esm apps/desktop/electron/test/kodax-sdk-probe.test.ts
node --test --import tsx/esm apps/desktop/electron/test/permission-broker.test.ts apps/desktop/electron/test/permission-batching.test.ts apps/desktop/electron/test/permission-sanitize.test.ts apps/desktop/electron/test/permission-registry.test.ts
node --test --import tsx/esm packages/space-ipc-schema/test/ask-user.test.ts packages/space-ipc-schema/test/session.test.ts packages/space-ipc-schema/test/slash.test.ts packages/space-ipc-schema/test/settings.test.ts
node --test --import tsx/esm apps/desktop/electron/test/session-runtime-store.test.ts apps/desktop/electron/test/runtime-defaults.test.ts apps/desktop/electron/test/host.test.ts apps/desktop/electron/test/queue.test.ts
npm run build:smoke
npm run smoke:pack
npm run smoke:boot
npx playwright test --retries=1
```

Then run a daemon SDK smoke through the linked `@kodax-ai/kodax/runtime` dist
package:

```powershell
@'
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createKodaXRuntime, connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-space-f255-'));
const profile = `space-${process.pid}-${Date.now()}`;
const capabilities = { richEvents: true, permissionPrompts: true, contextDiagnostics: true };
let repl;
let space;
try {
  repl = await createKodaXRuntime({
    mode: 'daemon',
    homeDir,
    profile,
    defaultProvider: 'mock-provider',
    clientInfo: { name: 'kodax-repl', title: 'KodaX REPL', version: '0.7.66' },
    capabilities,
  });
  space = await connectKodaXRuntime({
    homeDir,
    profile,
    clientInfo: { name: 'kodax-space', title: 'KodaX Space', version: '0.1.29' },
    capabilities,
  });
  const events = [];
  space.events.subscribe({}, (event) => {
    events.push(event.type);
    if (event.type !== 'permission.requested') return;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return;
    void space.permissions.respond(payload.id, { type: 'allow_once' }, { runId: payload.runId });
  });
  const decision = await repl.permissions.request({
    sessionId: 'space-smoke-session',
    runId: 'space-smoke-run',
    toolName: 'bash',
    inputPreview: 'echo ok',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.log(JSON.stringify({
    sameRuntime: repl.identity.runtimeId === space.identity.runtimeId,
    decision,
    events,
    pending: (await space.permissions.listPending({ runId: 'space-smoke-run' })).length,
  }));
} finally {
  await space?.close();
  await repl?.close();
  await rm(homeDir, { recursive: true, force: true });
}
'@ | node --input-type=module
```

Expected:

- Space SDK probe passes.
- Space permission broker tests pass.
- Space ask-user/session/slash/settings IPC schema tests pass.
- Space session runtime/defaults/host/queue tests pass.
- Space packages, renderer, and Electron main/preload compile through
  `npm run build:smoke`.
- Existing packaged artifacts pass `npm run smoke:pack`: installer size, asar
  contents, keyring native unpacking, yaml runtime files, and node-pty runtime
  files are present.
- Existing packaged app passes `npm run smoke:boot`: the Electron window opens,
  title is `KodaX Space`, and the primary textarea is present.
- Full Space Playwright e2e passes with `npx playwright test --retries=1`.
  This covers renderer/main IPC, session creation, mock send/reply, slash
  commands, settings, workflow events, artifact preview, and major layout flows.
- The SDK smoke prints `sameRuntime: true`.
- `events` contains `permission.requested` and `permission.resolved`.
- `decision.type` is `allow_once`.
- `pending` is `0`.
- A packaged permission UI push smoke should also pass: launch
  `out/win-unpacked/KodaX Space.exe`, send a schema-valid `permission.request`
  through `BrowserWindow.webContents.send`, verify `#permission-modal-title`
  appears with the tool/input/pattern text, then send `permission.cancelled` and
  verify the modal is removed.

## Space Tarball Gate

For release-candidate validation, repeat the Space gate with the packed
`kodax-ai-kodax-0.7.66.tgz` rather than the dev link:

```powershell
cd C:\Works\GitWorks\KodaX-author\KodaX-Space
npm install --no-save --package-lock=false C:\Works\GitWorks\KodaX-author\KodaX\kodax-ai-kodax-0.7.66.tgz
node -e "import('@kodax-ai/kodax/runtime').then(m=>console.log(require('./node_modules/@kodax-ai/kodax/package.json').version, typeof m.createKodaXRuntime, typeof m.connectKodaXRuntime))"
npm run build:smoke
npx playwright test --retries=1
node scripts/pack.mjs --win
npm run smoke:pack
npm run smoke:boot
```

Then run the same packaged permission UI push smoke described above. Restore
the Space checkout afterwards:

```powershell
npm ci --no-audit --no-fund --include=dev
npm run link:kodax
```

Expected:

- The runtime import probe prints version `0.7.66`.
- Space build/e2e/pack/smoke/boot all pass.
- The packaged permission UI push smoke passes.
- Space's `node_modules/@kodax-ai/kodax/package.json` reports version
  `0.7.66` after the dev link is restored.

## Manual REPL Gate

Run:

```bash
kodax daemon start --profile f255-manual --json
kodax --runtime-mode daemon --profile f255-manual
```

Inside REPL:

```text
/status runtime
```

Expected:

- Runtime mode is `daemon`.
- Profile is `f255-manual`.
- Runtime id and daemon endpoint are shown.
- Active/queued run counters are present.

Then stop:

```bash
kodax daemon stop --profile f255-manual --json
```

Expected:

- Stop returns `stopped: true`.
- Follow-up status reports missing or stopped ownership.

## Regression Checks

- `createKodaXRuntime({ mode: 'daemon' })` auto-starts or reuses the profile
  daemon.
- `createKodaXRuntime({ mode: 'daemon', autoStartDaemon: false })` remains
  attach-only.
- `connectKodaXRuntime()` remains attach-only unless `autoStart: true` is used.
- Daemon clients cannot call runtime methods before `initialize`.
- Wrong daemon token or wrong profile is rejected.
- Pending permissions are rejected on run abort, runtime close, and daemon stop.
- Runtime warnings are emitted as events and written to daemon logs.
- `homeDir` scopes daemon state, config, and default session storage.
- No public TCP listener is opened.
