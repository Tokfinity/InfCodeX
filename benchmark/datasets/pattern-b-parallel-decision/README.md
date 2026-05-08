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
2. **Not orphan tasks** — every `dispatch_child_task` eventually pairs
   with an `await_child_task` (or the LLM at least intends to wait
   based on transcript evidence)?

Sync degeneration ("dispatch then immediately await, dispatch then
immediately await…") is the failure mode this eval is designed to
catch — that pattern reduces FEATURE_119 to the v0.7.35 sync path.

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
| orphan rate (informational only — see note) | n/a | n/a | n/a |

> Pre-registered baseline: v0.7.35 had no `await_child_task` tool, so
> every dispatch was synchronous → trigger rate of "parallel
> dispatch in single response" was strictly 0%. Any non-zero trigger
> rate at v0.7.37 is a strict improvement.

### Why orphan rate is informational, not a gate

Orphan rate is "dispatch count > await count" — i.e. dispatching a child
task but never claiming the result. In production this would mean a
runaway in-flight promise. To **measure** it as a pass/fail gate,
the eval would need to be **multi-turn**: dispatch in turn 1, see the
synthetic `task_id:<id>` banner come back as a tool result, then on
turn 2 emit `await_child_task({task_id})`. The orphan signal is the
gap between dispatch count and await count *across the full multi-turn
trajectory*.

This eval is **single-turn** (one provider.stream call per cell),
which means:
- The dispatch tool never actually executes — it returns no
  `task_id:<id>` banner.
- The LLM has no task_ids to await on within the same response.
- Therefore orphan rate of 100% is the **single-turn baseline**, not
  a regression.

Multi-turn orphan measurement requires a `mockChildExecutor` primitive
that emits synthetic task_id banners at the dispatch tool boundary.
That primitive is documented in `docs/features/v0.7.37.md` Step 0.5
and explicitly **skipped** for this v0.7.37 eval ship — single-turn
trigger-rate validation is sufficient to falsify the "Pattern B
prompt is rhetorically dead" hypothesis, which is the dominant risk.

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

**2026-05-08 sweeps**: 76-88% parallel-dispatch trigger rate (range
across two sweeps of 25 cells each), comfortably above the 60% PASS
gate. The Pattern B prompt anchors are doing real work in
production-shape probes. Next re-run trigger: any change to
`worker-role-prompt.ts` Pattern B / DISPATCH RULES section, or to
`dispatch_child_task` / `await_child_task` description fields.

## Re-run triggers

- Worker role prompt changes (`packages/coding/src/agents/worker-role-prompt.ts`)
- `dispatch_child_task` / `await_child_task` description changes
- New Pattern B-aware prompt section added/removed
