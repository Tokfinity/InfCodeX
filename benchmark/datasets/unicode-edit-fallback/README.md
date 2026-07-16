# Unicode Edit Fallback — Behavioral Eval

> Dataset for FEATURE_146-C (v0.7.37). Validates whether the
> Unicode-normalized fallback in `text-anchor.ts:findUniqueUnicodeNormalizedBlockMatch`
> (FEATURE_131-B v0.7.36) actually rescues real LLM `edit` tool-call
> emissions where the legacy byte-exact + whitespace-normalize fallback
> would silent-fail.

## Product question

When real LLMs are asked to modify code inside files that contain
text humans typically paste with Unicode glyphs (smart quotes,
em-dash, non-breaking space, full-width ASCII, ideographic spaces),
the LLM frequently emits an `old_string` argument that drifts away
from the file's actual bytes — sometimes adding Unicode, sometimes
stripping it. **Without the FEATURE_131-B fallback, every such
mismatch silent-fails the `edit` tool**.

This dataset asks: in real LLM rollouts at 5 production aliases
configured today (zhipu / kimi / mmx / deepseek-pro / deepseek-flash),
how often does the Unicode fallback rescue a needle that the legacy
fallback would have missed? And critically: how often does it
**incorrectly** rescue a needle the legacy fallback already had,
producing a different (wrong) match location?

## Why behavioral, not synthetic

The synthetic dataset eval [`tests/feature-131-unicode-dataset-regression.eval.ts`](../../tests/feature-131-unicode-dataset-regression.eval.ts)
already verifies the **algorithm correctness** — given a constructed
needle/haystack pair with known Unicode artifacts, does the fallback
match? What it cannot answer is **frequency in real rollouts**:
how often do real LLMs actually emit Unicode-drifted needles?

This dataset puts real models in front of haystacks that match
production patterns and counts.

## Scope

- **10 tasks** = 5 positive (Unicode-prone haystack regions) + 5
  negative (clean ASCII haystacks — false-positive guard)
- **5 aliases × 10 tasks = 50 cells**
- N=1 reps per cell (deterministic structural categorization of the
  emitted `old_string` is the signal — no need for n=3 noise reduction)

## Per-cell measurement

Each cell captures the LLM's `edit` tool_use call's `old_string`
argument, then categorizes:

| Category | Definition |
|---|---|
| `byte-exact` | legacy fallback matches uniquely (no Unicode rescue needed) |
| `unicode-rescue` | legacy MISSES, Unicode fallback matches uniquely (the FEATURE_131-B win) |
| `both-miss` | both fallbacks miss — LLM produced a wrong needle (model failure, not Unicode) |
| `false-positive` | legacy uniquely matches range R1; Unicode uniquely matches R2 ≠ R1 (REGRESSION — would silently change the wrong place) |
| `no-edit-call` | LLM didn't emit an `edit` tool call (skipped, asked for clarification, etc.) |

## Pre-registered thresholds

| Metric | PASS | FAIL |
|---|---|---|
| `false-positive` count (in 50 cells) | **= 0** (must) | ≥ 1 |
| Unicode treatment match rate ≥ legacy baseline match rate | strict ≥ (must) | unicode < legacy |
| `unicode-rescue` count (positive cases only) | ≥ 1 (informational uplift signal) | 0 (the section is rhetorically dead) |

The suite asserts the false-positive=0 gate and the no-regression gate.
The uplift count is informational (LLMs in 2026 are conservative about
Unicode emission; a small uplift count is realistic).

## Cost budget

- 50 cells × ~$0.005-0.02/cell ≈ $1.00 max
- Strict serial within alias (avoid 429 per `EVAL_GUIDELINES.md` 反模式 3)

## Last-run conclusion

**2026-05-08 first sweep** (5 alias × 10 task = 50 cells):

| Category | Count | Notes |
|---|---:|---|
| `byte-exact` | 48 | LLMs copied haystack bytes verbatim |
| `unicode-rescue` | 0 | No Unicode drift observed in this sweep |
| `both-miss` | 2 | ds/v4pro + ds/v4flash on positive cases — LLM paraphrased instead of copying |
| `false-positive` | 0 | ✅ Unicode normalize never silently changed wrong location |
| `no-edit-call` | 0 | All cells emitted an `edit` tool call |

**PASS**: false-positive=0 + Unicode treatment match rate (48/50) =
legacy baseline (48/50). No regression. The Unicode fallback is doing
no harm in normal rollouts.

**Informational reading**: 0 unicode-rescue events means LLMs in 2026
across these 5 aliases are conservative about Unicode emission —
they faithfully copy haystack bytes rather than auto-substituting
typographic glyphs even when the haystack content (smart-quote-style
comments, em-dash separators) might tempt that behavior. The fallback
remains valuable as an insurance policy for the silent-edit-fail
tail risk (CJK locale paste-mix, web-doc paste flows, older models),
but is not in heavy daily use across these production aliases.

## Re-run triggers

- Changes to `text-anchor.ts` Unicode normalization helpers
- Changes to `edit` / `multi_edit` tool descriptions (LLM input spec)
- Changes to `unicodeCanonicalizeLogicalBlock` mapping table
