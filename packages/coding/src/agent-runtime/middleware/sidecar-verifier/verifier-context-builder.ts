/**
 * FEATURE_184 (v0.7.45) — Production Sidecar Verifier context builder.
 *
 * Phase D.2 plumbing. Extracts the verifier's input context from the
 * StopHookContext (transcript + lastAssistantText) plus per-run side
 * channels (ManagedMutationTracker file edits, future:
 * tool_use sequence, scout/planner artifacts).
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D.2
 */

import type { KodaXMessage } from '@kodax-ai/llm';
import type { ManagedMutationTracker } from '../../../types.js';
import type { SidecarVerifierContextInputs } from './verifier.js';

const ROLLING_BUFFER_SIZE = 24;

/**
 * Extract the user messages that belong to the CURRENT turn. Strategy:
 * walk backwards through the transcript and collect contiguous
 * user-role messages until the first assistant-role message is hit.
 * Those messages are what the user asked in the most recent
 * conversational unit — verifier must see them in full to judge whether
 * the agent's answer satisfies the ask.
 *
 * Edge case: an empty transcript or one with only system messages
 * yields zero queries (verifier sees "no current-turn queries" — the
 * prompt explicitly handles this case).
 */
export function extractCurrentTurnUserQueries(
  transcript: readonly KodaXMessage[],
): string[] {
  const queries: string[] = [];
  // Iterate backwards from the end of the transcript.
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const msg = transcript[i];
    if (!msg) continue;
    if (msg.role === 'assistant') {
      // Found the boundary — anything before this is from a prior turn.
      // BUT we keep going if we haven't found any user messages yet
      // (skip the assistant terminus message itself).
      if (queries.length > 0) break;
      continue;
    }
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : extractTextFromContentBlocks(msg.content);
      if (text.trim()) {
        queries.unshift(text);
      }
    }
    // Skip system / tool messages — not user queries
  }
  return queries;
}

function extractTextFromContentBlocks(
  content: KodaXMessage['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        out.push(block.text);
      } else if (block.type === 'tool_result' && 'content' in block) {
        // Tool result blocks — skip; not user-authored.
        continue;
      }
    }
  }
  return out.join('\n');
}

/**
 * Take the last `ROLLING_BUFFER_SIZE` messages from the transcript for
 * the verifier's "recent conversational context". Drops `system` role
 * messages (verifier has its own system prompt; main agent's would
 * confuse role separation).
 */
export function extractRollingBuffer(
  transcript: readonly KodaXMessage[],
): KodaXMessage[] {
  const filtered = transcript.filter((m) => m.role !== 'system');
  if (filtered.length <= ROLLING_BUFFER_SIZE) return filtered;
  return filtered.slice(filtered.length - ROLLING_BUFFER_SIZE);
}

/**
 * Build a file-edit summary from the ManagedMutationTracker.
 *
 * `ManagedMutationTracker.files` is `Map<path, opCount>` (types.ts:966).
 * Verifier sees `path: N op(s)` rows — enough to compare "agent claimed
 * X edits" against "tracker observed Y mutations". A future iteration
 * can enrich the tracker with diff previews; for v0.7.45 op-count
 * presence is sufficient to detect the "claimed-completion-without-
 * actual-edits" case the verifier most needs to catch.
 */
export function buildFileEditSummary(
  mutationTracker: ManagedMutationTracker | undefined,
): { path: string; diffHint: string }[] {
  if (!mutationTracker) return [];
  const out: { path: string; diffHint: string }[] = [];
  for (const [path, opCount] of mutationTracker.files) {
    const label = opCount === 1 ? '1 mutation' : `${opCount} mutations`;
    out.push({ path, diffHint: label });
  }
  return out;
}

export interface BuildVerifierContextOptions {
  readonly transcript: readonly KodaXMessage[];
  readonly lastAssistantText: string;
  readonly mutationTracker?: ManagedMutationTracker;
}

/**
 * Build the full `SidecarVerifierContextInputs` from a StopHookContext
 * + side-channel state. Pure composition of the three extractors
 * above.
 */
export function buildVerifierContext(
  options: BuildVerifierContextOptions,
): SidecarVerifierContextInputs {
  return {
    currentTurnUserQueries: extractCurrentTurnUserQueries(options.transcript),
    recentTranscript: extractRollingBuffer(options.transcript),
    fileEditSummary: buildFileEditSummary(options.mutationTracker),
    lastAssistantText: options.lastAssistantText,
  };
}
