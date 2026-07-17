import {
  AgentBudgetExhaustedError,
  AgentControlError,
} from './errors.js';
import { AgentTurnScheduler } from './scheduler.js';
import type {
  AgentActor,
  AgentActorSnapshot,
  AgentActorStore,
  AgentBudgetPort,
  AgentCapabilities,
  AgentDataClassification,
  AgentDetail,
  AgentEvent,
  AgentExecutionKind,
  AgentExecutor,
  AgentFollowupResult,
  AgentForkTurns,
  AgentMailboxMessage,
  AgentOutput,
  AgentSpawnInput,
  AgentTreeSnapshot,
  AgentTurn,
  AgentTurnRef,
} from './types.js';

const ROOT_PATH = '/root' as const;
const DEFAULT_MAX_CONCURRENT_THREADS = 4;
const MAX_MESSAGE_LENGTH = 32_768;

interface AgentControllerOptions {
  readonly maxConcurrentThreadsPerSession?: number;
  readonly rootCapabilities?: AgentCapabilities;
  readonly executor?: AgentExecutor;
  readonly executorFor?: (kind: AgentExecutionKind) => AgentExecutor;
  readonly budget?: AgentBudgetPort;
  readonly store?: AgentActorStore;
  readonly now?: () => string;
  readonly warn?: (message: string) => void;
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
}

const UNLIMITED_BUDGET: AgentBudgetPort = {
  async admit() { return { admitted: true }; },
};

const EMPTY_EXECUTOR: AgentExecutor = {
  async execute() { return { output: '' }; },
};

