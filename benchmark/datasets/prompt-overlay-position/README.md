# Prompt Overlay Position — Behavioral Eval

> Dataset for FEATURE_146-A (v0.7.37). Validates that v0.7.36
> FEATURE_143's prompt-overlay position migration (user-prompt head →
> system-prompt section) does NOT degrade downstream LLM behavior on
> tasks where the overlay carries observable directives.

## Product question

v0.7.26 FEATURE_084 stitched `plan.promptOverlay` (routing-notes
block: task-family guidance, work intent, brainstorm directives,
provider-policy notes, explicit-reason trail) onto the **user prompt
head** in `runner-driven.ts`. v0.7.36 FEATURE_143 routes the same
string through `ManagedRolePromptContext.promptOverlay` so it lands
as a **system-prompt section**, matching SA-path behavior.

Both positions give the LLM the same overlay information. The
question: does the new position drive comparable downstream behavior?

## Why behavioral, not structural

The structural ship gate
[`tests/prompt-overlay-position-migration.eval.ts`](../../tests/prompt-overlay-position-migration.eval.ts)
verifies the **migration completeness** — when `promptOverlay` is set
on the role-prompt context, the resulting system prompt for every
AMA role carries marker text from the overlay. What it cannot answer
is whether the LLM **acts on** that overlay text the same way it
used to when the text was at the user-prompt head.

This dataset is the load-bearing follow-up tracked in
`docs/features/v0.7.37.md` § FEATURE_146 Sub-feature A.

## Scope

- **6 tasks** — each carries an overlay with an observable directive
  (file-creation marker / specific file scope / conciseness directive
  / dep-prohibition / brainstorm-3-options / class-vs-functional
  preference)
- **2 variants** per task:
  - **A (legacy v0.7.35.1 user-prompt-head)**: system = bare role
    prompt without overlay; user message = `${OVERLAY}\n\n${TASK}`
  - **B (v0.7.36 system-prompt-section)**: system = role prompt with
    overlay rendered as a `[Routing Notes]` section via
    `createRolePrompt({ promptOverlay })`; user message = bare TASK
- **5 aliases × 6 tasks × 2 variants = 60 cells**

## Per-cell measurement

Each task has one mechanical predicate over the LLM's tool calls
+ text. Cell pass = predicate satisfied.

## Pre-registered thresholds

| Metric | PASS | FAIL |
|---|---|---|
| Per-task: variant B pass rate ≥ variant A pass rate − 10pp (no regression beyond 10pp) | strict (must on every task) | any task with B < A − 10pp |
| Aggregate: variant B mean pass rate ≥ 50% | informational (bar) | < 50% (overlay rhetorically dead in section position) |

The suite asserts the no-regression-beyond-10pp gate per task.
The 50% aggregate floor is logged as informational.

## Cost budget

- 60 cells × ~$0.005-0.02/cell ≈ $1.20 max
- Strict serial within alias (avoid 429); cross-alias also serial here

## Last-run conclusion

**2026-05-08 first sweep** (5 alias × 6 task × 2 variant = 60 cells):

| Task | A-legacy | B-section | Δ |
|---|---|---|---|
| t1-mandatory-marker          | 5/5 (100%) | 5/5 (100%) | 0pp |
| t2-specific-file-scope       | 5/5 (100%) | 5/5 (100%) | 0pp |
| t3-conciseness-directive     | 5/5 (100%) | 5/5 (100%) | 0pp |
| t4-dependency-prohibition    | 5/5 (100%) | 5/5 (100%) | 0pp |
| t5-brainstorm-three-options  | 1/5 (20%)  | 2/5 (40%)  | **+20pp (B better)** |
| t6-functional-vs-class       | 5/5 (100%) | 5/5 (100%) | 0pp |
| **Aggregate**                | **87%**    | **90%**    | **+3pp** |

**PASS** on every gate:
- No task regressed more than 10pp (in fact: 0pp on 5 tasks, +20pp on 1)
- B-section aggregate 90% well above the 50% informational floor
- B-section actually slightly **outperformed** A-legacy in aggregate

**Per-alias × variant breakdown**: zhipu 5/6, kimi 5/6, mmx 6/6,
ds/v4pro 5/6, ds/v4flash 6/6 (B-section). Stable across all 5
production aliases.

The brainstorm task (t5) was the lowest-scoring across both variants
(20-40%) — heuristic predicate looks for explicit numbered markers
("1.", "2.", "3."), which models often satisfy with bullet-style
formatting instead. This is a predicate-design quirk, not a Pattern
B regression. Future iteration could relax the predicate to count
distinct paragraph-level options. The fact that B-section beat
A-legacy on this hardest task is the strongest evidence the migration
did not silently degrade overlay efficacy.

## Re-run triggers

- Changes to `role-prompt.ts` `promptOverlaySection` rendering
- Changes to `runner-driven.ts` overlay flow
- Changes to `ManagedRolePromptContext.promptOverlay` type/contract
