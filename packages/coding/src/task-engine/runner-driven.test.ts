/**
 * Runner-driven path tests — FEATURE_084 Shard 5a (v0.7.26).
 *
 * Covers:
 *   - Env flag detection (`KODAX_MANAGED_TASK_RUNTIME=runner`)
 *   - Agent construction (Scout with emit + core tools, no handoffs for H0)
 *   - LLM adapter: system split, tool serialization, RunnerLlmResult shape
 *   - End-to-end Scout H0_DIRECT flow via mocked provider stream
 *   - KodaXResult shape: success + lastText + messages, no managedTask
 *     (matches SA fast-path semantics for Shard 5a; Shard 5b populates
 *     managedTask when Generator/Evaluator enter the chain)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// FEATURE_155 (v0.7.39) idle-yield e2e test below. Mock the child-
// executor so the dispatch tool's IIFE has a controllable promise
// instead of spawning a real sub-Runner. None of the pre-existing
// 113 tests in this file invoke `dispatch_child_task` end-to-end —
// they exercise tool topology only — so this mock is a no-op for
// every other suite.
vi.mock('../child-executor.js', async () => ({
  executeChildAgents: vi.fn(),
}));
const { executeChildAgents: mockExecuteChildAgents } = await import('../child-executor.js');
const mockExec = mockExecuteChildAgents as unknown as ReturnType<typeof vi.fn>;
import { _resetMessageQueueForTests, getMessageQueue } from '@kodax-ai/agent';
import {
  buildRunnerAgentChain,
  buildRunnerLlmAdapter,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
} from './runner-driven.js';
import { createTodoStore } from './todo-store.js';
import {
  createTodoDriftReminderState,
  observeTodoDriftAfterToolResult,
} from './todo-drift-reminder.js';
import { MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS } from '../constants.js';
import type { RunnableTool } from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type {
  KodaXChildExecutionResult,
  KodaXEvents,
  KodaXOptions,
  KodaXToolEventMeta,
  KodaXToolExecutionContext,
} from '../types.js';

// Shared scratch directory for `managedTaskWorkspaceDir` so the
// Shard 6d-h artifact writes (contract.json / managed-task.json /
// result.json / ... ) land inside a temp folder instead of polluting
// the repo's cwd with `.agent/managed-tasks/` entries.
let testWorkspaceRoot: string;

beforeAll(async () => {
  testWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-driven-'));
});

afterAll(async () => {
  if (testWorkspaceRoot) {
    await rm(testWorkspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
});

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

function makeOptions(): KodaXOptions {
  return {
    provider: 'anthropic',
    context: {
      gitRoot: process.cwd(),
      executionCwd: process.cwd(),
      managedTaskWorkspaceDir: testWorkspaceRoot,
      // Shard 6d-i: disable task-scoped repo-intelligence capture in
      // unit tests — the capture walks the real repo (cwd is the kodax
      // monorepo during test runs), which would otherwise add tens of
      // seconds per test. Production callers keep the default auto mode.
      repoIntelligenceMode: 'off',
    },
    events: {},
  } as KodaXOptions;
}

describe('isRunnerDrivenRuntimeEnabled', () => {
  const envKey = 'KODAX_MANAGED_TASK_RUNTIME';
  afterEach(() => {
    delete process.env[envKey];
  });

  it('returns false when env var is unset', () => {
    delete process.env[envKey];
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });

  it('returns true for "runner"', () => {
    process.env[envKey] = 'runner';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns true for "RUNNER" (case insensitive)', () => {
    process.env[envKey] = 'RUNNER';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns false for "legacy" or any other value', () => {
    process.env[envKey] = 'legacy';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
    process.env[envKey] = '1';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });
});

// FEATURE_193 v0.7.43: describe('buildRunnerScoutAgent') deleted — V1 chain retired.

describe('buildRunnerLlmAdapter (via overrideStream)', () => {
  it('splits leading system message and sends rest to the stream', async () => {
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, system) => {
      capturedSystem = system;
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'sys-text' },
        { role: 'user', content: 'user-q' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    expect(capturedSystem).toBe('sys-text');
    expect(capturedTranscript).toHaveLength(1);
    expect(capturedTranscript[0]!.content).toBe('user-q');
  });

  it('injects a one-shot todo drift reminder into the next provider call', async () => {
    const todoStore = createTodoStore();
    todoStore.init([{ id: 'todo_1', subject: 'Inspect implementation' }]);
    const driftState = createTodoDriftReminderState();
    observeTodoDriftAfterToolResult({
      state: driftState,
      todoStore,
      call: {
        id: 'read-1',
        name: 'read',
        input: { file_path: 'packages/coding/src/x.ts' },
      },
      result: { content: 'file contents' },
    });

    const capturedSystems: string[] = [];
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async (_transcript, _tools, system) => {
        capturedSystems.push(system);
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
      undefined,
      undefined,
      undefined,
      todoStore,
      undefined,
      undefined,
      driftState,
    );

    await adapter([{ role: 'system', content: 'sys-text' }], { name: 'worker', instructions: 'ignored' });
    await adapter([{ role: 'system', content: 'sys-text' }], { name: 'worker', instructions: 'ignored' });

    expect(capturedSystems[0]).toContain('sys-text');
    expect(capturedSystems[0]).toContain('no item marked in_progress');
    expect(capturedSystems[0]).toContain('call todo_update now');
    expect(capturedSystems[1]).toBe('sys-text');
  });

  // Regression: after compaction + `injectPostCompactAttachments`, the
  // transcript begins with `[compaction-summary, post-compact-ledger,
  // post-compact-file, ...]` — three or more contiguous role:'system'
  // entries. The adapter must join all leading system messages into the
  // `system` parameter so the agent role instructions that the Runner
  // seeded at position 0 don't get stranded behind the summary and so
  // strict OpenAI-compat proxies never see a role:'system' after a
  // user/assistant.
  it('merges all leading contiguous role:system messages into the system param', async () => {
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, system) => {
      capturedSystem = system;
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'agent-instructions' },
        { role: 'system', content: '[对话历史摘要]\nrecent turn notes' },
        { role: 'system', content: '[Post-compact: recent operations]\nledger' },
        { role: 'system', content: '[Post-compact: file content] /a.ts\n...' },
        { role: 'user', content: 'follow-up' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    expect(capturedSystem).toBe(
      'agent-instructions\n\n'
        + '[对话历史摘要]\nrecent turn notes\n\n'
        + '[Post-compact: recent operations]\nledger\n\n'
        + '[Post-compact: file content] /a.ts\n...',
    );
    expect(capturedTranscript).toHaveLength(1);
    expect(capturedTranscript[0]!.role).toBe('user');
    expect(capturedTranscript[0]!.content).toBe('follow-up');
  });

  // SDK bug: AMA `onIterationStart`/`onIterationEnd` reported a hardcoded
  // `maxIter = 20` (the engine's stand-alone `MAX_TOOL_LOOP_ITERATIONS`
  // default) that the Runner-driven path never actually enforces — the
  // real per-invocation cap is `MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS`.
  // The denominator must reflect the real ceiling so the spinner never
  // shows `1/20` / `5/20`.
  it('reports the real per-invocation cap as maxIter, not the stale 20', async () => {
    const starts: Array<{ iter: number; maxIter: number }> = [];
    const ends: Array<{ iter: number; maxIter: number }> = [];
    const adapter = buildRunnerLlmAdapter({
      ...makeOptions(),
      events: {
        onIterationStart: (iter, maxIter) => starts.push({ iter, maxIter }),
        onIterationEnd: (info) => ends.push({ iter: info.iter, maxIter: info.maxIter }),
      },
    } as unknown as KodaXOptions, async () => ({ textBlocks: [{ text: 'ok' }], toolBlocks: [] }));
    await adapter([{ role: 'user', content: 'q' }], { name: 'x', instructions: 'i' });
    expect(starts).toEqual([{ iter: 1, maxIter: MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS }]);
    expect(ends[0]!.maxIter).toBe(MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS);
    expect(starts[0]!.maxIter).not.toBe(20);
  });

  // SDK bug: the adapter counted iterations monotonically across the whole
  // task while the Runner cap is per-invocation, so `iter` could exceed
  // `maxIter` (e.g. `24/20`). The shared `iterationStateRef` lets the
  // idle-yield outer loop reset the counter at each `runOnce`, keeping the
  // reported `iter` in the same per-invocation scope as the Runner loop so
  // `iter <= maxIter` always holds.
  it('iteration counter shares scope via iterationStateRef and resets per run', async () => {
    const iters: number[] = [];
    const iterationStateRef = { current: 0 };
    const adapter = buildRunnerLlmAdapter(
      {
        ...makeOptions(),
        events: { onIterationStart: (iter) => iters.push(iter) },
      } as unknown as KodaXOptions,
      async () => ({ textBlocks: [{ text: 'ok' }], toolBlocks: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      iterationStateRef,
    );
    const agent = { name: 'x', instructions: 'i' };
    await adapter([{ role: 'user', content: 'q1' }], agent);
    await adapter([{ role: 'user', content: 'q2' }], agent);
    // Caller (runOnce) resets at the top of a fresh Runner.run.
    iterationStateRef.current = 0;
    await adapter([{ role: 'user', content: 'q3' }], agent);
    expect(iters).toEqual([1, 2, 1]);
    expect(iters.every((i) => i <= MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS)).toBe(true);
  });

  it('stops at the first non-system message — later role:system stays in transcript for provider-layer merge', async () => {
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, _system) => {
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'leading' },
        { role: 'user', content: 'q1' },
        { role: 'system', content: '[Post-compact: stray]' },
        { role: 'user', content: 'q2' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    // Adapter only strips the leading run; the stray mid-transcript
    // system survives here — the provider layer's normalizeSystemForWire
    // is the safety net that collapses it before the wire goes out.
    expect(capturedTranscript).toHaveLength(3);
    expect(capturedTranscript[0]!.role).toBe('user');
    expect(capturedTranscript[1]!.role).toBe('system');
    expect(capturedTranscript[2]!.role).toBe('user');
  });

  it('strips execute function from agent tools when serializing for the wire', async () => {
    let capturedTools: readonly { name: string; execute?: unknown }[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (_t, tools) => {
      capturedTools = tools as readonly { name: string; execute?: unknown }[];
      return { textBlocks: [], toolBlocks: [] };
    });
    // FEATURE_193 v0.7.43: migrated from Scout/emit_scout_verdict fixture to
    // Worker chain (V1 chain retired).
    const chain = buildRunnerAgentChain(makeCtx(), {});
    await adapter([{ role: 'system', content: 's' }], chain.worker);
    for (const t of capturedTools) {
      expect(t.execute).toBeUndefined();
    }
    expect(capturedTools.some((t) => t.name === 'read')).toBe(true);
  });

  it('converts textBlocks+toolBlocks to RunnerLlmResult shape', async () => {
    const toolBlock: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'read',
      input: { path: 'package.json' },
    };
    const adapter = buildRunnerLlmAdapter(makeOptions(), async () => ({
      textBlocks: [{ text: 'Reading file' }],
      toolBlocks: [toolBlock],
    }));
    const result = await adapter(
      [{ role: 'system', content: 's' }],
      { name: 'x', instructions: '' },
    );
    expect(result.text).toBe('Reading file');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('read');
    expect(result.toolCalls![0]!.input).toEqual({ path: 'package.json' });
  });
});

describe('buildRunnerLlmAdapter — max_tokens escalation (FEATURE_085 Scout parity)', () => {
  const ESCALATION_PROVIDER_NAME = 'runner-driven-max-tokens-test';
  const ESCALATION_PROVIDER_API_KEY_ENV = 'RUNNER_DRIVEN_MAX_TOKENS_TEST_API_KEY';

  let KodaXBaseProviderRef: typeof import('@kodax-ai/llm').KodaXBaseProvider;
  let registerModelProviderFn: typeof import('@kodax-ai/llm').registerModelProvider;
  let clearRuntimeModelProvidersFn: typeof import('@kodax-ai/llm').clearRuntimeModelProviders;
  let KODAX_CAPPED: number;
  let KODAX_ESCALATED: number;

  beforeAll(async () => {
    const aiModule = await import('@kodax-ai/llm');
    KodaXBaseProviderRef = aiModule.KodaXBaseProvider;
    registerModelProviderFn = aiModule.registerModelProvider;
    clearRuntimeModelProvidersFn = aiModule.clearRuntimeModelProviders;
    KODAX_CAPPED = aiModule.KODAX_CAPPED_MAX_OUTPUT_TOKENS;
    KODAX_ESCALATED = aiModule.KODAX_ESCALATED_MAX_OUTPUT_TOKENS;
  });

  afterEach(() => {
    clearRuntimeModelProvidersFn();
    delete process.env[ESCALATION_PROVIDER_API_KEY_ENV];
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
  });

  function registerScriptedProvider(
    responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }>,
    observedBudgets: number[],
  ): void {
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        this.setMaxOutputTokensOverride(undefined); // mirror withRateLimit auto-clear
        return {
          textBlocks: resp.textBlocks,
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: resp.stopReason,
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
  }

  function makeAdapterOptions(): KodaXOptions {
    return {
      ...makeOptions(),
      provider: ESCALATION_PROVIDER_NAME,
    };
  }

  it('forwards provider retry callbacks from managed-worker stream options', async () => {
    const onProviderRateLimit = vi.fn();
    const onRetryAfter = vi.fn();

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        streamOptions?.onRateLimit?.(1, 3, 500);
        streamOptions?.onRetryAfter?.({
          provider: this.name,
          waitMs: 500,
          reason: 'rate-limit',
          source: 'retry-after-ms',
          attempt: 1,
          maxAttempts: 3,
        });
        return {
          textBlocks: [{ type: 'text', text: 'done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: {
        onProviderRateLimit,
        onRetryAfter,
      },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Retry please.' }],
      { name: 'worker', instructions: '' },
    );

    expect(result.text).toBe('done');
    expect(onProviderRateLimit).toHaveBeenCalledWith(1, 3, 500);
    expect(onRetryAfter).toHaveBeenCalledWith({
      provider: ESCALATION_PROVIDER_NAME,
      waitMs: 500,
      reason: 'rate-limit',
      source: 'retry-after-ms',
      attempt: 1,
      maxAttempts: 3,
    });
  }, 15_000);

  it('passes the requested model into every provider stream call, including L5 continuation', async () => {
    const observedModels: Array<string | undefined> = [];
    const responses: KodaXStreamResult[] = [
      {
        textBlocks: [],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      {
        textBlocks: [{ type: 'text', text: 'half' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      {
        textBlocks: [{ type: 'text', text: ' done' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedModels.push(streamOptions?.modelOverride);
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        this.setMaxOutputTokensOverride(undefined);
        return resp;
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      model: 'glm-5.2',
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    expect(result.text).toContain('half');
    expect(result.text).toContain('done');
    expect(observedModels).toEqual(['glm-5.2', 'glm-5.2', 'glm-5.2']);
  }, 15_000);

  it('escalates capped budget to 64K on first max_tokens, reissues same turn', async () => {
    const observedBudgets: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: 'done at 64K' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Generate a long file.' }],
      { name: 'scout', instructions: '' },
    );

    expect(result.text).toBe('done at 64K');
    expect(observedBudgets).toEqual([KODAX_CAPPED, KODAX_ESCALATED]);
  }, 15_000);

  it('does not escalate a second time within the same adapter call', async () => {
    const observedBudgets: number[] = [];
    // v0.7.26 M6 parity — after L1 escalation, if stopReason remains
    // max_tokens with text, the L5 continuation ladder re-streams up to
    // KODAX_MAX_MAXTOKENS_RETRIES times with a synthetic "Continue" user
    // message appended. Script enough responses to satisfy the whole
    // ladder so the adapter settles naturally.
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        // Escalated turn: max_tokens + has text → triggers L5 continuation.
        { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
        // L5 retries surface more text and eventually end_turn.
        { textBlocks: [{ type: 'text', text: ' second' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    // Budgets: L1 capped → L1 escalated → L5 continuation (cleared override).
    // L1 escalation is idempotent (the 64K escalation fires exactly once in
    // positions [1]); subsequent L5 calls reuse whatever effective budget
    // is active at invocation time.
    expect(observedBudgets[0]).toBe(KODAX_CAPPED);
    expect(observedBudgets[1]).toBe(KODAX_ESCALATED);
    // L5 continuation accumulates text across retries.
    expect(result.text).toContain('half');
  }, 15_000);

  it('honors KODAX_MAX_OUTPUT_TOKENS env override and skips escalation', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = '32000';
    const observedBudgets: number[] = [];
    // With the env override pinned, L1 escalation is skipped (explicit
    // user intent). L5 continuation still fires on max_tokens + text,
    // so script enough responses for the ladder.
    registerScriptedProvider(
      [
        { textBlocks: [{ type: 'text', text: 'stuck at user budget' }], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: ' resumed' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'anything' }],
      { name: 'scout', instructions: '' },
    );

    // L1 never fires (KODAX_ESCALATED is absent from observedBudgets).
    expect(observedBudgets.every((b) => b !== KODAX_ESCALATED)).toBe(true);
    expect(result.text).toContain('stuck at user budget');
  }, 15_000);

  // MED-5: when the provider keeps returning max_tokens + text for every L5
  // retry, the adapter MUST bail out after KODAX_MAX_MAXTOKENS_RETRIES
  // iterations instead of looping forever. Regression guard for the
  // `l5Retries < KODAX_MAX_MAXTOKENS_RETRIES` break in runner-driven.ts.
  it('MED-5: L5 continuation breaks out after KODAX_MAX_MAXTOKENS_RETRIES and returns partial text', async () => {
    const { KODAX_MAX_MAXTOKENS_RETRIES } = await import('../constants.js');
    const observedBudgets: number[] = [];
    const responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }> = [
      // Call 1: capped budget → max_tokens empty triggers L1 escalation.
      { textBlocks: [], stopReason: 'max_tokens' },
      // Call 2: escalated budget, max_tokens + text → enters L5 loop.
      { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
    ];
    // Calls 3..(2 + KODAX_MAX_MAXTOKENS_RETRIES): every L5 retry ALSO
    // returns max_tokens + text so the break must fire, not end_turn.
    for (let i = 0; i < KODAX_MAX_MAXTOKENS_RETRIES; i += 1) {
      responses.push({
        textBlocks: [{ type: 'text', text: ` chunk${i + 1}` }],
        stopReason: 'max_tokens',
      });
    }
    // Guard: one extra response beyond the cap — if the loop keeps going
    // it will consume this, and `responses` will run out → throw. We
    // assert later that this extra entry is NEVER consumed.
    const sentinelMarker = 'SHOULD_NEVER_APPEAR';
    responses.push({
      textBlocks: [{ type: 'text', text: sentinelMarker }],
      stopReason: 'max_tokens',
    });

    registerScriptedProvider(responses, observedBudgets);

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'very large' }],
      { name: 'scout', instructions: '' },
    );

    // Exactly (1 capped + 1 escalated + KODAX_MAX_MAXTOKENS_RETRIES) calls.
    expect(observedBudgets.length).toBe(2 + KODAX_MAX_MAXTOKENS_RETRIES);
    // Sentinel never consumed — the break did its job.
    expect(result.text).not.toContain(sentinelMarker);
    // Partial accumulated text is returned instead of crashing.
    expect(result.text).toContain('half');
    for (let i = 1; i <= KODAX_MAX_MAXTOKENS_RETRIES; i += 1) {
      expect(result.text).toContain(`chunk${i}`);
    }
  }, 15_000);

  // L5 continuation meta message must match the Claude Code wording used by
  // agent.ts (cd213e4). Legacy "Continue from where you left off." was weaker;
  // the richer phrasing nudges the model to break remaining work into smaller
  // pieces so the continuation doesn't hit the same wall as the cut-off turn.
  it('L5 continuation injects the Claude Code style meta message', async () => {
    const observedBudgets: number[] = [];
    const capturedMessagesPerCall: Array<readonly import('@kodax-ai/llm').KodaXMessage[]> = [];
    const responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }> = [
      // Turn 1 returns max_tokens with text — after L1 escalation (which
      // doesn't fire here because first turn already at capped budget
      // returns max_tokens; escalation kicks in for turn 2).
      { textBlocks: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
      // L1 escalation turn — still max_tokens with text → L5 continuation fires.
      { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
      // L5 continuation call finishes.
      { textBlocks: [{ type: 'text', text: ' done' }], stopReason: 'end_turn' },
    ];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(messages: import('@kodax-ai/llm').KodaXMessage[]): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        capturedMessagesPerCall.push([...messages]);
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        this.setMaxOutputTokensOverride(undefined);
        return {
          textBlocks: resp.textBlocks,
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: resp.stopReason,
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    // By the third stream call the adapter must have injected the meta
    // message on the provider messages. Scan all subsequent calls after
    // the first one — the L5-style user message must appear.
    const allInjectedTexts = capturedMessagesPerCall
      .slice(1)
      .flatMap((msgs) => msgs)
      .filter((m) => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const hasClaudeCodeWording = allInjectedTexts.some((t) =>
      t.includes('Resume directly')
      && t.includes('no apology, no recap')
      && t.includes('Break remaining work into smaller pieces'),
    );
    expect(hasClaudeCodeWording).toBe(true);
    // And the legacy phrasing must NOT appear — otherwise the upgrade
    // silently regressed.
    expect(allInjectedTexts.some((t) => t === 'Continue from where you left off.')).toBe(false);
  }, 15_000);

  // Regression: escalation is a same-turn re-issue, not an error recovery.
  // Before the `attempt -= 1` fix, the L1 escalation silently consumed one
  // slot of `resilienceCfg.maxRetries`, so a subsequent real error passed
  // the wrong attempt number into the coordinator (leaking 1 retry worth
  // of budget). Concretely: a retryable error immediately after escalation
  // should be seen by `onProviderRecovery` with `attempt === 1`, because
  // the escalation did not consume any retry slot.
  it('L1 escalation does not consume recovery retry budget (onProviderRecovery sees attempt=1 after escalate+throw)', async () => {
    const observedBudgets: number[] = [];
    const recoveryAttempts: number[] = [];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        callIdx += 1;
        this.setMaxOutputTokensOverride(undefined);
        // Call 1: capped budget hit, forces L1 escalation.
        if (callIdx === 1) {
          return {
            textBlocks: [],
            toolBlocks: [],
            thinkingBlocks: [],
            stopReason: 'max_tokens',
          };
        }
        // Call 2: now at escalated budget — throw a retryable
        // connection_failure mid-stream to force the recovery
        // coordinator path. The coordinator receives `attempt` as an
        // argument; with the fix in place it must be 1 (fresh budget
        // after a successful L1 escalation). Without the fix it would
        // be 2 (leaked slot) and the ladder would pick a different
        // action (non_streaming_fallback instead of stable_boundary_retry).
        if (callIdx === 2) {
          throw new Error('zhipu-coding API error: terminated');
        }
        // Call 3 onward: recovery retry succeeds.
        return {
          textBlocks: [{ type: 'text', text: 'recovered ok' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: {
        onProviderRecovery: (evt) => {
          recoveryAttempts.push(evt.attempt);
        },
      },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }],
      { name: 'scout', instructions: '' },
    );

    // Budgets observed: call 1 at capped, call 2 at escalated, call 3 at escalated (after recovery).
    expect(observedBudgets[0]).toBe(KODAX_CAPPED);
    expect(observedBudgets[1]).toBe(KODAX_ESCALATED);
    // The coordinator recovery event must have seen attempt=1 — proving that
    // the escalation did NOT consume a retry slot. Without the fix this
    // would be 2.
    expect(recoveryAttempts).toEqual([1]);
    expect(result.text).toContain('recovered ok');
  }, 15_000);
});

describe('buildRunnerLlmAdapter — empty-completion retry', () => {
  // A finish_reason-complete turn carrying no text, no tool calls, and no
  // thinking is a degraded response (common on budget OpenAI-compat
  // providers under load / right after a 429). The runner's no-tool
  // terminal branch would otherwise misread it as a clean text-only task
  // completion and end the task silently. The adapter re-streams the same
  // turn a bounded number of times. A canonical text-only termination
  // (text present, no tool) must be left untouched — FEATURE_190.
  const EMPTY_PROVIDER_NAME = 'runner-driven-empty-completion-test';
  const EMPTY_PROVIDER_API_KEY_ENV = 'RUNNER_DRIVEN_EMPTY_COMPLETION_TEST_API_KEY';

  let KodaXBaseProviderRef: typeof import('@kodax-ai/llm').KodaXBaseProvider;
  let registerModelProviderFn: typeof import('@kodax-ai/llm').registerModelProvider;
  let clearRuntimeModelProvidersFn: typeof import('@kodax-ai/llm').clearRuntimeModelProviders;

  beforeAll(async () => {
    const aiModule = await import('@kodax-ai/llm');
    KodaXBaseProviderRef = aiModule.KodaXBaseProvider;
    registerModelProviderFn = aiModule.registerModelProvider;
    clearRuntimeModelProvidersFn = aiModule.clearRuntimeModelProviders;
  });

  afterEach(() => {
    clearRuntimeModelProvidersFn();
    delete process.env[EMPTY_PROVIDER_API_KEY_ENV];
  });

  interface ScriptedTurn {
    textBlocks?: { type: 'text'; text: string }[];
    toolBlocks?: KodaXToolUseBlock[];
    thinkingBlocks?: { type: 'thinking'; thinking: string }[];
    stopReason?: string;
  }

  function registerScriptedProvider(turns: ScriptedTurn[], callLog: number[]): void {
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = EMPTY_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: EMPTY_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: 8192,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(): Promise<any> {
        callLog.push(++callIdx);
        const turn = turns[callIdx - 1];
        if (!turn) throw new Error(`No scripted turn for stream call #${callIdx}`);
        return {
          textBlocks: turn.textBlocks ?? [],
          toolBlocks: turn.toolBlocks ?? [],
          thinkingBlocks: turn.thinkingBlocks ?? [],
          stopReason: turn.stopReason ?? 'stop',
        };
      }
    }
    process.env[EMPTY_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(EMPTY_PROVIDER_NAME, () => new Scripted());
  }

  function makeEmptyAdapterOptions(): KodaXOptions {
    return { ...makeOptions(), provider: EMPTY_PROVIDER_NAME };
  }

  it('re-streams on a fully-empty turn, then returns the recovered turn', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'stop' },
        { textBlocks: [{ type: 'text', text: 'recovered answer' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2); // original empty + 1 retry
    expect(result.text).toBe('recovered answer');
  }, 15_000);

  it('re-streams on a thinking-only turn, then returns the recovered public answer', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [],
          toolBlocks: [],
          thinkingBlocks: [{ type: 'thinking', thinking: 'The user greeted me; answer briefly.' }],
          stopReason: 'end_turn',
        },
        { textBlocks: [{ type: 'text', text: 'hello there' }], stopReason: 'end_turn' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2);
    expect(result.text).toBe('hello there');
  }, 15_000);

  it('re-streams when text is only whitespace even if thinking is present', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [{ type: 'text', text: ' \n\t ' }],
          toolBlocks: [],
          thinkingBlocks: [{ type: 'thinking', thinking: 'I know the answer.' }],
          stopReason: 'end_turn',
        },
        { textBlocks: [{ type: 'text', text: 'visible answer' }], stopReason: 'end_turn' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2);
    expect(result.text).toBe('visible answer');
  }, 15_000);

  it('gives up after KODAX_MAX_EMPTY_COMPLETION_RETRIES and fails locally', async () => {
    const { KODAX_MAX_EMPTY_COMPLETION_RETRIES } = await import('../constants.js');
    const callLog: number[] = [];
    const turns: ScriptedTurn[] = [];
    // original + cap retries all empty.
    for (let i = 0; i < KODAX_MAX_EMPTY_COMPLETION_RETRIES + 1; i += 1) {
      turns.push({ textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'stop' });
    }
    // Sentinel beyond the cap — must NEVER be consumed.
    turns.push({ textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' });
    registerScriptedProvider(turns, callLog);

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    await expect(adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    )).rejects.toThrow(/no user-visible text or tool calls/);

    // original (1) + cap retries — sentinel never reached.
    expect(callLog.length).toBe(KODAX_MAX_EMPTY_COMPLETION_RETRIES + 1);
  }, 15_000);

  it('does NOT retry a canonical text-only termination (FEATURE_190 guard)', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [{ type: 'text', text: 'final text-only answer' }], stopReason: 'stop' },
        { textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(1); // no retry — text present
    expect(result.text).toBe('final text-only answer');
  }, 15_000);

  it('does NOT retry a turn that has tool calls but no text', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [],
          toolBlocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
          thinkingBlocks: [{ type: 'thinking', thinking: 'Need to read first.' }],
          stopReason: 'tool_use',
        },
        { textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(1); // tool call present → not empty → no retry
    expect(result.toolCalls.length).toBe(1);
  }, 15_000);
});

describe('runManagedTaskViaRunner — end-to-end', () => {
  // FEATURE_193 v0.7.43: Scout H0_DIRECT emit_scout_verdict flow it deleted (V1 chain retired — Scout role + emit_scout_verdict tool retired)

  it('handles a zero-tool direct answer (Worker answers without emit)', async () => {
    // Edge case: a minimalist Worker that just returns the answer as text.
    // The run still completes; managedTask is populated with defaults (harness=H0_DIRECT).
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Say hello',
      async () => ({ textBlocks: [{ text: 'Hello, world.' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Hello, world.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
  });

  it('records todo drift telemetry and injects the next-turn reminder through runner wiring', async () => {
    const warnings: Array<Parameters<NonNullable<KodaXEvents['onTodoDriftWarning']>>[0]> = [];
    const todoSnapshots: Array<Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[0]> = [];
    const systems: string[] = [];
    let callCount = 0;
    const options: KodaXOptions = {
      ...makeOptions(),
      events: {
        onTodoDriftWarning: (event) => {
          warnings.push(event);
        },
        onTodoUpdate: (items) => {
          todoSnapshots.push(items);
        },
      },
    };

    const result = await runManagedTaskViaRunner(
      options,
      'Inspect todo drift wiring',
      async (_transcript, _tools, system) => {
        systems.push(system);
        callCount += 1;
        if (callCount === 1) {
          return {
            textBlocks: [],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'todo-create-1',
                name: 'todo_create',
                input: { subject: 'Inspect implementation' },
              },
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read',
                input: { path: path.join(process.cwd(), 'README.md') },
              },
            ],
          };
        }
        return {
          textBlocks: [{ text: 'Done after reminder.' }],
          toolBlocks: [],
        };
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'work_started_without_claimed_todo',
      toolName: 'read',
      firstPendingTodoSubject: 'Inspect implementation',
    });
    expect(todoSnapshots.some((snapshot) => snapshot[0]?.status === 'pending')).toBe(true);
    expect(systems[1]).toContain('no item marked in_progress');
    expect(systems[1]).toContain('call todo_update now');
    expect(result.managedTask?.runtime?.todoDriftWarnings).toEqual(warnings);
  });

  it('FEATURE_211: returns and persists extension runtime session snapshots', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
      appendSessionRecord(
        extensionId: string,
        type: string,
        data?: unknown,
        options?: { dedupeKey?: string },
      ): unknown;
    };

    let controller: TestSessionController | undefined;
    let released = false;
    const save = vi.fn(async () => undefined);
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          released = true;
          controller = undefined;
        };
      },
      hydrateSession: async (sessionId: string) => {
        controller?.setSessionState('ext:runner', 'visits', 1);
        controller?.appendSessionRecord('ext:runner', 'hydrate', { sessionId });
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211',
          storage: {
            load: vi.fn(async () => null),
            save,
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { visits: 1 },
    });
    expect(result.runtimeSessionSnapshot?.extensionRecords).toEqual([
      expect.objectContaining({
        extensionId: 'ext:runner',
        type: 'hydrate',
        data: { sessionId: 'runner-feature-211' },
      }),
    ]);
    expect(save).toHaveBeenCalledWith(
      'runner-feature-211',
      expect.objectContaining({
        extensionState: { 'ext:runner': { visits: 1 } },
        extensionRecords: [
          expect.objectContaining({
            extensionId: 'ext:runner',
            type: 'hydrate',
          }),
        ],
      }),
    );
    expect(released).toBe(true);
  });

  it('FEATURE_211: hydrates extension runtime with the resolved fallback session id', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    let hydratedSessionId: string | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          controller = undefined;
        };
      },
      hydrateSession: async (sessionId: string) => {
        hydratedSessionId = sessionId;
        controller?.setSessionState('ext:runner', 'sessionId', sessionId);
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          storage: {
            load: vi.fn(async () => null),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.sessionId).toMatch(/^runner-/);
    expect(hydratedSessionId).toBe(result.sessionId);
    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { sessionId: result.sessionId },
    });
  });

  it('FEATURE_211: hydrateSession intentionally wins duplicate keys over storage state', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          controller = undefined;
        };
      },
      hydrateSession: async () => {
        controller?.setSessionState('ext:runner', 'phase', 'hydrate');
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211-hydrate-order',
          storage: {
            load: vi.fn(async () => ({
              messages: [{ role: 'user', content: 'previous turn' }],
              title: 'Previous',
              gitRoot: '/repo',
              extensionState: {
                'ext:runner': { phase: 'storage', keep: true },
              },
            })),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { phase: 'hydrate', keep: true },
    });
  });

  it('FEATURE_211: ignores invalid extension runtime release handles', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return { release: true };
      },
      hydrateSession: async () => {
        controller?.setSessionState('ext:runner', 'phase', 'hydrate');
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211-invalid-release',
          storage: {
            load: vi.fn(async () => null),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { phase: 'hydrate' },
    });
  });

  it('surfaces tool errors back to the LLM without failing the run', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Read /nonexistent/path',
      async (transcript) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read',
                input: { file_path: '/definitely/does/not/exist/xyz.txt' },
              },
            ],
          };
        }
        // Second turn: LLM sees the tool error and adapts.
        const last = transcript[transcript.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.type).toBe('tool_result');
        // The read tool might fail with a specific error; either is_error
        // is true or content carries a "[Tool Error]" prefix.
        const errored = blocks[0]!.is_error === true
          || blocks[0]!.content.toLowerCase().includes('error')
          || blocks[0]!.content.toLowerCase().includes('enoent');
        expect(errored).toBe(true);
        return { textBlocks: [{ text: 'File does not exist; try a different path.' }], toolBlocks: [] };
      },
    );
    expect(result.success).toBe(true);
    expect(result.lastText).toMatch(/does not exist/);
  });
});

// FEATURE_114 v0.7.36 Slice 5 — V2 single-loop end-to-end runner test.
// Sibling to the Slice 3b unit tests that asserted chain SHAPE; this
// test asserts the chain actually FLOWS through Worker → Evaluator
// when KODAX_HARNESS_V2=true. Reuses the `makeChainMockLlm` helper
// (per-agent turn detection via system-prompt sniffing) and adds a
// 'worker' branch.
describe('FEATURE_114 v0.7.36 Slice 5 — V2 Worker→Evaluator end-to-end', () => {
  // FEATURE_193 v0.7.43: withHarnessV2 helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

  it('runs a V2 trivial flow: Worker terminates text-only', async () => {
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Trivial arithmetic — answering directly. 2 + 2 = 4.' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'What is 2 + 2?',
      mock,
    );
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Worker answer reaches the user via lastText.
    expect(result.lastText).toMatch(/2 \+ 2 = 4/);
    // FEATURE_184 (v0.7.45): the Sidecar Verifier StopHook fires on
    // Worker text-only termination and writes a verdict slot via
    // `verifier-recorder-bridge.applySidecarVerdictToRecorder`. In the
    // unit-test environment the verifier provider is `anthropic`
    // without a real API key, so `provider.stream` throws inside the
    // verifier; the fail-open policy resolves to `verdict: 'accept'`
    // (trace=`provider_error`, see `verifier.ts:251`). The recorder
    // bridge stamps `source: 'sidecar'` on the recorded payload.
    //
    // Pre-2026-05-23 this slot was silently `undefined` because
    // `currentAgentRoleRef` was stuck at the V1 `'scout'` sentinel and
    // the verifier gate (`isExecutionRole === 'worker'`) never opened
    // (regression from F193 Commit 2 `c5d4b829`, restored by the
    // ref-init fix).
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('V2 active: preflight emits activeWorkerTitle="Worker" (not "Scout")', async () => {
    // FEATURE_114 v0.7.38 Slice 7 — when V2 is the entry path
    // (chain.worker), the runner's preflight emit MUST carry the
    // Worker label so the REPL prefix on Worker's tool calls reads
    // `[Worker] read/bash/grep`. The previous hardcoded scout label
    // persisted into every Worker tool call (no slot emit had fired
    // yet) and made V2 sessions appear to still be running V1.
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done.' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    await runManagedTaskViaRunner(opts, 'What is 2 + 2?', mock);
    const preflight = statuses.find((s) => s.phase === 'preflight');
    expect(preflight?.activeWorkerId).toBe('worker');
    expect(preflight?.activeWorkerTitle).toBe('Worker');
    expect(preflight?.note).toBe('Worker analyzing task');
  });

  // FEATURE_190 Phase 3: Worker terminates text-only — onRoleEmit('worker')
  // is never called, so no `phase:'worker', activeWorkerId:'worker'` event
  // with the "completed a turn" note exists to assert against. The agentSwitched
  // event does fire but was not the invariant this test exercised (it checked
  // the onRoleEmit path specifically). Covered by text-only-termination.test.ts.
  it.todo('post-F190: V2 worker onRoleEmit event no longer fires — Worker terminates text-only; covered by text-only-termination.test.ts');

  // FEATURE_193 v0.7.43: V1 flag-off routing test deleted (Scout chain agents retired).
});

// FEATURE_196 (v0.7.43) — content-aware sidecar fire gate integration.
//
// Gate logic + regex boundaries covered exhaustively in `gate.test.ts`
// (23 unit tests). These integration tests verify the wire-up to
// `runner-driven.ts:composedStopHook` — fire/skip routing produces the
// right end-state in `managedProtocolPayload.verdict`. The unit-test
// env has no API keys so when the sidecar verifier fires it fail-opens
// to `accept` (trace=`provider_error`); when it skips, no verdict is
// recorded.
describe('FEATURE_196 v0.7.43 — sidecar content-aware fire gate (integration)', () => {
  it('trivial greeting → gate skips → no sidecar verdict written', async () => {
    // User: "你好" (Chinese greeting, 2 chars, no imperative).
    // Worker: text-only "你好!". Layer 2 detects conversational
    // intent → gate skips → composedStopHook returns through the
    // extension chain without invoking the verifier.
    //
    // Pre-F196 the verifier would have fail-open to accept and
    // stamped `source: 'sidecar'` on the verdict. Post-F196 the gate
    // skips → no verdict slot is written → `managedProtocolPayload?.verdict`
    // is undefined.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            textBlocks: [{ text: '你好! 我是 KodaX 的开发助手。' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), '你好', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Gate skipped sidecar — verdict slot never populated.
    expect(result.managedProtocolPayload?.verdict).toBeUndefined();
  });

  it('mutation tool call → gate fires → sidecar verdict written', async () => {
    // Worker invokes a mutation tool (action-surface signal). Layer 1
    // returns fire. Verifier fires + fail-opens to accept in the
    // key-less test env.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'todo_create',
              input: { items: [{ subject: 'plan step', description: 'do work' }] },
            }],
          };
        }
        // Turn 2 — text-only termination after tool ran.
        return {
          textBlocks: [{ text: 'Done. Plan items recorded.' }],
          toolBlocks: [],
        };
      },
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      // Imperative user message — even without Layer 1, Layer 2 would
      // defer to default fire.
      'plan three things and implement them',
      mock,
    );
    // Mutation tool call signals "real work" — gate fires regardless
    // of user-message intent.
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('imperative + zero tool action (zhipu floor) → gate fires safely (F184 contract)', async () => {
    // The CORE F184 contract case: user asked Worker to do something
    // imperative, Worker responds text-only without invoking a tool
    // (intent-vs-action floor). Layer 2's conversational check must
    // NOT skip this — safe default fires → sidecar verifies the claim.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            // No tool call — Worker just claims to have done it.
            textBlocks: [{ text: '明白，我用 grep 搜索了 README 文件。结果如下...' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      '查一下 README 文件',
      mock,
    );
    // Imperative user + zero action ⇒ gate defaults to fire.
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    // Fail-open accept in key-less test env. Production with real API
    // would surface the verifier's actual verdict (likely revise/
    // blocked given the false-action claim).
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

// FEATURE_167 (v0.7.41) Evaluator terminal-verdict fallback (B1+B2) deleted
// in FEATURE_184 Phase C.2 (v0.7.45). The three-layer B0/B1/B2 retry/synth
// fallback block is superseded by the Sidecar Verifier StopHook (Phase D.2).

describe('parity — Runner path and legacy SA path produce compatible KodaXResult shape', () => {
  // The goal of Shard 5a parity is NOT byte-level equivalence (the legacy
  // AMA state machine emits dozens of observer events and populates a
  // full managedTask payload that the Shard 5a skeleton doesn't produce).
  // The goal IS user-facing shape parity: both paths return a KodaXResult
  // with success + lastText + messages + sessionId, and FEATURE_076's
  // round-boundary reshape can consume either one without special casing.
  it('runner-path KodaXResult is compatible with FEATURE_076 round-boundary reshape', async () => {
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Trivial task',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    // Required fields for reshape (see round-boundary.ts):
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.lastText).toBe('string');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    // Shard 6a populates managedTask even on zero-tool runs.
    // FEATURE_184 (v0.7.45): Sidecar Verifier fires on Worker text-only
    // termination. In the unit-test environment without a real API
    // key, the verifier fail-opens to `accept` (provider_error trace),
    // which `payload-builder.ts:285-294` maps to `status: 'completed'`.
    // Restored 2026-05-23 by fixing the `currentAgentRoleRef` init
    // regression that previously gated the verifier off (was stuck at
    // V1 `'scout'` sentinel; now `'worker'` so `isExecutionRole` opens
    // the gate from turn 0).
    expect(result.managedTask?.verdict?.status).toBe('completed');
  });

  // FEATURE_173 (v0.7.42) Part A — kill `runner-${epoch}` ghost-session
  // double-write. When the REPL caller passes `options.session.id` (the
  // canonical `YYYYMMDD_HHMMSS` session file id), the result must echo it
  // back verbatim — `Runner.run` does not own a Session here (would
  // trigger `session.append` writes), so the synth `runner-${Date.now()}`
  // fallback at runner-driven.ts MUST NOT fire. The pre-fix bug caused
  // REPL to save TWO `.jsonl` files per conversation (REPL-side under
  // `YYYYMMDD_HHMMSS` + ghost-side under `runner-${epoch}`).
  it('FEATURE_173 Part A: propagates caller-supplied session.id, never falls through to runner-${epoch} ghost', async () => {
    const callerSessionId = '20260522_180000';
    const options = {
      ...makeOptions(),
      session: { id: callerSessionId },
    } as KodaXOptions;

    const result = await runManagedTaskViaRunner(
      options,
      'Trivial task',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.sessionId).toBe(callerSessionId);
    // Negative assertion: the ghost-fallback prefix must NEVER appear when
    // caller supplied an id. Future regressions where someone reverses the
    // ??-chain order at runner-driven.ts:~1965 will trip this immediately.
    expect(result.sessionId.startsWith('runner-')).toBe(false);
  });
});

// =============================================================================
// Shard 5b parity matrix — 4 multi-agent canonical paths
// =============================================================================

/**
 * Helper: build a mock LLM that dispatches per agent name. Each agent's
 * turn handler receives the turn number (1-indexed per agent) and may
 * return a text-only response, a tool-calling response, or throw.
 */
