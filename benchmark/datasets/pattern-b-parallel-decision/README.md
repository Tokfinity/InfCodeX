# Pattern B Parallel-Dispatch Decision Quality

> Dataset for FEATURE_146-B (v0.7.37). Validates whether the Worker
> system prompt (with the FEATURE_119 Pattern B block + DISPATCH RULES
> A/B/C) actually causes real LLMs to emit **multiple `dispatch_child_task`
> calls in a single response** when the user task has ≥3 independent
> investigation threads.

## Product question

When the user asks the Worker to investigate ≥3 independent things at
once (e.g. "for each of these 4 packages, tell me X"), does the LLM:

1. **Use Pattern B correctly** — emit ≥2 `dispatch_child_task` tool_use
   blocks in **one** response (parallel fan-out, RULE A read-only
   pattern in `worker-role-prompt.ts`)?
2. **(Historical, no longer applicable)** Not orphan tasks — pre-v0.7.39
   every `dispatch_child_task` had to pair with an `await_child_task`.
   FEATURE_155 v0.7.39 Slice C1 deleted the await tool entirely; the
   runner-driven outer loop reclaims results automatically via the
   idle-yield path, so "orphan" is now a category error (every dispatch
   is implicitly waited on by the runner, not the LLM).

Sync degeneration ("dispatch then immediately await, dispatch then
immediately await…") was the failure mode this eval was designed to
catch on the v0.7.35-v0.7.38 path. Post-FEATURE_155 the await-side of
that failure mode is structurally impossible (no tool to call), so the
eval now measures only the dispatch-side: does the LLM still fan out
in parallel under the idle-yield prompt?

## Why behavioral, not structural

The structural ship gate
[`tests/feature-119-pattern-b-async-dispatch.eval.ts`](../../tests/feature-119-pattern-b-async-dispatch.eval.ts)
already verifies the **tool surface** + **prompt anchors** are present.
What it cannot answer is whether real LLMs **act on** those anchors.
This dataset is the load-bearing follow-up that runs N×M LLM probes
and checks tool-call structure.

## Scope

- **5 tasks** — each constructed to have ≥3 independent investigation
  threads where parallel-dispatch is the obviously correct pattern
- **5 alias × 5 task = 25 cells** (with 5 aliases that have keys
  configured: `zhipu/glm51`, `kimi`, `mmx/m27`, `ds/v4pro`, `ds/v4flash`)
- N=1 reps per cell — tool-call structure is a deterministic enough
  signal that we don't need n=3 here (cost vs. signal trade-off)

## Pre-registered thresholds

| Metric | PASS | INCONCLUSIVE | FAIL |
|---|---|---|---|
| parallel-dispatch trigger rate (≥2 dispatch in single response) | ≥ 60% | 30-60% | < 30% |
| orphan rate | (retired — see note) | | |

> Pre-registered baseline: v0.7.35 had no async dispatch at all,
> so trigger rate of "parallel dispatch in single response" was
> strictly 0%. Any non-zero trigger rate at v0.7.37+ is a strict
> improvement.

### Why orphan rate is retired (v0.7.39 FEATURE_155 Slice C1)

The legacy orphan-rate signal counted "dispatch_child_task without
matching await_child_task". FEATURE_155 deleted the `await_child_task`
tool entirely — the runner-driven outer loop now reclaims child
results automatically through idle-yield (synthesizes a
`<task-completed task_id="…">` user message on the next turn).
Every dispatch is implicitly reclaimed by the runner. "Orphan" is
no longer a measurable failure mode in this dataset's single-turn
probe shape, so the metric is retired.

### First-run results (2026-05-08, 5 alias × 5 task = 25 cells)

Two independent sweeps recorded the natural LLM-output variance:

| Sweep | Aggregate trigger rate | zhipu | kimi | mmx | ds/v4pro | ds/v4flash |
|---|---|---|---|---|---|---|
| Sweep 1 | **76%** (19/25) | 3/5 | 4/5 | 4/5 | 4/5 | 4/5 |
| Sweep 2 | **88%** (22/25) | 3/5 | 5/5 | 5/5 | 4/5 | 5/5 |

**Both sweeps clearly above the 60% PASS threshold.** FEATURE_119
Pattern B prompt anchors DO drive the expected parallel fan-out
behavior across all 5 aliases. `zhipu/glm51` is the consistently
lowest performer (3/5 in both sweeps); the other 4 aliases dispatch
≥4/5 times. The most common Pattern B trigger across all aliases is
the multi-test-suite-status / multi-tsconfig-strict-audit tasks (5+
independent reads with obvious independence). The most common miss
is task-dependent — small per-task cost (e.g. quick package.json
reads) sometimes triggers sequential reads.

## Cost budget

- 25 cells × ~$0.005-0.02/cell ≈ $0.50 max
- Strict serial within alias (avoid 429 per `EVAL_GUIDELINES.md` 反模式 3)
- Cross-alias parallelism allowed (independent quotas)

## Last-run conclusion

**2026-05-08 sweeps** (pre-FEATURE_155): 76-88% parallel-dispatch
trigger rate (range across two sweeps of 25 cells each), comfortably
above the 60% PASS gate. The Pattern B prompt anchors were doing real
work in production-shape probes.

**2026-05-11 dataset migration**: tool surface + system prompt updated
in lockstep with the production wording change — `await_child_task`
tool removed (FEATURE_155 Slice C1), prompt switched to idle-yield
wording (FEATURE_155 Slice C3). The fan-out trigger-rate signal is
preserved; only the post-dispatch wait wording changed. A re-run
sweep against the new prompt is the next maintenance task.

Next re-run trigger: any change to `worker-role-prompt.ts` Pattern B
/ DISPATCH RULES section, or to `dispatch_child_task` description.

## Re-run triggers

- Worker role prompt changes (`packages/coding/src/agents/worker-role-prompt.ts`)
- `dispatch_child_task` description changes
- New Pattern B-aware prompt section added/removed
