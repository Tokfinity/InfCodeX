import { beforeEach, describe, expect, it, vi } from 'vitest';
import clipboard from 'clipboardy';
import { copyCommand } from './copy-command.js';

vi.mock('clipboardy', () => ({
  default: {
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('copyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies the last assistant message to the clipboard', async () => {
    const context = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'first answer' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'latest answer' },
            { type: 'tool_result', text: 'ignored' },
          ],
        },
      ],
    };

    await copyCommand.handler(
      [],
      context as never,
      {} as never,
      {} as never
    );

    expect(clipboard.write).toHaveBeenCalledWith('latest answer');
  });

  it('does nothing when there is no assistant message', async () => {
    const context = {
      messages: [{ role: 'user', content: 'hello' }],
    };

    await copyCommand.handler(
      [],
      context as never,
      {} as never,
      {} as never
    );

    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it('logs a friendly error when clipboard write fails', async () => {
    vi.mocked(clipboard.write).mockRejectedValueOnce(new Error('permission denied'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = {
      messages: [{ role: 'assistant', content: 'hello' }],
    };

    await copyCommand.handler(
      [],
      context as never,
      {} as never,
      {} as never
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to copy to clipboard: permission denied'));
  });
});
