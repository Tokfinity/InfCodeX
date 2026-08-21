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

  it('drains urgent Actor follow-ups without changing their synthetic mode', () => {
    const queue = getMessageQueue();
    queue.enqueue({
      priority: 'user',
      mode: 'agent-message',
      content: '<agent-message>updated objective</agent-message>',
    });

    expect(maybeDrainMidTurn({ lastTurnToolNames: [] })).toEqual([
      expect.objectContaining({ priority: 'user', mode: 'agent-message' }),
    ]);
  });

  it('leaves host-owned explicit invocations for the host command pipeline', () => {
    const queue = getMessageQueue();
    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      delivery: 'host',
      content: 'please use /hidden-skill args',
    });
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'ordinary follow-up' });

    expect(maybeDrainMidTurn({ lastTurnToolNames: [] }).map((message) => message.content))
      .toEqual([]);
    expect(queue.peek({ maxPriority: 'user' }).map((message) => message.content))
      .toEqual(['please use /hidden-skill args', 'ordinary follow-up']);
  });

  it('drains only user prompts that precede the first host-owned prompt', () => {
    const queue = getMessageQueue();
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'first runtime prompt' });
    queue.enqueue({
      priority: 'user',
      mode: 'prompt',
      delivery: 'host',
      content: '/hidden-skill args',
    });
    queue.enqueue({ priority: 'user', mode: 'prompt', content: 'later runtime prompt' });

    expect(maybeDrainMidTurn({ lastTurnToolNames: [] }).map((message) => message.content))
      .toEqual(['first runtime prompt']);
    expect(queue.peek({ maxPriority: 'user' }).map((message) => message.content))
      .toEqual(['/hidden-skill args', 'later runtime prompt']);
  });

  it('opens background mailbox delivery only after explicit wait_agent yield', () => {
    expect(midTurnDrainPriority(['spawn_agent'])).toBe('user');
    expect(midTurnDrainPriority(['spawn_agent', 'wait_agent'])).toBe('background');
  });
});
