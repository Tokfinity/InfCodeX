/**
 * v0.7.35.1 FEATURE_142 (B-R1) — neutral compaction prompt candidates.
 *
 * Three prompt variants compared in `tests/compaction-prompt.eval.ts`:
 *
 *   - BASELINE_CODING_SUMMARY_PROMPT / BASELINE_CODING_UPDATE_SUMMARY_PROMPT
 *     The verbatim v0.7.35 prompt — coding-flavored. Kept as ground-truth
 *     baseline; will become CODING_SUMMARY_PROMPT in @kodax-ai/coding when the
 *     two-layer split lands.
 *
 *   - CANDIDATE_A_SUMMARY_PROMPT / CANDIDATE_A_UPDATE_SUMMARY_PROMPT
 *     Conservative neutral — same structure / length as baseline; only
 *     domain wording neutralized. Drops `## Files & Changes` schema section.
 *     Drops the 401-error coding example, replaces with a neutral one.
 *
 *   - CANDIDATE_B_SUMMARY_PROMPT / CANDIDATE_B_UPDATE_SUMMARY_PROMPT
 *     Aggressive neutral — A's neutralization plus collapses the 3 "EXACT…"
 *     bullets into one and drops the verbatim-rule example entirely. ~20%
 *     shorter. Same schema sections as A.
 *
 * Eval picks the winner by:
 *   - schema validity (must reach 100% on all variants)
 *   - recall on a 10-fixture dataset (5 coding + 5 non-coding) with annotated
 *     ground-truth facts that must survive compression
 *   - cross-domain consistency (non-coding recall ≈ coding recall)
 *   - length efficiency (output token count for equivalent recall)
 */

// ============================================================================
// BASELINE — verbatim v0.7.35 (will become CODING_*_SUMMARY_PROMPT post-split)
// ============================================================================

export const BASELINE_CODING_SUMMARY_PROMPT = `Create a structured summary for the conversation below.

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

export const BASELINE_CODING_UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

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

// ============================================================================
// CANDIDATE A — Conservative neutral
// ============================================================================
// Changes vs baseline:
//   - "another coding agent" → "another agent"
//   - File-specific recall bullet → "identifiers, references, and concrete locations"
//   - "HTTP status codes" → "status codes" (drops HTTP narrowing)
//   - "API endpoints, database tables, env vars" → "configuration values, parameter
//     values, and external resource names"
//   - 401-on-/api/auth/login example → neutral dependency-upgrade example
//   - Drops "## Files & Changes" schema section
//   - <read-files>/<modified-files> tag NAMES kept (parser dependency); description
//     broadened to "file paths, URLs, IDs, or other locations"

export const CANDIDATE_A_SUMMARY_PROMPT = `Create a structured summary for the conversation below.

This summary will be handed to another agent so it can continue the same task with minimal context.
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
- EXACT identifiers, references, and concrete locations the agent operated on or referenced
- EXACT error messages, status codes, and exception types
- EXACT configuration values, parameter values, and external resource names mentioned
- key decisions WITH reasoning (not just the choice)

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.
Never reduce "user asked to upgrade dependency X to v3.4 to resolve incompatibility with system Y"
to "user asked to fix an issue".

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

First, wrap your analysis in <analysis> tags:
- Walk through messages chronologically
- Note exact identifiers, references, error codes, configuration values
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

---

<read-files>
[One reference per line — file paths, URLs, IDs, or other locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Conversation:
`;

export const CANDIDATE_A_UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

Update the structured summary so another agent can continue the task immediately.
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
- EXACT identifiers, references, and concrete locations
- EXACT error messages, status codes, and exception types
- EXACT configuration values, parameter values, and external resource names
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

---

<read-files>
[One reference per line — file paths, URLs, IDs, or other locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Keep every section concise.`;

// ============================================================================
// CANDIDATE B — Aggressive neutral (shorter)
// ============================================================================
// Changes vs A:
//   - Collapses 3 "EXACT..." recall bullets into 1
//   - Drops the "Never reduce..." example entirely (keeps the verbatim rule)
//   - ~20% shorter overall

export const CANDIDATE_B_SUMMARY_PROMPT = `Create a structured summary for the conversation below.

This summary will be handed to another agent so it can continue the same task with minimal context.
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
- EXACT identifiers, locations, error codes, status codes, and configuration values mentioned
- key decisions WITH reasoning (not just the choice)

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

First, wrap your analysis in <analysis> tags:
- Walk through messages chronologically
- Note exact identifiers, references, error codes, configuration values
- Identify user's explicit requests vs inferred intent
- Flag technical details that MUST survive compression

Then output the structured summary in <summary> tags.

Output format (strict markdown, inside <summary> tags):

## Goal
[1-2 sentences describing the active goal]

## Constraints & Preferences
- [One item per line, or "None"]

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

---

<read-files>
[One reference per line — locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Conversation:
`;

export const CANDIDATE_B_UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

Update the structured summary so another agent can continue the task immediately.
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
- EXACT identifiers, locations, error codes, status codes, and configuration values
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

---

<read-files>
[One reference per line — locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Keep every section concise.`;

export type CandidateName = 'baseline-coding' | 'candidate-a-conservative' | 'candidate-b-aggressive';

export interface CandidatePromptPair {
  readonly name: CandidateName;
  readonly summaryPrompt: string;
  readonly updateSummaryPrompt: string;
}

export const ALL_CANDIDATES: readonly CandidatePromptPair[] = Object.freeze([
  {
    name: 'baseline-coding',
    summaryPrompt: BASELINE_CODING_SUMMARY_PROMPT,
    updateSummaryPrompt: BASELINE_CODING_UPDATE_SUMMARY_PROMPT,
  },
  {
    name: 'candidate-a-conservative',
    summaryPrompt: CANDIDATE_A_SUMMARY_PROMPT,
    updateSummaryPrompt: CANDIDATE_A_UPDATE_SUMMARY_PROMPT,
  },
  {
    name: 'candidate-b-aggressive',
    summaryPrompt: CANDIDATE_B_SUMMARY_PROMPT,
    updateSummaryPrompt: CANDIDATE_B_UPDATE_SUMMARY_PROMPT,
  },
]);
