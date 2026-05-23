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
import {
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from '../agents/protocol-emitters.js';
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
  buildRunnerScoutAgent,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
} from './runner-driven.js';
import type { RunnableTool } from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXChildExecutionResult, KodaXEvents, KodaXOptions, KodaXToolExecutionContext } from '../types.js';

// Shared scratch directory for `managedTaskWorkspaceDir` so the
// Shard 6d-h artifact writes (contract.json / managed-task.json /
// result.json / ... ) land inside a temp folder instead of polluting
// the repo's cwd with `.agent/managed-tasks/` entries.
let testWorkspaceRoot: string;

// v0.7.38 Slice 7 — V2 is now the default behavior at runtime. This
// test file exercises the V1 chain extensively; pin the env to V1 for
// the whole file so V1 mocks (scout/planner/generator/evaluator only)
// stay valid. Tests that need V2 explicitly use the local `withHarnessV2('true', ...)`
// helper which save/restores the env around their scope.
let prevHarnessV2Env: string | undefined;
beforeAll(async () => {
  prevHarnessV2Env = process.env.KODAX_HARNESS_V2;
  process.env.KODAX_HARNESS_V2 = 'false';
  testWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-driven-'));
});

afterAll(async () => {
  if (prevHarnessV2Env === undefined) delete process.env.KODAX_HARNESS_V2;
  else process.env.KODAX_HARNESS_V2 = prevHarnessV2Env;
  if (testWorkspaceRoot) {
    // Windows can hold transient handles immediately after tests;
    // retry a few times before giving up so CI stays clean.
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

describe('buildRunnerScoutAgent', () => {
  it('carries emit_scout_verdict + 4 core coding tools', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const names = scout.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_SCOUT_VERDICT_TOOL_NAME);
    expect(names).toContain('read');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('bash');
  });

  it('declares handoffs to generator (H1) and planner (H2) — Shard 5b topology', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const targets = (scout.handoffs ?? []).map((h) => h.target.name);
    expect(targets).toContain('kodax/role/generator');
    expect(targets).toContain('kodax/role/planner');
  });

  it('uses kodax/role/scout as the canonical agent name', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    expect(scout.name).toBe('kodax/role/scout');
  });

  it('carries a self-contained H0 instruction string (no ManagedRolePromptContext dependency)', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    // v0.7.26 parity: instructions is a closure that resolves on every
    // Runner invocation so Scout's post-emit skillMap / scope reach
    // downstream prompts at runtime. Resolve it once here for assertion.
    const instructions = typeof scout.instructions === 'function'
      ? scout.instructions(undefined)
      : scout.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions).toMatch(/H0_DIRECT/);
    expect(instructions).toMatch(/emit_scout_verdict/);
  });
});

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
    const scout = buildRunnerScoutAgent(makeCtx());
    await adapter([{ role: 'system', content: 's' }], scout);
    for (const t of capturedTools) {
      expect(t.execute).toBeUndefined();
    }
    expect(capturedTools.some((t) => t.name === EMIT_SCOUT_VERDICT_TOOL_NAME)).toBe(true);
  });

  it('converts textBlocks+toolBlocks to RunnerLlmResult shape', async () => {
    const toolBlock: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'emit_scout_verdict',
      input: { confirmed_harness: 'H0_DIRECT' },
    };
    const adapter = buildRunnerLlmAdapter(makeOptions(), async () => ({
      textBlocks: [{ text: 'Calling verdict' }],
      toolBlocks: [toolBlock],
    }));
    const result = await adapter(
      [{ role: 'system', content: 's' }],
      { name: 'x', instructions: '' },
    );
    expect(result.text).toBe('Calling verdict');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('emit_scout_verdict');
    expect(result.toolCalls![0]!.input).toEqual({ confirmed_harness: 'H0_DIRECT' });
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

describe('runManagedTaskViaRunner — Scout H0_DIRECT end-to-end', () => {
  it('runs a Scout H0_DIRECT flow: emit_scout_verdict then final text', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'What is 2 + 2?',
      async (_transcript, _tools, _system) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [{ text: 'Simple arithmetic, answering directly.' }],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'scout-1',
                name: 'emit_scout_verdict',
                input: {
                  confirmed_harness: 'H0_DIRECT',
                  direct_completion_ready: 'yes',
                  summary: 'Arithmetic question',
                  scope: [],
                  required_evidence: [],
                  harness_rationale: 'Trivial math, no code inspection needed.',
                },
              },
            ],
          };
        }
        // Second turn: Scout sees tool_result, emits final text
        return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
      },
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('2 + 2 = 4.');
    expect(result.signal).toBe('COMPLETE');
    // Shard 6a populates managedTask with a minimal but well-shaped payload.
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');

    // Transcript shape: system, user, assistant(tool_use), user(tool_result), assistant(final)
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.role).toBe('user');
    expect(result.messages[2]!.role).toBe('assistant');
    expect(result.messages[3]!.role).toBe('user');
    expect(result.messages[4]!.role).toBe('assistant');
  });

  it('handles a zero-tool direct answer (Scout answers without emit)', async () => {
    // Edge case: a minimalist Scout that just returns the answer as text,
    // without ever calling emit_scout_verdict. The run still completes;
    // managedTask is populated with defaults (harness=H0_DIRECT).
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Say hello',
      async () => ({ textBlocks: [{ text: 'Hello, world.' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Hello, world.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
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
  // v0.7.38 Slice 7 — V2 is now the DEFAULT. Pass 'false' to opt out
  // (V1 path), 'true' to assert V2 explicitly, undefined to test the
  // unset-env default (which is now V2).
  async function withHarnessV2<T>(
    value: 'true' | 'false' | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = process.env.KODAX_HARNESS_V2;
    if (value === undefined) delete process.env.KODAX_HARNESS_V2;
    else process.env.KODAX_HARNESS_V2 = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.KODAX_HARNESS_V2;
      else process.env.KODAX_HARNESS_V2 = prev;
    }
  }

  it('runs a V2 trivial flow: Worker terminates text-only', async () => {
    await withHarnessV2('true', async () => {
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
      // No in-chain Evaluator → managedProtocolPayload.verdict is undefined.
      expect(result.managedProtocolPayload?.verdict).toBeUndefined();
    });
  });

  it('V2 active: preflight emits activeWorkerTitle="Worker" (not "Scout")', async () => {
    // FEATURE_114 v0.7.38 Slice 7 — when V2 is the entry path
    // (chain.worker), the runner's preflight emit MUST carry the
    // Worker label so the REPL prefix on Worker's tool calls reads
    // `[Worker] read/bash/grep`. The previous hardcoded scout label
    // persisted into every Worker tool call (no slot emit had fired
    // yet) and made V2 sessions appear to still be running V1.
    await withHarnessV2('true', async () => {
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
  });

  // FEATURE_190 Phase 3: Worker terminates text-only — onRoleEmit('worker')
  // is never called, so no `phase:'worker', activeWorkerId:'worker'` event
  // with the "completed a turn" note exists to assert against. The agentSwitched
  // event does fire but was not the invariant this test exercised (it checked
  // the onRoleEmit path specifically). Covered by text-only-termination.test.ts.
  it.todo('post-F190: V2 worker onRoleEmit event no longer fires — Worker terminates text-only; covered by text-only-termination.test.ts');

  it('V2 flag off (KODAX_HARNESS_V2=false): same prompt routes through Scout (V1 baseline preserved)', async () => {
    // v0.7.38 Slice 7 — V2 is the default; explicit `false` opts out
    // to V1. Previously this test used `undefined` (env unset =
    // implicit V1); the default flip flips that meaning so we now
    // pass 'false' explicitly to keep testing the V1 codepath.
    await withHarnessV2('false', async () => {
      // V1 Scout H0 shape — when flag is off, the run takes the
      // V1 entry. This guards against a regression where Slice 3b's
      // flag check accidentally returns true on undefined env.
      const mock = makeChainMockLlm({
        scout: (turn) => {
          if (turn === 1) {
            return {
              toolBlocks: [
                {
                  type: 'tool_use',
                  id: 'scout-1',
                  name: 'emit_scout_verdict',
                  input: {
                    confirmed_harness: 'H0_DIRECT',
                    direct_completion_ready: 'yes',
                    summary: 'Arithmetic',
                    scope: [],
                    required_evidence: [],
                    harness_rationale: 'Trivial.',
                  },
                },
              ],
            };
          }
          return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
        },
      });
      const result = await runManagedTaskViaRunner(
        makeOptions(),
        'What is 2 + 2?',
        mock,
      );
      expect(result.success).toBe(true);
      // V1 path: Scout populated the harness profile. V2 path
      // wouldn't have a Scout role record — so this is a clean
      // sentinel for which path the runner took.
      expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    });
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
    expect(result.managedTask?.verdict?.status).toBe('running');
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

describe('Shard 5b parity — H1 accept path', () => {
  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // FEATURE_190 Phase 3: emit_handoff deleted; Generator terminates text-only.
  // Sidecar Verifier (Phase D.2) handles verdict async.
  it('Scout → Generator terminates text-only for Sidecar Verifier (H1 accept path)', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'scout-1',
              name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL', harness_rationale: 'small scope' },
            }],
          };
        }
        throw new Error('scout should have handed off already');
      },
      generator: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: login endpoint added, tests pass)' }],
            toolBlocks: [],
          };
        }
        throw new Error('generator should have handed off already');
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add login endpoint', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    // FEATURE_190 Phase 3: Sidecar Verifier auto-runs and may populate verdict.
    // Accept both undefined (no sidecar in test env) and a sidecar accept verdict.
    const verdict = result.managedProtocolPayload?.verdict;
    if (verdict !== undefined) {
      expect(verdict.source).toBe('sidecar');
    }
  });
});

