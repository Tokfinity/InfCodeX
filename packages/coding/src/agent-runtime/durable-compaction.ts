import {
  persistCompactedSessionHistory,
  type KodaXSessionData,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import type { KodaXEvents } from '../types.js';

export interface DurableCompactionEventsInput {
  readonly events: KodaXEvents;
  readonly storage?: KodaXSessionStorage;
  readonly sessionId: string;
  readonly persistedByHost?: boolean;
  readonly currentAgentId?: string;
  readonly initialSessionData?: Omit<KodaXSessionData, 'messages' | 'lineage'>;
}

/** Add an awaited durable commit for root runs whose persistence is core-owned. */
export function withDurableCompactionPersistence(
  input: DurableCompactionEventsInput,
): KodaXEvents {
  const storage = input.storage;
  if (!storage || input.persistedByHost || input.currentAgentId !== undefined) {
    return input.events;
  }
  const original = input.events.onCompactedMessages;
  return {
    ...input.events,
    async onCompactedMessages(messages, update, meta) {
      if (meta?.contextKind === 'child') {
        await original?.(messages, update, meta);
        return;
      }
      if (!update?.preCompactionMessages) {
        throw new Error('Committed root compaction is missing its exact pre-compaction snapshot.');
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
