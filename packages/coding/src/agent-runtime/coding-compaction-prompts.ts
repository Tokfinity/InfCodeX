/**
 * v0.7.35.1 FEATURE_142 (B-R1) — Coding-flavored compaction summary prompts.
 *
 * These are the verbatim v0.7.35 compaction prompts (byte-identical to
 * the prior `SUMMARY_PROMPT` / `UPDATE_SUMMARY_PROMPT` constants in
 * `@kodax-ai/agent/src/compaction/summary-generator.ts`). They
 * remain the empirically best-performing prompts on the coding domain
 * (96.7% recall on the 10-fixture eval; see
 * `tests/compaction-prompt.eval.ts`) AND happen to also be the best on
 * the non-coding domain (97.0% recall) in the same eval — the wording
 * is coding-flavored but the structure generalizes.
 *
 * Why they live here: per ADR-021, @kodax-ai/agent is the
 * generic compaction primitive package and must not enumerate
 * coding-specific language ("coding agent", "file paths, function
 * names", "HTTP status codes", "## Files & Changes") in its public
 * prompt strings. Those strings now live in the @kodax-ai/coding layer
 * and are passed downward via the `summaryPrompt` /
 * `updateSummaryPrompt` parameters of `compact()` /
 * `buildCompactionPromptSnapshot()` / `generateSummary()`.
 *
 * Coding-flow callers (currently `compaction-orchestration.ts` and
 * `repl/.../commands.ts`) pass these constants explicitly so the
 * coding path produces a byte-equivalent prompt to v0.7.35 — preserving
 * the empirically validated 96.7% recall.
 *
 * Generic / non-coding consumers of @kodax-ai/agent get the
 * neutral `DEFAULT_SUMMARY_PROMPT` / `DEFAULT_UPDATE_SUMMARY_PROMPT`
 * (the candidate-a-conservative eval winner) by default — they pay a
 * 2-3pt non-coding recall cost for not knowing they should pass these
 * coding-flavored prompts, but their architectural surface stays clean.
 */

export const CODING_SUMMARY_PROMPT = `Create a structured summary for the conversation below.

This summary will be handed to another coding agent so it can continue the same task with minimal context.
Keep only information that is still useful for continuing the work.

You may drop:
- completed low-value micro-steps
- repetitive thinking
- stale intermediate plans
- verbose tool output details

You must keep:
- the current goal
- user constraints and preferences
- current progress and unfinished work
- blockers or unresolved questions
- the most important next steps
- EXACT file paths, function names, and line numbers referenced
- EXACT error messages, HTTP status codes, and exception types
- API endpoints, database tables, env vars, and config values mentioned
- key decisions WITH reasoning (not just the choice)

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.
Never reduce "user asked to fix the 401 error on /api/auth/login by switching to JWT"
to "user asked to fix an error".

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

First, wrap your analysis in <analysis> tags:
- Walk through messages chronologically
- Note exact file paths, function names, error codes, config values
- Identify user's explicit requests vs inferred intent
- Flag technical details that MUST survive compression

Then output the structured summary in <summary> tags.

Output format (strict markdown, inside <summary> tags):

## Goal
[1-2 sentences describing the active goal]

## Constraints & Preferences
- [One item per line]
- [Write "None" if there are no explicit constraints]

## Progress
### Completed
- [x] [Completed work that still matters for context]

### In Progress
- [ ] [Current work that is actively underway]

### Blockers
- [Current blockers, or "None"]

## Key Decisions
- **[Decision]**: [Short reason]

## Next Steps
1. [Highest-priority next action]

## Key Context
- [Critical context needed to continue]

## Files & Changes
- **[exact path]**: [what was done and why]

---

<read-files>
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Conversation:
`;

export const CODING_UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

Update the structured summary so another coding agent can continue the task immediately.
Keep only the information needed to continue the work.

You may remove:
- repetitive or superseded plans
- completed low-value steps
- outdated blockers
- noisy tool output details

You must preserve or update:
- the current goal
- user constraints and preferences
- current progress and unfinished work
- blockers that still matter
- next steps based on the latest state
- EXACT file paths, function names, and line numbers
- EXACT error messages, HTTP status codes, and exception types
- API endpoints, database tables, env vars, and config values
- key decisions WITH reasoning

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.

Do not accumulate every past detail. Compress aggressively while keeping continuation-critical context.

First, wrap your analysis in <analysis> tags, then output the summary in <summary> tags.

Output format (strict markdown, inside <summary> tags):

## Goal
[Updated goal]

## Constraints & Preferences
- [Relevant constraints only]

## Progress
### Completed
- [x] [Completed work that still matters]

### In Progress
- [ ] [Active work in the latest state]

### Blockers
- [Current blockers, or "None"]

## Key Decisions
- **[Decision]**: [Short reason]

## Next Steps
1. [Most relevant next action]

## Key Context
- [Critical context needed to continue]

## Files & Changes
- **[exact path]**: [what was done and why]

---

<read-files>
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Keep every section concise.`;
