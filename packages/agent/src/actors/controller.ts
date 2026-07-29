import {
  AgentBudgetExhaustedError,
  AgentControlError,
  AgentOwnerConflictError,
  AgentOwnerUnknownError,
  AgentRevisionConflictError,
} from './errors.js';
import { AgentTurnScheduler } from './scheduler.js';
import type {
  AgentActor,
  AgentActorClient,
  AgentActorOwner,
  AgentArtifactDescriptor,
  AgentActorSnapshot,
  AgentActorStore,
  AgentBudgetPort,
  AgentCapabilities,
  AgentDataClassification,
  AgentDetail,
  AgentEvent,
  AgentExecutionKind,
  AgentExecutionResult,
  AgentTurnExecutor,
  AgentFollowupResult,
  AgentForkTurns,
  AgentInterruptScope,
  AgentListEntry,
  AgentMailboxMessage,
  AgentMetadataValue,
  AgentMutationOptions,
  AgentOutput,
  AgentProgressItem,
  AgentProgressUpdate,
  AgentSpawnInput,
  AgentTreeSnapshot,
  AgentTurn,
  AgentTurnRef,
} from './types.js';

const ROOT_PATH = '/root' as const;
const DEFAULT_MAX_CONCURRENT_THREADS = 4;
const MAX_MESSAGE_LENGTH = 32_768;
const MAX_FORWARD_DEPTH = 5;
const MAX_PROGRESS_ITEMS = 6;
const MAX_PROGRESS_SUMMARY_LENGTH = 240;
const MAX_LIST_SUMMARY_LENGTH = 480;
const MAX_OUTPUT_PREVIEW_LENGTH = 8_192;
const MAX_EVENT_ITEMS = 2_048;
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

export interface AgentControllerOptions {
  readonly maxConcurrentThreadsPerSession?: number;
  readonly rootCapabilities?: AgentCapabilities;
  readonly executor?: AgentTurnExecutor;
  readonly executorFor?: (kind: AgentExecutionKind) => AgentTurnExecutor;
  readonly budget?: AgentBudgetPort;
  readonly store?: AgentActorStore;
  /** Unique Runtime/controller claim for one durable Session Actor tree. */
  readonly owner?: AgentActorOwner;
  /** Conservative liveness probe for a persisted foreign owner. Omitted means alive. */
  readonly isOwnerAlive?: (owner: AgentActorOwner) => boolean | Promise<boolean>;
  readonly now?: () => string;
  readonly warn?: (message: string) => void;
  readonly onBackgroundError?: (error: unknown) => void;
  /** Post-durability event sink. Callback failures never roll back committed actor state. */
  readonly onEventCommitted?: (event: AgentEvent) => void | Promise<void>;
  /** Post-durability mailbox sink. Callback failures never roll back committed actor state. */
  readonly onMessageCommitted?: (message: AgentMailboxMessage) => void | Promise<void>;
}

