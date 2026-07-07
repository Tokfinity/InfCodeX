# H2 Plan-Execute Boundary Eval Dataset

> Owner: FEATURE_107 (v0.7.32)
> Status: completed; retained as a historical eval corpus

## Status

FEATURE_107 is complete. The transient P1.0 scanner and raw scan outputs were
pruned during v0.7.63 cleanup:

- `scripts/scan-h2-candidates.ts`
- `candidates.jsonl`
- `candidates-report.md`
- `scan-summary.json`

The retained source of truth is `cases.ts`. `candidate-inventory.md` keeps the
methodology, verification trail, and demotion rationale.

## Dataset Composition

`cases.ts` locks the final corpus at 14 grounded H2-class cases:

| Source | Count |
|---|---:|
| Planned features | 6 |
| Open issues | 3 |
| Real replay | 5 |

This corpus is above the 12-case exploratory fallback floor from the
FEATURE_107 design, but it is not a confirmatory statistical sample.

## Product Question

When AMA escalates to H2 (Scout -> Planner -> Generator -> Evaluator), does the
Planner-to-Generator boundary benefit from a filtered plan-artifact handoff, or
is the full-transcript continuation better for Generator quality?

FEATURE_107 answered this empirically: the filtered B path did not produce a
quality win, so the B-path source hooks were removed and the historical harness
remains only for provenance.

## Files

| File | Purpose |
|---|---|
| `cases.ts` | Final 14-case grounded dataset and variant list. |
| `candidate-inventory.md` | Methodology, candidate review trail, and demotion rationale. |

## Replay Safety

Every case runs in an isolated git worktree at the historical SHA. Production
repos are never touched. The harness also isolates `KODAX_HOME` and cleans the
temporary worktree after each run.

## Provenance

The original scan used local single-user KodaX session telemetry from
`~/.kodax/sessions/`. Raw scan outputs were temporary P1.0 artifacts and are no
longer retained in git.
