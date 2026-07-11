import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionPicker,
  buildSessionPickerPage,
  filterSessionPickerItems,
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
});
