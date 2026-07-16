/**
 * FEATURE_184 (v0.7.45) Phase D.1 — Sidecar Verifier substrate tests.
 *
 * Tests cover:
 *   - Three-state verdict parsing (accept / revise / blocked)
 *   - Safe-default coverage: provider error / timeout / no tool call /
 *     invalid verdict value / missing reason
 *   - Fuzzy tool-name match (typo absorption)
 *   - mapVerifierVerdictToStopHookResult three-state mapping
 *   - createSidecarVerifierStopHook end-to-end stub run
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
  invokeSidecarVerifier,
  mapVerifierVerdictToStopHookResult,
  createSidecarVerifierStopHook,
  type SidecarVerifierContextInputs,
} from './verifier.js';

function fakeProvider(streamImpl: (
  messages: KodaXMessage[],
  tools: KodaXToolDefinition[],
  system: string,
) => Promise<KodaXStreamResult>): KodaXBaseProvider {
  return {
    name: 'fake-verifier',
    stream: streamImpl as unknown as KodaXBaseProvider['stream'],
  } as unknown as KodaXBaseProvider;
}

function toolBlock(name: string, input: Record<string, unknown>): KodaXToolUseBlock {
  return { type: 'tool_use', id: 'tu_fake', name, input };
}

const minimalInputs: SidecarVerifierContextInputs = {
  currentTurnUserQueries: ['fix the bug'],
  recentTranscript: [],
  fileEditSummary: [],
  lastAssistantText: 'done',
};

describe('invokeSidecarVerifier — three-state verdict parsing', () => {
  it('parses verdict=accept with empty reason', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'accept', reason: '' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.reason).toBe('');
    expect(verdict.trace).toBe('verifier_ok');
  });

  it('parses verdict=revise with reason', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', {
        verdict: 'revise',
        reason: 'add error handling to the catch block',
      })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('revise');
    expect(verdict.reason).toBe('add error handling to the catch block');
    expect(verdict.trace).toBe('verifier_ok');
  });

  it('parses verdict=blocked with reason + suggestedFix', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', {
        verdict: 'blocked',
        reason: 'user request ambiguous — needs clarification',
        suggestedFix: 'ask which API version',
      })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.suggestedFix).toBe('ask which API version');
  });

  it('case-insensitive verdict value normalization', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: '  REVISE  ', reason: 'fix X' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('revise');
  });
});

describe('invokeSidecarVerifier — safe-default coverage (fail-open)', () => {
  it('provider throw → accept + trace=provider_error', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('rate limit');
    });
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('provider_error');
  });

  it('timeout → accept + trace=timeout', async () => {
    const provider = fakeProvider(() => new Promise(() => { /* never resolves */ }));
    const verdict = await invokeSidecarVerifier({
      provider,
      inputs: minimalInputs,
      timeoutMs: 30, // tight to keep test fast
    });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('timeout');
  });

  it('no tool call emitted → accept + trace=no_tool_call', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [{ type: 'text', text: 'I think it looks fine' }],
      toolBlocks: [],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('no_tool_call');
  });

  it('invalid verdict value → accept + trace=invalid_verdict_value', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'maybe', reason: 'unsure' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('invalid_verdict_value');
  });

  it('revise/blocked with missing reason → accept + trace=missing_reason', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'revise', reason: '   ' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('missing_reason');
  });

  it('accept with missing reason is still accept (reason is optional for accept)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'accept' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('verifier_ok');
  });
});

describe('invokeSidecarVerifier — fuzzy tool match', () => {
  it('matches near-spelling within edit distance 2', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      // Typo: "emit_sidcar_verdict" (missing 'e') — distance 1
      toolBlocks: [toolBlock('emit_sidcar_verdict', { verdict: 'accept', reason: '' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.verdict).toBe('accept');
    expect(verdict.trace).toBe('fuzzy_tool_match');
  });

  it('rejects tool name beyond edit distance 2', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('completely_different_tool', { verdict: 'accept', reason: '' })],
      thinkingBlocks: [],
    }));
    const verdict = await invokeSidecarVerifier({ provider, inputs: minimalInputs });
    expect(verdict.trace).toBe('no_tool_call');
  });
});

