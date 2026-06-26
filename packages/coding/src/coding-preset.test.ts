/**
 * Unit test for coding-preset wiring.
 *
 * v0.7.23 (FEATURE_080): tested the "Option Y" path —
 *   `registerPresetDispatcher` registered a dispatcher; `Runner.run`
 *   routed to it via the registry.
 *
 * v0.7.29 (FEATURE_100): Option Y deleted per ADR-020. The substrate
 *   executor is now attached directly to the Agent declaration via
 *   `Agent.substrateExecutor`; `Runner.run` consults that field
 *   *before* the registry. This test reflects the new shape — a mock
 *   executor is attached to a custom Agent (NOT registered globally),
 *   exercising the declaration-borne dispatch path.
 */

import { describe, expect, it, vi } from 'vitest';

import { Runner, createAgent, type PresetDispatcher } from '@kodax-ai/agent';
import {
  DEFAULT_CODING_AGENT_NAME,
  createDefaultCodingAgent,
  extractFinalAssistantText,
} from './coding-preset.js';
import type { KodaXResult } from './types.js';

function makeResult(partial: Partial<KodaXResult>): KodaXResult {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'test',
    ...partial,
  } as KodaXResult;
}

describe('coding-preset', () => {
  it('createDefaultCodingAgent returns an agent with the stable dispatch name', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    expect(typeof agent.instructions).toBe('string');
  });

  it('createDefaultCodingAgent attaches a substrate executor closure on the declaration', () => {
    const agent = createDefaultCodingAgent();
    expect(typeof agent.substrateExecutor).toBe('function');
  });

  it('Runner.run delegates to Agent.substrateExecutor (declaration-borne, no registry)', async () => {
    const mock: PresetDispatcher = vi.fn(async () => ({
      output: 'mocked coding output',
      messages: [{ role: 'assistant' as const, content: 'mocked coding output' }],
      sessionId: 'mock-session',
    }));
    // Build a custom agent with our mock executor — proves Runner.run
    // dispatches off the declaration field, not a global registry.
    const customAgent = createAgent({
      name: 'test/coding/declaration-borne',
      instructions: 'test',
      substrateExecutor: mock,
    });
    const result = await Runner.run(customAgent, 'implement thing', {
      presetOptions: { provider: 'test-provider' },
      tracer: null,
    });
    expect(result.output).toBe('mocked coding output');
    expect(result.sessionId).toBe('mock-session');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      customAgent,
      'implement thing',
      { presetOptions: { provider: 'test-provider' }, tracer: null },
    );
  });

  it('createDefaultCodingAgent accepts overrides for declarative fields', () => {
    const agent = createDefaultCodingAgent({
      reasoning: { default: 'deep' },
      guardrails: [{ kind: 'input', name: 'safety' }],
    });
    expect(agent.reasoning?.default).toBe('deep');
    expect(agent.guardrails).toHaveLength(1);
    expect(agent.guardrails?.[0]).toEqual({ kind: 'input', name: 'safety' });
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    // Overrides MUST NOT overwrite the substrate executor closure.
    expect(typeof agent.substrateExecutor).toBe('function');
  });
});

describe('extractFinalAssistantText — placeholder/empty filter (P1③)', () => {
  it('returns real lastText unchanged', () => {
    const result = makeResult({ lastText: 'here is the answer' });
    expect(extractFinalAssistantText(result)).toBe('here is the answer');
  });

  it('does NOT surface a legacy persisted "..." as a real reply', () => {
    // lastText empty → walks back to the last assistant message. A legacy
    // session may carry a `'...'` placeholder block; it is not a real reply.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: '...' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('does NOT surface a bare empty-text marker as a real reply', () => {
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('treats a lastText that is only "..." as no reply', () => {
    const result = makeResult({ lastText: '...' });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('does NOT punch through a placeholder final turn to an earlier turn (resumed-session safety)', () => {
    // If THIS run's final assistant turn is a placeholder, the run produced no
    // visible reply → return ''. Resurfacing 'real earlier answer' would, in a
    // resumed `-c` session, return the answer to a DIFFERENT (previous) question.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'real earlier answer' }] },
        { role: 'user', content: 'noop' },
        { role: 'assistant', content: [{ type: 'text', text: '...' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('returns "" when this run has no assistant turn (trailing normal user — interrupted/error)', () => {
    // Shape [prev-turn assistant, this-turn user]: provider error or
    // interrupted before the assistant turn. Must NOT punch back to the prior
    // turn's answer (which, in a resumed session, answered a DIFFERENT question).
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: 'a different new question' },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('walks back past a trailing tool_result user turn to the real final assistant answer', () => {
    // Walking back past NON-assistant trailing messages is still correct — the
    // most-recent assistant IS the final answer, just not the literal last msg.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('the answer');
  });
});