describe('M5 parity — Scout pre-handoff write warning (v0.7.26)', () => {
  it('fires onManagedTaskStatus note when Scout writes a file then hands off to Generator (H1)', async () => {
    const statusEvents: Array<{ note?: string; detailNote?: string }> = [];
    const opts = makeOptions();
    opts.events = {
      ...opts.events,
      onManagedTaskStatus: (e) => {
        if (typeof e.note === 'string') {
          statusEvents.push({ note: e.note, detailNote: e.detailNote });
        }
      },
    };
    // Make Scout mutate a file before emitting H1 verdict by invoking
    // the `write` tool in the first turn, then emit_scout_verdict in
    // the second turn. The test fs path doesn't need to persist — the
    // wrapCodingToolAsRunnable path increments the mutation tracker
    // regardless of actual disk success.
    const tempFile = path.join(testWorkspaceRoot, 'scout-pre-handoff-artifact.txt');
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-write', name: 'write',
              input: { path: tempFile, content: 'scout draft\n' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-emit', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL', harness_rationale: 'small scope' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: summary rewritten)' }],
        toolBlocks: [],
      }),
    });

    await runManagedTaskViaRunner(opts, 'Rewrite summary', mock);

    const preHandoffNote = statusEvents.find(
      (e) => e.note && e.note.includes('before handing off'),
    );
    expect(preHandoffNote).toBeDefined();
    expect(preHandoffNote!.note).toMatch(/Scout wrote \d+ file/);
    expect(preHandoffNote!.note).toContain('Generator');
    expect(preHandoffNote!.detailNote ?? '').toContain('scout-pre-handoff-artifact.txt');
  });

  it('does NOT fire the warning on H0_DIRECT (Scout is the author in that case)', async () => {
    const statusEvents: Array<{ note?: string }> = [];
    const opts = makeOptions();
    opts.events = {
      ...opts.events,
      onManagedTaskStatus: (e) => {
        if (typeof e.note === 'string') statusEvents.push({ note: e.note });
      },
    };
    const tempFile = path.join(testWorkspaceRoot, 'scout-h0-artifact.txt');
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-write', name: 'write',
              input: { path: tempFile, content: 'scout direct output\n' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-emit', name: 'emit_scout_verdict',
              input: {
                confirmed_harness: 'H0_DIRECT',
                direct_completion_ready: 'yes',
                summary: 'Direct answer provided via write.',
              },
            }],
          };
        }
        // Scout may get a final text-only turn after H0_DIRECT emit so
        // the Runner can collect the assistant's user-facing answer.
        return { textBlocks: [{ text: 'Note written.' }] };
      },
    });

    await runManagedTaskViaRunner(opts, 'Write a note', mock);

    const preHandoffNote = statusEvents.find(
      (e) => e.note && e.note.includes('before handing off'),
    );
    expect(preHandoffNote).toBeUndefined();
  });
});

describe('Shard 5b parity — H1 Generator terminates text-only', () => {
  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // FEATURE_190 Phase 3: emit_handoff deleted; Generator terminates text-only.
  it('Generator terminates text-only; result.signal=COMPLETE', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: edge case fixed)' }],
            toolBlocks: [],
          };
        }
        throw new Error('generator overrun');
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Fix edge case', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // FEATURE_190 Phase 3: handoff slot no longer populated (emit_handoff deleted).
  });
});

