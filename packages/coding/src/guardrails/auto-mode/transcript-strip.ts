/**
 * Transcript stripping for the auto-mode classifier — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * The classifier sees a SUBSET of the main session's transcript:
 *
 *   - user messages (text + tool_result status metadata) KEEP
 *   - assistant tool identity + safe operational metadata KEEP
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
 *   - maxToolResultBytes (default 2KB) — per-result metadata cap
 *   - maxTranscriptBytes (default 8KB) — total serialized size cap;
 *     drops middle messages first, preserves the first and latest genuine
 *     user intent messages plus recent factual tail context.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolResultBlock,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import {
  projectToolHistoryInput,
  redactClassifierProjection,
  type ClassifierToolProjectionResolver,
} from '../../tools/classifier-projection.js';

export interface StripOptions {
  readonly maxToolResultBytes?: number;
  readonly maxTranscriptBytes?: number;
  readonly getToolProjection?: ClassifierToolProjectionResolver;
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
  const toolNames = new Map<string, string>();

  // Pass 1: per-message stripping
  const stripped: KodaXMessage[] = [];
  for (const msg of messages) {
    const result = stripMessage(msg, maxToolResultBytes, opts.getToolProjection, toolNames);
    if (result !== null) stripped.push(result);
  }

  // Pass 2: overall size cap (preserve first/latest user intent + recent tail)
  return enforceTotalBudget(stripped, maxTranscriptBytes);
}

function stripMessage(
  msg: KodaXMessage,
  maxToolResultBytes: number,
  getToolProjection: ClassifierToolProjectionResolver | undefined,
  toolNames: Map<string, string>,
): KodaXMessage | null {
  if (msg.role === 'user' || msg.role === 'system') {
    if (typeof msg.content === 'string') {
      return msg;
    }
    // User message with block array — typically tool_result blocks. Images
    // and local image paths are irrelevant to a permission verdict, so keep
    // only text plus status-only tool-result metadata.
    const blocks: KodaXContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const truncated = summarizeToolResult(
          block,
          toolNames.get(block.tool_use_id),
          maxToolResultBytes,
        );
        blocks.push(truncated);
      } else if (block.type === 'text') {
        blocks.push(block);
      }
    }
    return { ...msg, content: blocks };
  }

  // role === 'assistant' — preserve tool identity and bounded operational
  // metadata. Free-form bodies and credentials stay with the main provider.
  if (typeof msg.content === 'string') {
    // Pure-text assistant message: drop entirely.
    return null;
  }
  const keep: KodaXToolUseBlock[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      toolNames.set(block.id, block.name);
      keep.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: projectToolHistoryInput(block.name, block.input, getToolProjection),
      });
    }
    // Drop: text, thinking, redacted_thinking, image (assistants don't emit
    // images today, but if they ever do, those don't help the classifier)
  }
  if (keep.length === 0) return null;
  return { ...msg, content: keep };
}

function summarizeToolResult(
  block: KodaXToolResultBlock,
  toolName: string | undefined,
  maxBytes: number,
): KodaXToolResultBlock {
  const counts = countToolResultContent(block.content);
  const safeToolName = redactClassifierProjection(toolName ?? 'unknown')
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, 64);
  const status = block.is_error === true ? 'error' : 'success';
  const summary = [
    `[tool_result tool=${safeToolName}`,
    `status=${status}`,
    `text_chars=${counts.textChars}`,
    `text_bytes=${counts.textBytes}`,
    `media_items=${counts.mediaItems}]`,
  ].join(' ');
  const content = truncateUtf8Text(summary, maxBytes);
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
  };
}

function countToolResultContent(content: KodaXToolResultBlock['content']): {
  textChars: number;
  textBytes: number;
  mediaItems: number;
} {
  if (typeof content === 'string') {
    return { textChars: content.length, textBytes: utf8Bytes(content), mediaItems: 0 };
  }
  let textChars = 0;
  let textBytes = 0;
  let mediaItems = 0;
  let textItems = 0;
  for (const item of content) {
    if (item.type !== 'text') {
      mediaItems += 1;
      continue;
    }
    if (textItems > 0) {
      textChars += 1;
      textBytes += 1;
    }
    textChars += item.text.length;
    textBytes += utf8Bytes(item.text);
    textItems += 1;
  }
  return { textChars, textBytes, mediaItems };
}

function enforceTotalBudget(
  messages: readonly KodaXMessage[],
  maxBytes: number,
): KodaXMessage[] {
  if (messages.length === 0) return [];
  const sized = messages.map((msg) => ({ msg, bytes: serializedBytes(msg) }));
  if (serializedTranscriptBytes(messages) <= maxBytes) return [...messages];
  if (maxBytes <= 2) return [];

  // Preserve both the original intent and the newest user constraint before
  // spending the remaining budget on factual tail context.
  const firstUserIdx = sized.findIndex((s) => isUserIntentMessage(s.msg));
  if (firstUserIdx === -1) {
    // No user messages — keep last few until budget fits
    return takeTail(sized, maxBytes);
  }

  const messageBudget = maxBytes - 2; // JSON array brackets
  const latestUserIdx = findLatestUserIntentIndex(sized);
  const selected = selectUserAnchors(sized, firstUserIdx, latestUserIdx, messageBudget);
  let remaining = messageBudget - serializedSelectionBytes(selected);

  for (let i = sized.length - 1; i > firstUserIdx; i -= 1) {
    if (selected.has(i)) continue;
    const candidate = sized[i]!;
    const addedBytes = candidate.bytes + (selected.size > 0 ? 1 : 0);
    if (addedBytes <= remaining) {
      selected.set(i, candidate.msg);
      remaining -= addedBytes;
      continue;
    }
    const separatorBytes = selected.size > 0 ? 1 : 0;
    const retained = truncateMessageToFit(candidate.msg, remaining - separatorBytes);
    if (retained) selected.set(i, retained);
    break;
  }

  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message);
}

function findLatestUserIntentIndex(
  sized: ReadonlyArray<{ msg: KodaXMessage; bytes: number }>,
): number {
  for (let i = sized.length - 1; i >= 0; i -= 1) {
    if (isUserIntentMessage(sized[i]!.msg)) return i;
  }
  return -1;
}

function isUserIntentMessage(message: KodaXMessage): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  return message.content.some((block) => block.type === 'text');
}

function selectUserAnchors(
  sized: ReadonlyArray<{ msg: KodaXMessage; bytes: number }>,
  firstUserIdx: number,
  latestUserIdx: number,
  messageBudget: number,
): Map<number, KodaXMessage> {
  const selected = new Map<number, KodaXMessage>();
  const first = sized[firstUserIdx]!;
  const userBudget = resolveUserAnchorBudget(
    sized,
    firstUserIdx,
    latestUserIdx,
    messageBudget,
  );
  if (firstUserIdx === latestUserIdx) {
    const retained = truncateMessageToFit(first.msg, Math.min(first.bytes, userBudget));
    if (retained) selected.set(firstUserIdx, retained);
    return selected;
  }

  const anchorBudget = Math.max(0, userBudget - 1); // separator
  let retainedFirst = truncateMessageToFit(first.msg, Math.floor(anchorBudget / 2));
  if (!retainedFirst) {
    const latestOnly = truncateMessageToFit(sized[latestUserIdx]!.msg, userBudget);
    if (latestOnly) selected.set(latestUserIdx, latestOnly);
    return selected;
  }
  const latestBudget = anchorBudget - serializedBytes(retainedFirst);
  const retainedLatest = truncateMessageToFit(sized[latestUserIdx]!.msg, latestBudget);
  if (!retainedLatest) {
    retainedFirst = truncateMessageToFit(first.msg, userBudget);
    if (retainedFirst) selected.set(firstUserIdx, retainedFirst);
    return selected;
  }
  const unusedBytes = latestBudget - serializedBytes(retainedLatest);
  if (unusedBytes > 0) {
    retainedFirst = truncateMessageToFit(
      first.msg,
      serializedBytes(retainedFirst) + unusedBytes,
    ) ?? retainedFirst;
  }
  selected.set(firstUserIdx, retainedFirst);
  selected.set(latestUserIdx, retainedLatest);
  return selected;
}

function resolveUserAnchorBudget(
  sized: ReadonlyArray<{ msg: KodaXMessage; bytes: number }>,
  firstUserIdx: number,
  latestUserIdx: number,
  messageBudget: number,
): number {
  const hasTail = sized.some((_, index) => (
    index > firstUserIdx && index !== latestUserIdx
  ));
  if (!hasTail) return messageBudget;
  const firstEmpty = serializedBytes({ role: 'user', content: '' });
  const minimum = firstUserIdx === latestUserIdx
    ? firstEmpty
    : firstEmpty * 2 + 1;
  return Math.min(messageBudget, Math.max(Math.floor(messageBudget / 2), minimum));
}

function serializedSelectionBytes(selected: ReadonlyMap<number, KodaXMessage>): number {
  const messageBytes = [...selected.values()]
    .reduce((total, message) => total + serializedBytes(message), 0);
  return messageBytes + Math.max(0, selected.size - 1);
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
