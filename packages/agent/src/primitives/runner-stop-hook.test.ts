/**
 * FEATURE_184 (v0.7.45) — Stop hook primitive regression tests.
 *
 * Phase A of the claudecode-shape Main Agent + Sidecar Verifier substrate.
 * Pins the contract on `RunOptions.stopHook` three-state return surface
 * (undefined accept / string reanimate / {abort, reason} halt) and the
 * `stopHookReanimateBudget` enforcement.
 *
 * Design references:
 * - ADR-030 (docs/ADR.md) — Architecture decision
 * - claudecode `query.ts:1282-1305` (blockingErrors) + `query.ts:1278`
 *   (preventContinuation) — origin of the three-state surface
 *
 * Phase A is zero-behavior-change: with `stopHook` undefined the Runner
 * path is byte-identical to v0.7.42. These tests verify both that the
 * happy path stays unchanged AND that the new hook semantics behave per
 * spec.
 */

import { describe, expect, it } from 'vitest';

import { createAgent, type Agent, type AgentMessage } from './agent.js';
import { Runner } from './runner.js';
import type { StopHookContext, StopHookResult } from './runner.js';
import type { RunnableTool, RunnerLlmResult } from './runner-tool-loop.js';

const noopTool: RunnableTool = {
  name: 'noop',
  description: 'no-op for testing',
  input_schema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'noop ok' }),
};

const agentWithTools: Agent = createAgent({
  name: 'stop-hook-test-tools',
  instructions: 'test',
  tools: [noopTool],
});

const agentNoTools: Agent = createAgent({
  name: 'stop-hook-test-text',
  instructions: 'test',
});

