/**
 * FEATURE_215 (v0.7.49) — Generic LLM-judged stop-hook primitive tests.
 *
 * Covers the domain-neutral kernel lifted from the coding-layer Sidecar
 * Verifier / Stall Sidecar:
 *   - editDistance / findFuzzyToolMatch helpers
 *   - invokeLlmJudge: clean parse, fuzzy match, no-tool, beyond-distance,
 *     provider error, timeout, parse failure — each mapped to the
 *     reason-keyed defaultVerdict
 *   - createLlmJudgedStopHook: buildUserMessage → invoke → onVerdict →
 *     mapVerdict
 *
 * No production provider invoked — all providers are local fakes.
 */

import { describe, expect, it } from 'vitest';

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';

import {
  editDistance,
  findFuzzyToolMatch,
  invokeLlmJudge,
  createLlmJudgedStopHook,
  type LlmJudgeFailureReason,
} from './llm-judge.js';

function fakeProvider(streamImpl: (
  messages: KodaXMessage[],
  tools: KodaXToolDefinition[],
  system: string,
) => Promise<KodaXStreamResult>): KodaXBaseProvider {
  return {
    name: 'fake-judge',
    stream: streamImpl as unknown as KodaXBaseProvider['stream'],
  } as unknown as KodaXBaseProvider;
}

function toolBlock(name: string, input: Record<string, unknown>): KodaXToolUseBlock {
  return { type: 'tool_use', id: 'tu_fake', name, input };
}

const REPORT_TOOL = { name: 'emit_verdict', description: '', input_schema: { type: 'object' } } as unknown as KodaXToolDefinition;

/** Tiny test verdict — carries the value + the trace tag that the kernel
 *  / parser decided. Mirrors how real consumers (verifier / stall) tag. */
interface TestVerdict {
  readonly value: string;
  readonly trace: string;
}

/** Reason-keyed default factory, exactly like the real consumers use. */
const defaultVerdict = (reason: LlmJudgeFailureReason): TestVerdict => ({
  value: 'default',
  trace: reason,
});

/** Parse: returns the value, tags exact vs fuzzy. Returns undefined when
 *  the input explicitly carries `bad: true` (parse-failure path). */
const parseToolCall = (block: KodaXToolUseBlock, exact: boolean): TestVerdict | undefined => {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (input.bad === true) return undefined;
  return {
    value: typeof input.value === 'string' ? input.value : '',
    trace: exact ? 'ok' : 'fuzzy',
  };
};

function invoke(provider: KodaXBaseProvider, timeoutMs?: number): Promise<TestVerdict> {
  return invokeLlmJudge<TestVerdict>({
    provider,
    systemPrompt: 'judge',
    reportTool: REPORT_TOOL,
    userMessage: 'please judge',
    reportToolName: 'emit_verdict',
    parseToolCall,
    defaultVerdict,
    timeoutMs,
  });
}

describe('editDistance', () => {
  it('is 0 for identical strings', () => expect(editDistance('abc', 'abc')).toBe(0));
  it('equals length when one side empty', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });
  it('counts a single substitution', () => expect(editDistance('cat', 'cut')).toBe(1));
  it('absorbs the canonical typo', () => expect(editDistance('jundgment', 'judgment')).toBe(1));
  it('handles kitten→sitting', () => expect(editDistance('kitten', 'sitting')).toBe(3));
});

describe('findFuzzyToolMatch', () => {
  it('returns exact match', () => {
    const m = findFuzzyToolMatch([toolBlock('emit_verdict', {})], 'emit_verdict');
    expect(m?.exact).toBe(true);
  });
  it('returns fuzzy match within distance 2', () => {
    const m = findFuzzyToolMatch([toolBlock('emit_verdet', {})], 'emit_verdict');
    expect(m?.exact).toBe(false);
  });
  it('rejects beyond distance 2', () => {
    expect(findFuzzyToolMatch([toolBlock('totally_other', {})], 'emit_verdict')).toBeUndefined();
  });
  it('returns undefined on empty', () => {
    expect(findFuzzyToolMatch([], 'emit_verdict')).toBeUndefined();
  });
});

