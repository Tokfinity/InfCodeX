import { describe, expect, it } from 'vitest';

import { derivePromptCacheAffinityKey } from './prompt-cache-affinity.js';

describe('provider prompt-cache affinity identity', () => {
  it('is stable for a resumed logical context and opaque on the wire', () => {
    const scope = {
      logicalSessionId: 'session-user-shaped',
      agentId: '/root/reviewer',
    };
    const first = derivePromptCacheAffinityKey(scope);
    const resumed = derivePromptCacheAffinityKey(scope);

    expect(first).toBe(resumed);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('session-user-shaped');
    expect(first).not.toContain('reviewer');
  });

  it('isolates root, children, siblings, and Sessions', () => {
    const values = [
      derivePromptCacheAffinityKey({ logicalSessionId: 'session-a' }),
      derivePromptCacheAffinityKey({
        logicalSessionId: 'session-a',
        agentId: '/root/child-a',
      }),
      derivePromptCacheAffinityKey({
        logicalSessionId: 'session-a',
        agentId: '/root/child-b',
      }),
      derivePromptCacheAffinityKey({ logicalSessionId: 'session-b' }),
    ];

    expect(new Set(values).size).toBe(values.length);
  });

  it('cannot collide a user-shaped root Session with a child identity', () => {
    const childContextId = 's/agent/%2Froot%2Freviewer';
    const adversarialRoot = derivePromptCacheAffinityKey({
      logicalSessionId: childContextId,
    });
    const child = derivePromptCacheAffinityKey({
      logicalSessionId: 's',
      agentId: '/root/reviewer',
    });

    expect(adversarialRoot).not.toBe(child);
  });

  it('omits affinity when no stable logical context exists', () => {
    expect(derivePromptCacheAffinityKey({})).toBeUndefined();
    expect(derivePromptCacheAffinityKey({ logicalSessionId: '' })).toBeUndefined();
  });
});
