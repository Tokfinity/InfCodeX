# Issue 159 v0.7.69 Regression Guide

## Purpose

Verify that Windows process-tree cleanup does not leave a nested descendant
behind when the primary `taskkill /t` path fails or times out.

## Automated gate

Run on Windows with Node 20 and Node 22:

```powershell
npx vitest run packages/agent/src/runtime/process-tree.test.ts
```

Expected result: all three tests pass, including `kills a nested Windows child
process tree`. The test starts a real Node parent and nested child, invokes the
production cleanup helper, and waits until the descendant PID no longer exists.

Then run the package and type gates:

```powershell
npm run build:packages
npm run build:bundle
npm run build:dts
npx tsc --noEmit
```

## Manual stress check

1. Start a KodaX workload that creates nested local child processes.
2. While Windows management services are busy, cancel or time out the workload.
3. Confirm KodaX returns within the configured cleanup bound.
4. In Task Manager or `Get-Process`, confirm no child from that workload remains.
5. Repeat at least ten times; do not accept accumulating `node`, shell, or test
   worker descendants.

## Pass criteria

- The real nested-process regression passes on both supported Node lines.
- No workload descendant survives cleanup.
- Agent-runtime and LLM CLI-event cleanup remain behaviorally aligned.
- Build, bundle, DTS, and root type validation stay green.
