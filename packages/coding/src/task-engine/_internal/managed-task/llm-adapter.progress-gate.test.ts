import { describe, expect, it } from 'vitest';

import type { Agent } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { KodaXOptions } from '../../../types.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

const agent = {
  name: 'progress-gate-worker',
  instructions: 'test',
  tools: [],
} as unknown as Agent;

describe('buildRunnerLlmAdapter semantic progress gate', () => {
  it.each([12, 24, 40])(
    'defers checkpoint %i past a real user correction to preserve the request prefix',
    async (checkpoint) => {
      const iterationState = { current: checkpoint - 1 };
      const captured: KodaXMessage[][] = [];
      const adapter = buildRunnerLlmAdapter(
        { provider: 'anthropic', events: {} } as KodaXOptions,
        async (messages) => {
          captured.push([...messages]);
          return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        iterationState,
      );

      const requestOne: KodaXMessage[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'task' },
      ];
      const firstResult = await adapter(requestOne, agent);

      expect(iterationState.current).toBe(checkpoint);
      expect(captured[0]?.at(-1)?.content).toBe('task');
      expect(firstResult.injectedInputMessages).toEqual([]);

      const authoritativeAfterFirstTurn: KodaXMessage[] = [
        ...requestOne,
        { role: 'assistant', content: 'working' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
        },
      ];
      const secondResult = await adapter(authoritativeAfterFirstTurn, agent);
      const secondRequest = captured[1] ?? [];
      expect(secondRequest.slice(0, authoritativeAfterFirstTurn.length - 1)).toEqual(
        authoritativeAfterFirstTurn.slice(1),
      );
      const reminder = secondRequest.at(-1);
      expect(reminder?._source).toBe('managed-runtime-reminder');
      expect(reminder?._synthetic).toBe(true);
      expect(reminder?.content).toContain(`SEMANTIC PROGRESS CHECKPOINT ${checkpoint}`);
      expect(secondResult.injectedInputMessages).toEqual([reminder]);
    },
  );

  it('recognizes multimodal user content as a real correction and defers the reminder', async () => {
    const iterationState = { current: 11 };
    let captured: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(
      { provider: 'anthropic', events: {} } as KodaXOptions,
      async (messages) => {
        captured = messages;
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      iterationState,
    );

    const result = await adapter(
      [
        { role: 'system', content: 'system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'please inspect this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
          ],
        },
      ],
      agent,
    );

    expect(captured.at(-1)?.role).toBe('user');
    expect(result.injectedInputMessages).toEqual([]);
  });

  it('does not inject a reminder on an ordinary iteration', async () => {
    const iterationState = { current: 12 };
    let captured: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(
      { provider: 'anthropic', events: {} } as KodaXOptions,
      async (messages) => {
        captured = messages;
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      iterationState,
    );

    await adapter(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'task' },
      ],
      agent,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.content).toBe('task');
  });
});
