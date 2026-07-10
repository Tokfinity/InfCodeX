/**
 * SDK subpath entry - `@kodax-ai/kodax/runtime`.
 *
 * FEATURE_253 (v0.7.64): embedded runtime contract. This module composes the
 * existing coding run loop, REPL-backed session storage, and agent workflow
 * process manager without introducing a daemon or a fifth workspace package.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getActiveExtensionRuntime,
  generateSessionId,
  listCodingDispatchableAgents,
  registerCustomProviders,
  runManagedTask,
  startKodaX,
  validateCustomProviderConfig,
} from '@kodax-ai/coding';
import * as replApi from '@kodax-ai/repl';
import type {
  AskUserAnswer,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  ExtensionCommandDefinition,
  ExtensionRuntimeDiagnostics,
  LoadedExtensionDiagnostic,
  KodaXCustomProviderConfig,
  KodaXActivityEventMeta,
  KodaXEvents,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXMessage,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionData,
  KodaXSessionRuntimeInfo,
  KodaXToolEventMeta,
  KodaXTurnCompletedEvent,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
  RuntimeContextBudgetSnapshot,
  RuntimeToolExposurePlan,
  KodaXVideoInputArtifact,
  RunningSession,
} from '@kodax-ai/coding';
import {
  createSessionManager,
  listCustomProviders,
  getProviderList,
  getMcpServerConfig,
  listMcpServers,
  loadConfig,
  prepareRuntimeConfig,
  removeCustomProvider,
  removeMcpServer,
  saveConfig,
  upsertCustomProvider,
  upsertMcpServer,
  validateMcpServerConfig,
} from '@kodax-ai/repl';
import type {
  CommandInfo as ReplCommandInfo,
  CompactSessionResult,
  DeleteSessionResult,
  FullTranscriptSessionData,
  SessionManager,
  SessionSummary,
  SessionTranscriptEntry,
} from '@kodax-ai/repl';
import {
  createMcpManager,
  createAgentExecutorPlane,
  emitKodaXDiagnostic,
  getDefaultWorkflowRunManager,
  initializeSkillRegistry,
} from '@kodax-ai/agent';
import type {
  AgentArtifactPolicy,
  AgentCredentialBroker,
  AgentDispatchContext,
  AgentDispatchPolicy,
  AgentExecutorFactory,
  AgentExecutorPlane,
  AgentPreflightInput,
  AgentPreflightResult,
  AgentRegistrationService,
  AgentTaskFilter,
  AgentTaskService,
  AgentTaskSnapshot,
  AgentTaskStartInput,
  DispatchableAgentListing,
  DispatchableAgentQuery,
  ManagedWorkflowSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpServerToolList,
  Skill,
  SkillMetadata,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
} from '@kodax-ai/agent';
import { createRuntimeAgentExecutorPlaneStore } from './runtime-agent-store.js';
import {
  createRuntimeDaemonClient,
  type RuntimeDaemonClientTransport,
} from './runtime-daemon/client.js';
import { acquireRuntimeDaemonLease } from './runtime-daemon/manager.js';
import { acquireRuntimeDaemonProcessLease } from './runtime-daemon/process.js';
import { createRuntimeWorkerTransport } from './runtime-worker/transport.js';
import type { RuntimeWorkerOptions } from './runtime-worker/protocol.js';
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from './runtime-daemon/transport.js';
import {
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths,
} from './runtime-daemon/state.js';
export type { RuntimeDaemonClientTransport } from './runtime-daemon/client.js';
export {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_METHODS,
} from './runtime-daemon/protocol.js';
export type {
  RuntimeDaemonError,
  RuntimeDaemonErrorCode,
  RuntimeDaemonFrame,
  RuntimeDaemonMethod,
  RuntimeDaemonNotification,
  RuntimeDaemonNotificationMethod,
  RuntimeDaemonRequest,
} from './runtime-daemon/protocol.js';
export {
  RUNTIME_DAEMON_METHOD_SCHEMAS,
  RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON,
  listRuntimeDaemonSchemaMethods,
} from './runtime-daemon/schema.js';
export type {
  RuntimeDaemonJsonSchema,
  RuntimeDaemonMethodSchema,
  RuntimeDaemonProtocolSchema,
} from './runtime-daemon/schema.js';
export type { RuntimeDaemonEndpoint } from './runtime-daemon/transport.js';
export type {
  RuntimeContextBudgetSnapshot,
  RuntimeToolExposurePlan,
} from '@kodax-ai/coding';

export type KodaXRuntimeMode = 'embedded' | 'daemon';
export type KodaXRuntimeIsolation = 'inline' | 'worker' | 'process';
export type { RuntimeWorkerOptions, RuntimeWorkerResourceLimits } from './runtime-worker/protocol.js';

type ReplRuntimeConfigPatch = Parameters<typeof saveConfig>[0];

const RUNTIME_CONFIG_PATCH_KEYS = [
  'provider',
  'model',
  'effort',
  'planModeEffort',
  'thinking',
  'reasoningMode',
  'agentMode',
  'permissionMode',
  'locale',
  'providerModels',
  'extensions',
  'repoIntelligenceMode',
  'repoIntelligenceTrace',
  'verifierLog',
  'stallLog',
  'fallbackProviders',
  'fastProvider',
  'fastModel',
  'deepProvider',
  'deepModel',
  'maxOutputTokens',
  'disablePromptCache',
  'lsp',
  'lspAutoDownload',
  'acpLogLevel',
  'sessionRetentionDays',
  'repoIntelligence',
  'workflow',
] as const satisfies readonly (keyof ReplRuntimeConfigPatch)[];

type RuntimeConfigPatchKey = typeof RUNTIME_CONFIG_PATCH_KEYS[number];

export interface RuntimeIdentity {
  readonly runtimeId: string;
  readonly mode: KodaXRuntimeMode;
  readonly profile: string;
  readonly startedAt: string;
  readonly version: string;
  readonly isolation?: KodaXRuntimeIsolation;
  readonly workerThreadId?: number;
}

export interface RuntimeClientInfo {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
}

export interface RuntimeClientCapabilities {
  readonly richEvents?: boolean;
  readonly permissionPrompts?: boolean;
  readonly configAdmin?: boolean;
  readonly commandCatalog?: boolean;
  readonly skillCatalog?: boolean;
  readonly artifactUpload?: boolean;
  readonly contextDiagnostics?: boolean;
}

export interface RuntimeExternalAgentsOptions {
  readonly factories: readonly AgentExecutorFactory[];
  readonly policy: AgentDispatchPolicy;
  readonly credentialBroker?: AgentCredentialBroker;
  /** Authorizes an executor before it materializes any remote artifact. Defaults to deny. */
  readonly artifactPolicy?: AgentArtifactPolicy;
  /** Default host-derived context for Worker tools; run.start may override it. */
  readonly defaultContext?: AgentDispatchContext;
}

export interface CreateKodaXRuntimeOptions {
  /** Runtime ownership form. Defaults to a caller-owned embedded Runtime. */
  readonly mode?: KodaXRuntimeMode;
  /** Embedded-only execution location. Daemon mode selects host isolation internally. */
  readonly isolation?: 'inline' | 'worker';
  /** Requires `isolation: 'worker'`; rejected instead of being silently ignored. */
  readonly worker?: RuntimeWorkerOptions;
  readonly homeDir?: string;
  readonly profile?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
  readonly daemonStartupTimeoutMs?: number;
  readonly daemonConnectTimeoutMs?: number;
  readonly daemonTransport?: RuntimeDaemonClientTransport;
  readonly daemonEndpoint?: string | RuntimeDaemonEndpoint;
  /** Defaults to true for daemon mode unless a transport or endpoint is supplied. */
  readonly autoStartDaemon?: boolean;
  readonly daemonToken?: string;
  readonly clientInfo?: RuntimeClientInfo;
  readonly capabilities?: RuntimeClientCapabilities;
  readonly requirements?: RuntimeCapabilityRequirements;
  /** Inline host injection. Functions never cross daemon or Worker transport. */
  readonly externalAgents?: RuntimeExternalAgentsOptions;
}

export interface ConnectKodaXRuntimeOptions {
  readonly profile?: string;
  /** Attach-only by default; set true to start or reuse the local profile daemon. */
  readonly autoStart?: boolean;
  readonly endpoint?: string | RuntimeDaemonEndpoint;
  readonly transport?: RuntimeDaemonClientTransport;
  readonly homeDir?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
  readonly daemonStartupTimeoutMs?: number;
  readonly daemonConnectTimeoutMs?: number;
  readonly daemonToken?: string;
  readonly clientInfo?: RuntimeClientInfo;
  readonly capabilities?: RuntimeClientCapabilities;
  readonly requirements?: RuntimeCapabilityRequirements;
}

export interface RuntimeCapabilityRequirements {
  /** Reject inline and shared daemon hosts; only a Worker-hosted Runtime satisfies this. */
  readonly hardDispose?: boolean;
  /** Reject hosts that do not advertise an installed external Agent executor plane. */
  readonly externalAgents?: boolean;
}

export interface RuntimeDiagnosticFilter {
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface RuntimeDiagnosticsService {
  latestContextBudget(filter?: RuntimeDiagnosticFilter): Promise<RuntimeContextBudgetSnapshot | null>;
  latestToolExposure(filter?: RuntimeDiagnosticFilter): Promise<RuntimeToolExposurePlan | null>;
}

export interface KodaXRuntime {
  readonly identity: RuntimeIdentity;
  readonly sessions: RuntimeSessionService;
  readonly runs: RuntimeRunService;
  readonly events: RuntimeEventService;
  readonly permissions: RuntimePermissionService;
  readonly workflows: RuntimeWorkflowService;
  readonly config: RuntimeConfigService;
  readonly catalog: RuntimeCatalogService;
  readonly mcp: RuntimeMcpService;
  readonly artifacts: RuntimeArtifactService;
  readonly status: RuntimeStatusService;
  readonly diagnostics: RuntimeDiagnosticsService;
  readonly admin: RuntimeAdminService;
  readonly agents: RuntimeAgentService;
  readonly agentTasks: RuntimeAgentTaskService;
  /**
   * Release this facade. Inline closes its private Runtime, Worker mode shuts
   * down and terminates its Worker, and daemon mode only detaches this client.
   */
  close(): Promise<void>;
}

export interface RuntimeAdminService {
  readonly agentRegistrations: AgentRegistrationService;
}

export interface RuntimeAgentService {
  readonly enabled: boolean;
  listDispatchable(query: DispatchableAgentQuery): Promise<readonly DispatchableAgentListing[]>;
  describe(
    agentId: string,
    query: DispatchableAgentQuery,
  ): Promise<DispatchableAgentListing | undefined>;
  preflight(input: AgentPreflightInput): Promise<AgentPreflightResult>;
}

export type RuntimeAgentTaskService = Pick<
  AgentTaskService,
  'start' | 'list' | 'get' | 'events' | 'wait' | 'sendInput' | 'cancel' | 'reconcile'
>;

export type RuntimeConfigPatch = Partial<Pick<ReplRuntimeConfigPatch, RuntimeConfigPatchKey>>;

export interface RuntimeConfigReloadResult {
  readonly ok: true;
  readonly config: unknown;
}

export interface RuntimeConfigService {
  read(): Promise<unknown>;
  patch(patch: RuntimeConfigPatch): Promise<unknown>;
  reload(): Promise<RuntimeConfigReloadResult>;
}

export interface RuntimeModelListFilter {
  readonly provider?: string;
}

export interface RuntimeCommandResolveInput {
  readonly name: string;
  readonly projectRoot?: string;
}

export interface RuntimeCommandInfo {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly source: ReplCommandInfo['source'];
  readonly usage?: string;
  readonly argumentHint?: string;
  readonly location?: ReplCommandInfo['location'];
  readonly path?: string;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly allowedTools?: string;
  readonly context?: 'fork';
  readonly agent?: string;
  readonly model?: string;
}

export interface RuntimeSkillListFilter {
  readonly projectRoot?: string;
  readonly userInvocableOnly?: boolean;
}

export interface RuntimeSkillDescribeInput {
  readonly name: string;
  readonly projectRoot?: string;
}

export interface RuntimeSkillFileSummary {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
}

export interface RuntimeSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly userInvocable: boolean;
  readonly argumentHint?: string;
  readonly path: string;
  readonly source: SkillMetadata['source'];
  readonly disableModelInvocation: boolean;
}

export interface RuntimeSkillDescription extends RuntimeSkillSummary {
  readonly content: string;
  readonly skillFilePath: string;
  readonly scripts?: readonly RuntimeSkillFileSummary[];
  readonly references?: readonly RuntimeSkillFileSummary[];
  readonly assets?: readonly RuntimeSkillFileSummary[];
  readonly templates?: readonly RuntimeSkillFileSummary[];
  readonly resources?: readonly RuntimeSkillFileSummary[];
}

export interface RuntimeExtensionReloadResult {
  readonly ok: true;
  readonly active: boolean;
  readonly diagnostics?: ExtensionRuntimeDiagnostics;
}

export interface RuntimeExtensionListResult {
  readonly active: boolean;
  readonly extensions: readonly LoadedExtensionDiagnostic[];
  readonly diagnostics?: ExtensionRuntimeDiagnostics;
}

export interface RuntimeCatalogService {
  providers(): Promise<unknown>;
  models(filter?: RuntimeModelListFilter): Promise<unknown>;
  commands(projectRoot?: string): Promise<readonly RuntimeCommandInfo[]>;
  resolveCommand(input: RuntimeCommandResolveInput): Promise<RuntimeCommandInfo | null>;
  skills(filter?: RuntimeSkillListFilter): Promise<readonly RuntimeSkillSummary[]>;
  describeSkill(input: RuntimeSkillDescribeInput): Promise<RuntimeSkillDescription | null>;
  customProviders(): Promise<readonly KodaXCustomProviderConfig[]>;
  upsertCustomProvider(config: KodaXCustomProviderConfig): Promise<KodaXCustomProviderConfig>;
  deleteCustomProvider(name: string): Promise<boolean>;
  extensions(): Promise<RuntimeExtensionListResult>;
  reloadExtensions(): Promise<RuntimeExtensionReloadResult>;
}

export interface RuntimeMcpToolListFilter {
  readonly server?: string;
  readonly forceRefresh?: boolean;
}

export interface RuntimeMcpReloadResult {
  readonly ok: true;
  readonly servers: readonly McpServerStatus[];
}

export type RuntimeMcpValidateResult =
  | {
    readonly ok: true;
    readonly config: McpServerConfig;
  }
  | {
    readonly ok: false;
    readonly error: string;
  };

export interface RuntimeMcpService {
  listServers(): Promise<Record<string, McpServerConfig>>;
  getServer(name: string): Promise<McpServerConfig | undefined>;
  validateServer(name: string, config: unknown): Promise<RuntimeMcpValidateResult>;
  upsertServer(name: string, config: McpServerConfig): Promise<McpServerConfig>;
  deleteServer(name: string): Promise<boolean>;
  reloadServers(): Promise<RuntimeMcpReloadResult>;
  listTools(filter?: RuntimeMcpToolListFilter): Promise<readonly McpServerToolList[]>;
}

export type RuntimeArtifactKind = 'image' | 'file' | 'video';

export interface RuntimeCreateArtifactInput {
  readonly kind: RuntimeArtifactKind;
  readonly path: string;
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeArtifact {
  readonly id: string;
  readonly kind: RuntimeArtifactKind;
  readonly path: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
  readonly createdAt: string;
}

export interface RuntimeArtifactService {
  create(input: RuntimeCreateArtifactInput): Promise<RuntimeArtifact>;
  get(artifactId: string): Promise<RuntimeArtifact | undefined>;
  delete(artifactId: string): Promise<boolean>;
}

export interface RuntimeCreateSessionInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly projectPath?: string;
  readonly gitRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly tag?: string;
}

export interface RuntimeSession {
  readonly id: string;
  readonly title: string;
  readonly gitRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly createdAt?: string;
}

export interface RuntimeSessionSummary extends RuntimeSession {
  readonly msgCount: number;
  readonly tag?: string;
  readonly projectKey?: string;
  readonly archived?: boolean;
}

export type RuntimeTranscript = FullTranscriptSessionData;

export interface RuntimeSessionFilter {
  readonly projectRoot?: string;
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly tag?: string;
}

export interface RuntimeForkSessionInput {
  readonly sessionId: string;
  readonly selector?: string;
  readonly newSessionId?: string;
  readonly title?: string;
}

export interface RuntimeSessionSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: KodaXOptions['effort'];
  readonly thinking?: boolean;
  readonly reasoningMode?: KodaXReasoningMode;
  readonly permissionMode?: string;
  readonly executionCwd?: string;
}

