import { randomUUID } from 'node:crypto';

import type {
  AgentContinuationInput,
  AgentExecutor,
  AgentExecutorEvent,
  AgentExecutorFactory,
  AgentExecutorTaskReference,
  AgentExecutorTaskSnapshot,
  AgentTaskStartInput,
  ExternalAgentProtocol,
  ExternalAgentRegistration,
} from './types.js';

export interface ReferenceAgentExecutorFactoryOptions {
  readonly executorId: string;
  readonly protocol: ExternalAgentProtocol;
  readonly createRemoteTaskId?: () => string;
}

interface ReferenceTaskRecord {
  readonly reference: AgentExecutorTaskReference;
  readonly input: AgentTaskStartInput;
  snapshot: AgentExecutorTaskSnapshot;
  readonly events: ReferenceEventChannel;
}

class ReferenceEventChannel {
  readonly #queued: AgentExecutorEvent[] = [];
  readonly #waiters: Array<(event: AgentExecutorEvent | undefined) => void> = [];
  #closed = false;

  push(event: AgentExecutorEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(event);
    else this.#queued.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  async next(): Promise<AgentExecutorEvent | undefined> {
    const queued = this.#queued.shift();
    if (queued) return queued;
    if (this.#closed) return undefined;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class ReferenceAgentExecutor implements AgentExecutor {
  readonly #tasksByRemoteId = new Map<string, ReferenceTaskRecord>();
  readonly #remoteIdByIdempotencyKey = new Map<string, string>();

  constructor(
    private readonly registration: ExternalAgentRegistration,
    private readonly createRemoteTaskId: () => string,
  ) {}

  async start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference> {
    const idempotencyKey = input.idempotencyKey;
    if (!idempotencyKey) throw new Error('Reference executor requires an idempotencyKey.');
    const existingId = this.#remoteIdByIdempotencyKey.get(idempotencyKey);
    if (existingId) return this.requireTask(existingId).reference;
    const remoteTaskId = this.createRemoteTaskId();
    const reference = { idempotencyKey, remoteTaskId };
    const inputRequired = this.registration.executorConfig?.inputRequired === true;
    const record: ReferenceTaskRecord = {
      reference,
      input,
      snapshot: { state: inputRequired ? 'input-required' : 'working' },
      events: new ReferenceEventChannel(),
    };
    this.#tasksByRemoteId.set(remoteTaskId, record);
    this.#remoteIdByIdempotencyKey.set(idempotencyKey, remoteTaskId);
    if (!inputRequired) queueMicrotask(() => this.complete(record, this.configuredOutput(input.objective)));
    return reference;
  }

  async *events(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    const record = this.taskFromReference(reference);
    yield record.snapshot;
    if (isReferenceTerminal(record.snapshot)) return;
    while (true) {
      const event = await record.events.next();
      if (!event) return;
      yield event;
      if (event.state !== undefined && isReferenceTerminalState(event.state)) return;
    }
  }

  async get(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    return structuredClone(this.taskFromReference(reference).snapshot);
  }

  async sendInput(
    reference: AgentExecutorTaskReference,
    input: AgentContinuationInput,
  ): Promise<void> {
    const record = this.taskFromReference(reference);
    if (record.snapshot.state !== 'input-required' && record.snapshot.state !== 'auth-required') {
      throw new Error('Reference task is not waiting for input.');
    }
    record.snapshot = { state: 'working' };
    record.events.push(record.snapshot);
    const prefix = typeof this.registration.executorConfig?.inputPrefix === 'string'
      ? this.registration.executorConfig.inputPrefix
      : '';
    queueMicrotask(() => this.complete(record, `${prefix}${input.content}`));
  }

  async cancel(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    const record = this.taskFromReference(reference);
    if (!isReferenceTerminal(record.snapshot)) {
      record.snapshot = { state: 'canceled' };
      record.events.push(record.snapshot);
      record.events.close();
    }
    return structuredClone(record.snapshot);
  }

  async reconcile(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    return this.get(reference);
  }

  async dispose(): Promise<void> {
    for (const record of this.#tasksByRemoteId.values()) record.events.close();
    this.#tasksByRemoteId.clear();
    this.#remoteIdByIdempotencyKey.clear();
  }

  private configuredOutput(objective: string): string {
    const configured = this.registration.executorConfig?.output;
    return typeof configured === 'string' ? configured : objective;
  }

  private complete(record: ReferenceTaskRecord, output: string): void {
    if (isReferenceTerminal(record.snapshot)) return;
    record.snapshot = { state: 'completed', output };
    record.events.push(record.snapshot);
    record.events.close();
  }

  private taskFromReference(reference: AgentExecutorTaskReference): ReferenceTaskRecord {
    const remoteTaskId = reference.remoteTaskId
      ?? this.#remoteIdByIdempotencyKey.get(reference.idempotencyKey);
    if (!remoteTaskId) throw new Error('Reference task could not be reconciled.');
    return this.requireTask(remoteTaskId);
  }

  private requireTask(remoteTaskId: string): ReferenceTaskRecord {
    const task = this.#tasksByRemoteId.get(remoteTaskId);
    if (!task) throw new Error(`Reference task not found: ${remoteTaskId}`);
    return task;
  }
}

function isReferenceTerminal(snapshot: AgentExecutorTaskSnapshot): boolean {
  return isReferenceTerminalState(snapshot.state);
}

function isReferenceTerminalState(state: AgentExecutorTaskSnapshot['state']): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'rejected';
}

export function createReferenceAgentExecutorFactory(
  options: ReferenceAgentExecutorFactoryOptions,
): AgentExecutorFactory {
  return {
    executorId: options.executorId,
    protocol: options.protocol,
    async create(registration) {
      return new ReferenceAgentExecutor(
        registration,
        options.createRemoteTaskId ?? (() => `reference-${randomUUID()}`),
      );
    },
  };
}
