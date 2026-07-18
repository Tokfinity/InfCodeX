import { getAgentConfigPath } from '../runtime/agent-home.js';
import type {
  LearnedCapabilityLifecycle,
  LearnedCapabilityRecord,
  LearningAction,
  LearningActionDriver,
  LearningClientEventState,
  LearningClientRecord,
  LearningEvent,
  LearningPage,
  LearningQuery,
  LearningSubscribeOptions,
  LearningSurfaceSnapshot,
} from './center-types.js';
import {
  LearningCapabilityError,
  assertLearnedCapabilityTransition,
  slugifyLearnedCapabilityName,
} from './center-types.js';
import { eventFromCapability, LearnedAreaStore } from './learned-area-store.js';
import { makeProjectedLearningSlugsUnique, projectLearningProposals } from './proposal-projection.js';
import { approveStoredLearningProposal } from './approval.js';
import { readLearningProposalStore, updateLearningProposalStatus } from './store.js';

export interface CreateLearningCenterServiceOptions {
  readonly rootDir?: string;
  readonly clientIdentity: string;
  readonly now?: () => string;
  readonly proposalStores?: readonly string[];
  readonly actionDrivers?: readonly LearningActionDriver[];
}

export interface LearningCenterService {
  initialize(): Promise<void>;
  list(query?: LearningQuery): Promise<LearningPage>;
  get(nameOrSlug: string): Promise<LearnedCapabilityRecord>;
  getSnapshot(): Promise<LearningSurfaceSnapshot>;
  events(afterRevision?: number): Promise<readonly LearningEvent[]>;
  subscribe(options?: LearningSubscribeOptions): AsyncIterable<LearningEvent>;
  acknowledge(nameOrSlug: string): Promise<void>;
  markSeen(nameOrSlug: string): Promise<void>;
  snooze(nameOrSlug: string, until: string): Promise<void>;
  reject(nameOrSlug: string): Promise<void>;
  disable(nameOrSlug: string): Promise<void>;
  rollback(nameOrSlug: string): Promise<void>;
  archive(nameOrSlug: string): Promise<void>;
  restore(nameOrSlug: string): Promise<void>;
  promote(nameOrSlug: string, scope: 'user'): Promise<void>;
  review(nameOrSlug: string): Promise<void>;
  trust(nameOrSlug: string): Promise<void>;
  record(record: LearnedCapabilityRecord): Promise<LearnedCapabilityRecord>;
}

interface EventWaiter {
  readonly resolve: (event: LearningEvent | undefined) => void;
}

const EVENT_HUBS = new Map<string, Set<EventWaiter>>();

function eventHubFor(rootDir: string): Set<EventWaiter> {
  const existing = EVENT_HUBS.get(rootDir);
  if (existing) return existing;
  const created = new Set<EventWaiter>();
  EVENT_HUBS.set(rootDir, created);
  return created;
}

export class FileLearningCenterService implements LearningCenterService {
  private readonly store: LearnedAreaStore;
  private readonly now: () => string;
  private readonly proposalStores: readonly string[];
  private readonly drivers: ReadonlyMap<string, LearningActionDriver>;
  private readonly waiters: Set<EventWaiter>;

  constructor(private readonly options: CreateLearningCenterServiceOptions) {
    const rootDir = options.rootDir ?? getAgentConfigPath('learned');
    this.store = new LearnedAreaStore(rootDir);
    this.waiters = eventHubFor(rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
    this.proposalStores = options.proposalStores ?? [];
    this.drivers = new Map((options.actionDrivers ?? []).map((driver) => [driver.carrier, driver]));
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async list(query: LearningQuery = {}): Promise<LearningPage> {
    const all = await this.loadCapabilities();
    const filtered = all
      .filter((record) => matchesQuery(record, query))
      .sort(compareCapabilities);
    const offset = parseCursor(query.cursor);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
      revision: (await this.store.listEvents()).at(-1)?.sequence ?? 0,
    };
  }

  async get(nameOrSlug: string): Promise<LearnedCapabilityRecord> {
    const needle = nameOrSlug.trim().toLowerCase();
    const records = await this.loadCapabilities();
    const slugMatch = records.find((record) => record.slug.toLowerCase() === needle);
    if (slugMatch) return slugMatch;
    const nameMatches = records.filter((record) => record.displayName.toLowerCase() === needle);
    if (nameMatches.length > 1) {
      throw new LearningCapabilityError(
        'ambiguous_name',
        `learned capability name is ambiguous: ${nameOrSlug}; use one of ${nameMatches.map((entry) => entry.slug).join(', ')}`,
      );
    }
    if (nameMatches.length === 1) return nameMatches[0];
    throw new LearningCapabilityError('capability_not_found', `learned capability not found: ${nameOrSlug}`);
  }

  async getSnapshot(): Promise<LearningSurfaceSnapshot> {
    const [capabilities, events, client] = await Promise.all([
      this.loadCapabilities(),
      this.store.listEvents(),
      this.store.readClient(this.options.clientIdentity),
    ]);
    const currentEvents = selectCurrentEvents(capabilities, events);
    return {
      ready: countActionable(currentEvents, client, 'ready', this.now()),
      newlyActive: countActionable(currentEvents, client, 'activated', this.now()),
      attention: countActionable(currentEvents, client, 'attention', this.now()),
      active: capabilities.filter((entry) => entry.lifecycle === 'active_learned').length,
      revision: events.at(-1)?.sequence ?? 0,
    };
  }

  async events(afterRevision = 0): Promise<readonly LearningEvent[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new LearningCapabilityError('invalid_record', 'learning event revision is invalid');
    }
    return (await this.store.listEvents()).filter((event) => event.sequence > afterRevision);
  }

