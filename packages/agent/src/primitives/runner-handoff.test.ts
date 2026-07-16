/**
 * Runner handoff tests — FEATURE_084 Shard 4 (v0.7.26).
 *
 * Covers:
 *   - detectHandoffSignal: various metadata shapes, missing target, unknown target
 *   - replaceSystemMessage: with and without leading system message
 *   - Runner integration: multi-agent handoff chain completes
 *   - HandoffSpan emission under the AgentSpan
 *   - FEATURE_076 seam: final assistant text comes from the terminal agent
 *   - Non-handoff: same-agent tool loop unchanged
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgent, createHandoff, type Agent, type Guardrail } from './agent.js';
import type { ToolGuardrail } from './guardrail.js';
import {
  detectHandoffSignal,
  replaceSystemMessage,
} from './runner-handoff.js';
import {
  Runner,
  _resetPresetDispatchers,
} from './runner.js';
import type {
  RunnableTool,
  RunnerLlmResult,
  RunnerToolResult,
} from './runner-tool-loop.js';

describe('detectHandoffSignal', () => {
  const leafAgent: Agent = createAgent({ name: 'leaf', instructions: 'leaf' });
  const rootAgent: Agent = createAgent({
    name: 'root',
    instructions: 'root',
    handoffs: [createHandoff({ target: leafAgent, kind: 'continuation' })],
  });

  it('finds a handoff when the tool result declares a matching target', () => {
    const signal = detectHandoffSignal(
      rootAgent,
      [{ id: 'c1', name: 'emit', input: {} }],
      [{ content: 'ok', metadata: { handoffTarget: 'leaf' } }],
    );
    expect(signal).toBeDefined();
    expect(signal!.from).toBe(rootAgent);
    expect(signal!.to).toBe(leafAgent);
    expect(signal!.triggerIndex).toBe(0);
  });

  it('returns undefined when tool results have no metadata', () => {
    const signal = detectHandoffSignal(
      rootAgent,
      [{ id: 'c1', name: 'x', input: {} }],
      [{ content: 'no-meta' }],
    );
    expect(signal).toBeUndefined();
  });

  it('returns undefined when handoffTarget does not match any declared handoff', () => {
    const signal = detectHandoffSignal(
      rootAgent,
      [{ id: 'c1', name: 'x', input: {} }],
      [{ content: 'ok', metadata: { handoffTarget: 'nonexistent' } }],
    );
    expect(signal).toBeUndefined();
  });

  it('returns undefined when agent has no handoffs declared', () => {
    const noHandoffs: Agent = createAgent({ name: 'solo', instructions: 'solo' });
    const signal = detectHandoffSignal(
      noHandoffs,
      [{ id: 'c1', name: 'x', input: {} }],
      [{ content: 'ok', metadata: { handoffTarget: 'anything' } }],
    );
    expect(signal).toBeUndefined();
  });

  it('returns the first matching signal when multiple results carry targets', () => {
    const other: Agent = createAgent({ name: 'other', instructions: 'other' });
    const multi: Agent = createAgent({
      name: 'multi',
      instructions: 'm',
      handoffs: [
        createHandoff({ target: other, kind: 'continuation' }),
        createHandoff({ target: leafAgent, kind: 'continuation' }),
      ],
    });
    const signal = detectHandoffSignal(
      multi,
      [{ id: 'c1', name: 'a', input: {} }, { id: 'c2', name: 'b', input: {} }],
      [
        { content: '', metadata: { handoffTarget: 'leaf' } },
        { content: '', metadata: { handoffTarget: 'other' } },
      ],
    );
    expect(signal?.to).toBe(leafAgent);
    expect(signal?.triggerIndex).toBe(0);
  });
});

describe('replaceSystemMessage', () => {
  it('replaces leading system message', () => {
    const newAgent = createAgent({ name: 'new', instructions: 'new-sys' });
    const result = replaceSystemMessage(
      [
        { role: 'system', content: 'old-sys' },
        { role: 'user', content: 'q' },
      ],
      newAgent,
    );
    expect(result[0]!.content).toBe('new-sys');
    expect(result[1]!.content).toBe('q');
  });

  it('prepends system message when transcript starts with user', () => {
    const newAgent = createAgent({ name: 'new', instructions: 'sys' });
    const result = replaceSystemMessage([{ role: 'user', content: 'q' }], newAgent);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('system');
    expect(result[0]!.content).toBe('sys');
  });

  it('resolves function-based instructions', () => {
    const newAgent = createAgent({ name: 'fn', instructions: () => 'dynamic' });
    const result = replaceSystemMessage([], newAgent);
    expect(result[0]!.content).toBe('dynamic');
  });
});

describe('Runner integration — handoff chain', () => {
  afterEach(() => _resetPresetDispatchers());

  function makeEmitTool(name: string, handoffTarget: string | undefined): RunnableTool {
    return {
      name,
      description: 'test-emit',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => ({
        content: `${name} recorded`,
        metadata: { handoffTarget } as Record<string, unknown>,
      } satisfies RunnerToolResult),
    };
  }

  // FEATURE_193 v0.7.43: scout→generator→evaluator V1 chain it deleted (uses emit_handoff + emit_scout_verdict — V1 chain retired)

  it('stays on the same agent when tool result has no handoffTarget', async () => {
    const echo: RunnableTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: 'echoed' }),
    };
    const solo: Agent = createAgent({
      name: 'solo-agent',
      instructions: 'solo-sys',
      tools: [echo],
      handoffs: [],
    });
    const agentsSeen: string[] = [];
    let turn = 0;
    const llm = async (_msgs: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      agentsSeen.push(agent.name);
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] };
      return { text: 'done', toolCalls: [] };
    };
    const result = await Runner.run(solo, 'q', { llm });
    expect(agentsSeen).toEqual(['solo-agent', 'solo-agent']);
    expect(result.output).toBe('done');
  });

  it('ignores handoffTarget that does not match a declared handoff (stays on current agent)', async () => {
    const fakeEmit = makeEmitTool('emit_bogus', 'unknown-agent');
    const solo: Agent = createAgent({
      name: 'stubborn',
      instructions: 'stubborn-sys',
      tools: [fakeEmit],
      // no handoffs at all
    });
    let turn = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'emit_bogus', input: {} }] };
      return { text: 'stayed put', toolCalls: [] };
    };
    const result = await Runner.run(solo, 'q', { llm });
    expect(result.output).toBe('stayed put');
  });

  it('emits HandoffSpan under the AgentSpan for each transition', async () => {
    const { Tracer, addTracingProcessor, setTracingProcessors } = await import('../tracing/index.js');
    setTracingProcessors([]);
    const ended: Array<{ kind: string; from?: string; to?: string }> = [];
    addTracingProcessor({
      onSpanStart: () => { /* noop */ },
      onSpanEnd: (span) => {
        ended.push({
          kind: span.data.kind,
          from: (span.data as { fromAgent?: string }).fromAgent,
          to: (span.data as { toAgent?: string }).toAgent,
        });
      },
      onTraceEnd: () => { /* noop */ },
    });

    const leafTool = makeEmitTool('emit_leaf', undefined);
    const leaf: Agent = createAgent({ name: 'span-leaf', instructions: 'leaf-sys', tools: [leafTool] });
    const rootTool = makeEmitTool('emit_root', 'span-leaf');
    const root: Agent = createAgent({
      name: 'span-root',
      instructions: 'root-sys',
      tools: [rootTool],
      handoffs: [createHandoff({ target: leaf, kind: 'continuation', description: 'go to leaf' })],
    });
    let turn = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'emit_root', input: {} }] };
      if (turn === 2) return { text: '', toolCalls: [{ id: 'c2', name: 'emit_leaf', input: {} }] };
      return { text: 'done', toolCalls: [] };
    };
    await Runner.run(root, 'q', { llm, tracer: new Tracer() });
    setTracingProcessors([]);

    const handoffs = ended.filter((s) => s.kind === 'handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.from).toBe('span-root');
    expect(handoffs[0]!.to).toBe('span-leaf');
  });

  it('tool guardrail receives the CURRENT agent after handoff (MED-1)', async () => {
    // Regression guard: before the MED-1 fix, tool-before/after guardrails
    // received the run's start agent in ctx.agent even after a handoff.
    // Per comment in runner.ts L313-316, tool hooks must fire per-
    // invocation against whichever agent is currently active.
    const agentsSeenByGuardrail: string[] = [];
    const recordingToolGuardrail: ToolGuardrail = {
      kind: 'tool',
      name: 'agent-recorder',
      beforeTool: async (_call, ctx) => {
        agentsSeenByGuardrail.push(ctx.agent.name);
        return { action: 'allow' };
      },
    };

    const leafTool = makeEmitTool('emit_done', undefined);
    const leaf: Agent = createAgent({
      name: 'med1-leaf',
      instructions: 'leaf',
      tools: [leafTool],
    });
    const rootTool = makeEmitTool('emit_go', 'med1-leaf');
    const root: Agent = createAgent({
      name: 'med1-root',
      instructions: 'root',
      tools: [rootTool],
      handoffs: [createHandoff({ target: leaf, kind: 'continuation' })],
      guardrails: [recordingToolGuardrail as Guardrail],
    });

    let turn = 0;
    const llm = async (_m: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      turn += 1;
      if (agent.name === 'med1-root') {
        return { text: '', toolCalls: [{ id: 'c1', name: 'emit_go', input: {} }] };
      }
      if (turn === 2) {
        return { text: '', toolCalls: [{ id: 'c2', name: 'emit_done', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };
    await Runner.run(root, 'q', { llm });

    // Guardrail fired twice: once under root (emit_go), once under leaf
    // (emit_done). The leaf-side call must reflect the handoff target.
    expect(agentsSeenByGuardrail).toEqual(['med1-root', 'med1-leaf']);
  });

  it('final assistant message is from the terminal agent (FEATURE_076 seam)', async () => {
    // Start-agent → terminal-agent. The user should see the terminal agent's
    // final text, NOT the start agent's intermediate handoff text.
    // FEATURE_193 v0.7.43: migrated from scout→generator names to generic agent names (V1 chain retired)
    const terminalAgent: Agent = createAgent({ name: 'terminal-agent', instructions: 'terminal-sys' });
    const startTool = makeEmitTool('emit_done', 'terminal-agent');
    const startAgent: Agent = createAgent({
      name: 'start-agent',
      instructions: 'start-sys',
      tools: [startTool],
      handoffs: [createHandoff({ target: terminalAgent, kind: 'continuation' })],
    });
    let turn = 0;
    const llm = async (_m: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      turn += 1;
      if (agent.name === 'start-agent') {
        return { text: 'start transient', toolCalls: [{ id: 'c1', name: 'emit_done', input: {} }] };
      }
      return { text: 'terminal final answer', toolCalls: [] };
    };
    const result = await Runner.run(startAgent, 'q', { llm });
    expect(result.output).toBe('terminal final answer');
    expect(result.output).not.toBe('start transient');
  });

  // ----------------------------------------------------------------
  // FEATURE_166 (v0.7.41 follow-up) — onAgentSwitched hook
  //
  // The hook fires after `detectHandoffSignal` swaps `currentAgent`
  // and after the transcript inputFilter + system replacement run,
  // but before the next iteration's `runGenerationTurn`. Production
  // session 20260515_185354 confirmed the missing hook causes a
  // [Worker]→[Evaluator] label-lag that surfaces on every Evaluator
  // turn that does not emit_verdict-first.
  // ----------------------------------------------------------------

  it('FEATURE_166: onAgentSwitched fires once per handoff with from/to/iteration', async () => {
    // FEATURE_193 v0.7.43: emit_handoff → emit_done (V1 chain tool retired)
    const evalTool = makeEmitTool('emit_verdict', undefined);
    const evaluator: Agent = createAgent({
      name: 'f166-evaluator',
      instructions: 'eval-sys',
      tools: [evalTool],
    });
    const handoffTool = makeEmitTool('emit_done', 'f166-evaluator');
    const worker: Agent = createAgent({
      name: 'f166-worker',
      instructions: 'worker-sys',
      tools: [handoffTool],
      handoffs: [createHandoff({ target: evaluator, kind: 'continuation' })],
    });

    let turn = 0;
    const llm = async (_m: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      turn += 1;
      if (agent.name === 'f166-worker') {
        return { text: '', toolCalls: [{ id: `c${turn}`, name: 'emit_done', input: {} }] };
      }
      if (turn === 2) {
        return { text: '', toolCalls: [{ id: `c${turn}`, name: 'emit_verdict', input: {} }] };
      }
      return { text: 'evaluator final', toolCalls: [] };
    };

    const switches: Array<{ from: string; to: string; iteration: number }> = [];
    await Runner.run(worker, 'q', {
      llm,
      onAgentSwitched: ({ from, to, iteration }) => {
        switches.push({ from: from.name, to: to.name, iteration });
      },
    });

    // Single handoff Worker → Evaluator. Hook fires once with the
    // matching identities. `iteration` is the for-loop index at
    // which the handoff was detected (Worker's turn, before the
    // Evaluator's first runGenerationTurn).
    expect(switches).toEqual([{ from: 'f166-worker', to: 'f166-evaluator', iteration: 0 }]);
  });

  it('FEATURE_166: hook does not fire when no handoff happens (single-agent run)', async () => {
    const solo: Agent = createAgent({ name: 'f166-solo', instructions: 'solo' });
    const llm = async (): Promise<RunnerLlmResult> => ({ text: 'done', toolCalls: [] });
    const onAgentSwitched = vi.fn();
    await Runner.run(solo, 'q', { llm, onAgentSwitched });
    expect(onAgentSwitched).not.toHaveBeenCalled();
  });

  it('FEATURE_166: hook is awaited before the new agent\'s first runGenerationTurn fires', async () => {
    // Pin: hook is awaited so callers can flush ordered side effects
    // (status emits, lineage writes) before the new agent's first
    // streaming output begins. Without await, a non-trivial caller
    // hook would race against runGenerationTurn and the label flip
    // could still surface AFTER the new agent's first tokens.
    // FEATURE_193 v0.7.43: emit_handoff → emit_done (V1 chain tool retired)
    const evalTool = makeEmitTool('emit_verdict', undefined);
    const evaluator: Agent = createAgent({
      name: 'f166-async-eval',
      instructions: 'eval',
      tools: [evalTool],
    });
    const handoffTool = makeEmitTool('emit_done', 'f166-async-eval');
    const worker: Agent = createAgent({
      name: 'f166-async-worker',
      instructions: 'worker',
      tools: [handoffTool],
      handoffs: [createHandoff({ target: evaluator, kind: 'continuation' })],
    });

    const eventLog: string[] = [];
    let turn = 0;
    const llm = async (_m: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      turn += 1;
      eventLog.push(`llm:${agent.name}`);
      if (agent.name === 'f166-async-worker') {
        return { text: '', toolCalls: [{ id: `c${turn}`, name: 'emit_done', input: {} }] };
      }
      return { text: 'eval-final', toolCalls: [] };
    };

    await Runner.run(worker, 'q', {
      llm,
      onAgentSwitched: async () => {
        // Simulate an async status flush.
        await new Promise((resolve) => setTimeout(resolve, 0));
        eventLog.push('switched');
      },
    });

    // 'switched' MUST appear before the Evaluator's first LLM call.
    const switchedIdx = eventLog.indexOf('switched');
    const firstEvalIdx = eventLog.indexOf('llm:f166-async-eval');
    expect(switchedIdx).toBeGreaterThanOrEqual(0);
    expect(firstEvalIdx).toBeGreaterThan(switchedIdx);
  });

  it('FEATURE_166: hook errors propagate verbatim (caller-controlled contract)', async () => {
    // FEATURE_193 v0.7.43: emit_handoff → emit_done (V1 chain tool retired)
    const evalTool = makeEmitTool('emit_verdict', undefined);
    const evaluator: Agent = createAgent({
      name: 'f166-err-eval',
      instructions: 'eval',
      tools: [evalTool],
    });
    const handoffTool = makeEmitTool('emit_done', 'f166-err-eval');
    const worker: Agent = createAgent({
      name: 'f166-err-worker',
      instructions: 'worker',
      tools: [handoffTool],
      handoffs: [createHandoff({ target: evaluator, kind: 'continuation' })],
    });

    const llm = async (_m: unknown, agent: Agent): Promise<RunnerLlmResult> => {
      if (agent.name === 'f166-err-worker') {
        return { text: '', toolCalls: [{ id: 'c1', name: 'emit_done', input: {} }] };
      }
      return { text: 'unreachable', toolCalls: [] };
    };

    await expect(
      Runner.run(worker, 'q', {
        llm,
        onAgentSwitched: () => {
          throw new Error('caller-side fault');
        },
      }),
    ).rejects.toThrow('caller-side fault');
  });
});
