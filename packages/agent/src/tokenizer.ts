/**
 * Provider-neutral, non-blocking token estimation.
 *
 * This intentionally avoids Provider-specific BPE vocabularies on the main
 * runtime thread. Provider usage remains the authoritative context baseline;
 * these estimates account for new messages and enforce protective budgets.
 */

import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';

const DENSE_ENCODED_MINIMUM_RUN = 512;
const DENSE_ENCODED_TOKENS_PER_UTF16_UNIT = 0.75;

/** Detect long Base64, Hex, or URL-safe encoded runs in linear time. */
export function looksLikeDenseEncodedData(text: string): boolean {
  let run = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const encoded =
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43
      || code === 45
      || code === 47
      || code === 61
      || code === 95;

    run = encoded ? run + 1 : 0;
    if (run >= DENSE_ENCODED_MINIMUM_RUN) return true;
  }

  return false;
}

/**
 * Provider-neutral multilingual estimate derived from UTF-8 bytes and UTF-16
 * code units. ASCII becomes 1 token / 4 units while common BMP Chinese is
 * approximately 1 token / code unit.
 */
export function estimateMultilingualTokens(text: string): number {
  if (!text) return 0;

  const utf16Units = text.length;
  const utf8Bytes = Buffer.byteLength(text, 'utf8');
  return Math.ceil((3 * utf8Bytes - utf16Units) / 8);
}

function countTextTokens(text: string): number {
  if (!text) return 0;

  const multilingual = estimateMultilingualTokens(text);
  const dense = looksLikeDenseEncodedData(text)
    ? text.length * DENSE_ENCODED_TOKENS_PER_UTF16_UNIT
    : 0;
  return Math.ceil(Math.max(multilingual, dense));
}

function countMessageTokens(message: KodaXMessage): number {
  let total = 4;

  if (typeof message.content === 'string') {
    total += countTextTokens(message.content);
  } else {
    for (const block of message.content as KodaXContentBlock[]) {
      if (block.type === 'text') {
        total += countTextTokens(block.text);
      } else if (block.type === 'tool_use') {
        total += countTextTokens(block.name);
        total += countTextTokens(JSON.stringify(block.input));
      } else if (block.type === 'tool_result') {
        total += 4;
        total += typeof block.content === 'string'
          ? countTextTokens(block.content)
          : block.content.reduce(
              (sum, item) => sum + (item.type === 'text' ? countTextTokens(item.text) : 1500),
              0,
            );
      } else if (block.type === 'thinking') {
        total += countTextTokens(block.thinking);
      } else if (block.type === 'image') {
        total += 1500;
      }
    }
  }

  return total;
}

/** Messages are immutable, so repeated budget checks only estimate new tails. */
const messageTokenCache = new WeakMap<KodaXMessage, number>();

export function estimateTokens(messages: readonly KodaXMessage[]): number {
  let total = 0;

  for (const message of messages) {
    const cached = messageTokenCache.get(message);
    if (cached !== undefined) {
      total += cached;
      continue;
    }
    const count = countMessageTokens(message);
    messageTokenCache.set(message, count);
    total += count;
  }

  return total;
}

/** Estimate a text value without loading a BPE vocabulary or token array. */
export function countTokens(text: string): number {
  return countTextTokens(text);
}
