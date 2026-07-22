import { describe, expect, it, vi } from 'vitest';
import { applySessionCompaction, createSessionLineage } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  activateSessionHistoryTools,
  canActivateSessionHistoryTools,
  toolSessionHistoryRead,
  toolSessionHistorySearch,
} from './session-history.js';

function context(): KodaXToolExecutionContext {
  const lineage = applySessionCompaction(
    createSessionLineage([
      { role: 'system', content: 'private host instruction SYS-991' },
      { role: 'user', content: 'remember exact ticket USER-882' },
      { role: 'assistant', content: 'ticket USER-882 was resolved by patch seven' },
    ]),
    [{ role: 'user', content: 'active tail' }],
    { summary: 'ticket resolved' },
  );
  return { backups: new Map(), loadSessionHistory: vi.fn().mockResolvedValue(lineage) };
}

describe('session history tools', () => {
  it('activates the pair atomically and removes it from unsupported contexts', () => {
    expect(activateSessionHistoryTools(['read'], true)).toEqual([
      'read', 'session_history_search', 'session_history_read',
    ]);
    expect(activateSessionHistoryTools(['read', 'session_history_search'], false)).toEqual(['read']);
    const storage = {
      save: vi.fn(),
      load: vi.fn(),
      loadFullLineage: vi.fn(),
    };
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      storage,
    })).toBe(true);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      currentAgentId: 'child-1',
      storage,
    })).toBe(false);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search'],
      storage,
    })).toBe(false);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      storage: { save: vi.fn(), load: vi.fn() },
    })).toBe(false);
  });

  it('searches and reads cited exact evidence while hiding system messages', async () => {
    const ctx = context();
    const search = JSON.parse(await toolSessionHistorySearch({ query: 'USER-882' }, ctx));
    const userHit = search.hits.find((hit: { role?: string }) => hit.role === 'user');
    expect(userHit).toMatchObject({ role: 'user', active: false });
    const read = JSON.parse(await toolSessionHistoryRead({
      entry_id: userHit.entryId,
      revision: search.revision,
    }, ctx));
    expect(read).toMatchObject({ status: 'ok' });
    expect(read.content).toContain('USER-882');

    const system = JSON.parse(await toolSessionHistorySearch({ query: 'SYS-991' }, ctx));
    expect(system.hits).toEqual([]);
  });
});