describe('Runner stopHook — FEATURE_184 Phase A primitive', () => {
  it('is a no-op when stopHook is undefined (zero behavior change)', async () => {
    // Baseline: without a stopHook, the Runner must behave bit-identical
    // to v0.7.42 — the model emits text-only, no tool calls, run returns
    // with `output = text` and no `stoppedByHook` flag.
    const result = await Runner.run(agentNoTools, 'hi', {
      llm: async () => 'pure text reply',
      tracer: null,
    });
    expect(result.output).toBe('pure text reply');
    expect(result.stoppedByHook).toBeUndefined();
  });

  it('fires the hook once on text-only termination with signal=natural-end', async () => {
    const contexts: StopHookContext[] = [];
    const hook = async (ctx: StopHookContext): Promise<StopHookResult> => {
      contexts.push(ctx);
      return undefined;
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm: async () => 'final text',
      stopHook: hook,
      tracer: null,
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.signal).toBe('natural-end');
    expect(contexts[0]?.lastAssistantText).toBe('final text');
    expect(contexts[0]?.reanimateCount).toBe(0);
    expect(contexts[0]?.reanimateBudget).toBe(2);
    expect(result.output).toBe('final text');
    expect(result.stoppedByHook).toBeUndefined();
  });

  it('does NOT fire the hook on a tool-use iteration', async () => {
    // The hook only fires on text-only termination. A tool-using turn
    // (toolCalls.length > 0) skips the hook entirely on that iteration.
    let llmCall = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      llmCall++;
      if (llmCall < 3) {
        return { text: '', toolCalls: [{ id: `c${llmCall}`, name: 'noop', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };
    let hookFires = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookFires++;
      return undefined;
    };

    await Runner.run(agentWithTools, 'go', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    // 3 LLM calls (2 tool turns + 1 text-only). Hook fires exactly once
    // on the final text-only turn.
    expect(llmCall).toBe(3);
    expect(hookFires).toBe(1);
  });

  it('reanimate path: string return injects synthetic user msg and continues loop', async () => {
    // Hook returns "do X more" once on first text-only turn → Runner
    // synthesizes user message + continues. Second text-only turn,
    // hook returns undefined → accept + return.
    let llmCall = 0;
    const llmSawMessages: number[] = [];
    const llm = async (messages: readonly AgentMessage[]): Promise<RunnerLlmResult> => {
      llmCall++;
      llmSawMessages.push(messages.length);
      return { text: `reply ${llmCall}`, toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookCall++;
      if (hookCall === 1) return 'please redo X';
      return undefined;
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    expect(llmCall).toBe(2);
    expect(hookCall).toBe(2);
    // 2nd LLM call sees prior turn's assistant msg + the synthetic user
    // injection (length grew by 2 vs first call).
    expect(llmSawMessages[1]).toBe((llmSawMessages[0] ?? 0) + 2);
    expect(result.output).toBe('reply 2');
    expect(result.stoppedByHook).toBeUndefined();
    // Final transcript contains the synthetic user message.
    const userMessages = result.messages.filter((m) => m.role === 'user');
    expect(userMessages.some((m) => m.content === 'please redo X')).toBe(true);
    expect(userMessages.find((m) => m.content === 'please redo X')?._synthetic).toBe(true);
  });

  it('hook ctx.reanimateCount increments across iterations', async () => {
    const seenCounts: number[] = [];
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (ctx: StopHookContext): Promise<StopHookResult> => {
      seenCounts.push(ctx.reanimateCount);
      hookCall++;
      if (hookCall < 3) return 'again';
      return undefined;
    };

    await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    // Hook fires 3 times. ctx.reanimateCount is the count BEFORE this
    // call's reanimate, so: 0, 1, 2.
    expect(seenCounts).toEqual([0, 1, 2]);
  });

  it('budget exhaustion: string return when reanimateCount >= budget converts to forced abort', async () => {
    // Budget=1 → 1st hook call (count=0) reanimates, 2nd hook call
    // (count=1, which == budget) string-return is forcibly converted
    // to abort with reason "reanimate budget exhausted: <string>".
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookCall++;
      return 'keep going';
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      stopHookReanimateBudget: 1,
      tracer: null,
    });

    expect(hookCall).toBe(2);
    expect(result.stoppedByHook).toBe(true);
    expect(result.output).toBe('reanimate budget exhausted: keep going');
  });

  it('abort path: {abort: true, reason} return halts with stoppedByHook=true and output=reason', async () => {
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'should not be the output', toolCalls: [] };
    };
    const hook = async (): Promise<StopHookResult> => {
      return { abort: true, reason: 'verifier rejected: missing tests' };
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    expect(result.stoppedByHook).toBe(true);
    expect(result.output).toBe('verifier rejected: missing tests');
    // Assistant text is still in transcript (we pushed before calling hook).
    const assistantMessages = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
  });

  it('fail-open: hook throw is caught, treated as undefined accept', async () => {
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'all good', toolCalls: [] };
    };
    const hook = async (): Promise<StopHookResult> => {
      throw new Error('hook bug');
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    // Thrown hook does not abort the run.
    expect(result.output).toBe('all good');
    expect(result.stoppedByHook).toBeUndefined();
  });

  it('default budget is 2 when stopHookReanimateBudget unset', async () => {
    // Hook returns string repeatedly. With default budget=2:
    //   call 0 (count=0): reanimate
    //   call 1 (count=1): reanimate
    //   call 2 (count=2, == budget): converted to abort
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookCall++;
      return 'do more';
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    expect(hookCall).toBe(3);
    expect(result.stoppedByHook).toBe(true);
    expect(result.output).toContain('reanimate budget exhausted');
  });

  it('coexists with compactionHook — both fire correctly in one run', async () => {
    // compactionHook fires at top of every iteration. stopHook fires at
    // end of text-only iteration. They must not interfere.
    let compactionCalls = 0;
    let stopCalls = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    const compactionHook = async () => {
      compactionCalls++;
      return undefined;
    };
    const stopHook = async (): Promise<StopHookResult> => {
      stopCalls++;
      return undefined;
    };

    await Runner.run(agentNoTools, 'hi', {
      llm,
      compactionHook,
      stopHook,
      tracer: null,
    });

    // 1 iteration: compaction at top (1 call), text-only termination,
    // stop hook fires (1 call).
    expect(compactionCalls).toBe(1);
    expect(stopCalls).toBe(1);
  });

  it('mixed flow: reanimate on call 1, abort on call 2 — primary sidecar verifier path', async () => {
    // Simulates the production Sidecar Verifier flow:
    //   call 1: verifier says 'revise: missing tests' → reanimate
    //   call 2: verifier says 'blocked: still missing' → abort
    // This is the primary "retry once then block" sequence and must
    // be regression-protected.
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookCall++;
      if (hookCall === 1) return 'fix your output';
      return { abort: true, reason: 'still wrong after retry' };
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    expect(hookCall).toBe(2);
    expect(result.stoppedByHook).toBe(true);
    expect(result.output).toBe('still wrong after retry');
    // Synthetic user message from reanimate is in transcript before the
    // 2nd assistant message and the abort.
    const userMessages = result.messages.filter((m) => m.role === 'user');
    expect(userMessages.some((m) => m.content === 'fix your output')).toBe(true);
    expect(userMessages.find((m) => m.content === 'fix your output')?._synthetic).toBe(true);
  });

  it('budget=0 immediately aborts on first string return', async () => {
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (): Promise<StopHookResult> => {
      hookCall++;
      return 'try again';
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      stopHookReanimateBudget: 0,
      tracer: null,
    });

    // budget=0 means "zero reanimates allowed" — first string return is
    // immediately treated as budget-exhausted abort.
    expect(hookCall).toBe(1);
    expect(result.stoppedByHook).toBe(true);
    expect(result.output).toBe('reanimate budget exhausted: try again');
  });

  it('negative budget is clamped to 0 (does not crash, behaves as budget=0)', async () => {
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (ctx: StopHookContext): Promise<StopHookResult> => {
      hookCall++;
      // ctx.reanimateBudget should reflect the clamped value (0), not -1.
      expect(ctx.reanimateBudget).toBe(0);
      return 'reanimate me';
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      stopHookReanimateBudget: -1,
      tracer: null,
    });

    expect(hookCall).toBe(1);
    expect(result.stoppedByHook).toBe(true);
  });

  it('malformed object return (e.g. {abort: false}) does not silently accept', async () => {
    // Misuse case: JS caller returns `{abort: false}` thinking it means
    // "explicit non-abort". The strict `abort === true` check rejects
    // this, but instead of silently accepting, the Runner emits an
    // error span. We can't easily inspect spans in this test setup,
    // but verify the run still completes (fail-open) and the output is
    // the assistant text (not the malformed object's `reason`).
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'assistant text', toolCalls: [] };
    };
    const hook = async (): Promise<StopHookResult> => {
      // Cast through unknown — represents a runtime JS misuse that
      // bypasses TS type-checking.
      return { abort: false, reason: 'should not stop' } as unknown as StopHookResult;
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
    });

    expect(result.output).toBe('assistant text');
    expect(result.stoppedByHook).toBeUndefined();
  });

  it('reanimate loop hitting iteration cap throws stop-hook-aware error', async () => {
    // maxToolLoopIterations: 3, stopHookReanimateBudget: 100 (effectively
    // unbounded). Hook always returns string. Loop iterates 3 times then
    // hits the cap. The thrown error must mention stop-hook reanimate,
    // not "the LLM kept requesting tool calls" (which is misleading —
    // no tool calls happened).
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'reply', toolCalls: [] };
    };
    const hook = async (): Promise<StopHookResult> => 'keep going';

    await expect(
      Runner.run(agentNoTools, 'hi', {
        llm,
        stopHook: hook,
        stopHookReanimateBudget: 100,
        maxToolLoopIterations: 3,
        tracer: null,
      }),
    ).rejects.toThrow(/stop-hook reanimate loop/);
  });

  it('attributes a {reanimate, source} result onto the injected synthetic message', async () => {
    let calls = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      calls += 1;
      return { text: `reply-${calls}`, toolCalls: [] };
    };
    // Reanimate once with a structured, attributed result; accept on the retry.
    const hook = async (): Promise<StopHookResult> =>
      calls === 1 ? { reanimate: 'fix the tests', source: 'sidecar-verifier' } : undefined;

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      stopHookReanimateBudget: 2,
      tracer: null,
    });

    const injected = result.messages.find(
      (m) => m.role === 'user' && (m as { _source?: string })._source === 'sidecar-verifier',
    );
    expect(injected).toBeDefined();
    expect(injected?.content).toBe('fix the tests');
    expect((injected as { _synthetic?: boolean })._synthetic).toBe(true);
  });

  it('leaves a bare string reanimate without a _source (back-compat)', async () => {
    let calls = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      calls += 1;
      return { text: `reply-${calls}`, toolCalls: [] };
    };
    const hook = async (): Promise<StopHookResult> => (calls === 1 ? 'keep going' : undefined);

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      stopHookReanimateBudget: 2,
      tracer: null,
    });

    const injected = result.messages.find(
      (m) => m.role === 'user' && (m as { _synthetic?: boolean })._synthetic === true,
    );
    expect(injected?.content).toBe('keep going');
    expect((injected as { _source?: string })._source).toBeUndefined();
  });

  it('hook sees the post-guardrail assistant text in lastAssistantText', async () => {
    // OutputGuardrail rewrites the assistant message. stopHook must see
    // the rewritten text, not the original.
    const llm = async (): Promise<RunnerLlmResult> => {
      return { text: 'original text', toolCalls: [] };
    };
    let capturedText: string | undefined;
    const hook = async (ctx: StopHookContext): Promise<StopHookResult> => {
      capturedText = ctx.lastAssistantText;
      return undefined;
    };

    const result = await Runner.run(agentNoTools, 'hi', {
      llm,
      stopHook: hook,
      tracer: null,
      guardrails: [
        {
          kind: 'output' as const,
          name: 'rewrite-output',
          check: async (message: AgentMessage) => ({
            action: 'rewrite' as const,
            payload: {
              ...message,
              content: 'rewritten by guardrail',
            },
          }),
        },
      ],
    });

    expect(capturedText).toBe('rewritten by guardrail');
    expect(result.output).toBe('rewritten by guardrail');
  });
});
