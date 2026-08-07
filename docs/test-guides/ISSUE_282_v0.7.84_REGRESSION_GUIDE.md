# Issue 282 Actor settlement-recovery regression guide

This guide covers the v0.7.84 runtime system-code hardening for bounded Agent
progress persistence and same-owner recovery of an unknown Actor settlement.

## Automated checks

1. Run `npx vitest run packages/agent/src/actors/controller.test.ts`.
2. Run `npx vitest run packages/coding/src/agent-runtime/actor-runtime.test.ts`.
3. Run the focused SDK recovery tests:

   ```bash
   npx vitest run src/sdk-runtime.test.ts -t "accepts Stop for a live same-owner unknown Run|redelivers cancellation effects|does not regress a local terminal Run|terminalizes a previously returned unknown Run|rejects owned-unknown Stop"
   ```

4. Run `npx vitest run packages/coding/src/self-knowledge/registry.test.ts`.
5. Run `npm run build`.

## Manual acceptance

Force or delay Agent progress persistence so that a terminal save crosses the
settlement deadline and the owning Run becomes `unknown`. Issue Stop from the
exact same local owner and verify that the late Actor snapshot is reconciled,
the owner fence remains valid, remaining turns are quiesced, and repair can be
retried. Confirm that terminal completion or failure is emitted once, stale
callbacks do not rewind the Run, and repeated same-owner Stop is idempotent.

Also verify that a foreign owner, missing snapshot, and persistent store
failure are rejected fail-closed, and that a no-op quiesce does not rewrite the
Session.
