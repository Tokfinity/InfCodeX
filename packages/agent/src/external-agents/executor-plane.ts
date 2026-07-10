import { randomUUID } from 'node:crypto';

import { createMemoryAgentExecutorPlaneStore } from './memory-store.js';
import type {
  AgentCapabilityDeclaration,
  AgentCapabilityRequirements,
  AgentArtifactReference,
  AgentCredentialBroker,
  AgentDispatchabilitySnapshot,
  AgentExecutor,
  AgentExecutorEvent,
  AgentExecutorFactory,
  AgentExecutorFactoryContext,
  AgentExecutorPlane,
  AgentExecutorPlaneStore,
  AgentExecutorTaskSnapshot,
  AgentPreflightInput,
  AgentPreflightResult,
  AgentRegistrationService,
  AgentTaskCancellation,
  AgentTaskEvent,
  AgentTaskFilter,
  AgentTaskService,
  AgentTaskSnapshot,
  AgentTaskStartInput,
  CreateAgentExecutorPlaneOptions,
  DispatchableAgentDescriptor,
  DispatchableAgentListing,
  DispatchableAgentQuery,
  ExternalAgentRegistration,
  ExternalAgentRegistrationSummary,
  LocalAgentTaskInput,
  LocalAgentTaskUpdate,
} from './types.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);
const CAPABILITY_KEYS = [
  'streaming',
  'durableTasks',
  'inputRequired',
  'cancellation',
  'artifacts',
] as const satisfies readonly (keyof AgentCapabilityDeclaration)[];

const LOCAL_CAPABILITIES: AgentCapabilityDeclaration = {
  streaming: 'supported',
  durableTasks: 'supported',
  inputRequired: 'supported',
  cancellation: 'supported',
  artifacts: 'supported',
};

export class AgentStartUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentStartUncertainError';
  }
}

export class AgentCancellationUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCancellationUncertainError';
  }
}

interface PlaneRuntimeOptions {
  readonly factories: ReadonlyMap<string, AgentExecutorFactory>;
  readonly policy: CreateAgentExecutorPlaneOptions['policy'];
  readonly credentialBroker?: AgentCredentialBroker;
  readonly artifactPolicy?: CreateAgentExecutorPlaneOptions['artifactPolicy'];
  readonly store: AgentExecutorPlaneStore;
  readonly now: () => Date;
  readonly createTaskId: () => string;
  readonly createIdempotencyKey: () => string;
}

interface EvaluationResult {
  readonly descriptor: DispatchableAgentDescriptor;
  readonly dispatchability: AgentDispatchabilitySnapshot;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTerminal(state: AgentTaskSnapshot['state']): boolean {
  return TERMINAL_STATES.has(state);
}

function sanitizeText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length > 0) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|client[_-]?secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message || 'Unknown external agent error.', secrets);
}

function descriptorFromRegistration(
  registration: ExternalAgentRegistration,
): DispatchableAgentDescriptor {
  return {
    agentId: registration.agentId,
    displayName: registration.displayName,
    ...(registration.description ? { description: registration.description } : {}),
    origin: 'external',
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    skills: registration.skills ?? [],
    inputModalities: registration.inputModalities ?? [],
    outputModalities: registration.outputModalities ?? [],
    capabilities: registration.capabilities,
    effects: registration.effects,
  };
}

function summaryFromRegistration(
  registration: ExternalAgentRegistration,
): ExternalAgentRegistrationSummary {
  const diagnostics: string[] = [];
  if (!registration.enabled) diagnostics.push('disabled');
  if (registration.health?.status === 'unhealthy') diagnostics.push('unhealthy');
  if (registration.health?.diagnostic) diagnostics.push('health check reported a diagnostic');
  const health = registration.health
    ? {
        status: registration.health.status,
        checkedAt: registration.health.checkedAt,
        ...(registration.health.retryAfterMs !== undefined
          ? { retryAfterMs: registration.health.retryAfterMs }
          : {}),
      }
    : undefined;
  return {
    agentId: registration.agentId,
    displayName: registration.displayName,
    ...(registration.description ? { description: registration.description } : {}),
    enabled: registration.enabled,
    executorId: registration.executorId,
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    endpointIdentityHash: registration.endpointIdentityHash,
    credentialConfigured: registration.credentialRef !== undefined,
    capabilities: registration.capabilities,
    effects: registration.effects,
    ...(health ? { health } : {}),
    diagnostics,
  };
}

