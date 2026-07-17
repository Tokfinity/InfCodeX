export type AgentActorState = 'running' | 'idle' | 'closed';
export type AgentTurnState = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted';
export type AgentExecutionKind = 'native' | 'constructed' | 'workflow' | 'external';
export type AgentForkTurns = 'all' | 'none' | number;
export type AgentDataClassification = 'public' | 'internal' | 'sensitive';
export type AgentMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly AgentMetadataValue[]
  | { readonly [key: string]: AgentMetadataValue };

export interface AgentCapabilities {
  readonly tools: readonly string[];
  readonly filesystem: 'none' | 'read' | 'write';
  readonly network: boolean;
  readonly providers: readonly string[];
  readonly canAskUser: boolean;
  /** Backend operation support. Omitted means the complete native contract. */
  readonly control?: {
    readonly followup: boolean;
    readonly interrupt: boolean;
    readonly streaming: boolean;
    readonly artifacts: boolean;
  };
}

export interface AgentActor {
  readonly path: string;
  readonly taskName: string;
  readonly parentPath?: string;
  readonly kind: AgentExecutionKind;
  readonly state: AgentActorState;
  readonly capabilities: AgentCapabilities;
  readonly turnIds: readonly string[];
  readonly currentTurnId?: string;
  readonly mailboxCursor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface AgentTurn {
  readonly turnId: string;
  readonly actorPath: string;
  readonly sequence: number;
  readonly state: AgentTurnState;
  readonly objective: string;
  readonly forkTurns: AgentForkTurns;
  readonly metadata?: Readonly<Record<string, AgentMetadataValue>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly output?: string;
  readonly artifacts?: readonly string[];
  readonly error?: string;
  readonly revision: number;
}

export interface AgentMailboxMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly senderPath: string;
  readonly recipientPath: string;
  readonly turnId?: string;
  readonly kind: 'message' | 'followup' | 'completion';
  readonly classification: AgentDataClassification;
  readonly content: string;
  readonly createdAt: string;
}

export type AgentEventKind =
  | 'actor_spawned'
  | 'turn_started'
  | 'message_delivered'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'actor_closed';

export interface AgentEvent {
  readonly sequence: number;
  readonly kind: AgentEventKind;
  readonly actorPath: string;
  readonly turnId?: string;
  readonly parentPath?: string;
  readonly createdAt: string;
}

export interface AgentSpawnInput {
  readonly taskName: string;
  readonly objective: string;
  readonly kind?: AgentExecutionKind;
  readonly forkTurns?: AgentForkTurns;
  readonly capabilities?: Partial<AgentCapabilities>;
  readonly metadata?: Readonly<Record<string, AgentMetadataValue>>;
}

export interface AgentTurnRef {
  readonly actorPath: string;
  readonly turnId: string;
  readonly state: 'accepted' | 'running';
}

export interface AgentFollowupResult {
  readonly delivery: 'started_turn' | 'current_turn';
  readonly turn: AgentTurnRef;
}

export interface AgentTreeSnapshot {
  readonly rootPath: '/root';
  readonly actors: readonly AgentActor[];
  readonly activeNonRootTurns: number;
  readonly maxConcurrentThreads: number;
  readonly revision: number;
}

export interface AgentDetail {
  readonly actor: AgentActor;
  readonly turns: readonly AgentTurn[];
  readonly mailbox: readonly AgentMailboxMessage[];
}

export interface AgentOutput {
  readonly actorPath: string;
  readonly turnId: string;
  readonly state: AgentTurnState;
  readonly output?: string;
  readonly artifacts: readonly string[];
  readonly error?: string;
}

export interface AgentLimitReached {
  readonly code: 'agent_limit_reached';
  readonly maxConcurrentThreads: number;
  readonly activeNonRootTurns: number;
  readonly availableNonRootSlots: 0;
  readonly retryable: true;
}

export interface AgentBudgetExhausted {
  readonly code: 'agent_budget_exhausted';
  readonly retryable: false;
  readonly reason: string;
}

export interface AgentBudgetAdmissionInput {
  readonly actorPath: string;
  readonly parentPath: string;
  readonly turnId: string;
  readonly kind: AgentExecutionKind;
  readonly units: 1;
}

export type AgentBudgetAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly fact: AgentBudgetExhausted };

export interface AgentBudgetPort {
  admit(input: AgentBudgetAdmissionInput): Promise<AgentBudgetAdmission>;
  refund?(turnId: string): Promise<void>;
  snapshot?(): unknown;
}

export interface AgentExecutionInput {
  readonly actor: AgentActor;
  readonly turn: AgentTurn;
  readonly priorTurns: readonly AgentTurn[];
  readonly signal: AbortSignal;
  drainMailbox(): Promise<readonly AgentMailboxMessage[]>;
}

export interface AgentExecutionResult {
  readonly output: string;
  readonly artifacts?: readonly string[];
}

export interface AgentTurnExecutor {
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
}

export interface AgentActorSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly maxConcurrentThreads: number;
  readonly actors: readonly AgentActor[];
  readonly turns: readonly AgentTurn[];
  readonly mailboxes: Readonly<Record<string, readonly AgentMailboxMessage[]>>;
  readonly events: readonly AgentEvent[];
}

export interface AgentActorStore {
  load(): Promise<AgentActorSnapshot | undefined>;
  save(snapshot: AgentActorSnapshot, expectedRevision: number): Promise<void>;
}

/** Runtime-bound actor control surface. The caller path is minted by Runtime. */
export interface AgentActorClient {
  readonly callerPath: string;
  spawn(input: AgentSpawnInput): Promise<AgentTurnRef>;
  send(
    targetPath: string,
    content: string,
    classification?: AgentDataClassification,
  ): Promise<void>;
  followup(
    targetPath: string,
    objective: string,
    metadata?: Readonly<Record<string, AgentMetadataValue>>,
  ): Promise<AgentFollowupResult>;
  interrupt(targetPath: string, reason?: string): Promise<void>;
  list(): AgentTreeSnapshot;
  get(targetPath: string): AgentDetail;
  output(targetPath: string, turnId?: string): AgentOutput;
  eventSnapshot(afterSequence?: number): readonly AgentEvent[];
  wait(afterSequence?: number, timeoutMs?: number): Promise<AgentEvent | undefined>;
}
