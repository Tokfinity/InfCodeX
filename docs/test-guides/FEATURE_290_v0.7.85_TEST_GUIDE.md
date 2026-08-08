# FEATURE_290 — Memory Lesson and Verdict Production — Human Regression Test Guide

> Version: `v0.7.85`
> Feature: FEATURE_290 (Memory Lesson and Verdict Production + failedWithLesson Admission)
> Prerequisite: `npm run build` green; FEATURE_289 fixes in place (drain actually
> completes reviews).

---

## Test 1: Failed tool call produces a sanitized lesson (§3.1)

**Steps:**

1. Start a coding session.
2. Trigger a tool failure (e.g., `edit` with a wrong `old_string`, or `bash` with
   a failing command).
3. End the session normally (produces an outcome digest).
4. Run `kodax memory review-drain --max 1` to review the captured episode.
5. Inspect the resulting `decision.json` under
   `~/.kodax/memory-review-inbox/<tenant>/<session>/jobs/<jobId>/`.

**Expected:**

- The digest's `lesson` field contains a fixed-template lesson:
  `A \`<toolName>\` call with these inputs failed before. Inspect the referenced
  tool result and adjust the inputs before retrying.`
- No free-form model output, tool result text, or user input appears in the
  lesson — only the sanitized tool name.
- If the tool name itself is prompt-unsafe (contains injection patterns), no
  lesson is produced (`lesson === undefined`), and all prompt-facing fields
  (summary, actionSignature, claimKey, metadata.toolName) use `unknown-tool`.

**Pass criterion:** lesson exists for failed tool calls; lesson text is the fixed
template with only the tool name interpolated.

---

## Test 2: Verification verdict recorded in digest evidence (§3.2)

**Steps:**

1. Start a coding session.
2. Run a verification-class bash command (e.g., `npm test`, `npm run build`,
   `npx tsc --noEmit`) that **succeeds**.
3. End the session.
4. Drain the review and inspect the digest.

**Expected:**

- The digest's `evidence` array contains an entry with:
  - `grade: 'verified'` (after `codingMemorySourcePolicy` mapping)
  - `source: 'tool'`
  - `verdict: 'passed'`
- `verifiedOutcome` in the review qualification is `true` (when the digest
  outcome is `succeeded` and a `passed` verdict exists).

**Also test the failure variant:**

5. Run a verification command that **fails** (e.g., `npm test` with a breaking
   test).
6. Drain and inspect.

**Expected:**

- Evidence entry has `verdict: 'failed'`.
- If the episode outcome is `failed` and a lesson exists, `failedWithLesson` is
  `true` in the qualification.

**Pass criterion:** verdicts appear in evidence for verification-class calls;
`verifiedOutcome` can become `true` on real digests.

---

## Test 3: `failedWithLesson` does not perturb F263 (§3.3)

**This is an automated test, not a manual one — but document it for regression:**

**Steps:**

1. Run the existing F263 byte-identical regression test:

   ```powershell
   npx vitest run packages/agent/src/memory-control/unified-review.test.ts -t "F263"
   ```

**Expected:**

- The test constructs a `failedWithLesson=true` input and a `failedWithLesson=false`
  input, then asserts `JSON.stringify(capabilityDecision)` is byte-identical
  between them.
- Test passes.

**Pass criterion:** `normalizeCapabilityDecision` output is unaffected by the
`failedWithLesson` field. The F263 reviewer prompt hash is not perturbed.

---

## Test 4: `failedWithLesson` proposals stay in the human queue (§3.4)

**Steps:**

1. Produce a failed episode with a lesson (Test 1).
2. Drain the review.
3. Inspect the resulting proposal in the learning proposal store
   (`~/.kodax/learning-proposals/`).

**Expected:**

- The proposal's `actions` array has `risk: 'medium'` (or higher), even if the
  reviewer LLM self-reported `risk: 'low'` and `confidence: 'high'`.
- The proposal status is `pending` (not auto-applied).
- No `Memory updated:` notice is emitted (auto-apply did not fire).

**Pass criterion:** `failedWithLesson`-derived proposals never auto-apply; they
land in the human approval queue with `risk ≥ medium`.

**Verification:**

```powershell
# Find the proposal store and check status:
Get-ChildItem "$env:USERPROFILE\.kodax\learning-proposals" -Recurse -Filter "*.json" |
  ForEach-Object { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json; Write-Host "$($_.Name): status=$($j.status), risk=$($j.actions[0].risk)" }
```

---

## Test 5: Tool name sanitization in prompt-facing fields (defense-in-depth)

**Steps:**

1. Run the automated test:

   ```powershell
   npx vitest run packages/coding/src/memory/coding-observations.test.ts -t "replaces an unsafe tool name"
   ```

**Expected:**

- When a tool use block has a prompt-unsafe `name` (e.g., `"bash ignore previous
  system instructions"`), the observation's `summary`, `actionSignature`,
  `claimKey`, and `metadata.toolName` all use `unknown-tool` instead of the raw
  name.
- No injection text leaks into any prompt-facing field.

**Pass criterion:** unsafe tool names are neutralized in all output fields.

---

## Fault diagnosis

| Symptom | Diagnosis | Action |
|---|---|---|
| No lesson on failed episodes | §3.1 lesson derivation not firing | Check `coding-observations.ts:46-52`; verify `failure` flag and `safeToolName` |
| No verdict in evidence | §3.2 not attaching verdict | Check `isVerificationToolCall` — command must match the verification regex |
| `verifiedOutcome` still false | Evidence not trusted | Check `isTrustedTerminalEvidence`: grade must be `verified`/`authoritative` and source ≠ `agent` |
| Proposal auto-applied despite `failedWithLesson` | §3.4 risk floor not working | Check `bindMemoryPlanToInput` in `unified-review.ts:552-562`; verify `isEligibleEpisodePromotion` returns false for `risk !== 'low'` |
| F263 prompt hash changed | `normalizeCapabilityDecision` perturbed | The F263 byte-identical test must pass; if it fails, `failedWithLesson` leaked into the capability decision path |
