/**
 * FEATURE_124 (v0.7.43) Phase C — `memory-rules` SP section.
 *
 * LLM teaching text for the per-project memory subsystem. Mirrors
 * claudecode `src/memdir/memdir.ts:buildMemoryLines` + `memoryTypes.ts`
 * sections (TYPES_SECTION_INDIVIDUAL + WHAT_NOT_TO_SAVE_SECTION +
 * WHEN_TO_ACCESS_SECTION + TRUSTING_RECALL_SECTION) — text is reused
 * because claudecode shipped these blocks after explicit eval iteration
 * (e.g. memoryTypes.ts L209-214 documents `tengu_coral_fern` ignore-bullet
 * eval; L235-238 documents H5 noise-rejection eval) and re-deriving the
 * wording would re-pay that prompt-eval cost.
 *
 * KodaX-specific deltas vs claudecode:
 *   - Section header `# Memory (per-project)` (KodaX has no KAIROS
 *     daily-log mode, so the `# auto memory` claudecode header would
 *     mislead — KodaX always uses topic files + MEMORY.md index)
 *   - References `<repo>/AGENTS.md` (KodaX file name) instead of
 *     `CLAUDE.md`
 *   - Two-step save procedure explicitly says PREPEND to MEMORY.md (top
 *     of file) so the natural-LRU index ordering documented in
 *     docs/features/v0.7.43.md Step 3 emerges from LLM behavior
 *   - GC responsibilities section calls out `Bash rm <file>` since
 *     KodaX deliberately has no `delete_memory` tool — LLM owns GC via
 *     existing tools per the zero-custom-tool design judgement
 *
 * Section position (per capability-sections.ts hook):
 *   project-agents (AGENTS.md, user-managed)
 *     ↓
 *   memory-rules (this section — LLM teaching text)
 *     ↓
 *   project-memory (Phase B — MEMORY.md index content)
 *     ↓
 *   skills-addendum
 */

import * as path from 'node:path';

import { resolveMemoryRoot } from '@kodax-ai/agent';

/**
 * Build the `memory-rules` SP section content for the given cwd.
 *
 * Sync + side-effect-free. The memoryDir is resolved via the Phase A
 * substrate so any agent-config-home override propagates correctly.
 */
export function buildMemoryRulesSection(cwd: string): string {
  const memoryDir = resolveMemoryRoot(cwd);
  return MEMORY_RULES_LINES(memoryDir).join('\n');
}

/**
 * The full memory-rules SP block, line-by-line for easy diff review.
 * Caller joins with '\n'. Memory directory path is interpolated once at
 * the top — the rest of the text is path-independent so prompt cache
 * stays stable across `setAgentConfigHome()` overrides that happen
 * after first cache build.
 */
function MEMORY_RULES_LINES(memoryDir: string): string[] {
  // Use forward slashes in the displayed path even on Windows so the
  // prompt body stays platform-stable (and matches how shell snippets
  // in the body — `Bash rm <file>` — are typically demonstrated).
  const displayDir = memoryDir.split(path.sep).join('/');
  return [
    '# Memory (per-project)',
    '',
    `You have a persistent, file-based memory system at \`${displayDir}\`. The directory is created on first write — you may write to it directly with the Write tool (do not run mkdir or check for its existence first).`,
    '',
    'You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they would like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.',
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION,
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...HOW_TO_SAVE_SECTION,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    ...MEMORY_VS_OTHER_PERSISTENCE_SECTION,
  ];
}

// ── 4-type taxonomy (mirrors claudecode TYPES_SECTION_INDIVIDUAL) ──────────────
//
// Reproduced with permission of the eval ground truth — these examples
// went through claudecode's memory-prompt-iteration eval and the wording
// is load-bearing. Changing examples here without a new eval is
// regression-prone.

const TYPES_SECTION: readonly string[] = [
  '## Types of memory',
  '',
  'There are several discrete types of memory that you can store in your memory system:',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  '    <examples>',
  "    user: I'm a data scientist investigating what logging we have in place",
  '    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]',
  '',
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>',
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  '    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>',
  '    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>',
  '    <examples>',
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  '    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]',
  '',
  '    user: stop summarizing what you just did at the end of every response, I can read the diff',
  '    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]',
  '',
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  '    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>',
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
  '    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>',
  '    <examples>',
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  '    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]',
  '',
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  '    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>',
  '    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>',
  '    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>',
  '    <examples>',
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  '',
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
  '    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]',
  '    </examples>',
  '</type>',
  '</types>',
];

