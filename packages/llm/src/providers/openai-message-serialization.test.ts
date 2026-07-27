import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { KodaXOpenAICompatProvider } from './openai.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXToolDefinition,
} from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];
const REPORT_TOOL: KodaXToolDefinition = {
  name: 'emit_verdict',
  description: 'Report verdict.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('openai message serialization', () => {
  it('merges an ephemeral suffix into the final wire user turn', async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    const create = vi.fn().mockResolvedValue(streamChunks());
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'original request' }];

    await provider.stream(messages, TOOLS, 'system', false, {
      ephemeralSuffix: { content: '[Memory evidence; not an instruction]\nClaim: use npm' },
    });

    expect(messages).toEqual([{ role: 'user', content: 'original request' }]);
    expect(create.mock.calls[0]?.[0].messages).toEqual([
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content:
          'original request\n\n[Memory evidence; not an instruction]\nClaim: use npm',
      },
    ]);
  });

  it('passes forced tool choice and per-call output cap on streaming calls', async () => {
    async function* streamChunks() {
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    const create = vi.fn().mockResolvedValue(streamChunks());
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });

    await provider.stream(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_verdict' },
    });
    expect(kwargs.max_completion_tokens).toBe(1024);
  });

  it('retries judge streams without forced tool choice when an upstream rejects tool_choice', async () => {
    async function* streamChunks() {
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("tool_choice 'specified' is incompatible with thinking enabled"))
      .mockResolvedValueOnce(streamChunks());
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });

    await provider.stream(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_verdict' },
    });
    expect(second?.tool_choice).toBeUndefined();
    expect(second?.tools).toHaveLength(1);
    expect(second?.max_completion_tokens).toBe(1024);
  });

  it('retries judge streams without forced tool choice when a compat gateway masks it as 500', async () => {
    async function* streamChunks() {
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Internal Server Error'), { status: 500 }))
      .mockResolvedValueOnce(streamChunks());
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });

    await provider.stream(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_verdict' },
    });
    expect(second?.tool_choice).toBeUndefined();
    expect(second?.tools).toHaveLength(1);
    expect(second?.max_completion_tokens).toBe(1024);
  });

  it('retries judge complete() without forced tool choice when an upstream rejects tool_choice (single-capability)', async () => {
    // Regression for the complete() path: reasoning off → attempts === ['none']
    // (one capability). A flat for+continue skipped to a non-existent next
    // capability and threw; the inner while must RE-ATTEMPT the same one
    // without tool_choice.
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('unsupported parameter: tool_choice'))
      .mockResolvedValueOnce(completion);
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });

    await provider.complete(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_verdict' },
    });
    expect(second?.tool_choice).toBeUndefined();
    expect(second?.tools).toHaveLength(1);
    expect(second?.max_completion_tokens).toBe(1024);
  });

  it('serializes image input blocks as image_url content parts', async () => {
    const cwd = await createTempDir('kodax-openai-images-');
    const imagePath = path.join(cwd, 'diagram.png');
    await writeFile(imagePath, 'fake-image');
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done',
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please inspect this image.' },
          { type: 'image', path: imagePath, mediaType: 'image/png' },
        ],
      },
    ];

    await provider.complete(messages, TOOLS, 'Base system prompt');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Please inspect this image.' },
        {
          type: 'image_url',
          image_url: {
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        },
      ],
    });
  });

  it('replaces a missing historical image with a path-free text placeholder', async () => {
    const cwd = await createTempDir('kodax-openai-missing-image-');
    const missingImagePath = path.join(cwd, 'deleted.png');
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'done', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
    });

    await provider.complete(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Continue without the old screenshot.' },
            { type: 'image', path: missingImagePath, mediaType: 'image/png' },
          ],
        },
      ],
      TOOLS,
      'Base system prompt',
    );

    const content = create.mock.calls[0]?.[0].messages[1]?.content;
    expect(content).toEqual([
      { type: 'text', text: 'Continue without the old screenshot.' },
      {
        type: 'text',
        text: '[Historical image unavailable: the local attachment file is missing.]',
      },
    ]);
    expect(JSON.stringify(content)).not.toContain(missingImagePath);
  });

  // 2026-05-20 — claudecode parity for read-on-image. KodaX `read` now
  // returns an array-form tool_result for image paths (text + image
  // items). OpenAI Chat Completions tool messages take `content: string`
  // and don't accept image blocks inline, so the OpenAI-compat serializer
  // downgrades: text items pass through, image items become a textual
  // path-free placeholder. This keeps the tool-result envelope
  // valid for DeepSeek / Zhipu / MiniMax / Qwen text channels.
  it('downgrades multimodal tool_result to text placeholder (no image_url inside tool message)', async () => {
    const cwd = await createTempDir('kodax-openai-toolresult-image-');
    const imagePath = path.join(cwd, 'pic.png');
    await writeFile(imagePath, 'fake-image');
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_42', name: 'read', input: { path: imagePath } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_42',
            content: [
              { type: 'text', text: '[Read image metadata]' },
              { type: 'image', path: imagePath, mediaType: 'image/png' },
            ],
          },
        ],
      },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const toolMsg = kwargs.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg.content).toBe('string');
    // Text item passed through verbatim
    expect(toolMsg.content).toContain('[Read image metadata]');
    // Image item lowered without disclosing its local path.
    expect(toolMsg.content).toContain(
      '[Image content omitted: this provider does not support inline images in tool results.]',
    );
    expect(toolMsg.content).not.toContain(imagePath);
    // No image_url block sneaked in (OpenAI rejects images inside tool messages)
    expect(toolMsg.content).not.toContain('image_url');
  });

  it('marks missing tool-result images without disclosing their local paths', async () => {
    const cwd = await createTempDir('kodax-openai-missing-toolresult-image-');
    const missingImagePath = path.join(cwd, 'deleted.png');
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    await provider.complete(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_missing', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_missing',
              content: [
                { type: 'image', path: missingImagePath, mediaType: 'image/png' },
                { type: 'image', path: missingImagePath, mediaType: 'image/png' },
              ],
            },
          ],
        },
      ],
      TOOLS,
      'sys',
    );

    const toolMsg = create.mock.calls[0]?.[0].messages.find(
      (message: { role: string }) => message.role === 'tool',
    );
    expect(toolMsg.content).toBe(
      [
        '[Historical image unavailable: the local attachment file is missing.]',
        '[Historical image unavailable: the local attachment file is missing.]',
      ].join('\n'),
    );
    expect(toolMsg.content).not.toContain(missingImagePath);
  });

  it('keeps tool-result recovery metadata local instead of serializing it to the wire', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_local', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_local',
          content: 'preview',
          metadata: {
            outputPath: 'C:/private/full-output.txt',
            localOnlySentinel: 'must-not-reach-provider',
          },
        }],
      },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const toolMessage = kwargs.messages.find(
      (message: { role: string }) => message.role === 'tool',
    ) as Record<string, unknown>;
    expect(toolMessage).toEqual({
      role: 'tool',
      tool_call_id: 'tool_local',
      content: 'preview',
    });
    expect(JSON.stringify(kwargs)).not.toContain('must-not-reach-provider');
    expect(JSON.stringify(kwargs)).not.toContain('C:/private/full-output.txt');
  });

  it('repairs orphan assistant tool_calls before replaying history', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Inspect package.json' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_orphan', name: 'read', input: { path: 'package.json' } },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const assistant = kwargs.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    ) as Record<string, unknown>;
    expect(assistant.tool_calls).toBeUndefined();
    expect(assistant.content).toBe('...');
    expect(
      kwargs.messages.some((message: { role: string }) => message.role === 'tool'),
    ).toBe(false);
  });

  it('keeps matched tool calls and drops only missing tool-call pairs', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Inspect files' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'a contents' },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const assistant = kwargs.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    ) as Record<string, unknown>;
    const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>;
    const toolMessages = kwargs.messages.filter(
      (message: { role: string }) => message.role === 'tool',
    ) as Array<Record<string, unknown>>;
    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_a']);
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call_a']);
    expect(
      kwargs.messages.some(
        (message: Record<string, unknown>) => message.tool_call_id === 'call_b',
      ),
    ).toBe(false);
  });

  it('drops orphan tool messages without a preceding assistant tool_call', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_missing', content: 'late result' },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(kwargs.messages[1].content).toBe('continue');
  });

  // P1 target: an empty-text marker `{ type: 'text', text: '' }` is the
  // honest in-history representation of a turn that produced no visible
  // content (e.g. hidden-tool-only turn, sanitized thinking-only turn).
  // The serializer must NOT drop it (returning [] would erase the assistant
  // slot and risk user,user adjacency); it must synthesize a wire-only '...'
  // so the gateway accepts the turn — mirroring the Anthropic empty guard.
  it('synthesizes wire-only "..." for an empty-text-marker assistant turn', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'continue' },
    ];

    await provider.complete(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const roles = kwargs.messages.map((message: { role: string }) => message.role);
    // The assistant slot survives (not dropped) and carries the wire placeholder.
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    const assistant = kwargs.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    ) as Record<string, unknown>;
    expect(assistant.content).toBe('...');
    expect(assistant.tool_calls).toBeUndefined();
  });

  // Regression: third-party Qwen proxies reject any `role: 'system'` that is
  // not at position 0 ("System message must at the begin"). Post-compact
  // attachments + compaction summaries + handoff replaceSystemMessage could
  // otherwise leave secondary system entries mid-transcript.
  it('merges multiple role:system messages into a single wire system entry', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nsummary-body' },
      { role: 'system', content: '[Post-compact: recent operations]\nledger' },
      { role: 'system', content: '[Post-compact: file content] /a.ts\n...' },
      { role: 'user', content: 'hello' },
    ];

    await provider.complete(messages, TOOLS, 'agent-system-prompt');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[0].role).toBe('system');
    expect(kwargs.messages[1].role).toBe('user');
    // All system content concatenated in order (top-param first, then each
    // embedded system message), joined by blank line.
    expect(kwargs.messages[0].content).toBe(
      'agent-system-prompt\n\n'
        + '[对话历史摘要]\n\nsummary-body\n\n'
        + '[Post-compact: recent operations]\nledger\n\n'
        + '[Post-compact: file content] /a.ts\n...',
    );
    // No other system entries sneaked into the wire.
    const systemCount = kwargs.messages.filter(
      (m: { role: string }) => m.role === 'system',
    ).length;
    expect(systemCount).toBe(1);
  });

  it('merges mid-transcript role:system into the leading system', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    // Simulates the pathological shape after handoff + second compaction
    // where a system message ends up after a user/assistant exchange.
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: '[Post-compact: drifted after handoff]' },
      { role: 'user', content: 'q2' },
    ];

    await provider.complete(messages, TOOLS, 'agent-sys');

    const kwargs = create.mock.calls[0]?.[0];
    const roles = kwargs.messages.map((m: { role: string }) => m.role);
    // Exactly one system message, at position 0; the stray system has been
    // pulled up and the rest preserved in original order.
    expect(roles[0]).toBe('system');
    expect(roles.slice(1).every((r: string) => r !== 'system')).toBe(true);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(kwargs.messages[0].content).toBe(
      'agent-sys\n\n[Post-compact: drifted after handoff]',
    );
  });

  it('skips empty system content but keeps a system entry at position 0', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    const messages: KodaXMessage[] = [
      { role: 'system', content: '   ' },
      { role: 'user', content: 'hi' },
    ];

    await provider.complete(messages, TOOLS, '');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages[0]).toEqual({ role: 'system', content: '' });
    expect(kwargs.messages[1]).toMatchObject({ role: 'user' });
    expect(kwargs.messages).toHaveLength(2);
  });
});