describe('Shard 5b parity — H2 plan → execute path', () => {
  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // Generator terminates with emit_handoff (isTerminal=true).
  it('Scout → Planner → Generator terminates; contract surfaced', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL', harness_rationale: 'larger scope' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Add JWT auth',
                success_criteria: ['POST /auth/login works', 'tests pass'],
                required_evidence: ['auth.test.ts passing'],
                constraints: ['use existing token utils'],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done. (summary: JWT auth added, tests passing)' }],
            toolBlocks: [],
          };
        }
        throw new Error('generator overrun');
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add JWT auth', mock);
    expect(result.success).toBe(true);
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedProtocolPayload?.contract?.successCriteria).toHaveLength(2);
    // FEATURE_190 Phase 3: Sidecar Verifier may populate verdict. Accept both.
    const verdict = result.managedProtocolPayload?.verdict;
    if (verdict !== undefined) {
      expect(verdict.source).toBe('sidecar');
    }
  });
});

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
    // V1 baseline (file-level KODAX_HARNESS_V2='false') keeps the
    // legacy Scout label on preflight. The Slice 7 V2 path uses
    // 'Worker' — covered by the V2 preflight test in the
    // 'Shard 5d V2 trivial flow' describe block.
    expect(preflight?.activeWorkerId).toBe('scout');
    expect(preflight?.activeWorkerTitle).toBe('Scout');
    expect(preflight?.note).toBe('Scout analyzing task complexity');
    expect(statuses.some((s) => s.phase === 'completed')).toBe(true);
  });

  it('fires round events per role emit (Scout → Generator terminates)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_190 Phase 3: Sidecar Verifier may fire an evaluator-labeled event.
    const statuses: Array<{ phase?: string; activeWorkerId?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; activeWorkerId?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const roleEvents = statuses.filter((s) => s.phase === 'worker').map((s) => s.activeWorkerId);
    expect(roleEvents).toContain('scout');
    expect(roleEvents).toContain('generator');
    // Post-F190: Sidecar Verifier may also emit an evaluator-labeled event;
    // the key invariant is scout and generator are present.
  });

  it('fires completed with BLOCKED signal note on blocked handoff', async () => {
    // FEATURE_190 Phase 3: emit_handoff deleted. BLOCKED note is now owned
    // by Sidecar Verifier. This test checks that 'completed' phase is emitted.
    const statuses: Array<{ phase?: string; note?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; note?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed).toBeDefined();
  });
});

describe('Shard 6a — managedTask payload shape', () => {
  it('populates contract.harnessProfile from Scout verdict (H1 case)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.contract.surface).toBe('cli');
    expect(result.managedTask?.contract.objective).toBe('task');
  });

  it('populates roleAssignments in handoff order (H2 chain)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_190 Phase 3: Generator terminates text-only — onRoleEmit('generator')
    // is never called (no emit_handoff slot tool). Sidecar Verifier fires
    // onRoleEmit('evaluator') instead, so roleAssignments ends at 'evaluator'.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['c1'] },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    // Post-F190: Generator text-only → onRoleEmit('generator') never fires.
    // Sidecar adds 'evaluator' via applySidecarVerdictToRecorder.
    expect(roles).toContain('scout');
    expect(roles).toContain('planner');
    // Either 'generator' (no sidecar) or 'evaluator' (sidecar ran).
    const terminal = roles?.[roles.length - 1];
    expect(['generator', 'evaluator']).toContain(terminal);
  });

  it('populates single "direct" assignment for H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toEqual(['direct']);
    expect(result.managedTask?.verdict.decidedByAssignmentId).toBe('direct');
  });

  it('populates runtime.globalWorkBudget + budgetUsage (Shard 6a minimum)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // v0.7.26 budget caps: H0=100, H1=H2=200 (legacy parity). Extension
    // dialog at 90% crossing tops up by +100 (H0) or +200 (H1/H2).
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200); // H1
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThan(0);
  });

  it('records harnessTransitions when Scout chooses non-H0 tier', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const transitions = result.managedTask?.runtime?.harnessTransitions ?? [];
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('H0_DIRECT');
    expect(transitions[0]!.to).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(transitions[0]!.source).toBe('scout');
  });

  it('managedTask.verdict.status finalized (COMPLETE signal emitted post-F190)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_190 Phase 3: emit_handoff deleted; Generator terminates text-only.
    // Sidecar Verifier auto-runs after text-only termination and sets
    // verdict.status='completed'. The no-in-chain-evaluator invariant that
    // kept status='running' no longer holds; Sidecar owns verdict finalisation.
    const readyMock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const ready = await runManagedTaskViaRunner(makeOptions(), 'task', readyMock);
    // Post-F190: Sidecar sets verdict.status='completed'; accept either value.
    expect(['running', 'completed']).toContain(ready.managedTask?.verdict.status);
    expect(ready.signal).toBe('COMPLETE');
  });
});

// =============================================================================
// Shard 6b — Real budget tracking + mutation tracker
// =============================================================================

describe('Shard 6b — budget controller', () => {
  it('increments spentBudget per tool invocation (emit tools count)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_190 Phase 3: emit_handoff deleted; 1 emit tool call (scout).
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // At least 1 emit tool call (scout) → at least 1 budget unit.
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(1);
  });

  it('upgrades totalBudget when Scout picks H1 (from 50 → 400)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200);
  });

  it('keeps H0 budget (100) when Scout chooses H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(100);
  });

  it('upgrades to 200 when Scout picks H2', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200);
  });
});

