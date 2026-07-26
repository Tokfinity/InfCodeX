import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMessageQueueForTests,
  actorQueueId,
  getMessageQueue,
} from '@kodax-ai/agent';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import { runKodaX } from '../agent.js';
import { CodingActorSession } from './actor-runtime.js';

const PROVIDER_NAME = 'terminal-interrupt-provider';
const API_KEY_ENV = 'TERMINAL_INTERRUPT_PROVIDER_API_KEY';
const MAX_CONTINUATION_TURNS = 8;

describe('runKodaX Runtime terminal interrupt continuation', { timeout: 30_000 }, () => {
  let actorSession: CodingActorSession | undefined;

  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    _resetMessageQueueForTests();
  });

  afterEach(async () => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    _resetMessageQueueForTests();
    await actorSession?.close('test complete');
    actorSession = undefined;
  });

  it('consumes input accepted during the final provider request before completing', async () => {
    const sessionId = 'ordinary-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;
    const delivered: string[][] = [];
    const turnStarts: Array<{ turnId: string; deliveryKind: string }> = [];
    const turnCompletions: string[] = [];

    class TerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        _streamOptions?: KodaXProviderStreamOptions,
        _signal?: AbortSignal,
      ): Promise<KodaXStreamResult> {
        turn += 1;
        expect(inputWindowOpen).toBe(true);
        if (turn === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'interrupt accepted during the final request',
          });
          return {
            textBlocks: [{ type: 'text', text: 'first answer' }],
            toolBlocks: [],
            thinkingBlocks: [],
          };
        }
        expect(JSON.stringify(messages.at(-1)?.content)).toContain(
          'interrupt accepted during the final request',
        );
        return {
          textBlocks: [{ type: 'text', text: 'follow-up answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new TerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
        events: {
          onMidTurnUserMessages(contents) {
            delivered.push([...contents]);
          },
          onTurnStarted(event) {
            turnStarts.push({
              turnId: event.turnId,
              deliveryKind: event.deliveryKind,
            });
          },
          onTurnCompleted(event) {
            turnCompletions.push(event.turnId);
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('follow-up answer');
    expect(turn).toBe(2);
    expect(delivered).toEqual([['interrupt accepted during the final request']]);
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]?.deliveryKind).toBe('initial');
    expect(turnStarts[1]?.deliveryKind).toBe('queued');
    expect(turnStarts[1]?.turnId).not.toBe(turnStarts[0]?.turnId);
    expect(turnCompletions).toEqual([
      turnStarts[0]?.turnId,
      turnStarts[1]?.turnId,
    ]);
    expect(inputWindowOpen).toBe(false);
    expect(getMessageQueue().has({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    })).toBe(false);
  });

  it('bounds continuously accepted terminal input to a fixed continuation allowance', async () => {
    const sessionId = 'ordinary-bounded-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;

    class ContinuousTerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
        turn += 1;
        if (inputWindowOpen && turn <= MAX_CONTINUATION_TURNS + 3) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: `interrupt-${turn}`,
          });
        }
        if (turn === MAX_CONTINUATION_TURNS + 1) {
          expect(JSON.stringify(messages.at(-1)?.content)).toContain(
            `interrupt-${MAX_CONTINUATION_TURNS}`,
          );
        }
        return {
          textBlocks: [{ type: 'text', text: `answer-${turn}` }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new ContinuousTerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe(`answer-${MAX_CONTINUATION_TURNS + 1}`);
    expect(turn).toBe(MAX_CONTINUATION_TURNS + 1);
    expect(inputWindowOpen).toBe(false);
  });

  it('commits a COMPLETE assistant before continuing with accepted input', async () => {
    const sessionId = 'ordinary-complete-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;

    class CompleteTerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
      ): Promise<KodaXStreamResult> {
        turn += 1;
        if (turn === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'follow up after COMPLETE',
          });
          return {
            textBlocks: [{ type: 'text', text: 'first answer <promise>COMPLETE</promise>' }],
            toolBlocks: [],
            thinkingBlocks: [],
          };
        }
        const previousAssistant = messages.at(-2);
        expect(previousAssistant?.role).toBe('assistant');
        expect(JSON.stringify(previousAssistant?.content)).toContain('first answer');
        expect(JSON.stringify(messages.at(-1)?.content)).toContain('follow up after COMPLETE');
        return {
          textBlocks: [{ type: 'text', text: 'follow-up answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new CompleteTerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('follow-up answer');
    expect(turn).toBe(2);
    expect(inputWindowOpen).toBe(false);
  });

  it('closes interrupt admission before ordinary failure cleanup', async () => {
    const sessionId = 'ordinary-terminal-failure';
    let inputWindowOpen = true;

    class FailingProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        throw new Error('ordinary-provider-failure');
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new FailingProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(false);
    expect(inputWindowOpen).toBe(false);
  });
});
