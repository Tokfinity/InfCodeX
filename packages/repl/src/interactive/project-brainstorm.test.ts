import { describe, expect, it } from 'vitest';
import {
  appendBrainstormExchange,
  buildFallbackBrainstormOpening,
  buildFallbackBrainstormReply,
  completeBrainstormSession,
  createBrainstormSession,
  formatBrainstormTranscript,
} from './project-brainstorm.js';

describe('project-brainstorm', () => {
  it('creates a normalized active session', () => {
    const session = createBrainstormSession(
      '  Need a permission system  ',
      'Let us explore the requirements first.',
      '2026-03-17T10:00:00.000Z',
    );

    expect(session.id).toBe('brainstorm_2026-03-17T10-00-00-000Z');
    expect(session.topic).toBe('Need a permission system');
    expect(session.status).toBe('active');
    expect(session.turns).toEqual([
      {
        role: 'user',
        text: 'Need a permission system',
        createdAt: '2026-03-17T10:00:00.000Z',
      },
      {
        role: 'assistant',
        text: 'Let us explore the requirements first.',
        createdAt: '2026-03-17T10:00:00.000Z',
      },
    ]);
  });

  it('appends a follow-up exchange to an active session', () => {
    const session = createBrainstormSession(
      'Need audit logging',
      'What compliance expectations do you have?',
      '2026-03-17T10:00:00.000Z',
    );

    const updated = appendBrainstormExchange(
      session,
      ' SOC 2 and customer-facing exports ',
      'Then we should model immutable audit events and export workflows.',
      '2026-03-17T11:00:00.000Z',
    );

    expect(updated.updatedAt).toBe('2026-03-17T11:00:00.000Z');
    expect(updated.turns).toHaveLength(4);
    expect(updated.turns[2]).toEqual({
      role: 'user',
      text: 'SOC 2 and customer-facing exports',
      createdAt: '2026-03-17T11:00:00.000Z',
    });
  });

  it('prevents invalid or completed-session writes', () => {
    expect(() =>
      createBrainstormSession(' ', 'Let us explore this'),
    ).toThrow('topic cannot be empty');

    const session = completeBrainstormSession(
      createBrainstormSession('API versioning', 'What compatibility window matters most?'),
      '2026-03-17T12:00:00.000Z',
    );

    expect(() =>
      appendBrainstormExchange(session, 'Need 2 years', 'Then we need a deprecation policy.'),
    ).toThrow('cannot append to a completed brainstorm session');
  });

  it('formats a readable markdown transcript', () => {
    const session = appendBrainstormExchange(
      createBrainstormSession(
        'Feature flag rollout',
        'Which environments need progressive delivery?',
        '2026-03-17T10:00:00.000Z',
      ),
      'Staging first, then 10% of production.',
      'We should capture rollout stages and rollback triggers.',
      '2026-03-17T10:05:00.000Z',
    );

    expect(formatBrainstormTranscript(session)).toBe(`# Brainstorm: Feature flag rollout

## User
Feature flag rollout

## Assistant
Which environments need progressive delivery?

## User
Staging first, then 10% of production.

## Assistant
We should capture rollout stages and rollback triggers.`);
  });

  it('builds a useful fallback opening when no model is available', () => {
    const opening = buildFallbackBrainstormOpening('  API quotas  ');

    expect(opening).toContain('Let us pressure-test "API quotas"');
    expect(opening).toContain('Key questions to answer first:');
    expect(opening).toContain('Promising directions:');
  });

  it('builds a useful fallback follow-up reply when no model is available', () => {
    const reply = buildFallbackBrainstormReply('Need admin audit trails');

    expect(reply).toContain('That adds useful signal');
    expect(reply).toContain('Next angles to pressure-test:');
    expect(reply).toContain('Suggested next move:');
  });
});
