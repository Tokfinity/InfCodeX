import { describe, expect, it, vi } from 'vitest';
import { CodexCLIExecutor } from './codex-parser.js';
import type { CLIEvent, CLIExecutionOptions } from './types.js';

class ExposedCodexCLIExecutor extends CodexCLIExecutor {
  buildArgsForTest(options: CLIExecutionOptions): string[] {
    return this.buildArgs(options);
  }

  parseLineForTest(line: string): CLIEvent | null {
    return this.parseLine(line);
  }
}

describe('CodexCLIExecutor', () => {
  it('builds fresh and resume argument lists correctly', () => {
    const executor = new ExposedCodexCLIExecutor({ model: 'gpt-5.4' });

    expect(executor.buildArgsForTest({ prompt: 'ship it' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      'ship it',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'continue', sessionId: 'thread-1' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      'continue',
      '--json',
      '--full-auto',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'ship it', model: 'gpt-5.4' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '-m',
      'gpt-5.4',
      'ship it',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'continue', sessionId: 'thread-1', model: 'gpt-5.4' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      '-m',
      'gpt-5.4',
      'continue',
      '--json',
      '--full-auto',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'think harder', reasoningEffort: 'high' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '--config',
      'model_reasoning_effort="high"',
      'think harder',
    ]);

    expect(executor.buildArgsForTest({
      prompt: 'resume hard',
      sessionId: 'thread-1',
      reasoningEffort: 'xhigh',
    })).toEqual([
      'exec',
      'resume',
      'thread-1',
      '--config',
      'model_reasoning_effort="xhigh"',
      'resume hard',
      '--json',
      '--full-auto',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'disable thinking', reasoningEffort: 'none' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '--config',
      'model_reasoning_effort="none"',
      'disable thinking',
    ]);
  });

  it('parses Codex thread, message, tool, completion, and failure events', () => {
    const executor = new ExposedCodexCLIExecutor();
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    expect(
      executor.parseLineForTest('{"type":"thread.started","thread_id":"thread-1"}'),
    ).toEqual({
      type: 'session_start',
      timestamp: 1234,
      sessionId: 'thread-1',
      model: 'gpt-5.4',
      raw: { type: 'thread.started', thread_id: 'thread-1' },
    });

    expect(
      executor.parseLineForTest('{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"hello"}}'),
    ).toEqual({
      type: 'message',
      timestamp: 1234,
      role: 'assistant',
      content: 'hello',
      raw: {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'hello' },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"dir"}}'),
    ).toEqual({
      type: 'tool_use',
      timestamp: 1234,
      toolId: 'cmd-1',
      toolName: 'Bash',
      parameters: { command: 'dir' },
      raw: {
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', command: 'dir' },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":3,"output_tokens":4}}'),
    ).toEqual({
      type: 'complete',
      timestamp: 1234,
      status: 'success',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedReadTokens: 2,
        cachedWriteTokens: 3,
      },
      raw: {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          cache_write_input_tokens: 3,
          output_tokens: 4,
        },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}'),
    ).not.toHaveProperty('usage.cachedReadTokens');

    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":4}}'),
    ).toMatchObject({
      usage: { cachedReadTokens: 0, cachedWriteTokens: 0 },
    });

    expect(
      executor.parseLineForTest('{"type":"turn.failed","message":"boom"}'),
    ).toEqual({
      type: 'error',
      timestamp: 1234,
      errorType: 'turn.failed',
      message: 'boom',
      raw: { type: 'turn.failed', message: 'boom' },
    });
  });

  it('omits malformed usage and ignores invalid optional cache counters', () => {
    const executor = new ExposedCodexCLIExecutor();

    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10}}'),
    ).toMatchObject({ type: 'complete', usage: undefined });
    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4,"cached_input_tokens":-1,"cache_write_input_tokens":null}}'),
    ).not.toHaveProperty('usage.cachedReadTokens');
  });

  it('returns null for non-JSON and unsupported records', () => {
    const executor = new ExposedCodexCLIExecutor();

    expect(executor.parseLineForTest('not json')).toBeNull();
    expect(executor.parseLineForTest('{"type":"unknown"}')).toBeNull();
    expect(executor.parseLineForTest('{')).toBeNull();
  });
});