function assertRegistration(input: ExternalAgentRegistration): void {
  if (!input.agentId.startsWith('external:') || input.agentId.length <= 'external:'.length) {
    throw new Error('External agent registration agentId must use the external: namespace.');
  }
  for (const [label, value] of [
    ['displayName', input.displayName],
    ['executorId', input.executorId],
    ['configurationRevision', input.configurationRevision],
    ['endpointIdentityHash', input.endpointIdentityHash],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`External agent ${label} must not be empty.`);
  }
  if (input.maxConcurrency !== undefined && (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency <= 0)) {
    throw new Error('External agent maxConcurrency must be a positive integer.');
  }
  if (input.minimumBudget !== undefined && (!Number.isFinite(input.minimumBudget) || input.minimumBudget < 0)) {
    throw new Error('External agent minimumBudget must be a non-negative number.');
  }
}

function buildFactoryMap(
  factories: readonly AgentExecutorFactory[],
): ReadonlyMap<string, AgentExecutorFactory> {
  const result = new Map<string, AgentExecutorFactory>();
  for (const factory of factories) {
    if (result.has(factory.executorId)) {
      throw new Error(`Duplicate external agent executor factory: ${factory.executorId}`);
    }
    result.set(factory.executorId, factory);
  }
  return result;
}

function capabilityMismatchReasons(
  capabilities: AgentCapabilityDeclaration,
  required: AgentCapabilityRequirements | undefined,
): string[] {
  if (!required) return [];
  const reasons: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    if (required[key] === true && capabilities[key] !== 'supported') {
      reasons.push(`required capability ${key} is ${capabilities[key]}`);
    }
  }
  return reasons;
}

function descriptorMismatchReasons(
  descriptor: DispatchableAgentDescriptor,
  query: DispatchableAgentQuery,
): string[] {
  const reasons = capabilityMismatchReasons(descriptor.capabilities, query.requiredCapabilities);
  if (query.actorId.trim().length === 0) reasons.push('actor identity is required');
  if (query.budget !== undefined && (!Number.isFinite(query.budget) || query.budget < 0)) {
    reasons.push('dispatch budget is invalid');
  }
  const skills = new Set(descriptor.skills);
  for (const skill of query.requiredSkills ?? []) {
    if (!skills.has(skill)) reasons.push(`required skill is unavailable: ${skill}`);
  }
  if (query.readOnly === true && (descriptor.effects.remote === 'write' || descriptor.effects.remote === 'unknown')) {
    reasons.push(`read-only dispatch rejects remote effect ${descriptor.effects.remote}`);
  }
  if (descriptor.origin === 'external' && descriptor.effects.workspace === 'direct') {
    reasons.push('external workspace effects must be none or proposal');
  }
  return reasons;
}

function localEvaluation(
  descriptor: DispatchableAgentDescriptor,
  query: DispatchableAgentQuery,
  now: string,
): EvaluationResult {
  const reasons = descriptorMismatchReasons(descriptor, query);
  return {
    descriptor,
    dispatchability: {
      status: reasons.length === 0 ? 'dispatchable' : 'unavailable',
      checkedAt: now,
      reasons,
    },
  };
}

function registrationSnapshot(
  registration: ExternalAgentRegistration,
): AgentTaskSnapshot['registration'] {
  return {
    agentId: registration.agentId,
    origin: 'external',
    executorId: registration.executorId,
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    endpointIdentityHash: registration.endpointIdentityHash,
    capabilities: registration.capabilities,
    effects: registration.effects,
  };
}

function taskMatches(task: AgentTaskSnapshot, filter: AgentTaskFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.agentId !== undefined && task.agentId !== filter.agentId) return false;
  if (filter.parentTaskId !== undefined && task.parentTaskId !== filter.parentTaskId) return false;
  if (filter.workflowId !== undefined && task.workflowId !== filter.workflowId) return false;
  if (filter.runId !== undefined && task.runId !== filter.runId) return false;
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    if (!states.includes(task.state)) return false;
  }
  return true;
}

function eventType(event: AgentExecutorEvent): AgentTaskEvent['type'] {
  if (event.error !== undefined) return 'error';
  if (event.output !== undefined) return 'output';
  if (event.artifacts !== undefined) return 'artifact';
  if (event.usage !== undefined) return 'usage';
  if (event.progress !== undefined) return 'progress';
  return 'state';
}

