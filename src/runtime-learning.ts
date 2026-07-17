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
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    ready ??= service.initialize();
    return ready;
  };
  return {
    list: async (query) => { await ensureReady(); return service.list(query); },
    get: async (nameOrSlug) => { await ensureReady(); return service.get(nameOrSlug); },
    getSnapshot: async () => { await ensureReady(); return service.getSnapshot(); },
    events: async (afterRevision) => { await ensureReady(); return service.events(afterRevision); },
    subscribe: (options) => subscribeAfter(ensureReady(), service, options),
    acknowledge: async (nameOrSlug) => { await ensureReady(); await service.acknowledge(nameOrSlug); },
    snooze: async (nameOrSlug, until) => { await ensureReady(); await service.snooze(nameOrSlug, until); },
    reject: async (nameOrSlug) => { await ensureReady(); await service.reject(nameOrSlug); },
    disable: async (nameOrSlug) => { await ensureReady(); await service.disable(nameOrSlug); },
    rollback: async (nameOrSlug) => { await ensureReady(); await service.rollback(nameOrSlug); },
    promote: async (nameOrSlug, scope) => { await ensureReady(); await service.promote(nameOrSlug, scope); },
    review: async (nameOrSlug) => { await ensureReady(); await service.review(nameOrSlug); },
    trust: async (nameOrSlug) => { await ensureReady(); await service.trust(nameOrSlug); },
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