export interface RuntimeSessionSettingsPatch {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly effort?: KodaXOptions['effort'] | null;
  readonly thinking?: boolean | null;
  readonly reasoningMode?: KodaXReasoningMode | null;
  readonly permissionMode?: string | null;
  readonly executionCwd?: string | null;
}

export interface RuntimeAppendNoticeInput {
  readonly sessionId: string;
  readonly content: string;
  readonly source?: string;
}

export interface RuntimeRewindSessionInput {
  readonly sessionId: string;
  readonly selector?: string;
}

export interface RuntimeSetActiveEntryInput {
  readonly sessionId: string;
  readonly entryId: string;
}

export interface RuntimeCompactSessionInput {
  readonly sessionId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly customInstructions?: string;
  readonly contextWindow?: number;
}

export interface RuntimeCompactSessionResult extends CompactSessionResult {
  readonly session?: RuntimeSession;
}

export interface RuntimeSessionService {
  create(input?: RuntimeCreateSessionInput): Promise<RuntimeSession>;
  load(sessionId: string): Promise<RuntimeSession>;
  list(filter?: RuntimeSessionFilter): Promise<readonly RuntimeSessionSummary[]>;
  transcript(sessionId: string): Promise<RuntimeTranscript | null>;
  fork(input: RuntimeForkSessionInput): Promise<RuntimeSession | null>;
  getSettings(sessionId: string): Promise<RuntimeSessionSettings>;
  updateSettings(
    sessionId: string,
    patch: RuntimeSessionSettingsPatch,
  ): Promise<RuntimeSessionSettings>;
  appendNotice(input: RuntimeAppendNoticeInput): Promise<SessionTranscriptEntry | null>;
  rewind(input: RuntimeRewindSessionInput): Promise<RuntimeSession | null>;
  setActiveEntry(input: RuntimeSetActiveEntryInput): Promise<RuntimeSession | null>;
  compact(input: RuntimeCompactSessionInput): Promise<RuntimeCompactSessionResult>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type RuntimeRunPhase =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RuntimeRunMode = 'coding' | 'managed_task';

export interface RuntimeTextInput {
  readonly type: 'text';
  readonly text: string;
}

export interface RuntimeImageInput {
  readonly type: 'image';
  readonly path: string;
  readonly mediaType?: KodaXImageInputArtifact['mediaType'];
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeFileInput {
  readonly type: 'file';
  readonly path: string;
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeVideoInput {
  readonly type: 'video';
  readonly path: string;
  readonly mediaType: KodaXVideoInputArtifact['mediaType'];
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeArtifactRefInput {
  readonly type: 'artifact_ref';
  readonly artifactId: string;
  readonly description?: string;
}

export type RuntimeInput =
  | RuntimeTextInput
  | RuntimeImageInput
  | RuntimeFileInput
  | RuntimeVideoInput
  | RuntimeArtifactRefInput;

export type RuntimePermissionBroker = 'runtime' | 'client';

export interface RuntimeStartRunInput {
  readonly sessionId: string;
  readonly prompt?: string;
  readonly input?: RuntimeInput | readonly RuntimeInput[];
  readonly mode?: RuntimeRunMode;
  readonly permissionBroker?: RuntimePermissionBroker;
  readonly options?: RuntimeKodaXOptions;
  /** Host-derived dispatch identity; never accepted from an LLM tool payload. */
  readonly agentContext?: AgentDispatchContext;
}

export type RuntimeKodaXOptions =
  Omit<KodaXOptions, 'provider' | 'session' | 'events'>
  & {
    readonly provider?: string;
    readonly session?: KodaXOptions['session'];
    readonly events?: KodaXEvents;
  };

export interface RuntimeRunStatus {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly phase: RuntimeRunPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly provider: string;
  readonly model?: string;
  readonly reasoning?: KodaXReasoningMode;
  readonly error?: string;
}

export interface RuntimeRunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: RuntimeRunPhase;
  readonly result?: KodaXResult;
  readonly error?: Error;
}

export interface RuntimeRunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly result: Promise<RuntimeRunResult>;
}

export interface RuntimeRunFilter {
  readonly sessionId?: string;
  readonly phase?: RuntimeRunPhase | readonly RuntimeRunPhase[];
}

export interface RuntimeRunService {
  start(input: RuntimeStartRunInput): Promise<RuntimeRunHandle>;
  await(runId: string): Promise<RuntimeRunResult>;
  get(runId: string): Promise<RuntimeRunStatus>;
  list(filter?: RuntimeRunFilter): Promise<readonly RuntimeRunStatus[]>;
  abort(runId: string): Promise<void>;
  setModel(runId: string, model: string | undefined): Promise<void>;
  setProvider(runId: string, provider: string): Promise<void>;
  setReasoning(runId: string, reasoning: KodaXReasoningMode | undefined): Promise<void>;
}

export type RuntimeEventType =
  | 'session.created'
  | 'session.loaded'
  | 'session.settings.updated'
  | 'session.notice.appended'
  | 'session.rewound'
  | 'session.active_entry.updated'
  | 'session.compacted'
  | 'run.queued'
  | 'run.started'
  | 'run.progress'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'assistant.delta'
  | 'thinking.delta'
  | 'thinking.finished'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.finished'
  | 'user_input.requested'
  | 'user_input.resolved'
  | 'permission.requested'
  | 'permission.resolved'
  | 'workflow.started'
  | 'workflow.updated'
  | 'workflow.finished'
  | 'context.compaction.started'
  | 'context.compaction.stats'
  | 'context.compaction.finished'
  | 'context.compaction.messages'
  | 'context.compaction.ended'
  | 'context.compaction.skipped'
  | 'context.budget.snapshot'
  | 'tool.exposure.planned'
  | 'child_activity.finished'
  | 'provider.retry'
  | 'provider.recovery'
  | 'repo_intelligence.trace'
  | 'todo.updated'
  | 'todo.warning'
  | 'sidecar.message'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'artifact.created'
  | 'config.effective'
  | 'runtime.warning';

export interface RuntimeEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly seq: number;
  readonly time: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly type: RuntimeEventType;
  readonly payload: TPayload;
}

export type RuntimeEvent = RuntimeEventEnvelope;

export interface RuntimeEventFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly type?: RuntimeEventType | readonly RuntimeEventType[];
}

export interface RuntimeEventReplayFilter extends RuntimeEventFilter {
  readonly sinceSeq?: number;
  readonly limit?: number;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSubscription {
  close(): void;
}

export interface RuntimeEventService {
  subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener): RuntimeSubscription;
  replay(filter?: RuntimeEventReplayFilter): Promise<readonly RuntimeEvent[]>;
}

export type RuntimePermissionRisk = 'low' | 'medium' | 'high';

export interface RuntimePermissionScope {
  readonly toolName?: string;
  readonly sessionId?: string;
}

export interface RuntimePermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly risk?: RuntimePermissionRisk;
  readonly inputPreview?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RuntimePermissionRequestInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly risk?: RuntimePermissionRisk;
  readonly inputPreview?: string;
  readonly expiresAt?: string;
  readonly timeoutMs?: number;
}

export type RuntimePermissionDecision =
  | { readonly type: 'allow_once' }
  | { readonly type: 'allow_always'; readonly scope: RuntimePermissionScope }
  | { readonly type: 'reject'; readonly reason?: string };

export interface RuntimePermissionFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolName?: string;
}

export interface RuntimePermissionRespondOptions {
  readonly runId?: string;
}

export interface RuntimePermissionService {
  request(input: RuntimePermissionRequestInput): Promise<RuntimePermissionDecision>;
  listPending(filter?: RuntimePermissionFilter): Promise<readonly RuntimePermissionRequest[]>;
  respond(
    requestId: string,
    decision: RuntimePermissionDecision,
    options?: RuntimePermissionRespondOptions,
  ): Promise<boolean>;
}

type RuntimePermissionToolDecision = boolean | string;

export interface RuntimeWorkflowFilter {
  readonly runId?: string;
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export type RuntimeWorkflowSummary = ManagedWorkflowSnapshot;
export type RuntimeWorkflowSnapshot = WorkflowProcessSnapshot;
export type RuntimeWorkflowListener = (event: WorkflowProcessEvent) => void;

export interface RuntimeWorkflowService {
  list(filter?: RuntimeWorkflowFilter): Promise<readonly RuntimeWorkflowSummary[]>;
  get(runId: string): Promise<RuntimeWorkflowSnapshot | undefined>;
  subscribe(
    filter: RuntimeWorkflowFilter,
    listener: RuntimeWorkflowListener,
  ): RuntimeSubscription;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  stop(runId: string): Promise<boolean>;
}

export interface RuntimeStatusSnapshot {
  readonly runtimeId: string;
  readonly mode: KodaXRuntimeMode;
  readonly profile: string;
  readonly startedAt: string;
  readonly sessions: readonly RuntimeSessionSummary[];
  readonly runs: readonly RuntimeRunStatus[];
  readonly pendingPermissions: readonly RuntimePermissionRequest[];
  readonly workflows: readonly RuntimeWorkflowSummary[];
}

export interface RuntimeStatusService {
  snapshot(): Promise<RuntimeStatusSnapshot>;
}

interface RuntimeRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  turnId?: string;
  phase: RuntimeRunPhase;
  readonly startedAt: string;
  queuedAt?: string;
  endedAt?: string;
  provider: string;
  model?: string;
  permissionBroker?: RuntimePermissionBroker;
  permissionMode?: string;
  reasoning?: KodaXReasoningMode;
  error?: string;
  readonly result: Promise<RuntimeRunResult>;
  running?: RunningSession;
  abortController?: AbortController;
  mode: RuntimeRunMode;
  readonly agentContext?: AgentDispatchContext;
  start?: PendingRunStart;
  terminalEmitted: boolean;
}

interface PendingPermission {
  readonly request: RuntimePermissionRequest;
  readonly waiters: Array<(decision: RuntimePermissionDecision) => void>;
  readonly timer?: ReturnType<typeof setTimeout>;
}

type RuntimeEventBus = ReturnType<typeof createRuntimeEventBus>;
type RuntimePermissionRegistry = ReturnType<typeof createRuntimePermissionRegistry>;
type RuntimeArtifactStore = ReturnType<typeof createRuntimeArtifactStore>;

interface RuntimeRunServiceInternal extends RuntimeRunService {
  closeAll(reason: string): void;
}

interface PendingRunStart {
  readonly prompt: string;
  readonly inputArtifacts: readonly KodaXInputArtifact[];
  readonly options: RuntimeKodaXOptions;
  readonly resolve: (result: RuntimeRunResult) => void;
}

interface RuntimePersistence {
  readonly runtimeDir: string;
  appendEvent(event: RuntimeEvent): void;
  close(): void;
  nextEventSeq(): number;
  replay(filter?: RuntimeEventReplayFilter): readonly RuntimeEvent[];
  saveRunStatus(status: RuntimeRunStatus): void;
  loadRunStatus(runId: string): RuntimeRunStatus | undefined;
  loadRunStatuses(): readonly RuntimeRunStatus[];
  loadSessionSettings(sessionId: string): RuntimeSessionSettings;
  saveSessionSettings(sessionId: string, settings: RuntimeSessionSettings): void;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_RUNTIME_MEMORY_EVENTS = 10_000;
const MAX_RUNTIME_MEMORY_RUNS = 1_000;
const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_BUFFERED_EVENT_BYTES = 64 * 1024;
const RUNTIME_EVENT_FLUSH_INTERVAL_MS = 10;
const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;
const TARGET_RUNTIME_EVENT_FILE_BYTES = MAX_RUNTIME_EVENT_FILE_BYTES / 2;
const MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES = 128 * 1024;
const BUFFERED_RUNTIME_EVENT_TYPES: ReadonlySet<RuntimeEventType> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.progress',
  'run.progress',
]);
const RUNTIME_PERMISSION_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_describe',
]);
const RUNTIME_ARTIFACT_KINDS: ReadonlySet<string> = new Set(['image', 'file', 'video']);

