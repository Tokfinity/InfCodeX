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
      settings: { agentMode: 'ama', autoModeEngine: 'rules' },
      patch: { agentMode: 'ama', autoModeEngine: 'rules' },
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

  it('accepts queued and ordered-batch interrupt input events', () => {
    expect(parseRuntimeEvent(event('run.input.queued', {
      input: {
        inputId: 'input-1',
        afterRunId: 'run-1',
        delivery: 'interrupt',
        state: 'queued',
        contentPreview: 'first',
        queuedAt: '2026-07-14T00:00:01.000Z',
      },
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [
        {
          inputId: 'input-1',
          afterRunId: 'run-1',
          input: { type: 'text', text: 'first' },
          queuedAt: '2026-07-14T00:00:01.000Z',
          deliveredAt: '2026-07-14T00:00:03.000Z',
        },
        {
          inputId: 'input-2',
          afterRunId: 'run-1',
          input: { type: 'text', text: 'second' },
          queuedAt: '2026-07-14T00:00:02.000Z',
          deliveredAt: '2026-07-14T00:00:03.000Z',
        },
      ],
    })).ok).toBe(true);
  });

  it('rejects a malformed interrupt delivery batch', () => {
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [{ inputId: 'input-1', input: { type: 'text' } }],
    }))).toEqual({
      ok: false,
      error: 'run.input.delivered requires an ordered interrupt input batch.',
    });
  });

  it('accepts only complete canonical compaction facts', () => {
    const payload = {
      contextId: 'session-1',
      contextKind: 'root',
      contextRevision: 3,
      beforeRevision: 2,
      afterRevision: 3,
      source: 'automatic_threshold',
      tokensBefore: 322_973,
      tokensAfter: 92_000,
      committed: true,
      elapsedMs: 250,
    };
    expect(parseRuntimeEvent(event('context.compaction.finished', payload)).ok).toBe(true);
    expect(parseRuntimeEvent(event('context.compaction.finished', {
      ...payload,
      tokensAfter: undefined,
    }))).toEqual({
      ok: false,
      error: 'context.compaction.finished requires a canonical compaction payload.',
    });
  });
});
