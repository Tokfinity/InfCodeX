import { describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import { MessageQueue } from '../messaging/queue.js';
import { createAgent } from '../primitives/agent.js';
import {
  composeIdleYieldUserMessage,
  waitForWakeEvent,
} from './idle-yield.js';
import { runWithIdleYield } from './runner-with-idle-yield.js';

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

  it('does not let a later Runtime prompt overtake a host-owned prompt', async () => {
    const messageQueue = new MessageQueue();
    messageQueue.enqueue({
      priority: 'user',
      mode: 'prompt',
      delivery: 'host',
      agentId: '/root',
      content: '/hidden-skill args',
    });
    messageQueue.enqueue({
      priority: 'user',
      mode: 'prompt',
      agentId: '/root',
      content: 'later Runtime prompt',
    });
    messageQueue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      agentId: '/root',
      content: '<agent-completed path="/root/review">done</agent-completed>',
    });

    await expect(waitForWakeEvent({ messageQueue, agentId: '/root' }))
      .resolves.toEqual({ kind: 'host-input-arrived' });
    expect(messageQueue.peek({
      agentId: '/root',
      maxPriority: 'background',
    }).map((message) => message.content)).toEqual([
      '/hidden-skill args',
      'later Runtime prompt',
      '<agent-completed path="/root/review">done</agent-completed>',
    ]);
  });

  it('returns an idle run to the host when an explicit Skill is queued', async () => {
    const messageQueue = new MessageQueue();
    const agent = createAgent({ name: 'worker', instructions: 'sys' });
    let calls = 0;

    const result = await runWithIdleYield({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async () => {
        calls += 1;
        messageQueue.enqueue({
          priority: 'user',
          mode: 'prompt',
          delivery: 'host',
          agentId: '/root',
          content: '/hidden-skill args',
        });
        return { messages: [{ role: 'assistant', content: 'waiting' }] };
      },
      computeSnapshot: () => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
      messageQueue,
      agentId: '/root',
      resumeAgent: () => agent,
    });

    expect(result.messages.at(-1)?.content).toBe('waiting');
    expect(calls).toBe(1);
    expect(messageQueue.peek({
      agentId: '/root',
      maxPriority: 'user',
      mode: 'prompt',
    })).toHaveLength(1);
  });

  it('stops waiting promptly when the session aborts', async () => {
    const abort = new AbortController();
    const messageQueue = new MessageQueue();
    const waiting = waitForWakeEvent({ messageQueue, agentId: undefined, abortSignal: abort.signal });

    abort.abort('closed');

    await expect(waiting).resolves.toEqual({ kind: 'aborted' });
  });

  it('propagates idle-yield cancellation instead of returning a stale success', async () => {
    const abort = new AbortController();
    abort.abort('closed');
    const agent = createAgent({ name: 'worker', instructions: 'sys' });

    await expect(runWithIdleYield({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async () => ({ messages: [{ role: 'assistant', content: 'waiting' }] }),
      computeSnapshot: () => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
      messageQueue: new MessageQueue(),
      agentId: '/root',
      abortSignal: abort.signal,
      resumeAgent: () => agent,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails closed when unresolved idle resumes exceed the outer ceiling', async () => {
    const messageQueue = new MessageQueue();
    messageQueue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      agentId: '/root',
      content: '<agent-completed>still unresolved</agent-completed>',
    });
    const agent = createAgent({ name: 'worker', instructions: 'sys' });

    await expect(runWithIdleYield({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async () => ({ messages: [{ role: 'assistant', content: 'waiting' }] }),
      computeSnapshot: () => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
      messageQueue,
      agentId: '/root',
      resumeAgent: () => agent,
      maxIterations: 1,
    })).rejects.toThrow(/iteration ceiling \(1\)/);
  });

  it('does not impose the default outer ceiling when the caller is unbounded', async () => {
    const messageQueue = new MessageQueue();
    const agent = createAgent({ name: 'worker', instructions: 'sys' });
    let calls = 0;

    await runWithIdleYield({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async () => {
        calls += 1;
        if (calls <= 65) {
          messageQueue.enqueue({
            priority: 'background',
            mode: 'task-notification',
            agentId: '/root',
            content: `<agent-completed>child ${calls}</agent-completed>`,
          });
        }
        return { messages: [{ role: 'assistant', content: `turn ${calls}` }] };
      },
      computeSnapshot: () => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: calls <= 65 ? 1 : 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: calls <= 65,
      }),
      messageQueue,
      agentId: '/root',
      resumeAgent: () => agent,
      maxIterations: Number.POSITIVE_INFINITY,
    });

    expect(calls).toBe(66);
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
    expect(onUserPrompts).toHaveBeenCalledWith(
      ['change direction'],
      ['msg-1'],
      expect.objectContaining({ role: 'user', content: 'change direction' }),
      expect.any(Map),
    );
  });

  it('keeps each drained user prompt paired with its own transcript message', async () => {
    let messagesByQueuedId: ReadonlyMap<string, KodaXMessage> | undefined;
    const messages = await composeIdleYieldUserMessage({
      kind: 'messages-arrived',
      messages: [
        {
          id: 'msg-1',
          priority: 'user',
          mode: 'prompt',
          content: 'first direction',
          agentId: '/root',
          enqueuedAt: 1,
        },
        {
          id: 'msg-2',
          priority: 'user',
          mode: 'prompt',
          content: 'second direction',
          agentId: '/root',
          enqueuedAt: 2,
        },
      ],
    }, () => [], undefined, (_contents, _ids, _promptMessage, exactMessages) => {
      messagesByQueuedId = exactMessages;
    });

    expect(messages).toHaveLength(2);
    expect(messagesByQueuedId?.get('msg-1')?.content).toBe('first direction');
    expect(messagesByQueuedId?.get('msg-2')?.content).toBe('second direction');
    expect(new Set(messagesByQueuedId?.values()).size).toBe(2);
  });

  it('keeps explicit Actor mailbox messages synthetic instead of user-authored', async () => {
    const onUserPrompts = vi.fn();
    const messages = await composeIdleYieldUserMessage({
      kind: 'messages-arrived',
      messages: [{
        id: 'msg-1',
        priority: 'background',
        mode: 'agent-message',
        content: '<agent-message>critical evidence</agent-message>',
        agentId: '/root',
        enqueuedAt: 1,
      }],
    }, () => [], undefined, onUserPrompts);

    expect(messages).toMatchObject([{
      role: 'user',
      _synthetic: true,
      content: '<agent-message>critical evidence</agent-message>',
    }]);
    expect(onUserPrompts).not.toHaveBeenCalled();
  });

  it('inserts refreshed runtime context immediately before idle-resume wake messages', async () => {
    const messageQueue = new MessageQueue();
    messageQueue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      agentId: '/root',
      content: '<agent-completed>done</agent-completed>',
    });
    const agent = createAgent({ name: 'worker', instructions: 'sys' });
    const inputs: Array<readonly import('../primitives/agent.js').AgentMessage[]> = [];
    let calls = 0;

    await runWithIdleYield({
      initialAgent: agent,
      initialInput: [{ role: 'user', content: 'start' }],
      runOnce: async (_agent, input) => {
        inputs.push(input);
        calls += 1;
        return {
          // Mirror Runner.run: every invocation owns and prepends one system
          // message to the caller-provided transcript.
          messages: [
            { role: 'system' as const, content: 'sys' },
            ...input,
            { role: 'assistant' as const, content: `turn-${calls}` },
          ],
        };
      },
      computeSnapshot: () => ({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: calls === 1 ? 1 : 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
      messageQueue,
      agentId: '/root',
      resumeAgent: () => agent,
      buildResumeContextMessages: (_result, wakeMessages) => [{
        role: 'user',
        content: 'fresh runtime context',
        _synthetic: true,
        _source: 'managed-run-context',
        turnId: wakeMessages[0]?.turnId,
      }],
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.filter((message) => message.role === 'system')).toHaveLength(0);
    expect(inputs[1]?.slice(-2)).toEqual([
      expect.objectContaining({
        content: 'fresh runtime context',
        _source: 'managed-run-context',
      }),
      expect.objectContaining({
        content: '<agent-completed>done</agent-completed>',
      }),
    ]);
  });
});