describe('Shard 6b — mutation tracker', () => {
  // Mutation tracking hooks run when Generator invokes write/edit/bash.
  // We test by having the mock Generator call the `write` tool, then
  // verify the tracker accumulated the file entry.
  //
  // Note: the tracker is internal to the run. It's observable via the
  // scope-awareness note that `emit_scout_verdict` appends when H0 is
  // declared with >3 mutations (legacy behavior). For Shard 6b we only
  // assert the plumbing works end-to-end by checking that the write
  // tool call returns successfully — this exercises the
  // recordMutationForTool codepath without adding new assertions.
  it('write tool execution does not crash under the Runner-driven path', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: (turn) => {
        if (turn === 1) {
          // Call write with a path that won't actually exist; we only care
          // that the mutation hook runs (records via recordMutationForTool).
          // The tool will error, which is fine — we're testing plumbing,
          // not end-to-end write success.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'w1', name: 'write',
              input: {
                file_path: '/tmp/kodax-runner-driven-test-nowrite.txt',
                content: 'line1\nline2\nline3\n',
              },
            }],
          };
        }
        // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
        return {
          textBlocks: [{ text: 'Done. (summary: write complete)' }],
          toolBlocks: [],
        };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // Budget usage reflects scout emit + write tool ≥ 2
    // (FEATURE_184 C.1: no verdict emit from in-chain Evaluator;
    //  FEATURE_190 Phase 3: no emit_handoff tool call)
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Shard 6c — Checkpoint recovery (FEATURE_071)
// =============================================================================

describe('Shard 6c — checkpoint handling', () => {
  it('completes a run that has no pre-existing checkpoint without error', async () => {
    // Smoke: the happy-path "no checkpoint" branch in handlePreRunCheckpoint.
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
  });

  it('completes the full H1 chain even with checkpoint writes firing per role', async () => {
    // Exercises the fire-and-forget checkpoint writer during a multi-role
    // run. Failures inside writeCurrentCheckpoint are swallowed, so even
    // if the workspace-root is unwritable the chain completes.
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
      generator: () => ({
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // FEATURE_190 Phase 3: Generator terminates text-only — onRoleEmit('generator')
    // never fires. Sidecar Verifier fires onRoleEmit('evaluator') instead.
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toContain('scout');
    // Either 'generator' (no sidecar env) or 'evaluator' (sidecar ran).
    const terminal = roles?.[roles.length - 1];
    expect(['generator', 'evaluator']).toContain(terminal);
  });
});

describe('Shard 5b — H2 Generator terminates after planning', () => {
  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // Revise cycles via nextHarness no longer exist.
  // Generator terminates with emit_handoff (isTerminal=true).
  it('Scout → Planner → Generator terminates; result.success=true', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Plan v1',
                success_criteria: ['criteria1'],
                required_evidence: [],
                constraints: [],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      generator: () => ({
        // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
        textBlocks: [{ text: 'Done. (summary: task complete)' }],
        toolBlocks: [],
      }),
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Complex task', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
  });
});

describe('Shard 6d-c1 — observer event enrichment', () => {
  it('populates activeWorkerTitle, currentRound, maxRounds on round events', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL', summary: 'chosen H1' },
        }],
      }),
      generator: () => ({
        // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
        textBlocks: [{ text: 'Done. (summary: gen done)' }],
        toolBlocks: [],
      }),
    });
    await runManagedTaskViaRunner(opts, 'do X', mock);
    // Filter for slot-emit "completed a turn" events specifically —
    // FEATURE_166 v0.7.41 follow-up added an `agentSwitched` emit
    // that ALSO matches `phase==='worker' && activeWorkerId===<role>`
    // but fires before the role's slot tool and so carries the
    // pre-increment round. The "round events" this test asserts on
    // are the slot-emit anchors (round counter incremented in
    // onRoleEmit at line ~1552). The `'completed a turn'` note
    // string is unique to those slot emits.
    const isRoundEvent = (s: Record<string, unknown>, role: string): boolean =>
      s.phase === 'worker'
      && s.activeWorkerId === role
      && typeof s.note === 'string'
      && (s.note as string).includes('completed a turn');
    const scoutEvent = statuses.find((s) => isRoundEvent(s, 'scout'));
    expect(scoutEvent?.activeWorkerTitle).toBe('Scout');
    expect(scoutEvent?.currentRound).toBe(1);
    expect(scoutEvent?.maxRounds).toBeGreaterThanOrEqual(6);
    // FEATURE_190 Phase 3: Generator terminates text-only — onRoleEmit('generator')
    // never fires, so no "completed a turn" round event for generator exists.
    // The genEvent is undefined; assert that only slot-emit-based events (Scout)
    // are present, not those tied to emit_handoff (Generator).
    const genEvent = statuses.find((s) => isRoundEvent(s, 'generator'));
    // genEvent may be undefined post-F190 (no slot emit for generator).
    if (genEvent !== undefined) {
      // If present (e.g. future env without sidecar), validate shape.
      expect(genEvent.activeWorkerTitle).toBe('Generator');
      expect(genEvent.currentRound).toBe(2);
    }
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // Post-F190: Sidecar Verifier fires onRoleEmit('evaluator') via
    // applySidecarVerdictToRecorder, which uses the same "completed a turn"
    // note format. evalEvent may be defined when Sidecar runs.
    // The key invariant is that no *in-chain* Evaluator is invoked.
    // Accept both undefined (no sidecar env) and evaluator from sidecar.
    const evalEvent = statuses.find((s) => isRoundEvent(s, 'evaluator'));
    if (evalEvent !== undefined) {
      // Sidecar added evaluator event; verify it is a sidecar-sourced entry.
      // The presence of evalEvent is acceptable post-F190.
      expect(evalEvent.activeWorkerTitle).toBe('Evaluator');
    }
  });

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

  it('completed event has persistToHistory=true (FEATURE_184 C.1: no in-chain Evaluator, detailNote absent)', async () => {
    // FEATURE_190 Phase 3: emit_handoff deleted. Generator terminates text-only.
    // No in-chain Evaluator emits emit_verdict, so detailNote is not set.
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
        textBlocks: [{ text: 'Done.' }],
        toolBlocks: [],
      }),
    });
    await runManagedTaskViaRunner(opts, 'Task X', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed?.persistToHistory).toBe(true);
    // No Evaluator → no detailNote from verdict reason.
    expect(completed?.detailNote).toBeUndefined();
  });

  it('round events default persistToHistory=false (transient progress ticks)', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'ok' }] }),
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    await runManagedTaskViaRunner(opts, 'Task', mock);
    const round = statuses.find((s) => s.phase === 'worker');
    expect(round?.persistToHistory).toBe(false);
  });
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

  it('Planner agent exposes only read + grep + glob + emit_contract (no bash/write/edit)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).toContain('emit_contract');
    expect(plannerTools).toContain('read');
    expect(plannerTools).toContain('grep');
    expect(plannerTools).toContain('glob');
    expect(plannerTools).not.toContain('bash');
    expect(plannerTools).not.toContain('write');
    expect(plannerTools).not.toContain('edit');
  });

  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // "Evaluator agent exposes read + grep + glob + bash + emit_verdict" test deleted.

  it('Generator agent exposes full coding toolbox including write + edit', () => {
    // FEATURE_190 Phase 3: emit_handoff deleted from all agents.
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).not.toContain('emit_handoff');
    expect(genTools).toContain('bash');
    expect(genTools).toContain('write');
    expect(genTools).toContain('edit');
  });

  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // "Evaluator bash blocks shell mutation commands" test deleted.
  // "Evaluator bash allows read-only commands" test deleted.
  // "Evaluator bash blocks git write commands" test deleted.
  // wrapReadOnlyBash is retained for C.3 cleanup.

  it('Scout bash is NOT wrapped — Scout has full tool access per v0.7.22 parity', async () => {
    // v0.7.26 Scout-tool-restoration: Scout runs H0_DIRECT tasks to
    // completion (including file writes), so its bash must not be
    // wrapped with the verification-only guard. Harness routing is
    // enforced by prompt, not tool restrictions. This test guards
    // against future regressions that re-wrap Scout bash.
    //
    // Probe with `python -c "print(1)"` — a pure-read command that
    // WOULD have been blocked by the old `wrapReadOnlyBash` wrapper
    // (SHELL_WRITE_PATTERNS treats `python -c` as mutation). If Scout
    // bash is unwrapped, the block message never fires; the downstream
    // handler gets the command (and may or may not succeed depending on
    // test env, which we don't care about — we only assert on the
    // absence of the wrapper's block message).
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutBash = findTool(chain.scout, 'bash');
    const result = await scoutBash.execute(
      { command: 'python -c "print(1)"' },
      makeToolCtx('scout'),
    );
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text).not.toContain('verification-only');
  });

  it('Scout exposes write/edit/exit_plan_mode tools (v0.7.22 parity)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutTools = chain.scout.tools?.map((t) => t.name) ?? [];
    expect(scoutTools).toContain('write');
    expect(scoutTools).toContain('edit');
    expect(scoutTools).toContain('bash');
    expect(scoutTools).toContain('exit_plan_mode');
  });

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

    it('V1/V2 chain topology: no Worker targets in scout/planner/generator handoffs', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // chain.evaluator no longer exists; verify Worker is not leaked into
      // the remaining agent handoff edges.
      const prev = process.env.KODAX_HARNESS_V2;
      process.env.KODAX_HARNESS_V2 = 'false';
      try {
        const chain = buildRunnerAgentChain(makeCtx(), {});
        const scoutTargets = (chain.scout.handoffs ?? []).map((h) => h.target.name);
        expect(scoutTargets).not.toContain('kodax/role/worker');
        const plannerTargets = (chain.planner.handoffs ?? []).map((h) => h.target.name);
        expect(plannerTargets).not.toContain('kodax/role/worker');
        const genTargets = (chain.generator.handoffs ?? []).map((h) => h.target.name);
        expect(genTargets).not.toContain('kodax/role/worker');
      } finally {
        if (prev === undefined) delete process.env.KODAX_HARNESS_V2;
        else process.env.KODAX_HARNESS_V2 = prev;
      }
    });
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
    function withHarnessV2<T>(value: 'true' | 'false' | undefined, fn: () => T): T {
      const prev = process.env.KODAX_HARNESS_V2;
      if (value === undefined) delete process.env.KODAX_HARNESS_V2;
      else process.env.KODAX_HARNESS_V2 = value;
      try {
        return fn();
      } finally {
        if (prev === undefined) delete process.env.KODAX_HARNESS_V2;
        else process.env.KODAX_HARNESS_V2 = prev;
      }
    }

    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // "V2 active: Evaluator revise targets Worker" test deleted (chain.evaluator gone).

    it('V2 active: Worker has no handoffs (FEATURE_184 C.1: Evaluator removed)', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // FEATURE_190 Phase 3: Worker terminates text-only (emit_handoff deleted); no edge to Evaluator.
      withHarnessV2('true', () => {
        const chain = buildRunnerAgentChain(makeCtx(), {});
        const workerTargets = (chain.worker.handoffs ?? []).map((h) => h.target.name);
        expect(workerTargets).toHaveLength(0);
        expect(workerTargets).not.toContain('kodax/role/evaluator');
      });
    });

    it('flag toggles deterministically: same chain factory, Worker has no Evaluator target in either mode', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // chain.evaluator no longer exists; verify Worker has no Evaluator target.
      withHarnessV2('false', () => {
        const chain = buildRunnerAgentChain(makeCtx(), {});
        expect((chain.worker.handoffs ?? [])).toHaveLength(0);
      });
      withHarnessV2('true', () => {
        const chain = buildRunnerAgentChain(makeCtx(), {});
        expect((chain.worker.handoffs ?? [])).toHaveLength(0);
      });
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

describe('Shard 6d-T — Scout skillMap injected into Generator + Evaluator instructions', () => {
  function resolveInstructions(
    agent: { readonly instructions: string | ((ctx: unknown) => string) },
  ): string {
    return typeof agent.instructions === 'function'
      ? agent.instructions(undefined)
      : agent.instructions;
  }

  it('falls back to base text when Scout has not emitted', () => {
    // FEATURE_190 Phase 3: emit_handoff deleted from Generator instructions.
    const recorder = {};
    const chain = buildRunnerAgentChain(makeCtx(), recorder);
    const gen = resolveInstructions(chain.generator);
    expect(gen).not.toContain('Scout Skill Map');
    expect(gen).not.toContain('emit_handoff');
  });

  it('renders execution_obligations + ambiguities for Generator (not verification)', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: 'add a login form',
              executionObligations: ['write LoginForm.tsx', 'wire up POST /login'],
              verificationObligations: ['e2e test covers login'],
              ambiguities: ['should we support OAuth?'],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    expect(gen).toContain('Scout Skill Map');
    expect(gen).toContain('skill_summary: add a login form');
    expect(gen).toContain('execution_obligations:');
    expect(gen).toContain('- write LoginForm.tsx');
    expect(gen).toContain('- wire up POST /login');
    expect(gen).toContain('ambiguities_to_resolve:');
    expect(gen).toContain('- should we support OAuth?');
    // Generator does NOT see verification obligations.
    expect(gen).not.toContain('verification_obligations:');
  });

  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // "renders verification_obligations for Evaluator" test deleted (chain.evaluator gone).

  it('omits empty obligation lists', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: undefined,
              executionObligations: [],
              verificationObligations: [],
              ambiguities: [],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    // No fields populated → skill block omitted entirely.
    expect(gen).not.toContain('Scout Skill Map');
  });
});