describe('invokeLlmJudge — happy + fuzzy', () => {
  it('parses an exact tool call', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [], thinkingBlocks: [],
      toolBlocks: [toolBlock('emit_verdict', { value: 'good' })],
    }));
    const v = await invoke(provider);
    expect(v).toEqual({ value: 'good', trace: 'ok' });
  });

  it('parses a fuzzy tool call (exact=false)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [], thinkingBlocks: [],
      toolBlocks: [toolBlock('emit_verdet', { value: 'good' })],
    }));
    const v = await invoke(provider);
    expect(v).toEqual({ value: 'good', trace: 'fuzzy' });
  });
});

describe('invokeLlmJudge — fail-open default verdict', () => {
  it('provider throw → defaultVerdict(provider_error)', async () => {
    const provider = fakeProvider(async () => { throw new Error('rate limit'); });
    expect((await invoke(provider)).trace).toBe('provider_error');
  });

  it('timeout → defaultVerdict(timeout)', async () => {
    const provider = fakeProvider(() => new Promise(() => { /* never */ }));
    expect((await invoke(provider, 30)).trace).toBe('timeout');
  });

  it('no tool call → defaultVerdict(no_tool_call)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [{ type: 'text', text: 'looks fine' }], thinkingBlocks: [], toolBlocks: [],
    }));
    expect((await invoke(provider)).trace).toBe('no_tool_call');
  });

  it('tool name beyond distance 2 → defaultVerdict(no_tool_call)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [], thinkingBlocks: [],
      toolBlocks: [toolBlock('totally_other', { value: 'x' })],
    }));
    expect((await invoke(provider)).trace).toBe('no_tool_call');
  });

  it('parseToolCall returns undefined → defaultVerdict(parse_failure)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [], thinkingBlocks: [],
      toolBlocks: [toolBlock('emit_verdict', { bad: true })],
    }));
    expect((await invoke(provider)).trace).toBe('parse_failure');
  });

  it('never throws even on provider rejection', async () => {
    const provider = fakeProvider(async () => { throw new Error('boom'); });
    await expect(invoke(provider)).resolves.toBeDefined();
  });
});

describe('createLlmJudgedStopHook', () => {
  const baseCtx = {
    transcript: [], lastAssistantText: 'done',
    signal: 'natural-end' as const, reanimateCount: 0, reanimateBudget: 2,
  };

  it('builds user message from ctx, maps verdict, notifies onVerdict', async () => {
    let seenMessage: string | undefined;
    let observed: TestVerdict | undefined;
    const provider = fakeProvider(async (messages) => {
      seenMessage = messages[0]?.content as string;
      return { textBlocks: [], thinkingBlocks: [], toolBlocks: [toolBlock('emit_verdict', { value: 'revise-me' })] };
    });
    const hook = createLlmJudgedStopHook<TestVerdict>({
      provider,
      systemPrompt: 'judge',
      reportTool: REPORT_TOOL,
      reportToolName: 'emit_verdict',
      buildUserMessage: (ctx) => `text=${ctx.lastAssistantText}`,
      parseToolCall,
      defaultVerdict,
      mapVerdict: (v) => (v.value === 'revise-me' ? v.value : undefined),
      onVerdict: (v) => { observed = v; },
    });
    const result = await hook(baseCtx);
    expect(seenMessage).toBe('text=done');
    expect(observed).toEqual({ value: 'revise-me', trace: 'ok' });
    expect(result).toBe('revise-me');
  });

  it('maps a fail-open default verdict through mapVerdict', async () => {
    const provider = fakeProvider(async () => { throw new Error('down'); });
    const hook = createLlmJudgedStopHook<TestVerdict>({
      provider,
      systemPrompt: 'judge',
      reportTool: REPORT_TOOL,
      reportToolName: 'emit_verdict',
      buildUserMessage: () => 'm',
      parseToolCall,
      defaultVerdict,
      mapVerdict: (v) => (v.trace === 'provider_error' ? undefined : 'unexpected'),
    });
    expect(await hook(baseCtx)).toBeUndefined();
  });
});