interface EventWaiter {
  readonly callerPath: string;
  readonly afterSequence: number;
  readonly resolve: (event: AgentEvent | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface StartPlan {
  readonly actor: AgentActor;
  readonly turn: AgentTurn;
  readonly createdActor: boolean;
  readonly abortController: AbortController;
}

const UNLIMITED_BUDGET: AgentBudgetPort = {
  async admit() { return { admitted: true }; },
};

const EMPTY_EXECUTOR: AgentTurnExecutor = {
  async execute() { return { output: '' }; },
};

export class AgentActorController {
  private readonly actors = new Map<string, AgentActor>();
  private readonly turns = new Map<string, AgentTurn>();
  private readonly mailboxes = new Map<string, AgentMailboxMessage[]>();
  private readonly acknowledgedCompletionTurnIds = new Set<string>();
  private readonly pendingRootCompletionTurnIds = new Set<string>();
  private readonly eventsLog: AgentEvent[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly scheduler: AgentTurnScheduler;
  private readonly budget: AgentBudgetPort;
  private readonly now: () => string;
  private mutationTail: Promise<void> = Promise.resolve();
  private revision = 0;
  private snapshotSchemaVersion: 1 | 2;
  private durableOwner?: AgentActorOwner;
  private initialized = false;
  private ownershipLost = false;
  private ownershipReleased = false;
  private committedSnapshot: AgentActorSnapshot;

  constructor(private readonly options: AgentControllerOptions = {}) {
    const max = options.maxConcurrentThreadsPerSession ?? DEFAULT_MAX_CONCURRENT_THREADS;
    this.scheduler = new AgentTurnScheduler(max);
    this.budget = options.budget ?? UNLIMITED_BUDGET;
    this.now = options.now ?? (() => new Date().toISOString());
    this.snapshotSchemaVersion = options.owner ? 2 : 1;
    if (max >= 8) options.warn?.(`Agent concurrency is ${max}; available slots include the current Agent.`);
    this.installRoot(options.rootCapabilities ?? defaultRootCapabilities());
    this.committedSnapshot = this.snapshot();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // A failed initialization may have claimed and then cleanly released this
    // controller's owner. Retrying the same instance must begin a fresh
    // ownership lifecycle; successful shutdown remains idempotent because an
    // initialized controller returned above.
    if (this.ownershipReleased) this.ownershipReleased = false;
    const snapshot = await this.options.store?.load();
    if (snapshot) {
      validateSnapshot(snapshot, this.scheduler.maxConcurrentThreads);
      this.restore(snapshot);
      this.committedSnapshot = this.snapshot();
    }
    let ownershipClaimed = false;
    try {
      if (this.options.owner) {
        if (
          snapshot?.schemaVersion === 1
          && snapshot.turns.some((turn) => !isTerminal(turn.state))
        ) {
          throw new AgentOwnerUnknownError(snapshot.revision);
        }
        ownershipClaimed = await this.claimOwnership();
      } else if (this.snapshotSchemaVersion === 2) {
        throw new AgentOwnerConflictError(
          this.durableOwner?.runtimeId,
          this.revision,
          false,
        );
      }
      this.republishUnacknowledgedRootCompletions();
      await this.recoverUnmatchedTurns();
      this.initialized = true;
    } catch (error: unknown) {
      if (ownershipClaimed) {
        try {
          await this.releaseOwnershipAfterInitializationFailure();
        } catch (releaseError: unknown) {
          throw new AggregateError(
            [error, releaseError],
            'Actor initialization failed and its newly claimed owner fence could not be released.',
          );
        }
      }
      throw error;
    }
  }

  ownsDurableFence(): boolean {
    return this.options.owner !== undefined
      && this.durableOwner?.ownerId === this.options.owner.ownerId
      && !this.ownershipLost
      && !this.ownershipReleased;
  }

  bind(callerPath: string): AgentActorClient {
    this.requireCommittedActor(callerPath);
    return Object.freeze({
      callerPath,
      spawn: (input: AgentSpawnInput, options?: AgentMutationOptions) => (
        this.spawn(callerPath, input, options)
      ),
      send: (
        targetPath: string,
        content: string,
        classification?: AgentDataClassification,
        forwardedMessageId?: string,
      ) => this.send(callerPath, targetPath, content, classification, forwardedMessageId),
      followup: (
        targetPath: string,
        objective: string,
        metadata?: Readonly<Record<string, AgentMetadataValue>>,
        options?: AgentMutationOptions,
      ) => (
        this.followup(callerPath, targetPath, objective, metadata, options)
      ),
      interrupt: (targetPath: string, reason?: string, scope?: AgentInterruptScope) => (
        this.interrupt(callerPath, targetPath, reason, scope)
      ),
      acknowledgeCompletions: (turnIds: readonly string[]) => (
        this.acknowledgeCompletions(callerPath, turnIds)
      ),
      list: () => this.list(callerPath),
      get: (targetPath: string) => this.get(callerPath, targetPath),
      output: (targetPath: string, turnId?: string) => this.output(callerPath, targetPath, turnId),
      eventSnapshot: (afterSequence?: number) => this.eventSnapshot(callerPath, afterSequence),
      wait: (afterSequence?: number, timeoutMs?: number, signal?: AbortSignal) => (
        this.wait(callerPath, afterSequence, timeoutMs, signal)
      ),
    });
  }

  /** Trusted host API: register a zero-slot Workflow protocol owner in this tree. */
  async createProtocolOwner(callerPath: string, ownerId: string): Promise<AgentActorClient> {
    const ownerPath = await this.mutate(() => {
      const parent = this.requireActor(callerPath);
      if (parent.path !== ROOT_PATH && parent.kind !== 'workflow') {
        throw new AgentControlError('permission_denied', `${callerPath} cannot own a Workflow protocol`);
      }
      if (parent.state === 'closed') {
        throw new AgentControlError('actor_closed', `${callerPath} is closed`);
      }
      validateProtocolOwnerId(ownerId);
      const taskName = `workflow:${ownerId}`;
      const path = `${callerPath}/${taskName}`;
      if (this.actors.has(path)) {
        throw new AgentControlError('name_collision', `actor already exists: ${path}`);
      }
      const idleActor = this.createActor(
        path,
        taskName,
        callerPath,
        'workflow',
        deriveCapabilities(parent.capabilities, undefined),
      );
      const turn = this.createTurn(idleActor, `Run Workflow ${ownerId}`, 'none', {
        protocolOwner: true,
      });
      const timestamp = this.now();
      this.actors.set(path, {
        ...idleActor,
        state: 'running',
        turnIds: [turn.turnId],
        currentTurnId: turn.turnId,
        updatedAt: timestamp,
        revision: idleActor.revision + 1,
      });
      this.turns.set(turn.turnId, {
        ...turn,
        state: 'running',
        startedAt: timestamp,
        revision: turn.revision + 1,
      });
      this.abortControllers.set(turn.turnId, new AbortController());
      this.mailboxes.set(path, []);
      this.appendEvent('actor_spawned', path, turn.turnId, callerPath);
      this.appendEvent('turn_started', path, turn.turnId, callerPath);
      return path;
    });
    return this.bind(ownerPath);
  }

  /** Trusted host API: settle a zero-slot Workflow protocol owner. */
  async settleProtocolOwner(
    ownerPath: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: AgentExecutionResult & { readonly error?: string },
  ): Promise<void> {
    await this.mutate(() => {
      const actor = this.requireActor(ownerPath);
      if (actor.kind !== 'workflow') {
        throw new AgentControlError('invalid_actor_path', `${ownerPath} is not a Workflow owner`);
      }
      if (!actor.currentTurnId) {
        const latestTurnId = actor.turnIds.at(-1);
        const latestTurn = latestTurnId ? this.requireTurn(latestTurnId) : undefined;
        if (latestTurn && isTerminal(latestTurn.state)) {
          if (latestTurn.structured === undefined && result.structured !== undefined) {
            this.turns.set(latestTurn.turnId, {
              ...latestTurn,
              ...(result.output === undefined ? {} : { output: result.output }),
              ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
              ...(result.artifactDetails === undefined
                ? {} : { artifactDetails: result.artifactDetails }),
              structured: result.structured,
              ...(latestTurn.error === undefined && result.error !== undefined
                ? { error: result.error }
                : {}),
              revision: latestTurn.revision + 1,
            });
          }
          return;
        }
        throw new AgentControlError('no_active_turn', `${ownerPath} has no active protocol turn`);
      }
      this.finishTurn(actor.currentTurnId, state, result);
    });
  }

  /** Trusted host API: cancellation signal for a zero-slot Workflow protocol owner. */
  protocolOwnerSignal(ownerPath: string): AbortSignal {
    const actor = this.requireActor(ownerPath);
    if (actor.kind !== 'workflow' || !actor.currentTurnId) {
      throw new AgentControlError('no_active_turn', `${ownerPath} has no active protocol turn`);
    }
    const abort = this.abortControllers.get(actor.currentTurnId);
    if (!abort) throw new AgentControlError('no_active_turn', `${ownerPath} has no cancellation signal`);
    return abort.signal;
  }

  async spawn(
    callerPath: string,
    input: AgentSpawnInput,
    options?: AgentMutationOptions,
  ): Promise<AgentTurnRef> {
    let admittedTurnId: string | undefined;
    try {
      const plan = await this.mutate(async () => {
        this.assertExpectedTreeRevision(options);
        const created = await this.prepareSpawn(callerPath, input);
        admittedTurnId = created.turn.turnId;
        return created;
      });
      this.launch(plan);
      return turnRef(plan.turn);
    } catch (error) {
      if (admittedTurnId) await this.budget.refund?.(admittedTurnId);
      throw error;
    }
  }

  async send(
    callerPath: string,
    targetPath: string,
    content: string,
    classification: AgentDataClassification = 'internal',
    forwardedMessageId?: string,
  ): Promise<AgentMailboxMessage> {
    return this.mutate(() => {
      this.assertMessagePermission(callerPath, targetPath);
      const forwarding = this.resolveForwarding(callerPath, targetPath, forwardedMessageId);
      const message = this.appendMessage(
        callerPath,
        targetPath,
        content,
        'message',
        forwarding.source
          ? moreRestrictedClassification(classification, forwarding.source.classification)
          : classification,
        this.actors.get(callerPath)?.currentTurnId,
        forwarding.lineage,
        forwardedMessageId,
      );
      this.appendEvent('message_delivered', targetPath, this.actors.get(targetPath)?.currentTurnId);
      return message;
    });
  }

  async acknowledgeCompletions(
    callerPath: string,
    turnIds: readonly string[],
  ): Promise<number> {
    const requested = new Set(turnIds);
    if (requested.size === 0) return 0;
    return this.mutate(() => {
      this.requireActor(callerPath);
      const observed = (this.mailboxes.get(callerPath) ?? []).filter((message) => (
        message.kind === 'completion'
        && message.turnId !== undefined
        && requested.has(message.turnId)
        && !this.acknowledgedCompletionTurnIds.has(message.turnId)
      ));
      for (const message of observed) {
        const turnId = message.turnId;
        if (turnId) {
          this.acknowledgedCompletionTurnIds.add(turnId);
          this.pendingRootCompletionTurnIds.delete(turnId);
        }
      }
      return observed.length;
    }, (count) => count > 0);
  }

  async followup(
    callerPath: string,
    targetPath: string,
    objective: string,
    metadata?: Readonly<Record<string, AgentMetadataValue>>,
    options?: AgentMutationOptions,
  ): Promise<AgentFollowupResult> {
    let admittedTurnId: string | undefined;
    try {
      const result = await this.mutate(async () => {
        this.assertExpectedTreeRevision(options);
        const actor = this.requireControl(callerPath, targetPath);
        if (
          options?.expectedRevision !== undefined
          && actor.revision !== options.expectedRevision
        ) {
          throw new AgentRevisionConflictError(options.expectedRevision, actor.revision);
        }
        if (actor.state === 'closed') throw new AgentControlError('actor_closed', `${targetPath} is closed`);
        if (actor.capabilities.control?.followup === false) {
          throw new AgentControlError('unsupported_operation', `${targetPath} does not support follow-up`);
        }
        if (actor.currentTurnId) {
          const turn = this.requireTurn(actor.currentTurnId);
          const requestedStrategy = metadata?.qualityStrategy;
          if (
            requestedStrategy !== undefined
            && !metadataValueEqual(requestedStrategy, turn.metadata?.qualityStrategy)
          ) {
            throw new AgentControlError(
              'invalid_message',
              `${targetPath} cannot change quality strategy while its current turn is running`,
            );
          }
          this.appendMessage(
            callerPath,
            targetPath,
            objective,
            'followup',
            'internal',
            this.actors.get(callerPath)?.currentTurnId,
          );
          return { delivery: 'current_turn' as const, turn: turnRef(turn) };
        }
        const plan = await this.prepareExistingTurn(actor, objective, metadata);
        admittedTurnId = plan.turn.turnId;
        return { delivery: 'started_turn' as const, turn: turnRef(plan.turn), plan };
      });
      if (result.delivery === 'started_turn') this.launch(result.plan);
      return { delivery: result.delivery, turn: result.turn };
    } catch (error) {
      if (admittedTurnId) await this.budget.refund?.(admittedTurnId);
      throw error;
    }
  }

  async interrupt(
    callerPath: string,
    targetPath: string,
    reason = 'interrupted',
    scope: AgentInterruptScope = 'turn',
  ): Promise<void> {
    try {
      const aborts = await this.mutate(() => {
        const target = this.requireControl(callerPath, targetPath);
        const actors = scope === 'subtree'
          ? this.descendantsInclusive(targetPath).reverse()
          : [target];
        const active = actors.filter((actor) => actor.currentTurnId !== undefined);
        if (active.length === 0) throw new AgentControlError('no_active_turn', `${targetPath} is idle`);
        for (const actor of active) {
          if (actor.capabilities.control?.interrupt === false) {
            throw new AgentControlError('unsupported_operation', `${actor.path} does not support interruption`);
          }
        }
        return active.flatMap((actor) => {
          const turnId = actor.currentTurnId;
          if (!turnId) return [];
          const abort = this.abortControllers.get(turnId);
          this.finishTurn(turnId, 'interrupted', { error: reason });
          return abort ? [abort] : [];
        });
      });
      for (const abort of aborts) abort.abort(reason);
    } catch (error) {
      if (
        error instanceof AgentOwnerConflictError
        && (
          error.localExecutionsAborted
          || this.isInterruptionDurable(callerPath, targetPath, scope)
        )
      ) {
        return;
      }
      throw error;
    }
  }

  async close(callerPath: string, targetPath: string, reason = 'closed by owner'): Promise<void> {
    const aborts = await this.mutate(() => {
      this.requireControl(callerPath, targetPath);
      const pendingAborts: AbortController[] = [];
      for (const actor of this.descendantsInclusive(targetPath).reverse()) {
        if (actor.currentTurnId) {
          const abort = this.abortControllers.get(actor.currentTurnId);
          if (abort) pendingAborts.push(abort);
          this.finishTurn(
            actor.currentTurnId,
            'interrupted',
            { error: reason },
            actor.path === targetPath,
          );
        }
        const current = this.requireActor(actor.path);
        this.actors.set(actor.path, {
          ...current,
          state: 'closed',
          currentTurnId: undefined,
          updatedAt: this.now(),
          revision: current.revision + 1,
        });
        this.appendEvent('actor_closed', actor.path);
      }
      return pendingAborts;
    });
    for (const abort of aborts) abort.abort(reason);
  }

  /**
   * Final local teardown after the host has durably removed the backing store.
   * No mutation is allowed here because there is no longer a snapshot to save.
   */
  disposeAfterStoreRemoval(reason = 'backing store removed'): void {
    if (this.ownershipReleased) return;
    this.ownershipReleased = true;
    const aborts = [...new Set(this.abortControllers.values())];
    this.abortControllers.clear();
    for (const abort of aborts) abort.abort(reason);
    for (const waiter of [...this.waiters]) waiter.resolve(undefined);
  }

  /** Interrupts every local execution while retaining the durable owner fence. */
  async quiesce(reason = 'runtime quiesced'): Promise<void> {
    if (this.ownershipReleased) return;
    const aborts = await this.mutate(() => {
      const pendingAborts: AbortController[] = [];
      for (const turn of this.turns.values()) {
        if (isTerminal(turn.state)) continue;
        const abort = this.abortControllers.get(turn.turnId);
        if (abort) pendingAborts.push(abort);
        this.finishTurn(turn.turnId, 'interrupted', { error: reason });
      }
      return pendingAborts;
    });
    for (const abort of aborts) abort.abort(reason);
  }

  /** Stops in-flight work for process shutdown while preserving reusable Actor identities. */
  async shutdown(reason = 'runtime stopped'): Promise<void> {
    if (this.ownershipReleased) return;
    try {
      const aborts = await this.mutate(() => {
        const pendingAborts: AbortController[] = [];
        for (const turn of this.turns.values()) {
          if (isTerminal(turn.state)) continue;
          const abort = this.abortControllers.get(turn.turnId);
          if (abort) pendingAborts.push(abort);
          this.finishTurn(turn.turnId, 'interrupted', { error: reason });
        }
        return pendingAborts;
      });
      for (const abort of aborts) abort.abort(reason);
      if (this.options.owner) {
        await this.mutate(() => {
          this.durableOwner = undefined;
        });
        this.ownershipReleased = true;
      }
      for (const waiter of [...this.waiters]) waiter.resolve(undefined);
    } catch (error) {
      if (
        error instanceof AgentOwnerConflictError
        && (this.ownershipLost || this.ownershipReleased)
      ) {
        return;
      }
      throw error;
    }
  }

  list(callerPath: string): AgentTreeSnapshot {
    this.requireCommittedActor(callerPath);
    const kindByPath = new Map(
      this.committedSnapshot.actors.map((actor) => [actor.path, actor.kind]),
    );
    return {
      rootPath: ROOT_PATH,
      actors: this.visibleActors(callerPath).map((actor) => ({
        ...actor,
        ...this.latestTurnSummary(actor),
      })),
      activeNonRootTurns: this.committedSnapshot.turns.filter((turn) => (
        !isTerminal(turn.state) && kindByPath.get(turn.actorPath) !== 'workflow'
      )).length,
      maxConcurrentThreads: this.committedSnapshot.maxConcurrentThreads,
      revision: this.committedSnapshot.revision,
    };
  }

  get(callerPath: string, targetPath: string): AgentDetail {
    if (!this.isVisible(callerPath, targetPath)) {
      throw new AgentControlError('permission_denied', `${callerPath} cannot inspect ${targetPath}`);
    }
    const actor = this.requireCommittedActor(targetPath);
    return {
      actor,
      turns: actor.turnIds.map((turnId) => this.requireCommittedTurn(turnId)),
      mailbox: [...(this.committedSnapshot.mailboxes[targetPath] ?? [])],
    };
  }

  output(callerPath: string, targetPath: string, turnId?: string): AgentOutput {
    this.requireCommittedControl(callerPath, targetPath);
    const actor = this.requireCommittedActor(targetPath);
    const selected = turnId ?? actor.turnIds.at(-1);
    if (!selected) throw new AgentControlError('no_active_turn', `${targetPath} has no turns`);
    if (!actor.turnIds.includes(selected)) {
      throw new AgentControlError(
        'permission_denied',
        `turn ${selected} does not belong to ${targetPath}`,
      );
    }
    const turn = this.requireCommittedTurn(selected);
    if (turn.actorPath !== actor.path) {
      throw new AgentControlError(
        'permission_denied',
        `turn ${selected} does not belong to ${targetPath}`,
      );
    }
    const output = turn.output === undefined
      ? undefined
      : boundedTextEdges(turn.output, MAX_OUTPUT_PREVIEW_LENGTH, '\n... [truncated] ...\n');
    const descriptors = artifactDetails(turn);
    return {
      actorPath: actor.path,
      turnId: turn.turnId,
      state: turn.state,
      ...(output === undefined ? {} : {
        output: output.text,
        ...(output.truncated ? { outputTruncated: true } : {}),
      }),
      artifacts: turn.artifacts ?? [],
      ...(descriptors.length === 0 ? {} : { artifactDetails: descriptors }),
      progress: turn.progress ?? [],
      ...(turn.structured === undefined ? {} : { structured: turn.structured }),
      ...(turn.error === undefined ? {} : { error: turn.error }),
    };
  }

  eventSnapshot(callerPath: string, afterSequence = 0): readonly AgentEvent[] {
    this.requireCommittedActor(callerPath);
    return this.committedSnapshot.events.filter((event) => (
      event.sequence > afterSequence
      && this.isVisible(callerPath, event.actorPath)
      && !this.isAcknowledgedDirectChildTerminal(callerPath, event)
    ));
  }

  private isAcknowledgedDirectChildTerminal(
    callerPath: string,
    event: AgentEvent,
  ): boolean {
    if (!event.turnId || !isTerminalEvent(event)) return false;
    if (!this.acknowledgedCompletionTurnIds.has(event.turnId)) return false;
    const actor = this.committedSnapshot.actors.find((candidate) => (
      candidate.path === event.actorPath
    ));
    return actor?.parentPath === callerPath;
  }

  async wait(
    callerPath: string,
    afterSequence = 0,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<AgentEvent | undefined> {
    const existing = this.eventSnapshot(callerPath, afterSequence)[0];
    if (existing) return existing;
    if (signal?.aborted) return undefined;
    return new Promise<AgentEvent | undefined>((resolve) => {
      let waiter: EventWaiter | undefined;
      const settle = (event: AgentEvent | undefined): void => {
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', abortHandler);
        waiter = undefined;
        resolve(event);
      };
      const abortHandler = (): void => settle(undefined);
      waiter = {
        callerPath,
        afterSequence,
        resolve: settle,
        timer: setTimeout(() => settle(undefined), Math.max(0, timeoutMs)),
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
    });
  }

  private async prepareSpawn(callerPath: string, input: AgentSpawnInput): Promise<StartPlan> {
    const parent = this.requireActor(callerPath);
    if (parent.state === 'closed') throw new AgentControlError('actor_closed', `${callerPath} is closed`);
    validateTaskName(input.taskName);
    validateForkTurns(input.forkTurns ?? 'all');
    const path = `${callerPath}/${input.taskName}`;
    if (this.actors.has(path)) throw new AgentControlError('name_collision', `actor already exists: ${path}`);
    const capabilities = deriveCapabilities(parent.capabilities, input.capabilities);
    const actor = this.createActor(path, input.taskName, callerPath, input.kind ?? 'native', capabilities);
    return this.admitTurn(actor, input.objective, input.forkTurns ?? 'all', true, input.metadata);
  }

  private prepareExistingTurn(
    actor: AgentActor,
    objective: string,
    metadata?: Readonly<Record<string, AgentMetadataValue>>,
  ): Promise<StartPlan> {
    return this.admitTurn(actor, objective, 'all', false, metadata);
  }

  private async admitTurn(
    actor: AgentActor,
    objective: string,
    forkTurns: AgentForkTurns,
    createdActor: boolean,
    metadata?: AgentTurn['metadata'],
  ): Promise<StartPlan> {
    if (objective.trim().length === 0) throw new AgentControlError('invalid_message', 'objective is required');
    const turn = this.createTurn(actor, objective, forkTurns, metadata);
    this.scheduler.reserve(turn.turnId);
    const admission = await this.budget.admit({
      actorPath: actor.path,
      parentPath: actor.parentPath ?? ROOT_PATH,
      turnId: turn.turnId,
      kind: actor.kind,
      units: 1,
    });
    if (!admission.admitted) {
      this.scheduler.release(turn.turnId);
      throw new AgentBudgetExhaustedError(admission.fact.reason);
    }
    const abortController = this.commitStart(actor, turn, createdActor);
    return {
      actor: this.requireActor(actor.path),
      turn: this.requireTurn(turn.turnId),
      createdActor,
      abortController,
    };
  }

  private commitStart(
    actor: AgentActor,
    turn: AgentTurn,
    createdActor: boolean,
  ): AbortController {
    const timestamp = this.now();
    const abortController = new AbortController();
    const runningTurn: AgentTurn = { ...turn, state: 'running', startedAt: timestamp, revision: 2 };
    const current = createdActor ? actor : this.requireActor(actor.path);
    this.actors.set(actor.path, {
      ...current,
      state: 'running',
      turnIds: [...current.turnIds, turn.turnId],
      currentTurnId: turn.turnId,
      updatedAt: timestamp,
      revision: current.revision + 1,
    });
    this.turns.set(turn.turnId, runningTurn);
    this.abortControllers.set(turn.turnId, abortController);
    if (createdActor) this.mailboxes.set(actor.path, []);
    if (createdActor) this.appendEvent('actor_spawned', actor.path, turn.turnId, actor.parentPath);
    this.appendEvent('turn_started', actor.path, turn.turnId, actor.parentPath);
    return abortController;
  }

  private launch(plan: StartPlan): void {
    const abort = plan.abortController;
    if (abort.signal.aborted) return;
    const executor = this.options.executorFor?.(plan.actor.kind) ?? this.options.executor ?? EMPTY_EXECUTOR;
    const priorTurns = plan.actor.turnIds
      .filter((turnId) => turnId !== plan.turn.turnId)
      .map((turnId) => this.requireTurn(turnId));
    void Promise.resolve()
      .then(() => executor.execute({
        actor: plan.actor,
        turn: plan.turn,
        priorTurns,
        signal: abort.signal,
        drainMailbox: () => this.drainMailbox(plan.actor.path),
        reportProgress: (update) => this.recordProgress(plan.turn.turnId, update),
      }))
      .then(
        (result) => this.completeExecution(plan.turn.turnId, result),
        (error: unknown) => this.failExecution(plan.turn.turnId, error),
      )
      .catch((error: unknown) => {
        if (
          error instanceof AgentOwnerConflictError
          && (this.ownershipLost || this.ownershipReleased)
        ) {
          return;
        }
        this.reportBackgroundError(error);
      });
  }

  private async completeExecution(
    turnId: string,
    result: AgentExecutionResult,
  ): Promise<void> {
    await this.mutate(() => {
      const turn = this.turns.get(turnId);
      if (!turn || isTerminal(turn.state)) return false;
      this.finishTurn(turnId, 'completed', {
        output: result.output,
        artifacts: result.artifacts ?? [],
        ...(result.artifactDetails === undefined
          ? {} : { artifactDetails: result.artifactDetails }),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
        ...(result.turnMetadata === undefined ? {} : { turnMetadata: result.turnMetadata }),
      });
      return true;
    }, (changed) => changed);
  }

  private async failExecution(turnId: string, error: unknown): Promise<void> {
    await this.mutate(() => {
      const turn = this.turns.get(turnId);
      if (!turn || isTerminal(turn.state)) return false;
      this.finishTurn(turnId, 'failed', { error: error instanceof Error ? error.message : String(error) });
      return true;
    }, (changed) => changed);
  }

  private finishTurn(
    turnId: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: {
      readonly output?: string;
      readonly artifacts?: readonly string[];
      readonly artifactDetails?: readonly AgentArtifactDescriptor[];
      readonly structured?: AgentMetadataValue;
      readonly turnMetadata?: Readonly<Record<string, AgentMetadataValue>>;
      readonly error?: string;
    },
    notifyParent = true,
  ): void {
    const turn = this.requireTurn(turnId);
    if (isTerminal(turn.state)) return;
    const actor = this.requireActor(turn.actorPath);
    const timestamp = this.now();
    const { turnMetadata, ...turnResult } = result;
    this.turns.set(turnId, {
      ...turn,
      ...turnResult,
      ...(turnMetadata === undefined
        ? {}
        : { metadata: { ...turn.metadata, ...turnMetadata } }),
      state,
      completedAt: timestamp,
      revision: turn.revision + 1,
    });
    this.actors.set(actor.path, {
      ...actor, state: 'idle', currentTurnId: undefined, updatedAt: timestamp, revision: actor.revision + 1,
    });
    this.scheduler.release(turnId);
    this.abortControllers.delete(turnId);
    if (notifyParent && actor.parentPath) this.appendCompletion(actor, turnId, state, result);
    this.appendEvent(eventKindForTerminal(state), actor.path, turnId, actor.parentPath);
  }

  private appendCompletion(
    actor: AgentActor,
    turnId: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: { readonly output?: string; readonly error?: string },
  ): void {
    const rawSummary = nonEmptyText(result.output) ?? nonEmptyText(result.error) ?? state;
    const summary = rawSummary.length > MAX_MESSAGE_LENGTH
      ? `${rawSummary.slice(0, MAX_MESSAGE_LENGTH - 3).trimEnd()}...`
      : rawSummary;
    const recipientPath = actor.parentPath ?? ROOT_PATH;
    this.appendMessage(actor.path, recipientPath, summary, 'completion', 'internal', turnId);
    if (recipientPath === ROOT_PATH) this.pendingRootCompletionTurnIds.add(turnId);
  }

  private async drainMailbox(actorPath: string): Promise<readonly AgentMailboxMessage[]> {
    if (this.requireActor(actorPath).state === 'closed') {
      throw new AgentControlError('actor_closed', `${actorPath} is closed`);
    }
    if (this.unreadMailbox(actorPath).length === 0) return [];
    return this.mutate(() => {
      const actor = this.requireActor(actorPath);
      if (actor.state === 'closed') {
        throw new AgentControlError('actor_closed', `${actorPath} is closed`);
      }
      const unread = this.unreadMailbox(actorPath);
      if (unread.length > 0) {
        this.actors.set(actorPath, {
          ...actor,
          mailboxCursor: unread.at(-1)?.sequence ?? actor.mailboxCursor,
          updatedAt: this.now(),
          revision: actor.revision + 1,
        });
      }
      return unread;
    });
  }

  private unreadMailbox(actorPath: string): readonly AgentMailboxMessage[] {
    const actor = this.requireActor(actorPath);
    return (this.mailboxes.get(actorPath) ?? [])
      .filter((message) => (
        message.sequence > actor.mailboxCursor
        && (
          message.kind !== 'completion'
          || message.turnId === undefined
          || !this.acknowledgedCompletionTurnIds.has(message.turnId)
        )
      ));
  }

  private async recordProgress(turnId: string, update: AgentProgressUpdate): Promise<void> {
    await this.mutate(() => {
      const turn = this.requireTurn(turnId);
      if (isTerminal(turn.state)) return false;
      const summary = boundedText(update.summary.trim(), MAX_PROGRESS_SUMMARY_LENGTH).text;
      if (summary.length === 0) {
        throw new AgentControlError('invalid_message', 'progress summary is required');
      }
      const previous = turn.progress ?? [];
      const progress: AgentProgressItem = {
        sequence: (previous.at(-1)?.sequence ?? 0) + 1,
        kind: update.kind,
        summary,
        createdAt: this.now(),
      };
      this.turns.set(turnId, {
        ...turn,
        progress: [...previous, progress].slice(-MAX_PROGRESS_ITEMS),
        revision: turn.revision + 1,
      });
      this.appendEvent('turn_progress', turn.actorPath, turnId, undefined, progress);
      return true;
    }, (changed) => changed);
  }

  private resolveForwarding(
    senderPath: string,
    targetPath: string,
    forwardedMessageId: string | undefined,
  ): { readonly lineage: readonly string[]; readonly source?: AgentMailboxMessage } {
    const source = forwardedMessageId === undefined
      ? undefined
      : (this.mailboxes.get(senderPath) ?? []).find((message) => (
          message.messageId === forwardedMessageId && message.recipientPath === senderPath
        ));
    if (forwardedMessageId !== undefined && !source) {
      throw new AgentControlError(
        'invalid_forward_reference',
        `${senderPath} did not receive message ${forwardedMessageId}`,
      );
    }
    const priorLineage = source?.lineage ?? (source ? [source.senderPath] : []);
    const lineage = [...priorLineage, senderPath];
    if (lineage.length > MAX_FORWARD_DEPTH) {
      throw new AgentControlError(
        'message_cycle_detected',
        `forwarding depth exceeds ${MAX_FORWARD_DEPTH}: ${lineage.join(' -> ')}`,
      );
    }
    if (new Set(lineage).size !== lineage.length || lineage.includes(targetPath)) {
      throw new AgentControlError(
        'message_cycle_detected',
        `message target ${targetPath} is already in the forwarding chain`,
      );
    }
    return { lineage, ...(source ? { source } : {}) };
  }

  private appendMessage(
    senderPath: string,
    recipientPath: string,
    content: string,
    kind: AgentMailboxMessage['kind'],
    classification: AgentDataClassification,
    turnId?: string,
    lineage: readonly string[] = [senderPath],
    forwardedMessageId?: string,
  ): AgentMailboxMessage {
    if (content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
      throw new AgentControlError('invalid_message', `message length must be 1-${MAX_MESSAGE_LENGTH}`);
    }
    const mailbox = this.mailboxes.get(recipientPath) ?? [];
    const message: AgentMailboxMessage = {
      messageId: `msg_${mailbox.length + 1}_${this.eventsLog.length + 1}`,
      sequence: (mailbox.at(-1)?.sequence ?? 0) + 1,
      senderPath,
      recipientPath,
      ...(turnId === undefined ? {} : { turnId }),
      kind,
      classification,
      lineage,
      ...(forwardedMessageId === undefined ? {} : { forwardedMessageId }),
      content,
      createdAt: this.now(),
    };
    this.mailboxes.set(recipientPath, [...mailbox, message]);
    return message;
  }

  private appendEvent(
    kind: AgentEvent['kind'],
    actorPath: string,
    turnId?: string,
    parentPath?: string,
    progress?: AgentProgressItem,
  ): void {
    this.eventsLog.push({
      sequence: (this.eventsLog.at(-1)?.sequence ?? 0) + 1,
      kind,
      actorPath,
      ...(turnId === undefined ? {} : { turnId }),
      ...(parentPath === undefined ? {} : { parentPath }),
      ...(progress === undefined ? {} : { progress }),
      createdAt: this.now(),
    });
    if (this.eventsLog.length > MAX_EVENT_ITEMS) {
      this.eventsLog.splice(0, this.eventsLog.length - MAX_EVENT_ITEMS);
    }
  }

  private requireControl(callerPath: string, targetPath: string): AgentActor {
    const caller = this.requireActor(callerPath);
    const target = this.requireActor(targetPath);
    if (caller.path !== ROOT_PATH && target.parentPath !== caller.path) {
      throw new AgentControlError('permission_denied', `${callerPath} cannot control ${targetPath}`);
    }
    return target;
  }

  private assertMessagePermission(callerPath: string, targetPath: string): void {
    const caller = this.requireActor(callerPath);
    const target = this.requireActor(targetPath);
    if (caller.state === 'closed') {
      throw new AgentControlError('actor_closed', `${callerPath} is closed`);
    }
    if (target.state === 'closed') {
      throw new AgentControlError('actor_closed', `${targetPath} is closed`);
    }
    const allowed = caller.path === ROOT_PATH
      || target.path === caller.parentPath
      || target.parentPath === caller.path
      || (caller.parentPath !== undefined && caller.parentPath === target.parentPath);
    if (!allowed) throw new AgentControlError('permission_denied', `${callerPath} cannot message ${targetPath}`);
  }

  private isVisible(callerPath: string, targetPath: string): boolean {
    const caller = this.requireCommittedActor(callerPath);
    const target = this.requireCommittedActor(targetPath);
    if (caller.path === ROOT_PATH) return true;
    if (target.path === caller.path || target.path.startsWith(`${caller.path}/`)) return true;
    return target.path === caller.parentPath
      || (caller.parentPath !== undefined && target.parentPath === caller.parentPath);
  }

  private visibleActors(callerPath: string): readonly AgentActor[] {
    return this.committedSnapshot.actors
      .filter((actor) => this.isVisible(callerPath, actor.path))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private latestTurnSummary(actor: AgentActor): Pick<AgentListEntry, 'latestTurn'> {
    const turnId = actor.turnIds.at(-1);
    if (!turnId) return {};
    const turn = this.requireCommittedTurn(turnId);
    const rawSummary = nonEmptyText(turn.output) ?? nonEmptyText(turn.error) ?? turn.state;
    const normalizedSummary = rawSummary.replace(/\s+/gu, ' ').trim();
    const summary = boundedTextEdges(normalizedSummary, MAX_LIST_SUMMARY_LENGTH, ' ... ');
    return {
      latestTurn: {
        turnId,
        state: turn.state,
        summary: summary.text,
        summaryTruncated: summary.truncated,
        recentActivity: turn.progress ?? [],
      },
    };
  }

  private descendantsInclusive(path: string): AgentActor[] {
    return [...this.actors.values()]
      .filter((actor) => actor.path === path || actor.path.startsWith(`${path}/`))
      .sort((left, right) => left.path.length - right.path.length);
  }

  private createActor(
    path: string,
    taskName: string,
    parentPath: string,
    kind: AgentExecutionKind,
    capabilities: AgentCapabilities,
  ): AgentActor {
    const timestamp = this.now();
    return {
      path, taskName, parentPath, kind, capabilities,
      state: 'idle', turnIds: [], mailboxCursor: 0,
      createdAt: timestamp, updatedAt: timestamp, revision: 1,
    };
  }

  private createTurn(
    actor: AgentActor,
    objective: string,
    forkTurns: AgentForkTurns,
    metadata?: AgentTurn['metadata'],
  ): AgentTurn {
    const sequence = actor.turnIds.length + 1;
    return {
      turnId: `turn_${actor.path.slice(1).replace(/[^a-zA-Z0-9]+/g, '_')}_${sequence}`,
      actorPath: actor.path,
      sequence,
      state: 'accepted',
      objective,
      forkTurns,
      ...(metadata === undefined ? {} : { metadata }),
      createdAt: this.now(),
      progress: [],
      revision: 1,
    };
  }

  private requireActor(path: string): AgentActor {
    const actor = this.actors.get(path);
    if (!actor) throw new AgentControlError('actor_not_found', `actor not found: ${path}`);
    return actor;
  }

  private requireTurn(turnId: string): AgentTurn {
    const turn = this.turns.get(turnId);
    if (!turn) throw new AgentControlError('no_active_turn', `turn not found: ${turnId}`);
    return turn;
  }

  private requireCommittedActor(path: string): AgentActor {
    const actor = this.committedSnapshot.actors.find((candidate) => candidate.path === path);
    if (!actor) throw new AgentControlError('actor_not_found', `actor not found: ${path}`);
    return actor;
  }

  private requireCommittedTurn(turnId: string): AgentTurn {
    const turn = this.committedSnapshot.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new AgentControlError('no_active_turn', `turn not found: ${turnId}`);
    return turn;
  }

  private requireCommittedControl(callerPath: string, targetPath: string): AgentActor {
    const caller = this.requireCommittedActor(callerPath);
    const target = this.requireCommittedActor(targetPath);
    if (caller.path !== ROOT_PATH && target.parentPath !== caller.path) {
      throw new AgentControlError('permission_denied', `${callerPath} cannot control ${targetPath}`);
    }
    return target;
  }

  private installRoot(capabilities: AgentCapabilities): void {
    const timestamp = this.now();
    this.actors.set(ROOT_PATH, {
      path: ROOT_PATH,
      taskName: 'root',
      kind: 'native',
      state: 'running',
      capabilities,
      turnIds: [],
      mailboxCursor: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    });
    this.mailboxes.set(ROOT_PATH, []);
  }

  private async mutate<T>(
    operation: () => T | Promise<T>,
    shouldCommit: (result: T) => boolean = () => true,
    allowOwnershipClaim = false,
  ): Promise<T> {
    const previousTail = this.mutationTail;
    let release: () => void = () => {};
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTail;
    const before = this.snapshot();
    const beforeAborts = new Map(this.abortControllers);
    const priorEventSequence = this.eventsLog.at(-1)?.sequence ?? 0;
    try {
      if (!allowOwnershipClaim) this.assertWritableOwner();
      const result = await operation();
      if (!shouldCommit(result)) {
        this.restore(before);
        replaceMap(this.abortControllers, [...beforeAborts.entries()]);
        return result;
      }
      const expectedRevision = this.revision;
      this.revision += 1;
      await this.options.store?.save(this.snapshot(), expectedRevision);
      this.committedSnapshot = this.snapshot();
      for (const message of appendedMessages(before, this.committedSnapshot)) {
        this.publishCommittedMessage(message);
      }
      for (const event of this.eventsLog) {
        if (event.sequence > priorEventSequence) this.publishCommittedEvent(event);
      }
      return result;
    } catch (error) {
      const conflict = actorSnapshotConflictFact(error);
      if (conflict) {
        throw await this.fenceAfterSnapshotConflict(
          conflict,
          before,
          beforeAborts,
        );
      }
      this.restore(before);
      replaceMap(this.abortControllers, [...beforeAborts.entries()]);
      throw error;
    } finally {
      release();
    }
  }

  private snapshot(): AgentActorSnapshot {
    const contents = {
      revision: this.revision,
      maxConcurrentThreads: this.scheduler.maxConcurrentThreads,
      actors: [...this.actors.values()],
      turns: [...this.turns.values()],
      mailboxes: Object.fromEntries([...this.mailboxes.entries()]),
      ...(this.acknowledgedCompletionTurnIds.size > 0
        ? { acknowledgedCompletionTurnIds: [...this.acknowledgedCompletionTurnIds] }
        : {}),
      ...(this.pendingRootCompletionTurnIds.size > 0
        ? { pendingRootCompletionTurnIds: [...this.pendingRootCompletionTurnIds] }
        : {}),
      events: [...this.eventsLog],
    };
    return this.snapshotSchemaVersion === 2
      ? {
          schemaVersion: 2,
          ...contents,
          ...(this.durableOwner ? { owner: this.durableOwner } : {}),
        }
      : { schemaVersion: 1, ...contents };
  }

  private restore(snapshot: AgentActorSnapshot): void {
    this.snapshotSchemaVersion = snapshot.schemaVersion;
    this.durableOwner = snapshot.schemaVersion === 2 ? snapshot.owner : undefined;
    this.revision = snapshot.revision;
    replaceMap(this.actors, snapshot.actors.map((actor) => [actor.path, actor]));
    replaceMap(this.turns, snapshot.turns.map((turn) => [turn.turnId, turn]));
    replaceMap(this.mailboxes, Object.entries(snapshot.mailboxes).map(([path, messages]) => [path, [...messages]]));
    this.acknowledgedCompletionTurnIds.clear();
    for (const turnId of snapshot.acknowledgedCompletionTurnIds ?? []) {
      this.acknowledgedCompletionTurnIds.add(turnId);
    }
    this.pendingRootCompletionTurnIds.clear();
    for (const turnId of snapshot.pendingRootCompletionTurnIds ?? []) {
      this.pendingRootCompletionTurnIds.add(turnId);
    }
    this.eventsLog.splice(0, this.eventsLog.length, ...snapshot.events);
    const kindByPath = new Map(snapshot.actors.map((actor) => [actor.path, actor.kind]));
    this.scheduler.restore(snapshot.turns
      .filter((turn) => !isTerminal(turn.state) && kindByPath.get(turn.actorPath) !== 'workflow')
      .map((turn) => turn.turnId));
  }

  private republishUnacknowledgedRootCompletions(): void {
    for (const message of this.mailboxes.get(ROOT_PATH) ?? []) {
      if (
        message.kind === 'completion'
        && message.turnId !== undefined
        && this.pendingRootCompletionTurnIds.has(message.turnId)
        && !this.acknowledgedCompletionTurnIds.has(message.turnId)
      ) {
        this.publishCommittedMessage(message);
      }
    }
  }

  private async recoverUnmatchedTurns(): Promise<void> {
    const active = [...this.turns.values()].filter((turn) => !isTerminal(turn.state));
    if (active.length === 0) return;
    await this.mutate(() => {
      for (const turn of active) {
        const actor = this.requireActor(turn.actorPath);
        if (actor.kind === 'external') {
          this.finishTurn(turn.turnId, 'failed', { error: 'external_state_unknown' });
          continue;
        }
        this.finishTurn(turn.turnId, 'interrupted', { error: 'runtime_recovered_without_executor' });
      }
    });
  }

  private async claimOwnership(): Promise<boolean> {
    const desired = this.options.owner;
    if (!desired) return false;
    const current = this.durableOwner;
    if (current?.ownerId === desired.ownerId) return false;
    if (current) {
      const probe = this.options.isOwnerAlive?.(current);
      const alive = probe === undefined ? true : await probe;
      if (alive) {
        throw new AgentOwnerConflictError(current.runtimeId, this.revision, false);
      }
    }
    await this.mutate(() => {
      this.snapshotSchemaVersion = 2;
      this.durableOwner = desired;
    }, () => true, true);
    return true;
  }

  private async releaseOwnershipAfterInitializationFailure(): Promise<void> {
    if (
      !this.options.owner
      || this.durableOwner?.ownerId !== this.options.owner.ownerId
      || this.ownershipLost
      || this.ownershipReleased
    ) {
      return;
    }
    await this.mutate(() => {
      this.durableOwner = undefined;
    });
    this.ownershipReleased = true;
  }

  private assertWritableOwner(): void {
    const desired = this.options.owner;
    if (this.ownershipLost || this.ownershipReleased) {
      throw new AgentOwnerConflictError(
        this.durableOwner?.runtimeId,
        this.revision,
        false,
      );
    }
    if (!desired) return;
    if (this.durableOwner?.ownerId !== desired.ownerId) {
      throw new AgentOwnerConflictError(
        this.durableOwner?.runtimeId,
        this.revision,
        false,
      );
    }
  }

  private async fenceAfterSnapshotConflict(
    conflict: ActorSnapshotConflictFact,
    before: AgentActorSnapshot,
    beforeAborts: ReadonlyMap<string, AbortController>,
  ): Promise<AgentOwnerConflictError> {
    this.restore(before);
    this.ownershipLost = true;
    const localAborts = [...new Set(beforeAborts.values())];
    replaceMap(this.abortControllers, []);
    for (const abort of localAborts) abort.abort('actor owner superseded');

    const priorCommitted = this.committedSnapshot;
    let ownerRuntimeId: string | undefined;
    let currentRevision = conflict.currentRevision;
    try {
      const latest = await this.options.store?.load();
      if (latest) {
        validateSnapshot(latest, this.scheduler.maxConcurrentThreads);
        this.restore(latest);
        replaceMap(this.abortControllers, []);
        this.committedSnapshot = this.snapshot();
        ownerRuntimeId = latest.schemaVersion === 2
          ? latest.owner?.runtimeId
          : undefined;
        currentRevision = latest.revision;
        for (const message of appendedMessages(priorCommitted, this.committedSnapshot)) {
          this.publishCommittedMessage(message);
        }
        const priorSequence = priorCommitted.events.at(-1)?.sequence ?? 0;
        for (const event of this.committedSnapshot.events) {
          if (event.sequence > priorSequence) this.publishCommittedEvent(event);
        }
      }
    } catch (refreshError) {
      this.options.warn?.(
        `Actor owner conflict refresh failed: ${
          refreshError instanceof Error ? refreshError.message : String(refreshError)
        }`,
      );
    }
    return new AgentOwnerConflictError(
      ownerRuntimeId,
      currentRevision,
      localAborts.length > 0,
    );
  }

  private isInterruptionDurable(
    callerPath: string,
    targetPath: string,
    scope: AgentInterruptScope,
  ): boolean {
    try {
      this.requireCommittedControl(callerPath, targetPath);
    } catch {
      return false;
    }
    const actors = scope === 'subtree'
      ? this.committedSnapshot.actors.filter((actor) => (
          actor.path === targetPath || actor.path.startsWith(`${targetPath}/`)
        ))
      : this.committedSnapshot.actors.filter((actor) => actor.path === targetPath);
    return actors.length > 0 && actors.every((actor) => {
      if (actor.currentTurnId) return false;
      const latestTurnId = actor.turnIds.at(-1);
      if (!latestTurnId) return false;
      return this.committedSnapshot.turns.find((turn) => turn.turnId === latestTurnId)?.state
        === 'interrupted';
    });
  }

  private notify(event: AgentEvent): void {
    for (const waiter of [...this.waiters]) {
      if (event.sequence <= waiter.afterSequence || !this.isVisible(waiter.callerPath, event.actorPath)) continue;
      waiter.resolve(event);
    }
  }

  private publishCommittedEvent(event: AgentEvent): void {
    this.notify(event);
    if (!this.options.onEventCommitted) return;
    try {
      void Promise.resolve(this.options.onEventCommitted(event))
        .catch((error: unknown) => this.reportBackgroundError(error));
    } catch (error) {
      this.reportBackgroundError(error);
    }
  }

  private publishCommittedMessage(message: AgentMailboxMessage): void {
    if (!this.options.onMessageCommitted) return;
    try {
      void Promise.resolve(this.options.onMessageCommitted(message))
        .catch((error: unknown) => this.reportBackgroundError(error));
    } catch (error) {
      this.reportBackgroundError(error);
    }
  }

  private reportBackgroundError(error: unknown): void {
    if (this.options.onBackgroundError) {
      this.options.onBackgroundError(error);
      return;
    }
    setTimeout(() => { throw error; }, 0);
  }

  private assertExpectedTreeRevision(options: AgentMutationOptions | undefined): void {
    if (
      options?.expectedTreeRevision !== undefined
      && this.revision !== options.expectedTreeRevision
    ) {
      throw new AgentRevisionConflictError(options.expectedTreeRevision, this.revision);
    }
  }
}

function nonEmptyText(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function artifactDetails(turn: AgentTurn): readonly AgentArtifactDescriptor[] {
  if (turn.artifactDetails) return turn.artifactDetails;
  return (turn.artifacts ?? []).map((reference) => ({ name: reference }));
}

function boundedText(value: string, maxLength: number): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  return {
    text: `${takeGraphemeSafeStart(value, Math.max(0, maxLength - 3)).trimEnd()}...`,
    truncated: true,
  };
}

function boundedTextEdges(
  value: string,
  maxLength: number,
  marker: string,
): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  const contentBudget = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = Math.floor(contentBudget / 2);
  return {
    text: `${takeGraphemeSafeStart(value, headLength).trimEnd()}${marker}${takeGraphemeSafeEnd(value, tailLength).trimStart()}`,
    truncated: true,
  };
}

function takeGraphemeSafeStart(value: string, maxCodeUnits: number): string {
  let end = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(value)) {
    if (end + part.segment.length > maxCodeUnits) break;
    end += part.segment.length;
  }
  return value.slice(0, end);
}

function takeGraphemeSafeEnd(value: string, maxCodeUnits: number): string {
  let used = 0;
  let start = value.length;
  const parts = [...GRAPHEME_SEGMENTER.segment(value)];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || used + part.segment.length > maxCodeUnits) break;
    used += part.segment.length;
    start = part.index;
  }
  return value.slice(start);
}

function moreRestrictedClassification(
  requested: AgentDataClassification,
  source: AgentDataClassification,
): AgentDataClassification {
  const rank: Readonly<Record<AgentDataClassification, number>> = {
    public: 0,
    internal: 1,
    sensitive: 2,
  };
  return rank[source] > rank[requested] ? source : requested;
}

export async function createAgentActorController(
  options: AgentControllerOptions = {},
): Promise<AgentActorController> {
  const controller = new AgentActorController(options);
  await controller.initialize();
  return controller;
}

function defaultRootCapabilities(): AgentCapabilities {
  return {
    tools: ['*'],
    filesystem: 'write',
    network: true,
    providers: ['*'],
    canAskUser: true,
    control: { followup: true, interrupt: true, streaming: true, artifacts: true },
  };
}

function validateTaskName(taskName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskName)
    || /^(?:root|workflow|external)(?:[-_]|$)/i.test(taskName)) {
    throw new AgentControlError('invalid_task_name', `invalid actor task_name: ${taskName}`);
  }
}

