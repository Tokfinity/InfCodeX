import {
  persistCompactedSessionHistory,
  type KodaXSessionData,
  type KodaXSessionScope,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import type { KodaXEvents } from '../types.js';

export interface DurableCompactionEventsInput {
  readonly events: KodaXEvents;
  readonly storage?: KodaXSessionStorage;
  readonly sessionId: string;
  readonly persistedByHost?: boolean;
  readonly currentAgentId?: string;
  readonly sessionScope?: KodaXSessionScope;
  readonly initialSessionData?: Omit<KodaXSessionData, 'messages' | 'lineage'>;
}

/** Add an awaited durable commit for a core-owned root or isolated child run. */
export function withDurableCompactionPersistence(
  input: DurableCompactionEventsInput,
): KodaXEvents {
  const storage = input.storage;
  const isolatedChild = input.currentAgentId !== undefined
    && input.sessionScope === 'managed-task-worker';
  if (!storage || input.persistedByHost || (input.currentAgentId !== undefined && !isolatedChild)) {
    return input.events;
  }
  const original = input.events.onCompactedMessages;
  return {
    ...input.events,
    async onCompactedMessages(messages, update, meta) {
      if (meta?.contextKind === 'child' && !isolatedChild) {
        await original?.(messages, update, meta);
        return;
      }
      if (!update?.preCompactionMessages) {
        throw new Error('Committed compaction is missing its exact pre-compaction snapshot.');
      }
      await persistCompactedSessionHistory({
        storage,
        sessionId: input.sessionId,
        compactedMessages: messages,
        update,
        initialSessionData: input.initialSessionData,
      });
      await original?.(messages, update, meta);
    },
  };
}