export class AgentActorController {
  private readonly actors = new Map<string, AgentActor>();
  private readonly turns = new Map<string, AgentTurn>();
  private readonly mailboxes = new Map<string, AgentMailboxMessage[]>();
  private readonly eventsLog: AgentEvent[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly scheduler: AgentTurnScheduler;
  private readonly budget: AgentBudgetPort;
  private readonly now: () => string;
  private mutationTail: Promise<void> = Promise.resolve();
  private revision = 0;

  constructor(private readonly options: AgentControllerOptions = {}) {
    const max = options.maxConcurrentThreadsPerSession ?? DEFAULT_MAX_CONCURRENT_THREADS;
    this.scheduler = new AgentTurnScheduler(max);
    this.budget = options.budget ?? UNLIMITED_BUDGET;
    this.now = options.now ?? (() => new Date().toISOString());
    if (max >= 8) options.warn?.(`Agent concurrency is ${max}; available slots include the current Agent.`);
    this.installRoot(options.rootCapabilities ?? defaultRootCapabilities());
  }

  async initialize(): Promise<void> {
    const snapshot = await this.options.store?.load();
    if (!snapshot) return;
    validateSnapshot(snapshot, this.scheduler.maxConcurrentThreads);
    this.restore(snapshot);
    await this.recoverUnmatchedTurns();
  }

  async spawn(callerPath: string, input: AgentSpawnInput): Promise<AgentTurnRef> {
    let admittedTurnId: string | undefined;
    try {
      const plan = await this.mutate(async () => {
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
  ): Promise<void> {
    await this.mutate(() => {
      this.assertMessagePermission(callerPath, targetPath);
      this.appendMessage(callerPath, targetPath, content, 'message', classification);
      this.appendEvent('message_delivered', targetPath, this.actors.get(targetPath)?.currentTurnId);
    });
  }

  async followup(
    callerPath: string,
    targetPath: string,
    objective: string,
  ): Promise<AgentFollowupResult> {
    let admittedTurnId: string | undefined;
    try {
      const result = await this.mutate(async () => {
        const actor = this.requireControl(callerPath, targetPath);
        if (actor.state === 'closed') throw new AgentControlError('actor_closed', `${targetPath} is closed`);
        if (actor.currentTurnId) {
          this.appendMessage(callerPath, targetPath, objective, 'followup', 'internal');
          const turn = this.requireTurn(actor.currentTurnId);
          return { delivery: 'current_turn' as const, turn: turnRef(turn) };
        }
        const plan = await this.prepareExistingTurn(actor, objective);
        admittedTurnId = plan.turn.turnId;
        return { delivery: 'started_turn' as const, turn: turnRef(plan.turn), plan };
      });
      if ('plan' in result) this.launch(result.plan);
      return { delivery: result.delivery, turn: result.turn };
    } catch (error) {
      if (admittedTurnId) await this.budget.refund?.(admittedTurnId);
      throw error;
    }
  }

  async interrupt(callerPath: string, targetPath: string, reason = 'interrupted'): Promise<void> {
    const turnId = await this.mutate(() => {
      const actor = this.requireControl(callerPath, targetPath);
      if (!actor.currentTurnId) throw new AgentControlError('no_active_turn', `${targetPath} is idle`);
      this.finishTurn(actor.currentTurnId, 'interrupted', { error: reason });
      return actor.currentTurnId;
    });
    this.abortControllers.get(turnId)?.abort(reason);
  }

  async close(callerPath: string, targetPath: string, reason = 'closed by owner'): Promise<void> {
    await this.mutate(() => {
      this.requireControl(callerPath, targetPath);
      for (const actor of this.descendantsInclusive(targetPath).reverse()) {
        if (actor.currentTurnId) this.finishTurn(actor.currentTurnId, 'interrupted', { error: reason });
        this.actors.set(actor.path, { ...actor, state: 'closed', currentTurnId: undefined });
        this.appendEvent('actor_closed', actor.path);
      }
    });
  }

  list(callerPath: string): AgentTreeSnapshot {
    this.requireActor(callerPath);
    return {
      rootPath: ROOT_PATH,
      actors: this.visibleActors(callerPath),
      activeNonRootTurns: this.scheduler.activeNonRootTurns,
      maxConcurrentThreads: this.scheduler.maxConcurrentThreads,
      revision: this.revision,
    };
  }

  get(callerPath: string, targetPath: string): AgentDetail {
    if (!this.isVisible(callerPath, targetPath)) {
      throw new AgentControlError('permission_denied', `${callerPath} cannot inspect ${targetPath}`);
    }
    const actor = this.requireActor(targetPath);
    return {
      actor,
      turns: actor.turnIds.map((turnId) => this.requireTurn(turnId)),
      mailbox: [...(this.mailboxes.get(targetPath) ?? [])],
    };
  }

  output(callerPath: string, targetPath: string, turnId?: string): AgentOutput {
    this.requireControl(callerPath, targetPath);
    const actor = this.requireActor(targetPath);
    const selected = turnId ?? actor.turnIds.at(-1);
    if (!selected) throw new AgentControlError('no_active_turn', `${targetPath} has no turns`);
    const turn = this.requireTurn(selected);
    return {
      actorPath: actor.path,
      turnId: turn.turnId,
      state: turn.state,
      ...(turn.output === undefined ? {} : { output: turn.output }),
      artifacts: turn.artifacts ?? [],
      ...(turn.error === undefined ? {} : { error: turn.error }),
    };
  }

  eventSnapshot(callerPath: string, afterSequence = 0): readonly AgentEvent[] {
    this.requireActor(callerPath);
    return this.eventsLog.filter((event) => (
      event.sequence > afterSequence && this.isVisible(callerPath, event.actorPath)
    ));
  }

  async wait(
    callerPath: string,
    afterSequence = 0,
    timeoutMs = 30_000,
  ): Promise<AgentEvent | undefined> {
    const existing = this.eventSnapshot(callerPath, afterSequence)[0];
    if (existing) return existing;
    return new Promise<AgentEvent | undefined>((resolve) => {
      const waiter: EventWaiter = {
        callerPath,
        afterSequence,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(undefined);
        }, Math.max(0, timeoutMs)),
      };
      this.waiters.add(waiter);
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
    return this.admitTurn(actor, input.objective, input.forkTurns ?? 'all', true);
  }

  private prepareExistingTurn(actor: AgentActor, objective: string): Promise<StartPlan> {
    return this.admitTurn(actor, objective, 'all', false);
  }

  private async admitTurn(
    actor: AgentActor,
    objective: string,
    forkTurns: AgentForkTurns,
    createdActor: boolean,
  ): Promise<StartPlan> {
    if (objective.trim().length === 0) throw new AgentControlError('invalid_message', 'objective is required');
    const turn = this.createTurn(actor, objective, forkTurns);
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
    this.commitStart(actor, turn, createdActor);
    return { actor: this.requireActor(actor.path), turn: this.requireTurn(turn.turnId), createdActor };
  }

  private commitStart(actor: AgentActor, turn: AgentTurn, createdActor: boolean): void {
    const timestamp = this.now();
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
    if (createdActor) this.mailboxes.set(actor.path, []);
    if (createdActor) this.appendEvent('actor_spawned', actor.path, turn.turnId, actor.parentPath);
    this.appendEvent('turn_started', actor.path, turn.turnId, actor.parentPath);
  }

  private launch(plan: StartPlan): void {
    const abort = new AbortController();
    this.abortControllers.set(plan.turn.turnId, abort);
    const executor = this.options.executorFor?.(plan.actor.kind) ?? this.options.executor ?? EMPTY_EXECUTOR;
    const priorTurns = plan.actor.turnIds
      .filter((turnId) => turnId !== plan.turn.turnId)
      .map((turnId) => this.requireTurn(turnId));
    void executor.execute({
      actor: plan.actor,
      turn: plan.turn,
      priorTurns,
      signal: abort.signal,
      drainMailbox: () => this.drainMailbox(plan.actor.path),
    }).then(
      (result) => this.completeExecution(plan.turn.turnId, result.output, result.artifacts),
      (error: unknown) => this.failExecution(plan.turn.turnId, error),
    );
  }

  private async completeExecution(
    turnId: string,
    output: string,
    artifacts: readonly string[] = [],
  ): Promise<void> {
    await this.mutate(() => this.finishTurn(turnId, 'completed', { output, artifacts }));
  }

  private async failExecution(turnId: string, error: unknown): Promise<void> {
    await this.mutate(() => {
      const turn = this.turns.get(turnId);
      if (!turn || isTerminal(turn.state)) return;
      this.finishTurn(turnId, 'failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private finishTurn(
    turnId: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: { readonly output?: string; readonly artifacts?: readonly string[]; readonly error?: string },
  ): void {
    const turn = this.requireTurn(turnId);
    if (isTerminal(turn.state)) return;
    const actor = this.requireActor(turn.actorPath);
    const timestamp = this.now();
    this.turns.set(turnId, { ...turn, ...result, state, completedAt: timestamp, revision: turn.revision + 1 });
    this.actors.set(actor.path, {
      ...actor, state: 'idle', currentTurnId: undefined, updatedAt: timestamp, revision: actor.revision + 1,
    });
    this.scheduler.release(turnId);
    this.abortControllers.delete(turnId);
    if (actor.parentPath) this.appendCompletion(actor, turnId, state, result);
    this.appendEvent(eventKindForTerminal(state), actor.path, turnId, actor.parentPath);
  }

  private appendCompletion(
    actor: AgentActor,
    turnId: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: { readonly output?: string; readonly error?: string },
  ): void {
    const summary = result.output ?? result.error ?? state;
    this.appendMessage(actor.path, actor.parentPath ?? ROOT_PATH, summary, 'completion', 'internal', turnId);
  }

  private async drainMailbox(actorPath: string): Promise<readonly AgentMailboxMessage[]> {
    return this.mutate(() => {
      const actor = this.requireActor(actorPath);
      const mailbox = this.mailboxes.get(actorPath) ?? [];
      const unread = mailbox.filter((message) => message.sequence > actor.mailboxCursor);
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

  private appendMessage(
    senderPath: string,
    recipientPath: string,
    content: string,
    kind: AgentMailboxMessage['kind'],
    classification: AgentDataClassification,
    turnId?: string,
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
  ): void {
    this.eventsLog.push({
      sequence: this.eventsLog.length + 1,
      kind,
      actorPath,
      ...(turnId === undefined ? {} : { turnId }),
      ...(parentPath === undefined ? {} : { parentPath }),
      createdAt: this.now(),
    });
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
    const allowed = caller.path === ROOT_PATH
      || target.path === caller.parentPath
      || target.parentPath === caller.path
      || (caller.parentPath !== undefined && caller.parentPath === target.parentPath);
    if (!allowed) throw new AgentControlError('permission_denied', `${callerPath} cannot message ${targetPath}`);
  }

  private isVisible(callerPath: string, targetPath: string): boolean {
    const caller = this.requireActor(callerPath);
    const target = this.requireActor(targetPath);
    if (caller.path === ROOT_PATH) return true;
    if (target.path === caller.path || target.path.startsWith(`${caller.path}/`)) return true;
    return target.path === caller.parentPath
      || (caller.parentPath !== undefined && target.parentPath === caller.parentPath);
  }

  private visibleActors(callerPath: string): readonly AgentActor[] {
    return [...this.actors.values()]
      .filter((actor) => this.isVisible(callerPath, actor.path))
      .sort((left, right) => left.path.localeCompare(right.path));
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

  private createTurn(actor: AgentActor, objective: string, forkTurns: AgentForkTurns): AgentTurn {
    const sequence = actor.turnIds.length + 1;
    return {
      turnId: `turn_${actor.path.slice(1).replace(/[^a-zA-Z0-9]+/g, '_')}_${sequence}`,
      actorPath: actor.path,
      sequence,
      state: 'accepted',
      objective,
      forkTurns,
      createdAt: this.now(),
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

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const previousTail = this.mutationTail;
    let release: () => void = () => {};
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTail;
    const before = this.snapshot();
    const eventCount = this.eventsLog.length;
    try {
      const result = await operation();
      const expectedRevision = this.revision;
      this.revision += 1;
      await this.options.store?.save(this.snapshot(), expectedRevision);
      for (const event of this.eventsLog.slice(eventCount)) this.notify(event);
      return result;
    } catch (error) {
      this.restore(before);
      throw error;
    } finally {
      release();
    }
  }

  private snapshot(): AgentActorSnapshot {
    return {
      schemaVersion: 1,
      revision: this.revision,
      maxConcurrentThreads: this.scheduler.maxConcurrentThreads,
      actors: [...this.actors.values()],
      turns: [...this.turns.values()],
      mailboxes: Object.fromEntries([...this.mailboxes.entries()]),
      events: [...this.eventsLog],
    };
  }

  private restore(snapshot: AgentActorSnapshot): void {
    this.revision = snapshot.revision;
    replaceMap(this.actors, snapshot.actors.map((actor) => [actor.path, actor]));
    replaceMap(this.turns, snapshot.turns.map((turn) => [turn.turnId, turn]));
    replaceMap(this.mailboxes, Object.entries(snapshot.mailboxes).map(([path, messages]) => [path, [...messages]]));
    this.eventsLog.splice(0, this.eventsLog.length, ...snapshot.events);
    this.scheduler.restore(snapshot.turns.filter((turn) => !isTerminal(turn.state)).map((turn) => turn.turnId));
  }

  private async recoverUnmatchedTurns(): Promise<void> {
    const active = [...this.turns.values()].filter((turn) => !isTerminal(turn.state));
    if (active.length === 0) return;
    await this.mutate(() => {
      for (const turn of active) {
        this.finishTurn(turn.turnId, 'interrupted', { error: 'runtime_recovered_without_executor' });
      }
    });
  }

  private notify(event: AgentEvent): void {
    for (const waiter of [...this.waiters]) {
      if (event.sequence <= waiter.afterSequence || !this.isVisible(waiter.callerPath, event.actorPath)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }
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
  };
}

function validateTaskName(taskName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskName)
    || /^(?:root|workflow|external)(?:[-_]|$)/i.test(taskName)) {
    throw new AgentControlError('invalid_task_name', `invalid actor task_name: ${taskName}`);
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
  };
  const valid = isSubset(child.tools, parent.tools)
    && isSubset(child.providers, parent.providers)
    && filesystemRank(child.filesystem) <= filesystemRank(parent.filesystem)
    && (!child.network || parent.network)
    && requested?.canAskUser !== true;
  if (!valid) throw new AgentControlError('invalid_capabilities', 'child capabilities cannot exceed parent authority');
  return child;
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

function validateSnapshot(snapshot: AgentActorSnapshot, configuredMax: number): void {
  if (snapshot.schemaVersion !== 1) throw new Error('Unsupported actor snapshot schema.');
  if (snapshot.maxConcurrentThreads !== configuredMax) {
    throw new Error('Actor snapshot concurrency does not match the root session setting.');
  }
  if (!snapshot.actors.some((actor) => actor.path === ROOT_PATH)) throw new Error('Actor snapshot has no root.');
}
