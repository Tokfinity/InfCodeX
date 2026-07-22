import type { KodaXMessage } from '@kodax-ai/llm';
import type {
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionStorage,
} from '../types.js';
import type { CompactionUpdate } from './compaction/types.js';
import { mergeArtifactLedger } from './compaction/file-tracker.js';
import {
  applySessionCompaction,
  createSessionLineage,
} from './kodax-session-lineage.js';

export interface PersistCompactedSessionHistoryInput {
  readonly storage: KodaXSessionStorage;
  readonly sessionId: string;
  readonly compactedMessages: readonly KodaXMessage[];
  readonly update: CompactionUpdate;
  /** Explicit metadata used only when a new Session compacts before its first routine snapshot. */
  readonly initialSessionData?: Omit<KodaXSessionData, 'messages' | 'lineage'>;
}

/** Persist one exact root compaction transaction before its replacement is used. */
export async function persistCompactedSessionHistory(
  input: PersistCompactedSessionHistoryInput,
): Promise<KodaXSessionLineage> {
  const loaded = await input.storage.load(input.sessionId);
  if (!loaded && !input.initialSessionData) {
    throw new Error(`Cannot persist compaction for missing session: ${input.sessionId}`);
  }
  const preCompactionMessages = [...(input.update.preCompactionMessages ?? loaded?.messages ?? [])];
  const current: KodaXSessionData = loaded ?? {
    ...input.initialSessionData!,
    messages: preCompactionMessages,
    lineage: createSessionLineage(preCompactionMessages),
  };
  const exactBase = createSessionLineage(
    preCompactionMessages.length > 0 ? preCompactionMessages : current.messages,
    current.lineage,
  );
  const compactedMessages = [...input.compactedMessages];
  const lineage = input.update.anchor
    ? applySessionCompaction(
        exactBase,
        compactedMessages,
        input.update.anchor,
        input.update.postCompactAttachments ?? [],
      )
    : createSessionLineage(compactedMessages, exactBase);
  const artifactLedger = input.update.artifactLedger?.length
    ? mergeArtifactLedger(current.artifactLedger ?? [], input.update.artifactLedger)
    : current.artifactLedger;

  await input.storage.save(input.sessionId, {
    ...current,
    messages: compactedMessages,
    lineage,
    ...(artifactLedger !== undefined ? { artifactLedger } : {}),
  });
  return lineage;
}
