/**
 * Assistant message empty-content guard — CAP-073
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-073-empty-assistant-content-guard
 *
 * Class 1 (substrate). Guards against pushing an assistant message with
 * an empty content array onto the message history. This can happen when
 * the model only emits invisible tool calls (e.g. `emit_managed_protocol`)
 * with no text or thinking blocks — the user-visible filter strips them
 * out (`isVisibleToolName`), leaving `[...thinkingBlocks, ...textBlocks,
 * ...visibleToolBlocks]` empty.
 *
 * Some providers (Kimi being the canonical case) reject assistant
 * messages with empty content via a 400 error before the next
 * provider call can be made — the guard prevents that. Others tolerate
 * empty content but produce degenerate next turns. Either way, an
 * empty assistant message is a corrupt history shape; replacing it
 * with a minimal `[{ type: 'text', text: '' }]` marker is the cheapest
 * correct intervention.
 *
 * The marker is an EMPTY text block, NOT the literal `'...'`. A persisted
 * `'...'` leaks to the SDK output (`coding-preset.extractFinalAssistantText`)
 * and the REPL transcript as a fabricated assistant reply, and pollutes the
 * model's replayed context. The empty marker keeps history honest while
 * still occupying the assistant slot (preserving user/assistant alternation
 * and avoiding orphaned adjacent tool_result blocks). The visible `'...'`
 * placeholder is synthesized wire-only by the provider serializers
 * (anthropic.ts / openai.ts) ONLY when a gateway rejects empty content;
 * it is never written back into KodaX history. Mirrors the generic Agent
 * Runner convention (`runner-tool-loop.ts`: empty text block keeps a
 * message well-formed).
 *
 * Migration history: extracted from `agent.ts:1064-1070` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.3a. Switched from a
 * persisted `'...'` to an empty-text marker during the empty-content
 * placeholder root-cause fix.
 */

import type { KodaXContentBlock } from '@kodax-ai/llm';

export const EMPTY_ASSISTANT_CONTENT_PLACEHOLDER: KodaXContentBlock = {
  type: 'text',
  text: '',
};

/**
 * Return the input content unchanged when non-empty; otherwise return a
 * single-element array with the canonical placeholder text block.
 *
 * The function does NOT mutate `content` — callers receive a fresh
 * array on the placeholder path.
 */
export function guardEmptyAssistantContent(
  content: KodaXContentBlock[],
): KodaXContentBlock[] {
  if (content.length === 0) {
    return [EMPTY_ASSISTANT_CONTENT_PLACEHOLDER];
  }
  return content;
}
