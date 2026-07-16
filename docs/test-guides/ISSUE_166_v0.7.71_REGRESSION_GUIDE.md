# Issue 166 v0.7.71 Regression Guide

## Scope

Verify that packaged Electron daemon bootstrap mode is consumed before daemon
application code loads and is never inherited by ordinary user child processes,
while trusted internal JavaScript children continue to start correctly.

## Focused regression

```powershell
npx vitest run packages/agent/src/runtime/process-hardening.test.ts src/runtime-daemon/process.test.ts
npx vitest run src/sandbox-runtime.test.ts src/skill_cli.test.ts packages/coding/src/lsp/spawn.test.ts packages/coding/src/lsp/client-integration.test.ts
npm run build:packages
```

The focused tests must prove:

1. Electron Node mode is present at the simulated exec boundary.
2. The bootstrap import removes `ELECTRON_RUN_AS_NODE` before target code runs.
3. Cleanup remains mandatory when `KODAX_DISABLE_HARDENING=1` disables optional
   linker-variable hardening.
4. Ordinary Node arguments are unchanged and stale bootstrap state is removed.
5. Runtime daemon, LSP, Skill CLI, and sandbox paths remain operational.

## Windows packaged/asar release gate

Use Electron 42.5.0 and electron-builder 25.1.8:

```powershell
$env:KODAX_ELECTRON_DIST = '<app>\node_modules\electron\dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<app>\node_modules\electron-builder\out\cli\cli.js'
npm run test:electron-daemon
```

The smoke packages the current npm tarball into an asar application and uses a
fresh profile. It must prove:

- packaged Main cold-starts one daemon and never re-enters as a second GUI;
- daemon code observes `ELECTRON_RUN_AS_NODE` as absent;
- a normal Windows process spawned by daemon extension code also observes it as
  absent;
- an independent Node SDK process attaches to the same `runtimeId` with correct
  logical client counts;
- Electron close only detaches, and two daemon-to-inline-to-daemon owner cycles
  remain safe.

This smoke is required by the Windows CI job and the `win-x64` release build.

## RunAsNode fuse boundary

Electron enables the `RunAsNode` fuse by default. Packaged `autoStart: true`
requires it because the application executable is the only available detached
Node host. If an embedder disables the fuse, start the daemon through ordinary
Node or the KodaX CLI and connect with attach-only mode. Confirm a packaged
auto-start timeout explicitly names the fuse requirement and does not open a
second GUI or fall back to inline Runtime.
