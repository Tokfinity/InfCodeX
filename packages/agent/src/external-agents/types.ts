export type DispatchableAgentOrigin = 'native' | 'constructed' | 'external';
export type AgentExecutorProtocol = 'native' | 'a2a' | 'mcp' | 'http';
export type ExternalAgentProtocol = Exclude<AgentExecutorProtocol, 'native'>;
export type CapabilitySupport = 'supported' | 'unsupported' | 'conditional';

export type AgentJsonValue =
  | string
  | number
  | boolean
  | null
  | AgentJsonObject
  | readonly AgentJsonValue[];

export interface AgentJsonObject {
  readonly [key: string]: AgentJsonValue;
}

export interface AgentCapabilityDeclaration {
  readonly streaming: CapabilitySupport;
  readonly durableTasks: CapabilitySupport;
  readonly inputRequired: CapabilitySupport;
  readonly cancellation: CapabilitySupport;
  readonly artifacts: CapabilitySupport;
}

export interface AgentEffectDeclaration {
  readonly remote: 'none' | 'read' | 'write' | 'unknown';
  readonly workspace: 'none' | 'proposal' | 'direct';
}

export interface ExternalAgentEffectDeclaration extends AgentEffectDeclaration {
  readonly workspace: 'none' | 'proposal';
}

export interface DispatchableAgentDescriptor {
  readonly agentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly origin: DispatchableAgentOrigin;
  readonly protocol: AgentExecutorProtocol;
  readonly configurationRevision: string;
  readonly skills: readonly string[];
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly capabilities: AgentCapabilityDeclaration;
  readonly effects: AgentEffectDeclaration;
}

export type AgentDispatchabilityStatus =
  | 'dispatchable'
  | 'degraded'
  | 'busy'
  | 'unavailable';

export interface AgentDispatchabilitySnapshot {
  readonly status: AgentDispatchabilityStatus;
  readonly checkedAt: string;
  readonly reasons: readonly string[];
  readonly retryAfterMs?: number;
}

export interface DispatchableAgentListing {
  readonly descriptor: DispatchableAgentDescriptor;
  readonly dispatchability: AgentDispatchabilitySnapshot;
}

export interface AgentDispatchContext {
  readonly actorId: string;
  readonly projectId?: string;
  readonly workflowId?: string;
  readonly parentTaskId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly dataClassifications?: readonly string[];
  readonly budget?: number;
}

export interface AgentCapabilityRequirements {
  readonly streaming?: boolean;
  readonly durableTasks?: boolean;
  readonly inputRequired?: boolean;
  readonly cancellation?: boolean;
  readonly artifacts?: boolean;
}

export interface DispatchableAgentQuery extends AgentDispatchContext {
  readonly requiredSkills?: readonly string[];
  readonly requiredCapabilities?: AgentCapabilityRequirements;
  readonly readOnly?: boolean;
}

export interface ExternalAgentHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly checkedAt: string;
  readonly retryAfterMs?: number;
  readonly diagnostic?: string;
}

export interface ExternalAgentRegistration {
  readonly agentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly managementOwner?: string;
  readonly enabled: boolean;
  readonly executorId: string;
  readonly protocol: ExternalAgentProtocol;
  /**
   * Stable content identity for this execution route. Producers must issue a
   * new value whenever immutable execution content changes. The same immutable
   * content may reuse its stable revision after removal or Runtime restart;
   * different content must never reuse a revision.
   */
  readonly configurationRevision: string;
  readonly endpointIdentityHash: string;
  readonly credentialRef?: string;
  /** Public, JSON-safe executor configuration. Secrets must remain references. */
  readonly executorConfig?: AgentJsonObject;
  readonly skills?: readonly string[];
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly capabilities: AgentCapabilityDeclaration;
  readonly effects: ExternalAgentEffectDeclaration;
  readonly health?: ExternalAgentHealth;
  readonly maxConcurrency?: number;
  readonly minimumBudget?: number;
  readonly allowedDataClassifications?: readonly string[];
}

