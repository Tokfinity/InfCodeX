import type {
  AgentEffectDeclaration,
  AgentExecutorFactory,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';

import type {
  KodaXRuntime,
  RuntimeExecutionToolPolicy,
  RuntimeKodaXOptions,
  RuntimeUserMarkdownAgentRef,
  RuntimeWorkspaceBinding,
} from '../sdk-runtime.js';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_EXECUTOR_ID = 'kodax-a2a-v1-jsonrpc';

export type A2ATaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface A2APart {
  readonly text?: string;
  readonly raw?: string;
  readonly url?: string;
  readonly data?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly filename?: string;
  readonly mediaType?: string;
}

export interface A2AMessage {
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId?: string;
  readonly role: 'ROLE_USER' | 'ROLE_AGENT';
  readonly parts: readonly A2APart[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extensions?: readonly string[];
  readonly referenceTaskIds?: readonly string[];
}

export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  readonly message?: A2AMessage;
  readonly timestamp?: string;
}

export interface A2AArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly A2APart[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extensions?: readonly string[];
}

export interface A2ATask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2ATaskStatus;
  readonly artifacts?: readonly A2AArtifact[];
  readonly history?: readonly A2AMessage[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface A2AAgentInterface {
  readonly url: string;
  readonly protocolBinding: string;
  readonly tenant?: string;
  readonly protocolVersion: string;
}

export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
  readonly securityRequirements?: readonly Readonly<Record<string, unknown>>[];
}

export interface A2AAgentExtension {
  readonly uri: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface A2AAgentCard {
  readonly name: string;
  readonly description: string;
  readonly supportedInterfaces: readonly A2AAgentInterface[];
  readonly version: string;
  readonly capabilities: {
    readonly streaming?: boolean;
    readonly pushNotifications?: boolean;
    readonly extendedAgentCard?: boolean;
    readonly extensions?: readonly A2AAgentExtension[];
  };
  readonly securitySchemes?: Readonly<Record<string, unknown>>;
  readonly securityRequirements?: readonly Readonly<Record<string, unknown>>[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
}

export interface A2AJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface A2AJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface A2AJsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: A2AJsonRpcError;
}

export interface A2ANetworkPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowPrivateAddresses: boolean;
  /** Explicitly permits plaintext HTTP beyond exact loopback targets. */
  readonly allowInsecureHttp?: boolean;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
}

export interface A2AClientOptions {
  readonly networkPolicy: A2ANetworkPolicy;
  /** RPC/SSE task payload ceiling; Card/OAuth discovery keeps the stricter network limit. */
  readonly maxTaskResponseBytes?: number;
  readonly pollIntervalMs: number;
  readonly authorization?: string;
  /** Trusted transport override. Supplying one opts out of the default DNS-pinned connector. */
  readonly fetch?: typeof globalThis.fetch;
}

export type A2AClientAuthenticationInput =
  | {
      readonly type: 'http-bearer';
      readonly scheme: string;
      readonly credentialRef: string;
    }
  | {
      readonly type: 'oauth2-client-credentials';
      readonly scheme: string;
      readonly issuer: string;
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecretRef: string;
      readonly scopes: readonly string[];
      readonly resource?: string;
      readonly clientAuthentication: 'client-secret-basic' | 'client-secret-post';
    };

export interface A2ARegistrationInput {
  readonly agentId: string;
  readonly agentCardUrl: string;
  /** Legacy shorthand for HTTP Bearer; prefer authentication. */
  readonly credentialRef?: string;
  readonly authentication?: A2AClientAuthenticationInput;
  readonly effects: Pick<AgentEffectDeclaration, 'remote'>;
}

export interface A2ADiscoveredRegistration {
  readonly registration: ExternalAgentRegistration;
  readonly agentCard: A2AAgentCard;
}

export interface A2APrincipal {
  readonly subject: string;
  readonly tenant?: string;
  readonly scopes: readonly string[];
}

export interface A2AAuthentication {
  /**
   * Non-secret authority identifier used to namespace durable task ownership.
   * Keep it stable across credential rotation; change it when the identity authority changes.
   */
  readonly securityRealm: string;
  readonly securitySchemes: Readonly<Record<string, unknown>>;
  readonly securityRequirements: readonly Readonly<Record<string, unknown>>[];
  authenticate(request: Request): Promise<A2APrincipal | null>;
}

export type A2AOperation =
  | 'send-message'
  | 'send-streaming-message'
  | 'get-task'
  | 'list-tasks'
  | 'cancel-task'
  | 'subscribe-to-task'
  | 'get-extended-agent-card';

export interface A2AAuthorizationInput {
  readonly principal: A2APrincipal;
  readonly operation: A2AOperation;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly inputModes?: readonly string[];
}

export interface A2AServerLimits {
  readonly maxRequestBytes: number;
  readonly maxPartBytes: number;
  readonly maxConcurrentTasks: number;
  /** Maximum synchronous SendMessage wait before returning the current task. */
  readonly maxTaskWaitMs?: number;
  /** @deprecated Use maxRetainedTasksPerPrincipal. */
  readonly maxTasksPerPrincipal?: number;
  readonly maxActiveTasksPerPrincipal?: number;
  readonly maxRetainedTasksPerPrincipal?: number;
  readonly maxEventsPerTask?: number;
  readonly maxEventBytesPerTask?: number;
  readonly maxWorkspaceBytesPerContext?: number;
}

export type A2AServerExecution =
  | {
      readonly kind: 'runtime-default';
      readonly profileId?: string;
      readonly workspace: RuntimeWorkspaceBinding;
      readonly toolPolicy: RuntimeExecutionToolPolicy;
    }
  | {
      readonly kind: 'local-agent';
      readonly agentRef: RuntimeUserMarkdownAgentRef;
      readonly profileId?: string;
      readonly workspace: RuntimeWorkspaceBinding;
      readonly toolPolicy: RuntimeExecutionToolPolicy;
    };

export interface A2APublishedSkill extends A2AAgentSkill {}

export interface A2APublishedAgent {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly publicBaseUrl: string;
  readonly skills: readonly A2APublishedSkill[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
  readonly profileId?: string;
  readonly projectPath?: string;
  readonly runOptions?: RuntimeKodaXOptions;
}

export interface A2AServerEvent {
  readonly type: string;
  readonly time: string;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly runId?: string;
  readonly outcome?: 'accepted' | 'rejected' | 'completed' | 'failed';
  readonly diagnosticId?: string;
}

export interface A2AServerOptions {
  readonly runtime: KodaXRuntime;
  readonly agent: A2APublishedAgent;
  /** When set, prepareKodaXA2AServer binds an immutable Runtime execution snapshot. */
  readonly execution?: A2AServerExecution;
  readonly dataDir: string;
  readonly limits: A2AServerLimits;
  readonly authentication: A2AAuthentication;
  authorize(input: A2AAuthorizationInput): Promise<boolean>;
  readonly extendedAgentCard?: A2AAgentCard;
  readonly onEvent?: (event: A2AServerEvent) => void;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface A2AServerHotOptions {
  readonly agent: A2APublishedAgent;
  readonly limits: A2AServerLimits;
  readonly authentication: A2AAuthentication;
  authorize(input: A2AAuthorizationInput): Promise<boolean>;
  readonly extendedAgentCard?: A2AAgentCard;
}

export interface KodaXA2AServer {
  readonly agentCard: A2AAgentCard;
  whenReady(): Promise<void>;
  handle(request: Request): Promise<Response>;
  listen(input: { readonly hostname: string; readonly port: number; readonly publicBaseUrl?: string }): Promise<string>;
  /** Atomically replace publication/auth/limit policy for subsequent requests. */
  updateHot(options: A2AServerHotOptions): void;
  close(): Promise<void>;
}

export type CreateA2AAgentExecutorFactory = (
  options: A2AClientOptions,
) => AgentExecutorFactory;