function validateProtocolOwnerId(ownerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(ownerId)) {
    throw new AgentControlError('invalid_task_name', `invalid Workflow owner id: ${ownerId}`);
  }
}

function validateForkTurns(value: AgentForkTurns): void {
  if (value === 'all' || value === 'none') return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentControlError('invalid_fork_turns', 'fork_turns must be all, none, or a positive integer');
  }
}

function deriveCapabilities(
  parent: AgentCapabilities,
  requested: Partial<AgentCapabilities> | undefined,
): AgentCapabilities {
  const child: AgentCapabilities = {
    tools: requested?.tools ?? parent.tools,
    filesystem: requested?.filesystem ?? parent.filesystem,
    network: requested?.network ?? parent.network,
    providers: requested?.providers ?? parent.providers,
    canAskUser: false,
    control: requested?.control ?? parent.control,
  };
  const valid = isSubset(child.tools, parent.tools)
    && isSubset(child.providers, parent.providers)
    && filesystemRank(child.filesystem) <= filesystemRank(parent.filesystem)
    && (!child.network || parent.network)
    && controlIsSubset(child.control, parent.control)
    && requested?.canAskUser !== true;
  if (!valid) throw new AgentControlError('invalid_capabilities', 'child capabilities cannot exceed parent authority');
  return child;
}