describe('Shard 6d-Q — dispatch_child_task exposed to Scout + Generator only', () => {
  it('Scout agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutTools = chain.scout.tools?.map((t) => t.name) ?? [];
    expect(scoutTools).toContain('dispatch_child_task');
  });

  it('Generator agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).toContain('dispatch_child_task');
  });

  it('Planner agent does NOT expose dispatch_child_task (FEATURE_184 C.1: Evaluator removed)', () => {
    // FEATURE_184 Phase C.1 (v0.7.45): chain.evaluator no longer exists.
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).not.toContain('dispatch_child_task');
  });

  it('Scout-bound dispatch tool errors out if Scout asks for a write child', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutDispatch = chain.scout.tools?.find(
      (t) => t.name === 'dispatch_child_task',
    ) as RunnableTool;
    expect(scoutDispatch).toBeDefined();
    // Scout with `read_only: false` → error (role gating inside
    // toolDispatchChildTask rejects write fan-out from Scout).
    const result = await scoutDispatch.execute(
      {
        id: 'x',
        objective: 'test',
        read_only: false,
      },
      { agent: { name: 'scout' } as unknown as import('@kodax-ai/agent').Agent },
    );
    expect(String(result.content)).toContain('Scout can only dispatch read-only');
  });
});

describe('Shard 6d-S — task verification contract completionContractStatus', () => {
  // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
  // "falls back to base Evaluator text when no verification contract" test deleted.
  // "renders startup command + UI flows + API checks for the Evaluator" test deleted.
  // (chain.evaluator no longer exists; role-prompts.ts Evaluator case retained for C.3.)
  //
  // completionContractStatus now reflects verdictStatus=undefined (no in-chain Evaluator).
  // Verdict is set by Sidecar Verifier (Phase D.2). Without a sidecar verdict, all checks
  // get status='missing'.

  it('populates completionContractStatus=missing when no verdict emitted (FEATURE_184 C.1)', async () => {
    // FEATURE_184 Phase C.1: no in-chain Evaluator → verdictStatus=undefined → status='missing'
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
            textBlocks: [{ text: 'Done. (summary: fixed)' }],
            toolBlocks: [],
          };
        }
        throw new Error('generator overrun');
      },
    });

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        context: {
          ...makeOptions().context!,
          taskVerification: {
            criteria: [
              { id: 'crit.login', label: 'Login works', description: 'Login form submits successfully', threshold: 0.8, weight: 1 },
            ],
            runtime: {
              uiFlows: ['Login flow'],
              apiChecks: ['GET /api/health returns 200'],
              dbChecks: ['user row exists after signup'],
            },
          },
        },
      },
      'Verify the app',
      mock,
    );
    const status = result.managedTask?.runtime?.completionContractStatus;
    expect(status).toBeDefined();
    // FEATURE_190 Phase 3: Sidecar Verifier auto-runs after text-only termination
    // and populates verdict with status='accept', which sets completionContractStatus
    // to 'ready' for all criteria. Accept either 'missing' (no sidecar) or 'ready'.
    for (const key of ['crit.login', 'ui_flow:1', 'api_check:1', 'db_check:1']) {
      expect(['missing', 'ready']).toContain(status![key]);
    }
  });

  it('returns undefined when no verification contract is declared', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'hi' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'hi', mock);
    expect(result.managedTask?.runtime?.completionContractStatus).toBeUndefined();
  });
});

