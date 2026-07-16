/**
 * Kimi public API and Kimi Code real-wire smoke tests.
 *
 * Skipped by default because they spend API quota. Run explicitly with:
 *
 *   KODAX_INTEGRATION_TEST=1 KIMI_API_KEY=... npx vitest run \
 *     packages/llm/src/providers/kimi-wire.integration.test.ts
 *
 * Set KIMI_CODE_API_KEY as well to exercise the subscription endpoint.
 *
 * These are mechanical compatibility checks, not prompt-quality evals.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolDefinition } from '../types.js';
import { resolveProvider } from './resolver.js';

const RUN_INTEGRATION =
  process.env.KODAX_INTEGRATION_TEST === '1' && Boolean(process.env.KIMI_API_KEY);
const RUN_KIMI_CODE_INTEGRATION =
  process.env.KODAX_INTEGRATION_TEST === '1' && Boolean(process.env.KIMI_CODE_API_KEY);

const EMIT_RESULT_TOOL: KodaXToolDefinition = {
  name: 'emit_result',
  description: 'Return the requested test result.',
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string', enum: ['ok'] },
    },
    required: ['value'],
  },
};

describe.skipIf(!RUN_INTEGRATION)('Kimi public API — real provider HTTP', () => {
  it('streams the default K2.7 model with both thinking and text', async () => {
    const provider = resolveProvider('kimi');

    expect(provider.getModel()).toBe('kimi-k2.7-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'high' },
      { maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('recovers when K2.7 rejects a forced tool choice', async () => {
    const provider = resolveProvider('kimi');

    const result = await provider.stream(
      [{ role: 'user', content: 'Call emit_result with value "ok". Do not answer in plain text.' }],
      [EMIT_RESULT_TOOL],
      'Use the provided tool to return the result.',
      { enabled: true, effort: 'high' },
      {
        forcedToolName: 'emit_result',
        maxOutputTokensOverride: 2_048,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.toolBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'emit_result' }),
      ]),
    );

    const toolCall = result.toolBlocks[0];
    expect(toolCall).toBeDefined();
    if (!toolCall) return;

    const followUp = await provider.stream(
      [
        { role: 'user', content: 'Call emit_result with value "ok". Do not answer in plain text.' },
        {
          role: 'assistant',
          content: [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolCall.id, content: '{"accepted":true}' },
          ],
        },
      ],
      [EMIT_RESULT_TOOL],
      'Use the provided tool to return the result, then acknowledge its result.',
      { enabled: true, effort: 'high' },
      { maxOutputTokensOverride: 2_048 },
      AbortSignal.timeout(45_000),
    );

    expect(
      followUp.thinkingBlocks.length + followUp.textBlocks.length + followUp.toolBlocks.length,
    ).toBeGreaterThan(0);
  }, 60_000);

  it('disables thinking on K2.6 when the caller explicitly turns it off', async () => {
    const provider = resolveProvider('kimi');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: false, effort: 'none' },
      {
        modelOverride: 'kimi-k2.6',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual([]);
  }, 60_000);
});

describe.skipIf(!RUN_KIMI_CODE_INTEGRATION)('Kimi Code — real provider HTTP', () => {
  it('streams the Moderato K3 tier over the upstream k3 wire model', async () => {
    const provider = resolveProvider('kimi-code');

    expect(provider.getModel()).toBe('kimi-for-coding');
    expect(provider.getAvailableModels()).toEqual([
      'kimi-for-coding',
      'k3',
      'k3-256k',
      'kimi-for-coding-highspeed',
    ]);
    expect(provider.getEffectiveContextWindow('k3-256k')).toBe(262_144);

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'max' },
      { modelOverride: 'k3-256k', maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('honors the legacy reasoning=false control on K3', async () => {
    const provider = resolveProvider('kimi-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      false,
      { modelOverride: 'k3', maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual([]);
  }, 60_000);

  it('streams the K2.7 Code HighSpeed subscription route', async () => {
    const provider = resolveProvider('kimi-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'high' },
      {
        modelOverride: 'kimi-for-coding-highspeed',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);
});