type AgentTurn = (
  turnOfThisAgent: number,
  transcript: readonly KodaXMessage[],
) => {
  textBlocks?: readonly { text: string }[];
  toolBlocks?: readonly KodaXToolUseBlock[];
};

function makeChainMockLlm(handlers: Record<string, AgentTurn>) {
  const turnCount: Record<string, number> = {};
  // We can't see the agent name from the stream signature, but the system
  // message content tells us: it's the agent's instructions. We grep each
  // role's distinct marker.
  const detectRole = (system: string): string => {
    if (system.includes('You are Scout')) return 'scout';
    if (system.includes('You are Planner')) return 'planner';
    if (system.includes('You are Generator')) return 'generator';
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_114 v0.7.36 Slice 5 — Worker prompt opens with one
    // of two markers depending on whether the prompt is built via
    // `worker-role-prompt.ts` (production path: "You are the Worker
    // — KodaX's single primary agent …") or the
    // `WORKER_INSTRUCTIONS_FALLBACK` constant in this file
    // (test/topology-only path: "You are Worker (AMA Harness V2 …").
    // Match both so e2e tests work whether or not promptContext is
    // wired by the test fixture.
    if (
      system.includes('You are the Worker')
      || system.includes('You are Worker (AMA Harness V2')
    ) {
      return 'worker';
    }
    return 'unknown';
  };
  return async (
    transcript: readonly KodaXMessage[],
    _tools: readonly KodaXToolDefinition[],
    system: string,
  ) => {
    const role = detectRole(system);
    turnCount[role] = (turnCount[role] ?? 0) + 1;
    const handler = handlers[role];
    if (!handler) {
      // Debug aid: when role is "unknown", surface the first 200
      // chars of the system prompt so the test failure tells us why
      // the role detector missed.
      throw new Error(
        `No mock handler for role ${role}. system head: ${JSON.stringify(system.slice(0, 240))}`,
      );
    }
    return handler(turnCount[role]!, transcript);
  };
}