  subscribe(options: LearningSubscribeOptions = {}): AsyncIterable<LearningEvent> {
    return new LearningEventSubscription(
      this.store,
      this.waiters,
      options.afterRevision ?? 0,
    );
  }

  async acknowledge(nameOrSlug: string): Promise<void> {
    await this.updateNotificationState(nameOrSlug, 'acknowledged');
  }

  async markSeen(nameOrSlug: string): Promise<void> {
    await this.updateNotificationState(nameOrSlug, 'seen');
  }

  async snooze(nameOrSlug: string, until: string): Promise<void> {
    if (!Number.isFinite(Date.parse(until))) {
      throw new LearningCapabilityError('invalid_record', 'snooze time must be an ISO timestamp');
    }
    await this.updateNotificationState(nameOrSlug, 'snoozed', until);
  }

  async reject(nameOrSlug: string): Promise<void> {
    const current = await this.get(nameOrSlug);
    if (current.source.kind === 'f224_proposal') {
      await this.updateF224Proposal(current, 'reject');
      return;
    }
    await this.transition(current, 'rejected');
  }

  async disable(nameOrSlug: string): Promise<void> {
    await this.transitionByName(nameOrSlug, 'archived');
  }

  async rollback(nameOrSlug: string): Promise<void> {
    const current = await this.get(nameOrSlug);
    const driver = this.driverFor(current, 'rollback');
    if (!driver) {
      throw new LearningCapabilityError(
        'unsupported_action',
        `rollback is not supported for learned ${current.carrier} capabilities`,
      );
    }
    await this.record(await driver.execute('rollback', current));
  }

  async archive(nameOrSlug: string): Promise<void> {
    await this.transitionByName(nameOrSlug, 'archived');
  }

  async restore(nameOrSlug: string): Promise<void> {
    const current = await this.get(nameOrSlug);
    await this.transition(current, current.previousGoodRevision === undefined ? 'ready' : 'active_learned');
  }

  async promote(nameOrSlug: string, _scope: 'user'): Promise<void> {
    await this.executeDriverAction(nameOrSlug, 'promote');
  }

  async review(nameOrSlug: string): Promise<void> {
    await this.executeDriverAction(nameOrSlug, 'review');
  }

  async trust(nameOrSlug: string): Promise<void> {
    const current = await this.get(nameOrSlug);
    if (current.source.kind === 'f224_proposal') {
      await this.updateF224Proposal(current, 'trust');
      return;
    }
    await this.executeDriverAction(nameOrSlug, 'trust');
  }

  async record(record: LearnedCapabilityRecord): Promise<LearnedCapabilityRecord> {
    return this.store.withOwnerMutation(() => this.recordUnlocked(record));
  }

  private async recordUnlocked(record: LearnedCapabilityRecord): Promise<LearnedCapabilityRecord> {
    validateRecord(record);
    const existing = await this.store.readCapability(record.capabilityId);
    if (existing) {
      if (record.revision !== existing.revision + 1) {
        throw new LearningCapabilityError('invalid_record', 'capability revision must increase by one');
      }
      if (record.lifecycle === existing.lifecycle) {
        if (record.lastAction !== 'rollback' || record.lifecycle !== 'active_learned') {
          throw new LearningCapabilityError('invalid_transition', 'same-state revision requires an active rollback');
        }
      } else {
        assertLearnedCapabilityTransition(existing.lifecycle, record.lifecycle);
      }
    }
    const slugOwner = (await this.store.listCapabilities()).find((entry) => (
      entry.slug === record.slug && entry.capabilityId !== record.capabilityId
    ));
    if (slugOwner) {
      throw new LearningCapabilityError(
        'invalid_record',
        `learned capability slug is already owned by ${slugOwner.capabilityId}: ${record.slug}`,
      );
    }
    await this.store.writeCapability(record);
    const events = await this.store.listEvents();
    const event = eventFromCapability(record, (events.at(-1)?.sequence ?? 0) + 1);
    await this.store.writeEvent(event);
    this.emit(event);
    return record;
  }