export async function createKodaXRuntime(
  options: CreateKodaXRuntimeOptions = {},
): Promise<KodaXRuntime> {
  if (
    options.isolation !== undefined
    && options.isolation !== 'inline'
    && options.isolation !== 'worker'
  ) {
    throw new Error(`Unsupported KodaX Runtime isolation: ${String(options.isolation)}`);
  }
  if (options.mode === 'daemon') {
    if (options.isolation !== undefined) {
      throw new Error('Daemon mode selects its isolation internally and does not accept an isolation option.');
    }
    if (options.worker !== undefined) {
      throw new Error("Runtime Worker options require isolation: 'worker'.");
    }
    if (options.externalAgents !== undefined) {
      return createInProcessExternalAgentDaemon(options);
    }
    return connectKodaXRuntime({
      profile: options.profile,
      transport: options.daemonTransport,
      endpoint: options.daemonEndpoint,
      autoStart: options.autoStartDaemon ?? (
        options.daemonTransport === undefined
        && options.daemonEndpoint === undefined
      ),
      homeDir: options.homeDir,
      sessionsDir: options.sessionsDir,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      permissionTimeoutMs: options.permissionTimeoutMs,
      daemonStartupTimeoutMs: options.daemonStartupTimeoutMs,
      daemonConnectTimeoutMs: options.daemonConnectTimeoutMs,
      daemonToken: options.daemonToken,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      requirements: options.requirements,
    });
  }
  if (options.mode !== undefined && options.mode !== 'embedded') {
    throw new Error(`Unsupported KodaX runtime mode: ${String(options.mode)}`);
  }
  if (options.worker !== undefined && options.isolation !== 'worker') {
    throw new Error("Runtime Worker options require isolation: 'worker'.");
  }
  if (options.isolation === 'worker' && options.externalAgents !== undefined) {
    throw new Error('External agent factories must be installed inside the Runtime Worker host; function injection cannot cross the Worker boundary.');
  }
  if (options.isolation === 'worker') {
    return createWorkerHostedKodaXRuntime(options);
  }
  assertRuntimeCapabilities({
    hardDispose: false,
    externalAgents: options.externalAgents !== undefined,
  }, options.requirements);

  const identity: RuntimeIdentity = {
    runtimeId: `rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    mode: 'embedded',
    profile: options.profile ?? 'default',
    startedAt: new Date().toISOString(),
    version: process.env.KODAX_VERSION ?? '0.0.0',
    isolation: 'inline',
  };
  const sessionsDir = resolveRuntimeSessionsDir(options);
  const sessionManager = createSessionManager(
    sessionsDir ? { sessionsDir } : undefined,
  );
  const configFile = resolveRuntimeConfigFile(options);
  registerRuntimeConfiguredCustomProviders(configFile);
  const persistence = createRuntimePersistence(options);
  const agentPlane = options.externalAgents
    ? await createAgentExecutorPlane({
        factories: options.externalAgents.factories,
        policy: options.externalAgents.policy,
        credentialBroker: options.externalAgents.credentialBroker,
        artifactPolicy: options.externalAgents.artifactPolicy,
        store: createRuntimeAgentExecutorPlaneStore(path.join(persistence.runtimeDir, 'agents')),
      })
    : undefined;
  const bus = createRuntimeEventBus(persistence);
  const permissions = createRuntimePermissionRegistry(
    bus,
    options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  const artifacts = createRuntimeArtifactStore();
  const workflows = createRuntimeWorkflowService();
  const runs = new Map<string, RuntimeRunRecord>();
  for (const status of recentRunStatuses(persistence.loadRunStatuses())) {
    const recovered = interruptPersistedNonTerminalRun(status, bus, persistence);
    runs.set(recovered.runId, recordFromPersistedStatus(recovered));
  }
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error('KodaX runtime is closed');
    }
  };

  const runService = createRuntimeRunService({
    bus,
    defaultModel: options.defaultModel,
    defaultProvider: options.defaultProvider,
    ensureOpen,
    isClosed: () => closed,
    artifacts,
    permissions,
    persistence,
    runs,
    sessionManager,
    agentPlane,
    defaultAgentContext: options.externalAgents?.defaultContext,
  });

  const runtime: KodaXRuntime = {
    identity,
    sessions: createRuntimeSessionService(
      sessionManager,
      bus,
      persistence,
      ensureOpen,
      (sessionId) => [...runs.values()].some((run) => (
        run.sessionId === sessionId && isActiveRunPhase(run.phase)
      )),
      (sessionId, permissionMode) => {
        for (const run of runs.values()) {
          if (run.sessionId === sessionId && isActiveRunPhase(run.phase)) {
            run.permissionMode = permissionMode;
          }
        }
      },
    ),
    runs: runService,
    events: bus.service,
    permissions: permissions.service,
    workflows,
    config: createRuntimeConfigService(ensureOpen, configFile),
    catalog: createRuntimeCatalogService(ensureOpen, configFile),
    mcp: createRuntimeMcpService(ensureOpen, configFile),
    artifacts: artifacts.service,
    status: createRuntimeStatusService({
      identity,
      permissions,
      runs,
      sessionManager,
      workflows,
    }),
    diagnostics: createRuntimeDiagnosticsService(bus.service),
    admin: createRuntimeAdminService(agentPlane),
    agents: createRuntimeAgentService(agentPlane),
    agentTasks: createRuntimeAgentTaskService(agentPlane),
    async close() {
      if (closed) return;
      closed = true;
      runService.closeAll('runtime closed');
      permissions.rejectAll('runtime closed');
      await agentPlane?.close();
      bus.close();
    },
  };

  return runtime;
}

async function createInProcessExternalAgentDaemon(
  options: CreateKodaXRuntimeOptions,
): Promise<KodaXRuntime> {
  const externalAgents = options.externalAgents;
  if (!externalAgents) throw new Error('External agent options are required for the hosted daemon.');
  if (options.daemonTransport !== undefined) {
    throw new Error('External agent factories cannot be installed through an existing daemon transport.');
  }
  if (options.autoStartDaemon === false) {
    throw new Error('External agent factories require an in-process daemon host with autoStartDaemon enabled.');
  }
  const endpoint = options.daemonEndpoint !== undefined
    ? normalizeRuntimeDaemonEndpoint(options.daemonEndpoint)
    : undefined;
  const lease = await acquireRuntimeDaemonLease({
    homeDir: options.homeDir,
    profile: options.profile,
    endpoint,
    connectTimeoutMs: options.daemonConnectTimeoutMs,
    startupTimeoutMs: options.daemonStartupTimeoutMs,
    createRuntime: () => createKodaXRuntime({
      mode: 'embedded',
      homeDir: options.homeDir,
      profile: options.profile,
      sessionsDir: options.sessionsDir,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      permissionTimeoutMs: options.permissionTimeoutMs,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      requirements: options.requirements,
      externalAgents,
    }),
  });
  if (!lease.ownsHost) {
    await lease.close();
    throw new Error(
      'External agent factories cannot be installed into an already-running daemon profile; configure its owner or use a unique profile.',
    );
  }
  try {
    const runtime = await connectKodaXRuntime({
      profile: options.profile,
      transport: lease.transport,
      daemonToken: options.daemonToken ?? readRuntimeDaemonToken(lease.paths),
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      requirements: { ...options.requirements, externalAgents: true },
    });
    let closed = false;
    return {
      ...runtime,
      identity: { ...runtime.identity, isolation: 'inline' },
      async close() {
        if (closed) return;
        closed = true;
        await runtime.close();
        if (lease.ownsHost) await lease.shutdown();
        else await lease.close();
      },
    };
  } catch (error: unknown) {
    await lease.close();
    if (lease.ownsHost) await lease.shutdown();
    throw error;
  }
}

async function createWorkerHostedKodaXRuntime(
  options: CreateKodaXRuntimeOptions,
): Promise<KodaXRuntime> {
  const shutdownTimeoutMs = options.worker?.shutdownTimeoutMs ?? 2_000;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new Error('Runtime Worker shutdownTimeoutMs must be a positive finite number.');
  }
  const handle = createRuntimeWorkerTransport({
    homeDir: options.homeDir,
    profile: options.profile,
    sessionsDir: options.sessionsDir,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    permissionTimeoutMs: options.permissionTimeoutMs,
  }, options.worker);
  try {
    const initialized = requireRuntimeRecord(await handle.transport.request('initialize', {
      profile: options.profile ?? 'default',
      ...(options.clientInfo !== undefined ? { clientInfo: options.clientInfo } : {}),
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    }));
    const identity = parseRuntimeIdentity(initialized.identity);
    assertRuntimeCapabilities(initialized.capabilities, {
      ...options.requirements,
      hardDispose: true,
    });
    const client = createRuntimeDaemonClient({
      identity: {
        ...identity,
        mode: 'embedded',
        isolation: 'worker',
        workerThreadId: handle.threadId,
      },
      transport: handle.transport,
      capabilities: requireRuntimeRecord(initialized.capabilities),
    });
    let closed = false;
    return {
      ...client,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await settleWithin(
            handle.transport.request('runtime.shutdown'),
            shutdownTimeoutMs,
          );
        } finally {
          await handle.terminate();
        }
      },
    };
  } catch (error: unknown) {
    await handle.terminate();
    throw error;
  }
}

function assertRuntimeCapabilities(
  value: unknown,
  requirements: RuntimeCapabilityRequirements | undefined,
): void {
  if (!requirements?.hardDispose && !requirements?.externalAgents) return;
  const capabilities = requireRuntimeRecord(value);
  if (requirements.hardDispose && capabilities.hardDispose !== true) {
    throw new Error('Runtime does not support the required hardDispose capability.');
  }
  if (requirements.externalAgents && capabilities.externalAgents !== true) {
    throw new Error('Runtime does not support the required externalAgents capability.');
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Runtime Worker shutdown timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function connectKodaXRuntime(
  options: ConnectKodaXRuntimeOptions = {},
): Promise<KodaXRuntime> {
  assertPositiveRuntimeTimeout('daemonStartupTimeoutMs', options.daemonStartupTimeoutMs);
  assertPositiveRuntimeTimeout('daemonConnectTimeoutMs', options.daemonConnectTimeoutMs);
  const explicitEndpoint = options.endpoint !== undefined
    ? normalizeRuntimeDaemonEndpoint(options.endpoint)
    : undefined;
  const lease = options.transport === undefined && options.autoStart === true
    ? await acquireRuntimeDaemonProcessLease({
        homeDir: options.homeDir,
        profile: options.profile,
        endpoint: explicitEndpoint,
        defaultProvider: options.defaultProvider,
        defaultModel: options.defaultModel,
        sessionsDir: options.sessionsDir,
        permissionTimeoutMs: options.permissionTimeoutMs,
        startupTimeoutMs: options.daemonStartupTimeoutMs,
        connectTimeoutMs: options.daemonConnectTimeoutMs,
      })
    : undefined;
  const endpoint = explicitEndpoint
    ?? lease?.endpoint
    ?? (
      options.transport === undefined
        ? defaultRuntimeDaemonEndpoint(
            options.profile ?? 'default',
            path.resolve(options.homeDir ?? os.homedir()),
          )
        : undefined
    );
  const transport = options.transport
    ?? lease?.transport
    ?? (
      endpoint !== undefined
        ? await createRuntimeDaemonSocketClientTransport(endpoint, {
            connectTimeoutMs: options.daemonConnectTimeoutMs,
          })
        : undefined
    );
  if (!transport) {
    throw new Error(
      'connectKodaXRuntime requires a daemon transport, endpoint, or autoStart: true.',
    );
  }
  const token = resolveConnectDaemonToken(options);
  let identity: RuntimeIdentity;
  let daemonCapabilities: Readonly<Record<string, unknown>> = {};
  try {
    const initialized = requireRuntimeRecord(
      await transport.request('initialize', {
        profile: options.profile ?? 'default',
        autoStart: options.autoStart === true,
        ...(token !== undefined ? { token } : {}),
        ...(options.clientInfo !== undefined ? { clientInfo: options.clientInfo } : {}),
        ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
        ...(endpoint !== undefined ? { endpoint: endpoint.path } : {}),
      }),
    );
    identity = parseRuntimeIdentity(initialized.identity);
    daemonCapabilities = initialized.capabilities === undefined
      ? {}
      : requireRuntimeRecord(initialized.capabilities);
    assertRuntimeCapabilities(daemonCapabilities, options.requirements);
    const expectedProfile = options.profile ?? 'default';
    if (identity.profile !== expectedProfile) {
      throw new Error(
        `Runtime daemon profile mismatch: expected ${expectedProfile}, got ${identity.profile}`,
      );
    }
  } catch (error: unknown) {
    await transport.close?.();
    await lease?.close();
    throw error;
  }
  const runtime = createRuntimeDaemonClient({
    identity: { ...identity, mode: 'daemon', isolation: 'process' },
    transport,
    capabilities: daemonCapabilities,
  });
  if (!lease) return runtime;
  return {
    ...runtime,
    async close() {
      await runtime.close();
      await lease.close();
    },
  };
}

function assertPositiveRuntimeTimeout(name: string, value: number | undefined): void {
  if (value === undefined || (Number.isFinite(value) && value > 0)) return;
  throw new Error(`${name} must be a positive finite number.`);
}

function resolveConnectDaemonToken(options: ConnectKodaXRuntimeOptions): string | undefined {
  if (options.daemonToken !== undefined) return options.daemonToken;
  if (options.transport !== undefined && options.autoStart !== true) return undefined;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  return readRuntimeDaemonToken(resolveRuntimeDaemonPaths(homeDir, options.profile ?? 'default'));
}

function normalizeRuntimeDaemonEndpoint(
  endpoint: string | RuntimeDaemonEndpoint,
): RuntimeDaemonEndpoint {
  if (typeof endpoint !== 'string') return endpoint;
  return {
    kind: process.platform === 'win32' || endpoint.startsWith('\\\\.\\pipe\\')
      ? 'pipe'
      : 'unix',
    path: endpoint,
  };
}

function createRuntimeSessionService(
  manager: SessionManager,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  ensureOpen: () => void,
  hasActiveRun: (sessionId: string) => boolean,
  updateActivePermissionMode: (sessionId: string, permissionMode: string | undefined) => void,
): RuntimeSessionService {
  const toRuntimeSession = (
    id: string,
    data: KodaXSessionData,
    createdAt?: string,
  ): RuntimeSession => ({
    id,
    title: data.title,
    ...(data.gitRoot ? { gitRoot: data.gitRoot } : {}),
    ...(data.runtimeInfo?.workspaceRoot ? { workspaceRoot: data.runtimeInfo.workspaceRoot } : {}),
    ...(data.runtimeInfo?.surface ? { surface: data.runtimeInfo.surface } : {}),
    ...(data.runtimeInfo?.profileId ? { profileId: data.runtimeInfo.profileId } : {}),
    ...(createdAt ? { createdAt } : {}),
  });

  return {
    async create(input = {}) {
      ensureOpen();
      const sessionId = input.sessionId ?? await generateSessionId();
      const projectPath = input.projectPath ? path.resolve(input.projectPath) : undefined;
      const gitRoot = input.gitRoot ? path.resolve(input.gitRoot) : projectPath;
      const runtimeInfo = buildSessionRuntimeInfo(input, projectPath, gitRoot);
      const data: KodaXSessionData = {
        messages: [],
        title: input.title ?? '',
        gitRoot: gitRoot ?? '',
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
        scope: 'user',
      };
      await manager.storage.save(sessionId, data);
      const session = toRuntimeSession(sessionId, data, new Date().toISOString());
      bus.emit('session.created', session, { sessionId, runId: sessionId });
      return session;
    },

    async load(sessionId) {
      ensureOpen();
      const data = await manager.loadSession(sessionId);
      if (!data) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const session = toRuntimeSession(sessionId, data);
      bus.emit('session.loaded', session, { sessionId, runId: sessionId });
      return session;
    },

    async list(filter) {
      ensureOpen();
      const summaries = await manager.listSessions(filter);
      return summaries.map(toRuntimeSessionSummary);
    },

    async transcript(sessionId) {
      ensureOpen();
      return manager.loadFullTranscript(sessionId);
    },

    async fork(input) {
      ensureOpen();
      const forked = await manager.forkSession(input.sessionId, {
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
        ...(input.newSessionId !== undefined ? { sessionId: input.newSessionId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      if (!forked) {
        const source = await manager.loadSession(input.sessionId);
        if (!source) return null;
        const sessionId = input.newSessionId ?? await generateSessionId();
        const data: KodaXSessionData = {
          ...source,
          title: input.title ?? source.title,
          messages: source.messages.map(cloneMessage),
        };
        await manager.storage.save(sessionId, data);
        const session = toRuntimeSession(sessionId, data);
        bus.emit('session.created', session, { sessionId, runId: sessionId });
        return session;
      }
      const session = toRuntimeSession(forked.sessionId, forked.data);
      bus.emit('session.created', session, { sessionId: forked.sessionId, runId: forked.sessionId });
      return session;
    },

    async getSettings(sessionId) {
      ensureOpen();
      await loadRequiredSession(manager, sessionId);
      return persistence.loadSessionSettings(sessionId);
    },

    async updateSettings(sessionId, patch) {
      ensureOpen();
      const sessionData = await loadRequiredSession(manager, sessionId);
      const current = persistence.loadSessionSettings(sessionId);
      const settings = applySessionSettingsPatch(current, patch);
      assertSessionSettingsAllowed(sessionData, settings);
      persistence.saveSessionSettings(sessionId, settings);
      if (patch.permissionMode !== undefined) {
        updateActivePermissionMode(sessionId, settings.permissionMode);
      }
      bus.emit('session.settings.updated', {
        sessionId,
        settings,
        patch,
      }, { sessionId, runId: sessionId });
      return settings;
    },

    async appendNotice(input) {
      ensureOpen();
      const entry = await manager.appendClientNotice(input.sessionId, {
        content: input.content,
        ...(input.source !== undefined ? { source: input.source } : {}),
      });
      if (entry) {
        bus.emit('session.notice.appended', {
          sessionId: input.sessionId,
          entry,
        }, { sessionId: input.sessionId, runId: input.sessionId });
      }
      return entry;
    },

    async rewind(input) {
      ensureOpen();
      assertSessionMutationAllowed(input.sessionId, hasActiveRun);
      const data = await manager.rewindSession(input.sessionId, {
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
      });
      if (!data) return null;
      const session = toRuntimeSession(input.sessionId, data);
      bus.emit('session.rewound', {
        sessionId: input.sessionId,
        selector: input.selector,
        session,
      }, { sessionId: input.sessionId, runId: input.sessionId });
      return session;
    },

    async setActiveEntry(input) {
      ensureOpen();
      assertSessionMutationAllowed(input.sessionId, hasActiveRun);
      const data = await manager.setActiveEntry(input.sessionId, input.entryId);
      if (!data) return null;
      const session = toRuntimeSession(input.sessionId, data);
      bus.emit('session.active_entry.updated', {
        sessionId: input.sessionId,
        entryId: input.entryId,
        session,
      }, { sessionId: input.sessionId, runId: input.sessionId });
      return session;
    },

    async compact(input) {
      ensureOpen();
      assertSessionMutationAllowed(input.sessionId, hasActiveRun);
      const result = await manager.compactSession(input.sessionId, {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      });
      const loaded = await manager.loadSession(input.sessionId);
      const session = loaded ? toRuntimeSession(input.sessionId, loaded) : undefined;
      bus.emit('context.compaction.finished', {
        sessionId: input.sessionId,
        compacted: result.compacted,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      }, { sessionId: input.sessionId, runId: input.sessionId });
      if (result.compacted) {
        bus.emit('session.compacted', {
          sessionId: input.sessionId,
          result: {
            compacted: result.compacted,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          },
          ...(session !== undefined ? { session } : {}),
        }, { sessionId: input.sessionId, runId: input.sessionId });
      }
      return {
        ...result,
        ...(session !== undefined ? { session } : {}),
      };
    },

    async archive(sessionId) {
      ensureOpen();
      const ok = await manager.archiveSession(sessionId);
      if (!ok) throw new Error(`Session not found or not archived: ${sessionId}`);
    },

    async unarchive(sessionId) {
      ensureOpen();
      const ok = await manager.unarchiveSession(sessionId);
      if (!ok) throw new Error(`Session not found or not unarchived: ${sessionId}`);
    },

    async delete(sessionId) {
      ensureOpen();
      const result = await manager.deleteSession(sessionId);
      assertDeleteSucceeded(sessionId, result);
    },
  };
}

function createRuntimeRunService(deps: {
  readonly agentPlane?: AgentExecutorPlane;
  readonly artifacts: RuntimeArtifactStore;
  readonly bus: RuntimeEventBus;
  readonly defaultModel?: string;
  readonly defaultProvider?: string;
  readonly defaultAgentContext?: AgentDispatchContext;
  readonly ensureOpen: () => void;
  readonly isClosed: () => boolean;
  readonly permissions: RuntimePermissionRegistry;
  readonly persistence: RuntimePersistence;
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
}): RuntimeRunServiceInternal {
  const activeRunBySession = new Map<string, string>();
  const queueBySession = new Map<string, string[]>();

  const getRecord = (runId: string): RuntimeRunRecord => {
    const run = deps.runs.get(runId);
    if (!run) {
      throw new Error(`Runtime run not found: ${runId}`);
    }
    return run;
  };

  const releaseActiveRun = (record: RuntimeRunRecord): void => {
    if (activeRunBySession.get(record.sessionId) === record.runId) {
      activeRunBySession.delete(record.sessionId);
    }
  };

  const resolveRunStart = (record: RuntimeRunRecord, result: RuntimeRunResult): void => {
    record.start?.resolve(result);
    record.start = undefined;
  };

  const finishRun = (record: RuntimeRunRecord, result: RuntimeRunResult): RuntimeRunResult => {
    deps.permissions.rejectForRun(record.runId, 'runtime run ended');
    resolveRunStart(record, result);
    releaseActiveRun(record);
    pruneTerminalRuns(deps.runs);
    drainNext(record.sessionId);
    return result;
  };

  const cancelRun = (
    record: RuntimeRunRecord,
    reason: string,
    drain: boolean,
  ): RuntimeRunResult => {
    if (record.phase === 'queued') {
      removeQueuedRun(queueBySession, record);
    }
    record.running?.abort(new Error(reason));
    record.abortController?.abort(new Error(reason));
    deps.permissions.rejectForRun(record.runId, reason);
    markRunTerminal(deps.bus, deps.persistence, record, 'cancelled');
    const result: RuntimeRunResult = {
      runId: record.runId,
      sessionId: record.sessionId,
      phase: record.phase,
    };
    resolveRunStart(record, result);
    releaseActiveRun(record);
    if (drain && !deps.isClosed()) {
      drainNext(record.sessionId);
    }
    return result;
  };

  const startRecord = (record: RuntimeRunRecord): void => {
    if (!record.start || deps.isClosed()) {
      cancelRun(record, 'runtime closed', false);
      return;
    }
    record.phase = 'running';
    record.queuedAt = undefined;
    activeRunBySession.set(record.sessionId, record.runId);
    deps.bus.emit('run.started', statusFromRecord(record), {
      sessionId: record.sessionId,
      runId: record.runId,
    });
    saveRunStatusSafely(deps.bus, deps.persistence, record, statusFromRecord(record));

    const events = wrapKodaXEvents({
      bus: deps.bus,
      original: record.start.options.events,
      permissions: deps.permissions,
      record,
    });
    const runOptions = buildRunOptions({
      agentPlane: deps.agentPlane,
      events,
      model: record.model,
      options: record.start.options,
      provider: record.provider,
      record,
      sessionManager: deps.sessionManager,
    });
    deps.bus.emit('config.effective', {
      sessionId: record.sessionId,
      runId: record.runId,
      provider: record.provider,
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(runOptions.effort !== undefined ? { effort: runOptions.effort } : {}),
      ...(runOptions.thinking !== undefined ? { thinking: runOptions.thinking } : {}),
      ...(runOptions.reasoningMode !== undefined ? { reasoningMode: runOptions.reasoningMode } : {}),
      ...(record.permissionMode !== undefined ? { permissionMode: record.permissionMode } : {}),
      ...(runOptions.context?.executionCwd !== undefined ? { executionCwd: runOptions.context.executionCwd } : {}),
    }, {
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
    });
    if (record.mode === 'managed_task') {
      const abortController = new AbortController();
      record.abortController = abortController;
      const upstreamSignal = runOptions.abortSignal;
      if (upstreamSignal?.aborted) {
        abortController.abort(upstreamSignal.reason);
      } else {
        upstreamSignal?.addEventListener('abort', () => {
          abortController.abort(upstreamSignal.reason);
        }, { once: true });
      }
      void runManagedTask({
        ...runOptions,
        abortSignal: abortController.signal,
      }, record.start.prompt)
        .then((value): RuntimeRunResult => {
          const phase = record.terminalEmitted
            ? record.phase
            : value.interrupted ? 'interrupted' : value.success ? 'completed' : 'failed';
          markRunTerminal(deps.bus, deps.persistence, record, phase);
          return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, result: value };
        })
        .catch((error: unknown): RuntimeRunResult => {
          const normalized = normalizeError(error);
          const phase = record.terminalEmitted ? record.phase : 'failed';
          if (phase === 'failed') {
            record.error = normalized.message;
          }
          markRunTerminal(deps.bus, deps.persistence, record, phase);
          return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, error: normalized };
        })
        .then((result) => finishRun(record, result));
      return;
    }

    const running = startKodaX(runOptions, record.start.prompt);
    record.running = running;
    void running.result
      .then((value): RuntimeRunResult => {
        const phase = record.terminalEmitted
          ? record.phase
          : value.interrupted ? 'interrupted' : value.success ? 'completed' : 'failed';
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, result: value };
      })
      .catch((error: unknown): RuntimeRunResult => {
        const normalized = normalizeError(error);
        const phase = record.terminalEmitted ? record.phase : 'failed';
        if (phase === 'failed') {
          record.error = normalized.message;
        }
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return { runId: record.runId, sessionId: record.sessionId, phase: record.phase, error: normalized };
      })
      .then((result) => finishRun(record, result));
  };

  const drainNext = (sessionId: string): void => {
    const queue = queueBySession.get(sessionId);
    if (!queue || queue.length === 0 || activeRunBySession.has(sessionId)) return;
    const nextRunId = queue.shift();
    if (queue.length === 0) queueBySession.delete(sessionId);
    if (!nextRunId) return;
    const next = deps.runs.get(nextRunId);
    if (!next || next.phase !== 'queued') {
      drainNext(sessionId);
      return;
    }
    startRecord(next);
  };

  const enqueue = (record: RuntimeRunRecord): void => {
    const queue = queueBySession.get(record.sessionId) ?? [];
    queue.push(record.runId);
    queueBySession.set(record.sessionId, queue);
    deps.bus.emit('run.queued', statusFromRecord(record), {
      sessionId: record.sessionId,
      runId: record.runId,
    });
    saveRunStatusSafely(deps.bus, deps.persistence, record, statusFromRecord(record));
  };

  return {
    async start(input) {
      deps.ensureOpen();
      const normalizedInput = normalizeRuntimeRunInput(input, deps.artifacts);
      const session = await deps.sessionManager.loadSession(input.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }
      const settings = deps.persistence.loadSessionSettings(input.sessionId);
      assertSessionSettingsAllowed(session, settings);
      const options = buildEffectiveRuntimeOptions(
        input.options ?? {},
        settings,
        normalizedInput.inputArtifacts,
      );
      const provider = options.provider ?? deps.defaultProvider;
      if (!provider) {
        throw new Error('runtime.runs.start requires input.options.provider or runtime defaultProvider');
      }
      const model = options.modelOverride ?? options.model ?? deps.defaultModel;
      const runId = createRunId();
      const startedAt = new Date().toISOString();
      let resolveResult: (result: RuntimeRunResult) => void = () => undefined;
      const result = new Promise<RuntimeRunResult>((resolve) => {
        resolveResult = resolve;
      });
      const isQueued = activeRunBySession.has(input.sessionId);
      const record: RuntimeRunRecord = {
        runId,
        sessionId: input.sessionId,
        phase: isQueued ? 'queued' : 'running',
        startedAt,
        ...(isQueued ? { queuedAt: startedAt } : {}),
        provider,
        ...(model !== undefined ? { model } : {}),
        ...(input.permissionBroker !== undefined
          ? { permissionBroker: input.permissionBroker }
          : {}),
        ...(settings.permissionMode !== undefined ? { permissionMode: settings.permissionMode } : {}),
        ...(options.reasoningMode !== undefined ? { reasoning: options.reasoningMode } : {}),
        mode: input.mode ?? 'coding',
        ...(input.agentContext ?? deps.defaultAgentContext
          ? { agentContext: input.agentContext ?? deps.defaultAgentContext }
          : {}),
        result,
        start: {
          prompt: normalizedInput.prompt,
          inputArtifacts: normalizedInput.inputArtifacts,
          options,
          resolve: resolveResult,
        },
        terminalEmitted: false,
      };
      deps.runs.set(runId, record);
      if (isQueued) {
        enqueue(record);
      } else {
        startRecord(record);
      }

      return {
        runId,
        sessionId: input.sessionId,
        get turnId() {
          return record.turnId;
        },
        result,
      };
    },

    async await(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      if (run) return run.result;
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) return resultFromStatus(persisted);
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async get(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      if (run) return statusFromRecord(run);
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) return persisted;
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async list(filter) {
      deps.ensureOpen();
      return [...deps.runs.values()]
        .filter((run) => runMatchesFilter(run, filter))
        .map(statusFromRecord);
    },

    async abort(runId) {
      deps.ensureOpen();
      const run = getRecord(runId);
      if (run.phase === 'queued' || isActiveRunPhase(run.phase)) {
        cancelRun(run, 'runtime run aborted', true);
      }
    },

    async setModel(runId, model) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.model = model;
      run.running?.setModel(model);
    },

    async setProvider(runId, provider) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.provider = provider;
      run.running?.setProvider(provider);
    },

    async setReasoning(runId, reasoning) {
      deps.ensureOpen();
      const run = getRecord(runId);
      run.reasoning = reasoning;
      run.running?.setReasoning(reasoning);
    },

    closeAll(reason) {
      for (const run of deps.runs.values()) {
        if (run.phase === 'queued' || isActiveRunPhase(run.phase)) {
          cancelRun(run, reason, false);
        }
      }
      activeRunBySession.clear();
      queueBySession.clear();
    },
  };
}

function createRuntimeWorkflowService(): RuntimeWorkflowService {
  const manager = getDefaultWorkflowRunManager();
  return {
    async list(filter) {
      const list = manager.list();
      const filtered = filter?.runId
        ? list.filter((item) => item.runId === filter.runId)
        : list;
      return filter?.limit === undefined ? filtered : filtered.slice(0, filter.limit);
    },

    async get(runId) {
      return manager.getWorkflowProcessSnapshot(runId);
    },

    subscribe(filter, listener) {
      const unsubscribe = manager.subscribeWorkflowProcess((event) => {
        if (filter.runId && event.snapshot.runId !== filter.runId) return;
        if (filter.activeOnly === true && isFinalWorkflowStatus(event.snapshot.status)) return;
        listener(event);
      });
      return { close: unsubscribe };
    },

    async pause(runId) {
      return manager.pause(runId);
    },

    async resume(runId) {
      return manager.resume(runId);
    },

    async stop(runId) {
      return manager.stop(runId);
    },
  };
}

function createRuntimeConfigService(
  ensureOpen: () => void,
  configFile: string | undefined,
): RuntimeConfigService {
  return {
    async read() {
      ensureOpen();
      return redactRuntimeConfig(readRuntimeConfig(configFile));
    },

    async patch(patch) {
      ensureOpen();
      assertPlainObject(patch, 'runtime.config.patch');
      patchRuntimeConfig(configFile, sanitizeRuntimeConfigPatch(patch));
      return redactRuntimeConfig(readRuntimeConfig(configFile));
    },

    async reload() {
      ensureOpen();
      if (configFile !== undefined) {
        registerRuntimeConfiguredCustomProviders(configFile);
        return {
          ok: true,
          config: redactRuntimeConfig(readRuntimeConfig(configFile)),
        };
      }
      return {
        ok: true,
        config: redactRuntimeConfig(prepareRuntimeConfig()),
      };
    },
  };
}

function createRuntimeCatalogService(
  ensureOpen: () => void,
  configFile: string | undefined,
): RuntimeCatalogService {
  return {
    async providers() {
      ensureOpen();
      return getProviderList();
    },

    async models(filter) {
      ensureOpen();
      return listRuntimeModels(getProviderList(), filter);
    },

    async commands(projectRoot) {
      ensureOpen();
      return listRuntimeCommands(projectRoot);
    },

    async resolveCommand(input) {
      ensureOpen();
      const normalized = input.name.trim().toLowerCase();
      return listRuntimeCommands(input.projectRoot).find((command) => (
        command.name.trim().toLowerCase() === normalized
        || (command.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized)
      )) ?? null;
    },

    async skills(filter) {
      ensureOpen();
      const registry = await initializeSkillRegistry(filter?.projectRoot);
      const skills = filter?.userInvocableOnly === true
        ? registry.listUserInvocable()
        : registry.list();
      return skills.map(toRuntimeSkillSummary);
    },

    async describeSkill(input) {
      ensureOpen();
      const registry = await initializeSkillRegistry(input.projectRoot);
      if (!registry.has(input.name)) return null;
      return toRuntimeSkillDescription(await registry.loadFull(input.name));
    },

    async customProviders() {
      ensureOpen();
      return listRuntimeCustomProviders(configFile);
    },

    async upsertCustomProvider(config) {
      ensureOpen();
      return upsertRuntimeCustomProvider(configFile, config);
    },

    async deleteCustomProvider(name) {
      ensureOpen();
      return removeRuntimeCustomProvider(configFile, name);
    },

    async extensions() {
      ensureOpen();
      const runtime = getActiveExtensionRuntime();
      if (!runtime) {
        return { active: false, extensions: [] };
      }
      const diagnostics = runtime.getDiagnostics();
      return {
        active: true,
        extensions: diagnostics.loadedExtensions,
        diagnostics,
      };
    },

    async reloadExtensions() {
      ensureOpen();
      const runtime = getActiveExtensionRuntime();
      if (!runtime) {
        return { ok: true, active: false };
      }
      await runtime.reloadExtensions({ continueOnError: true });
      return {
        ok: true,
        active: true,
        diagnostics: runtime.getDiagnostics(),
      };
    },
  };
}

function createRuntimeMcpService(
  ensureOpen: () => void,
  configFile: string | undefined,
): RuntimeMcpService {
  return {
    async listServers() {
      ensureOpen();
      return listRuntimeMcpServers(configFile);
    },

    async getServer(name) {
      ensureOpen();
      return getRuntimeMcpServer(configFile, name);
    },

    async validateServer(name, config) {
      ensureOpen();
      try {
        validateMcpServerConfig(name, config as McpServerConfig);
        return {
          ok: true,
          config: structuredClone(config as McpServerConfig),
        };
      } catch (error: unknown) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async upsertServer(name, config) {
      ensureOpen();
      return upsertRuntimeMcpServer(configFile, name, config);
    },

    async deleteServer(name) {
      ensureOpen();
      return removeRuntimeMcpServer(configFile, name);
    },

    async reloadServers() {
      ensureOpen();
      const manager = createMcpManager(listRuntimeMcpServers(configFile));
      try {
        return {
          ok: true,
          servers: manager.listServers(),
        };
      } finally {
        await manager.dispose();
      }
    },

    async listTools(filter) {
      ensureOpen();
      const servers = listRuntimeMcpServers(configFile);
      const names = filter?.server !== undefined ? [filter.server] : Object.keys(servers);
      const manager = createMcpManager(servers);
      try {
        const result: McpServerToolList[] = [];
        for (const name of names) {
          result.push(await manager.listTools(name, {
            forceRefresh: filter?.forceRefresh === true,
          }));
        }
        return result;
      } finally {
        await manager.dispose();
      }
    },
  };
}

function createRuntimeArtifactStore() {
  const artifacts = new Map<string, RuntimeArtifact>();

  const resolve = (artifactId: string): RuntimeArtifact => {
    const artifact = artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Runtime artifact not found: ${artifactId}`);
    }
    return artifact;
  };

  const service: RuntimeArtifactService = {
    async create(input) {
      if (!isRuntimeArtifactKind(input.kind)) {
        throw new Error(`Unsupported runtime artifact kind: ${String(input.kind)}`);
      }
      const resolvedPath = path.resolve(input.path);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(resolvedPath);
      } catch (error: unknown) {
        throw new Error(
          `Runtime artifact path is not readable: ${resolvedPath}`,
          { cause: error },
        );
      }
      if (!stats.isFile()) {
        throw new Error(`Runtime artifact path must be a regular file: ${resolvedPath}`);
      }
      if (stats.size > MAX_RUNTIME_ARTIFACT_BYTES) {
        throw new Error(
          `Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte limit: ${resolvedPath}`,
        );
      }
      const id = `art_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const artifact: RuntimeArtifact = {
        id,
        kind: input.kind,
        path: resolvedPath,
        sizeBytes: stats.size,
        ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        createdAt: new Date().toISOString(),
      };
      artifacts.set(id, artifact);
      return artifact;
    },

    async get(artifactId) {
      return artifacts.get(artifactId);
    },

    async delete(artifactId) {
      return artifacts.delete(artifactId);
    },
  };

  return {
    service,
    resolve,
  };
}

function buildRunOptions(input: {
  readonly agentPlane?: AgentExecutorPlane;
  readonly events: KodaXEvents;
  readonly model?: string;
  readonly options: RuntimeKodaXOptions;
  readonly provider: string;
  readonly record: RuntimeRunRecord;
  readonly sessionManager: SessionManager;
}): KodaXOptions {
  const { agentPlane, events, model, options, provider, record, sessionManager } = input;
  return {
    ...options,
    provider,
    ...(model !== undefined ? { modelOverride: model } : {}),
    session: {
      ...(options.session ?? {}),
      id: record.sessionId,
      storage: sessionManager.storage,
    },
    events,
    ...(agentPlane && record.agentContext
      ? {
          context: {
            ...(options.context ?? {}),
            agentExecutorPlane: { plane: agentPlane, context: record.agentContext },
          },
        }
      : {}),
  };
}

function assertRuntimeAgentContext(context: AgentDispatchContext): void {
  if (context.actorId.trim().length === 0) {
    throw new Error('Runtime agent context actorId must not be empty.');
  }
}

function localAgentReasons(
  listing: ReturnType<typeof listCodingDispatchableAgents>[number],
  query: DispatchableAgentQuery,
): string[] {
  const reasons: string[] = [];
  const skills = new Set(listing.skills);
  for (const skill of query.requiredSkills ?? []) {
    if (!skills.has(skill)) reasons.push(`required skill is unavailable: ${skill}`);
  }
  const required = query.requiredCapabilities;
  if (required) {
    for (const key of ['streaming', 'durableTasks', 'inputRequired', 'cancellation', 'artifacts'] as const) {
      if (required[key] === true && listing.capabilities[key] !== 'supported') {
        reasons.push(`required capability ${key} is ${listing.capabilities[key]}`);
      }
    }
  }
  return reasons;
}

function runtimeLocalListings(query: DispatchableAgentQuery): readonly DispatchableAgentListing[] {
  assertRuntimeAgentContext(query);
  return listCodingDispatchableAgents(query)
    .map((descriptor): DispatchableAgentListing => {
      const reasons = localAgentReasons(descriptor, query);
      return {
        descriptor,
        dispatchability: {
          status: reasons.length === 0 ? 'dispatchable' : 'unavailable',
          checkedAt: new Date().toISOString(),
          reasons,
        },
      };
    })
    .filter((listing) => listing.dispatchability.status === 'dispatchable');
}

function createRuntimeAgentService(
  plane: AgentExecutorPlane | undefined,
): RuntimeAgentService {
  return {
    enabled: plane !== undefined,
    async listDispatchable(query) {
      assertRuntimeAgentContext(query);
      const local = listCodingDispatchableAgents(query);
      return plane ? plane.listDispatchable(query, local) : runtimeLocalListings(query);
    },
    async describe(agentId, query) {
      assertRuntimeAgentContext(query);
      const local = listCodingDispatchableAgents(query);
      if (plane) return plane.describe(agentId, query, local);
      return runtimeLocalListings(query).find((listing) => listing.descriptor.agentId === agentId);
    },
    async preflight(input) {
      assertRuntimeAgentContext(input.query);
      const local = listCodingDispatchableAgents(input.query);
      if (plane) return plane.preflight(input, local);
      const listing = runtimeLocalListings(input.query)
        .find((candidate) => candidate.descriptor.agentId === input.agentId);
      const reasons = listing ? [] : ['agent is not dispatchable'];
      if (
        listing
        && input.expectedConfigurationRevision !== undefined
        && listing.descriptor.configurationRevision !== input.expectedConfigurationRevision
      ) reasons.push('configuration revision changed');
      return {
        ok: listing !== undefined && reasons.length === 0,
        ...(listing ? { descriptor: listing.descriptor } : {}),
        dispatchability: listing?.dispatchability ?? {
          status: 'unavailable',
          checkedAt: new Date().toISOString(),
          reasons,
        },
        reasons,
      };
    },
  };
}

function externalAgentsDisabled(): Error {
  return new Error('Runtime external agent executor plane is not enabled.');
}

function createRuntimeAdminService(
  plane: AgentExecutorPlane | undefined,
): RuntimeAdminService {
  return {
    agentRegistrations: plane?.registrations ?? {
      async list() { return []; },
      async upsert() { throw externalAgentsDisabled(); },
      async remove() { throw externalAgentsDisabled(); },
    },
  };
}

function createRuntimeAgentTaskService(
  plane: AgentExecutorPlane | undefined,
): RuntimeAgentTaskService {
  if (plane) return plane.tasks;
  return {
    async start() { throw externalAgentsDisabled(); },
    async list() { return []; },
    async get() { throw externalAgentsDisabled(); },
    async events() { throw externalAgentsDisabled(); },
    async wait() { throw externalAgentsDisabled(); },
    async sendInput() { throw externalAgentsDisabled(); },
    async cancel() { throw externalAgentsDisabled(); },
    async reconcile() { throw externalAgentsDisabled(); },
  };
}

function createRuntimeStatusService(deps: {
  readonly identity: RuntimeIdentity;
  readonly permissions: RuntimePermissionRegistry;
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
  readonly workflows: RuntimeWorkflowService;
}): RuntimeStatusService {
  return {
    async snapshot() {
      return {
        runtimeId: deps.identity.runtimeId,
        mode: deps.identity.mode,
        profile: deps.identity.profile,
        startedAt: deps.identity.startedAt,
        sessions: (await deps.sessionManager.listSessions({ includeArchived: true }))
          .map(toRuntimeSessionSummary),
        runs: [...deps.runs.values()].map(statusFromRecord),
        pendingPermissions: await deps.permissions.service.listPending(),
        workflows: await deps.workflows.list({}),
      };
    },
  };
}

function createRuntimeDiagnosticsService(
  events: RuntimeEventService,
): RuntimeDiagnosticsService {
  return {
    latestContextBudget(filter) {
      return latestRuntimeDiagnosticPayload<RuntimeContextBudgetSnapshot>(
        events,
        'context.budget.snapshot',
        filter,
      );
    },
    latestToolExposure(filter) {
      return latestRuntimeDiagnosticPayload<RuntimeToolExposurePlan>(
        events,
        'tool.exposure.planned',
        filter,
      );
    },
  };
}

async function latestRuntimeDiagnosticPayload<T>(
  events: RuntimeEventService,
  type: RuntimeEventType,
  filter: RuntimeDiagnosticFilter | undefined,
): Promise<T | null> {
  const replayFilter: RuntimeEventReplayFilter = {
    type,
    limit: 100,
    ...(filter?.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
    ...(filter?.runId !== undefined ? { runId: filter.runId } : {}),
  };
  const replay = await events.replay(replayFilter);
  return (replay.at(-1)?.payload as T | undefined) ?? null;
}

function isActiveRunPhase(phase: RuntimeRunPhase): boolean {
  return phase === 'running'
    || phase === 'waiting_permission'
    || phase === 'waiting_user_input';
}

function removeQueuedRun(queueBySession: Map<string, string[]>, run: RuntimeRunRecord): void {
  const queue = queueBySession.get(run.sessionId);
  if (!queue) return;
  const next = queue.filter((runId) => runId !== run.runId);
  if (next.length === 0) {
    queueBySession.delete(run.sessionId);
  } else {
    queueBySession.set(run.sessionId, next);
  }
}

function createRuntimeEventBus(persistence: RuntimePersistence) {
  let closed = false;
  const events: RuntimeEvent[] = [];
  const subscribers = new Set<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }>();

  const matches = (event: RuntimeEvent, filter: RuntimeEventFilter | undefined): boolean => {
    if (!filter) return true;
    if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
    if (filter.runId !== undefined && event.runId !== filter.runId) return false;
    if (filter.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.includes(event.type)) return false;
    }
    return true;
  };

  const remember = (event: RuntimeEvent): void => {
    events.push(event);
    if (events.length > MAX_RUNTIME_MEMORY_EVENTS) {
      events.splice(0, events.length - MAX_RUNTIME_MEMORY_EVENTS);
    }
  };

  const createEvent = (
    type: RuntimeEventType,
    payload: unknown,
    scope: { readonly sessionId: string; readonly runId: string; readonly turnId?: string },
  ): RuntimeEvent => {
    const seq = persistence.nextEventSeq();
    return {
      id: `evt_${seq}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      seq,
      time: new Date().toISOString(),
      sessionId: scope.sessionId,
      runId: scope.runId,
      ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
      type,
      payload,
    };
  };

  const notify = (event: RuntimeEvent): void => {
    for (const subscriber of [...subscribers]) {
      if (!matches(event, subscriber.filter)) continue;
      try {
        subscriber.listener(event);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.events',
          level: 'error',
          message: `Runtime event listener failed for ${event.type}`,
          detail: {
            eventId: event.id,
            error: normalizeError(error),
          },
        });
      }
    }
  };

  const service: RuntimeEventService = {
    subscribe(filter, listener) {
      if (closed) {
        throw new Error('KodaX runtime event bus is closed');
      }
      const subscriber = { filter, listener };
      subscribers.add(subscriber);
      return {
        close() {
          subscribers.delete(subscriber);
        },
      };
    },

    async replay(filter) {
      const source = persistence.replay(filter);
      const replayEvents = new Map<string, RuntimeEvent>();
      for (const event of source) replayEvents.set(event.id, event);
      for (const event of events) replayEvents.set(event.id, event);
      const matched = [...replayEvents.values()].filter((event) => (
        matches(event, filter)
        && (filter?.sinceSeq === undefined || event.seq > filter.sinceSeq)
      )).sort((a, b) => a.seq - b.seq || a.time.localeCompare(b.time));
      return filter?.limit === undefined ? matched : matched.slice(-filter.limit);
    },
  };

  return {
    service,
    emit(
      type: RuntimeEventType,
      payload: unknown,
      scope: { readonly sessionId: string; readonly runId: string; readonly turnId?: string },
    ): RuntimeEvent {
      const event = createEvent(type, payload, scope);
      remember(event);
      const notifyEvents: RuntimeEvent[] = [event];
      try {
        persistence.appendEvent(event);
      } catch (error: unknown) {
        const warning = createEvent('runtime.warning', {
          message: normalizeError(error).message,
          sourceEventId: event.id,
        }, scope);
        remember(warning);
        notifyEvents.push(warning);
      }
      for (const emitted of notifyEvents) notify(emitted);
      return event;
    },
    close() {
      closed = true;
      try {
        persistence.close();
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.persistence',
          level: 'error',
          message: 'Failed to flush runtime events while closing',
          detail: error,
        });
      }
      subscribers.clear();
    },
  };
}