function controlIsSubset(
  child: AgentCapabilities['control'],
  parent: AgentCapabilities['control'],
): boolean {
  if (!child || !parent) return true;
  return (!child.followup || parent.followup)
    && (!child.interrupt || parent.interrupt)
    && (!child.streaming || parent.streaming)
    && (!child.artifacts || parent.artifacts);
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  return parent.includes('*') || child.every((entry) => parent.includes(entry));
}

function filesystemRank(value: AgentCapabilities['filesystem']): number {
  return value === 'none' ? 0 : value === 'read' ? 1 : 2;
}

function turnRef(turn: AgentTurn): AgentTurnRef {
  return { actorPath: turn.actorPath, turnId: turn.turnId, state: 'running' };
}

function isTerminal(state: AgentTurn['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'interrupted';
}

function eventKindForTerminal(state: 'completed' | 'failed' | 'interrupted'): AgentEvent['kind'] {
  if (state === 'completed') return 'turn_completed';
  if (state === 'failed') return 'turn_failed';
  return 'turn_interrupted';
}

function replaceMap<K, V>(target: Map<K, V>, entries: readonly (readonly [K, V])[]): void {
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.kind === 'turn_completed'
    || event.kind === 'turn_failed'
    || event.kind === 'turn_interrupted';
}

function appendedMessages(
  before: AgentActorSnapshot,
  after: AgentActorSnapshot,
): AgentMailboxMessage[] {
  const messages: AgentMailboxMessage[] = [];
  for (const [path, afterMailbox] of Object.entries(after.mailboxes)) {
    const beforeLength = before.mailboxes[path]?.length ?? 0;
    messages.push(...afterMailbox.slice(beforeLength));
  }
  return messages;
}

interface ActorSnapshotConflictFact {
  readonly expectedRevision: number;
  readonly currentRevision: number;
}

function actorSnapshotConflictFact(error: unknown): ActorSnapshotConflictFact | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Readonly<Record<string, unknown>>;
  if (
    record.code !== 'actor_snapshot_conflict'
    || typeof record.expectedRevision !== 'number'
    || typeof record.currentRevision !== 'number'
  ) {
    return undefined;
  }
  return {
    expectedRevision: record.expectedRevision,
    currentRevision: record.currentRevision,
  };
}