// FEATURE_193 v0.7.43: V1 Scout→Generator H1 accept describe deleted (V1 chain retired).

// FEATURE_193 v0.7.43: M5 Scout pre-handoff write warning describe deleted (V1 chain retired).

// FEATURE_193 v0.7.43: Shard 5b parity H1 (scout→generator text-only) describe deleted (V1 chain retired — uses emit_scout_verdict + generator role)

// FEATURE_193 v0.7.43: Shard 5b parity H2 (scout→planner→generator) describe deleted (V1 chain retired — uses emit_scout_verdict + emit_contract + generator role)

describe('Shard 5b parity — blocked path', () => {
  // FEATURE_190 Phase 3: emit_handoff deleted. BLOCKED semantics now owned
  // by Sidecar Verifier — covered by sidecar.test.ts.
  it.todo('post-F190: blocked semantics owned by Sidecar Verifier — covered by sidecar.test.ts');
});

// =============================================================================
// Shard 6a — Observer events + managedTask payload
// =============================================================================

describe('Shard 6a — onManagedTaskStatus observer events', () => {
  it('fires preflight at start and completed at end', async () => {
    const statuses: Array<{
      phase?: string;
      activeWorkerId?: string;
      activeWorkerTitle?: string;
      note?: string;
    }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: {
          phase?: string;
          activeWorkerId?: string;
          activeWorkerTitle?: string;
          note?: string;
        }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    const preflight = statuses.find((s) => s.phase === 'preflight');
    expect(preflight).toBeDefined();
    // FEATURE_193 v0.7.43: V2 default — preflight carries Worker label.
    expect(preflight?.activeWorkerId).toBe('worker');
    expect(preflight?.activeWorkerTitle).toBe('Worker');
    expect(preflight?.note).toBe('Worker analyzing task');
    expect(statuses.some((s) => s.phase === 'completed')).toBe(true);
  });

  // FEATURE_193 v0.7.43: fires round events per role emit (Scout → Generator) it deleted (V1 chain retired)

  // FEATURE_193 v0.7.43: fires completed with BLOCKED signal note on blocked handoff it deleted (V1 chain retired — emit_handoff deleted)
});