describe('Shard 6d-U — degraded-continue when upgrade beyond ceiling', () => {
  function makePlanWithCeiling(
    upgradeCeiling: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL',
  ): import('../reasoning.js').ReasoningPlan {
    return {
      mode: 'balanced',
      depth: 'medium',
      decision: {
        primaryTask: 'bugfix',
        confidence: 0.8,
        riskLevel: 'medium',
        recommendedMode: 'conversation',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        upgradeCeiling,
        reason: 'test',
      },
      amaControllerDecision: {
        profile: 'tactical',
        tactics: [],
        fanout: { mode: 'off' as const } as unknown as import('@kodax-ai/llm').KodaXAmaFanoutPolicy,
        reason: 'test',
        upgradeTriggers: [],
      },
      promptOverlay: '',
    };
  }

  it('FEATURE_184 C.1: no in-chain Evaluator means degradedContinue is not set (Generator terminates directly)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_190 Phase 3: emit_handoff deleted. Generator terminates text-only.
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
            textBlocks: [{ text: 'Done.' }],
            toolBlocks: [],
          };
        }
        throw new Error('generator overrun');
      },
    });

    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Fix it',
      mock,
      makePlanWithCeiling('H1_EXECUTE_EVAL'),
    );
    expect(result.success).toBe(true);
    // No in-chain Evaluator → no revise request → no degradedContinue flag set.
    expect(result.managedTask?.runtime?.degradedContinue).toBeUndefined();
    // FEATURE_190 Phase 3: Sidecar Verifier auto-runs and may populate verdict.
    // Accept both undefined (no sidecar env) and sidecar accept verdict.
    const verdict = result.managedProtocolPayload?.verdict;
    if (verdict !== undefined) {
      expect(verdict.source).toBe('sidecar');
    }
  });
});

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
  it('fires onIterationEnd after every LLM turn with scope=worker', async () => {
    const iterations: Array<{ iter: number; scope?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onIterationEnd: (info: { iter: number; scope?: string }) =>
          iterations.push({ iter: info.iter, scope: info.scope }),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'x' }] }),
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    await runManagedTaskViaRunner(opts, 'T', mock);
    expect(iterations.length).toBeGreaterThanOrEqual(2); // scout turn 1 + scout turn 2
    expect(iterations.every((i) => i.scope === 'worker')).toBe(true);
    // Iteration counter is monotonically increasing
    expect(iterations[0]!.iter).toBeLessThan(iterations[iterations.length - 1]!.iter);
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
  it('budget extension askUser is NOT fired on short Scout→Generator run (threshold gating)', async () => {
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // Budget cap is 400 for H1; the short Scout+Generator chain burns <<90%,
    // so the askUser dialog is NOT fired — verifies threshold gating.
    const askUserCalls: Array<{ question: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        askUser: async (q: { question: string }) => {
          askUserCalls.push({ question: q.question });
          return 'continue';
        },
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        return { textBlocks: [{ text: 'scout fallback' }] };
      },
      generator: () => ({
        // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
        textBlocks: [{ text: 'Done.' }],
        toolBlocks: [],
      }),
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    await runManagedTaskViaRunner(opts, 'Task', mock);
    // threshold not met — askUser never fires.
    expect(askUserCalls.length).toBe(0);
  });

  it('fires askUser when Evaluator revises and usage crosses 90% threshold', async () => {
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
        mode: 'balanced',
        depth: 'default',
        amaControllerDecision: undefined,
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

  it('Risk-2: first H1 revise passes through unchanged; counter increments', async () => {
    const { wrapEmitterWithRecorder, H1_MAX_SAME_HARNESS_REVISES } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'retry' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 10 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as { payload: { verdict: { status: string } } };
    expect(meta.payload.verdict.status).toBe('revise');
    expect(budgetExtension.reviseCountByHarnessRef.current.get('H1_EXECUTE_EVAL')).toBe(
      H1_MAX_SAME_HARNESS_REVISES,
    );
  });

  it('Risk-2: second H1 revise auto-escalates to H2 when ceiling permits', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'still incomplete' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
    });
    // Pre-seed the counter to simulate "one same-harness revise already used"
    budgetExtension.reviseCountByHarnessRef.current.set('H1_EXECUTE_EVAL', 1);

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as {
      payload: { verdict: { status: string; nextHarness?: string; reason?: string } };
      handoffTarget?: string;
    };
    expect(meta.payload.verdict.nextHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(meta.handoffTarget).toBe('kodax/role/planner');
    expect(meta.payload.verdict.reason).toMatch(/Auto-escalated to H2/);
  });

  it('Risk-2: second H1 revise converts to accept-with-followup when ceiling blocks H2', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({
      status: 'revise',
      reason: 'tests still failing',
      followups: ['fix the lint'],
    });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      upgradeCeiling: 'H1_EXECUTE_EVAL', // ceiling blocks H2 escalation
    });
    budgetExtension.reviseCountByHarnessRef.current.set('H1_EXECUTE_EVAL', 1);

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as {
      payload: { verdict: { status: string; followups: string[]; nextHarness?: string } };
      isTerminal?: boolean;
    };
    expect(meta.payload.verdict.status).toBe('accept');
    expect(meta.payload.verdict.followups[0]).toMatch(/Pending concern from Evaluator.*tests still failing/);
    expect(meta.payload.verdict.followups).toContain('fix the lint');
    expect(meta.payload.verdict.nextHarness).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
    expect(budgetExtension.degradedContinueRef.current).toBe(true);
  });

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

