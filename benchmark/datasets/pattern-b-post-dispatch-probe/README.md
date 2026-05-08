# Pattern B Post-Dispatch Probe (FEATURE_148)

> **Layer 2 single-turn probe** dataset for FEATURE_148 (v0.7.37).
> Validates whether the Worker, when handed a freshly-launched
> `task_id:<id>`, immediately calls `await_child_task` (the
> "派出去 → 立即 await" sync degeneration) instead of the cheap
> independent side-task the user explicitly asked for.

## Why this is Layer 2 (and not Layer 3.5 anti-pattern)

Per [`benchmark/EVAL_GUIDELINES.md`](../../EVAL_GUIDELINES.md):

- Layer 2 = pre-canned input + single LLM call + mechanical
  assertion. Each probe verifies one pre-registered hypothesis.
- Layer 3.5 anti-pattern = "let the LLM run free for N turns and
  aggregate the trace" — prompt micro-effects get drowned in
  trajectory noise.

An earlier draft of this eval used a multi-turn mock-child-executor
loop with the LLM free-deciding for up to 6 turns. That was
anti-pattern 2. The redesign here probes ONE decision: given an
exact post-dispatch state, what is the next `tool_use`?

## What each probe is

For every (alias × scenario × rep) cell:

1. **Fixed input**: system prompt with the FEATURE_148 anti-
   immediate-await rule + a canned 3-message history that ends with
   a synthetic `task_id:child-1 launched` tool_result.
2. **Single `provider.stream` call**: one round; we read the
   assistant's first `tool_use` block.
3. **Mechanical assertion** per cell:

   ```
   degenerate :=
     firstTool.name === 'await_child_task'
     && firstTool.input.task_id === 'child-1'
   ```

The assistant's canned text is intentionally neutral ("I'll dispatch
… as a background child task") so the next decision is driven only
by the system prompt + user task + the just-arrived task_id banner —
not by an assistant pre-commitment to a sequence.

## Scope

- **5 scenarios** — each is a "dispatch slow + meanwhile do cheap
  Y" workflow. Y is cheap, named explicitly in the user message,
  and independent of the dispatched child's output:

  | Scenario | dispatched (slow) | side-task (cheap) |
  |---|---|---|
  | `long-test-with-side-read` | `npm test` ~90s | read package.json |
  | `three-fanout-with-side-readme` | first of 3 test children | read README.md |
  | `slow-grep-with-side-tsconfig` | repo-wide grep | read tsconfig.json |
  | `long-build-with-side-changelog` | `npm run build` ~60s | read CHANGELOG.md |
  | `parallel-research-with-side-package` | first of 2 research children | read package.json |

- **5 alias × 5 scenario × N=3 reps = 75 probes** (with 5 aliases
  configured: `zhipu/glm51`, `kimi`, `mmx/m27`, `ds/v4pro`,
  `ds/v4flash`). Cells skip individually when the alias key is
  absent.
- N=3 reps absorb single-call rate-limit / temperature jitter
  without doubling cost. Tool-name selection is much lower-variance
  than text quality scoring.

## Pre-registered metrics + thresholds

| Metric | PASS | INCONCLUSIVE | FAIL |
|---|---|---|---|
| **degenerate-rate** (load-bearing) | ≤ 40% | 40-70% | > 70% |
| **per-alias degenerate-rate** | informational | — | — |
| **side-task-tool-rate** (degenerate-rate's complement, broken down by which non-await tool fired) | informational | — | — |

Vitest hard-asserts the FAIL threshold (>70% degenerate-rate fails
the suite red). PASS aspiration (≤40%) is logged but not asserted —
gate gets tightened in subsequent versions once a baseline is
established.

## Cost budget

- 75 probes × ~$0.01-0.05/probe ≈ **$1-4** total.
- Strict serial within alias (avoid 429 per EVAL_GUIDELINES anti-
  pattern 3); cross-alias serial here for log readability + provider
  quota safety.

## Re-run triggers

- `worker-role-prompt.ts` `dispatchRules` block changes (any rule
  added / reworded / removed)
- `dispatch_child_task` / `await_child_task` description changes
- Canned banner wording changes in
  [`cases.ts:launchedBanner`](./cases.ts) (the banner is
  rhetorically load-bearing — re-sweep on edit)
- New scenario added or existing scenario's user message reworded