  private async transitionByName(
    nameOrSlug: string,
    lifecycle: LearnedCapabilityLifecycle,
  ): Promise<LearnedCapabilityRecord> {
    return this.transition(await this.get(nameOrSlug), lifecycle);
  }

  private async transition(
    current: LearnedCapabilityRecord,
    lifecycle: LearnedCapabilityLifecycle,
  ): Promise<LearnedCapabilityRecord> {
    assertLearnedCapabilityTransition(current.lifecycle, lifecycle);
    return this.record({
      ...current,
      lifecycle,
      revision: current.revision + 1,
      updatedAt: this.now(),
      ...(lifecycle === 'archived' && current.lifecycle === 'active_learned'
        ? { previousGoodRevision: current.revision }
        : {}),
    });
  }

  private async executeDriverAction(nameOrSlug: string, action: LearningAction): Promise<void> {
    const current = await this.get(nameOrSlug);
    const driver = this.driverFor(current, action);
    if (!driver) {
      throw new LearningCapabilityError(
        'unsupported_action',
        `${action} is not supported for learned ${current.carrier} capabilities`,
      );
    }
    await this.record(await driver.execute(action, current));
  }

  private driverFor(
    current: LearnedCapabilityRecord,
    action: LearningAction,
  ): LearningActionDriver | undefined {
    const driver = this.drivers.get(current.carrier);
    return driver?.actions.includes(action) ? driver : undefined;
  }

  private async loadCapabilities(): Promise<readonly LearnedCapabilityRecord[]> {
    const stored = await this.store.listCapabilities();
    const rawProjected = (await Promise.all(this.proposalStores.map(projectLearningProposals)))
      .flatMap((result) => result.records);
    const projected = makeProjectedLearningSlugsUnique(rawProjected, stored.map((record) => record.slug));
    const storedIds = new Set(stored.map((record) => record.capabilityId));
    return [...stored, ...projected.filter((record) => !storedIds.has(record.capabilityId))];
  }

  private async updateNotificationState(
    nameOrSlug: string,
    state: LearningClientEventState['state'],
    snoozedUntil?: string,
  ): Promise<void> {
    await this.store.withClientMutation(this.options.clientIdentity, async () => {
      const capability = await this.get(nameOrSlug);
      const [events, client] = await Promise.all([
        this.store.listEvents(),
        this.store.readClient(this.options.clientIdentity),
      ]);
      const matching = events.filter((event) => event.capabilityId === capability.capabilityId);
      const nextEvents = { ...client.events };
      for (const event of matching) {
        nextEvents[event.eventId] = {
          state,
          capabilityRevision: event.capabilityRevision,
          updatedAt: this.now(),
          ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
        };
      }
      await this.store.writeClient({ ...client, events: nextEvents });
    });
  }

  private emit(event: LearningEvent): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.resolve(event);
  }

  private async updateF224Proposal(
    current: LearnedCapabilityRecord,
    action: 'reject' | 'trust',
  ): Promise<void> {
    const proposalId = current.source.proposalId;
    if (!proposalId) {
      throw new LearningCapabilityError('store_integrity_error', 'F224 projection is missing owner metadata');
    }
    const storePath = await this.findF224ProposalStore(current, proposalId);
    const stored = (await readLearningProposalStore(storePath)).proposals
      .find((entry) => entry.proposalId === proposalId);
    if (!stored) throw new LearningCapabilityError('capability_not_found', `F224 proposal not found: ${current.slug}`);
    if (action === 'reject') await updateLearningProposalStatus(storePath, proposalId, 'rejected');
    else {
      const result = await approveStoredLearningProposal(storePath, stored);
      if (!result.status.startsWith('approved_')) {
        throw new LearningCapabilityError('action_failed', `F224 proposal approval was blocked: ${result.status}`);
      }
    }
    const projected = (await projectLearningProposals(storePath)).records
      .find((entry) => entry.capabilityId === current.capabilityId);
    if (!projected) throw new LearningCapabilityError('store_integrity_error', 'F224 projection disappeared after update');
    await this.record({
      ...projected,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    });
  }

  private async findF224ProposalStore(
    current: LearnedCapabilityRecord,
    proposalId: string,
  ): Promise<string> {
    for (const storePath of this.proposalStores) {
      const projected = await projectLearningProposals(storePath);
      if (projected.records.some((entry) => entry.capabilityId === current.capabilityId)) {
        return storePath;
      }
    }
    throw new LearningCapabilityError(
      'capability_not_found',
      `F224 proposal owner was not found: ${proposalId}`,
    );
  }
}

