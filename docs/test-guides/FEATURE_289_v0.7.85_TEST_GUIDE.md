# FEATURE_289 — Memory Review Drain Reliability — Human Regression Test Guide

> Version: `v0.7.85`
> Feature: FEATURE_289 (Memory Review Drain Reliability + Pipeline Observability)
> Prerequisite: `npm run build` green; at least one LLM provider configured
> (`ZAI_CODING_API_KEY` / `ANTHROPIC_API_KEY` / etc. in env or `~/.kodax/config.json`).

---

## Test 1: `/memory status` on a fresh project (zero-state)

**Steps:**

1. Start a new KodaX session in an empty or fresh project directory.
2. Run `/memory status` in the REPL.

**Expected:**

- Memory directory: `0 entries` (or absent).
- This-session pipeline: `digests: 0, receipts: 0, notices: 0`.
- Cross-session pending: `0 pending` (or a tenant-level count if other projects
  share the same `~/.kodax` home).
- Reviewer: `auto-installed (production)` or `MISSING` (if no provider configured).
- Diagnosis: `No digests captured yet — break at capture segment.`

**Pass criterion:** renders without error; all sections present even with zeros.

---

## Test 2: `/memory status` on a populated project

**Prerequisite:** at least one completed coding episode (a session that ran tools
and ended normally, producing a `memory_outcome_digest`).

**Steps:**

1. Run a short coding session (e.g., `kodax -c "read README.md and summarize"`).
2. Start a new session in the same project.
3. Run `/memory status`.

**Expected:**

- Digests ≥ 1 (the previous session's outcome digest).
- Receipts: 0 if no review has completed yet (the normal pre-F289 state).
- Pending: ≥ 1 (the captured job waiting for review).
- Diagnosis: `Digests captured but no review receipts — break at review segment.`
  (This is the exact signal F289 was built to surface.)

**Pass criterion:** diagnosis correctly identifies the review-segment break.

---

## Test 3: Turn-end drain with bounded await

**Prerequisite:** a pending review job in the inbox (from Test 2 or pre-existing).

**Steps:**

1. Start a new session in the project (triggers startup drain, then turn-end
   drain on session end).
2. End the session normally (type `exit` or Ctrl-C).

**Expected:**

- The turn-end drain runs with a 15 s deadline (`deadlineAtMs = Date.now() + 15_000`).
- If a review completes within 15 s: `decision.json` written, receipt appears in
  the owner session's lineage.
- If the review's decide phase takes > 15 s: the claim is released via
  `deferEpisodeReview` (job returns to `pending`, not stuck in `processing`).
- On the next run, the startup drain (no deadline) picks up the deferred job and
  completes it.

**Pass criterion:** no job left stuck in `processing` after process exit; the
next run recovers it.

**Verification command:**

```powershell
# After ending a session, check for processing fossils:
Get-ChildItem "$env:USERPROFILE\.kodax\memory-review-inbox" -Recurse -Filter "state.json" |
  ForEach-Object { Get-Content $_.FullName | ConvertFrom-Json } |
  Where-Object { $_.status -eq 'processing' }
# Expected: zero or only very recent (< 5 min old) entries.
```

---

## Test 4: `kodax memory review-drain` foreground command

**Prerequisite:** pending review jobs in the inbox; provider configured.

**Steps:**

1. Run a small batch to verify the pipeline works:

   ```powershell
   node dist\kodax_cli.js memory review-drain --max 5
   ```

2. Observe the output: `reviewed / discarded / failed / deferred` summary.
3. Check `/memory status` (in a REPL session) or re-run `review-drain` to see
   pending count decrease.

**Expected:**

- `reviewed ≥ 1` if any job's digest produces a memory proposal.
- `discarded ≥ 0` if any job is an eligibility discard.
- `failed = 0` if the reviewer LLM is reachable.
- `deferred` for jobs in backoff or fenced by own-session.
- Exit code 0 if `failed == 0`; exit code 1 if `failed > 0`.

**Pass criterion:** pending count decreases; `decision.json` files appear under
`~/.kodax/memory-review-inbox/<tenant>/<session>/jobs/<jobId>/`; receipts are
written to owner session lineages.

**Full backlog clearing:**

```powershell
node dist\kodax_cli.js memory review-drain
```

Loops until a pass yields zero reviewed + zero discarded (deferred-only or
failed-only pass terminates). Re-run after the v2 backoff window (1-30 min) to
retry deferred/failed jobs.

---

## Test 5: Drain failure notice visibility

**Prerequisite:** a review job that will fail (e.g., temporarily unset the
provider API key, or use an invalid model).

**Steps:**

1. Unset `ZAI_CODING_API_KEY` (or misconfigure the provider).
2. Run a coding session that produces a digest and triggers turn-end drain.
3. Observe the REPL output.

**Expected:**

- A `[memory]` line appears in the REPL with failure wording:
  `Memory review failed: ...` (not `Memory updated:`).
- The notice appears on the **current visible session** (not silently dropped).
- `/memory status` shows `notices: ≥ 1` in the this-session section.

**Pass criterion:** the failure is visible to the user in the same session —
not silent. This is the core observability fix of §3.6.

---

## Test 6: Defer does not consume drain budget (§3.2)

**Prerequisite:** an autoResume session whose own oldest job defers (the
pre-F289 head-of-line deadlock condition).

**Steps:**

1. Have ≥ 3 pending jobs from different sessions in the inbox.
2. Start a session that auto-resumes (its own job will defer).
3. Check the drain result (via `emitResilienceDebug` log or `review-drain`).

**Expected:**

- The session's own job defers (does not consume the `maxEntries: 2` budget).
- Other sessions' eligible jobs are reached and processed in the same drain pass.

**Pass criterion:** `reviewed + discarded > 0` in a single drain pass even when
the session's own job defers. (Pre-F289, this was always zero.)

---

## Fault diagnosis quick reference

| Symptom | Diagnosis | Action |
|---|---|---|
| `digests: 0` | Capture segment broken — no outcome digests being produced | Check `memory-runtime.ts` wiring; verify session ended normally |
| `digests > 0, receipts: 0` | Review segment broken — reviewer never ran | Run `kodax memory review-drain` to clear backlog |
| `pending` growing over time | Backlog accumulating — drains not completing | Run `kodax memory review-drain`; check provider config |
| `reviewer: MISSING` | No production reviewer installed | Check provider config; ensure `installProductionLearningReviewer` runs |
| Jobs stuck in `processing` | Claim not released after process exit | Wait 5 min for lease expiry; next run's startup drain recovers |
| `failed > 0` on review-drain | Reviewer LLM errors (timeout, bad response, etc.) | Check API key; re-run after backoff window; check `attention` jobs after 4 failures |
