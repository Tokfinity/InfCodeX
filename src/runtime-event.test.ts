import { describe, expect, it } from 'vitest';

import { parseRuntimeEvent } from './runtime-event.js';

function event(type: string, payload: unknown): Record<string, unknown> {
  return {
    id: 'evt-1',
    seq: 1,
    time: '2026-07-14T00:00:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    type,
    payload,
  };
}

describe('parseRuntimeEvent', () => {
  it('accepts both explicit and provider-backed session.loaded payloads', () => {
    expect(parseRuntimeEvent(event('session.loaded', {
      id: 'session-1',
      title: 'Coder session',
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('session.loaded', {
      provider: 'anthropic',
      sessionId: 'provider-session-1',
    })).ok).toBe(true);
  });

  it('rejects malformed known payloads without throwing', () => {
    expect(parseRuntimeEvent(event('session.loaded', { sessionId: 'missing-provider' })))
      .toEqual({
        ok: false,
        error: 'session.loaded requires a RuntimeSession or provider session payload.',
      });
  });

  it('accepts the emitted session settings CAS payload', () => {
    expect(parseRuntimeEvent(event('session.settings.updated', {
      sessionId: 'session-1',
      revision: 2,
      settings: { agentMode: 'amaw', autoModeEngine: 'rules' },
      patch: { agentMode: 'amaw', autoModeEngine: 'rules' },
    })).ok).toBe(true);
  });

  it('accepts shared and embedded user input request payloads', () => {
    expect(parseRuntimeEvent(event('user_input.requested', {
      id: 'request-1',
      revision: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      kind: 'askUser',
      options: { question: 'Continue?' },
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:05:00.000Z',
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('user_input.requested', {
      requestId: 'request-2',
      kind: 'askUserMulti',
      options: { questions: [] },
    })).ok).toBe(true);
  });
});
