# Issue 213 v0.7.77 Regression Guide

## Scope

Validate that AMA managed-run context remains request-only and survives real
automatic compaction for both native ephemeral-suffix Providers and legacy
Provider lowering.

## Automated gate

```bash
npx vitest run \
  packages/coding/src/task-engine/runner-driven.compaction-context.test.ts \
  packages/coding/src/task-engine/runner-driven.test.ts
```

The regression must force a real automatic-compaction boundary between two
Worker requests and execute both Provider capability modes.

## Required assertions

For the Worker request immediately before and after compaction:

1. `skills-addendum` content appears exactly once.
2. The explicitly selected Skill body appears exactly once.
3. Task constraints and managed MCP/Skill context are delivered through the
   request-only suffix or its legacy wire-message lowering.
4. The stable System prompt contains none of those dynamic bodies.
5. `onContextBudgetSnapshot.tokenBreakdown.skillCatalog` remains greater than
   zero.

For compactable and durable transcripts:

1. no message has `_source: "managed-run-context"`;
2. Skills, selected Skill content, and task constraints are not persisted;
3. the compaction summary cannot become their only surviving copy.

## Exact package audit

From the final clean release candidate:

```bash
node scripts/release.mjs --pack-only
```

Record the generated `kodax-ai-kodax-0.7.77.tgz` SHA-256. Inspect the packed
Runtime/SDK entry points and confirm the native ephemeral-suffix capability,
legacy request-only lowering, Shell Execution Contract exports, and managed
context reinjection are present in the exact archive supplied to consumers.
