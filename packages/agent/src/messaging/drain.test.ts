import { beforeEach, describe, expect, it } from 'vitest';

import { maybeDrainMidTurn, midTurnDrainPriority } from './drain.js';
import { _resetMessageQueueForTests, getMessageQueue } from './queue.js';

describe('mid-turn message drain', () => {
  beforeEach(() => _resetMessageQueueForTests());

  it('keeps background Actor events for the idle-yield boundary', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'background', mode: 'task-notification', content: 'done' });

    expect(maybeDrainMidTurn({ lastTurnToolNames: [] })).toEqual([]);
    expect(queue.size()).toBe(1);
  });

  it('drains user prompts without crossing Agent scopes', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'root' });
    queue.enqueue({ priority: 'user', mode: 'prompt', agentId: '/root/a', content: 'child' });

    expect(maybeDrainMidTurn({ lastTurnToolNames: [] }).map((message) => message.content))
      .toEqual(['root']);
    expect(queue.size()).toBe(1);
  });

  it('uses user priority for every current tool', () => {
    expect(midTurnDrainPriority(['spawn_agent', 'wait_agent'])).toBe('user');
  });
});