describe('mapVerifierVerdictToStopHookResult — three-state mapping', () => {
  it('accept → undefined', () => {
    const result = mapVerifierVerdictToStopHookResult({
      verdict: 'accept',
      reason: '',
      trace: 'verifier_ok',
    });
    expect(result).toBeUndefined();
  });

  it('revise → {reanimate: reason + retrospective, source: sidecar-verifier}', () => {
    const result = mapVerifierVerdictToStopHookResult({
      verdict: 'revise',
      reason: 'add tests',
      trace: 'verifier_ok',
    });
    expect((result as { source?: string }).source).toBe('sidecar-verifier');
    const reanimate = (result as { reanimate: string }).reanimate;
    expect(reanimate).toContain('add tests');
    // Retry retrospective is folded into the reanimate message (moved out of the
    // Worker system prompt so the system cache block stays byte-stable).
    expect(reanimate).toContain('previous attempt at this task failed');
  });

  it('blocked → {abort, reason}', () => {
    const result = mapVerifierVerdictToStopHookResult({
      verdict: 'blocked',
      reason: 'cannot determine intent',
      trace: 'verifier_ok',
    });
    expect(result).toEqual({ abort: true, reason: 'cannot determine intent' });
  });
});

describe('createSidecarVerifierStopHook — end-to-end stub', () => {
  it('runs the verifier and surfaces accept as undefined', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'accept', reason: '' })],
      thinkingBlocks: [],
    }));
    let observedVerdict: { v: string; trace: string } | undefined;
    const hook = createSidecarVerifierStopHook({
      provider,
      buildContext: () => minimalInputs,
      onVerdict: (v) => {
        observedVerdict = { v: v.verdict, trace: v.trace };
      },
    });
    const result = await hook({
      transcript: [],
      lastAssistantText: 'done',
      signal: 'natural-end',
      reanimateCount: 0,
      reanimateBudget: 2,
    });
    expect(result).toBeUndefined();
    expect(observedVerdict).toEqual({ v: 'accept', trace: 'verifier_ok' });
  });

  it('surfaces revise verdict as a {reanimate, source} object', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', {
        verdict: 'revise',
        reason: 'please add a test',
      })],
      thinkingBlocks: [],
    }));
    const hook = createSidecarVerifierStopHook({
      provider,
      buildContext: () => minimalInputs,
    });
    const result = await hook({
      transcript: [],
      lastAssistantText: 'done',
      signal: 'natural-end',
      reanimateCount: 0,
      reanimateBudget: 2,
    });
    expect((result as { source?: string }).source).toBe('sidecar-verifier');
    expect((result as { reanimate: string }).reanimate).toContain('please add a test');
  });

  it('surfaces blocked verdict as {abort, reason}', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', {
        verdict: 'blocked',
        reason: 'need clarification',
      })],
      thinkingBlocks: [],
    }));
    const hook = createSidecarVerifierStopHook({
      provider,
      buildContext: () => minimalInputs,
    });
    const result = await hook({
      transcript: [],
      lastAssistantText: 'done',
      signal: 'natural-end',
      reanimateCount: 0,
      reanimateBudget: 2,
    });
    expect(result).toEqual({ abort: true, reason: 'need clarification' });
  });

  it('buildContext receives the StopHook ctx transcript + lastAssistantText', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      toolBlocks: [toolBlock('emit_sidecar_verdict', { verdict: 'accept', reason: '' })],
      thinkingBlocks: [],
    }));
    let receivedCtx: { transcriptLen: number; text: string } | undefined;
    const hook = createSidecarVerifierStopHook({
      provider,
      buildContext: (ctx) => {
        receivedCtx = {
          transcriptLen: ctx.transcript.length,
          text: ctx.lastAssistantText,
        };
        return minimalInputs;
      },
    });
    await hook({
      transcript: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      lastAssistantText: 'final answer',
      signal: 'natural-end',
      reanimateCount: 1,
      reanimateBudget: 2,
    });
    expect(receivedCtx).toEqual({
      transcriptLen: 2,
      text: 'final answer',
    });
  });
});