function metadataValueEqual(
  left: AgentMetadataValue | undefined,
  right: AgentMetadataValue | undefined,
): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => metadataValueEqual(entry, right[index]));
  }

  if (isMetadataRecord(left)) {
    if (!isMetadataRecord(right)) return false;
    const keys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return keys.length === rightKeys.length
      && keys.every((key, index) => (
        key === rightKeys[index]
        && metadataValueEqual(left[key], right[key])
      ));
  }
  return false;
}

function isMetadataRecord(
  value: AgentMetadataValue | undefined,
): value is Readonly<Record<string, AgentMetadataValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSnapshot(snapshot: AgentActorSnapshot, configuredMax: number): void {
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) {
    throw new Error('Unsupported actor snapshot schema.');
  }
  if (snapshot.schemaVersion === 2 && snapshot.owner) validateOwner(snapshot.owner);
  if (snapshot.maxConcurrentThreads !== configuredMax) {
    throw new Error('Actor snapshot concurrency does not match the root session setting.');
  }
  if (!snapshot.actors.some((actor) => actor.path === ROOT_PATH)) throw new Error('Actor snapshot has no root.');
  const completionTurnIds = new Set(Object.values(snapshot.mailboxes)
    .flatMap((mailbox) => mailbox)
    .filter((message): message is AgentMailboxMessage & { readonly turnId: string } => (
      message.kind === 'completion' && message.turnId !== undefined
    ))
    .map((message) => message.turnId));
  const rootCompletionTurnIds = new Set((snapshot.mailboxes[ROOT_PATH] ?? [])
    .filter((message): message is AgentMailboxMessage & { readonly turnId: string } => (
      message.kind === 'completion' && message.turnId !== undefined
    ))
    .map((message) => message.turnId));
  const terminalTurnIds = new Set(snapshot.turns
    .filter((turn) => isTerminal(turn.state))
    .map((turn) => turn.turnId));
  for (const turnId of snapshot.acknowledgedCompletionTurnIds ?? []) {
    if (!completionTurnIds.has(turnId)) {
      throw new Error(`Actor snapshot acknowledges an unknown completion turn: ${turnId}`);
    }
  }
  for (const turnId of snapshot.pendingRootCompletionTurnIds ?? []) {
    if (!rootCompletionTurnIds.has(turnId)) {
      throw new Error(`Actor snapshot tracks an unknown root completion turn: ${turnId}`);
    }
    if (!terminalTurnIds.has(turnId)) {
      throw new Error(`Actor snapshot root completion turn is missing or non-terminal: ${turnId}`);
    }
    if (snapshot.acknowledgedCompletionTurnIds?.includes(turnId)) {
      throw new Error(`Actor snapshot tracks an acknowledged root completion turn: ${turnId}`);
    }
  }
}

function validateOwner(owner: AgentActorOwner): void {
  if (
    owner.ownerId.trim().length === 0
    || owner.runtimeId.trim().length === 0
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || owner.startedAt.trim().length === 0
  ) {
    throw new Error('Actor snapshot has an invalid Runtime owner.');
  }
}