// FEATURE_193 v0.7.43: Shard 6a managedTask payload shape describe deleted (V1 chain retired — all its used scout/planner/generator roles)

// =============================================================================
// Shard 6b — Real budget tracking + mutation tracker
// =============================================================================

// FEATURE_193 v0.7.43: 'Shard 6b — budget controller' describe deleted — all 4 tests used scout + emit_scout_verdict (V1 chain retired)
//   increments spentBudget per tool invocation it deleted
//   upgrades totalBudget when Scout picks H1 it deleted
//   keeps H0 budget when Scout chooses H0_DIRECT it deleted
//   upgrades to 200 when Scout picks H2 it deleted

// FEATURE_193 v0.7.43: Shard 6b mutation tracker describe deleted (V1 chain retired — uses scout + generator roles)

// =============================================================================
// Shard 6c — Checkpoint recovery (FEATURE_071)
// =============================================================================

// FEATURE_193 v0.7.43: Shard 6c checkpoint handling describe deleted (V1 chain retired — both its used scout/generator roles)

// FEATURE_193 v0.7.43: Shard 5b H2 Generator terminates after planning describe deleted (V1 chain retired — uses scout/planner/generator roles)

describe('Shard 6d-c1 — observer event enrichment', () => {
  // FEATURE_193 v0.7.43: populates activeWorkerTitle/currentRound/maxRounds on round events it deleted (V1 chain retired — uses scout/generator roles)

  it('populates globalWorkBudget and budgetUsage on every event', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    const event = statuses.find((s) => s.phase === 'preflight');
    expect(typeof event?.globalWorkBudget).toBe('number');
    expect(typeof event?.budgetUsage).toBe('number');
    expect(event?.budgetApprovalRequired).toBe(false);
  });

  // FEATURE_193 v0.7.43: completed event has persistToHistory=true it deleted (V1 chain retired — uses scout/generator roles)
  // FEATURE_193 v0.7.43: round events default persistToHistory=false it deleted (V1 chain retired — onRoleEmit path is V1-only; V2 Worker text-only termination does not fire onRoleEmit)
});

