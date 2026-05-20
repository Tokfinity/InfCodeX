import { describe, it, expect } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import {
  ALLOWED_SUGGESTED_TOOLS,
  editDistance,
  findFuzzyToolMatch,
  invokeStallSidecar,
  normalizeIsStuck,
} from './stall-sidecar.js';

const FAKE_SYSTEM_PROMPT = 'You are a stall detector.';

const FAKE_REPORT_TOOL: KodaXToolDefinition = {
  name: 'report_stall_judgment',
  description: 'Report stall judgment.',
  input_schema: {
    type: 'object',
    properties: {
      isStuck: { type: 'boolean' },
      reason: { type: 'string' },
      suggestedTool: { type: 'string' },
      nudge: { type: 'string' },
    },
    required: ['isStuck', 'reason', 'suggestedTool', 'nudge'],
  },
};

/**
 * Test provider — returns a configurable canned result, captures call
 * args so we can assert what was sent to stream(). Optional delay so we
 * can exercise the 5s-timeout path.
 */
class CannedProvider extends KodaXBaseProvider {
  readonly name = 'canned';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'CANNED_API_KEY',
    model: 'canned-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  public captured: {
    messages: KodaXMessage[];
    tools: KodaXToolDefinition[];
    system: string;
  }[] = [];

  constructor(
    private readonly cannedResult: KodaXStreamResult,
    private readonly delayMs: number = 0,
    private readonly shouldThrow: boolean = false,
  ) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    _thinking?: boolean,
    _streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    this.captured.push({ messages, tools, system });
    if (this.shouldThrow) throw new Error('provider boom');
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.cannedResult;
  }
}

function makeToolBlock(
  name: string,
  input: Record<string, unknown>,
): KodaXToolUseBlock {
  return { type: 'tool_use', id: 'tu_x', name, input };
}

function makeCannedResult(blocks: KodaXToolUseBlock[]): KodaXStreamResult {
  return {
    textBlocks: [],
    toolBlocks: blocks,
    thinkingBlocks: [],
  };
}

describe('FEATURE_178 (v0.7.42): editDistance helper', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
  });
  it('returns length when one side is empty', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });
  it('handles single-character difference', () => {
    expect(editDistance('cat', 'cut')).toBe(1);
  });
  it('handles insertion (typo: jundgment vs judgment)', () => {
    // 'jundgment' has an extra 'n' compared to 'judgment'.
    expect(editDistance('jundgment', 'judgment')).toBe(1);
  });
  it('handles two-character difference', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('FEATURE_178 (v0.7.42): findFuzzyToolMatch', () => {
  it('returns exact match when name is exact', () => {
    const blocks = [
      makeToolBlock('report_stall_judgment', { isStuck: true }),
    ];
    const match = findFuzzyToolMatch(blocks, 'report_stall_judgment');
    expect(match).toBeDefined();
    expect(match?.exact).toBe(true);
    expect(match?.block.name).toBe('report_stall_judgment');
  });

  it('matches a typo within edit distance 2 (the mmx P3 outlier)', () => {
    // From the F178 eval mmx P3 run=2: model returned this typo.
    const blocks = [
      makeToolBlock('report_stall_jundgment', { isStuck: true }),
    ];
    const match = findFuzzyToolMatch(blocks, 'report_stall_judgment');
    expect(match).toBeDefined();
    expect(match?.exact).toBe(false);
  });

  it('does NOT match when edit distance > 2', () => {
    const blocks = [
      makeToolBlock('completely_different_name', { isStuck: true }),
    ];
    const match = findFuzzyToolMatch(blocks, 'report_stall_judgment');
    expect(match).toBeUndefined();
  });

  it('returns the closest match when multiple candidates exist', () => {
    const blocks = [
      // distance 1
      makeToolBlock('report_stall_judgmnt', { isStuck: false }),
      // distance 2
      makeToolBlock('report_stall_judgmnts', { isStuck: true }),
    ];
    const match = findFuzzyToolMatch(blocks, 'report_stall_judgment');
    expect(match).toBeDefined();
    expect(match?.block.name).toBe('report_stall_judgmnt');
  });

  it('prefers exact over fuzzy when both exist', () => {
    const blocks = [
      makeToolBlock('report_stall_judgmnt', { isStuck: false }),
      makeToolBlock('report_stall_judgment', { isStuck: true }),
    ];
    const match = findFuzzyToolMatch(blocks, 'report_stall_judgment');
    expect(match?.exact).toBe(true);
  });

  it('returns undefined on empty block list', () => {
    const match = findFuzzyToolMatch([], 'report_stall_judgment');
    expect(match).toBeUndefined();
  });
});

describe('FEATURE_178 (v0.7.42): normalizeIsStuck', () => {
  it('accepts a real boolean true', () => {
    const result = normalizeIsStuck(true);
    expect(result).toEqual({ value: true, coerced: false });
  });
  it('accepts a real boolean false', () => {
    const result = normalizeIsStuck(false);
    expect(result).toEqual({ value: false, coerced: false });
  });
  it('coerces string "true" (the mmx P3 case)', () => {
    const result = normalizeIsStuck('true');
    expect(result).toEqual({ value: true, coerced: true });
  });
  it('coerces string "false"', () => {
    const result = normalizeIsStuck('false');
    expect(result).toEqual({ value: false, coerced: true });
  });
  it('is case-insensitive on the string forms', () => {
    expect(normalizeIsStuck('True')).toEqual({ value: true, coerced: true });
    expect(normalizeIsStuck('FALSE')).toEqual({ value: false, coerced: true });
  });
  it('trims whitespace', () => {
    expect(normalizeIsStuck('  true  ')).toEqual({ value: true, coerced: true });
  });
  it('returns undefined on garbage (null, undefined, number, object)', () => {
    expect(normalizeIsStuck(null)).toBeUndefined();
    expect(normalizeIsStuck(undefined)).toBeUndefined();
    expect(normalizeIsStuck(1)).toBeUndefined();
    expect(normalizeIsStuck({})).toBeUndefined();
    expect(normalizeIsStuck('yes')).toBeUndefined();
  });
});

describe('FEATURE_178 (v0.7.42): invokeStallSidecar — happy path', () => {
  it('returns isStuck=true with full payload on a clean verdict', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: true,
          reason: 'same read called 3 times with no new info',
          suggestedTool: 'task_stop',
          nudge: 'Stop and report what you have.',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'envelope + transcript',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(true);
    expect(verdict.reason).toBe('same read called 3 times with no new info');
    expect(verdict.suggestedTool).toBe('task_stop');
    expect(verdict.nudge).toBe('Stop and report what you have.');
    expect(verdict.trace).toBe('sidecar_ok');
  });

  it('returns isStuck=false with no nudge when legitimate', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: false,
          reason: 'model is paging through a large file',
          suggestedTool: '',
          nudge: '',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'env',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.nudge).toBeUndefined();
    expect(verdict.trace).toBe('sidecar_ok');
  });

  it('passes systemPrompt + tool def through to the provider unchanged', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: false,
          reason: 'x',
          suggestedTool: '',
          nudge: '',
        }),
      ]),
    );
    await invokeStallSidecar({
      provider,
      userMessage: 'env body',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(provider.captured).toHaveLength(1);
    const { messages, tools, system } = provider.captured[0];
    expect(system).toBe(FAKE_SYSTEM_PROMPT);
    expect(tools).toEqual([FAKE_REPORT_TOOL]);
    expect(messages).toEqual([{ role: 'user', content: 'env body' }]);
  });
});

