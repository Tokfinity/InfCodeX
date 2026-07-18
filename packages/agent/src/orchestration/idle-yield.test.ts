import { describe, expect, it, vi } from 'vitest';

import { MessageQueue } from '../messaging/queue.js';
import {
  composeIdleYieldUserMessage,
  waitForWakeEvent,
} from './idle-yield.js';

describe('Actor-aware idle yield', () => {
  it('drains a message that already exists before waiting', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const messageQueue = new MessageQueue();
    messageQueue.enqueue({
      priority: 'user',
      mode: 'prompt',
      agentId: '/root',
      content: 'already queued',
    });

    await expect(waitForWakeEvent({ messageQueue, agentId: '/root' }))
      .resolves.toMatchObject({
        kind: 'messages-arrived',
        messages: [expect.objectContaining({ content: 'already queued' })],
      });
    expect(intervalSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();
  });

  it('rechecks after subscribing so an enqueue in the registration gap is not lost', async () => {
    const messageQueue = new MessageQueue();
    const subscribe = messageQueue.subscribe;
    messageQueue.subscribe = (listener) => {
      messageQueue.enqueue({
        priority: 'user',
        mode: 'prompt',
        agentId: '/root',
        content: 'registration-gap input',
      });
      return subscribe(listener);
    };

    await expect(waitForWakeEvent({ messageQueue, agentId: '/root' }))
      .resolves.toMatchObject({
        kind: 'messages-arrived',
        messages: [expect.objectContaining({ content: 'registration-gap input' })],
      });
  });

  it('ignores another session scope until the matching scope receives input', async () => {
    const messageQueue = new MessageQueue();
    const waiting = waitForWakeEvent({ messageQueue, agentId: 'actor:a:/root' });
    messageQueue.enqueue({
      priority: 'user',
      mode: 'prompt',
      agentId: 'actor:b:/root',
      content: 'other session',
    });
    messageQueue.enqueue({
      priority: 'user',
      mode: 'prompt',
      agentId: 'actor:a:/root',
      content: 'current session',
    });

    await expect(waiting).resolves.toMatchObject({
      kind: 'messages-arrived',
      messages: [expect.objectContaining({ content: 'current session' })],
    });
    expect(messageQueue.peek({
      agentId: 'actor:b:/root',
      maxPriority: 'background',
    }).map((message) => message.content)).toEqual(['other session']);
  });

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