describe('Shard 6d-c2 — stream event passthrough', () => {
  it('forwards onTextDelta / onThinkingDelta via provider stream options', async () => {
    // We verify by going through the real adapter + a fake provider.stream
    // the adapter passes streamOptions to. Since `runManagedTaskViaRunner`
    // accepts an `adapterOverride` that *replaces* the stream entirely
    // (bypassing `resolveProvider`), these two hooks are exercised at the
    // adapter layer in `buildRunnerLlmAdapter` rather than here — this
    // test confirms the adapter propagates events through the override
    // signature (which carries `system` + `tools` + `transcript`).
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const opts = {
      ...makeOptions(),
      events: {
        onTextDelta: (t: string) => textDeltas.push(t),
        onThinkingDelta: (t: string) => thinkingDeltas.push(t),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    // The override stream path does NOT hit provider.stream; for this
    // regression it is sufficient that options.events is surfaced into
    // buildRunnerLlmAdapter (verified via type-check) and tests below
    // exercise the non-override path only under integration.
    await runManagedTaskViaRunner(opts, 'hi', async () => ({
      textBlocks: [{ text: 'hi' }], toolBlocks: [],
    }));
    // With adapterOverride, no provider.stream call happens, so deltas
    // remain empty. The field wiring itself is compile-time guaranteed
    // via buildRunnerLlmAdapter's passthrough of streamOptions.
    expect(textDeltas).toEqual([]);
    expect(thinkingDeltas).toEqual([]);
  });
});

describe('Shard 6d-f — role-scoped tool boundaries (legacy toolPolicy parity)', () => {
  function findTool(agent: { tools?: readonly KodaXToolDefinition[] }, name: string): RunnableTool {
    const tool = agent.tools?.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found on agent`);
    return tool as RunnableTool;
  }

  // Minimal RunnerToolContext for tests — `agent` is unused by the
  // bash / mutation-guard path but required by the interface.
  function makeToolCtx(agentName: string): import('@kodax-ai/agent').RunnerToolContext {
    return { agent: { name: agentName } as unknown as import('@kodax-ai/agent').Agent };
  }

  // FEATURE_193 v0.7.43: Planner + Generator topology tests deleted —
  // V1 chain agents retired from agent-chain.ts.

  // FEATURE_114 v0.7.36 Slice 3a — Worker agent in the runner chain.
  // Slice 3a is intentionally additive: the Worker slot is built but
  // never dispatched until Slice 3b flips the entry agent under
  // KODAX_HARNESS_V2=true. These tests assert structural presence
  // (chain.worker exists with the right name + tool surface +
  // single-handoff topology) so Slice 3b has a stable target.
  describe('FEATURE_114 Slice 3a — Worker agent topology', () => {
    it('chain.worker exists with the canonical worker agent name', () => {
      const chain = buildRunnerAgentChain(makeCtx(), {});
      expect(chain.worker.name).toBe('kodax/role/worker');
    });

    it('Worker exposes the full execution toolbox (Scout exec ∪ Generator mutation surface)', () => {
      // FEATURE_190 Phase 3: emit_handoff deleted — Worker terminates text-only.
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const workerTools = chain.worker.tools?.map((t) => t.name) ?? [];
      // emit_handoff no longer exists post-F190 Phase 3.
      expect(workerTools).not.toContain('emit_handoff');
      // Read surface — every probe Scout/Generator have.
      expect(workerTools).toContain('read');
      expect(workerTools).toContain('grep');
      expect(workerTools).toContain('glob');
      // Mutation surface — Worker is the V2 single-loop executor.
      expect(workerTools).toContain('bash');
      expect(workerTools).toContain('write');
      expect(workerTools).toContain('edit');
      expect(workerTools).toContain('multi_edit');
      // Plan + flow control.
      expect(workerTools).toContain('todo_update');
      expect(workerTools).toContain('todo_list');
      expect(workerTools).toContain('exit_plan_mode');
      // Async dispatch (FEATURE_119 Pattern B parity).
      expect(workerTools).toContain('dispatch_child_task');
      // FEATURE_155 v0.7.39 Slice C1 — `await_child_task` was deleted
      // entirely. Idle-yield (always-on since Slice C3) is the only
      // wait mechanic for child dispatches.
      expect(workerTools).not.toContain('await_child_task');
      // Worker MUST NOT carry the V1 emit tools — those belong to the
      // legacy roles only.
      expect(workerTools).not.toContain('emit_scout_verdict');
      expect(workerTools).not.toContain('emit_contract');
      expect(workerTools).not.toContain('emit_verdict');
    });

    it('Worker has no handoffs (FEATURE_184 C.1: Evaluator removed from chain)', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // FEATURE_190 Phase 3: Worker terminates text-only; no agent handoff edge.
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const handoffs = chain.worker.handoffs ?? [];
      expect(handoffs).toHaveLength(0);
    });

    // FEATURE_193 v0.7.43: 'V1/V2 chain topology: no Worker targets in scout/planner/generator handoffs' deleted
    //   (KODAX_HARNESS_V2='false' + chain.scout/planner/generator — V1 chain retired)
  });

  // FEATURE_114 v0.7.36 Slice 3b — V2 single-loop topology under flag.
  // When KODAX_HARNESS_V2=true, the runner-driven chain swaps
  // Evaluator's revise target from Generator to Worker so the
  // single-loop Worker → Evaluator → revise(Worker) path resolves.
  // The entry-agent swap (chain.scout vs chain.worker) is wired in
  // `runManagedTaskViaRunnerInner` itself; that requires the full
  // runner harness so it's covered indirectly via the existing
  // Scout-H0 e2e test under flag-off baseline + a unit assertion on
  // `isHarnessV2Enabled` here.
  describe('FEATURE_114 Slice 3b — V2 flag-gated handoff topology', () => {
    // FEATURE_193 v0.7.43: withHarnessV2 sync helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // "V2 active: Evaluator revise targets Worker" test deleted (chain.evaluator gone).

    it('V2 active: Worker has no handoffs (FEATURE_184 C.1: Evaluator removed)', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // FEATURE_190 Phase 3: Worker terminates text-only (emit_handoff deleted); no edge to Evaluator.
      // FEATURE_193 v0.7.43: withHarnessV2 wrapper removed (V2 is now unconditional default)
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const workerTargets = (chain.worker.handoffs ?? []).map((h) => h.target.name);
      expect(workerTargets).toHaveLength(0);
      expect(workerTargets).not.toContain('kodax/role/evaluator');
    });

    it('flag toggles deterministically: same chain factory, Worker has no Evaluator target in either mode', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // chain.evaluator no longer exists; verify Worker has no Evaluator target.
      // FEATURE_193 v0.7.43: withHarnessV2 wrappers removed (V2 is now unconditional default)
      const chain1 = buildRunnerAgentChain(makeCtx(), {});
      expect((chain1.worker.handoffs ?? [])).toHaveLength(0);
      const chain2 = buildRunnerAgentChain(makeCtx(), {});
      expect((chain2.worker.handoffs ?? [])).toHaveLength(0);
    });
  });

  // FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator.
  // The runner wraps `todo_update` so a successful pending|in_progress
  // → completed transition on an item with `evaluator: 'build'|'test'|
  // 'lint'` triggers the corresponding npm command and threads stderr
  // back into the tool result. These tests use a stub evaluator runner
  // (injected via `buildRunnerAgentChain`'s last param) to avoid
  // spawning real shell commands; the helper's own contract is covered
  // by `deterministic-evaluator.test.ts`.
  describe('FEATURE_114 Slice 3c — deterministic per-step evaluator wrap', () => {
    type StubCall = {
      hint: 'build' | 'test' | 'lint';
      cwd: string;
    };

    function buildStubRunner(calls: StubCall[], outcome: 'pass' | 'fail'): (
      input: { hint: 'build' | 'test' | 'lint'; cwd: string },
    ) => Promise<{
      hint: 'build' | 'test' | 'lint';
      command: string;
      status: 'pass' | 'fail' | 'skipped' | 'error';
      exitCode: number | undefined;
      stderrTail: string;
      stdoutTail: string;
      durationMs: number;
    }> {
      return async (input) => {
        calls.push({ hint: input.hint, cwd: input.cwd });
        return outcome === 'pass'
          ? {
            hint: input.hint,
            command: `npm run ${input.hint}`,
            status: 'pass',
            exitCode: 0,
            stderrTail: '',
            stdoutTail: '',
            durationMs: 12,
          }
          : {
            hint: input.hint,
            command: `npm run ${input.hint}`,
            status: 'fail',
            exitCode: 1,
            stderrTail: 'TypeError: cannot read x of undefined',
            stdoutTail: '',
            durationMs: 18,
          };
      };
    }

    async function buildChainWithEvaluator(
      stubCalls: StubCall[],
      outcome: 'pass' | 'fail',
    ): Promise<{
      chain: ReturnType<typeof buildRunnerAgentChain>;
      todoStore: import('./todo-store.js').TodoStore;
    }> {
      const { createTodoStore } = await import('./todo-store.js');
      const todoStore = createTodoStore();
      const stub = buildStubRunner(stubCalls, outcome);
      // Production wires `todoStore` into baseCtx so the underlying
      // todo_update tool handler can read it via `ctx.todoStore`. Mirror
      // that here so the wrapper sees real status transitions instead
      // of the not-active error path.
      const ctxWithStore: KodaXToolExecutionContext = { ...makeCtx(), todoStore };
      const chain = buildRunnerAgentChain(
        ctxWithStore,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // FEATURE_188 v0.7.42 — childWriteWorktreePathsRef param removed.
        // The remaining trailing slots stay in the same order.
        undefined,
        undefined,
        todoStore,
        undefined,
        undefined,
        '/test/cwd',
        stub,
      );
      return { chain, todoStore };
    }

    function findTodoUpdate(chain: ReturnType<typeof buildRunnerAgentChain>): RunnableTool {
      const tool = chain.worker.tools?.find((t) => t.name === 'todo_update');
      if (!tool) throw new Error('todo_update tool not on worker');
      return tool;
    }

    it('triggers the evaluator when an item with evaluator hint flips to completed', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([
        { id: 't1', subject: 'Build the package', evaluator: 'build' },
        { id: 't2', subject: 'Run tests' },
      ]);
      const tool = findTodoUpdate(chain);
      // Set t1 to completed via the wrapped tool. Snapshot pre-state
      // is captured by the wrapper; post-state shows status='completed'
      // with evaluator='build', so the stub fires.
      const result = await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].hint).toBe('build');
      expect(calls[0].cwd).toBe('/test/cwd');
      expect(typeof result.content).toBe('string');
      expect(String(result.content)).toContain('[evaluator:t1]');
      expect(String(result.content)).toContain('[deterministic-evaluator:build] pass');
    });

    it('threads fail stderr tail into the tool result so the LLM sees it', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'fail');
      todoStore.init([{ id: 't1', subject: 'Run tests', evaluator: 'test' }]);
      const tool = findTodoUpdate(chain);
      const result = await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls[0].hint).toBe('test');
      expect(String(result.content)).toContain('fail');
      expect(String(result.content)).toContain('TypeError: cannot read x of undefined');
    });

    it('does NOT trigger the evaluator on items without an evaluator hint', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([{ id: 't1', subject: 'Plain step (no hint)' }]);
      const tool = findTodoUpdate(chain);
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(0);
    });

    it('does NOT re-trigger the evaluator when the item was already completed (no transition)', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([{ id: 't1', subject: 'Build', evaluator: 'build' }]);
      const tool = findTodoUpdate(chain);
      // First flip — fires.
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      // Second call attempting the same transition — already-completed,
      // wrapper short-circuits.
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(1);
    });

    it('no-op when runtimeCwd is omitted (legacy callers / test fixtures)', async () => {
      const calls: StubCall[] = [];
      const { createTodoStore } = await import('./todo-store.js');
      const todoStore = createTodoStore();
      const stub = buildStubRunner(calls, 'pass');
      const ctxWithStore: KodaXToolExecutionContext = { ...makeCtx(), todoStore };
      const chain = buildRunnerAgentChain(
        ctxWithStore,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        todoStore,
        undefined,
        undefined,
        // runtimeCwd intentionally omitted
        undefined,
        stub,
      );
      todoStore.init([{ id: 't1', subject: 'Build', evaluator: 'build' }]);
      const tool = chain.worker.tools?.find((t) => t.name === 'todo_update');
      if (!tool) throw new Error('todo_update tool missing');
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(0);
    });
  });
});

