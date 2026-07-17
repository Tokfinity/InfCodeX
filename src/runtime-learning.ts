import { createHash } from 'node:crypto';

import {
  createLearningCenterService,
  type LearnedCapabilityRecord,
  type LearningEvent,
  type LearningPage,
  type LearningQuery,
  type LearningSubscribeOptions,
  type LearningSurfaceSnapshot,
} from '@kodax-ai/agent';

export interface RuntimeLearningService {
  list(query?: LearningQuery): Promise<LearningPage>;
  get(nameOrSlug: string): Promise<LearnedCapabilityRecord>;
  getSnapshot(): Promise<LearningSurfaceSnapshot>;
  events(afterRevision?: number): Promise<readonly LearningEvent[]>;
  subscribe(options?: LearningSubscribeOptions): AsyncIterable<LearningEvent>;
  acknowledge(nameOrSlug: string): Promise<void>;
  snooze(nameOrSlug: string, until: string): Promise<void>;
  reject(nameOrSlug: string): Promise<void>;
  disable(nameOrSlug: string): Promise<void>;
  rollback(nameOrSlug: string): Promise<void>;
  promote(nameOrSlug: string, scope: 'user'): Promise<void>;
  review(nameOrSlug: string): Promise<void>;
  trust(nameOrSlug: string): Promise<void>;
}

interface RuntimeLearningOwner extends RuntimeLearningService {
  forClient(clientIdentity: string): RuntimeLearningService;
}

export interface CreateRuntimeLearningOwnerOptions {
  readonly rootDir: string;
  readonly defaultClientIdentity: string;
  readonly proposalStores?: readonly string[];
}

export function createRuntimeLearningOwner(
  options: CreateRuntimeLearningOwnerOptions,
): RuntimeLearningService {
  const clients = new Map<string, RuntimeLearningService>();
  const forClient = (identity: string): RuntimeLearningService => {
    const key = learningClientFileKey(identity);
    const existing = clients.get(key);
    if (existing) return existing;
    const service = createLearningCenterService({
      rootDir: options.rootDir,
      clientIdentity: key,
      proposalStores: options.proposalStores,
    });
    const facade = createInitializedFacade(service);
    clients.set(key, facade);
    return facade;
  };
  const defaultFacade = forClient(options.defaultClientIdentity);
  return Object.assign(defaultFacade, { forClient }) satisfies RuntimeLearningOwner;
}

export function bindRuntimeLearningClient(
  service: RuntimeLearningService,
  clientIdentity: string,
): RuntimeLearningService {
  const owner = service as Partial<RuntimeLearningOwner>;
  return typeof owner.forClient === 'function' ? owner.forClient(clientIdentity) : service;
}

export function learningClientFileKey(identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return `client_${digest}`;
}

function createInitializedFacade(
  service: ReturnType<typeof createLearningCenterService>,
): RuntimeLearningService {
  const ready = service.initialize();
  return {
    list: async (query) => { await ready; return service.list(query); },
    get: async (nameOrSlug) => { await ready; return service.get(nameOrSlug); },
    getSnapshot: async () => { await ready; return service.getSnapshot(); },
    events: async (afterRevision) => { await ready; return service.events(afterRevision); },
    subscribe: (options) => subscribeAfter(ready, service, options),
    acknowledge: async (nameOrSlug) => { await ready; await service.acknowledge(nameOrSlug); },
    snooze: async (nameOrSlug, until) => { await ready; await service.snooze(nameOrSlug, until); },
    reject: async (nameOrSlug) => { await ready; await service.reject(nameOrSlug); },
    disable: async (nameOrSlug) => { await ready; await service.disable(nameOrSlug); },
    rollback: async (nameOrSlug) => { await ready; await service.rollback(nameOrSlug); },
    promote: async (nameOrSlug, scope) => { await ready; await service.promote(nameOrSlug, scope); },
    review: async (nameOrSlug) => { await ready; await service.review(nameOrSlug); },
    trust: async (nameOrSlug) => { await ready; await service.trust(nameOrSlug); },
  };
}

async function* subscribeAfter(
  ready: Promise<void>,
  service: ReturnType<typeof createLearningCenterService>,
  options: LearningSubscribeOptions | undefined,
): AsyncIterable<LearningEvent> {
  await ready;
  yield* service.subscribe(options);
}
