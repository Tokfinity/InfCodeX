/**
 * Eval: provider empty-content contract.
 *
 * Purpose:
 *   Measure how KodaX's primary coding-plan providers react to empty or
 *   substance-free transcript shapes that KodaX can produce via hidden tool
 *   filtering, microcompaction, history cleanup, recovery, compression, or
 *   restored sessions.
 *
 * This is a provider-boundary eval, not a model-quality eval:
 *   - `kodax_path` sends the case through the current KodaX provider adapter.
 *   - `raw_wire_probe` sends the equivalent unguarded protocol payload
 *     directly to the upstream gateway where that is feasible.
 *
 * Run:
 *   KODAX_EVAL_PROVIDER_EMPTY_CONTENT=1 npm run test:eval -- provider-empty-content-contract
 *
 * Optional subset:
 *   KODAX_EVAL_PROVIDER_EMPTY_CONTENT=1 \
 *   KODAX_EVAL_PROVIDER_EMPTY_CONTENT_PROVIDERS=kimi-code,deepseek \
 *   npm run test:eval -- provider-empty-content-contract
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import {
  getProvider,
  KODAX_PROVIDER_SNAPSHOTS,
  type KodaXBaseProvider,
  type KodaXMessage,
  type KodaXStreamResult,
  type KodaXTokenUsage,
  type KodaXToolDefinition,
  type ProviderName,
} from '@kodax-ai/llm';

const GATE_ENV = 'KODAX_EVAL_PROVIDER_EMPTY_CONTENT';
const PROVIDERS_ENV = 'KODAX_EVAL_PROVIDER_EMPTY_CONTENT_PROVIDERS';
const isLiveOptIn = process.env[GATE_ENV] === '1';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 8;

const DEFAULT_PROVIDER_NAMES = [
  'kimi-code',
  'zhipu-coding',
  'minimax-coding',
  'mimo-coding',
  'mimo',
  'ark-coding',
  'deepseek',
] as const satisfies readonly ProviderName[];

type ProbeProtocol = 'anthropic' | 'openai';
type ProbePath = 'kodax_path' | 'raw_wire_probe';
type ProbeStatus = 'accepted' | 'rejected' | 'skipped';

interface ProviderPlan {
  readonly name: ProviderName;
  readonly protocol: ProbeProtocol;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly baseUrl: string;
}

const PROVIDER_PLANS: Readonly<Record<(typeof DEFAULT_PROVIDER_NAMES)[number], ProviderPlan>> = {
  'kimi-code': {
    name: 'kimi-code',
    protocol: 'anthropic',
    apiKeyEnv: 'KIMI_CODE_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS['kimi-code'].model,
    baseUrl: 'https://api.kimi.com/coding/',
  },
  'zhipu-coding': {
    name: 'zhipu-coding',
    protocol: 'anthropic',
    apiKeyEnv: 'ZHIPU_CODING_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS['zhipu-coding'].model,
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  },
  'minimax-coding': {
    name: 'minimax-coding',
    protocol: 'anthropic',
    apiKeyEnv: 'MINIMAX_CODING_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS['minimax-coding'].model,
    baseUrl: 'https://api.minimaxi.com/anthropic',
  },
  'mimo-coding': {
    name: 'mimo-coding',
    protocol: 'anthropic',
    apiKeyEnv: 'MIMO_CODING_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS['mimo-coding'].model,
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  },
  mimo: {
    name: 'mimo',
    protocol: 'anthropic',
    apiKeyEnv: 'MIMO_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS.mimo.model,
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
  },
  'ark-coding': {
    name: 'ark-coding',
    protocol: 'anthropic',
    apiKeyEnv: 'ARK_CODING_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS['ark-coding'].model,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  },
  deepseek: {
    name: 'deepseek',
    protocol: 'openai',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: KODAX_PROVIDER_SNAPSHOTS.deepseek.model,
    baseUrl: 'https://api.deepseek.com',
  },
};

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'provider-empty-content-contract',
);

const SYSTEM_PROMPT =
  'Provider empty-content contract probe. Reply with OK if you can continue.';

const KODAX_NOOP_TOOL: KodaXToolDefinition = {
  name: 'noop',
  description: 'No-op probe tool for empty-content provider contract eval.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const OPENAI_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: KODAX_NOOP_TOOL.name,
      description: KODAX_NOOP_TOOL.description,
      parameters: KODAX_NOOP_TOOL.input_schema,
    },
  },
];

const ANTHROPIC_TOOLS = [
  {
    name: KODAX_NOOP_TOOL.name,
    description: KODAX_NOOP_TOOL.description,
    input_schema: KODAX_NOOP_TOOL.input_schema,
  },
] as unknown as Anthropic.Messages.Tool[];

type AnthropicRawMessage = {
  readonly role: 'user' | 'assistant';
  readonly content: unknown;
};

type OpenAIRawMessage = Record<string, unknown>;

interface EmptyContentCase {
  readonly id: string;
  readonly origin: string;
  readonly kodaxMessages: readonly KodaXMessage[];
  readonly rawAnthropicMessages?: readonly AnthropicRawMessage[];
  readonly rawOpenAIMessages?: readonly OpenAIRawMessage[];
  readonly mustAcceptKodaXPath: boolean;
}

interface ErrorSummary {
  readonly name?: string;
  readonly status?: string | number;
  readonly code?: string | number;
  readonly type?: string;
  readonly message: string;
}

interface UsageSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

interface ProbeOutcome {
  readonly provider: ProviderName;
  readonly protocol: ProbeProtocol;
  readonly caseId: string;
  readonly path: ProbePath;
  readonly status: ProbeStatus;
  readonly durationMs: number;
  readonly stopReason?: string;
  readonly usage?: UsageSummary;
  readonly error?: ErrorSummary;
  readonly skipReason?: string;
}

function user(content: string): KodaXMessage {
  return { role: 'user', content };
}

function assistant(content: KodaXMessage['content']): KodaXMessage {
  return { role: 'assistant', content };
}

function toolUseMessage(content: KodaXMessage['content']): KodaXMessage {
  return { role: 'assistant', content };
}

function toolResultMessage(content: KodaXMessage['content']): KodaXMessage {
  return { role: 'user', content };
}

const CASES: readonly EmptyContentCase[] = [
  {
    id: 'baseline_normal_user',
    origin: 'credential and routing baseline',
    kodaxMessages: [user('Say OK.')],
    rawAnthropicMessages: [{ role: 'user', content: 'Say OK.' }],
    rawOpenAIMessages: [{ role: 'user', content: 'Say OK.' }],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_empty_array',
    origin: 'hidden tool filtering leaves assistant.content empty',
    kodaxMessages: [user('Start.'), assistant([]), user('Continue.')],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_empty_text_block',
    origin: 'history cleanup / proposed invisible placeholder path',
    kodaxMessages: [user('Start.'), assistant([{ type: 'text', text: '' }]), user('Continue.')],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_whitespace_text_block',
    origin: 'LLM emitted only whitespace or sanitizer preserved whitespace',
    kodaxMessages: [user('Start.'), assistant([{ type: 'text', text: '   ' }]), user('Continue.')],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_empty_string_content',
    origin: 'legacy/restored assistant string content is empty',
    kodaxMessages: [user('Start.'), assistant(''), user('Continue.')],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_thinking_only_nonempty',
    origin: 'reasoning provider returned thinking with no public text/tool',
    kodaxMessages: [
      user('Start.'),
      assistant([{ type: 'thinking', thinking: 'Need to continue carefully.', signature: '' }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Need to continue carefully.', signature: '' }],
      },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '', reasoning_content: 'Need to continue carefully.' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_empty_thinking_only',
    origin: 'microcompaction or thinking sanitization leaves empty thinking block',
    kodaxMessages: [
      user('Start.'),
      assistant([{ type: 'thinking', thinking: '', signature: '' }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '', reasoning_content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_tool_use_without_thinking_then_result',
    origin: 'session restore / pre-thinking history with tool_use but no thinking',
    kodaxMessages: [
      user('Call the no-op tool.'),
      toolUseMessage([{ type: 'tool_use', id: 'call_no_thinking', name: 'noop', input: {} }]),
      toolResultMessage([{ type: 'tool_result', tool_use_id: 'call_no_thinking', content: 'ok' }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_no_thinking', name: 'noop', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_no_thinking', content: 'ok' }],
      },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_no_thinking', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_no_thinking', content: 'ok' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'assistant_tool_use_empty_thinking_then_result',
    origin: 'tool_use turn with thinking field cleared by cleanup',
    kodaxMessages: [
      user('Call the no-op tool.'),
      toolUseMessage([
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'tool_use', id: 'call_empty_thinking', name: 'noop', input: {} },
      ]),
      toolResultMessage([{ type: 'tool_result', tool_use_id: 'call_empty_thinking', content: 'ok' }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 'call_empty_thinking', name: 'noop', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_empty_thinking', content: 'ok' }],
      },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '',
        tool_calls: [
          { id: 'call_empty_thinking', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_empty_thinking', content: 'ok' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'empty_tool_result_string',
    origin: 'tool execution produced empty stdout/content',
    kodaxMessages: [
      user('Call the no-op tool.'),
      toolUseMessage([{ type: 'tool_use', id: 'call_empty_result', name: 'noop', input: {} }]),
      toolResultMessage([{ type: 'tool_result', tool_use_id: 'call_empty_result', content: '' }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_empty_result', name: 'noop', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_empty_result', content: '' }],
      },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_empty_result', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_empty_result', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'empty_tool_result_array',
    origin: 'multimodal/structured tool_result array is empty',
    kodaxMessages: [
      user('Call the no-op tool.'),
      toolUseMessage([{ type: 'tool_use', id: 'call_empty_array_result', name: 'noop', input: {} }]),
      toolResultMessage([{ type: 'tool_result', tool_use_id: 'call_empty_array_result', content: [] }]),
      user('Continue.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_empty_array_result', name: 'noop', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_empty_array_result', content: [] }],
      },
      { role: 'user', content: 'Continue.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_empty_array_result', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_empty_array_result', content: '' },
      { role: 'user', content: 'Continue.' },
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'orphan_tool_use_then_user_continue',
    origin: 'interrupted/restored history retains unanswered tool_use',
    kodaxMessages: [
      user('Call the no-op tool.'),
      toolUseMessage([{ type: 'tool_use', id: 'call_orphan', name: 'noop', input: {} }]),
      user('Continue without the missing tool result.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_orphan', name: 'noop', input: {} }],
      },
      { role: 'user', content: 'Continue without the missing tool result.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Call the no-op tool.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_orphan', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'user', content: 'Continue without the missing tool result.' },
    ],
    mustAcceptKodaXPath: false,
  },
  {
    id: 'mid_history_empty_system',
    origin: 'compaction/restore leaves an empty system message in history',
    kodaxMessages: [
      user('Start.'),
      { role: 'system', content: '' },
      assistant([{ type: 'text', text: 'Previous answer.' }]),
      user('Continue.'),
    ],
    mustAcceptKodaXPath: true,
  },
  {
    id: 'consecutive_empty_assistant_turns',
    origin: 'history trimming/restoration concatenates multiple empty assistant turns',
    kodaxMessages: [
      user('Start.'),
      assistant([]),
      user('Continue once.'),
      assistant([{ type: 'text', text: '' }]),
      user('Continue twice.'),
    ],
    rawAnthropicMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'Continue once.' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'Continue twice.' },
    ],
    rawOpenAIMessages: [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue once.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue twice.' },
    ],
    mustAcceptKodaXPath: true,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldAsStringOrNumber(record: Record<string, unknown>, key: string): string | number | undefined {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function summarizeError(error: unknown): ErrorSummary {
  if (error instanceof Error) {
    const record = isRecord(error) ? error : {};
    return {
      name: error.name,
      status: fieldAsStringOrNumber(record, 'status'),
      code: fieldAsStringOrNumber(record, 'code'),
      type: typeof record.type === 'string' ? record.type : undefined,
      message: error.message,
    };
  }
  if (isRecord(error)) {
    return {
      status: fieldAsStringOrNumber(error, 'status'),
      code: fieldAsStringOrNumber(error, 'code'),
      type: typeof error.type === 'string' ? error.type : undefined,
      message: typeof error.message === 'string' ? error.message : JSON.stringify(error),
    };
  }
  return { message: String(error) };
}

function numericField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeKodaXUsage(usage: KodaXTokenUsage | undefined): UsageSummary | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedReadTokens: usage.cachedReadTokens,
    cachedWriteTokens: usage.cachedWriteTokens,
  };
}

function summarizeOpenAIUsage(usage: unknown): UsageSummary | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  return {
    inputTokens: numericField(usage, 'prompt_tokens'),
    outputTokens: numericField(usage, 'completion_tokens'),
    totalTokens: numericField(usage, 'total_tokens'),
    cachedReadTokens:
      numericField(promptDetails ?? {}, 'cached_tokens')
      ?? numericField(usage, 'prompt_cache_hit_tokens'),
  };
}

function summarizeAnthropicUsage(usage: unknown): UsageSummary | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens = numericField(usage, 'input_tokens');
  const outputTokens = numericField(usage, 'output_tokens');
  const cachedReadTokens = numericField(usage, 'cache_read_input_tokens');
  const cachedWriteTokens = numericField(usage, 'cache_creation_input_tokens');
  const totalInput = (inputTokens ?? 0) + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0);
  return {
    inputTokens: totalInput || inputTokens,
    outputTokens,
    totalTokens: outputTokens !== undefined ? totalInput + outputTokens : undefined,
    cachedReadTokens,
    cachedWriteTokens,
  };
}

function stopReasonFromKodaX(result: KodaXStreamResult): string | undefined {
  return result.stopReason;
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function selectedPlans(): ProviderPlan[] {
  const raw = process.env[PROVIDERS_ENV];
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_PROVIDER_NAMES.map((name) => PROVIDER_PLANS[name]);
  }
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean);
  return names.map((name) => {
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_PLANS, name)) {
      throw new Error(
        `Unknown provider in ${PROVIDERS_ENV}: ${name}. `
        + `Known: ${Object.keys(PROVIDER_PLANS).join(', ')}`,
      );
    }
    return PROVIDER_PLANS[name as keyof typeof PROVIDER_PLANS];
  });
}

async function runKodaXPath(
  provider: KodaXBaseProvider,
  plan: ProviderPlan,
  testCase: EmptyContentCase,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  try {
    const result = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
      provider.complete(
        [...testCase.kodaxMessages],
        [KODAX_NOOP_TOOL],
        SYSTEM_PROMPT,
        undefined,
        {
          modelOverride: plan.model,
          maxOutputTokensOverride: MAX_OUTPUT_TOKENS,
        },
        signal,
      ));
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'kodax_path',
      status: 'accepted',
      durationMs: Date.now() - t0,
      stopReason: stopReasonFromKodaX(result),
      usage: summarizeKodaXUsage(result.usage),
    };
  } catch (error) {
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'kodax_path',
      status: 'rejected',
      durationMs: Date.now() - t0,
      error: summarizeError(error),
    };
  }
}

function anthropicMessages(
  messages: readonly AnthropicRawMessage[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) as unknown as Anthropic.Messages.MessageParam[];
}

function openAIMessages(
  messages: readonly OpenAIRawMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[];
}

async function runRawAnthropicPath(
  plan: ProviderPlan,
  testCase: EmptyContentCase,
  apiKey: string,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  if (!testCase.rawAnthropicMessages) {
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'skipped',
      durationMs: 0,
      skipReason: 'case has no Anthropic-protocol raw equivalent',
    };
  }

  const client = new Anthropic({
    apiKey,
    baseURL: plan.baseUrl,
    defaultHeaders: { 'User-Agent': 'KodaX' },
  });

  try {
    const response = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
      client.messages.create(
        {
          model: plan.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: anthropicMessages(testCase.rawAnthropicMessages!),
          tools: ANTHROPIC_TOOLS,
        },
        { signal },
      ));
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'accepted',
      durationMs: Date.now() - t0,
      stopReason: response.stop_reason ?? undefined,
      usage: summarizeAnthropicUsage(response.usage),
    };
  } catch (error) {
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'rejected',
      durationMs: Date.now() - t0,
      error: summarizeError(error),
    };
  }
}

async function runRawOpenAIPath(
  plan: ProviderPlan,
  testCase: EmptyContentCase,
  apiKey: string,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  if (!testCase.rawOpenAIMessages) {
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'skipped',
      durationMs: 0,
      skipReason: 'case has no OpenAI-protocol raw equivalent',
    };
  }

  const client = new OpenAI({
    apiKey,
    baseURL: plan.baseUrl,
    defaultHeaders: { 'User-Agent': 'KodaX' },
  });

  try {
    const response = await withTimeout(REQUEST_TIMEOUT_MS, (signal) =>
      client.chat.completions.create(
        {
          model: plan.model,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...openAIMessages(testCase.rawOpenAIMessages!),
          ],
          tools: OPENAI_TOOLS,
        },
        { signal },
      ));
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'accepted',
      durationMs: Date.now() - t0,
      stopReason: response.choices[0]?.finish_reason ?? undefined,
      usage: summarizeOpenAIUsage(response.usage),
    };
  } catch (error) {
    return {
      provider: plan.name,
      protocol: plan.protocol,
      caseId: testCase.id,
      path: 'raw_wire_probe',
      status: 'rejected',
      durationMs: Date.now() - t0,
      error: summarizeError(error),
    };
  }
}

async function runRawPath(
  plan: ProviderPlan,
  testCase: EmptyContentCase,
  apiKey: string,
): Promise<ProbeOutcome> {
  return plan.protocol === 'anthropic'
    ? runRawAnthropicPath(plan, testCase, apiKey)
    : runRawOpenAIPath(plan, testCase, apiKey);
}

async function runProviderMatrix(plan: ProviderPlan): Promise<ProbeOutcome[]> {
  const apiKey = process.env[plan.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${plan.apiKeyEnv}`);
  }
  const provider = getProvider(plan.name);
  const outcomes: ProbeOutcome[] = [];
  for (const testCase of CASES) {
    outcomes.push(await runKodaXPath(provider, plan, testCase));
    outcomes.push(await runRawPath(plan, testCase, apiKey));
  }
  return outcomes;
}

function dumpPathFor(provider: ProviderName): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(DUMP_ROOT, `${stamp}-${provider}.json`);
}

function writeDump(plan: ProviderPlan, outcomes: readonly ProbeOutcome[]): string {
  mkdirSync(DUMP_ROOT, { recursive: true });
  const path = dumpPathFor(plan.name);
  const payload = {
    eval: 'provider-empty-content-contract',
    provider: plan,
    generatedAt: new Date().toISOString(),
    gateEnv: GATE_ENV,
    providersEnv: PROVIDERS_ENV,
    cases: CASES.map((testCase) => ({
      id: testCase.id,
      origin: testCase.origin,
      mustAcceptKodaXPath: testCase.mustAcceptKodaXPath,
    })),
    outcomes,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

function summarizeOutcome(outcome: ProbeOutcome): string {
  if (outcome.status === 'accepted') {
    return `${outcome.caseId}/${outcome.path}: accepted`;
  }
  if (outcome.status === 'skipped') {
    return `${outcome.caseId}/${outcome.path}: skipped (${outcome.skipReason ?? 'no reason'})`;
  }
  return `${outcome.caseId}/${outcome.path}: rejected ${outcome.error?.status ?? ''} ${outcome.error?.message ?? ''}`.trim();
}

describe('Eval: provider empty-content contract', () => {
  if (!isLiveOptIn) {
    it(`skips: set ${GATE_ENV}=1 to run live provider empty-content eval`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  const plans = selectedPlans();

  for (const plan of plans) {
    const hasKey = typeof process.env[plan.apiKeyEnv] === 'string'
      && process.env[plan.apiKeyEnv]!.length > 0;
    if (!hasKey) {
      it.skip(`${plan.name}: missing ${plan.apiKeyEnv}`, () => {});
      continue;
    }

    it(
      `${plan.name}: KodaX path accepts required empty-content cases; raw path records upstream behavior`,
      { timeout: CASES.length * REQUEST_TIMEOUT_MS * 2 + 20_000 },
      async () => {
        const outcomes = await runProviderMatrix(plan);
        const dumpPath = writeDump(plan, outcomes);
        process.stdout.write(`[provider-empty-content] ${plan.name} dump: ${dumpPath}\n`);

        const requiredCaseIds = new Set(
          CASES
            .filter((testCase) => testCase.mustAcceptKodaXPath)
            .map((testCase) => testCase.id),
        );
        const kodaxFailures = outcomes.filter((outcome) =>
          outcome.path === 'kodax_path'
          && requiredCaseIds.has(outcome.caseId)
          && outcome.status !== 'accepted');

        expect(
          kodaxFailures.map(summarizeOutcome),
          `KodaX provider path rejected required empty-content cases. Dump: ${dumpPath}`,
        ).toEqual([]);
      },
    );
  }
});