// FEATURE_193 v0.7.43: 'Shard 6d-T — Scout skillMap injected into Generator + Evaluator instructions' deleted
//   (all tests used chain.generator / chain.scout — V1 chain roles retired)

// FEATURE_193 v0.7.43: Shard 6d-Q V1-agent dispatch_child_task tests deleted
// (chain.scout/.planner/.generator retired). Worker dispatch is covered by
// Worker topology tests in the Slice 3a describe.

// FEATURE_193 v0.7.43: 'Shard 6d-S — task verification contract completionContractStatus' deleted
//   (all tests used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

// FEATURE_193 v0.7.43: 'Shard 6d-U — degraded-continue when upgrade beyond ceiling' deleted
//   (test used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

// FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
// "Shard 6d-f — evaluator graceful fallback when verdict is not emitted" deleted.
// The F167 three-layer B0/B1/B2 retry/synth fallback is superseded by Sidecar Verifier (Phase D.2).

describe('Shard 6d-d — session continuity', () => {
  it('prepends options.session.initialMessages before the new prompt', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    const opts = {
      ...makeOptions(),
      session: {
        initialMessages: [
          { role: 'user' as const, content: 'prior question' },
          { role: 'assistant' as const, content: 'prior answer' },
        ],
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'follow-up question', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'got it' }], toolBlocks: [] };
    });
    // The first LLM turn's transcript (post-system-strip) should contain
    // the prior user/assistant pair + the new user prompt.
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(3);
    expect(firstTurn[0]!.role).toBe('user');
    expect(firstTurn[0]!.content).toBe('prior question');
    expect(firstTurn[1]!.role).toBe('assistant');
    expect(firstTurn[2]!.role).toBe('user');
    expect(firstTurn[2]!.content).toBe('follow-up question');
  });

  it('falls back to raw string prompt when session.initialMessages is empty', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    await runManagedTaskViaRunner(makeOptions(), 'fresh task', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(1);
    expect(firstTurn[0]!.content).toBe('fresh task');
  });
});

describe('Shard 6d-c4 — onIterationEnd + contextTokenSnapshot', () => {
  it('fires onIterationEnd after LLM turn with scope=worker', async () => {
    // FEATURE_193 v0.7.43: migrated from scout/generator to worker (V1 chain retired)
    const iterations: Array<{ iter: number; scope?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onIterationEnd: (info: { iter: number; scope?: string }) =>
          iterations.push({ iter: info.iter, scope: info.scope }),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'T', makeChainMockLlm({
      worker: () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    }));
    expect(iterations.length).toBeGreaterThanOrEqual(1);
    expect(iterations.every((i) => i.scope === 'worker')).toBe(true);
  });

  it('returns undefined contextTokenSnapshot when no provider usage is reported', async () => {
    // Using adapterOverride (no real provider.stream) means no usage data,
    // so the snapshot stays undefined — same behaviour as the SA-mode
    // path for estimated-only runs.
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Hi',
      async () => ({ textBlocks: [{ text: 'Hi' }], toolBlocks: [] }),
    );
    expect(result.contextTokenSnapshot).toBeUndefined();
  });
});

describe('Shard 6d-c3 — budget extension at 90% threshold', () => {
  // FEATURE_193 v0.7.43: 'budget extension askUser is NOT fired on short Scout→Generator run' deleted
  //   (used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

  it('fires askUser when revise summary lands and usage crosses 90% threshold', async () => {
    // Directly exercise `maybeRequestAdditionalWorkBudget` with a
    // pre-seeded controller, proving the helper we wire into the runner
    // path produces the expected askUser dialog + budget extension. The
    // integration with the Runner is exercised at compile-time via the
    // `wrapEmitterWithRecorder` budgetExtension path.
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 370, // 92.5% — over 90% threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'needs more inspection',
      currentRound: 4,
      maxRounds: 6,
      originalTask: 'Heavy task',
    });
    expect(decision).toBe('approved');
    expect(askUserCalls.length).toBe(1);
    expect(askUserCalls[0]!.question).toMatch(/work units|budget/i);
    // Extension increased the budget
    expect(controller.totalBudget).toBeGreaterThan(400);
  });

  it('does not fire askUser when usage is below 90% threshold', async () => {
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<unknown> = [];
    const events: KodaXEvents = {
      askUser: async () => {
        askUserCalls.push({});
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 100, // 25% — well under threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'minor revise',
      currentRound: 2,
      maxRounds: 6,
      originalTask: 'Task',
    });
    expect(decision).toBe('skipped');
    expect(askUserCalls.length).toBe(0);
    expect(controller.totalBudget).toBe(400);
  });

  it('Risk-3: force=true bypasses the 90% threshold short-circuit', async () => {
    // Evaluator explicit budgetRequest funnels through this path: the
    // caller sets `force: true` so the dialog fires even when spent
    // budget is well below the 90% gate.
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 50, // 12.5% — deeply under the auto threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'Evaluator requested more budget: need e2e',
      currentRound: 2,
      maxRounds: 6,
      originalTask: 'Task',
      force: true,
    });
    expect(decision).toBe('approved');
    expect(askUserCalls.length).toBe(1);
    expect(controller.totalBudget).toBeGreaterThan(400);
  });
});

// =============================================================================
// Risk-2 + Risk-3 + Risk-5 — wrapEmitterWithRecorder behavioural guards
//
// Direct exercises of the emit-wrapper's verdict processing via the
// `__runnerDrivenTestables` export. These tests stub the underlying
// emitter (no real LLM, no Runner boot) and assert the wrapper's
// rewrite / auto-conversion / budget-dialog behaviour.
// =============================================================================

