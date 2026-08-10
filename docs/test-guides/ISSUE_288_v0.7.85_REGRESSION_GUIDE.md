# Issue 288 — v0.7.85 Regression Guide

> Scope: a repo-intelligence Worker may stay warm through the first prompt
> window, then must retire after its idle cache window so its peak analysis
> heap is reclaimable.

## Automated regression

From the repository root:

```bash
npx vitest run packages/coding/src/repo-intelligence/runtime.test.ts -t "keeps the repo-intelligence worker warm across the first prompt window"
```

Expected result: the Worker remains alive through the first five-second prompt
window, a subsequent cache hit keeps the warm path available, and the Worker
is terminated after the longer idle boundary. Cache data remains usable and a
later cache miss may start a fresh Worker.

## Manual smoke

1. Run a full repo-intelligence lookup in a large TypeScript workspace.
2. Record RSS after the semantic cache is warm.
3. Leave the process idle beyond the configured warm-cache window.
4. Confirm the Worker exits and RSS drops, then issue another cache miss and
   confirm a fresh Worker can answer normally.

Record source-file count, warm-up duration, RSS before/after retirement, and
whether the second lookup preserved the same semantic result.