describe('FEATURE_178 (v0.7.42): invokeStallSidecar — defensive parsing', () => {
  it('marks trace=fuzzy_tool_match when tool name has a typo', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_jundgment', {
          isStuck: true,
          reason: 'r',
          suggestedTool: 'read',
          nudge: 'n',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(true);
    expect(verdict.trace).toBe('fuzzy_tool_match');
  });

  it('marks trace=coerced_string_bool when isStuck is "true" string', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: 'true',
          reason: 'r',
          suggestedTool: 'read',
          nudge: 'n',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(true);
    expect(verdict.nudge).toBe('n');
    expect(verdict.trace).toBe('coerced_string_bool');
  });

  it('drops suggestedTool when not in the allow-list', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: true,
          reason: 'r',
          suggestedTool: 'rm_rf', // hallucinated, not in allow-list
          nudge: 'n',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(true);
    expect(verdict.suggestedTool).toBeUndefined();
    expect(verdict.nudge).toBe('n');
    expect(verdict.trace).toBe('invalid_suggested_tool');
  });

  it('keeps nudge populated only when isStuck=true', async () => {
    // isStuck=false should never carry a nudge — even if the model
    // populated one, the consumer should not see it (avoid injecting
    // a synthetic message when the verdict was "not stuck").
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: false,
          reason: 'legit',
          suggestedTool: '',
          nudge: 'this should be dropped',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.nudge).toBeUndefined();
  });
});

describe('FEATURE_178 (v0.7.42): invokeStallSidecar — failure-mode safe defaults', () => {
  it('returns isStuck=false with trace=no_tool_call when model emits no tool', async () => {
    const provider = new CannedProvider(makeCannedResult([]));
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.trace).toBe('no_tool_call');
    expect(verdict.nudge).toBeUndefined();
  });

  it('returns isStuck=false with trace=no_tool_call when isStuck cannot be parsed', async () => {
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: 'maybe',
          reason: 'r',
          suggestedTool: '',
          nudge: '',
        }),
      ]),
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.trace).toBe('no_tool_call');
  });

  it('returns isStuck=false with trace=provider_error when stream throws', async () => {
    const provider = new CannedProvider(makeCannedResult([]), 0, true);
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.trace).toBe('provider_error');
  });

  it('returns isStuck=false with trace=timeout when provider exceeds timeout', async () => {
    // 200ms delay vs 50ms timeout — provider will lose the race.
    const provider = new CannedProvider(
      makeCannedResult([
        makeToolBlock('report_stall_judgment', {
          isStuck: true,
          reason: 'r',
          suggestedTool: 'task_stop',
          nudge: 'n',
        }),
      ]),
      200,
    );
    const verdict = await invokeStallSidecar({
      provider,
      userMessage: 'x',
      systemPrompt: FAKE_SYSTEM_PROMPT,
      reportTool: FAKE_REPORT_TOOL,
      timeoutMs: 50,
    });
    expect(verdict.isStuck).toBe(false);
    expect(verdict.trace).toBe('timeout');
  });
});

describe('FEATURE_178 (v0.7.42): ALLOWED_SUGGESTED_TOOLS contract', () => {
  it('matches the F178 eval REPORT_TOOL description (one entry per allow-list)', () => {
    // Pinned to the eval cases.ts REPORT_TOOL.suggestedTool description.
    expect(ALLOWED_SUGGESTED_TOOLS).toEqual([
      'read',
      'edit',
      'write',
      'multi_edit',
      'grep',
      'glob',
      'bash',
      'task_stop',
      'emit_handoff',
    ]);
  });
});