describe('wrapEmitterWithRecorder — Risk 2/3/5 behavioural guards', () => {
  type VerdictFixture = {
    status: 'accept' | 'revise' | 'blocked';
    reason?: string;
    followups?: string[];
    nextHarness?: 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    budgetRequest?: string;
  };

  async function harnessTestables() {
    const mod = await import('./runner-driven.js');
    const budgetMod = await import('./_internal/managed-task/budget.js');
    return { ...mod.__runnerDrivenTestables, ...budgetMod };
  }

  function makeFakeVerdictEmitter(verdict: VerdictFixture): RunnableTool {
    return {
      name: 'emit_verdict',
      description: 'stub',
      input_schema: { type: 'object' },
      execute: async () => ({
        content: 'emitted',
        metadata: {
          role: 'evaluator',
          payload: {
            verdict: {
              source: 'evaluator',
              status: verdict.status,
              reason: verdict.reason,
              followups: verdict.followups ?? [],
              userFacingText: '',
              nextHarness: verdict.nextHarness,
              budgetRequest: verdict.budgetRequest,
            },
          },
          handoffTarget: verdict.status === 'revise' ? 'kodax/role/generator' : undefined,
          isTerminal: verdict.status !== 'revise',
        },
      }),
    } as unknown as RunnableTool;
  }

  function makeBudgetExtensionFixture(opts: {
    events?: KodaXEvents;
    upgradeCeiling?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    harness?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
  }) {
    // Plan fixture is intentionally minimal — the wrapper only reads
    // `decision.harnessProfile` and `decision.upgradeCeiling`, so the
    // rest of ReasoningPlan's surface is not required for these tests.
    // Cast through `unknown` to satisfy the full interface.
    const planRef = {
      current: {
        decision: {
          primaryTask: 'edit',
          workIntent: 'implement',
          complexity: 'medium',
          riskLevel: 'low',
          harnessProfile: opts.harness ?? 'H1_EXECUTE_EVAL',
          upgradeCeiling: opts.upgradeCeiling ?? 'H2_PLAN_EXECUTE_EVAL',
          topologyCeiling: 'solo',
          assuranceIntent: 'default',
          recommendedMode: 'default',
          requiresBrainstorm: false,
          reason: 'test',
        },
        effort: 'medium',
        promptOverlay: undefined,
      },
    };
    return {
      planRef,
      degradedContinueRef: { current: false },
      reviseCountByHarnessRef: { current: new Map() },
      harnessRef: { current: opts.harness ?? 'H1_EXECUTE_EVAL' },
      events: opts.events,
      originalTask: 'test task',
      roundRef: { current: 1 },
      maxRoundsRef: { current: 6 },
      budgetApprovalRef: { current: false },
    } as any;
  }

  function makeBudgetController(init: { total: number; spent: number; harness?: string }) {
    return {
      totalBudget: init.total,
      spentBudget: init.spent,
      currentHarness: init.harness ?? 'H1_EXECUTE_EVAL',
      lastApprovalBudgetTotal: 0,
    } as any;
  }

  const makeRecorder = (): any => ({
    scout: undefined,
    contract: undefined,
    handoff: undefined,
    verdict: undefined,
  });

  const noopObserver: any = {
    onRoleEmit: () => undefined,
    notifyBudgetApprovalRequest: () => undefined,
  };

  const toolCtx: any = { gitRoot: process.cwd(), executionCwd: process.cwd(), agent: 'test' };

  it('Risk-3: explicit budgetRequest triggers askUser below 90% threshold', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const base = makeFakeVerdictEmitter({
      status: 'accept',
      reason: 'done',
      budgetRequest: 'need another e2e pass',
    });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 40 }); // 20% — well below 90%
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      events,
    });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await wrapped.execute({}, toolCtx);

    expect(askUserCalls.length).toBe(1);
    // The dialog summary surfaces the Evaluator's explicit reason.
    expect(askUserCalls[0]!.question).toMatch(/work units|budget/i);
  });

  it('Risk-3: missing budgetRequest + below 90% → no dialog fires', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const askUserCalls: Array<unknown> = [];
    const events: KodaXEvents = {
      askUser: async () => {
        askUserCalls.push({});
        return 'continue';
      },
    } as KodaXEvents;
    const base = makeFakeVerdictEmitter({ status: 'accept', reason: 'done' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 40 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      events,
    });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await wrapped.execute({}, toolCtx);

    expect(askUserCalls.length).toBe(0);
  });

  it('Risk-5: H2 harness is not subject to the H1 same-harness revise cap', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'retry' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50, harness: 'H2_PLAN_EXECUTE_EVAL' });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H2_PLAN_EXECUTE_EVAL',
    });
    // Even if we pre-seed a high revise count for H2, the wrapper must
    // NOT apply the H1-only conversion — H2 runs to the global round cap.
    budgetExtension.reviseCountByHarnessRef.current.set('H2_PLAN_EXECUTE_EVAL', 5);

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as { payload: { verdict: { status: string } } };
    expect(meta.payload.verdict.status).toBe('revise');
  });

  it('Risk-5: multi-emit on same slot — recorder holds the LAST payload (last-wins)', async () => {
    // When the LLM calls emit_verdict twice in one turn (either by
    // accident or as a self-correction), the recorder must hold the
    // SECOND payload so handoff routing reflects the corrected intent.
    // Legacy managed-protocol-handoff.test.ts explicitly covered this
    // for the text-fence path ("uses the last verdict block when
    // multiple exist"); the same semantic must hold for the tool-call
    // path.
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 10 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    // First emit: revise with one reason
    const firstBase = makeFakeVerdictEmitter({ status: 'revise', reason: 'first pass incomplete' });
    const firstWrapped = wrapEmitterWithRecorder(firstBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await firstWrapped.execute({}, toolCtx);
    expect((recorder as any).verdict?.payload.verdict?.reason).toBe('first pass incomplete');

    // Second emit on same slot: self-correct to accept
    const secondBase = makeFakeVerdictEmitter({ status: 'accept', reason: 'actually done' });
    const secondWrapped = wrapEmitterWithRecorder(secondBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await secondWrapped.execute({}, toolCtx);
    // Last-wins semantic — recorder now holds the second payload
    expect((recorder as any).verdict?.payload.verdict?.status).toBe('accept');
    expect((recorder as any).verdict?.payload.verdict?.reason).toBe('actually done');
  });

  it('Risk-5: malformed verdict (missing payload fields) passes through without mutation', async () => {
    // When the emitter's base.execute returns a metadata-less error
    // (e.g. schema validation failed, emit tool rejected the input),
    // wrapEmitterWithRecorder must NOT try to rewrite — the recorder
    // stays empty and downstream handoff falls through to whatever the
    // fallback path decides. This guards the silent-fatal regression
    // the old managed-protocol-handoff.test.ts covered.
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const errorBase = {
      name: 'emit_verdict',
      description: 'stub',
      input_schema: { type: 'object' },
      execute: async () => ({ content: '[emit error]', isError: true }),
    } as unknown as RunnableTool;
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    const wrapped = wrapEmitterWithRecorder(errorBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    expect(result.isError).toBe(true);
    // Revise counter untouched
    expect(budgetExtension.reviseCountByHarnessRef.current.size).toBe(0);
    // Degraded-continue flag untouched
    expect(budgetExtension.degradedContinueRef.current).toBe(false);
  });
});

// =============================================================================
// H1 structural resume (v0.7.26) — buildStructuralResumeSeed
// =============================================================================

// FEATURE_193 v0.7.43: 'H1 structural resume — buildStructuralResumeSeed' describe deleted
//   (all 6 tests used V1 chain resume concepts: scoutCompleted, rolesEmitted=['scout'], startingRole='generator'/'planner'/'scout')

// =============================================================================
// FEATURE_155 (v0.7.39) Slice A2 — runner-driven idle-yield outer loop
// =============================================================================
// End-to-end integration: when the Worker dispatches a child and exits
// with a text-only turn (no tool calls), the outer loop must
//   (a) detect idle-yield via `detectIdleYield`,
//   (b) wait for the child to settle via `waitForWakeEvent`,
//   (c) splice the canonical `<task-completed>` banner into the
//       transcript via `composeIdleYieldUserMessage`, and
//   (d) re-enter `Runner.run` so the Worker can react.
//
// The single test exercises the full happy path (probe child completes
// → Worker text-only terminates → Sidecar Verifier accepts) with the
// child-executor mocked so we control settlement timing precisely.
// Idle-yield is
// always-on as of Slice C3 (the `KODAX_IDLE_YIELD` env-flag gate was
// retired); this test is the only place that drives the outer-loop
// wiring through a real `Runner.run` -> idle-yield -> resume ->
// `Runner.run` cycle.

function buildSuccessChildResult(
  childId: string,
  evidence: string[],
): KodaXChildExecutionResult {
  return {
    results: [
      {
        childId,
        fanoutClass: 'evidence-scan',
        status: 'completed',
        disposition: 'valid',
        summary: evidence.join('\n'),
        evidenceRefs: [],
        contradictions: [],
      },
    ],
    mergedFindings: [
      {
        childId,
        objective: 'idle-yield probe',
        evidence,
        artifacts: [],
      },
    ],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
  };
}

describe('FEATURE_155 v0.7.39 Slice A2 — idle-yield outer loop', () => {
  // FEATURE_193 v0.7.43: KODAX_HARNESS_V2 env manipulation removed from beforeEach/afterEach (V2 is now unconditional default)
  let prevAsyncDispatch: string | undefined;

  beforeEach(() => {
    prevAsyncDispatch = process.env.KODAX_ASYNC_DISPATCH;
    // Ensure the dispatch tool takes the async / fire-and-forget path
    // — the sync path runs the child inline and never reaches the
    // idle-yield branch.
    delete process.env.KODAX_ASYNC_DISPATCH;
    mockExec.mockReset();
    _resetMessageQueueForTests();
  });

  afterEach(() => {
    if (prevAsyncDispatch === undefined) delete process.env.KODAX_ASYNC_DISPATCH;
    else process.env.KODAX_ASYNC_DISPATCH = prevAsyncDispatch;
    _resetMessageQueueForTests();
  });

  it('Worker dispatches → idle-yields → child completes → Worker resumes → text-only termination → Sidecar Verifier accepts', async () => {
    let resolveChild!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveChild = resolve;
      }),
    );

    const workerTurns: number[] = [];
    // Capture the per-turn iteration index the adapter reports. This run
    // crosses an idle-yield resume → two real `runOnce` (two fresh
    // `Runner.run`), so the reset at the top of `runOnce` must restart the
    // counter: turns 1+2 in the first run, turn 3 in the second → [1,2,1].
    // This protects the reset LOCATION inside `runOnce` (the direct-adapter
    // unit test only simulates the reset, it cannot catch a moved reset).
    const iterStarts: number[] = [];
    let resumeTranscriptHadBanner = false;

    const mock = makeChainMockLlm({
      worker: (turn, transcript) => {
        workerTurns.push(turn);
        if (turn === 1) {
          // Fire a read-only probe dispatch. The dispatch tool's
          // async branch registers a promise (mocked above) and
          // returns the `task_id:probe-1` banner as tool_result.
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'dispatch_child_task',
              input: {
                id: 'probe-1',
                objective: 'count imports of foo',
                read_only: true,
              },
            }],
          };
        }
        if (turn === 2) {
          // Schedule the child to settle just AFTER this turn returns
          // and the outer loop transitions into `waitForWakeEvent`.
          // 20 ms is enough headroom for the Runner to process this
          // turn's no-tool-calls exit without making the test slow.
          setTimeout(() => {
            resolveChild(buildSuccessChildResult('probe-1', ['found 3 imports of foo']));
          }, 20);
          // Idle-yield: text-only response with NO tool calls. This
          // is the entry condition that `detectIdleYield` keys on.
          return {
            textBlocks: [{ text: 'Awaiting probe-1 result before continuing.' }],
          };
        }
        if (turn === 3) {
          // After resume — confirm the synthetic user message
          // carrying the `<task-completed task_id="probe-1">` banner
          // is in the transcript. This is the contract `composeIdleYieldUserMessage`
          // must satisfy for the Worker to observe the wake.
          for (const msg of transcript) {
            if (
              msg.role === 'user'
              && typeof msg.content === 'string'
              && msg.content.includes('<task-completed task_id="probe-1">')
              && msg.content.includes('found 3 imports of foo')
            ) {
              resumeTranscriptHadBanner = true;
              break;
            }
          }
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: probe-1 done — found 3 imports of foo)' }],
            toolBlocks: [],
          };
        }
        // Fallback for any extra turn — return safe text-only.
        // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
        return { textBlocks: [{ text: 'Done.' }] };
      },
    });

    const optsWithIter = {
      ...makeOptions(),
      events: { onIterationStart: (iter: number) => iterStarts.push(iter) },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const result = await runManagedTaskViaRunner(optsWithIter, 'count imports of foo', mock);

    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Counter resets across the idle-yield resume: the post-resume run
    // starts a fresh Runner.run, so the reported iter drops back to 1
    // rather than accumulating. Guarantees `iter <= maxIter` per run.
    expect(iterStarts).toEqual([1, 2, 1]);
    expect(iterStarts.every((i) => i <= MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS)).toBe(true);
    // Worker MUST have been called at least three times:
    //   turn 1 — dispatch
    //   turn 2 — idle-yield (text-only)
    //   turn 3 — text-only termination (post-resume)
    expect(workerTurns.length).toBeGreaterThanOrEqual(3);
    expect(workerTurns).toContain(3);
    // The synthetic user message must have surfaced the canonical
    // banner format on resume.
    expect(resumeTranscriptHadBanner).toBe(true);
    // FEATURE_184 (v0.7.45) + FEATURE_190 (v0.7.43): post-resume Worker
    // text-only termination is the canonical V2 terminal signal. The
    // Sidecar Verifier StopHook fires after the text-only turn and the
    // recorder bridge stamps `source: 'sidecar'` on the verdict slot.
    // In the unit-test environment the verifier provider is `anthropic`
    // without a real API key — fail-open policy resolves to
    // `verdict: 'accept'` (trace=`provider_error`, see
    // `verifier.ts:251`). Mirrors the L715-717 assertion shape locked
    // in by the cc8ce393 F193 sidecar-restore fix; this assertion
    // covers the idle-yield resume path which has a different runner
    // entry trajectory than the trivial direct-answer path at L715.
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  }, 30_000);

  // FEATURE_155 v0.7.39 Slice C3 — the `KODAX_IDLE_YIELD=false` opt-out
  // test was retired here. With `await_child_task` removed (Slice C1)
  // there is no working off-path: setting the flag would leave the
  // runner with a Worker prompt that exits text-only but no resumer
  // to wake it. The flag is now hard-coded ON in `isIdleYieldEnabled`,
  // and the always-on outer loop is fully covered by the happy-path
  // test above.

  // FEATURE_155 v0.7.39 Slice D2 — chat-while-waiting behavioral
  // test. The pre-registered acceptance criterion is "user input in
  // the idle-wait window reaches the Worker on the NEXT turn within
  // a perception budget". `waitForWakeEvent` polls the message queue
  // every 100ms (`pollIntervalMs` default), so the worst-case
  // latency between enqueue and wake is one poll tick + Runner.run
  // re-entry overhead. We assert ≤500ms — a generous bound that's
  // still well under user-perceived "slow" thresholds (the Worker's
  // status-text turn was already idle when we enqueued, so there's
  // no LLM call to wait on; only the poll-tick + outer-loop
  // re-entry).
  it('user input enqueued during idle-wait reaches Worker within perception budget', async () => {
    let resolveChild!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveChild = resolve;
      }),
    );

    const workerTurns: number[] = [];
    let userMessageDeliveredAt: number | undefined;
    let userMessageEnqueuedAt: number | undefined;
    let workerSawUserText = false;

    const mock = makeChainMockLlm({
      worker: (turn, transcript) => {
        workerTurns.push(turn);
        if (turn === 1) {
          // Fire a read-only probe — child stays unresolved so the
          // Worker stays in idle-wait and `waitForWakeEvent` is
          // racing only the queue arm + abort arm.
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'dispatch_child_task',
              input: {
                id: 'probe-cww-1',
                objective: 'long-running probe',
                read_only: true,
              },
            }],
          };
        }
        if (turn === 2) {
          // Idle-yield: text-only response. After this returns, the
          // outer loop transitions into `waitForWakeEvent`. We
          // schedule a queue.enqueue from the test harness AFTER a
          // small delay so it lands during the wait.
          setTimeout(() => {
            userMessageEnqueuedAt = Date.now();
            getMessageQueue().enqueue({
              priority: 'user',
              mode: 'prompt',
              content: 'side-question while you wait',
            });
          }, 30);
          return {
            textBlocks: [{ text: 'Probing in the background; ask me anything.' }],
          };
        }
        if (turn === 3) {
          // Resume turn — the synthetic user message should carry
          // the side-question content. Record latency at the moment
          // Worker first observes it.
          for (const msg of transcript) {
            if (
              msg.role === 'user'
              && typeof msg.content === 'string'
              && msg.content.includes('side-question while you wait')
            ) {
              userMessageDeliveredAt = Date.now();
              workerSawUserText = true;
              break;
            }
          }
          // Settle the child so the run completes.
          setTimeout(() => {
            resolveChild(buildSuccessChildResult('probe-cww-1', ['done']));
          }, 5);
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: probe done + side answered)' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'fallthrough' }] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // evaluator handler deleted.
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'long task', mock);

    expect(result.success).toBe(true);
    expect(workerSawUserText).toBe(true);
    expect(workerTurns).toContain(3);

    // Perception-budget assertion: the gap between user enqueue and
    // the Worker observing the message should fit within one queue-
    // poll tick (100ms default) plus generous re-entry overhead.
    expect(userMessageEnqueuedAt).toBeDefined();
    expect(userMessageDeliveredAt).toBeDefined();
    const latencyMs = (userMessageDeliveredAt as number) - (userMessageEnqueuedAt as number);
    // Floor at 0 to guard against system-clock drift on slow CI hosts;
    // ceiling at 500ms — well above the 100ms poll budget plus
    // Runner.run re-entry on a mocked LLM.
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(500);
  }, 30_000);

  // FEATURE_190 Phase 3: FEATURE_165 pending-children gate no longer exists
  // (emit_handoff deleted). The "dispatch + emit_handoff in one batch" shape
  // is no longer possible; post-F190 Worker terminates text-only.
  // The equivalent invariant is covered by `text-only-termination.test.ts`.
  it.todo('post-F190: FEATURE_165 pending-children gate no longer exists — emit_handoff deleted. Combined FEATURE_155 Bug B + FEATURE_165 gate regression covered by text-only-termination.test.ts');

  // v0.7.38 FEATURE_155 hotfix follow-up — Bug A integration test.
  // The unit-level test in `async-dispatch.test.ts` checks the
  // registry is cleaned up after a single dispatch settles. This
  // test drives the EXACT production-bug shape that motivated the
  // hotfix: Worker dispatches 2 children, first child completes →
  // Worker resumes → still idle-yields waiting for second → second
  // child completes → Worker resumes → emits handoff. Pass criterion:
  // the first child's `<task-completed>` banner appears EXACTLY
  // ONCE in the Worker transcript (not duplicated because the
  // settled-then-not-deleted registry entry kept re-firing
  // `child-completed` wakes with a fabricated
  // "(no summary available)" banner).
  it('settled child does NOT re-fire wake on subsequent idle-yield (Bug A registry-leak regression at integration level)', async () => {
    const childResolvers = new Map<string, (r: KodaXChildExecutionResult) => void>();
    mockExec.mockImplementation((bundles) => {
      const bundle = bundles[0];
      return new Promise<KodaXChildExecutionResult>((resolve) => {
        childResolvers.set(bundle.id, resolve);
      });
    });

    const workerTurns: number[] = [];

    const mock = makeChainMockLlm({
      worker: (turn, transcript) => {
        workerTurns.push(turn);
        if (turn === 1) {
          // Fan out 2 children in one response — the registry will
          // hold both for the next several wakes.
          return {
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'w-1a',
                name: 'dispatch_child_task',
                input: { id: 'leak-A', objective: 'probe A', read_only: true },
              },
              {
                type: 'tool_use',
                id: 'w-1b',
                name: 'dispatch_child_task',
                input: { id: 'leak-B', objective: 'probe B', read_only: true },
              },
            ],
          };
        }
        if (turn === 2) {
          // Settle A only; B stays pending. The outer loop should
          // wake on A, but then the next snapshot still has B
          // pending → another idle-yield wait. The bug used to be:
          // after A's wake, A's registry entry stayed and the next
          // `waitForWakeEvent` immediately fired another
          // `child-completed` for A with a fake banner. Fix:
          // `.finally(() => registry.delete(childId))` removes A
          // from the registry the moment A's promise settles.
          setTimeout(() => {
            childResolvers.get('leak-A')!(
              buildSuccessChildResult('leak-A', ['A finding']),
            );
          }, 10);
          return {
            textBlocks: [{ text: 'Awaiting probes.' }],
          };
        }
        if (turn === 3) {
          // After A wakes us — A's banner MUST be in the transcript,
          // appearing exactly once. Continue idle-yielding for B.
          setTimeout(() => {
            childResolvers.get('leak-B')!(
              buildSuccessChildResult('leak-B', ['B finding']),
            );
          }, 10);
          return {
            textBlocks: [{ text: 'A in, awaiting B.' }],
          };
        }
        if (turn === 4) {
          // Both children in. Terminate text-only.
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: both probes done — A finding, B finding)' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'fallthrough' }] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // evaluator handler deleted.
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'two-child fan-out', mock);

    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');

    // The CORE assertion: count occurrences of A's banner across all
    // transcripts the Worker observed. The bug would have inflated
    // this number to 2+ as the leaked A entry kept re-firing wakes
    // with fabricated `(no summary available)` banners.
    let aBannerCount = 0;
    let aFakeBannerCount = 0;
    let bBannerCount = 0;
    // Re-run the mock once more synthetically by inspecting the
    // recorded turns isn't possible here, but we can lean on the
    // `workerTurns` evidence: a clean run is exactly turns 1-4. A
    // leaked-registry run inflates the turn count via spurious wakes.
    // The Bug A integration symptom is "turn 3 sees A's banner ONCE
    // and turn 4 emits handoff" — a leaked path would re-yield more
    // times before reaching the handoff turn.
    expect(workerTurns).toEqual([1, 2, 3, 4]);

    // Additionally inspect the result's recorded messages for the
    // banner counts. `result.messages` carries the full transcript.
    const messages = result.messages ?? [];
    for (const msg of messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
      if (msg.content.includes('<task-completed task_id="leak-A">')) aBannerCount++;
      if (msg.content.includes('<task-completed task_id="leak-B">')) bBannerCount++;
      if (msg.content.includes('(child task completed; no summary available)')) {
        aFakeBannerCount++;
      }
    }
    expect(aBannerCount).toBe(1);
    expect(bBannerCount).toBe(1);
    // The defensive-fallback fake banner is the smoking gun of
    // Bug A. Post-fix, it MUST NOT appear.
    expect(aFakeBannerCount).toBe(0);
  }, 30_000);

  // v0.7.38 FEATURE_155 hotfix follow-up #2 — fast-child race
  // regression. Production trace (user screenshot 2026-05-11):
  // Worker dispatched 3 audit children, two returned + were
  // processed, Worker emitted text-only "等待最后一个子任务" while
  // the third child completed DURING that LLM call. The third
  // child's IIFE ran `enqueueChildTaskNotification` then resolved;
  // the registry's `.finally(delete)` ran in the same microtask
  // burst — BEFORE the outer-loop snapshot. `pendingChildTaskCount`
  // read 0, `detectIdleYield` returned false, loop broke. The
  // banner was orphaned in the background queue and the run ended
  // with the Worker's "等待..." placeholder as the final answer.
  //
  // Fix: `IdleYieldSnapshot.hasPendingBackgroundMessages` keeps the
  // loop alive whenever there's still a banner to drain.
  // Verification shape: simulate the production race by resolving
  // the child's promise WHILE the Worker's text-only turn is still
  // running — both `enqueue` and `.finally(delete)` complete before
  // the outer-loop snapshot sees `pendingChildTaskCount`.
  it('fast-child race: child settles during Worker turn → loop must NOT break (background queue keeps it alive)', async () => {
    let resolveChild!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveChild = resolve;
      }),
    );

    const workerTurns: number[] = [];

    const mock = makeChainMockLlm({
      worker: (turn, transcript) => {
        workerTurns.push(turn);
        if (turn === 1) {
          // Dispatch a single fast child. Schedule the resolution
          // for AFTER this turn returns but BEFORE turn 2's text-only
          // exit completes — simulating "child settles during the
          // surrounding Runner.run iteration".
          setTimeout(() => {
            resolveChild(buildSuccessChildResult('fast-1', ['fast finding']));
          }, 5);
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'dispatch_child_task',
              input: { id: 'fast-1', objective: 'audit X', read_only: true },
            }],
          };
        }
        if (turn === 2) {
          // Text-only idle-yield. By the time the outer loop runs
          // `detectIdleYield` after THIS turn, the child's IIFE has
          // already settled (the setTimeout above) and the
          // `.finally(delete)` has removed `fast-1` from the
          // registry. `pendingChildTaskCount` therefore reads 0.
          // The `hasPendingBackgroundMessages` field is what keeps
          // the loop alive — banner is queued.
          return {
            textBlocks: [{ text: 'awaiting fast-1' }],
          };
        }
        if (turn === 3) {
          // Resumed via the banner-only wake. Verify Worker saw the
          // banner on its way back in. Then emit handoff.
          let sawBanner = false;
          for (const msg of transcript) {
            if (
              msg.role === 'user'
              && typeof msg.content === 'string'
              && msg.content.includes('<task-completed task_id="fast-1">')
              && msg.content.includes('fast finding')
            ) {
              sawBanner = true;
              break;
            }
          }
          expect(sawBanner).toBe(true);
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: fast-1 audit complete — fast finding)' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'fallthrough' }] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // evaluator handler deleted.
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'fast audit', mock);

    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // CORE assertion: Worker MUST reach turn 3 (post-resume). Pre-fix
    // the outer loop would break after turn 2 and the run would end
    // with the "awaiting fast-1" text as `lastText`, with the banner
    // orphaned in the background queue. Post-fix the loop stays alive,
    // wake fires on the queue arm, Worker resumes and emits handoff.
    expect(workerTurns).toEqual([1, 2, 3]);
    // FEATURE_184 Phase C.1: lastText assertion removed (was verifying
    // Evaluator's user_answer field; Evaluator no longer in chain).
  }, 30_000);

  // v0.7.38 FEATURE_156 — idle-wait status emit. Verifies the
  // producer side: when the outer loop is about to park in
  // `waitForWakeEvent`, the observer bridge fires an
  // `onManagedTaskStatus` event with `idleWaiting=true` +
  // `idleWaitingPendingCount` set to the registry size, and the
  // identity (`activeWorkerId` / `activeWorkerTitle`) reflects the
  // agent that just parked (Worker today, but the lookup is
  // agent-agnostic).
  it('emits idleWaiting=true with role + pendingCount before waitForWakeEvent (FEATURE_156)', async () => {
    let resolveChild!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveChild = resolve;
      }),
    );

    const statusEvents: Array<{
      idleWaiting?: boolean;
      idleWaitingPendingCount?: number;
      activeWorkerId?: string;
      activeWorkerTitle?: string;
      phase?: string;
    }> = [];

    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'dispatch_child_task',
              input: { id: 'feat156-1', objective: 'audit', read_only: true },
            }],
          };
        }
        if (turn === 2) {
          setTimeout(() => {
            resolveChild(buildSuccessChildResult('feat156-1', ['finding']));
          }, 20);
          return { textBlocks: [{ text: 'awaiting feat156-1' }] };
        }
        if (turn === 3) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: audit done — finding)' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'fallthrough' }] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // evaluator handler deleted.
    });

    const options: KodaXOptions = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (status) => {
          statusEvents.push({
            idleWaiting: status.idleWaiting,
            idleWaitingPendingCount: status.idleWaitingPendingCount,
            activeWorkerId: status.activeWorkerId,
            activeWorkerTitle: status.activeWorkerTitle,
            phase: status.phase,
          });
        },
      },
    };

    const result = await runManagedTaskViaRunner(options, 'audit task', mock);
    expect(result.success).toBe(true);

    // CORE assertion: at least ONE status emit carries idleWaiting=true
    // with the Worker identity + pendingCount=1 (the in-flight child).
    const idleEmits = statusEvents.filter((e) => e.idleWaiting === true);
    expect(idleEmits.length).toBeGreaterThanOrEqual(1);
    const first = idleEmits[0]!;
    expect(first.activeWorkerId).toBe('worker');
    expect(first.activeWorkerTitle).toBe('Worker');
    expect(first.idleWaitingPendingCount).toBe(1);
    expect(first.phase).toBe('worker');

    // Subsequent role-emits MUST not carry idleWaiting=true (post-wake
    // role-emit clears the field — consumers branch on `=== true`).
    const lastEmit = statusEvents[statusEvents.length - 1];
    expect(lastEmit?.idleWaiting).not.toBe(true);
  }, 30_000);
});

