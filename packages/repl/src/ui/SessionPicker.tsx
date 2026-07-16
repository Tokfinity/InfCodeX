import React, { useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput } from './tui.js';

export interface SessionPickerItem {
  readonly id: string;
  readonly title: string;
  readonly msgCount: number;
  readonly createdAt?: string;
  readonly surface?: string;
}

export interface SessionPickerPage {
  readonly items: readonly SessionPickerItem[];
  readonly selectedIndex: number;
  readonly pageStart: number;
  readonly pageIndex: number;
  readonly pageCount: number;
}

export function filterSessionPickerItems(
  sessions: readonly SessionPickerItem[],
  query: string,
): SessionPickerItem[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...sessions];
  return sessions.filter((session) => {
    const searchable = [
      session.title,
      session.id,
      session.surface ?? '',
      session.createdAt ?? '',
      String(session.msgCount),
    ].join(' ').toLocaleLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}

export function buildSessionPickerPage(
  sessions: readonly SessionPickerItem[],
  selectedIndex: number,
  pageSize: number,
): SessionPickerPage {
  const safePageSize = Math.max(1, pageSize);
  const safeSelected = sessions.length === 0
    ? 0
    : Math.max(0, Math.min(selectedIndex, sessions.length - 1));
  const pageStart = Math.floor(safeSelected / safePageSize) * safePageSize;
  return {
    items: sessions.slice(pageStart, pageStart + safePageSize),
    selectedIndex: safeSelected,
    pageStart,
    pageIndex: Math.floor(pageStart / safePageSize),
    pageCount: Math.max(1, Math.ceil(sessions.length / safePageSize)),
  };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return 'unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 16).replace('T', ' ');
}

export function SessionPicker({
  sessions,
  onSelect,
  onCancel,
  pageSize = 8,
}: {
  readonly sessions: readonly SessionPickerItem[];
  readonly onSelect: (session: SessionPickerItem) => void;
  readonly onCancel: () => void;
  readonly pageSize?: number;
}): React.ReactElement {
  const { exit } = useApp();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filtered = useMemo(() => filterSessionPickerItems(sessions, query), [sessions, query]);
  const page = buildSessionPickerPage(filtered, selectedIndex, pageSize);
  const selectedSession = filtered[page.selectedIndex];

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      exit();
      return;
    }
    if (key.return) {
      const selected = filtered[page.selectedIndex];
      if (selected) {
        onSelect(selected);
        exit();
      }
      return;
    }
    if (key.upArrow) setSelectedIndex((current) => Math.max(0, current - 1));
    else if (key.downArrow) setSelectedIndex((current) => Math.min(Math.max(0, filtered.length - 1), current + 1));
    else if (key.pageUp) setSelectedIndex((current) => Math.max(0, current - pageSize));
    else if (key.pageDown) setSelectedIndex((current) => Math.min(Math.max(0, filtered.length - 1), current + pageSize));
    else if (key.home) setSelectedIndex(0);
    else if (key.end) setSelectedIndex(Math.max(0, filtered.length - 1));
    else if (key.tab) {
      const selected = filtered[page.selectedIndex];
      if (selected) {
        setQuery(selected.title);
        setSelectedIndex(0);
      }
    } else if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setSelectedIndex(0);
    } else if (input && !key.ctrl && !key.meta && !key.super) {
      setQuery((current) => current + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Resume a session</Text>
      <Text>Search: <Text color="yellow">{query || 'type to filter'}</Text></Text>
      <Text dimColor>↑/↓ select · PgUp/PgDn page · Tab complete · Enter resume · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {page.items.length === 0 ? <Text color="yellow">No matching sessions.</Text> : null}
        {page.items.map((session, offset) => {
          const absoluteIndex = page.pageStart + offset;
          const selected = absoluteIndex === page.selectedIndex;
          const title = session.title.trim() || 'Untitled session';
          const surface = session.surface ? ` · ${session.surface}` : '';
          return (
            <Text key={session.id} color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '❯' : ' '} {title} · {session.msgCount} msgs{surface} · {formatTimestamp(session.createdAt)} · {session.id.slice(0, 8)}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>
        {filtered.length} matches · Page {page.pageIndex + 1}/{page.pageCount}
      </Text>
      <Text dimColor>Selected ID: {selectedSession?.id ?? 'none'}</Text>
    </Box>
  );
}

export async function runSessionPicker(
  sessions: readonly SessionPickerItem[],
): Promise<SessionPickerItem | undefined> {
  let selected: SessionPickerItem | undefined;
  const pageSize = Math.max(4, Math.min(12, (process.stdout.rows ?? 24) - 8));
  const instance = render(
    <SessionPicker
      sessions={sessions}
      pageSize={pageSize}
      onSelect={(session) => { selected = session; }}
      onCancel={() => undefined}
    />,
    { exitOnCtrlC: false, patchConsole: false },
  );
  await instance.waitUntilExit();
  instance.cleanup();
  return selected;
}
