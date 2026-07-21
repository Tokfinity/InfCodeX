import { createHash } from 'node:crypto';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';

const LEDGER_START = '<user-query-ledger format="jsonl" version="1">';
const LEDGER_END = '</user-query-ledger>';

export interface UserQueryLedgerEntry {
  readonly queryId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly order: number;
  readonly text: string;
  readonly supersedesQueryId?: string;
}

function queryText(message: KodaXMessage): string | undefined {
  if (message.role !== 'user' || message._synthetic === true) return undefined;
  if (typeof message.content === 'string') {
    return message.content.trim() ? message.content : undefined;
  }
  const text = message.content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> => (
      block.type === 'text'
    ))
    .map((block) => block.text)
    .join('\n');
  return text.trim() ? text : undefined;
}

function createQueryId(
  message: KodaXMessage,
  order: number,
  text: string,
): string {
  const stableMessageIdentity = [message.turnId, message.timestamp]
    .filter((value): value is string => value !== undefined)
    .join('\0') || undefined;
  return `query_${createHash('sha256')
    .update(stableMessageIdentity === undefined
      ? `legacy\0${order}\0${text}`
      : `stable\0${stableMessageIdentity}\0${text}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function collectUserQueryLedger(
  messages: readonly KodaXMessage[],
  startOrder = 1,
): UserQueryLedgerEntry[] {
  const entries: UserQueryLedgerEntry[] = [];
  for (const message of messages) {
    const text = queryText(message);
    if (text === undefined) continue;
    const order = startOrder + entries.length;
    const queryId = createQueryId(message, order, text);
    const turnId = message.turnId ?? `legacy-turn-${order}`;
    const messageId = [message.turnId, message.timestamp]
      .filter((value): value is string => value !== undefined)
      .join(':') || queryId;
    entries.push({
      queryId,
      messageId,
      turnId,
      order,
      text,
    });
  }
  return entries;
}

export function mergeUserQueryLedger(
  existing: readonly UserQueryLedgerEntry[],
  messages: readonly KodaXMessage[],
): UserQueryLedgerEntry[] {
  const nextOrder = existing.reduce(
    (largest, entry) => Math.max(largest, entry.order),
    0,
  ) + 1;
  const existingIds = new Set(existing.map((entry) => entry.queryId));
  const additions = collectUserQueryLedger(messages, nextOrder)
    .filter((entry) => !existingIds.has(entry.queryId));
  return [...existing, ...additions];
}

export function renderUserQueryLedger(
  entries: readonly UserQueryLedgerEntry[],
): string {
  return [
    '## User Queries & Corrections',
    LEDGER_START,
    ...entries.map((entry) => JSON.stringify(entry)),
    LEDGER_END,
  ].join('\n');
}

function isLedgerEntry(value: unknown): value is UserQueryLedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.queryId === 'string'
    && typeof entry.messageId === 'string'
    && typeof entry.turnId === 'string'
    && Number.isSafeInteger(entry.order)
    && typeof entry.text === 'string'
    && (entry.supersedesQueryId === undefined || typeof entry.supersedesQueryId === 'string');
}

export function parseUserQueryLedger(content: string): UserQueryLedgerEntry[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === LEDGER_START);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line === LEDGER_END);
  if (end < 0) return [];

  const entries: UserQueryLedgerEntry[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isLedgerEntry(parsed)) return [];
      entries.push(parsed);
    } catch {
      return [];
    }
  }
  return entries;
}