class AgentExecutorPlaneRuntime {
  readonly #registrations = new Map<string, ExternalAgentRegistration>();
  readonly #tasks = new Map<string, AgentTaskSnapshot>();
  readonly #eventSequences = new Map<string, number>();
  readonly #executors = new Map<string, AgentExecutor>();
  readonly #waiters = new Map<string, Set<(task: AgentTaskSnapshot) => void>>();
  readonly #startTails = new Map<string, Promise<void>>();

  constructor(private readonly options: PlaneRuntimeOptions) {}

  async initialize(): Promise<void> {
    for (const registration of await this.options.store.loadRegistrations()) {
      assertRegistration(registration);
      this.#registrations.set(registration.agentId, clone(registration));
    }
    for (const task of await this.options.store.loadTasks()) {
      this.#tasks.set(task.taskId, clone(task));
      const events = await this.options.store.loadEvents(task.taskId);
      this.#eventSequences.set(task.taskId, events.at(-1)?.seq ?? 0);
    }
    await this.recoverNonTerminalTasks();
  }

  readonly registrations: AgentRegistrationService = {
    list: async () => [...this.#registrations.values()].map(summaryFromRegistration),
    upsert: async (input) => this.upsertRegistration(input),
    remove: async (agentId) => this.removeRegistration(agentId),
  };

  readonly tasks: AgentTaskService = {
    start: async (input) => this.startTaskSerialized(input),
    list: async (filter) => this.listTasks(filter),
    get: async (taskId) => this.getTask(taskId),
    events: async (taskId, cursor) => this.listEvents(taskId, cursor),
    wait: async (taskId, timeoutMs) => this.waitTask(taskId, timeoutMs),
    sendInput: async (taskId, input) => this.sendTaskInput(taskId, input),
    cancel: async (taskId, reason) => this.cancelTask(taskId, reason),
    reconcile: async (taskId) => this.reconcileTask(taskId),
    recordLocal: async (input) => this.recordLocalTask(input),
    updateLocal: async (taskId, update) => this.updateLocalTask(taskId, update),
  };

  async upsertRegistration(
    input: ExternalAgentRegistration,
  ): Promise<ExternalAgentRegistrationSummary> {
    assertRegistration(input);
    const factory = this.options.factories.get(input.executorId);
    if (factory && factory.protocol !== input.protocol) {
      throw new Error(`Executor ${input.executorId} uses ${factory.protocol}, not ${input.protocol}.`);
    }
    this.#registrations.set(input.agentId, clone(input));
    await this.persistRegistrations();
    return summaryFromRegistration(input);
  }

  private async startTaskSerialized(input: AgentTaskStartInput): Promise<AgentTaskSnapshot> {
    const previous = this.#startTails.get(input.agentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#startTails.set(input.agentId, tail);
    await previous;
    try {
      return await this.startTask(input);
    } finally {
      release?.();
      if (this.#startTails.get(input.agentId) === tail) this.#startTails.delete(input.agentId);
    }
  }

  async removeRegistration(agentId: string): Promise<boolean> {
    const removed = this.#registrations.delete(agentId);
    if (removed) await this.persistRegistrations();
    return removed;
  }

  async listDispatchable(
    query: DispatchableAgentQuery,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<readonly DispatchableAgentListing[]> {
    const local = localAgents.map((descriptor) => localEvaluation(descriptor, query, this.nowIso()));
    const external = await Promise.all(
      [...this.#registrations.values()].map((registration) => this.evaluateRegistration(registration, query)),
    );
    return [...local, ...external]
      .filter((entry) => entry.dispatchability.status === 'dispatchable' || entry.dispatchability.status === 'degraded')
      .sort((left, right) => left.descriptor.agentId.localeCompare(right.descriptor.agentId))
      .map(clone);
  }

  async describe(
    agentId: string,
    query: DispatchableAgentQuery,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<DispatchableAgentListing | undefined> {
    const local = localAgents.find((descriptor) => descriptor.agentId === agentId);
    if (local) return clone(localEvaluation(local, query, this.nowIso()));
    const registration = this.#registrations.get(agentId);
    if (!registration) return undefined;
    return clone(await this.evaluateRegistration(registration, query));
  }

  async preflight(
    input: AgentPreflightInput,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<AgentPreflightResult> {
    const listing = await this.describe(input.agentId, input.query, localAgents);
    const reasons = listing ? [...listing.dispatchability.reasons] : ['agent is not registered'];
    if (
      listing
      && input.expectedConfigurationRevision !== undefined
      && listing.descriptor.configurationRevision !== input.expectedConfigurationRevision
    ) {
      reasons.push('configuration revision changed');
    }
    return {
      ok: listing !== undefined && reasons.length === 0,
      ...(listing ? { descriptor: listing.descriptor } : {}),
      dispatchability: listing?.dispatchability ?? {
        status: 'unavailable',
        checkedAt: this.nowIso(),
        reasons,
      },
      reasons,
    };
  }

  async close(): Promise<void> {
    const executors = [...this.#executors.values()];
    this.#executors.clear();
    await Promise.allSettled(executors.map((executor) => executor.dispose()));
  }

  private async evaluateRegistration(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
  ): Promise<EvaluationResult> {
    const reasons = descriptorMismatchReasons(descriptorFromRegistration(registration), query);
    if (!registration.enabled) reasons.push('registration is disabled');
    if (!this.options.factories.has(registration.executorId)) reasons.push('executor is unavailable');
    await this.appendCredentialReason(registration, reasons);
    this.appendHealthReasons(registration, reasons);
    this.appendResourceReasons(registration, query, reasons);
    await this.appendPolicyReasons(registration, query, reasons);
    const degraded = registration.health?.status === 'degraded';
    return {
      descriptor: descriptorFromRegistration(registration),
      dispatchability: {
        status: reasons.length > 0 ? 'unavailable' : degraded ? 'degraded' : 'dispatchable',
        checkedAt: this.nowIso(),
        reasons,
        ...(registration.health?.retryAfterMs !== undefined
          ? { retryAfterMs: registration.health.retryAfterMs }
          : {}),
      },
    };
  }

  private async appendCredentialReason(
    registration: ExternalAgentRegistration,
    reasons: string[],
  ): Promise<void> {
    const ref = registration.credentialRef;
    if (!ref) return;
    if (!this.options.credentialBroker) {
      reasons.push('credential broker is unavailable');
      return;
    }
    try {
      const available = await this.options.credentialBroker.isAvailable?.(ref);
      if (available === false) reasons.push('credential is unavailable');
    } catch {
      reasons.push('credential availability check failed');
    }
  }

  private appendHealthReasons(
    registration: ExternalAgentRegistration,
    reasons: string[],
  ): void {
    if (registration.health?.status === 'unhealthy') reasons.push('agent is unhealthy');
  }

  private appendResourceReasons(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
    reasons: string[],
  ): void {
    const active = [...this.#tasks.values()].filter(
      (task) => task.agentId === registration.agentId && !isTerminal(task.state),
    ).length;
    if (registration.maxConcurrency !== undefined && active >= registration.maxConcurrency) {
      reasons.push('agent concurrency limit reached');
    }
    if (registration.minimumBudget !== undefined && (query.budget ?? -1) < registration.minimumBudget) {
      reasons.push('dispatch budget is insufficient');
    }
    const allowed = registration.allowedDataClassifications;
    for (const classification of query.dataClassifications ?? []) {
      if (allowed !== undefined && !allowed.includes(classification)) {
        reasons.push(`data classification is not allowed: ${classification}`);
      }
    }
  }

  private async appendPolicyReasons(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
    reasons: string[],
  ): Promise<void> {
    try {
      const decision = await this.options.policy({ registration: clone(registration), query: clone(query) });
      if (!decision.allowed) reasons.push(...(decision.reasons ?? ['policy denied dispatch']));
    } catch {
      reasons.push('dispatch policy is unavailable');
    }
  }

  private async startTask(input: AgentTaskStartInput): Promise<AgentTaskSnapshot> {
    const query = this.queryFromTask(input);
    const preflight = await this.preflight({
      agentId: input.agentId,
      query,
      ...(input.expectedConfigurationRevision
        ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
        : {}),
    });
    if (!preflight.ok) throw new Error(`Agent preflight failed: ${preflight.reasons.join('; ')}`);
    const registration = this.requireRegistration(input.agentId);
    if (preflight.descriptor?.configurationRevision !== registration.configurationRevision) {
      throw new Error('Agent configuration revision changed during preflight.');
    }
    const executor = await this.executorForRegistration(registration);
    const taskId = input.taskId ?? this.options.createTaskId();
    if (this.#tasks.has(taskId)) throw new Error(`Agent task already exists: ${taskId}`);
    const enriched = { ...input, taskId, idempotencyKey: input.idempotencyKey ?? this.options.createIdempotencyKey() };
    await this.assertExecutorPreflight(executor, enriched);
    const task = this.createSubmittedTask(enriched, registration);
    await this.saveTask(task, 'submitted');
    return this.invokeExternalStart(task, enriched, executor);
  }

  private queryFromTask(input: AgentTaskStartInput): DispatchableAgentQuery {
    return {
      ...input.context,
      ...(input.requiredSkills ? { requiredSkills: input.requiredSkills } : {}),
      ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    };
  }

  private async assertExecutorPreflight(
    executor: AgentExecutor,
    input: AgentTaskStartInput,
  ): Promise<void> {
    const result = await executor.preflight?.(input);
    if (result && !result.ok) {
      throw new Error(`Executor preflight failed: ${(result.reasons ?? ['rejected']).join('; ')}`);
    }
  }

  private createSubmittedTask(
    input: AgentTaskStartInput & { readonly taskId: string; readonly idempotencyKey: string },
    registration: ExternalAgentRegistration,
  ): AgentTaskSnapshot {
    const now = this.nowIso();
    return {
      taskId: input.taskId,
      route: 'external',
      agentId: input.agentId,
      objective: input.objective,
      state: 'submitted',
      cancellation: 'none',
      registration: registrationSnapshot(registration),
      idempotencyKey: input.idempotencyKey,
      dispatchAttempt: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.context.parentTaskId ? { parentTaskId: input.context.parentTaskId } : {}),
      ...(input.context.workflowId ? { workflowId: input.context.workflowId } : {}),
      ...(input.context.runId ? { runId: input.context.runId } : {}),
      ...(input.context.nodeId ? { nodeId: input.context.nodeId } : {}),
    };
  }

  private async invokeExternalStart(
    task: AgentTaskSnapshot,
    input: AgentTaskStartInput,
    executor: AgentExecutor,
  ): Promise<AgentTaskSnapshot> {
    try {
      const reference = await executor.start(input);
      const accepted: AgentTaskSnapshot = {
        ...task,
        state: 'working',
        executorReference: reference,
        ...(reference.remoteTaskId ? { remoteTaskId: reference.remoteTaskId } : {}),
        updatedAt: this.nowIso(),
      };
      await this.saveTask(accepted, 'state');
      const remote = await executor.get(reference).catch(() => ({ state: 'working' as const }));
      const started = this.applyRemoteSnapshot(accepted, remote);
      await this.saveTask(started, 'state');
      this.startEventPump(started.taskId, executor, reference);
      return clone(started);
    } catch (error: unknown) {
      const state: AgentTaskSnapshot['state'] = error instanceof AgentStartUncertainError
        ? 'unknown'
        : 'failed';
      const failed: AgentTaskSnapshot = {
        ...task,
        state,
        error: errorMessage(error),
        updatedAt: this.nowIso(),
      };
      await this.saveTask(failed, 'error');
      return clone(failed);
    }
  }

  private startEventPump(
    taskId: string,
    executor: AgentExecutor,
    reference: NonNullable<AgentTaskSnapshot['executorReference']>,
  ): void {
    void this.pumpEvents(taskId, executor, reference).catch(async (error: unknown) => {
      const current = this.#tasks.get(taskId);
      if (!current || isTerminal(current.state)) return;
      await this.saveTask({
        ...current,
        state: 'unknown',
        error: errorMessage(error),
        updatedAt: this.nowIso(),
      }, 'error');
    });
  }

  private async pumpEvents(
    taskId: string,
    executor: AgentExecutor,
    reference: NonNullable<AgentTaskSnapshot['executorReference']>,
  ): Promise<void> {
    for await (const event of executor.events(reference)) {
      const current = this.#tasks.get(taskId);
      if (!current || isTerminal(current.state)) return;
      const next = this.applyExecutorEvent(current, event);
      await this.saveTask(next, eventType(event), event);
    }
  }

  private applyExecutorEvent(
    task: AgentTaskSnapshot,
    event: AgentExecutorEvent,
  ): AgentTaskSnapshot {
    return {
      ...task,
      ...(event.state ? { state: event.state } : {}),
      ...(event.progress ? { progress: event.progress } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.error !== undefined ? { error: sanitizeText(event.error) } : {}),
      ...(event.artifacts ? { artifacts: this.withArtifactProvenance(task, event.artifacts) } : {}),
      ...(event.usage ? { usage: event.usage } : {}),
      updatedAt: this.nowIso(),
    };
  }

  private withArtifactProvenance(
    task: AgentTaskSnapshot,
    artifacts: readonly AgentArtifactReference[],
  ): readonly AgentArtifactReference[] {
    return artifacts.map((artifact) => ({
      ...artifact,
      producingAgentId: artifact.producingAgentId ?? task.agentId,
      ...(artifact.remoteTaskId ?? task.remoteTaskId
        ? { remoteTaskId: artifact.remoteTaskId ?? task.remoteTaskId }
        : {}),
    }));
  }

  private async listTasks(filter?: AgentTaskFilter): Promise<readonly AgentTaskSnapshot[]> {
    return [...this.#tasks.values()]
      .filter((task) => taskMatches(task, filter))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  private async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    return clone(this.requireTask(taskId));
  }

  private async listEvents(taskId: string, cursor = 0): Promise<readonly AgentTaskEvent[]> {
    this.requireTask(taskId);
    return (await this.options.store.loadEvents(taskId))
      .filter((event) => event.seq > cursor)
      .map(clone);
  }

  private async waitTask(taskId: string, timeoutMs?: number): Promise<AgentTaskSnapshot> {
    const current = this.requireTask(taskId);
    if (isTerminal(current.state)) return clone(current);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('Agent task wait timeoutMs must be positive.');
    }
    return new Promise<AgentTaskSnapshot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listener = (task: AgentTaskSnapshot): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(clone(task));
      };
      const listeners = this.#waiters.get(taskId) ?? new Set();
      listeners.add(listener);
      this.#waiters.set(taskId, listeners);
      if (timeoutMs === undefined) return;
      timer = setTimeout(() => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#waiters.delete(taskId);
        reject(new Error(`Agent task ${taskId} did not finish within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private async sendTaskInput(
    taskId: string,
    input: { readonly content: string },
  ): Promise<AgentTaskSnapshot> {
    const task = this.requireExternalTask(taskId);
    if (isTerminal(task.state)) throw new Error(`Agent task is already terminal: ${taskId}`);
    const { executor, reference } = await this.executorRoute(task);
    await executor.sendInput(reference, input);
    const next = { ...task, state: 'working' as const, updatedAt: this.nowIso() };
    await this.saveTask(next, 'state');
    return clone(next);
  }

  private async cancelTask(taskId: string, reason?: string): Promise<AgentTaskSnapshot> {
    const task = this.requireExternalTask(taskId);
    if (isTerminal(task.state)) return clone(task);
    if (task.registration.capabilities.cancellation === 'unsupported') {
      const unsupported = { ...task, cancellation: 'unsupported' as const, updatedAt: this.nowIso() };
      await this.saveTask(unsupported, 'cancellation');
      return clone(unsupported);
    }
    const requested = { ...task, cancellation: 'requested' as const, updatedAt: this.nowIso() };
    await this.saveTask(requested, 'cancellation');
    try {
      const { executor, reference } = await this.executorRoute(requested);
      const remote = await executor.cancel(reference, reason);
      const cancellation: AgentTaskCancellation = remote.state === 'canceled'
        ? 'confirmed'
        : remote.state === 'unknown' ? 'unknown' : 'requested';
      const next = { ...this.applyRemoteSnapshot(requested, remote), cancellation };
      await this.saveTask(next, 'cancellation');
      return clone(next);
    } catch (error: unknown) {
      const failed = {
        ...requested,
        cancellation: error instanceof AgentCancellationUncertainError
          ? 'unknown' as const
          : 'failed' as const,
        cancellationError: errorMessage(error),
        updatedAt: this.nowIso(),
      };
      await this.saveTask(failed, 'cancellation');
      return clone(failed);
    }
  }

  private async reconcileTask(taskId: string): Promise<AgentTaskSnapshot> {
    const task = this.requireExternalTask(taskId);
    try {
      const { executor, reference } = await this.executorRoute(task);
      const remote = await executor.reconcile(reference);
      const next = this.applyRemoteSnapshot(task, remote);
      await this.saveTask(next, 'state');
      return clone(next);
    } catch (error: unknown) {
      const unknown = { ...task, state: 'unknown' as const, error: errorMessage(error), updatedAt: this.nowIso() };
      await this.saveTask(unknown, 'error');
      return clone(unknown);
    }
  }

  private applyRemoteSnapshot(
    task: AgentTaskSnapshot,
    remote: AgentExecutorTaskSnapshot,
  ): AgentTaskSnapshot {
    return this.applyExecutorEvent(task, remote);
  }

  private async recordLocalTask(input: LocalAgentTaskInput): Promise<AgentTaskSnapshot> {
    if (this.#tasks.has(input.taskId)) throw new Error(`Agent task already exists: ${input.taskId}`);
    const now = this.nowIso();
    const origin = input.origin ?? (input.agentId.startsWith('constructed:') ? 'constructed' : 'native');
    const task: AgentTaskSnapshot = {
      taskId: input.taskId,
      route: 'local',
      agentId: input.agentId,
      objective: input.objective,
      state: 'working',
      cancellation: 'none',
      registration: {
        agentId: input.agentId,
        origin,
        executorId: 'kodax-local-child',
        protocol: 'native',
        configurationRevision: input.configurationRevision,
        capabilities: LOCAL_CAPABILITIES,
        effects: { remote: 'none', workspace: 'proposal' },
      },
      idempotencyKey: `local:${input.taskId}`,
      dispatchAttempt: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    };
    await this.saveTask(task, 'submitted');
    return clone(task);
  }

  private async updateLocalTask(
    taskId: string,
    update: LocalAgentTaskUpdate,
  ): Promise<AgentTaskSnapshot> {
    const task = this.requireTask(taskId);
    if (task.route !== 'local') throw new Error(`Agent task is not local: ${taskId}`);
    const next: AgentTaskSnapshot = {
      ...task,
      ...update,
      ...(update.error !== undefined ? { error: sanitizeText(update.error) } : {}),
      cancellation: update.state === 'canceled' ? 'confirmed' : task.cancellation,
      updatedAt: this.nowIso(),
    };
    await this.saveTask(next, update.error ? 'error' : update.output ? 'output' : 'state');
    return clone(next);
  }

  private async saveTask(
    task: AgentTaskSnapshot,
    type: AgentTaskEvent['type'],
    detail: AgentExecutorEvent = {},
  ): Promise<void> {
    const safeTask = clone(task);
    this.#tasks.set(task.taskId, safeTask);
    await this.options.store.saveTask(safeTask);
    await this.appendEvent(safeTask, type, detail);
    if (isTerminal(safeTask.state)) this.resolveWaiters(safeTask);
  }

  private async appendEvent(
    task: AgentTaskSnapshot,
    type: AgentTaskEvent['type'],
    detail: AgentExecutorEvent,
  ): Promise<void> {
    const seq = (this.#eventSequences.get(task.taskId) ?? 0) + 1;
    this.#eventSequences.set(task.taskId, seq);
    await this.options.store.appendEvent({
      taskId: task.taskId,
      seq,
      timestamp: this.nowIso(),
      type,
      state: task.state,
      cancellation: task.cancellation,
      ...(detail.progress ? { progress: detail.progress } : {}),
      ...(detail.output !== undefined ? { output: detail.output } : {}),
      ...(detail.error !== undefined ? { error: sanitizeText(detail.error) } : {}),
      ...(detail.artifacts ? { artifacts: this.withArtifactProvenance(task, detail.artifacts) } : {}),
      ...(detail.usage ? { usage: detail.usage } : {}),
    });
  }

  private resolveWaiters(task: AgentTaskSnapshot): void {
    const waiters = this.#waiters.get(task.taskId);
    if (!waiters) return;
    this.#waiters.delete(task.taskId);
    for (const resolve of waiters) resolve(task);
  }

  private async executorRoute(task: AgentTaskSnapshot): Promise<{
    readonly executor: AgentExecutor;
    readonly reference: NonNullable<AgentTaskSnapshot['executorReference']>;
  }> {
    const reference = task.executorReference ?? { idempotencyKey: task.idempotencyKey };
    const registration = this.#registrations.get(task.agentId);
    if (!registration || registration.configurationRevision !== task.registration.configurationRevision) {
      throw new Error('Captured executor revision is unavailable for this task.');
    }
    return { executor: await this.executorForRegistration(registration), reference };
  }

  private async executorForRegistration(
    registration: ExternalAgentRegistration,
  ): Promise<AgentExecutor> {
    const key = `${registration.executorId}\u0000${registration.agentId}\u0000${registration.configurationRevision}`;
    const cached = this.#executors.get(key);
    if (cached) return cached;
    const factory = this.options.factories.get(registration.executorId);
    if (!factory) throw new Error(`External agent executor is unavailable: ${registration.executorId}`);
    const executor = await factory.create(clone(registration), this.factoryContext(registration));
    this.#executors.set(key, executor);
    return executor;
  }

  private factoryContext(registration: ExternalAgentRegistration): AgentExecutorFactoryContext {
    return {
      withCredential: async <T>(credentialRef: string, use: (credential: string) => Promise<T>) => {
        const broker = this.options.credentialBroker;
        if (!broker) throw new Error('Credential broker is unavailable.');
        return broker.withCredential(credentialRef, async (credential) => {
          try {
            return await use(credential);
          } catch (error: unknown) {
            throw new Error(errorMessage(error, [credential]));
          }
        });
      },
      authorizeArtifact: async (artifact) => {
        const decision = await this.options.artifactPolicy?.({
          registration: clone(registration),
          artifact: clone(artifact),
        });
        if (!decision?.allowed) {
          throw new Error(decision?.reason ?? 'Artifact materialization is not authorized by the host.');
        }
      },
    };
  }

  private async persistRegistrations(): Promise<void> {
    await this.options.store.saveRegistrations([...this.#registrations.values()].map(clone));
  }

  private requireRegistration(agentId: string): ExternalAgentRegistration {
    const registration = this.#registrations.get(agentId);
    if (!registration) throw new Error(`External agent is not registered: ${agentId}`);
    return registration;
  }

  private requireTask(taskId: string): AgentTaskSnapshot {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Agent task not found: ${taskId}`);
    return task;
  }

  private requireExternalTask(taskId: string): AgentTaskSnapshot {
    const task = this.requireTask(taskId);
    if (task.route !== 'external') throw new Error(`Agent task is not external: ${taskId}`);
    return task;
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private async recoverNonTerminalTasks(): Promise<void> {
    for (const task of [...this.#tasks.values()]) {
      if (task.route !== 'external' || isTerminal(task.state)) continue;
      const registration = this.#registrations.get(task.agentId);
      if (!registration || registration.configurationRevision !== task.registration.configurationRevision) {
        await this.saveTask({ ...task, state: 'unknown', updatedAt: this.nowIso() }, 'state');
        continue;
      }
      await this.reconcileTask(task.taskId);
    }
  }
}

function defaultTaskId(): string {
  return `agent-task-${randomUUID()}`;
}

function defaultIdempotencyKey(): string {
  return `agent-dispatch-${randomUUID()}`;
}

export async function createAgentExecutorPlane(
  options: CreateAgentExecutorPlaneOptions,
): Promise<AgentExecutorPlane> {
  const runtime = new AgentExecutorPlaneRuntime({
    factories: buildFactoryMap(options.factories),
    policy: options.policy,
    credentialBroker: options.credentialBroker,
    artifactPolicy: options.artifactPolicy,
    store: options.store ?? createMemoryAgentExecutorPlaneStore(),
    now: options.now ?? (() => new Date()),
    createTaskId: options.createTaskId ?? defaultTaskId,
    createIdempotencyKey: options.createIdempotencyKey ?? defaultIdempotencyKey,
  });
  await runtime.initialize();
  return {
    registrations: runtime.registrations,
    tasks: runtime.tasks,
    listDispatchable: (query, locals) => runtime.listDispatchable(query, locals),
    describe: (agentId, query, locals) => runtime.describe(agentId, query, locals),
    preflight: (input, locals) => runtime.preflight(input, locals),
    close: () => runtime.close(),
  };
}

export { createMemoryAgentExecutorPlaneStore } from './memory-store.js';
