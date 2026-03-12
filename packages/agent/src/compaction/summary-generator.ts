/**
 * @kodax/agent Compaction Summary Generator
 *
 * Generates continuation-oriented summaries for compacted conversations.
 */

import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';
import type { CompactionDetails } from './types.js';
import { serializeConversation } from './utils.js';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant.
Read the conversation history and produce a compact continuation summary.

Do not continue the conversation.
Do not answer any user requests.
Only output the requested structured summary.`;

const SUMMARY_PROMPT = `Create a structured summary for the conversation below.

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
- key files, code locations, and decisions

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

Output format (strict markdown):

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
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Conversation:
`;

const UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

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
- exact file paths, function names, and key decisions when they remain relevant

Do not accumulate every past detail. Compress aggressively while keeping continuation-critical context.

Output format (strict markdown):

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
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Keep every section concise.`;

export async function generateSummary(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  details: CompactionDetails,
  customInstructions?: string,
  systemPrompt?: string,
  previousSummary?: string
): Promise<string> {
  const conversationText = serializeConversation(messages);

  let basePrompt = previousSummary ? UPDATE_SUMMARY_PROMPT : SUMMARY_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional instructions: ${customInstructions}`;
  }

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  promptText += `\n\n---\nFile tracking:\n`;
  promptText += `Read files: ${details.readFiles.length > 0 ? details.readFiles.join(', ') : 'None'}\n`;
  promptText += `Modified files: ${details.modifiedFiles.length > 0 ? details.modifiedFiles.join(', ') : 'None'}\n`;

  const result = await provider.stream(
    [{ role: 'user', content: promptText }],
    [],
    systemPrompt || SUMMARIZATION_SYSTEM_PROMPT,
    false,
    undefined,
    undefined
  );

  return result.textBlocks.map(block => block.text).join('\n');
}