export interface ExternalAgentRegistrationSummary {
  readonly agentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly managementOwner?: string;
  readonly enabled: boolean;
  readonly executorId: string;
  readonly protocol: ExternalAgentProtocol;
  readonly configurationRevision: string;
  readonly endpointIdentityHash: string;
  readonly credentialConfigured: boolean;
  readonly capabilities: AgentCapabilityDeclaration;
  readonly effects: ExternalAgentEffectDeclaration;
  readonly health?: ExternalAgentHealth;
  readonly diagnostics: readonly string[];
}

export interface AgentDispatchPolicyInput {
  readonly registration: ExternalAgentRegistration;
  readonly query: DispatchableAgentQuery;
}

export interface AgentDispatchPolicyDecision {
  readonly allowed: boolean;
  readonly reasons?: readonly string[];
}

export type AgentDispatchPolicy = (
  input: AgentDispatchPolicyInput,
) => AgentDispatchPolicyDecision | Promise<AgentDispatchPolicyDecision>;

export interface AgentCredentialBroker {
  isAvailable?(credentialRef: string): boolean | Promise<boolean>;
  withCredential<T>(
    credentialRef: string,
    use: (credential: string) => Promise<T>,
  ): Promise<T>;
}

export interface AgentArtifactReference {
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly hash?: string;
  readonly uri?: string;
  readonly provenance?: string;
  readonly producingAgentId?: string;
  readonly remoteTaskId?: string;
}

export interface AgentArtifactPolicyInput {
  readonly registration: ExternalAgentRegistration;
  readonly artifact: AgentArtifactReference;
}

export interface AgentArtifactPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type AgentArtifactPolicy = (
  input: AgentArtifactPolicyInput,
) => AgentArtifactPolicyDecision | Promise<AgentArtifactPolicyDecision>;

export interface AgentTaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
  readonly currency?: string;
}

export type AgentTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unknown';

export type AgentTaskCancellation =
  | 'none'
  | 'requested'
  | 'confirmed'
  | 'unsupported'
  | 'failed'
  | 'unknown';

export interface AgentTaskProgress {
  readonly message?: string;
  readonly percent?: number;
}

export interface AgentTaskCorrelation {
  readonly parentTaskId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
}

export interface AgentTaskRegistrationSnapshot {
  readonly agentId: string;
  readonly origin: DispatchableAgentOrigin;
  readonly executorId: string;
  readonly protocol: AgentExecutorProtocol;
  readonly configurationRevision: string;
  readonly endpointIdentityHash?: string;
  readonly capabilities: AgentCapabilityDeclaration;
  readonly effects: AgentEffectDeclaration;
}

export interface AgentExecutorTaskReference {
  readonly idempotencyKey: string;
  readonly remoteTaskId?: string;
  readonly metadata?: AgentJsonObject;
}

export interface AgentTaskSnapshot extends AgentTaskCorrelation {
  readonly taskId: string;
  readonly route: 'local' | 'external';
  readonly agentId: string;
  readonly objective: string;
  readonly state: AgentTaskState;
  readonly cancellation: AgentTaskCancellation;
  readonly registration: AgentTaskRegistrationSnapshot;
  readonly idempotencyKey: string;
  readonly dispatchAttempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly remoteTaskId?: string;
  readonly executorReference?: AgentExecutorTaskReference;
  readonly progress?: AgentTaskProgress;
  readonly output?: string;
  readonly error?: string;
  readonly cancellationError?: string;
  readonly artifacts?: readonly AgentArtifactReference[];
  readonly usage?: AgentTaskUsage;
}

export interface AgentExecutorTaskSnapshot {
  readonly state: AgentTaskState;
  readonly progress?: AgentTaskProgress;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: readonly AgentArtifactReference[];
  readonly usage?: AgentTaskUsage;
}

export interface AgentTaskStartInput {
  readonly taskId?: string;
  readonly agentId: string;
  readonly objective: string;
  readonly context: AgentDispatchContext;
  readonly readOnly?: boolean;
  readonly requiredSkills?: readonly string[];
  readonly requiredCapabilities?: AgentCapabilityRequirements;
  readonly expectedConfigurationRevision?: string;
  readonly idempotencyKey?: string;
  readonly input?: string;
}

