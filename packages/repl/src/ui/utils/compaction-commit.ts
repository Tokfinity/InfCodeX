import {
  applySessionCompaction,
  createSessionLineage,
  type KodaXMessage,
  type KodaXSessionStorage,
  type KodaXSessionLineage,
} from '@kodax-ai/agent';
import type { CompactionUpdate, KodaXActivityEventMeta } from '@kodax-ai/coding';

/** Build the exact root lineage that must be durable before in-memory eviction. */
export function prepareRootCompactionLineage(
  existing: KodaXSessionLineage | undefined,
  compactedMessages: KodaXMessage[],
  update: CompactionUpdate | undefined,
  meta: KodaXActivityEventMeta | undefined,
): KodaXSessionLineage | null {
  if (meta?.contextKind === 'child') return null;
  const exactBase = update?.preCompactionMessages
    ? createSessionLineage([...update.preCompactionMessages], existing)
    : existing;
  return update?.anchor
    ? applySessionCompaction(
      exactBase,
      compactedMessages,
      update.anchor,
      update.postCompactAttachments ?? [],
    )
    : createSessionLineage(compactedMessages, exactBase);
}

/** Delay model-facing exact-history reads until the host's durable write has settled. */
export function withSessionHistoryReadBarrier(
  storage: KodaXSessionStorage,
  getBarrier: () => Promise<void>,
): KodaXSessionStorage {
  const loadFullLineage = storage.loadFullLineage;
  if (!loadFullLineage) return storage;
  const guardedLoadFullLineage = async (id: string): Promise<KodaXSessionLineage | null> => {
    await getBarrier();
    return loadFullLineage.call(storage, id);
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'loadFullLineage') return guardedLoadFullLineage;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
