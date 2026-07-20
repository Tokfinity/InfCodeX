/**
 * Transcript stripping for the auto-mode classifier — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * The classifier sees a SUBSET of the main session's transcript:
 *
 *   - user messages (text and tool_result blocks)         KEEP
 *   - assistant tool_use blocks (factual record)          KEEP
 *   - assistant text + thinking + redacted_thinking       DROP
 *
 * Why drop assistant reasoning:
 *   1. Prompt-injection defense — the main agent may have absorbed
 *      instructions from a poisoned tool_result; its reasoning could
 *      then propagate that injection to the classifier.
 *   2. Noise reduction — assistant prose dilutes the signal the
 *      classifier needs (user intent + actual tool calls).
 *   3. Cost — main-session reasoning can be tens of KB; classifier
 *      input should stay in the few-KB range.
 *
 * Two size budgets:
 *   - maxToolResultBytes (default 2KB) — per-tool_result content cap
 *   - maxTranscriptBytes (default 8KB) — total serialized size cap;
 *     drops middle messages first, preserves first user message
 *     (original intent) and recent tail.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolResultBlock,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';

export interface StripOptions {
  readonly maxToolResultBytes?: number;
  readonly maxTranscriptBytes?: number;
}

const DEFAULT_TOOL_RESULT_BYTES = 2 * 1024;
const DEFAULT_TRANSCRIPT_BYTES = 8 * 1024;
const TRUNCATION_SUFFIX = '\n…[truncated]…';

export function stripAssistantText(
  messages: readonly KodaXMessage[],
  opts: StripOptions = {},
): KodaXMessage[] {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES;
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? DEFAULT_TRANSCRIPT_BYTES;

  // Pass 1: per-message stripping
  const stripped: KodaXMessage[] = [];
  for (const msg of messages) {
    const result = stripMessage(msg, maxToolResultBytes);
    if (result !== null) stripped.push(result);
  }

  // Pass 2: overall size cap (preserve first user message + recent tail)
  return enforceTotalBudget(stripped, maxTranscriptBytes);
}

function stripMessage(msg: KodaXMessage, maxToolResultBytes: number): KodaXMessage | null {
  if (msg.role === 'user' || msg.role === 'system') {
    if (typeof msg.content === 'string') {
      return msg;
    }
    // User message with block array — typically tool_result blocks. Images
    // and local image paths are irrelevant to a permission verdict, so keep
    // only text plus normalized tool results.
    const blocks: KodaXContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const truncated = truncateToolResult(block, maxToolResultBytes);
        blocks.push(truncated);
      } else if (block.type === 'text') {
        blocks.push(block);
      }
    }
    return { ...msg, content: blocks };
  }

  // role === 'assistant' — keep only tool_use blocks
  if (typeof msg.content === 'string') {
    // Pure-text assistant message: drop entirely.
    return null;
  }
  const keep: KodaXToolUseBlock[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      keep.push(block);
    }
    // Drop: text, thinking, redacted_thinking, image (assistants don't emit
    // images today, but if they ever do, those don't help the classifier)
  }
  if (keep.length === 0) return null;
  return { ...msg, content: keep };
}

function truncateToolResult(
  block: KodaXToolResultBlock,
  maxBytes: number,
): KodaXToolResultBlock {
  const text = typeof block.content === 'string'
    ? block.content
    : block.content
      .filter((item) => item.type === 'text')
      .map((item) => item.type === 'text' ? item.text : '')
      .join('\n');
  const content = truncateUtf8Text(text, maxBytes);
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
  };
}

function enforceTotalBudget(
  messages: readonly KodaXMessage[],
  maxBytes: number,
): KodaXMessage[] {
  if (messages.length === 0) return [];
  const sized = messages.map((msg) => ({ msg, bytes: serializedBytes(msg) }));
  if (serializedTranscriptBytes(messages) <= maxBytes) return [...messages];
  if (maxBytes <= 2) return [];

  // Identify the first user message — always preserve it as the original intent.
  const firstUserIdx = sized.findIndex((s) => s.msg.role === 'user');
  if (firstUserIdx === -1) {
    // No user messages — keep last few until budget fits
    return takeTail(sized, maxBytes);
  }

  const head = sized[firstUserIdx]!;
  const messageBudget = maxBytes - 2; // JSON array brackets
  const after = sized.slice(firstUserIdx + 1);
  // Reserve half for recent factual context whenever the original intent is
  // itself large. A normal first prompt remains byte-for-byte.
  const headBudget = after.length > 0 && head.bytes > Math.floor(messageBudget / 2)
    ? Math.floor(messageBudget / 2)
    : Math.min(head.bytes, messageBudget);
  const retainedHead = truncateMessageToFit(head.msg, headBudget);
  if (!retainedHead) return [];
  let remaining = messageBudget - serializedBytes(retainedHead);

  // Take the recent tail that fits in the remaining budget
  const tail: KodaXMessage[] = [];
  for (let i = after.length - 1; i >= 0; i -= 1) {
    const s = after[i]!;
    const availableForMessage = remaining - 1; // comma separator
    if (availableForMessage <= 0) break;
    if (s.bytes <= availableForMessage) {
      tail.unshift(s.msg);
      remaining -= s.bytes + 1;
      continue;
    }
    // Preserve a bounded snapshot of the most recent oversized message.
    if (tail.length === 0) {
      const truncated = truncateMessageToFit(s.msg, availableForMessage);
      if (truncated) tail.unshift(truncated);
    }
    break;
  }

  return [retainedHead, ...tail];
}

function takeTail(
  sized: ReadonlyArray<{ msg: KodaXMessage; bytes: number }>,
  maxBytes: number,
): KodaXMessage[] {
  const out: KodaXMessage[] = [];
  if (maxBytes <= 2) return out;
  let remaining = maxBytes - 2; // JSON array brackets
  for (let i = sized.length - 1; i >= 0; i -= 1) {
    const s = sized[i]!;
    const availableForMessage = remaining - (out.length > 0 ? 1 : 0);
    if (s.bytes > availableForMessage) {
      if (out.length === 0 && availableForMessage > 0) {
        const truncated = truncateMessageToFit(s.msg, availableForMessage);
        if (truncated) out.unshift(truncated);
      }
      break;
    }
    out.unshift(s.msg);
    remaining -= s.bytes + (out.length > 1 ? 1 : 0);
  }
  return out;
}

function truncateMessageToFit(
  message: KodaXMessage,
  maxBytes: number,
): KodaXMessage | null {
  if (serializedBytes(message) <= maxBytes) return message;
  const source = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
  const empty: KodaXMessage = { role: message.role, content: '' };
  if (serializedBytes(empty) > maxBytes) return null;

  let low = 0;
  let high = source.length;
  let best = empty;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = safeCodeUnitSlice(source, mid);
    const candidate: KodaXMessage = {
      role: message.role,
      content: prefix.length > 0 ? prefix + TRUNCATION_SUFFIX : '',
    };
    if (serializedBytes(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateUtf8Text(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;
  if (utf8Bytes(TRUNCATION_SUFFIX) > maxBytes) return '';

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = safeCodeUnitSlice(text, mid);
    const candidate = prefix + TRUNCATION_SUFFIX;
    if (utf8Bytes(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function safeCodeUnitSlice(text: string, end: number): string {
  let safeEnd = end;
  if (safeEnd > 0) {
    const code = text.charCodeAt(safeEnd - 1);
    if (code >= 0xD800 && code <= 0xDBFF) safeEnd -= 1;
  }
  return text.slice(0, safeEnd);
}

function serializedBytes(message: KodaXMessage): number {
  return utf8Bytes(JSON.stringify(message));
}

function serializedTranscriptBytes(messages: readonly KodaXMessage[]): number {
  return utf8Bytes(JSON.stringify(messages));
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