export interface AgentContinuationInput {
  readonly content: string;
}

export interface AgentExecutorEvent {
  readonly state?: AgentTaskState;
  readonly progress?: AgentTaskProgress;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: readonly AgentArtifactReference[];
  readonly usage?: AgentTaskUsage;
}

export interface AgentTaskEvent extends AgentExecutorEvent {
  readonly taskId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly type: 'submitted' | 'state' | 'progress' | 'output' | 'artifact' | 'usage' | 'error' | 'cancellation';
  readonly cancellation?: AgentTaskCancellation;
}

export interface AgentExecutorPreflightResult {
  readonly ok: boolean;
  readonly reasons?: readonly string[];
}

export interface AgentExecutor {
  preflight?(input: AgentTaskStartInput): Promise<AgentExecutorPreflightResult>;
  start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference>;
  events(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent>;
  get(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot>;
  sendInput(reference: AgentExecutorTaskReference, input: AgentContinuationInput): Promise<void>;
  cancel(reference: AgentExecutorTaskReference, reason?: string): Promise<AgentExecutorTaskSnapshot>;
  reconcile(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot>;
  dispose(): Promise<void>;
}

export interface AgentExecutorFactoryContext {
  withCredential<T>(
    credentialRef: string,
    use: (credential: string) => Promise<T>,
  ): Promise<T>;
  authorizeArtifact(artifact: AgentArtifactReference): Promise<void>;
}

export interface AgentExecutorFactory {
  readonly executorId: string;
  readonly protocol: ExternalAgentProtocol;
  create(
    registration: ExternalAgentRegistration,
    context: AgentExecutorFactoryContext,
  ): Promise<AgentExecutor>;
}

export interface AgentPreflightInput {
  readonly agentId: string;
  readonly query: DispatchableAgentQuery;
  readonly expectedConfigurationRevision?: string;
}

export interface AgentPreflightResult {
  readonly ok: boolean;
  readonly descriptor?: DispatchableAgentDescriptor;
  readonly dispatchability: AgentDispatchabilitySnapshot;
  readonly reasons: readonly string[];
}

export interface AgentTaskFilter {
  readonly agentId?: string;
  readonly parentTaskId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly state?: AgentTaskState | readonly AgentTaskState[];
}

export interface LocalAgentTaskInput extends AgentTaskCorrelation {
  readonly taskId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly configurationRevision: string;
  readonly origin?: 'native' | 'constructed';
}

export interface LocalAgentTaskUpdate {
  readonly state?: AgentTaskState;
  readonly progress?: AgentTaskProgress;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: readonly AgentArtifactReference[];
  readonly usage?: AgentTaskUsage;
}

export interface AgentExecutorPlaneStore {
  loadRegistrations(): Promise<readonly ExternalAgentRegistration[]>;
  saveRegistrations(registrations: readonly ExternalAgentRegistration[]): Promise<void>;
  /**
   * Optional compatibility extension for durable executor recovery across a
   * registration update/removal. Built-in stores implement both hooks. A
   * custom store that omits them can only recover through a still-current
   * registration with the same revision; otherwise recovery fails closed.
   * Implement both hooks or neither. The plane is the single writer and
   * serializes whole-map replacements. Credential fields in snapshots are
   * references only; `executorConfig` must likewise contain public data or secret
   * references, never secret material. A store must never resolve or persist a
   * referenced secret value.
   */
  loadTaskRegistrationSnapshots?(): Promise<readonly ExternalAgentRegistration[]>;
  saveTaskRegistrationSnapshots?(
    registrations: readonly ExternalAgentRegistration[],
  ): Promise<void>;
  loadTasks(): Promise<readonly AgentTaskSnapshot[]>;
  saveTask(task: AgentTaskSnapshot): Promise<void>;
  loadEvents(taskId: string): Promise<readonly AgentTaskEvent[]>;
  appendEvent(event: AgentTaskEvent): Promise<void>;
}

export interface AgentRegistrationMutationOptions {
  /** `null` means that no registration may exist; `undefined` disables CAS. */
  readonly expectedConfigurationRevision?: string | null;
  /** `null` means that no manager may own the registration; `undefined` disables owner CAS. */
  readonly expectedManagementOwner?: string | null;
}

export interface AgentRegistrationEnabledMutationOptions extends AgentRegistrationMutationOptions {
  /** Atomically claims an unowned registration; a different existing owner is rejected. */
  readonly claimOwner?: string;
}

export interface AgentRegistrationService {
  list(): Promise<readonly ExternalAgentRegistrationSummary[]>;
  upsert(
    input: ExternalAgentRegistration,
    options?: AgentRegistrationMutationOptions,
  ): Promise<ExternalAgentRegistrationSummary>;
  setEnabled(
    agentId: string,
    enabled: boolean,
    options?: AgentRegistrationEnabledMutationOptions,
  ): Promise<ExternalAgentRegistrationSummary | undefined>;
  remove(agentId: string, options?: AgentRegistrationMutationOptions): Promise<boolean>;
}

export interface AgentTaskService {
  start(input: AgentTaskStartInput): Promise<AgentTaskSnapshot>;
  list(filter?: AgentTaskFilter): Promise<readonly AgentTaskSnapshot[]>;
  get(taskId: string): Promise<AgentTaskSnapshot>;
  events(taskId: string, cursor?: number): Promise<readonly AgentTaskEvent[]>;
  wait(taskId: string, timeoutMs?: number): Promise<AgentTaskSnapshot>;
  sendInput(taskId: string, input: AgentContinuationInput): Promise<AgentTaskSnapshot>;
  cancel(taskId: string, reason?: string): Promise<AgentTaskSnapshot>;
  reconcile(taskId: string): Promise<AgentTaskSnapshot>;
  recordLocal(input: LocalAgentTaskInput): Promise<AgentTaskSnapshot>;
  updateLocal(taskId: string, update: LocalAgentTaskUpdate): Promise<AgentTaskSnapshot>;
}

export interface AgentExecutorPlaneBinding {
  readonly plane: AgentExecutorPlane;
  readonly context: AgentDispatchContext;
}

export interface AgentExecutorPlane {
  readonly registrations: AgentRegistrationService;
  readonly tasks: AgentTaskService;
  listDispatchable(
    query: DispatchableAgentQuery,
    localAgents?: readonly DispatchableAgentDescriptor[],
  ): Promise<readonly DispatchableAgentListing[]>;
  describe(
    agentId: string,
    query: DispatchableAgentQuery,
    localAgents?: readonly DispatchableAgentDescriptor[],
  ): Promise<DispatchableAgentListing | undefined>;
  preflight(
    input: AgentPreflightInput,
    localAgents?: readonly DispatchableAgentDescriptor[],
  ): Promise<AgentPreflightResult>;
  close(): Promise<void>;
}

export interface AgentExecutorPlaneBackgroundErrorContext {
  readonly operation: 'event-pump-recovery' | 'task-admission-event' | 'executor-dispose';
  readonly taskId?: string;
  readonly agentId?: string;
  readonly configurationRevision?: string;
}

export type AgentExecutorPlaneBackgroundErrorHandler = (
  error: Error,
  context: AgentExecutorPlaneBackgroundErrorContext,
) => void | Promise<void>;

export interface CreateAgentExecutorPlaneOptions {
  readonly factories: readonly AgentExecutorFactory[];
  readonly policy: AgentDispatchPolicy;
  readonly credentialBroker?: AgentCredentialBroker;
  readonly artifactPolicy?: AgentArtifactPolicy;
  /** Receives failures from detached event handling and best-effort resource cleanup. */
  readonly onBackgroundError?: AgentExecutorPlaneBackgroundErrorHandler;
  readonly store?: AgentExecutorPlaneStore;
  readonly now?: () => Date;
  readonly createTaskId?: () => string;
  readonly createIdempotencyKey?: () => string;
}