function createRuntimePersistence(options: CreateKodaXRuntimeOptions): RuntimePersistence {
  const baseDir = options.homeDir
    ? path.resolve(options.homeDir)
    : options.sessionsDir
      ? path.resolve(options.sessionsDir, '..')
      : process.cwd();
  const runtimeDir = path.join(baseDir, '.kodax', 'runtime');
  const runsDir = path.join(runtimeDir, 'runs');
  const sessionSettingsDir = path.join(runtimeDir, 'session-settings');
  const eventSequenceFile = path.join(runtimeDir, 'event-sequence');
  const bufferedEventLines = new Map<string, string[]>();
  let bufferedEventBytes = 0;
  let scheduledEventFlush: ReturnType<typeof setTimeout> | undefined;
  let deferredAppendError: Error | undefined;
  let nextSequence: number | undefined;
  let sequenceDirty = false;

  const runDir = (runId: string): string => path.join(runsDir, encodeURIComponent(runId));
  const eventFile = (runId: string): string => path.join(runDir(runId), 'events.jsonl');
  const statusFile = (runId: string): string => path.join(runDir(runId), 'status.json');
  const sessionSettingsFile = (sessionId: string): string =>
    path.join(sessionSettingsDir, `${encodeURIComponent(sessionId)}.json`);
  const persistenceWarnings: RuntimeEvent[] = [];
  const persistenceWarningKeys = new Set<string>();

  const findMaxPersistedEventSeq = (): number => {
    let maxSeq = 0;
    if (fs.existsSync(eventSequenceFile)) {
      try {
        const persisted = Number.parseInt(fs.readFileSync(eventSequenceFile, 'utf-8').trim(), 10);
        if (Number.isSafeInteger(persisted) && persisted > 0) maxSeq = persisted;
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.persistence',
          level: 'warn',
          message: 'Failed to read runtime event sequence cursor; recovering from event logs',
          detail: error,
        });
      }
    }
    if (!fs.existsSync(runsDir)) return maxSeq;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(runsDir, entry.name, 'events.jsonl');
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      const readBytes = Math.min(size, MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(readBytes);
      const descriptor = fs.openSync(file, 'r');
      try {
        fs.readSync(descriptor, buffer, 0, readBytes, size - readBytes);
      } finally {
        fs.closeSync(descriptor);
      }
      const lines = buffer.toString('utf-8').split(/\r?\n/);
      if (readBytes < size) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRuntimeEvent(parsed) && Number.isSafeInteger(parsed.seq)) {
            maxSeq = Math.max(maxSeq, parsed.seq);
          }
        } catch {
          // Malformed records are surfaced by replay; sequence recovery only
          // considers complete runtime events.
        }
      }
    }
    return maxSeq;
  };

  const allocateEventSeq = (): number => {
    if (nextSequence === undefined) {
      nextSequence = findMaxPersistedEventSeq() + 1;
    }
    const allocated = nextSequence;
    nextSequence += 1;
    sequenceDirty = true;
    return allocated;
  };

  const pushPersistenceWarning = (
    key: string,
    message: string,
    scope: { readonly runId?: string; readonly sessionId?: string; readonly file?: string },
  ): void => {
    if (persistenceWarningKeys.has(key)) return;
    persistenceWarningKeys.add(key);
    const seq = allocateEventSeq();
    const event: RuntimeEvent = {
      id: `evt_persist_warn_${seq}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      seq,
      time: new Date().toISOString(),
      sessionId: scope.sessionId ?? 'runtime',
      runId: scope.runId ?? scope.sessionId ?? 'runtime',
      type: 'runtime.warning',
      payload: {
        source: 'runtime.persistence',
        message,
        ...(scope.file !== undefined ? { file: scope.file } : {}),
      },
    };
    persistenceWarnings.push(event);
    if (persistenceWarnings.length > MAX_RUNTIME_MEMORY_EVENTS) {
      persistenceWarnings.splice(0, persistenceWarnings.length - MAX_RUNTIME_MEMORY_EVENTS);
    }
  };

  const withPersistenceWarnings = (
    events: readonly RuntimeEvent[],
    filter: RuntimeEventReplayFilter | undefined,
  ): readonly RuntimeEvent[] => (
    [...events, ...persistenceWarnings]
      .filter((event) => eventMatchesReplayFilter(event, filter))
      .sort((a, b) => a.seq - b.seq || a.time.localeCompare(b.time))
  );

  const readEventsFromFile = (file: string, runId?: string): RuntimeEvent[] => {
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf-8');
    const events: RuntimeEvent[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRuntimeEvent(parsed)) {
          events.push(parsed);
        } else {
          pushPersistenceWarning(
            `${file}:${i + 1}:shape`,
            `Skipped malformed runtime event record at ${path.basename(file)}:${i + 1}`,
            { runId, file },
          );
        }
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${file}:${i + 1}:parse`,
          `Skipped malformed runtime event record at ${path.basename(file)}:${i + 1}: ${normalizeError(error).message}`,
          { runId, file },
        );
      }
    }
    return events;
  };

  const trimEventFile = (file: string): void => {
    if (fs.statSync(file).size <= MAX_RUNTIME_EVENT_FILE_BYTES) return;
    const lines = fs.readFileSync(file, 'utf-8').trimEnd().split(/\r?\n/);
    const kept: string[] = [];
    let keptBytes = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? '';
      if (!line) continue;
      const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
      if (kept.length > 0 && keptBytes + lineBytes > TARGET_RUNTIME_EVENT_FILE_BYTES) break;
      kept.push(line);
      keptBytes += lineBytes;
    }
    kept.reverse();
    fs.writeFileSync(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
  };

  const flushBufferedEvents = (): void => {
    if (scheduledEventFlush !== undefined) {
      clearTimeout(scheduledEventFlush);
      scheduledEventFlush = undefined;
    }
    for (const [runId, lines] of bufferedEventLines) {
      const content = lines.join('');
      const contentBytes = Buffer.byteLength(content, 'utf-8');
      const dir = runDir(runId);
      const file = eventFile(runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, content, 'utf-8');
      bufferedEventLines.delete(runId);
      bufferedEventBytes = Math.max(0, bufferedEventBytes - contentBytes);
      trimEventFile(file);
    }
    if (sequenceDirty && nextSequence !== undefined) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(eventSequenceFile, String(nextSequence - 1), 'utf-8');
      sequenceDirty = false;
    }
    deferredAppendError = undefined;
  };

  const scheduleEventFlush = (): void => {
    if (scheduledEventFlush !== undefined) return;
    scheduledEventFlush = setTimeout(() => {
      scheduledEventFlush = undefined;
      try {
        flushBufferedEvents();
      } catch (error: unknown) {
        deferredAppendError = normalizeError(error);
        emitKodaXDiagnostic({
          source: 'runtime.persistence',
          level: 'error',
          message: 'Failed to flush buffered runtime events',
          detail: error,
        });
      }
    }, RUNTIME_EVENT_FLUSH_INTERVAL_MS);
    scheduledEventFlush.unref?.();
  };

  return {
    runtimeDir,
    appendEvent(event) {
      const line = `${JSON.stringify(event)}\n`;
      const lines = bufferedEventLines.get(event.runId) ?? [];
      lines.push(line);
      bufferedEventLines.set(event.runId, lines);
      bufferedEventBytes += Buffer.byteLength(line, 'utf-8');

      const previousError = deferredAppendError;
      deferredAppendError = undefined;
      try {
        if (
          previousError !== undefined
          || !BUFFERED_RUNTIME_EVENT_TYPES.has(event.type)
          || bufferedEventBytes >= MAX_RUNTIME_BUFFERED_EVENT_BYTES
        ) {
          flushBufferedEvents();
        } else {
          scheduleEventFlush();
        }
      } catch (error: unknown) {
        scheduleEventFlush();
        throw error;
      }
      if (previousError !== undefined) throw previousError;
    },
    close() {
      flushBufferedEvents();
    },
    nextEventSeq() {
      return allocateEventSeq();
    },
    replay(filter) {
      try {
        flushBufferedEvents();
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${runtimeDir}:event-flush`,
          `Failed to flush buffered runtime events: ${normalizeError(error).message}`,
          { runId: filter?.runId },
        );
      }
      if (filter?.runId) {
        return withPersistenceWarnings(readEventsFromFile(eventFile(filter.runId), filter.runId), filter);
      }
      if (!fs.existsSync(runsDir)) return withPersistenceWarnings([], filter);
      const result: RuntimeEvent[] = [];
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        result.push(...readEventsFromFile(path.join(runsDir, entry.name, 'events.jsonl'), entry.name));
      }
      return withPersistenceWarnings(result, filter);
    },
    saveRunStatus(status) {
      const dir = runDir(status.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statusFile(status.runId), JSON.stringify(status, null, 2), 'utf-8');
    },
    loadRunStatus(runId) {
      const file = statusFile(runId);
      if (!fs.existsSync(file)) return undefined;
      try {
        const status = parseRuntimeRunStatus(JSON.parse(fs.readFileSync(file, 'utf-8')));
        if (status) return status;
        pushPersistenceWarning(
          `${file}:shape`,
          `Skipped malformed runtime status record at ${path.basename(file)}`,
          { runId, file },
        );
        return undefined;
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${file}:parse`,
          `Skipped malformed runtime status record at ${path.basename(file)}: ${normalizeError(error).message}`,
          { runId, file },
        );
        return undefined;
      }
    },
    loadRunStatuses() {
      if (!fs.existsSync(runsDir)) return [];
      const statuses: RuntimeRunStatus[] = [];
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(runsDir, entry.name, 'status.json');
        if (!fs.existsSync(file)) continue;
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
          const status = parseRuntimeRunStatus(parsed);
          if (status) {
            statuses.push(status);
          } else {
            pushPersistenceWarning(
              `${file}:shape`,
              `Skipped malformed runtime status record at ${path.basename(file)}`,
              { runId: entry.name, file },
            );
          }
        } catch (error: unknown) {
          pushPersistenceWarning(
            `${file}:parse`,
            `Skipped malformed runtime status record at ${path.basename(file)}: ${normalizeError(error).message}`,
            { runId: entry.name, file },
          );
        }
      }
      return statuses;
    },
    loadSessionSettings(sessionId) {
      const file = sessionSettingsFile(sessionId);
      if (!fs.existsSync(file)) return {};
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return parseRuntimeSessionSettings(parsed);
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${file}:parse`,
          `Skipped malformed runtime session settings at ${path.basename(file)}: ${normalizeError(error).message}`,
          { sessionId, file },
        );
        return {};
      }
    },
    saveSessionSettings(sessionId, settings) {
      fs.mkdirSync(sessionSettingsDir, { recursive: true });
      const serialized = serializeSessionSettings(settings);
      const file = sessionSettingsFile(sessionId);
      if (Object.keys(serialized).length === 0) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return;
      }
      fs.writeFileSync(file, JSON.stringify(serialized, null, 2), 'utf-8');
    },
  };
}

function resolveRuntimeSessionsDir(
  options: Pick<CreateKodaXRuntimeOptions, 'homeDir' | 'sessionsDir'>,
): string | undefined {
  if (options.sessionsDir !== undefined) {
    return path.resolve(options.sessionsDir);
  }
  if (options.homeDir !== undefined) {
    return path.join(path.resolve(options.homeDir), '.kodax', 'sessions');
  }
  return undefined;
}

function eventMatchesReplayFilter(
  event: RuntimeEvent,
  filter: RuntimeEventReplayFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) return false;
  return true;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.seq === 'number'
    && typeof value.time === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.runId === 'string'
    && typeof value.type === 'string'
    && 'payload' in value;
}

function parseRuntimeRunStatus(value: unknown): RuntimeRunStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.runId !== 'string'
    || typeof value.sessionId !== 'string'
    || !isRuntimeRunPhase(value.phase)
    || typeof value.startedAt !== 'string'
    || typeof value.provider !== 'string'
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    sessionId: value.sessionId,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    phase: value.phase,
    startedAt: value.startedAt,
    ...(typeof value.endedAt === 'string' ? { endedAt: value.endedAt } : {}),
    provider: value.provider,
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning as KodaXReasoningMode } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function isRuntimeRunPhase(value: unknown): value is RuntimeRunPhase {
  return value === 'queued'
    || value === 'running'
    || value === 'waiting_permission'
    || value === 'waiting_user_input'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'interrupted';
}

function recordFromPersistedStatus(status: RuntimeRunStatus): RuntimeRunRecord {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    ...(status.turnId !== undefined ? { turnId: status.turnId } : {}),
    phase: status.phase,
    startedAt: status.startedAt,
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    provider: status.provider,
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.reasoning !== undefined ? { reasoning: status.reasoning } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
    mode: 'coding',
    result: Promise.resolve(resultFromStatus(status)),
    terminalEmitted: isTerminalRunPhase(status.phase),
  };
}

function interruptPersistedNonTerminalRun(
  status: RuntimeRunStatus,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
): RuntimeRunStatus {
  if (isTerminalRunPhase(status.phase)) return status;
  const reason = status.phase === 'queued' ? 'daemon_restarted' : 'daemon_crashed';
  const recovered: RuntimeRunStatus = {
    ...status,
    phase: 'interrupted',
    endedAt: new Date().toISOString(),
    error: reason,
  };
  bus.emit('run.interrupted', recovered, {
    sessionId: recovered.sessionId,
    runId: recovered.runId,
    ...(recovered.turnId !== undefined ? { turnId: recovered.turnId } : {}),
  });
  saveRunStatusSafely(bus, persistence, undefined, recovered);
  return recovered;
}

function resolvePermissionTimeoutMs(expiresAt: string | undefined, fallbackMs: number): number {
  if (expiresAt === undefined) return fallbackMs;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 1;
  return Math.max(1, expiresAtMs - Date.now());
}

function createRuntimePermissionRegistry(bus: RuntimeEventBus, defaultTimeoutMs: number) {
  const pending = new Map<string, PendingPermission>();

  const trackAndWait = (
    request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
    timeoutMs = defaultTimeoutMs,
  ): {
    readonly request: RuntimePermissionRequest;
    readonly response: Promise<RuntimePermissionDecision>;
  } => {
    let resolveResponse: (decision: RuntimePermissionDecision) => void = () => {};
    const response = new Promise<RuntimePermissionDecision>((resolve) => {
      resolveResponse = resolve;
    });
    const created = createPendingPermission(
      request,
      [resolveResponse],
      resolvePermissionTimeoutMs(request.expiresAt, timeoutMs),
    );
    return { request: created, response };
  };

  const resolvePending = (
    requestId: string,
    decision: RuntimePermissionDecision,
    expectedRunId?: string,
  ): boolean => {
    const item = pending.get(requestId);
    if (!item) return false;
    if (expectedRunId !== undefined && item.request.runId !== expectedRunId) return false;
    pending.delete(requestId);
    if (item.timer) clearTimeout(item.timer);
    for (const resolve of item.waiters) resolve(decision);
    bus.emit('permission.resolved', { requestId, decision }, {
      sessionId: item.request.sessionId,
      runId: item.request.runId,
      ...(item.request.turnId !== undefined ? { turnId: item.request.turnId } : {}),
    });
    return true;
  };

  const resolveMatching = (
    predicate: (request: RuntimePermissionRequest) => boolean,
    decision: RuntimePermissionDecision,
  ): void => {
    const ids = [...pending.values()]
      .filter((item) => predicate(item.request))
      .map((item) => item.request.id);
    for (const id of ids) {
      resolvePending(id, decision);
    }
  };

  const service: RuntimePermissionService = {
    request(input) {
      const pendingPermission = trackAndWait({
        sessionId: input.sessionId,
        runId: input.runId,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.risk !== undefined ? { risk: input.risk } : {}),
        ...(input.inputPreview !== undefined ? { inputPreview: input.inputPreview } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }, input.timeoutMs ?? defaultTimeoutMs);
      return pendingPermission.response;
    },

    async listPending(filter) {
      return [...pending.values()]
        .map((item) => item.request)
        .filter((request) => permissionMatchesFilter(request, filter));
    },

    async respond(requestId, decision, options) {
      return resolvePending(requestId, decision, options?.runId);
    },
  };

  return {
    service,
    track(request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>): RuntimePermissionRequest {
      const created = createPendingPermission(
        request,
        [],
        resolvePermissionTimeoutMs(request.expiresAt, defaultTimeoutMs),
      );
      return created;
    },
    trackAndWait(
      request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
      timeoutMs = defaultTimeoutMs,
    ) {
      return trackAndWait(request, timeoutMs);
    },
    resolve(requestId: string, decision: RuntimePermissionDecision): void {
      resolvePending(requestId, decision);
    },
    rejectForRun(runId: string, reason: string): void {
      resolveMatching(
        (request) => request.runId === runId,
        { type: 'reject', reason },
      );
    },
    rejectAll(reason: string): void {
      resolveMatching(
        () => true,
        { type: 'reject', reason },
      );
    },
  };

  function createPendingPermission(
    request: Omit<RuntimePermissionRequest, 'id' | 'createdAt'>,
    waiters: Array<(decision: RuntimePermissionDecision) => void>,
    timeoutMs = defaultTimeoutMs,
  ): RuntimePermissionRequest {
    const created: RuntimePermissionRequest = {
      ...request,
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          const item = pending.get(created.id);
          if (!item) return;
          pending.delete(created.id);
          const decision: RuntimePermissionDecision = {
            type: 'reject',
            reason: 'permission request timed out',
          };
          for (const resolve of item.waiters) resolve(decision);
          bus.emit('permission.resolved', { requestId: created.id, decision }, {
            sessionId: created.sessionId,
            runId: created.runId,
            ...(created.turnId !== undefined ? { turnId: created.turnId } : {}),
          });
        }, timeoutMs)
      : undefined;
    timer?.unref?.();
    pending.set(created.id, {
      request: created,
      waiters,
      ...(timer !== undefined ? { timer } : {}),
    });
    bus.emit('permission.requested', created, {
      sessionId: created.sessionId,
      runId: created.runId,
      ...(created.turnId !== undefined ? { turnId: created.turnId } : {}),
    });
    return created;
  }
}

function wrapKodaXEvents(input: {
  readonly bus: RuntimeEventBus;
  readonly original?: KodaXEvents;
  readonly permissions: RuntimePermissionRegistry;
  readonly record: RuntimeRunRecord;
}): KodaXEvents {
  const { bus, original, permissions, record } = input;
  const scopeFromMeta = (meta?: Partial<KodaXActivityEventMeta>) => ({
    sessionId: meta?.sessionId ?? record.sessionId,
    runId: record.runId,
    turnId: meta?.turnId ?? record.turnId,
  });
  const emit = (
    type: RuntimeEventType,
    payload: unknown,
    meta?: Partial<KodaXActivityEventMeta>,
  ): void => {
    bus.emit(type, payload, scopeFromMeta(meta));
  };
  const runWithUserInputPhase = async <T>(
    kind: 'askUser' | 'askUserMulti' | 'askUserInput',
    options: unknown,
    meta: KodaXToolEventMeta | undefined,
    execute: () => Promise<T>,
  ): Promise<T> => {
    const requestId = `input_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const previousPhase = record.phase;
    if (record.phase === 'running') {
      record.phase = 'waiting_user_input';
    }
    emit('user_input.requested', { requestId, kind, options }, meta);
    try {
      const answer = await execute();
      emit('user_input.resolved', {
        requestId,
        kind,
        status: answer === undefined ? 'dismissed' : 'answered',
      }, meta);
      return answer;
    } catch (error: unknown) {
      emit('user_input.resolved', {
        requestId,
        kind,
        status: 'failed',
        error: normalizeError(error).message,
      }, meta);
      throw error;
    } finally {
      if (record.phase === 'waiting_user_input') {
        record.phase = previousPhase;
      }
    }
  };

  return {
    ...original,
    onTextDelta(text, meta) {
      emit('assistant.delta', { text, meta }, meta);
      original?.onTextDelta?.(text, meta);
    },
    onThinkingDelta(text, meta) {
      emit('thinking.delta', { text, meta }, meta);
      original?.onThinkingDelta?.(text, meta);
    },
    onThinkingEnd(thinking, meta) {
      emit('thinking.finished', { thinking, meta }, meta);
      original?.onThinkingEnd?.(thinking, meta);
    },
    onToolUseStart(tool, meta) {
      emit('tool.started', { tool, meta }, meta);
      original?.onToolUseStart?.(tool, meta);
    },
    onToolProgress(update, meta) {
      emit('tool.progress', { update, meta }, meta);
      original?.onToolProgress?.(update, meta);
    },
    onToolInputDelta(toolName, partialJson, meta) {
      emit('tool.progress', { toolName, partialJson, meta }, meta);
      original?.onToolInputDelta?.(toolName, partialJson, meta);
    },
    onToolResult(result, meta) {
      emit('tool.finished', { result, meta }, meta);
      original?.onToolResult?.(result, meta);
    },
    onStreamEnd(meta) {
      emit('run.progress', { kind: 'stream_end', meta }, meta);
      original?.onStreamEnd?.(meta);
    },
    onChildActivityEnd(meta) {
      emit('child_activity.finished', { meta }, meta);
      original?.onChildActivityEnd?.(meta);
    },
    onSessionStart(info) {
      record.provider = info.provider;
      bus.emit('session.loaded', info, {
        sessionId: info.sessionId,
        runId: record.runId,
        turnId: info.turnId ?? record.turnId,
      });
      original?.onSessionStart?.(info);
    },
    onTurnStarted(event) {
      record.turnId = event.turnId;
      bus.emit('turn.started', event, {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnStarted?.(event);
    },
    onTurnCompleted(event) {
      bus.emit('turn.completed', event, {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnCompleted?.(event);
    },
    onTurnFailed(event) {
      bus.emit('turn.failed', event, {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnFailed?.(event);
    },
    onIterationStart(iter, maxIter, meta) {
      emit('run.progress', { kind: 'iteration_start', iter, maxIter, meta }, meta);
      original?.onIterationStart?.(iter, maxIter, meta);
    },
    onIterationEnd(info) {
      emit('run.progress', { kind: 'iteration_end', info }, info);
      original?.onIterationEnd?.(info);
    },
    onCompactStart(meta) {
      emit('context.compaction.started', { meta }, meta);
      original?.onCompactStart?.(meta);
    },
    onCompact(estimatedTokens, meta) {
      emit('context.compaction.finished', { estimatedTokens, meta }, meta);
      original?.onCompact?.(estimatedTokens, meta);
    },
    onCompactStats(info) {
      emit('context.compaction.stats', info, info);
      original?.onCompactStats?.(info);
    },
    onCompactedMessages(messages, update, meta) {
      emit('context.compaction.messages', {
        messageCount: messages.length,
        update,
        meta,
      }, meta);
      original?.onCompactedMessages?.(messages, update, meta);
    },
    onCompactEnd(meta) {
      emit('context.compaction.ended', { meta }, meta);
      original?.onCompactEnd?.(meta);
    },
    onMidTurnUserMessages(contents, meta) {
      emit('run.progress', { kind: 'mid_turn_user_messages', contents, meta }, meta);
      original?.onMidTurnUserMessages?.(contents, meta);
    },
    onRetry(reason, attempt, maxAttempts, meta) {
      emit('provider.retry', { reason, attempt, maxAttempts, meta }, meta);
      original?.onRetry?.(reason, attempt, maxAttempts, meta);
    },
    onProviderRateLimit(attempt, maxRetries, delayMs, meta) {
      emit('provider.retry', {
        reason: 'rate_limit',
        attempt,
        maxAttempts: maxRetries,
        delayMs,
        meta,
      }, meta);
      original?.onProviderRateLimit?.(attempt, maxRetries, delayMs, meta);
    },
    onRetryAfter(payload, meta) {
      emit('provider.retry', { retryAfter: payload, meta }, meta);
      original?.onRetryAfter?.(payload, meta);
    },
    onReasoningEffortRejected(event) {
      emit('provider.recovery', { kind: 'reasoning_effort_rejected', event }, event);
      original?.onReasoningEffortRejected?.(event);
    },
    onRepoIntelligenceTrace(event) {
      emit('repo_intelligence.trace', event, event);
      original?.onRepoIntelligenceTrace?.(event);
    },
    onContextBudgetSnapshot(event) {
      emit('context.budget.snapshot', event, event);
      original?.onContextBudgetSnapshot?.(event);
    },
    onToolExposurePlanned(event) {
      emit('tool.exposure.planned', event, event);
      original?.onToolExposurePlanned?.(event);
    },
    onContextCompactionSkipped(event) {
      emit('context.compaction.skipped', event, event);
      original?.onContextCompactionSkipped?.(event);
    },
    onSidecarMessage(event) {
      emit('sidecar.message', event, event);
      original?.onSidecarMessage?.(event);
    },
    onTodoUpdate(items, meta) {
      emit('todo.updated', { items, meta }, meta);
      original?.onTodoUpdate?.(items, meta);
    },
    onTodoDriftWarning(event) {
      emit('todo.warning', event, event);
      original?.onTodoDriftWarning?.(event);
    },
    onProviderRecovery(event, meta) {
      emit('provider.recovery', { event, meta }, meta);
      original?.onProviderRecovery?.(event, meta);
    },
    onEffectiveConfig(config) {
      emit('config.effective', config, config);
      original?.onEffectiveConfig?.(config);
    },
    onWorkflowProcessEvent(event) {
      const mapped = workflowEventType(event);
      bus.emit(mapped, event, {
        sessionId: event.snapshot.hostMetadata?.sessionId ?? record.sessionId,
        runId: record.runId,
        turnId: record.turnId,
      });
      original?.onWorkflowProcessEvent?.(event);
    },
    onComplete(meta) {
      emit('run.progress', { kind: 'complete', meta }, meta);
      original?.onComplete?.(meta);
    },
    onError(error, meta) {
      emit('runtime.warning', {
        source: 'coding',
        severity: 'error',
        message: error.message,
      }, meta);
      original?.onError?.(error, meta);
    },
    onManagedTaskStatus(status) {
      emit('run.progress', { kind: 'managed_task_status', status }, status);
      original?.onManagedTaskStatus?.(status);
    },
    beforeToolExecute: async (
      tool: string,
      toolInput: Record<string, unknown>,
      meta?: KodaXToolEventMeta,
    ): Promise<RuntimePermissionToolDecision> => {
      // An in-process host hook is authoritative. The runtime policy is the
      // fallback for headless/daemon execution where no executable callback can
      // cross the wire.
      const policyDecision = original?.beforeToolExecute === undefined
        ? resolveRuntimePermissionPolicy(record, tool, toolInput)
        : undefined;
      if (policyDecision !== undefined) return policyDecision;
      const previousPhase = record.phase;
      if (record.phase === 'running') {
        record.phase = 'waiting_permission';
      }
      const pendingPermission = permissions.trackAndWait({
        sessionId: meta?.sessionId ?? record.sessionId,
        runId: record.runId,
        ...(meta?.turnId ?? record.turnId ? { turnId: meta?.turnId ?? record.turnId } : {}),
        ...(meta?.toolId ? { toolCallId: meta.toolId } : {}),
        toolName: tool,
        inputPreview: previewInput(toolInput),
      });
      try {
        if (!original?.beforeToolExecute) {
          const decision = await pendingPermission.response;
          return decisionToToolDecision(decision);
        }
        const hookDecision = Promise.resolve(original.beforeToolExecute(tool, toolInput, meta))
          .then((decision): RuntimePermissionRaceResult => ({
            source: 'hook',
            decision,
          }));
        const runtimeDecision = pendingPermission.response
          .then((decision): RuntimePermissionRaceResult => ({
            source: 'runtime',
            decision: decisionToToolDecision(decision),
          }));
        const result = await Promise.race([hookDecision, runtimeDecision]);
        if (result.source === 'hook') {
          permissions.resolve(
            pendingPermission.request.id,
            decisionToPermissionDecision(result.decision),
          );
        }
        return result.decision;
      } catch (error: unknown) {
        permissions.resolve(pendingPermission.request.id, {
          type: 'reject',
          reason: normalizeError(error).message,
        });
        throw error;
      } finally {
        if (record.phase === 'waiting_permission') {
          record.phase = previousPhase === 'queued' ? 'running' : previousPhase;
        }
      }
    },
    ...(original?.askUser
      ? {
          askUser: (
            options: AskUserQuestionOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<AskUserAnswer> => runWithUserInputPhase(
            'askUser',
            options,
            meta,
            () => original.askUser!(options, meta),
          ),
        }
      : {}),
    ...(original?.askUserMulti
      ? {
          askUserMulti: (
            options: AskUserMultiOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<Record<string, AskUserAnswer> | undefined> =>
            runWithUserInputPhase(
              'askUserMulti',
              options,
              meta,
              () => original.askUserMulti!(options, meta),
            ),
        }
      : {}),
    ...(original?.askUserInput
      ? {
          askUserInput: (
            options: { question: string; default?: string },
            meta?: KodaXToolEventMeta,
          ): Promise<string | undefined> => runWithUserInputPhase(
            'askUserInput',
            options,
            meta,
            () => original.askUserInput!(options, meta),
          ),
        }
      : {}),
  };
}

function buildSessionRuntimeInfo(
  input: RuntimeCreateSessionInput,
  projectPath: string | undefined,
  gitRoot: string | undefined,
): KodaXSessionRuntimeInfo | undefined {
  const info: KodaXSessionRuntimeInfo = {
    ...(gitRoot !== undefined ? { canonicalRepoRoot: gitRoot } : {}),
    ...(projectPath !== undefined ? { workspaceRoot: projectPath, executionCwd: projectPath } : {}),
    ...(projectPath !== undefined ? { workspaceKind: 'managed' } : {}),
    ...(input.surface !== undefined ? { surface: input.surface } : {}),
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

function toRuntimeSessionSummary(summary: SessionSummary): RuntimeSessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    msgCount: summary.msgCount,
    ...(summary.runtimeInfo?.gitRoot ? { gitRoot: summary.runtimeInfo.gitRoot } : {}),
    ...(summary.runtimeInfo?.workspaceRoot ? { workspaceRoot: summary.runtimeInfo.workspaceRoot } : {}),
    ...(summary.runtimeInfo?.surface ? { surface: summary.runtimeInfo.surface } : {}),
    ...(summary.runtimeInfo?.profileId ? { profileId: summary.runtimeInfo.profileId } : {}),
    ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
    ...(summary.tag !== undefined ? { tag: summary.tag } : {}),
    ...(summary.projectKey !== undefined ? { projectKey: summary.projectKey } : {}),
    ...(summary.archived === true ? { archived: true } : {}),
  };
}

interface NormalizedRuntimeRunInput {
  readonly prompt: string;
  readonly inputArtifacts: readonly KodaXInputArtifact[];
}

function normalizeRuntimeRunInput(
  input: RuntimeStartRunInput,
  artifacts: RuntimeArtifactStore,
): NormalizedRuntimeRunInput {
  const items = input.input === undefined
    ? []
    : Array.isArray(input.input)
      ? [...input.input]
      : [input.input];
  const textItems = items.filter((item): item is RuntimeTextInput => item.type === 'text');
  if (input.prompt !== undefined && textItems.length > 0) {
    throw new Error('runtime.runs.start accepts either prompt or text input, not both');
  }
  if (textItems.length > 1) {
    throw new Error('runtime.runs.start accepts at most one text input item');
  }
  const prompt = input.prompt ?? textItems[0]?.text;
  if (prompt === undefined) {
    throw new Error('runtime.runs.start requires prompt or text input');
  }
  return {
    prompt,
    inputArtifacts: items.flatMap((item) => runtimeInputToArtifacts(item, artifacts)),
  };
}

function runtimeInputToArtifacts(
  input: RuntimeInput,
  artifacts: RuntimeArtifactStore,
): KodaXInputArtifact[] {
  if (input.type === 'text') return [];
  if (input.type === 'artifact_ref') {
    return runtimeArtifactToInputArtifacts(artifacts.resolve(input.artifactId), input.description);
  }
  if (input.type === 'image') {
    const artifact: KodaXImageInputArtifact = {
      kind: 'image',
      path: input.path,
      ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    return [artifact];
  }
  if (input.type === 'file') {
    const artifact: KodaXFileInputArtifact = {
      kind: 'file',
      path: input.path,
      ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    return [artifact];
  }
  if (input.type === 'video') {
    const artifact: KodaXVideoInputArtifact = {
      kind: 'video',
      path: input.path,
      mediaType: input.mediaType,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    return [artifact];
  }
  const unsupported = input as { readonly type?: unknown };
  throw new Error(`Unsupported runtime input type: ${String(unsupported.type)}`);
}

function runtimeArtifactToInputArtifacts(
  artifact: RuntimeArtifact,
  description: string | undefined,
): KodaXInputArtifact[] {
  const resolvedDescription = description ?? artifact.description;
  if (artifact.kind === 'image') {
    const inputArtifact: KodaXImageInputArtifact = {
      kind: 'image',
      path: artifact.path,
      ...(artifact.mediaType !== undefined
        ? { mediaType: artifact.mediaType as KodaXImageInputArtifact['mediaType'] }
        : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
    };
    return [inputArtifact];
  }
  if (artifact.kind === 'file') {
    const inputArtifact: KodaXFileInputArtifact = {
      kind: 'file',
      path: artifact.path,
      ...(artifact.mediaType !== undefined ? { mediaType: artifact.mediaType } : {}),
      ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.name !== undefined ? { name: artifact.name } : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
    };
    return [inputArtifact];
  }
  if (artifact.kind === 'video') {
    const inputArtifact: KodaXVideoInputArtifact = {
      kind: 'video',
      path: artifact.path,
      mediaType: (
        artifact.mediaType ?? 'video/mp4'
      ) as KodaXVideoInputArtifact['mediaType'],
      ...(artifact.name !== undefined ? { name: artifact.name } : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
    };
    return [inputArtifact];
  }
  throw new Error(`Unsupported runtime artifact kind: ${String(artifact.kind)}`);
}

function isRuntimeArtifactKind(kind: unknown): kind is RuntimeArtifactKind {
  return typeof kind === 'string' && RUNTIME_ARTIFACT_KINDS.has(kind);
}

function buildEffectiveRuntimeOptions(
  options: RuntimeKodaXOptions,
  settings: RuntimeSessionSettings,
  inputArtifacts: readonly KodaXInputArtifact[],
): RuntimeKodaXOptions {
  const inheritedContext: KodaXOptions['context'] = {
    ...(settings.executionCwd !== undefined ? { executionCwd: settings.executionCwd } : {}),
  };
  const optionContext = options.context;
  const combinedArtifacts = [
    ...(optionContext?.inputArtifacts ?? []),
    ...inputArtifacts,
  ];
  const context: KodaXOptions['context'] = {
    ...inheritedContext,
    ...(optionContext ?? {}),
    ...(combinedArtifacts.length > 0 ? { inputArtifacts: combinedArtifacts } : {}),
  };
  const provider = options.provider ?? settings.provider;
  const model = options.model ?? settings.model;
  const effort = options.effort ?? settings.effort;
  const thinking = options.thinking ?? settings.thinking;
  const reasoningMode = options.reasoningMode ?? settings.reasoningMode;
  return {
    ...options,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoningMode !== undefined ? { reasoningMode } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

async function loadRequiredSession(
  manager: SessionManager,
  sessionId: string,
): Promise<KodaXSessionData> {
  const data = await manager.loadSession(sessionId);
  if (!data) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return data;
}

function assertSessionSettingsAllowed(
  session: KodaXSessionData,
  settings: RuntimeSessionSettings,
): void {
  if (settings.executionCwd === undefined) return;
  const root = session.runtimeInfo?.workspaceRoot ?? session.gitRoot;
  if (!root) return;
  assertPathWithinRoot(settings.executionCwd, root, 'executionCwd');
}

function assertPathWithinRoot(candidate: string, root: string, label: string): void {
  const resolvedCandidate = normalizePathForContainment(path.resolve(candidate));
  const resolvedRoot = normalizePathForContainment(path.resolve(root));
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within the session workspace root`);
  }
}

function normalizePathForContainment(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function applySessionSettingsPatch(
  current: RuntimeSessionSettings,
  patch: RuntimeSessionSettingsPatch,
): RuntimeSessionSettings {
  const next: RuntimeSessionSettings = { ...current };
  applyNullableStringPatch(next, 'provider', patch.provider);
  applyNullableStringPatch(next, 'model', patch.model);
  applyNullableStringPatch(next, 'permissionMode', patch.permissionMode);
  applyNullableStringPatch(next, 'executionCwd', patch.executionCwd, true);
  applyNullablePatch(next, 'effort', patch.effort);
  applyNullablePatch(next, 'thinking', patch.thinking);
  applyNullablePatch(next, 'reasoningMode', patch.reasoningMode);
  return next;
}

type RuntimeStringSettingKey =
  | 'provider'
  | 'model'
  | 'permissionMode'
  | 'executionCwd';

function applyNullableStringPatch(
  target: RuntimeSessionSettings,
  key: RuntimeStringSettingKey,
  value: string | null | undefined,
  requireAbsolutePath = false,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, key);
    return;
  }
  if (requireAbsolutePath && !path.isAbsolute(value)) {
    throw new Error(`${String(key)} must be an absolute path`);
  }
  setMutableSetting(target, key, value as RuntimeSessionSettings[typeof key]);
}

function applyNullablePatch<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
  value: RuntimeSessionSettings[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, key);
    return;
  }
  setMutableSetting(target, key, value);
}

function setMutableSetting<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
  value: RuntimeSessionSettings[K],
): void {
  (target as { -readonly [P in keyof RuntimeSessionSettings]: RuntimeSessionSettings[P] })[key] = value;
}

function deleteMutableSetting<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
): void {
  delete (target as { -readonly [P in keyof RuntimeSessionSettings]?: RuntimeSessionSettings[P] })[key];
}

function parseRuntimeSessionSettings(value: unknown): RuntimeSessionSettings {
  if (!isRecord(value)) return {};
  const settings: RuntimeSessionSettings = {};
  setStringIfPresent(settings, 'provider', value.provider);
  setStringIfPresent(settings, 'model', value.model);
  setStringIfPresent(settings, 'permissionMode', value.permissionMode);
  setStringIfPresent(settings, 'executionCwd', value.executionCwd);
  setStringIfPresent(settings, 'effort', value.effort);
  if (typeof value.thinking === 'boolean') {
    setMutableSetting(settings, 'thinking', value.thinking);
  }
  setStringIfPresent(settings, 'reasoningMode', value.reasoningMode);
  return settings;
}

function setStringIfPresent<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
  value: unknown,
): void {
  if (typeof value === 'string' && value.length > 0) {
    setMutableSetting(target, key, value as RuntimeSessionSettings[K]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} requires a plain object`);
  }
}

function sanitizeRuntimeConfigPatch(
  patch: Record<string, unknown>,
): RuntimeConfigPatch {
  const allowedKeys: ReadonlySet<string> = new Set(RUNTIME_CONFIG_PATCH_KEYS);
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`runtime.config.patch does not support config key: ${key}`);
    }
  }
  return patch as RuntimeConfigPatch;
}

function resolveRuntimeConfigFile(options: CreateKodaXRuntimeOptions): string | undefined {
  if (options.homeDir === undefined) return undefined;
  return path.join(path.resolve(options.homeDir), '.kodax', 'config.json');
}

function readRuntimeConfig(configFile: string | undefined): Record<string, unknown> {
  if (configFile === undefined) {
    return loadConfig() as unknown as Record<string, unknown>;
  }
  if (!fs.existsSync(configFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function patchRuntimeConfig(configFile: string | undefined, patch: RuntimeConfigPatch): void {
  if (configFile === undefined) {
    saveConfig(patch);
    return;
  }
  const current = readRuntimeConfig(configFile);
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(patch) as Array<keyof RuntimeConfigPatch>) {
    if (patch[key] === undefined) {
      delete merged[key];
    }
  }
  writeRuntimeConfig(configFile, merged);
}

function writeRuntimeConfig(configFile: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function listRuntimeCustomProviders(
  configFile: string | undefined,
): readonly KodaXCustomProviderConfig[] {
  if (configFile === undefined) return listCustomProviders();
  return cloneCustomProviders(extractRuntimeCustomProviders(readRuntimeConfig(configFile)));
}

function upsertRuntimeCustomProvider(
  configFile: string | undefined,
  config: KodaXCustomProviderConfig,
): KodaXCustomProviderConfig {
  if (configFile === undefined) return upsertCustomProvider(config);
  validateCustomProviderConfig(config);
  const whole = readRuntimeConfig(configFile);
  const existing = extractRuntimeCustomProviders(whole);
  const next = upsertConfigEntry(existing, config, (item) => item.name === config.name);
  writeRuntimeConfig(configFile, { ...whole, customProviders: next });
  registerCustomProviders(next);
  return structuredClone(config);
}

function removeRuntimeCustomProvider(
  configFile: string | undefined,
  name: string,
): boolean {
  if (configFile === undefined) return removeCustomProvider(name);
  if (typeof name !== 'string' || name.length === 0) return false;
  const whole = readRuntimeConfig(configFile);
  const existing = extractRuntimeCustomProviders(whole);
  const next = existing.filter((provider) => provider.name !== name);
  if (next.length === existing.length) return false;
  writeRuntimeConfig(configFile, { ...whole, customProviders: next });
  registerCustomProviders(next);
  return true;
}

function registerRuntimeConfiguredCustomProviders(configFile: string | undefined): void {
  if (configFile === undefined) return;
  registerCustomProviders(extractRuntimeCustomProviders(readRuntimeConfig(configFile)));
}

function extractRuntimeCustomProviders(
  config: Record<string, unknown>,
): KodaXCustomProviderConfig[] {
  return Array.isArray(config.customProviders)
    ? structuredClone(config.customProviders as KodaXCustomProviderConfig[])
    : [];
}

function cloneCustomProviders(
  providers: readonly KodaXCustomProviderConfig[],
): readonly KodaXCustomProviderConfig[] {
  return structuredClone(providers);
}

function listRuntimeMcpServers(configFile: string | undefined): Record<string, McpServerConfig> {
  if (configFile === undefined) return listMcpServers();
  return cloneMcpServers(extractRuntimeMcpServers(readRuntimeConfig(configFile)));
}

function getRuntimeMcpServer(
  configFile: string | undefined,
  name: string,
): McpServerConfig | undefined {
  if (configFile === undefined) return getMcpServerConfig(name);
  const config = extractRuntimeMcpServers(readRuntimeConfig(configFile))[name];
  return config === undefined ? undefined : structuredClone(config);
}

function upsertRuntimeMcpServer(
  configFile: string | undefined,
  name: string,
  config: McpServerConfig,
): McpServerConfig {
  if (configFile === undefined) return upsertMcpServer(name, config);
  validateMcpServerConfig(name, config);
  const whole = readRuntimeConfig(configFile);
  const servers = {
    ...extractRuntimeMcpServers(whole),
    [name]: structuredClone(config),
  };
  writeRuntimeConfig(configFile, { ...whole, mcpServers: servers });
  return structuredClone(config);
}

function removeRuntimeMcpServer(
  configFile: string | undefined,
  name: string,
): boolean {
  if (configFile === undefined) return removeMcpServer(name);
  const whole = readRuntimeConfig(configFile);
  const servers = extractRuntimeMcpServers(whole);
  if (!(name in servers)) return false;
  const next = { ...servers };
  delete next[name];
  writeRuntimeConfig(configFile, { ...whole, mcpServers: next });
  return true;
}

function extractRuntimeMcpServers(
  config: Record<string, unknown>,
): Record<string, McpServerConfig> {
  return isRecord(config.mcpServers)
    ? structuredClone(config.mcpServers as Record<string, McpServerConfig>)
    : {};
}

function cloneMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return structuredClone(servers);
}

function upsertConfigEntry<T>(
  entries: readonly T[],
  next: T,
  matches: (entry: T) => boolean,
): T[] {
  const existingIndex = entries.findIndex(matches);
  if (existingIndex < 0) return [...entries, structuredClone(next)];
  return entries.map((entry, index) => (
    index === existingIndex ? structuredClone(next) : structuredClone(entry)
  ));
}

function listRuntimeModels(
  providerList: unknown,
  filter: RuntimeModelListFilter | undefined,
): unknown {
  const providers = Array.isArray(providerList) ? providerList : [];
  if (filter?.provider !== undefined) {
    const provider = providers.find((item) => (
      isRecord(item) && item.name === filter.provider
    ));
    if (!isRecord(provider)) {
      return { provider: filter.provider, models: [] };
    }
    return {
      provider: filter.provider,
      models: Array.isArray(provider.models) ? provider.models : [],
    };
  }
  return providers.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    return [{
      provider: item.name,
      models: Array.isArray(item.models) ? item.models : [],
    }];
  });
}

function listRuntimeCommands(projectRoot?: string): readonly RuntimeCommandInfo[] {
  const registeredCommands = listReplCommands(projectRoot).map(replCommandToRuntimeCommandInfo);
  const extensionCommands = getActiveExtensionRuntime()
    ?.listCommands()
    .filter((command: ExtensionCommandDefinition) => command.metadata?.userInvocable !== false)
    .map(extensionCommandToRuntimeCommandInfo) ?? [];
  return [...registeredCommands, ...extensionCommands]
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listReplCommands(projectRoot?: string): readonly ReplCommandInfo[] {
  const commandCatalogApi = replApi as typeof replApi & {
    readonly listRegisteredCommands?: (projectRoot?: string) => readonly ReplCommandInfo[];
  };
  if (typeof commandCatalogApi.listRegisteredCommands === 'function') {
    return commandCatalogApi.listRegisteredCommands(projectRoot);
  }
  return replApi.getCommandRegistry().getAll();
}

function replCommandToRuntimeCommandInfo(command: ReplCommandInfo): RuntimeCommandInfo {
  return {
    name: command.name,
    ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
    description: command.description,
    source: command.source,
    ...(command.usage !== undefined ? { usage: command.usage } : {}),
    ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
    ...(command.location !== undefined ? { location: command.location } : {}),
    ...(command.path !== undefined ? { path: command.path } : {}),
    ...(command.userInvocable !== undefined ? { userInvocable: command.userInvocable } : {}),
    ...(command.disableModelInvocation !== undefined
      ? { disableModelInvocation: command.disableModelInvocation }
      : {}),
    ...(command.allowedTools !== undefined ? { allowedTools: command.allowedTools } : {}),
    ...(command.context !== undefined ? { context: command.context } : {}),
    ...(command.agent !== undefined ? { agent: command.agent } : {}),
    ...(command.model !== undefined ? { model: command.model } : {}),
  };
}

function extensionCommandToRuntimeCommandInfo(
  command: ExtensionCommandDefinition,
): RuntimeCommandInfo {
  return {
    name: command.name,
    ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
    description: command.description,
    source: 'extension',
    ...(command.usage !== undefined ? { usage: command.usage } : {}),
  };
}

function redactRuntimeConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRuntimeConfig(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveConfigKey(key) ? '[redacted]' : redactRuntimeConfig(item),
    ]),
  );
}

function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('apikey')
    || lower.includes('api_key')
    || lower === 'key'
    || lower.endsWith('key')
    || lower.includes('token')
    || lower.includes('secret')
    || lower.includes('password');
}

function toRuntimeSkillSummary(skill: SkillMetadata): RuntimeSkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable,
    ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
    path: skill.path,
    source: skill.source,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

function toRuntimeSkillDescription(skill: Skill): RuntimeSkillDescription {
  return {
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable ?? true,
    ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
    path: skill.path,
    source: skill.source,
    disableModelInvocation: skill.disableModelInvocation ?? false,
    content: skill.content,
    skillFilePath: skill.skillFilePath,
    ...(skill.scripts !== undefined ? { scripts: skill.scripts.map(toRuntimeSkillFileSummary) } : {}),
    ...(skill.references !== undefined ? { references: skill.references.map(toRuntimeSkillFileSummary) } : {}),
    ...(skill.assets !== undefined ? { assets: skill.assets.map(toRuntimeSkillFileSummary) } : {}),
    ...(skill.templates !== undefined ? { templates: skill.templates.map(toRuntimeSkillFileSummary) } : {}),
    ...(skill.resources !== undefined ? { resources: skill.resources.map(toRuntimeSkillFileSummary) } : {}),
  };
}

function toRuntimeSkillFileSummary(file: {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
}): RuntimeSkillFileSummary {
  return {
    name: file.name,
    path: file.path,
    relativePath: file.relativePath,
  };
}

function requireRuntimeRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Invalid runtime daemon response: expected object');
  }
  return value;
}

function parseRuntimeIdentity(value: unknown): RuntimeIdentity {
  const record = requireRuntimeRecord(value);
  if (
    typeof record.runtimeId !== 'string'
    || typeof record.mode !== 'string'
    || typeof record.profile !== 'string'
    || typeof record.startedAt !== 'string'
    || typeof record.version !== 'string'
  ) {
    throw new Error('Invalid runtime daemon response: missing identity fields');
  }
  return {
    runtimeId: record.runtimeId,
    mode: record.mode === 'daemon' ? 'daemon' : 'embedded',
    profile: record.profile,
    startedAt: record.startedAt,
    version: record.version,
    ...(record.isolation === 'inline' || record.isolation === 'worker' || record.isolation === 'process'
      ? { isolation: record.isolation }
      : {}),
    ...(typeof record.workerThreadId === 'number' ? { workerThreadId: record.workerThreadId } : {}),
  };
}

function serializeSessionSettings(settings: RuntimeSessionSettings): RuntimeSessionSettings {
  const result: RuntimeSessionSettings = {};
  if (settings.provider !== undefined) setMutableSetting(result, 'provider', settings.provider);
  if (settings.model !== undefined) setMutableSetting(result, 'model', settings.model);
  if (settings.effort !== undefined) setMutableSetting(result, 'effort', settings.effort);
  if (settings.thinking !== undefined) setMutableSetting(result, 'thinking', settings.thinking);
  if (settings.reasoningMode !== undefined) setMutableSetting(result, 'reasoningMode', settings.reasoningMode);
  if (settings.permissionMode !== undefined) setMutableSetting(result, 'permissionMode', settings.permissionMode);
  if (settings.executionCwd !== undefined) setMutableSetting(result, 'executionCwd', settings.executionCwd);
  return result;
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function statusFromRecord(run: RuntimeRunRecord): RuntimeRunStatus {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    phase: run.phase,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    provider: run.provider,
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function resultFromStatus(status: RuntimeRunStatus): RuntimeRunResult {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    phase: status.phase,
    ...(status.error !== undefined ? { error: new Error(status.error) } : {}),
  };
}

function recentRunStatuses(statuses: readonly RuntimeRunStatus[]): readonly RuntimeRunStatus[] {
  if (statuses.length <= MAX_RUNTIME_MEMORY_RUNS) return statuses;
  return [...statuses]
    .sort(compareRunStatusRecency)
    .slice(-MAX_RUNTIME_MEMORY_RUNS);
}

function pruneTerminalRuns(runs: Map<string, RuntimeRunRecord>): void {
  if (runs.size <= MAX_RUNTIME_MEMORY_RUNS) return;
  const terminal = [...runs.values()]
    .filter((run) => isTerminalRunPhase(run.phase))
    .sort((left, right) => compareRunStatusRecency(statusFromRecord(left), statusFromRecord(right)));
  for (const run of terminal) {
    if (runs.size <= MAX_RUNTIME_MEMORY_RUNS) return;
    runs.delete(run.runId);
  }
}

function compareRunStatusRecency(left: RuntimeRunStatus, right: RuntimeRunStatus): number {
  const leftTime = left.endedAt ?? left.startedAt;
  const rightTime = right.endedAt ?? right.startedAt;
  const byTime = leftTime.localeCompare(rightTime);
  return byTime !== 0 ? byTime : left.runId.localeCompare(right.runId);
}

function runMatchesFilter(
  run: RuntimeRunRecord,
  filter: RuntimeRunFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && run.sessionId !== filter.sessionId) return false;
  if (filter.phase !== undefined) {
    const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
    if (!phases.includes(run.phase)) return false;
  }
  return true;
}

function markRunTerminal(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord,
  phase: RuntimeRunPhase,
): void {
  if (run.terminalEmitted) return;
  run.phase = phase;
  run.endedAt = new Date().toISOString();
  run.terminalEmitted = true;
  const type: RuntimeEventType =
    phase === 'completed'
      ? 'run.completed'
      : phase === 'cancelled'
        ? 'run.cancelled'
        : phase === 'interrupted'
          ? 'run.interrupted'
          : 'run.failed';
  bus.emit(type, statusFromRecord(run), {
    sessionId: run.sessionId,
    runId: run.runId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
  });
  saveRunStatusSafely(bus, persistence, run, statusFromRecord(run));
}

function saveRunStatusSafely(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord | undefined,
  status: RuntimeRunStatus,
): void {
  try {
    persistence.saveRunStatus(status);
  } catch (error: unknown) {
    const turnId = run?.turnId ?? status.turnId;
    bus.emit('runtime.warning', {
      message: `Failed to save runtime run status for ${status.runId}: ${normalizeError(error).message}`,
      runId: status.runId,
      phase: status.phase,
    }, {
      sessionId: status.sessionId,
      runId: status.runId,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }
}

function isTerminalRunPhase(phase: RuntimeRunPhase): boolean {
  return phase === 'completed'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'interrupted';
}

function workflowEventType(event: WorkflowProcessEvent): RuntimeEventType {
  if (event.type === 'workflow_started') return 'workflow.started';
  if (event.type === 'workflow_finished') return 'workflow.finished';
  return 'workflow.updated';
}

function isFinalWorkflowStatus(status: WorkflowProcessSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function permissionMatchesFilter(
  request: RuntimePermissionRequest,
  filter: RuntimePermissionFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && request.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && request.runId !== filter.runId) return false;
  if (filter.toolName !== undefined && request.toolName !== filter.toolName) return false;
  return true;
}

function decisionToPermissionDecision(decision: boolean | string): RuntimePermissionDecision {
  if (decision === true) return { type: 'allow_once' };
  return {
    type: 'reject',
    reason: decision === false ? 'tool execution rejected' : decision,
  };
}

type RuntimePermissionRaceResult =
  | { readonly source: 'hook'; readonly decision: RuntimePermissionToolDecision }
  | { readonly source: 'runtime'; readonly decision: RuntimePermissionToolDecision };

function resolveRuntimePermissionPolicy(
  record: RuntimeRunRecord,
  tool: string,
  input: Record<string, unknown>,
): RuntimePermissionToolDecision | undefined {
  if (RUNTIME_PERMISSION_BRIDGE_TOOLS.has(tool)) return true;
  if (record.permissionBroker === 'client') return undefined;
  const mode = replApi.normalizePermissionMode(record.permissionMode);
  if (mode === undefined) return undefined;
  const projectRoot = record.start?.options.context?.gitRoot
    ?? record.start?.options.context?.executionCwd;
  if (mode === 'plan') {
    const blockReason = replApi.getPlanModeBlockReason(tool, input, projectRoot);
    return blockReason === null
      ? true
      : `${blockReason} Finish the plan before switching to a writable permission mode.`;
  }
  if (tool === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (replApi.isBashReadCommand(command)) return true;
    if (projectRoot && replApi.isCommandOnProtectedPath(command, projectRoot)) return undefined;
  }
  if (projectRoot && replApi.FILE_MODIFICATION_TOOLS.has(tool)) {
    const targetPath = typeof input.path === 'string' ? input.path : undefined;
    if (targetPath && replApi.isAlwaysConfirmPath(
      path.resolve(projectRoot, targetPath),
      projectRoot,
    )) {
      return undefined;
    }
  }
  return replApi.computeConfirmTools(mode).has(tool) ? undefined : true;
}

function decisionToToolDecision(
  decision: RuntimePermissionDecision | undefined,
): RuntimePermissionToolDecision {
  if (!decision) return false;
  if (decision.type === 'allow_once' || decision.type === 'allow_always') return true;
  return decision.reason ?? false;
}

function previewInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length <= 500 ? json : `${json.slice(0, 497)}...`;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertSessionMutationAllowed(
  sessionId: string,
  hasActiveRun: (candidateSessionId: string) => boolean,
): void {
  if (!hasActiveRun(sessionId)) return;
  const error = new Error(`Session has an active run and cannot be mutated: ${sessionId}`);
  Object.defineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    value: 'conflict',
  });
  throw error;
}

function assertDeleteSucceeded(sessionId: string, result: DeleteSessionResult): void {
  if ('ok' in result) return;
  throw new Error(`Session is running and cannot be deleted: ${sessionId}`);
}

function cloneMessage(message: KodaXMessage): KodaXMessage {
  return structuredClone(message);
}

export type {
  KodaXMessage,
  KodaXResult,
  KodaXEvents,
  SessionTranscriptEntry,
};