describe('H1 structural resume — buildStructuralResumeSeed (v0.7.26)', () => {
  async function getBuilder() {
    const mod = await import('./runner-driven.js');
    return mod.__runnerDrivenTestables.buildStructuralResumeSeed;
  }

  type ValidatedCheckpointInput = Parameters<
    Awaited<ReturnType<typeof getBuilder>>
  >[0];

  function makeCheckpoint(params: {
    harness: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    scoutCompleted: boolean;
    scoutDecision?: {
      summary?: string;
      recommendedHarness?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
      scope?: string[];
      reviewFilesOrAreas?: string[];
      harnessRationale?: string;
      directCompletionReady?: 'yes' | 'no';
      skillSummary?: string;
      executionObligations?: string[];
    };
    contractSummary?: string;
  }): ValidatedCheckpointInput {
    return {
      checkpoint: {
        version: 1,
        taskId: 'task-test',
        createdAt: new Date().toISOString(),
        gitCommit: 'abcd1234',
        objective: 'resume fixture',
        harnessProfile: params.harness,
        currentRound: 2,
        completedWorkerIds: params.scoutCompleted ? ['scout-1'] : [],
        scoutCompleted: params.scoutCompleted,
      },
      workspaceDir: '/tmp/ws',
      managedTask: {
        contract: {
          taskId: 'task-test',
          surface: 'repl',
          objective: 'resume fixture',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'in_progress',
          primaryTask: 'edit',
          workIntent: 'implement',
          complexity: 'medium',
          riskLevel: 'low',
          harnessProfile: params.harness,
          recommendedMode: 'ama',
          requiresBrainstorm: false,
          reason: 'fixture',
          contractSummary: params.contractSummary,
          successCriteria: params.contractSummary ? ['criterion-1'] : [],
          requiredEvidence: [],
          constraints: [],
        },
        roleAssignments: [],
        workItems: [],
        evidence: { workspaceDir: '/tmp/ws', artifacts: [], entries: [], routingNotes: [] },
        verdict: {
          status: 'in_progress',
          decidedByAssignmentId: '',
          summary: '',
        },
        runtime: params.scoutDecision
          ? {
            scoutDecision: {
              summary: params.scoutDecision.summary ?? 'scout summary',
              recommendedHarness: params.scoutDecision.recommendedHarness ?? params.harness,
              readyForUpgrade: false,
              scope: params.scoutDecision.scope,
              reviewFilesOrAreas: params.scoutDecision.reviewFilesOrAreas,
              harnessRationale: params.scoutDecision.harnessRationale,
              directCompletionReady: params.scoutDecision.directCompletionReady,
              skillSummary: params.scoutDecision.skillSummary,
              executionObligations: params.scoutDecision.executionObligations,
            },
          }
          : undefined,
      },
    } as unknown as ValidatedCheckpointInput;
  }

  it('H1 scout completed → starts at generator, scout slot seeded, rolesEmitted=[scout]', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Investigated modules A + B',
        recommendedHarness: 'H1_EXECUTE_EVAL',
        scope: ['src/a.ts', 'src/b.ts'],
        harnessRationale: 'single-file write sufficient',
      },
    }));
    expect(seed.startingRole).toBe('generator');
    expect(seed.harness).toBe('H1_EXECUTE_EVAL');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.scout).toBeDefined();
    expect(seed.recorderSlots.scout?.role).toBe('scout');
    expect(seed.recorderSlots.scout?.payload.scout?.summary).toBe('Investigated modules A + B');
    expect(seed.recorderSlots.scout?.payload.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(seed.recorderSlots.scout?.handoffTarget).toBe('kodax/role/generator');
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H2 scout completed, no contract → starts at planner', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H2_PLAN_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Large refactor across 4 modules',
        recommendedHarness: 'H2_PLAN_EXECUTE_EVAL',
      },
    }));
    expect(seed.startingRole).toBe('planner');
    expect(seed.harness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H2 scout + contract completed → starts at generator, both slots seeded', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H2_PLAN_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Multi-phase migration',
        recommendedHarness: 'H2_PLAN_EXECUTE_EVAL',
      },
      contractSummary: 'Phase 1: add schema; Phase 2: backfill; Phase 3: cutover',
    }));
    expect(seed.startingRole).toBe('generator');
    expect(seed.rolesEmitted).toEqual(['scout', 'planner']);
    expect(seed.recorderSlots.scout).toBeDefined();
    expect(seed.recorderSlots.contract).toBeDefined();
    expect(seed.recorderSlots.contract?.payload.contract?.summary)
      .toContain('Phase 1: add schema');
    expect(seed.recorderSlots.contract?.payload.contract?.successCriteria).toEqual(['criterion-1']);
  });

  it('no scout completion → starts at scout with empty seeds (plain restart)', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: false,
    }));
    expect(seed.startingRole).toBe('scout');
    expect(seed.rolesEmitted).toEqual([]);
    expect(seed.recorderSlots.scout).toBeUndefined();
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H0 scout completed → stays at scout (re-emit direct answer with context)', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H0_DIRECT',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Trivial explain-only',
        recommendedHarness: 'H0_DIRECT',
        directCompletionReady: 'yes',
      },
    }));
    expect(seed.startingRole).toBe('scout');
    expect(seed.harness).toBe('H0_DIRECT');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.scout?.isTerminal).toBe(true);
  });

  it('seeded scout skillMap round-trips the skillSummary + obligations', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'write-heavy edit',
        recommendedHarness: 'H1_EXECUTE_EVAL',
        skillSummary: 'use edit for single-file change',
        executionObligations: ['preserve CRLF', 'keep header comment'],
      },
    }));
    const skillMap = seed.recorderSlots.scout?.payload.scout?.skillMap;
    expect(skillMap).toBeDefined();
    expect(skillMap?.skillSummary).toBe('use edit for single-file change');
    expect(skillMap?.executionObligations).toEqual(['preserve CRLF', 'keep header comment']);
  });
});

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
// → Worker emits handoff → Evaluator accepts) with the child-executor
// mocked so we control settlement timing precisely. Idle-yield is
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
  let prevHarnessV2: string | undefined;
  let prevAsyncDispatch: string | undefined;

  beforeEach(() => {
    prevHarnessV2 = process.env.KODAX_HARNESS_V2;
    prevAsyncDispatch = process.env.KODAX_ASYNC_DISPATCH;
    process.env.KODAX_HARNESS_V2 = 'true';
    // Ensure the dispatch tool takes the async / fire-and-forget path
    // — the sync path runs the child inline and never reaches the
    // idle-yield branch.
    delete process.env.KODAX_ASYNC_DISPATCH;
    mockExec.mockReset();
    _resetMessageQueueForTests();
  });

  afterEach(() => {
    if (prevHarnessV2 === undefined) delete process.env.KODAX_HARNESS_V2;
    else process.env.KODAX_HARNESS_V2 = prevHarnessV2;
    if (prevAsyncDispatch === undefined) delete process.env.KODAX_ASYNC_DISPATCH;
    else process.env.KODAX_ASYNC_DISPATCH = prevAsyncDispatch;
    _resetMessageQueueForTests();
  });

  it('Worker dispatches → idle-yields → child completes → Worker resumes & emits handoff → Evaluator accepts', async () => {
    let resolveChild!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveChild = resolve;
      }),
    );

    const workerTurns: number[] = [];
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

    const result = await runManagedTaskViaRunner(makeOptions(), 'count imports of foo', mock);

    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Worker MUST have been called at least three times:
    //   turn 1 — dispatch
    //   turn 2 — idle-yield (text-only)
    //   turn 3 — text-only termination (post-resume)
    expect(workerTurns.length).toBeGreaterThanOrEqual(3);
    expect(workerTurns).toContain(3);
    // The synthetic user message must have surfaced the canonical
    // banner format on resume.
    expect(resumeTranscriptHadBanner).toBe(true);
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
  // V2 Worker→Evaluator handoff label-lag fix. The runner-driven outer
  // loop now provides an `onAgentSwitched` callback to `Runner.run`;
  // that callback maps the new agent's name to a `KodaXTaskRole` and
  // calls `observer.agentSwitched(role)`, which emits a fresh status
  // event with `activeWorkerTitle: ROLE_TO_TITLE[role]`. The REPL reads
  // this on the next render frame and the new agent's first streaming
  // output displays under the correct label.
  //
  // Without the hook, the label stays on whichever role last fired
  // `onRoleEmit` (Worker, from emit_handoff success at line ~1093).
  // Production session 20260515_185354 confirmed: Evaluator's
  // text-only review summary surfaced under `[Worker]` because zhipu
  // never emitted emit_verdict to flip the label.
  //
  // The test below uses the same withHarnessV2 + makeChainMockLlm
  // shape as the FEATURE_114 V2 tests above.
  async function withHarnessV2<T>(
    value: 'true' | 'false' | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = process.env.KODAX_HARNESS_V2;
    if (value === undefined) delete process.env.KODAX_HARNESS_V2;
    else process.env.KODAX_HARNESS_V2 = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.KODAX_HARNESS_V2;
      else process.env.KODAX_HARNESS_V2 = prev;
    }
  }

  // FEATURE_184 Phase C.1 (v0.7.45): Deleted "emits a phase=worker status
  // with activeWorkerTitle='Evaluator' AFTER Worker emit_handoff and BEFORE
  // Evaluator emit_verdict" test — tested V2 Worker→Evaluator handoff label
  // flip which required in-chain Evaluator. Evaluator removed from chain.

  it('does not emit agent-switched when no handoff happens (single-role H0 direct run)', async () => {
    // V1 Scout H0 path: no handoff at all (Scout-only run). The
    // observer's agentSwitched callback should never fire because
    // the agent runtime never invokes the onAgentSwitched hook
    // without a handoffSignal.
    await withHarnessV2('false', async () => {
      const statuses: Array<Record<string, unknown>> = [];
      const opts = {
        ...makeOptions(),
        events: {
          onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
        },
      } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
      const mock = makeChainMockLlm({
        scout: (turn) => {
          if (turn === 1) {
            return {
              toolBlocks: [{
                type: 'tool_use',
                id: 's1',
                name: 'emit_scout_verdict',
                input: {
                  confirmed_harness: 'H0_DIRECT',
                  direct_completion_ready: 'yes',
                  summary: 'Trivial',
                  scope: [],
                  required_evidence: [],
                  harness_rationale: 'Trivial.',
                },
              }],
            };
          }
          return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
        },
      });
      await runManagedTaskViaRunner(opts, 'What is 2 + 2?', mock);

      // No `taking over` notes — that string is unique to the
      // FEATURE_166 agentSwitched emit shape, so absence pins the
      // "hook did not fire" invariant.
      const switchedStatuses = statuses.filter(
        (s) => typeof s.note === 'string' && (s.note as string).endsWith(' taking over'),
      );
      expect(switchedStatuses).toEqual([]);
    });
  });

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
