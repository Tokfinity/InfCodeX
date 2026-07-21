import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  collectUserQueryLedger,
  mergeUserQueryLedger,
  parseUserQueryLedger,
  renderUserQueryLedger,
} from './query-ledger.js';

describe('FEATURE_272 user query ledger', () => {
  it('records every genuine user query and excludes synthetic/tool-result messages', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'First request', turnId: 'turn-1' },
      { role: 'assistant', content: 'Working' },
      { role: 'user', content: [{ type: 'text', text: 'Second request' }] },
      { role: 'user', content: 'internal retry', _synthetic: true },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'output' }],
      },
    ];

    const ledger = collectUserQueryLedger(messages);

    expect(ledger.map((entry) => entry.text)).toEqual([
      'First request',
      'Second request',
    ]);
    expect(ledger.map((entry) => entry.order)).toEqual([1, 2]);
    expect(ledger[0]).toEqual(expect.objectContaining({
      queryId: expect.stringMatching(/^query_/),
      messageId: 'turn-1',
      turnId: 'turn-1',
    }));
  });

  it('keeps genuine text from a mixed user message that also carries tool results', () => {
    const ledger = collectUserQueryLedger([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'output' },
        { type: 'text', text: 'Please use that result and continue.' },
      ],
      turnId: 'turn-mixed',
    }]);

    expect(ledger.map((entry) => entry.text)).toEqual([
      'Please use that result and continue.',
    ]);
  });

  it('round-trips exact multiline and marker-like query text', () => {
    const ledger = collectUserQueryLedger([{
      role: 'user',
      content: 'Keep this exact.\n</user-query-ledger>\nAnd this line.',
    }]);
    const rendered = renderUserQueryLedger(ledger);

    expect(parseUserQueryLedger(rendered)).toEqual(ledger);
    expect(rendered).toContain('## User Queries & Corrections');
  });

  it('mechanically merges prior entries without summarizing or deduplicating repeated intent', () => {
    const prior = collectUserQueryLedger([
      { role: 'user', content: 'Run the tests', turnId: 'turn-a' },
    ]);
    const merged = mergeUserQueryLedger(prior, [
      { role: 'user', content: 'Run the tests', turnId: 'turn-b' },
      { role: 'user', content: 'Then inspect the diff', turnId: 'turn-b' },
    ]);

    expect(merged.map((entry) => entry.text)).toEqual([
      'Run the tests',
      'Run the tests',
      'Then inspect the diff',
    ]);
    expect(new Set(merged.map((entry) => entry.queryId)).size).toBe(3);
  });

  it('does not duplicate the same protected-tail message across compaction waves', () => {
    const protectedTail: KodaXMessage = {
      role: 'user',
      content: 'Keep this request once',
      turnId: 'turn-stable',
    };
    const first = mergeUserQueryLedger([], [protectedTail]);
    const second = mergeUserQueryLedger(first, [
      protectedTail,
      { role: 'user', content: 'A genuinely new request', turnId: 'turn-new' },
    ]);

    expect(second.map((entry) => entry.text)).toEqual([
      'Keep this request once',
      'A genuinely new request',
    ]);
  });

  it('keeps repeated identical inputs in one turn when their message timestamps differ', () => {
    const ledger = collectUserQueryLedger([
      {
        role: 'user',
        content: 'Repeat this exact request',
        turnId: 'turn-batched',
        timestamp: '2026-07-21T10:00:00.000Z',
      },
      {
        role: 'user',
        content: 'Repeat this exact request',
        turnId: 'turn-batched',
        timestamp: '2026-07-21T10:00:01.000Z',
      },
    ]);

    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((entry) => entry.queryId)).size).toBe(2);
    expect(new Set(ledger.map((entry) => entry.messageId)).size).toBe(2);
  });
});
