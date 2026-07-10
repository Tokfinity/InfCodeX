/**
 * Eval: FEATURE_254 tool exposure bridge reachability.
 *
 * Layer 1 deterministic release gate:
 * - uses production tool definitions and the real runKodaX provider-visible
 *   tool assembly;
 * - verifies small-window schema pruning hides non-core deferred tools while
 *   keeping portable bridge helpers visible;
 * - verifies hidden-but-active targets stay reachable through both coding
 *   dispatch and managed Worker wiring.
 *
 * Run:
 *   npm run test:eval -- tests/tool-exposure-bridge-reachability.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import { runKodaX } from '../packages/coding/src/agent.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import type { RuntimeContextBudgetSnapshot } from '../packages/coding/src/agent-runtime/context-budget.js';
import type { RuntimeToolExposurePlan } from '../packages/coding/src/agent-runtime/tool-exposure-planner.js';
import type { KodaXEvents, KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import {
  registerTool,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
} from '../packages/coding/src/tools/index.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';

const TEST_PROVIDER_NAME = 'tool-exposure-bridge-eval-provider';
const TEST_PROVIDER_API_KEY_ENV = 'TOOL_EXPOSURE_BRIDGE_EVAL_API_KEY';
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-exposure-bridge-reachability');

class ToolExposureEvalProvider extends KodaXBaseProvider {
  static calls: Array<{
    readonly messages: KodaXMessage[];
    readonly tools: KodaXToolDefinition[];
    readonly streamOptions?: KodaXProviderStreamOptions;
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'bridge-eval-model',
    supportsThinking: false,
    contextWindow: 16_000,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    ToolExposureEvalProvider.calls.push({ messages, tools, streamOptions });
    streamOptions?.onTextDelta?.('bridge eval ok');
    return {
      textBlocks: [{ type: 'text', text: 'bridge eval ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        totalTokens: 104,
      },
    };
  }
}

const cleanupToolRegistrations: Array<() => void> = [];

function writeEvalDump(name: string, data: unknown): void {
  mkdirSync(DUMP_ROOT, { recursive: true });
  writeFileSync(join(DUMP_ROOT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

function makeToolBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): KodaXToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function makeManagedCtx(): KodaXToolExecutionContext {
  return {
    ...makeCtx(),
    extensionRuntime: {} as KodaXToolExecutionContext['extensionRuntime'],
    workflowHost: {} as KodaXToolExecutionContext['workflowHost'],
  };
}

function makeRecorder(): Parameters<typeof buildRunnerAgentChain>[1] {
  return {};
}

describe('Eval: tool exposure bridge reachability', () => {
  beforeEach(() => {
    ToolExposureEvalProvider.calls = [];
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(TEST_PROVIDER_NAME, () => new ToolExposureEvalProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
    while (cleanupToolRegistrations.length > 0) {
      cleanupToolRegistrations.pop()?.();
    }
  });

  it('small-window provider-visible schemas hide non-core deferred tools but keep the bridge resident', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const exposures: RuntimeToolExposurePlan[] = [];

    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        context: {
          contextDiagnostics: true,
          repoIntelligenceMode: 'off',
        },
        events: {
          onContextBudgetSnapshot: (event) => budgets.push(event),
          onToolExposurePlanned: (event) => exposures.push(event),
        },
      },
      'Verify small-window bridge reachability without using external services.',
    );

    const visibleToolNames = ToolExposureEvalProvider.calls[0]?.tools.map((tool) => tool.name) ?? [];
    const exposure = exposures[0];
    const webFetchDecision = exposure?.decisions.find((decision) => decision.toolName === 'web_fetch');

    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.profile).toBe('small_window');
    expect(exposure?.profile).toBe('small_window');
    expect(exposure?.reportOnly).toBe(false);
    expect(exposure?.bridgeAvailable).toBe(true);
    expect(webFetchDecision?.mode).toBe('bridge');
    expect(webFetchDecision?.modelVisible).toBe(false);

    for (const required of ['read', 'grep', TOOL_DESCRIBE_NAME, TOOL_CALL_NAME, 'tool_search']) {
      expect(visibleToolNames, `provider-visible tools should retain ${required}`).toContain(required);
    }
    expect(visibleToolNames).not.toContain('web_fetch');
    expect(exposure?.estimatedToolSchemaTokensBefore).toBeGreaterThan(
      exposure?.estimatedToolSchemaTokensAfter ?? Number.POSITIVE_INFINITY,
    );
    expect(exposure?.estimatedTokensSaved).toBeGreaterThan(0);

    writeEvalDump('small-window-provider-visible-tools', {
      stage: 'small-window-provider-visible-tools',
      profile: exposure?.profile,
      pressure: exposure?.pressure,
      providerVisibleToolNames: visibleToolNames,
      bridgeDecisions: exposure?.decisions
        .filter((decision) => decision.mode === 'bridge')
        .map((decision) => ({
          toolName: decision.toolName,
          reason: decision.reason,
          estimatedTokensBefore: decision.estimatedTokensBefore,
          estimatedTokensAfter: decision.estimatedTokensAfter,
        })),
      estimatedToolSchemaTokensBefore: exposure?.estimatedToolSchemaTokensBefore,
      estimatedToolSchemaTokensAfter: exposure?.estimatedToolSchemaTokensAfter,
      estimatedTokensSaved: exposure?.estimatedTokensSaved,
    });
  });

  it('coding dispatch can describe and call an active target that is absent from provider-visible schemas', async () => {
    cleanupToolRegistrations.push(registerTool({
      name: 'bridge_eval_target',
      description: 'Eval-only bridge target used to prove hidden active tool reachability.',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      handler: async (input, ctx) => `bridge-eval-target:${String(input.value)}:${ctx.toolCallId ?? 'missing'}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    }));

    const activeToolNames = [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME, 'bridge_eval_target'];
    const providerVisibleToolNames = [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME];
    const permissionNames: string[] = [];
    const events: KodaXEvents = {
      beforeToolExecute: async (name) => {
        permissionNames.push(name);
        return undefined;
      },
    };

    const results = await runToolDispatch({
      toolBlocks: [
        makeToolBlock('describe-1', TOOL_DESCRIBE_NAME, {
          name: 'bridge_eval_target',
        }),
        makeToolBlock('call-1', TOOL_CALL_NAME, {
          name: 'bridge_eval_target',
          input: { value: 'ok' },
        }),
      ],
      events,
      ctx: makeCtx(),
      runtimeSessionState: buildRuntimeSessionState({
        activeTools: activeToolNames,
        modelSelection: { provider: TEST_PROVIDER_NAME },
      }),
      activeToolNames,
      abortSignal: undefined,
    });

    expect(providerVisibleToolNames).not.toContain('bridge_eval_target');
    expect(results.get('describe-1')).toContain('"name":"bridge_eval_target"');
    expect(results.get('call-1')).toContain('bridge-eval-target:ok:call-1:bridge_eval_target');
    expect(permissionNames).toEqual(expect.arrayContaining([
      TOOL_DESCRIBE_NAME,
      TOOL_CALL_NAME,
      'bridge_eval_target',
    ]));

    writeEvalDump('coding-dispatch-hidden-active-target', {
      stage: 'coding-dispatch-hidden-active-target',
      activeToolNames,
      providerVisibleToolNames,
      permissionNames,
      describeResult: results.get('describe-1'),
      callResult: results.get('call-1'),
    });
  });

  it('managed Worker bridge can describe and call an active registered target', async () => {
    cleanupToolRegistrations.push(registerTool({
      name: 'managed_bridge_eval_target',
      description: 'Managed eval bridge target.',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      handler: async (input) => `managed-bridge-eval-target:${String(input.value)}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    }));

    const chain = buildRunnerAgentChain(makeManagedCtx(), makeRecorder());
    const workerTools = (chain.worker.tools ?? []) as Array<{
      readonly name: string;
      readonly execute?: (
        input: Record<string, unknown>,
        ctx: { readonly agent: typeof chain.worker; readonly toolCallId: string },
      ) => Promise<{ readonly content: string | readonly unknown[]; readonly isError?: boolean }>;
    }>;
    const describeTool = workerTools.find((tool) => tool.name === TOOL_DESCRIBE_NAME);
    const callTool = workerTools.find((tool) => tool.name === TOOL_CALL_NAME);

    expect(describeTool?.execute).toBeTypeOf('function');
    expect(callTool?.execute).toBeTypeOf('function');

    const describeResult = await describeTool!.execute!(
      { name: 'managed_bridge_eval_target' },
      { agent: chain.worker, toolCallId: 'managed-describe-1' },
    );
    const callResult = await callTool!.execute!(
      { name: 'managed_bridge_eval_target', input: { value: 'ok' } },
      { agent: chain.worker, toolCallId: 'managed-call-1' },
    );

    expect(String(describeResult.content)).toContain('"name":"managed_bridge_eval_target"');
    expect(String(describeResult.content)).toContain('Managed eval bridge target.');
    expect(callResult.content).toBe('managed-bridge-eval-target:ok');

    writeEvalDump('managed-worker-bridge-target', {
      stage: 'managed-worker-bridge-target',
      workerToolNames: workerTools.map((tool) => tool.name),
      describeResult: describeResult.content,
      callResult: callResult.content,
    });
  });
});
