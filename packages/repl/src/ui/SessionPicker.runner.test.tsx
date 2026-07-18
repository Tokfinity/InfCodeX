import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

const tuiMocks = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock('./tui.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tui.js')>(),
  render: tuiMocks.render,
}));

import { runSessionPicker, type SessionPickerItem } from './SessionPicker.js';

describe('runSessionPicker', () => {
  it('binds the searchable picker to the real process terminal streams', async () => {
    const session: SessionPickerItem = {
      id: 'session-one',
      title: 'First session',
      msgCount: 2,
    };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    let resolveExit: (() => void) | undefined;
    const waitUntilExit = vi.fn(() => new Promise<void>((resolve) => {
      resolveExit = resolve;
    }));
    const unmount = vi.fn();
    const cleanup = vi.fn();
    tuiMocks.render.mockReturnValue({ waitUntilExit, unmount, cleanup });

    try {
      const resultPromise = runSessionPicker([session]);
      const rendered = tuiMocks.render.mock.calls[0]?.[0] as React.ReactElement<{
        onSelect: (selected: SessionPickerItem) => void;
      }>;
      rendered.props.onSelect(session);
      resolveExit?.();

      await expect(resultPromise).resolves.toBe(session);
      expect(tuiMocks.render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
        }),
      );
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      tuiMocks.render.mockReset();
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });
});
