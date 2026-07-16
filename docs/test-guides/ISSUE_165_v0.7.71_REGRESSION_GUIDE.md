# Issue 165 v0.7.71 Regression Guide

## Scope

Verify that a packaged Electron Main process can cold-start and attach to the
shared Runtime daemon through the public SDK, without relaunching the GUI or
changing ordinary Node behavior.

## Automated Windows packaged/asar smoke

Prerequisites:

- Windows x64;
- a locally installed Electron distribution;
- an `electron-builder` CLI compatible with that Electron distribution.

Set the two toolchain paths and run:

```powershell
$env:KODAX_ELECTRON_DIST = '<app>\node_modules\electron\dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<app>\node_modules\electron-builder\out\cli\cli.js'
npm run test:electron-daemon
```

The smoke builds the current KodaX npm tarball, installs it into a fresh fixture,
packages that fixture with asar, and starts it with an isolated Runtime profile.
It must prove all of the following:

1. A fresh packaged Electron facade reaches ready before the startup timeout.
2. The packaged application Main entry runs exactly once; the daemon child does
   not create another GUI application.
3. The initial logical `clientCount` is 1.
4. An independent Node SDK client attaches to the same `runtimeId`, and the
   logical count converges to 2.
5. Closing the Node client and then the Electron facade only detaches clients;
   the daemon remains attachable and converges back to one management client.
6. Atomic `stopForInline()` succeeds with the inspected Runtime and owner-policy
   revisions, daemon mode can be re-enabled, and a new daemon starts normally.
7. A second stop/enable cycle completes and leaves the isolated profile in
   daemon policy with no running owner.

## Focused and process-distinct regression

```powershell
npx vitest run src/runtime-daemon/process.test.ts
npx vitest run src/runtime-daemon src/kodax_cli.daemon-smoke.test.ts
npx tsc --noEmit
```

Confirm that ordinary Node SDK/CLI auto-start, concurrent owner election,
logical client accounting, detach semantics, and rollback fencing remain green.

## Embedder path semantics

For public SDK options and CLI daemon commands, `homeDir`/`--home` is the base
directory that owns `.kodax`. For example, `homeDir = C:\Users\me` stores daemon
state below `C:\Users\me\.kodax`.

`KODAX_HOME` is lower-level and already points at the `.kodax` data directory.
Do not pass a `KODAX_HOME` value back as `ConnectKodaXRuntimeOptions.homeDir`, or
the SDK will intentionally resolve a different `<value>\.kodax` namespace.

## Failure-path check

The focused process test also verifies that a bundled embedder which omits the
published `dist/kodax_cli.js` sidecar receives an immediate, actionable error.
It must not wait for the 60-second daemon startup timeout.
