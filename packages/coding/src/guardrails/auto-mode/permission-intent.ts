import { createHash } from 'node:crypto';
import type { KodaXMessage } from '@kodax-ai/llm';

export interface PermissionIntentEvidence {
  readonly status: 'complete' | 'targeted' | 'missing';
  readonly content: string;
  readonly sourceBytes: number;
  readonly includedBytes: number;
  readonly omittedBytes: number;
  readonly sha256: string;
}

export const MAX_PERMISSION_INTENT_BYTES = 6 * 1024;
const SLICE_CHARS = 480;
const AUTHORITY_TERMS = /\b(?:allow|approve|authorize|deny|forbid|must|never|outside|delete|move|write)\b|允许|授权|同意|禁止|不要|必须|工作区外|删除|移动|写入/i;

interface IntentSegment {
  readonly turn: number;
  readonly order: number;
  readonly text: string;
  readonly score: number;
}

export function buildPermissionIntentEvidence(
  messages: readonly KodaXMessage[],
  query: string,
  maxBytes = MAX_PERMISSION_INTENT_BYTES,
): PermissionIntentEvidence {
  const userTexts = messages.flatMap((message) => extractUserText(message));
  const source = userTexts.map((text, index) => `[user-turn:${index + 1}] ${text}`).join('\n');
  const sourceBytes = utf8Bytes(source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (userTexts.length === 0) {
    return {
      status: 'missing', content: '', sourceBytes: 0,
      includedBytes: 0, omittedBytes: 0, sha256,
    };
  }
  if (sourceBytes <= maxBytes) {
    return {
      status: 'complete', content: source, sourceBytes,
      includedBytes: sourceBytes, omittedBytes: 0, sha256,
    };
  }

  const terms = queryTerms(query);
  const segments = buildSegments(userTexts, terms);
  const selected = selectSegments(segments, maxBytes);
  const content = selected
    .sort((left, right) => left.turn - right.turn || left.order - right.order)
    .map((segment) => segment.text)
    .join('\n');
  const includedBytes = utf8Bytes(content);
  return {
    status: 'targeted', content, sourceBytes, includedBytes,
    omittedBytes: Math.max(0, sourceBytes - includedBytes), sha256,
  };
}

function extractUserText(message: KodaXMessage): string[] {
  if (message.role !== 'user') return [];
  if (typeof message.content === 'string') return message.content.trim() ? [message.content] : [];
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n');
  return text ? [text] : [];
}

function buildSegments(userTexts: readonly string[], terms: readonly string[]): IntentSegment[] {
  const segments: IntentSegment[] = [];
  for (let turn = 0; turn < userTexts.length; turn += 1) {
    const paragraphs = userTexts[turn]!.split(/\r?\n+/).filter(Boolean);
    for (let order = 0; order < paragraphs.length; order += 1) {
      const paragraph = paragraphs[order]!;
      const slices = relevantSlices(paragraph, terms);
      for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
        const slice = slices[sliceIndex]!;
        const label = `[user-turn:${turn + 1}] ${slice}`;
        segments.push({
          turn,
          order: order * 100 + sliceIndex,
          text: label,
          score: segmentScore(slice, terms, turn, userTexts.length),
        });
      }
    }
  }
  return segments;
}

function relevantSlices(text: string, terms: readonly string[]): string[] {
  if (text.length <= SLICE_CHARS) return [text];
  const starts = new Set<number>([0, Math.max(0, text.length - SLICE_CHARS)]);
  const lower = text.toLowerCase();
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      starts.add(Math.max(0, Math.min(text.length - SLICE_CHARS, index - Math.floor(SLICE_CHARS / 2))));
      index = lower.indexOf(term, index + term.length);
    }
  }
  return [...starts]
    .sort((left, right) => left - right)
    .filter((start, index, all) => index === 0 || start - all[index - 1]! >= SLICE_CHARS / 2)
    .map((start) => text.slice(start, start + SLICE_CHARS));
}

function segmentScore(
  text: string,
  terms: readonly string[],
  turn: number,
  turnCount: number,
): number {
  const lower = text.toLowerCase();
  const matches = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
  return matches * 100
    + (AUTHORITY_TERMS.test(text) ? 50 : 0)
    + (turn === turnCount - 1 ? 1_000 : turn);
}

function selectSegments(segments: readonly IntentSegment[], maxBytes: number): IntentSegment[] {
  const selected: IntentSegment[] = [];
  let remaining = Math.max(0, maxBytes);
  for (const segment of [...segments].sort((left, right) => right.score - left.score)) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const bytes = utf8Bytes(segment.text);
    if (bytes + separatorBytes <= remaining) {
      selected.push(segment);
      remaining -= bytes + separatorBytes;
    }
  }
  return selected;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.:/\\-]{3,}/gu) ?? [])]
    .sort((left, right) => right.length - left.length)
    .slice(0, 32);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
