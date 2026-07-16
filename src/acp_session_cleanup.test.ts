import { describe, expect, it } from 'vitest';
import type { KodaXSessionData } from '@kodax-ai/agent';
import { isAcpPollutionSession } from './acp_session_cleanup.js';

function session(overrides: Partial<KodaXSessionData> = {}): KodaXSessionData {
  return {
    title: 'ACP Session',
    messages: [],
    gitRoot: 'C:/repo',
    scope: 'user',
    runtimeInfo: { surface: 'acp' },
    ...overrides,
  };
}

describe('ACP session cleanup', () => {
  it('matches only empty legacy ACP placeholders', () => {
    expect(isAcpPollutionSession(session())).toBe(true);
    expect(isAcpPollutionSession(session({ title: 'Real ACP task' }))).toBe(false);
    expect(isAcpPollutionSession(session({ messages: [{ role: 'user', content: 'hello' }] }))).toBe(false);
    expect(isAcpPollutionSession(session({ uiHistory: [{ type: 'assistant', text: 'hello' }] }))).toBe(false);
    expect(isAcpPollutionSession(session({ artifactLedger: [{
      id: 'artifact-1',
      kind: 'file_read',
      target: 'C:/repo/README.md',
      timestamp: '2026-07-11T00:00:00.000Z',
    }] }))).toBe(false);
    expect(isAcpPollutionSession(session({ runtimeInfo: { surface: 'repl' } }))).toBe(false);
    expect(isAcpPollutionSession(session({ scope: 'managed-task-worker' }))).toBe(false);
  });

  it('rejects sessions with lineage or extension records even when messages are empty', () => {
    expect(isAcpPollutionSession(session({
      lineage: {
        version: 2,
        activeEntryId: 'entry-1',
        entries: [{
          id: 'entry-1',
          parentId: null,
          timestamp: '2026-07-11T00:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: 'hello' },
        }],
      },
    }))).toBe(false);
    expect(isAcpPollutionSession(session({
      extensionRecords: [{
        id: 'record-1',
        extensionId: 'extension-1',
        type: 'test',
        ts: 1,
        data: {},
      }],
    }))).toBe(false);
    expect(isAcpPollutionSession(session({
      extensionState: { 'extension-1': { key: 'value' } },
    }))).toBe(false);
    expect(isAcpPollutionSession(session({
      errorMetadata: { consecutiveErrors: 1, lastError: 'retry later' },
    }))).toBe(false);
  });
});
