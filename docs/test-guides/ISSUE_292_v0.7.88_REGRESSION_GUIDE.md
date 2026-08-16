# Issue 292 / Actor settlement convergence v0.7.88 Regression Guide

## Purpose

Verify that Actor terminal settlement separates local queueing, writer
eligibility, canonical replacement, and post-commit maintenance, and that the
v2 capability is advertised without weakening the existing shell/sandbox
contracts. Do not run `npm publish`; publication remains a maintainer step.

## Automated checks

Run from the repository root:

```bash
npm ci
npm run build:packages
npm run build:bundle
npm run test:full
npm run test:electron-daemon:built
```

The deterministic suite must pass on Node 20 and Node 22. The bundle step must
also report no eager startup import of the Anthropic SDK, `jimp`, TypeScript,
LSP, or other audited heavy dependencies.

## Actor settlement checks

1. Run the Actor controller and storage tests under
   `packages/agent/src/actors/` and `packages/repl/src/interactive/storage.test.ts`.
2. Verify a long process-local queue does not consume the canonical five-second
   settlement deadline before writer eligibility.
3. Verify cancellation before canonical replacement produces no late write.
4. Verify an in-flight replacement remains fail-closed and an explicit
   replacement error is classified by authoritative persisted JSON shape.
5. Verify post-commit cache/watermark/topology/lock maintenance failure does
   not roll back a successfully replaced terminal Actor snapshot.
6. Verify same-owner repair uses the same phased save boundary and that a
   predecessor stuck in canonical replacement is fenced.
7. Verify the Runtime capability snapshot includes
   `actorSettlementConvergence: 2` and rejects incompatible v1 semantics when
   the host requires convergence v2.

## Manual smoke

Start a local interactive session, submit a query, interrupt or stop it during
tool work, then resume the same session. Confirm the terminal result and
recovery diagnostics are consistent with the durable Actor snapshot and no
duplicate tool effect is replayed. Confirm Windows shell and sandbox contract
tests remain green.