class LearningEventSubscription implements AsyncIterableIterator<LearningEvent> {
  private cursor: number;
  private closed = false;
  private pendingWaiter: EventWaiter | undefined;
  private nextQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: LearnedAreaStore,
    private readonly waiters: Set<EventWaiter>,
    afterRevision: number,
  ) {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new LearningCapabilityError('invalid_record', 'learning event revision is invalid');
    }
    this.cursor = afterRevision;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LearningEvent> {
    return this;
  }

  next(): Promise<IteratorResult<LearningEvent>> {
    const result = this.nextQueue.then(() => this.readNext());
    this.nextQueue = result.then(
      () => undefined,
      () => { this.closed = true; },
    );
    return result;
  }

  private async readNext(): Promise<IteratorResult<LearningEvent>> {
    while (!this.closed) {
      const existing = (await this.store.listEvents()).find((event) => event.sequence > this.cursor);
      if (this.closed) break;
      if (existing) return this.deliver(existing);

      const event = await this.registerAndRecheck();
      if (this.closed || !event) break;
      if (event.sequence <= this.cursor) continue;
      return this.deliver(event);
    }
    return { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<LearningEvent>> {
    this.closed = true;
    const waiter = this.pendingWaiter;
    this.pendingWaiter = undefined;
    if (waiter) {
      this.waiters.delete(waiter);
      waiter.resolve(undefined);
    }
    return { done: true, value: undefined };
  }

  private async registerAndRecheck(): Promise<LearningEvent | undefined> {
    let waiter: EventWaiter | undefined;
    const waiting = new Promise<LearningEvent | undefined>((resolve) => {
      waiter = { resolve };
      this.pendingWaiter = waiter;
      this.waiters.add(waiter);
    });
    try {
      const rechecked = (await this.store.listEvents()).find((event) => event.sequence > this.cursor);
      if (this.closed) return undefined;
      if (rechecked) return rechecked;
      return await waiting;
    } finally {
      if (waiter) this.waiters.delete(waiter);
      if (this.pendingWaiter === waiter) this.pendingWaiter = undefined;
    }
  }

  private deliver(event: LearningEvent): IteratorResult<LearningEvent> {
    this.cursor = event.sequence;
    return { done: false, value: event };
  }
}

export function createLearningCenterService(
  options: CreateLearningCenterServiceOptions,
): FileLearningCenterService {
  return new FileLearningCenterService(options);
}

function validateRecord(record: LearnedCapabilityRecord): void {
  if (record.schemaVersion !== 1
    || record.capabilityId.length === 0
    || record.displayName.trim().length === 0
    || record.slug !== slugifyLearnedCapabilityName(record.slug)
    || !Number.isSafeInteger(record.revision)
    || record.revision < 1) {
    throw new LearningCapabilityError('invalid_record', 'invalid learned capability record');
  }
}

function matchesQuery(record: LearnedCapabilityRecord, query: LearningQuery): boolean {
  if (query.carrier !== undefined && record.carrier !== query.carrier) return false;
  if (query.lifecycle !== undefined && record.lifecycle !== query.lifecycle) return false;
  if (query.search === undefined) return true;
  const needle = query.search.trim().toLowerCase();
  return record.displayName.toLowerCase().includes(needle) || record.slug.includes(needle);
}

function compareCapabilities(left: LearnedCapabilityRecord, right: LearnedCapabilityRecord): number {
  const priority: Readonly<Record<LearnedCapabilityLifecycle, number>> = {
    ready: 0,
    quarantined: 1,
    active_learned: 2,
    testing: 3,
    drafting: 4,
    opportunity: 5,
    archived: 6,
    rejected: 7,
    promoted_user: 8,
  };
  return priority[left.lifecycle] - priority[right.lifecycle]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.slug.localeCompare(right.slug);
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new LearningCapabilityError('invalid_record', 'learning query cursor is invalid');
  }
  return offset;
}

function selectCurrentEvents(
  capabilities: readonly LearnedCapabilityRecord[],
  events: readonly LearningEvent[],
): readonly LearningEvent[] {
  const revisions = new Map(capabilities.map((entry) => [entry.capabilityId, entry.revision]));
  return events.filter((event) => revisions.get(event.capabilityId) === event.capabilityRevision);
}

function countActionable(
  events: readonly LearningEvent[],
  client: LearningClientRecord,
  kind: LearningEvent['kind'],
  now: string,
): number {
  return events.filter((event) => event.kind === kind && isActionable(event, client, now)).length;
}

function isActionable(event: LearningEvent, client: LearningClientRecord, now: string): boolean {
  const state = client.events[event.eventId];
  if (state === undefined || state.state === 'unread' || state.state === 'seen') return true;
  if (state.state === 'acknowledged') return false;
  return state.snoozedUntil === undefined || state.snoozedUntil <= now;
}
