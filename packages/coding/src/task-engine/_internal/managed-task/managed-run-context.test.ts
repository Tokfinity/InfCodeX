import { describe, expect, it } from 'vitest';

import {
  createManagedRunContextMessage,
  createManagedRuntimeContextMessage,
  installCanonicalManagedRunContext,
} from './managed-run-context.js';
import { resolveRoleRuntimeStateFingerprint } from './role-prompts.js';

describe('managed run context layout', () => {
  it('bounds runtime-state deltas', () => {
    const message = createManagedRuntimeContextMessage('x'.repeat(10_000));

    expect(String(message.content).length).toBeLessThan(4_100);
    expect(message.content).toContain('[Runtime state delta truncated]');
    expect(message.content).toContain('=== End Managed Run Context ===');
  });

  it('hard-bounds the full initial context while preserving its closing boundary', () => {
    const message = createManagedRunContextMessage('x'.repeat(40_000));

    expect(String(message.content).length).toBeLessThanOrEqual(32_000);
    expect(message.content).toContain('[Managed run context truncated]');
    expect(message.content).toContain('=== End Managed Run Context ===');
  });

  it('ignores relative-age rendering when the Team snapshot is unchanged', () => {
    const first = resolveRoleRuntimeStateFingerprint({
      originalTask: 'task',
      teamModeSection: 'peer started 1s ago',
      teamModeFingerprint: 'semantic-peer-state',
    });
    const later = resolveRoleRuntimeStateFingerprint({
      originalTask: 'task',
      teamModeSection: 'peer started 2s ago',
      teamModeFingerprint: 'semantic-peer-state',
    });

    expect(later).toBe(first);
  });

  it('keeps the latest real user instruction after canonical context', () => {
    const canonical = {
      role: 'user' as const,
      content: 'canonical context',
      _synthetic: true,
      _source: 'managed-run-context',
    };
    const messages = installCanonicalManagedRunContext([
      { role: 'user', content: 'summary', _synthetic: true, _source: 'compaction-checkpoint' },
      { role: 'user', content: 'latest correction' },
    ], canonical);

    expect(messages.at(-1)?.content).toBe('latest correction');
    expect(messages.at(-2)).toEqual(canonical);
  });
});
