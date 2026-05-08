# FEATURE_148 v0.7.37 Behavioral Eval Report

> **Eval**: Pattern B post-dispatch probe — does the Worker, when handed a fresh `task_id:<id>`, immediately await it (sync degeneration) or do the side-task the user explicitly asked for?
>
> **Methodology**: Layer 2 single-turn probe per [`benchmark/EVAL_GUIDELINES.md`](../../benchmark/EVAL_GUIDELINES.md). One `provider.stream` call per cell with a pre-canned 3-message history that ends with a synthetic `task_id:child-1 launched` tool_result. Mechanical assertion on the first emitted `tool_use`.

## Pre-registered hypothesis

> When the user has explicitly asked for a side-task ("WHILE X runs, also do Y"), and the assistant has just dispatched X as a child (so `task_id:child-1 launched` is the most recent tool_result the LLM has seen), then the LLM's NEXT `tool_use` should NOT be `await_child_task({task_id:'child-1'})`.

`degenerate := firstTool.name === 'await_child_task' && firstTool.input.task_id === 'child-1'`

## Pre-registered thresholds

| Metric | PASS | INCONCLUSIVE | FAIL |
|---|---|---|---|
| **degenerate-rate** (load-bearing) | ≤ 40% | 40-70% | > 70% |

## Run config

- 2026-05-08, 14:54:52 → 14:59:43 (291.6 s wall-clock)
- 5 alias × 5 scenario × 3 reps = **75 probes**
- Strict serial within alias (avoid 429); cross-alias also serial here for log readability + quota safety
- 0 provider errors
- Cost: 75 × ~$0.01-0.05 ≈ $1-4

## Aggregate result

```
[fea148] degenerate-rate = 0.0% (0/75 completed cells; errors=0)
[fea148] PASS=YES  INCONCLUSIVE=no
```

✅ **PASS** with margin: 0/75 cells exhibited the "派出去 → 立即 await" sync degeneration. Far below the 40% PASS aspiration.

## Per-alias breakdown

| Alias | degen / total | errors |
|---|---|---|
| `zhipu/glm51` | 0/15 | 0 |
| `kimi` | 0/15 | 0 |
| `mmx/m27` | 0/15 | 0 |
| `ds/v4pro` | 0/15 | 0 |
| `ds/v4flash` | 0/15 | 0 |

All five production-tier provider aliases land at 0% degeneration. Cross-family generalization is clean.

## Per-scenario breakdown — what the LLM picked instead of awaiting

| Scenario | degen / total | non-degenerate next-tool histogram |
|---|---|---|
| `long-test-with-side-read` | 0/15 | `read=15` |
| `three-fanout-with-side-readme` | 0/15 | `dispatch_child_task=15` |
| `slow-grep-with-side-tsconfig` | 0/15 | `read=15` |
| `long-build-with-side-changelog` | 0/15 | `read=15` |
| `parallel-research-with-side-package` | 0/15 | `dispatch_child_task=15` |

Two distinct correct behaviors emerge cleanly:

1. **"Single slow + cheap side-read" scenarios** (3 of 5) → 100% picked `read` for the side-task the user explicitly named. The Worker correctly does the cheap independent read while the dispatched child runs.
2. **"First of N parallel children" scenarios** (2 of 5) → 100% picked `dispatch_child_task` for the next sibling child. The Worker correctly fans out the remaining parallel work before any await.

Both are correct non-degenerate behaviors. The Worker never picked `await_child_task` as its first move.

## Caveats — what this eval does NOT prove

1. **No A/B baseline run**. The eval uses the post-FEATURE_148 prompt (with anti-immediate-await rule). It does not run the same probes against the pre-FEATURE_148 prompt. So the data confirms "with the new rule, degeneration is 0%" — it does **not** confirm "the new rule is what fixed it" vs "FEATURE_119 base prompt was already enough at the post-dispatch boundary". A follow-up A/B sweep (variant `prompt_v0_pre_148` vs `prompt_v1_with_148`) would close this.
2. **Single-turn probe ≠ full-trajectory behavior**. This eval probes ONE decision (the `tool_use` immediately after task_id arrival). It does not measure what happens 3-4 turns later if the Worker keeps interleaving. FEATURE_146-B already established that >76% of the time Workers emit ≥2 dispatch in one response when ≥3 independent investigations are asked for; together with this eval, the post-dispatch and parallel-trigger boundaries are both green.
3. **Production user-observed degeneration source unclear**. The user-reported "派出去 → 立即 await" log may have come from (a) an earlier prompt revision before FEATURE_148, (b) a scenario the eval did not reproduce, or (c) a session where the system prompt got truncated. The 0% result here means the rule DOES drive correct behavior at the boundary the eval probes, not that no degeneration ever happens in any production trajectory.

## Decision

- ✅ **Ship**: FEATURE_148 prompt patch lands in v0.7.37 重发 with the Layer 2 eval as protection against future regression.
- 📋 **Re-run trigger**: any change to `worker-role-prompt.ts` `dispatchRules` block, `dispatch_child_task` / `await_child_task` description, or the canned `task_id:child-1 launched` banner wording.
- 🔭 **Optional follow-up** (not blocking ship): A/B baseline run to attribute the 0% specifically to the new rule. Cost ≈ same $1-4, decision: confirm rule load-bearing → keep / data flat → consider revert.
- 🧹 **Cleanup completed**: the multi-turn `mockChildExecutor` primitive + `pattern-b-multi-turn-discipline` dataset + `tests/feature-148-multi-turn-discipline.eval.ts` from the initial Layer 3.5 anti-pattern draft were removed (zero current use cases under KodaX `NEVER add abstractions until 3+ concrete use cases`). If a Layer 3 choreographed use case appears later, re-introduce on demand.

## Files

- Dataset: [`benchmark/datasets/pattern-b-post-dispatch-probe/cases.ts`](../../benchmark/datasets/pattern-b-post-dispatch-probe/cases.ts) + [README](../../benchmark/datasets/pattern-b-post-dispatch-probe/README.md)
- Eval: [`tests/feature-148-post-dispatch-probe.eval.ts`](../../tests/feature-148-post-dispatch-probe.eval.ts)
- Worker prompt change: [`packages/coding/src/agents/worker-role-prompt.ts`](../../packages/coding/src/agents/worker-role-prompt.ts) `dispatchRules` block
