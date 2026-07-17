import { describe, expect, it, vi } from 'vitest';

import { MessageQueue } from '../messaging/queue.js';
import {
  composeIdleYieldUserMessage,
  waitForWakeEvent,
} from './idle-yield.js';

describe('Actor-aware idle yield', () => {
  it('wakes from an Actor completion projected into the scoped message queue', async () => {
    const messageQueue = new MessageQueue();
    const waiting = waitForWakeEvent({
      messageQueue,
      agentId: '/root',
      pollIntervalMs: 2,
    });
    messageQueue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      agentId: '/root',
      content: '<agent-completed path="/root/review">done</agent-completed>',
    });

    const wake = await waiting;

    expect(wake).toMatchObject({ kind: 'messages-arrived' });
    const messages = await composeIdleYieldUserMessage(wake, () => []);
    expect(messages).toMatchObject([{
      role: 'user',
      _synthetic: true,
      _source: 'agent-completed',
      content: '<agent-completed path="/root/review">done</agent-completed>',
    }]);
  });

  it('stops waiting promptly when the session aborts', async () => {
    const abort = new AbortController();
    const messageQueue = new MessageQueue();
    const waiting = waitForWakeEvent({ messageQueue, agentId: undefined, abortSignal: abort.signal });

    abort.abort('closed');

    await expect(waiting).resolves.toEqual({ kind: 'aborted' });
  });

  it('reports user prompts drained during a wait as real transcript messages', async () => {
    const onUserPrompts = vi.fn();
    const messages = await composeIdleYieldUserMessage({
      kind: 'messages-arrived',
      messages: [{
        id: 'msg-1',
        priority: 'user',
        mode: 'prompt',
        content: 'change direction',
        agentId: '/root',
        enqueuedAt: 1,
      }],
    }, () => [], undefined, onUserPrompts);

    expect(messages).toMatchObject([{ role: 'user', content: 'change direction' }]);
    expect(onUserPrompts).toHaveBeenCalledWith(['change direction']);
  });
});