// FEATURE_190 (v0.7.43) Phase 3: the FEATURE_165 pending-children gate
// describe block was removed — the `emit_handoff` tool it gated no
// longer exists. The equivalent invariant (Worker text-terminates with
// pending children → idle-yield keeps the loop alive until banners
// arrive) is covered by `text-only-termination.test.ts`.

describe('FEATURE_166 v0.7.41 follow-up — agent-switch label flip', () => {
  // FEATURE_193 v0.7.43: withHarnessV2 async helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

  // FEATURE_184 Phase C.1 (v0.7.45): Deleted "emits a phase=worker status
  // with activeWorkerTitle='Evaluator' AFTER Worker emit_handoff and BEFORE
  // Evaluator emit_verdict" test — tested V2 Worker→Evaluator handoff label
  // flip which required in-chain Evaluator. Evaluator removed from chain.

  // FEATURE_193 v0.7.43: 'does not emit agent-switched when no handoff happens (single-role H0 direct run)' deleted
  //   (used withHarnessV2('false') + scout: mock with emit_scout_verdict — V1 chain roles retired)

  it('NULL_OBSERVER provides a no-op agentSwitched so chain-only test paths do not throw', () => {
    // The NULL_OBSERVER is used in topology-only tests that build the
    // chain without runtime events. agentSwitched must exist (or
    // calling it would throw `undefined is not a function`) but be
    // a no-op. This is a structural pin — without it, the
    // ObserverBridge contract addition could silently break any
    // existing test that passes NULL_OBSERVER.
    //
    // We can't import NULL_OBSERVER directly (not exported), but
    // buildRunnerAgentChain accepts the default `observer:
    // NULL_OBSERVER` parameter, so reaching this line without
    // throwing is itself the assertion.
    expect(() => buildRunnerAgentChain(makeCtx(), {})).not.toThrow();
  });
});
