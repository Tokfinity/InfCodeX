import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { render as renderOwnedTui } from './tui.js';
import {
  SessionPicker,
  buildSessionPickerPage,
  filterSessionPickerItems,
  runSessionPicker,
  type SessionPickerItem,
} from './SessionPicker.js';

const sessions: SessionPickerItem[] = [
  {
    id: 'session-alpha-12345678',
    title: 'Review runtime persistence',
    msgCount: 8,
    surface: 'repl',
    createdAt: '2026-07-11T03:00:00.000Z',
  },
  {
    id: 'session-beta-12345678',
    title: 'Fix ACP storage isolation',
    msgCount: 4,
    surface: 'acp',
    createdAt: '2026-07-11T02:00:00.000Z',
  },
  {
    id: 'session-gamma-12345678',
    title: 'Document SDK pagination',
    msgCount: 6,
    surface: 'cli',
    createdAt: '2026-07-11T01:00:00.000Z',
  },
];

class MockInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }
}

class MockOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  write = vi.fn(() => true);
}

describe('SessionPicker', () => {
  it('searches incrementally across title, id, and surface using all query tokens', () => {
    expect(filterSessionPickerItems(sessions, 'storage acp').map((session) => session.id))
      .toEqual(['session-beta-12345678']);
    expect(filterSessionPickerItems(sessions, 'gamma').map((session) => session.id))
      .toEqual(['session-gamma-12345678']);
  });

  it('keeps the selected row visible while paging', () => {
    expect(buildSessionPickerPage(sessions, 2, 2)).toMatchObject({
      pageStart: 2,
      pageIndex: 1,
      pageCount: 2,
      selectedIndex: 2,
      items: [sessions[2]],
    });
  });

  it('renders search, navigation, paging, and completion hints', () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        pageSize={2}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume a session');
    expect(frame).toContain('Search:');
    expect(frame).toContain('PgUp/PgDn');
    expect(frame).toContain('Tab complete');
    expect(frame).toContain('Page 1/2');
    expect(frame).toContain('Selected ID: session-alpha-12345678');
  });

  it('selects and exits through the owned TUI input lifecycle', async () => {
    const stdin = new MockInput();
    const stdout = new MockOutput();
    const stderr = new MockOutput();
    const onSelect = vi.fn();
    const instance = renderOwnedTui(
      <SessionPicker
        sessions={sessions}
        onSelect={onSelect}
        onCancel={vi.fn()}
        pageSize={2}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );

    try {
      stdin.emit('data', Buffer.from('\r'));
      expect(onSelect).toHaveBeenCalledWith(sessions[0]);
      await instance.waitUntilExit();
      expect(stdin.isRaw).toBe(false);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('cancels and exits on Ctrl+C through the owned TUI input lifecycle', async () => {
    const stdin = new MockInput();
    const stdout = new MockOutput();
    const stderr = new MockOutput();
    const onCancel = vi.fn();
    const instance = renderOwnedTui(
      <SessionPicker
        sessions={sessions}
        onSelect={vi.fn()}
        onCancel={onCancel}
        pageSize={2}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      },
    );

    try {
      stdin.emit('data', Buffer.from('\x03'));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await instance.waitUntilExit();
      expect(stdin.isRaw).toBe(false);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('rejects the searchable picker when stdin/stdout are not interactive', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await expect(runSessionPicker(sessions)).rejects.toThrow(
        'requires an interactive terminal',
      );
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });
});