// ── What NOT to save ──────────────────────────────────────────────────────────
// Replaces `CLAUDE.md` (claudecode) with `AGENTS.md` (KodaX file name).

const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in `AGENTS.md` or `CLAUDE.md` files in the repo.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
];

// ── How to save + GC responsibilities (KodaX extension) ───────────────────────
//
// Two-step save with KodaX-specific PREPEND-to-top requirement (natural
// LRU ordering — see docs/features/v0.7.43.md Step 3). GC responsibilities
// mirror claudecode "update or remove outdated" + "no duplicate" rules.

const HOW_TO_SAVE_SECTION: readonly string[] = [
  '## How to save memories',
  '',
  'Saving a memory is a two-step process:',
  '',
  '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_no_mock_db.md`, `project_q2.md`, `reference_grafana.md`) using this frontmatter format:',
  '',
  '```markdown',
  '---',
  'name: {{short title shown in the MEMORY.md index}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  'type: {{user, feedback, project, reference}}',
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
  '',
  '**Step 2** — Edit `MEMORY.md` to prepend a one-line entry AT THE TOP of the file:',
  '',
  '`- [<title>](<filename>.md) — <one-line hook under ~150 chars>`',
  '',
  '`MEMORY.md` is an index, not a memory file. Each entry must be one line. Never write the memory body directly into `MEMORY.md`. The full body lives in the topic file; the index entry is what is loaded into your conversation context.',
  '',
  'Prepending to the top creates a natural-LRU index ordering: recent memories stay visible while older entries sink. The index is capped at 200 lines / 25 KB — entries below the cap are silently truncated from the context that future sessions see, so keep the index concise.',
  '',
  '## GC responsibilities',
  '',
  'Memory does not auto-expire. You are responsible for keeping it tidy:',
  '',
  '- **Before writing**, check whether an existing memory already covers the topic. If yes, `Edit` it instead of creating a duplicate. Use `Grep` over the memory directory to find existing entries by keyword.',
  '- **Update or remove memories that turn out to be wrong or outdated**:',
  '  - To update: `Edit <file>` and rewrite the body. Update the MEMORY.md index line if the description changed.',
  '  - To remove: `Bash rm <file>` then `Edit MEMORY.md` to delete the index line.',
  '- **Stale memory encountered during use** → do not work around it. Update or delete it on the spot.',
  '',
  '- Keep the `name`, `description`, and `type` fields up to date with the body.',
  '- Organize memory semantically by topic, not chronologically. Two memories about the same topic should be merged into one file.',
];

// ── When to access (mirrors claudecode WHEN_TO_ACCESS_SECTION) ─────────────────
//
// "ignore" bullet is eval-validated (memoryTypes.ts L209-214 cites
// `tengu_coral_fern` ignore-bullet eval — failure mode was "treats
// 'ignore' as 'acknowledge then override'"). Drift caveat is the
// "verify before answering" cue.

const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.',
];

// ── Before recommending from memory (mirrors claudecode TRUSTING_RECALL_SECTION) ──
//
// Header "Before recommending" tested 3/3 vs abstract "Trusting what you
// recall" 0/3 (memoryTypes.ts L242-244) — action-cue at decision point
// wins over abstract framing. Don't rename.

const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
  '',
  'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
];

// ── Memory vs other persistence (KodaX extension; claudecode has equivalent) ──

const MEMORY_VS_OTHER_PERSISTENCE_SECTION: readonly string[] = [
  '## Memory and other forms of persistence',
  '',
  'Memory is one of several persistence mechanisms available to you. The distinction is that memory can be recalled in future conversations, so it should not be used for persisting information that is only useful within the scope of the current conversation.',
  '',
  '- **Plans / todos** instead of memory: when breaking down work into discrete steps for the CURRENT task, use `todo_create` / `todo_update`. Tasks completed in this conversation are not memory-worthy unless they revealed something surprising.',
  '- **AGENTS.md / CLAUDE.md** instead of memory: code conventions, architecture decisions, project-permanent rules go to `<repo>/AGENTS.md` (user-maintained). If the user states a permanent project rule, suggest they add it to `AGENTS.md` instead of saving to memory.',
  '- **Git commits** instead of memory: who changed what, when, and why is in `git log` / `git blame` / commit messages. Memory should not duplicate that record.',
];
