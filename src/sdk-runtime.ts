/**
 * SDK subpath entry - `@kodax-ai/kodax/runtime`.
 *
 * FEATURE_253 (v0.7.64): embedded runtime contract. This module composes the
 * existing coding run loop, REPL-backed session storage, and agent workflow
 * process manager without introducing a daemon or a fifth workspace package.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getActiveExtensionRuntime,
  CodingActorSession,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_SPECULATIVE_WINDOW_MS,
  createAutoModeDenialTracker,
  createCircuitBreaker,
  breakerShouldFallback,
  bashSignalCollector,
  checkAbsoluteDeny,
  createExternalActorTurnExecutor,
  generateSessionId,
  listCodingDispatchableAgents,
  parseModelSpec,
  registerCustomProviders,
  resolveProviderModelDescriptors,
  resolveToolBridgeTarget,
  runManagedTask,
  normalizeShellExecutionContract,
  shellExecutionContractFingerprint,
  startKodaX,
  validateCustomProviderConfig,
} from "@kodax-ai/coding";
import {
  redactScopedProviderCredential,
  runWithProviderCredential,
} from "@kodax-ai/llm";
import * as replApi from "@kodax-ai/repl";
import type {
  AskUserAnswer,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  ExtensionCommandDefinition,
  ExtensionRuntimeDiagnostics,
  LoadedExtensionDiagnostic,
  KodaXCustomProviderConfig,
  KodaXContextCompactionFinishedEvent,
  KodaXContextIdentity,
  KodaXContextOptions,
  KodaXActivityEventMeta,
  KodaXEvents,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXMessage,
  KodaXManagedTaskStatusEvent,
  KodaXOptions,
  KodaXShellExecutionContract,
  KodaXPromptCacheDiagnosticEvent,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionData,
  KodaXSessionRuntimeInfo,
  KodaXShellSandbox,
  KodaXToolEventMeta,
  KodaXToolSandboxObservationUpdate,
  KodaXTurnCompletedEvent,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
  AutoModeStats,
  AutoModeSharedState,
  AutoModeDecisionDiagnostics,
  AutoModePermissionReview,
  AutoModeToolGuardrail,
  RuntimeContextBudgetSnapshot,
  RuntimeToolExposurePlan,
  ToolCallSignal,
  KodaXVideoInputArtifact,
  RunningSession,
} from "@kodax-ai/coding";
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
  withCoreConfigWriteLock,
  upsertCustomProvider,
  upsertMcpServer,
  validateMcpServerConfig,
} from "@kodax-ai/repl";
import {
  createRuntimePermissionMatcher,
  hasDynamicExpansionForPermissionShell,
  parseRuntimePermissionMatcher,
  runtimePermissionHostPlatform,
  runtimePermissionMatcherMatches,
  type RuntimeExactCommandPermissionMatcher,
  type RuntimePermissionMatcher,
} from "./runtime-permission-scope.js";
export type {
  RuntimeExactCallPermissionMatcher,
  RuntimeExactCommandPermissionMatcher,
  RuntimeExactPathPermissionMatcher,
  RuntimePermissionHostPlatform,
  RuntimePermissionMatcher,
} from "./runtime-permission-scope.js";
import type {
  CommandInfo as ReplCommandInfo,
  CompactSessionResult,
  DeleteSessionResult,
  FullTranscriptSessionData,
  SessionManager,
  SessionConversationHistoryData,
  SessionConversationHistoryEntry,
  SessionConversationHistoryIssue,
  SessionConversationHistoryStatus,
  SessionReadCapture,
  SessionReadOptions,
  SessionSummary,
  SessionTranscriptEntry,
} from "@kodax-ai/repl";
import {
  createMcpManager,
  createAgentExecutorPlane,
  createSessionLineage,
  emitKodaXDiagnostic,
  getAgentConfigHome,
  isPathInsideDirectory,
  normalizeCompactionConfig,
  resolveExecutionPath,
  getDefaultWorkflowRunManager,
  initializeSkillRegistry,
  actorQueueId,
  enqueueWithArtifacts,
  getMessageQueue,
  registerActiveRootQueueRoute,
  resolveLearningProposalStore,
} from "@kodax-ai/agent";
import {
  searchSessionHistoryCooperatively,
  validateSessionHistorySearchQuery,
} from "@kodax-ai/agent/session-lineage";
import type {
  AgentArtifactPolicy,
  AgentActorClient,
  AgentControllerHealth,
  AgentActorOwner,
  AgentActorSnapshot,
  AgentActorStore,
  AgentDataClassification,
  AgentDetail,
  AgentEvent,
  AgentExecutionKind,
  AgentFollowupResult,
  AgentOutput,
  AgentSpawnInput,
  AgentTreeSnapshot,
  AgentTurnRef,
  AgentCredentialBroker,
  AgentDispatchContext,
  AgentDispatchPolicy,
  AgentExecutorFactory,
  AgentExecutorPlane,
  AgentPreflightInput,
  AgentPreflightResult,
  AgentRegistrationService,
  DispatchableAgentListing,
  DispatchableAgentQuery,
  ManagedWorkflowSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpServerToolList,
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  ToolGuardrail,
  Skill,
  SkillMetadata,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
  KodaXSessionHistoryHit,
} from "@kodax-ai/agent";
import { createRuntimeAgentExecutorPlaneStore } from "./runtime-agent-store.js";
import { createRuntimeAgentBindingService } from "./runtime-agent-binding.js";
import {
  createRuntimeActorOwnerLiveness,
  inspectRuntimeActorOwner,
  inspectRuntimeActorOwners,
  isRuntimeActorOwnerAlive,
  type RuntimeActorOwnerLiveness,
} from "./runtime-actor-owner-liveness.js";
import {
  createAsrtShellSandbox,
  createAsrtSkillScriptRunner,
  sandboxRuntimeCapability,
} from "./sandbox-runtime.js";
import type {
  RuntimeAgentBindingService,
  RuntimeAgentOwnerSession,
  RuntimeBoundDefaultAgent,
  RuntimeBoundLocalAgent,
  RuntimeDefaultAgentStartInput,
  RuntimeEffectiveSkillRef,
  RuntimeExecutionToolPolicy,
  RuntimeLocalAgentStartInput,
  RuntimeResolvedLocalAgent,
  RuntimeUserMarkdownAgentRef,
  RuntimeWorkspaceBinding,
} from "./runtime-agent-binding.js";
import {
  createRuntimeLearningOwner,
  type RuntimeLearningService,
} from "./runtime-learning.js";
export type { RuntimeLearningService } from "./runtime-learning.js";
import {
  createRuntimeDaemonClient,
  type RuntimeDaemonClientTransport,
} from "./runtime-daemon/client.js";
import { acquireRuntimeDaemonLease } from "./runtime-daemon/manager.js";
import {
  acquireRuntimeDaemonProcessLease,
  type RuntimeDaemonProcessLease,
} from "./runtime-daemon/process.js";
import { createRuntimeWorkerTransport } from "./runtime-worker/transport.js";
import type { RuntimeWorkerOptions } from "./runtime-worker/protocol.js";
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from "./runtime-daemon/transport.js";
import {
  acquireRuntimeInlineOwner,
  enableRuntimeDaemonOwner,
  readRuntimeDaemonLockOwner,
  readRuntimeOwnerPolicy,
  readRuntimeDaemonToken,
  releaseRuntimeDaemonLock,
  resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPathsFromConfigHome,
  updateRuntimeOwnerPolicy,
} from "./runtime-daemon/state.js";
export {
  RuntimePermissionScopeUpgradeRequiredError,
  RuntimeTransportBoundaryError,
} from "./runtime-daemon/client.js";

export class RuntimeDaemonCapabilityUpgradeError extends Error {
  readonly code = "daemon_capability_upgrade_required" as const;
  readonly recoverable = true as const;
  readonly restartRequired = true as const;
  readonly capability: string;

  constructor(
    message: string,
    readonly preflight?: RuntimeDaemonPreflight,
    options?: ErrorOptions,
    capability = "runtimeAutoModeGuardrail",
  ) {
    super(message, options);
    this.name = "RuntimeDaemonCapabilityUpgradeError";
    this.capability = capability;
  }
}

/** A recoverable Auto LLM configuration error that must never become approval work. */
export class RuntimeAutoModeConfigurationError extends Error {
  readonly code = "auto_mode_classifier_model_required" as const;
  readonly recoverable = true as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeAutoModeConfigurationError";
  }
}
export type {
  RuntimeDaemonClientTransport,
  RuntimeDaemonRequestControl,
  RuntimeDaemonTransportLifecycleState,
} from "./runtime-daemon/client.js";
export { parseRuntimeEvent } from "./runtime-event.js";
export type {
  RuntimeAgentBindingService,
  RuntimeAgentOwnerSession,
  RuntimeBoundDefaultAgent,
  RuntimeBoundLocalAgent,
  RuntimeDefaultAgentStartInput,
  RuntimeEffectiveSkillRef,
  RuntimeExecutionToolPolicy,
  RuntimeLocalAgentStartInput,
  RuntimeResolvedLocalAgent,
  RuntimeUserMarkdownAgentRef,
  RuntimeWorkspaceBinding,
} from "./runtime-agent-binding.js";
export {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_METHODS,
} from "./runtime-daemon/protocol.js";
export type {
  RuntimeDaemonError,
  RuntimeDaemonErrorCode,
  RuntimeDaemonFrame,
  RuntimeDaemonMethod,
  RuntimeDaemonNotification,
  RuntimeDaemonNotificationMethod,
  RuntimeDaemonRequest,
} from "./runtime-daemon/protocol.js";
export {
  RUNTIME_DAEMON_METHOD_SCHEMAS,
  RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON,
  listRuntimeDaemonSchemaMethods,
} from "./runtime-daemon/schema.js";
export type {
  RuntimeDaemonJsonSchema,
  RuntimeDaemonMethodSchema,
  RuntimeDaemonProtocolSchema,
} from "./runtime-daemon/schema.js";
export type { RuntimeDaemonEndpoint } from "./runtime-daemon/transport.js";
export type {
  KodaXPromptCacheDiagnosticEvent,
  RuntimeContextBudgetSnapshot,
  RuntimeToolExposurePlan,
} from "@kodax-ai/coding";

export type KodaXRuntimeMode = "embedded" | "daemon";
export type KodaXRuntimeIsolation = "inline" | "worker" | "process";
export type {
  RuntimeWorkerOptions,
  RuntimeWorkerResourceLimits,
} from "./runtime-worker/protocol.js";

export interface RuntimeInlineOwnerHandle {
  readonly profile: string;
  readonly ownerId: string;
  readonly ownerPolicy: RuntimeOwnerPolicyState;
  close(): void;
}

export interface RuntimeOwnerPolicyState {
  readonly mode: "daemon" | "inline";
  readonly revision: number;
  readonly updatedAt: string;
}

export interface RuntimeOwnerIdentity {
  readonly runtimeId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly kind?: "daemon" | "inline";
}

export interface RuntimeOwnerState {
  readonly profile: string;
  readonly policy: RuntimeOwnerPolicyState;
  readonly ownerStatus: "unowned" | "owned" | "unreadable";
  readonly owner: RuntimeOwnerIdentity | null;
}

function resolveRuntimeDaemonClientLocation(homeDir: string | undefined): {
  readonly homeDir: string;
  readonly configHome: string;
} {
  const resolvedHome = path.resolve(homeDir ?? os.homedir());
  return {
    homeDir: resolvedHome,
    configHome:
      homeDir === undefined
        ? path.resolve(replApi.KODAX_DIR)
        : path.join(resolvedHome, ".kodax"),
  };
}

function resolveRuntimeDaemonClientPaths(
  homeDir: string | undefined,
  profile = "default",
) {
  const location = resolveRuntimeDaemonClientLocation(homeDir);
  return {
    ...location,
    paths: resolveRuntimeDaemonPathsFromConfigHome(
      location.configHome,
      profile,
    ),
  };
}

/**
 * Reserve the Coder profile for inline rollback. Partner runtimes must not use
 * this fence; they remain in their independent embedded namespace.
 */
export function acquireKodaXInlineOwner(
  input: {
    readonly homeDir?: string;
    readonly profile?: string;
    readonly enableRollback?: boolean;
  } = {},
): RuntimeInlineOwnerHandle {
  const { paths } = resolveRuntimeDaemonClientPaths(
    input.homeDir,
    input.profile,
  );
  const ownerId = `inline_${randomUUID().replace(/-/g, "")}`;
  const lock = acquireRuntimeInlineOwner(
    paths,
    {
      runtimeId: ownerId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      kind: "inline",
    },
    input.enableRollback === true,
  );
  let closed = false;
  return {
    profile: paths.profile,
    ownerId,
    ownerPolicy: readRuntimeOwnerPolicy(paths),
    close() {
      if (closed) return;
      closed = true;
      releaseRuntimeDaemonLock(lock);
    },
  };
}

export function getKodaXRuntimeOwnerPolicy(
  input: {
    readonly homeDir?: string;
    readonly profile?: string;
  } = {},
): RuntimeOwnerPolicyState {
  return readRuntimeOwnerPolicy(
    resolveRuntimeDaemonClientPaths(input.homeDir, input.profile).paths,
  );
}

export function getKodaXRuntimeOwnerState(
  input: {
    readonly homeDir?: string;
    readonly profile?: string;
  } = {},
): RuntimeOwnerState {
  const { paths } = resolveRuntimeDaemonClientPaths(
    input.homeDir,
    input.profile,
  );
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  return {
    profile: paths.profile,
    policy: readRuntimeOwnerPolicy(paths),
    ownerStatus:
      owner !== undefined
        ? "owned"
        : fs.existsSync(paths.lockFile)
          ? "unreadable"
          : "unowned",
    owner: owner ?? null,
  };
}

/** Enable daemon auto-start after the inline owner has released its fence. */
export function enableKodaXDaemonOwner(
  input: {
    readonly homeDir?: string;
    readonly profile?: string;
  } = {},
): RuntimeOwnerPolicyState {
  return enableRuntimeDaemonOwner(
    resolveRuntimeDaemonClientPaths(input.homeDir, input.profile).paths,
  );
}

export function setKodaXRuntimeOwnerMode(input: {
  readonly mode: "daemon" | "inline";
  readonly expectedRevision: number;
  readonly homeDir?: string;
  readonly profile?: string;
}): {
  readonly mode: "daemon" | "inline";
  readonly revision: number;
  readonly updatedAt: string;
} {
  const { paths } = resolveRuntimeDaemonClientPaths(
    input.homeDir,
    input.profile,
  );
  if (readRuntimeDaemonLockOwner(paths.lockFile) !== undefined) {
    throw new Error(
      "Cannot change Runtime owner mode while an owner lock exists.",
    );
  }
  return updateRuntimeOwnerPolicy(paths, input.mode, input.expectedRevision);
}

type ReplRuntimeConfigPatch = Parameters<typeof saveConfig>[0];

const RUNTIME_CONFIG_PATCH_KEYS = [
  "provider",
  "model",
  "effort",
  "planModeEffort",
  "thinking",
  "reasoningMode",
  "agentMode",
  "permissionMode",
  "locale",
  "providerModels",
  "extensions",
  "repoIntelligenceMode",
  "repoIntelligenceTrace",
  "verifierLog",
  "stallLog",
  "fallbackProviders",
  "fastProvider",
  "fastModel",
  "deepProvider",
  "deepModel",
  "maxOutputTokens",
  "disablePromptCache",
  "lsp",
  "lspAutoDownload",
  "acpLogLevel",
  "sessionRetentionDays",
  "repoIntelligence",
  "workflow",
] as const satisfies readonly (keyof ReplRuntimeConfigPatch)[];

const CODER_DAEMON_SESSION_SURFACES = new Set([
  "code",
  "cli",
  "repl",
  "acp",
  "a2a",
  "sdk",
  "ide",
  "space-desktop",
]);

type RuntimeConfigPatchKey = (typeof RUNTIME_CONFIG_PATCH_KEYS)[number];

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
  /** Stable host-generated identity used only after daemon authentication. */
  readonly instanceId?: string;
  /** Stable host-generated secret; persist in OS keychain to resume client-owned leases. */
  readonly instanceSecret?: string;
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
  readonly operationDeduplication?: boolean;
}

export type RuntimeGrantedScope =
  | "session:observe"
  | "session:write"
  | "run:control"
  | "interaction:respond"
  | "permission:respond"
  | "permission:grant-admin"
  | "integration:admin"
  | "workflow:control"
  | "learning:read"
  | "learning:control"
  | "artifact:write"
  | "agent:control"
  | "credential:register"
  | "host-tool:register"
  | "owner:admin"
  | "daemon:admin";

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
  readonly isolation?: "inline" | "worker";
  /** Requires `isolation: 'worker'`; rejected instead of being silently ignored. */
  readonly worker?: RuntimeWorkerOptions;
  /** Base directory that owns `.kodax`, matching CLI `--home`; not the `.kodax` directory used by `KODAX_HOME`. */
  readonly homeDir?: string;
  readonly profile?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
  /** Internal daemon-host switch; keeps ordinary embedded runs non-interactive by default. */
  readonly sharedDaemonHost?: boolean;
  /** @internal Owner-fence identity assigned before a shared daemon Runtime is constructed. */
  readonly daemonHostRuntimeId?: string;
  readonly daemonStartupTimeoutMs?: number;
  readonly daemonConnectTimeoutMs?: number;
  /**
   * Auto-started daemon only: after the last logical client disconnects,
   * stop once governed work is idle. Omit to keep the normal persistent daemon.
   */
  readonly daemonOrphanExitMs?: number;
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
  /** Base directory that owns `.kodax`, matching CLI `--home`; not the `.kodax` directory used by `KODAX_HOME`. */
  readonly homeDir?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
  readonly daemonStartupTimeoutMs?: number;
  readonly daemonConnectTimeoutMs?: number;
  /** Auto-started daemon idle-exit policy; see CreateKodaXRuntimeOptions. */
  readonly daemonOrphanExitMs?: number;
  readonly daemonToken?: string;
  readonly clientInfo?: RuntimeClientInfo;
  readonly capabilities?: RuntimeClientCapabilities;
  readonly requirements?: RuntimeCapabilityRequirements;
}

/** SDK facts that embedders can inspect before auto-starting a daemon. */
export const KODAX_RUNTIME_SDK_CAPABILITIES = Object.freeze({
  daemonOrphanExit: 1,
  managedRunDurability: 1,
  runtimeEventCoalescing: 1,
} as const);

export interface RuntimeCapabilityRequirements {
  /** Reject inline and shared daemon hosts; only a Worker-hosted Runtime satisfies this. */
  readonly hardDispose?: boolean;
  /** Reject hosts that do not advertise an installed external Agent executor plane. */
  readonly externalAgents?: boolean;
  /** Require owner/revision-fenced external Agent registration administration. */
  readonly externalAgentAdmin?: 1;
  /** Require a daemon that owns and hot-reconciles its A2A integration config. */
  readonly a2aConfigReconciler?: 1;
  readonly operationDeduplication?: 1;
  readonly sessionObservation?: 1;
  readonly afterTurnInput?: 1;
  readonly learningCenter?: 1;
  readonly skillLearningLoop?: 1;
  readonly interruptInput?: 1;
  readonly askUserTransport?: 1;
  readonly permissionCas?: 1;
  readonly providerCredentialBroker?: 1;
  readonly runBoundHostTools?: 1;
  readonly coderOwnerFencing?: 1;
  readonly crashOutcomeModel?: 1;
  readonly coderFeatureMatrix?: 1;
  readonly sessionAdmission?: 1;
  readonly completeObservationSnapshot?: 1;
  /** Require always-on thresholds, stable context identity, and canonical compact events. */
  readonly contextCompaction?: 1 | 2 | 3;
  /** Require bounded transcript slices plus page/chunk recovery. */
  readonly transcriptPaging?: 1;
  /** Require deterministic exact-history search over merged persisted lineage. */
  readonly transcriptSearch?: 1;
  /** Require SDK-resolved ordinary history with explicit legacy ambiguity. */
  readonly conversationHistory?: 1;
  readonly connectionLifecycle?: 1;
  readonly typedRuntimeEvents?: 1;
  readonly daemonSafeRunInput?: 1;
  readonly sharedSessionSettings?: 1;
  readonly durableRecoveryQueries?: 1;
  /** Require durable accepted-input and completed-turn boundaries for managed Runs. */
  readonly managedRunDurability?: 1;
  readonly daemonManagement?: 1;
  /** Require an auto-started daemon whose current host has orphan idle-exit enabled. */
  readonly daemonOrphanExit?: 1;
  /** Require source-level bounded coalescing before sequence allocation and persistence. */
  readonly runtimeEventCoalescing?: 1;
  /** Optional integration failures are isolated, observable, and hot-recoverable. */
  readonly integrationConfigResilience?: 1;
  readonly actorControlPlane?: 1;
  /** Runtime owns Auto LLM/rules classification before shared permission brokering. */
  readonly runtimeAutoModeGuardrail?: 1 | 2 | 3 | 4;
}

export type RuntimeOperationState =
  | "accepted"
  | "dispatched"
  | "applied"
  | "rejected"
  | "interrupted"
  | "unknown";

export interface RuntimeOperationReceipt {
  readonly operationId: string;
  readonly journalEpoch: string;
  readonly principalId: string;
  readonly method: string;
  readonly resourceId?: string;
  readonly requestDigest: string;
  readonly state: RuntimeOperationState;
  /** Serialized mutation result when state is applied; exact retries return the same value. */
  readonly result?: unknown;
  readonly updatedAt: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface RuntimeOperationService {
  get(input: {
    readonly operationId: string;
    readonly journalEpoch: string;
  }): Promise<RuntimeOperationReceipt>;
}

export interface RuntimeDiagnosticFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  /** Defaults to root so child physical requests do not replace root diagnostics. */
  readonly contextKind?: "root" | "child";
  readonly agentId?: string;
}

export interface RuntimeDiagnosticsService {
  latestContextBudget(
    filter?: RuntimeDiagnosticFilter,
  ): Promise<RuntimeContextBudgetSnapshot | null>;
  latestToolExposure(
    filter?: RuntimeDiagnosticFilter,
  ): Promise<RuntimeToolExposurePlan | null>;
  latestProviderCacheDiagnostic(
    filter?: RuntimeDiagnosticFilter,
  ): Promise<KodaXPromptCacheDiagnosticEvent | null>;
}

export interface RuntimeConnectionState {
  readonly state: "connected" | "disconnected";
  readonly connectionId: string;
  readonly runtimeEpoch: string;
  readonly journalEpoch?: string;
  readonly reason?: string;
  readonly reconnectable: boolean;
}

export interface RuntimeConnectionService {
  current(): RuntimeConnectionState;
  subscribe(
    listener: (state: RuntimeConnectionState) => void,
  ): RuntimeSubscription;
}

export interface KodaXRuntime {
  readonly identity: RuntimeIdentity;
  /** Server-advertised facts. Authorization remains defined by grantedScopes. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly grantedScopes?: readonly RuntimeGrantedScope[];
  readonly sessions: RuntimeSessionService;
  readonly runs: RuntimeRunService;
  readonly events: RuntimeEventService;
  readonly permissions: RuntimePermissionService;
  readonly userInputs: RuntimeUserInputService;
  readonly credentials: RuntimeCredentialService;
  readonly hostTools: RuntimeHostToolService;
  readonly operations: RuntimeOperationService;
  readonly workflows: RuntimeWorkflowService;
  readonly learning: RuntimeLearningService;
  readonly config: RuntimeConfigService;
  readonly catalog: RuntimeCatalogService;
  readonly mcp: RuntimeMcpService;
  readonly artifacts: RuntimeArtifactService;
  readonly status: RuntimeStatusService;
  readonly diagnostics: RuntimeDiagnosticsService;
  /** Present on daemon facades; emits disconnects without waiting for polling. */
  readonly connection?: RuntimeConnectionService;
  readonly admin: RuntimeAdminService;
  readonly agents: RuntimeAgentService;
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
  /** Present when this facade owns an embedded execution substrate. */
  readonly execution?: RuntimeAgentBindingService;
  listDispatchable(
    query: DispatchableAgentQuery,
  ): Promise<readonly DispatchableAgentListing[]>;
  describe(
    agentId: string,
    query: DispatchableAgentQuery,
  ): Promise<DispatchableAgentListing | undefined>;
  preflight(input: AgentPreflightInput): Promise<AgentPreflightResult>;
  tree(sessionId: string): Promise<AgentTreeSnapshot>;
  detail(sessionId: string, actorPath: string): Promise<AgentDetail>;
  spawn(sessionId: string, input: AgentSpawnInput): Promise<AgentTurnRef>;
  send(
    sessionId: string,
    actorPath: string,
    content: string,
    classification?: AgentDataClassification,
  ): Promise<void>;
  followup(
    sessionId: string,
    actorPath: string,
    objective: string,
    options?: { readonly expectedRevision?: number },
  ): Promise<AgentFollowupResult>;
  interrupt(
    sessionId: string,
    actorPath: string,
    reason?: string,
  ): Promise<void>;
  output(
    sessionId: string,
    actorPath: string,
    turnId?: string,
  ): Promise<AgentOutput>;
  events(
    sessionId: string,
    afterSequence?: number,
  ): Promise<readonly AgentEvent[]>;
  wait(
    sessionId: string,
    afterSequence?: number,
    timeoutMs?: number,
    options?: Readonly<Pick<RuntimeReadOptions, "signal">>,
  ): Promise<AgentEvent | undefined>;
}

export type RuntimeConfigPatch = Partial<
  Pick<ReplRuntimeConfigPatch, RuntimeConfigPatchKey>
>;

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
  readonly source: ReplCommandInfo["source"];
  readonly usage?: string;
  readonly argumentHint?: string;
  readonly location?: ReplCommandInfo["location"];
  readonly path?: string;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly allowedTools?: string;
  readonly context?: "fork";
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
  readonly source: SkillMetadata["source"];
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
  resolveCommand(
    input: RuntimeCommandResolveInput,
  ): Promise<RuntimeCommandInfo | null>;
  skills(
    filter?: RuntimeSkillListFilter,
  ): Promise<readonly RuntimeSkillSummary[]>;
  describeSkill(
    input: RuntimeSkillDescribeInput,
  ): Promise<RuntimeSkillDescription | null>;
  customProviders(): Promise<readonly KodaXCustomProviderConfig[]>;
  upsertCustomProvider(
    config: KodaXCustomProviderConfig,
  ): Promise<KodaXCustomProviderConfig>;
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
  validateServer(
    name: string,
    config: unknown,
  ): Promise<RuntimeMcpValidateResult>;
  upsertServer(name: string, config: McpServerConfig): Promise<McpServerConfig>;
  deleteServer(name: string): Promise<boolean>;
  reloadServers(): Promise<RuntimeMcpReloadResult>;
  listTools(
    filter?: RuntimeMcpToolListFilter,
  ): Promise<readonly McpServerToolList[]>;
}

export type RuntimeArtifactKind = "image" | "file" | "video";

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
  readonly operation?: RuntimeOperationOptions;
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

/** Payload emitted when an executing run binds its provider session. */
export interface RuntimeRunSessionLoadedEventPayload {
  readonly provider: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly iteration?: number;
}

/** Durable compatibility event emitted when a run binds its provider session. */
export type RuntimeSessionLoadedEventPayload =
  RuntimeSession | RuntimeRunSessionLoadedEventPayload;

export interface RuntimeSessionSummary extends RuntimeSession {
  /** Opaque continuation token accepted by RuntimeSessionFilter.cursor. */
  readonly cursor?: string;
  readonly msgCount: number;
  readonly tag?: string;
  readonly projectKey?: string;
  readonly archived?: boolean;
}

export type RuntimeTranscript = FullTranscriptSessionData;

export interface RuntimeConversationHistory extends SessionConversationHistoryData {
  /** Content-derived identity shared by direct and paged conversation reads. */
  readonly revision: string;
}

export interface RuntimeConversationHistorySliceEntry {
  readonly index: number;
  readonly boundaryId?: string;
  readonly byteLength: number;
  readonly oversized: boolean;
  readonly entry?: SessionConversationHistoryEntry;
}

export interface RuntimeConversationHistorySlice {
  readonly revision: string;
  readonly sourceRevision: string;
  readonly status: SessionConversationHistoryStatus;
  readonly issues: readonly SessionConversationHistoryIssue[];
  readonly entries: readonly RuntimeConversationHistorySliceEntry[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface RuntimeConversationHistoryPageInput {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RuntimeTranscriptSliceEntry {
  readonly index: number;
  readonly entryId?: string;
  readonly byteLength: number;
  readonly oversized: boolean;
  readonly entry?: SessionTranscriptEntry;
}

export interface RuntimeTranscriptSlice {
  readonly revision: string;
  readonly entries: readonly RuntimeTranscriptSliceEntry[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface RuntimeTranscriptPageInput {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RuntimeReadOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeSessionDiagnosticsInput extends RuntimeReadOptions {
  readonly sessionId: string;
  /** Select one Run control record; otherwise the authoritative Session Run is used. */
  readonly runId?: string;
}

export type RuntimeSessionDiagnosticErrorCode =
  | "run_control_unknown"
  | "run_status_unknown"
  | "owner_liveness_unconfirmed"
  | "owner_recovery_required"
  | "stop_outcome_unconfirmed"
  | "actor_settlement_retrying"
  | "actor_settlement_not_persisted"
  | "run_failed"
  | "terminal_time_unknown";

export interface RuntimeSessionDiagnosticError {
  readonly code: RuntimeSessionDiagnosticErrorCode;
  readonly message: string;
}

export interface RuntimeSessionDiagnosticRun {
  readonly controlRecord: "present" | "unknown";
  readonly runId?: string;
  readonly turnId?: string;
  readonly state: "queued" | "active" | "terminal" | "unknown";
  readonly phase?: RuntimeRunPhase;
  readonly stage: RuntimeRunStage | "unknown";
  readonly stageChangedAt?: string;
  readonly terminalAt?: string;
  readonly terminalTimeKnown: boolean;
  readonly terminal?: RuntimeTerminalFact;
  readonly activeSubtaskCount: number | null;
  readonly activeSubtaskCountSource: "run_status" | "unknown";
  readonly stop?: RuntimeRunStopStatus;
  readonly interruptInputs?: readonly RuntimeInterruptInputStatus[];
  readonly errors: readonly RuntimeSessionDiagnosticError[];
}

export interface RuntimeSessionDiagnostics {
  readonly schemaVersion: 1;
  readonly captureStartedAt: string;
  readonly capturedAt: string;
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
  readonly daemonVersion: string | null;
  readonly runtimeId: string;
  readonly runtimeMode: KodaXRuntimeMode;
  readonly sessionId: string;
  readonly observation: {
    readonly cursor: number;
    readonly transcriptRevision: string;
  };
  readonly run: RuntimeSessionDiagnosticRun;
}

interface RuntimeReadBudget {
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeTranscriptEntryChunkInput {
  readonly sessionId: string;
  readonly revision: string;
  readonly entryIndex: number;
  readonly cursor?: string;
}

export interface RuntimeTranscriptEntryChunk {
  readonly revision: string;
  readonly entryIndex: number;
  readonly entryId?: string;
  readonly encoding: "base64-json";
  readonly data: string;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface RuntimeConversationHistoryEntryChunk {
  readonly revision: string;
  readonly entryIndex: number;
  readonly boundaryId?: string;
  readonly encoding: "base64-json";
  readonly data: string;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface RuntimeConversationHistoryEntryChunkInput {
  readonly sessionId: string;
  readonly revision: string;
  readonly entryIndex: number;
  readonly cursor?: string;
}

export interface RuntimeTranscriptSearchInput {
  readonly sessionId: string;
  readonly query: string;
  readonly limit?: number;
  readonly role?: "user" | "assistant";
  readonly scope?: "compacted" | "all";
}

export interface RuntimeTranscriptSearchHit extends KodaXSessionHistoryHit {
  /** Index accepted by transcriptEntryChunk for this exact transcript revision. */
  readonly entryIndex: number;
}

export interface RuntimeTranscriptSearchResult {
  readonly revision: string;
  readonly hits: readonly RuntimeTranscriptSearchHit[];
}

export interface RuntimeSessionFilter {
  readonly projectRoot?: string;
  readonly scope?: "user" | "managed-task-worker" | "all";
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly tag?: string;
  readonly surface?: string;
  readonly cursor?: string;
}

export interface RuntimeForkSessionInput {
  readonly sessionId: string;
  readonly selector?: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly historyBoundary?: RuntimeConversationHistoryBoundary;
}

export interface RuntimeConversationHistoryBoundary {
  readonly entryId: string;
  readonly sourceRevision: string;
}

export interface RuntimeSessionSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: KodaXOptions["effort"];
  readonly thinking?: boolean;
  readonly reasoningMode?: KodaXReasoningMode;
  readonly permissionMode?: string;
  readonly executionCwd?: string;
  readonly shellExecution?: KodaXShellExecutionContract;
  readonly agentMode?: KodaXOptions["agentMode"];
  readonly autoModeEngine?: "llm" | "rules";
  readonly autoModeClassifierModel?: string;
  readonly autoModeTimeoutMs?: number;
  readonly autoModeSpeculativeWindowMs?: number;
  /** Auto-compaction percentage threshold, normalized to the inclusive 15-90 range. */
  readonly compactionTriggerPercent?: number;
  /** Optional absolute auto-compaction threshold. Missing or zero is inactive. */
  readonly compactionTriggerTokens?: number;
}

export interface RuntimeSessionSettingsPatch {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly effort?: KodaXOptions["effort"] | null;
  readonly thinking?: boolean | null;
  readonly reasoningMode?: KodaXReasoningMode | null;
  readonly permissionMode?: string | null;
  readonly executionCwd?: string | null;
  readonly shellExecution?: KodaXShellExecutionContract | null;
  readonly agentMode?: KodaXOptions["agentMode"] | null;
  readonly autoModeEngine?: "llm" | "rules" | null;
  readonly autoModeClassifierModel?: string | null;
  readonly autoModeTimeoutMs?: number | null;
  readonly autoModeSpeculativeWindowMs?: number | null;
  readonly compactionTriggerPercent?: number | null;
  readonly compactionTriggerTokens?: number | null;
}

export interface RuntimeAppendNoticeInput {
  readonly sessionId: string;
  readonly content: string;
  readonly source?: string;
}

export interface RuntimeRewindSessionInput {
  readonly sessionId: string;
  readonly selector?: string;
  readonly historyBoundary?: RuntimeConversationHistoryBoundary;
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
  /** Override the Session percentage threshold used to size the protected tail. */
  readonly triggerPercent?: number;
  /** Override the Session absolute threshold used to size the protected tail. */
  readonly triggerTokens?: number;
}

export interface RuntimeCompactSessionResult extends CompactSessionResult {
  readonly session?: RuntimeSession;
}

export interface RuntimeVersionedValue<T> {
  readonly revision: number;
  readonly value: T;
}

export interface RuntimeVersionedUpdateOptions extends RuntimeOperationOptions {
  readonly expectedRevision: number;
}

export interface RuntimeActiveToolProjection {
  readonly key: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly started: unknown;
  readonly progress?: unknown;
  readonly sandbox?: RuntimeToolSandboxEventPayload;
}

export interface RuntimePendingUserInputProjection {
  readonly requestId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly detail: unknown;
}

export interface RuntimeManagedTaskProjection {
  readonly runId: string;
  readonly turnId?: string;
  readonly status: KodaXManagedTaskStatusEvent;
}

export interface RuntimeSessionLiveProjection {
  readonly assistantTextByRun: Readonly<Record<string, string>>;
  readonly thinkingTextByRun: Readonly<Record<string, string>>;
  readonly activeTools: readonly RuntimeActiveToolProjection[];
  readonly todo?: unknown;
  readonly pendingUserInputs: readonly RuntimePendingUserInputProjection[];
  readonly managedTasks: readonly RuntimeManagedTaskProjection[];
}

export interface RuntimeSessionObservationSnapshot {
  readonly runtimeId: string;
  readonly cursor: number;
  /** Content-derived token for the transcript captured at this observation boundary. */
  readonly transcriptRevision: string;
  readonly session: RuntimeSession;
  readonly transcript: RuntimeTranscriptSlice | null;
  readonly settings: RuntimeVersionedValue<RuntimeSessionSettings>;
  readonly runs: readonly RuntimeRunStatus[];
  readonly pendingPermissions: readonly RuntimePermissionRequest[];
  readonly live: RuntimeSessionLiveProjection;
}

export interface RuntimeSessionObservation extends RuntimeSubscription {
  readonly snapshot: RuntimeSessionObservationSnapshot;
  readonly invalidated: Promise<RuntimeObservationInvalidation>;
}

export interface RuntimeObservationInvalidation {
  readonly code: "observation_invalidated";
  readonly reason:
    | "event_overflow"
    | "event_order"
    | "delivery_failed"
    | "runtime_changed"
    | "transport_disconnected";
  readonly runtimeId: string;
  readonly message: string;
}

export interface RuntimeSessionService {
  create(input?: RuntimeCreateSessionInput): Promise<RuntimeSession>;
  load(
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeSession>;
  list(
    filter?: RuntimeSessionFilter,
  ): Promise<readonly RuntimeSessionSummary[]>;
  status(sessionId: string): Promise<RuntimeSessionStatus>;
  transcript(
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeTranscript | null>;
  transcriptPage(
    input: RuntimeTranscriptPageInput,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeTranscriptSlice | null>;
  transcriptEntryChunk(
    input: RuntimeTranscriptEntryChunkInput,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeTranscriptEntryChunk | null>;
  transcriptSearch(
    input: RuntimeTranscriptSearchInput,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeTranscriptSearchResult | null>;
  conversation(
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeConversationHistory | null>;
  conversationPage(
    input: RuntimeConversationHistoryPageInput,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeConversationHistorySlice | null>;
  conversationEntryChunk(
    input: RuntimeConversationHistoryEntryChunkInput,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeConversationHistoryEntryChunk | null>;
  observe(
    sessionId: string,
    listener: RuntimeEventListener,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeSessionObservation>;
  /**
   * Captures a bounded, read-only diagnostic boundary without recovering,
   * taking over, or otherwise mutating Session or Run state.
   */
  diagnostics(
    input: RuntimeSessionDiagnosticsInput,
  ): Promise<RuntimeSessionDiagnostics>;
  fork(input: RuntimeForkSessionInput): Promise<RuntimeSession | null>;
  getSettings(sessionId: string): Promise<RuntimeSessionSettings>;
  getSettingsVersioned(
    sessionId: string,
  ): Promise<RuntimeVersionedValue<RuntimeSessionSettings>>;
  /** Runtime-owned Auto classifier state used by diagnostics and status UI. */
  getAutoModeStats(sessionId: string): Promise<AutoModeStats | undefined>;
  updateSettings(
    sessionId: string,
    patch: RuntimeSessionSettingsPatch,
  ): Promise<RuntimeSessionSettings>;
  updateSettingsVersioned(
    sessionId: string,
    patch: RuntimeSessionSettingsPatch,
    options: RuntimeVersionedUpdateOptions,
  ): Promise<RuntimeVersionedValue<RuntimeSessionSettings>>;
  appendNotice(
    input: RuntimeAppendNoticeInput,
  ): Promise<SessionTranscriptEntry | null>;
  rewind(input: RuntimeRewindSessionInput): Promise<RuntimeSession | null>;
  setActiveEntry(
    input: RuntimeSetActiveEntryInput,
  ): Promise<RuntimeSession | null>;
  compact(
    input: RuntimeCompactSessionInput,
  ): Promise<RuntimeCompactSessionResult>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type RuntimeRunPhase =
  | "queued"
  | "running"
  | "waiting_agent"
  | "recovering"
  | "waiting_permission"
  | "waiting_user_input"
  | "unknown"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RuntimeRunStage =
  | "queued"
  | "executing"
  | "waiting_agent"
  | "recovering"
  | "finalizing"
  | "terminal"
  | "unknown"
  | "starting"
  | "routing"
  | "preflight"
  | "round"
  | "worker"
  | "upgrade"
  | "verifying";

export interface RuntimeSessionStatus {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly phase: "idle" | RuntimeRunPhase;
  readonly observedAt: string;
  readonly runId?: string;
}

export type RuntimeRunMode = "coding" | "managed_task";

export interface RuntimeTextInput {
  readonly type: "text";
  readonly text: string;
}

export interface RuntimeImageInput {
  readonly type: "image";
  readonly path: string;
  readonly mediaType?: KodaXImageInputArtifact["mediaType"];
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeFileInput {
  readonly type: "file";
  readonly path: string;
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeVideoInput {
  readonly type: "video";
  readonly path: string;
  readonly mediaType: KodaXVideoInputArtifact["mediaType"];
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface RuntimeArtifactRefInput {
  readonly type: "artifact_ref";
  readonly artifactId: string;
  readonly description?: string;
}

export type RuntimeInput =
  | RuntimeTextInput
  | RuntimeImageInput
  | RuntimeFileInput
  | RuntimeVideoInput
  | RuntimeArtifactRefInput;

export type RuntimePermissionBroker = "runtime" | "client";

export interface RuntimeStartRunInput {
  readonly sessionId: string;
  readonly prompt?: string;
  readonly input?: RuntimeInput | readonly RuntimeInput[];
  readonly mode?: RuntimeRunMode;
  readonly permissionBroker?: RuntimePermissionBroker;
  readonly options?: RuntimeKodaXOptions;
  /** Host-derived dispatch identity; never accepted from an LLM tool payload. */
  readonly agentContext?: AgentDispatchContext;
  /** Daemon-issued lease binding; contains no credential material. */
  readonly credential?: { readonly leaseId: string; readonly provider: string };
  /** Daemon-issued host capability binding. Unbound runs never inherit it. */
  readonly hostTools?: { readonly leaseId: string };
  readonly operation?: RuntimeOperationOptions;
}

interface RuntimeTrustedStartRunInput extends RuntimeStartRunInput {
  readonly providerCredential?: string;
  readonly providerCredentialProvider?: string;
  readonly origin?: RuntimeRunStatus["origin"];
  readonly trustedRunId?: string;
  readonly requiredAfterRunId?: string;
}

export interface RuntimeSubmitInput {
  readonly sessionId: string;
  readonly afterRunId: string;
  readonly delivery: "after_turn" | "interrupt";
  readonly input: RuntimeInput | readonly RuntimeInput[];
  /** Continuations receive only bindings explicitly supplied for this input. */
  readonly credential?: { readonly leaseId: string; readonly provider: string };
  readonly hostTools?: { readonly leaseId: string };
  readonly operation?: RuntimeOperationOptions;
}

interface RuntimeTrustedSubmitInput extends RuntimeSubmitInput {
  readonly providerCredential?: string;
  readonly providerCredentialProvider?: string;
  readonly origin?: RuntimeRunStatus["origin"];
  readonly trustedRunId?: string;
  readonly trustedInputId?: string;
  readonly options?: RuntimeKodaXOptions;
}

export type RuntimeSubmitInputResult =
  | {
      readonly accepted: true;
      readonly delivery: "after_turn";
      readonly runId: string;
      readonly sessionId: string;
      readonly afterRunId: string;
      readonly sessionOrder: number;
    }
  | {
      readonly accepted: true;
      readonly delivery: "interrupt";
      readonly inputId: string;
      /** The existing active Run that owns this input; no new Run is created. */
      readonly runId: string;
      readonly sessionId: string;
      readonly afterRunId: string;
      readonly sessionOrder: number;
    }
  | {
      readonly accepted: false;
      readonly delivery: "after_turn" | "interrupt";
      readonly sessionId: string;
      readonly afterRunId: string;
      readonly reason:
        "stale_run" | "unsupported_capability" | "interrupt_window_closed";
    };

export interface RuntimeOperationOptions {
  readonly operationId?: string;
  readonly journalEpoch?: string;
  readonly expectedRevision?: number;
}

export type RuntimeKodaXOptions = Omit<
  KodaXOptions,
  "provider" | "session" | "events"
> & {
  readonly provider?: string;
  readonly session?: KodaXOptions["session"];
  readonly events?: KodaXEvents;
};

export type RuntimeDaemonContextOptions = Pick<
  KodaXContextOptions,
  | "gitRoot"
  | "executionCwd"
  | "shellExecution"
  | "contextTokenSnapshot"
  | "projectSnapshot"
  | "longRunning"
  | "providerPolicyHints"
  | "repoRoutingSignals"
  | "repoIntelligenceMode"
  | "repoIntelligenceTrace"
  | "contextDiagnostics"
  | "disableAutoTaskReroute"
  | "toolConstructionMode"
  | "skillsPrompt"
  | "rawUserInput"
  | "skillInvocation"
  | "repoIntelligenceContext"
  | "inputArtifacts"
  | "promptOverlay"
  | "taskSurface"
  | "liveTurn"
  | "managedTaskWorkspaceDir"
  | "managedProtocolEmission"
  | "excludeTools"
  | "systemPromptOverride"
  | "taskMetadata"
  | "taskVerification"
  | "agentProfile"
  | "currentAgentId"
  | "parentAgentId"
>;

export type RuntimeDaemonKodaXOptions = Pick<
  RuntimeKodaXOptions,
  | "provider"
  | "model"
  | "modelOverride"
  | "effort"
  | "thinking"
  | "reasoningMode"
  | "agentMode"
  | "maxIter"
  | "workflowHostPolicy"
  | "workflowRunsBaseDir"
  | "modelTiers"
  | "maxOutputTokens"
  | "disablePromptCache"
  | "lsp"
  | "workflow"
  | "selfManual"
  | "compaction"
  | "timeouts"
  | "sandbox"
> & {
  readonly context?: RuntimeDaemonContextOptions;
};

export type RuntimeDaemonStartRunInput = Omit<
  RuntimeStartRunInput,
  "options" | "agentContext" | "permissionBroker"
> & {
  readonly options?: RuntimeDaemonKodaXOptions;
};

export interface RuntimeDaemonRunService extends Omit<
  RuntimeRunService,
  "start"
> {
  start(input: RuntimeDaemonStartRunInput): Promise<RuntimeRunHandle>;
}

export type KodaXDaemonRuntime = Omit<KodaXRuntime, "runs"> & {
  readonly runs: RuntimeDaemonRunService;
  readonly daemon: RuntimeDaemonManagementService;
};

export interface RuntimeRunStatus {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly phase: RuntimeRunPhase;
  /** Fine-grained executor stage within the coarse lifecycle phase. */
  readonly stage?: RuntimeRunStage;
  readonly stageChangedAt?: string;
  /** Present only when the managed executor reported an authoritative count. */
  readonly activeSubtaskCount?: number;
  readonly startedAt: string;
  /** Durable acceptance timestamp; equals startedAt for protocol v1. */
  readonly acceptedAt?: string;
  readonly sessionOrder?: number;
  readonly queuedAt?: string;
  readonly runningAt?: string;
  readonly executionStartedAt?: string;
  readonly endedAt?: string;
  readonly provider: string;
  readonly mode?: RuntimeRunMode;
  readonly origin?: {
    readonly principalId: string;
    readonly clientName?: string;
    readonly clientVersion?: string;
    readonly operationId?: string;
  };
  readonly model?: string;
  readonly reasoning?: KodaXReasoningMode;
  readonly error?: string;
  readonly lifecycleError?: RuntimeRunLifecycleError;
  readonly terminal?: RuntimeTerminalFact;
  readonly continuation?: RuntimeContinuationStatus;
  readonly interruptInputs?: readonly RuntimeInterruptInputStatus[];
  /** Durable Stop request/result; distinct from chat interruptInputs. */
  readonly stop?: RuntimeRunStopStatus;
  readonly requirements?: RuntimeRunRequirements;
}

export interface RuntimeRunLifecycleError {
  readonly code:
    | "actor_settlement_retrying"
    | "actor_settlement_not_persisted";
  readonly message: string;
  readonly retryable: boolean;
}

export interface RuntimeRunRequirements {
  readonly credential?: {
    readonly leaseId: string;
    readonly provider: string;
    readonly state: "ready" | "expired" | "terminal";
  };
  readonly hostTools?: {
    readonly leaseId: string;
    readonly state: "ready" | "waiting_host" | "expired" | "terminal";
  };
}

export interface RuntimeContinuationStatus {
  readonly inputId: string;
  readonly afterRunId: string;
  readonly delivery: "after_turn";
  readonly state: "queued" | "delivered" | "terminal";
  readonly contentPreview: string;
}

export interface RuntimeInterruptInputStatus {
  readonly inputId: string;
  readonly afterRunId: string;
  readonly delivery: "interrupt";
  readonly state: "queued" | "delivered" | "terminal";
  readonly contentPreview: string;
  readonly queuedAt: string;
  readonly deliveredAt?: string;
  /** Canonical user-entry reference; absent before delivery or in legacy records. */
  readonly entryId?: string;
  readonly origin?: RuntimeRunStatus["origin"];
}

export interface RuntimeRunStopStatus {
  readonly requestedAt: string;
  readonly state: "unknown" | "confirmed";
  readonly outcome:
    | "unknown"
    | "cancelled"
    | "interrupted"
    | "completed"
    | "failed";
  readonly reason: string;
  readonly resolvedAt?: string;
}

export interface RuntimeRunStopReceipt {
  readonly runId: string;
  readonly sessionId: string;
  /** True only when this invocation durably created the Stop request. */
  readonly accepted: boolean;
  readonly state: RuntimeRunStopStatus["state"];
  readonly outcome: RuntimeRunStopStatus["outcome"];
  readonly phase: RuntimeRunPhase;
  /** Durable Run control-record revision observed by this receipt. */
  readonly revision: number;
}

export type RuntimeTerminalCode =
  | "completed"
  | "run_failed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "runtime_restarted"
  | "daemon_crashed"
  | "credential_unavailable"
  | "host_not_dispatched"
  | "host_outcome_unknown"
  | "control_history_untrusted";

export interface RuntimeTerminalFact {
  readonly revision: number;
  readonly kind: "completed" | "failed" | "cancelled" | "interrupted";
  readonly code: RuntimeTerminalCode;
  readonly effectOutcome: "none" | "known" | "unknown";
  readonly message?: string;
}

export interface RuntimeRunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: RuntimeRunPhase;
  readonly result?: KodaXResult;
  readonly error?: Error;
  readonly terminal?: RuntimeTerminalFact;
  readonly stop?: RuntimeRunStopStatus;
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
  submitInput(input: RuntimeSubmitInput): Promise<RuntimeSubmitInputResult>;
  await(runId: string): Promise<RuntimeRunResult>;
  get(runId: string): Promise<RuntimeRunStatus>;
  list(filter?: RuntimeRunFilter): Promise<readonly RuntimeRunStatus[]>;
  abort(runId: string): Promise<RuntimeRunStopReceipt>;
  setModel(runId: string, model: string | undefined): Promise<void>;
  setProvider(runId: string, provider: string): Promise<void>;
  setReasoning(
    runId: string,
    reasoning: KodaXReasoningMode | undefined,
  ): Promise<void>;
}

export type RuntimeEventType =
  | "session.created"
  | "session.loaded"
  | "session.settings.updated"
  | "session.notice.appended"
  | "session.rewound"
  | "session.active_entry.updated"
  | "session.compacted"
  | "run.queued"
  | "run.started"
  | "run.updated"
  | "run.progress"
  | "run.input.queued"
  | "run.input.delivered"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "assistant.delta"
  | "thinking.delta"
  | "thinking.finished"
  | "tool.started"
  | "tool.progress"
  | "tool.sandbox"
  | "tool.finished"
  | "user_input.requested"
  | "user_input.resolved"
  | "permission.requested"
  | "permission.resolved"
  | "permission.grant.changed"
  | "workflow.started"
  | "workflow.updated"
  | "workflow.finished"
  | "context.compaction.started"
  | "context.compaction.stats"
  | "context.compaction.finished"
  | "context.compaction.messages"
  | "context.compaction.ended"
  | "context.compaction.skipped"
  | "context.budget.snapshot"
  | "tool.exposure.planned"
  | "child_activity.finished"
  | "provider.retry"
  | "provider.recovery"
  | "provider.cache.diagnostics"
  | "repo_intelligence.trace"
  | "todo.updated"
  | "todo.warning"
  | "sidecar.message"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "artifact.created"
  | "config.effective"
  | "runtime.warning";

export interface RuntimeTextDeltaEventPayload {
  readonly text: string;
  readonly meta?: KodaXActivityEventMeta;
}

export interface RuntimeThinkingFinishedEventPayload {
  readonly thinking: string;
  readonly meta?: KodaXActivityEventMeta;
}

export interface RuntimeToolStartedEventPayload {
  readonly tool: {
    readonly name: string;
    readonly id: string;
    readonly input?: Readonly<Record<string, unknown>>;
  };
  readonly meta?: KodaXToolEventMeta;
}

export type RuntimeToolProgressEventPayload =
  | {
      readonly update: { readonly id: string; readonly message: string };
      readonly meta?: KodaXToolEventMeta;
    }
  | {
      readonly toolName: string;
      readonly partialJson: string;
      readonly meta?: KodaXToolEventMeta;
    };

export interface RuntimeToolSandboxEventPayload {
  readonly update: KodaXToolSandboxObservationUpdate;
  readonly meta?: KodaXToolEventMeta;
}

export interface RuntimeToolFinishedEventPayload {
  readonly result: {
    readonly id: string;
    readonly name: string;
    readonly content: string;
  };
  readonly meta?: KodaXToolEventMeta;
}

export type RuntimeRunProgressEventPayload =
  | {
      readonly kind: "managed_task_status";
      readonly status: KodaXManagedTaskStatusEvent;
    }
  | {
      readonly kind: "stream_end" | "complete";
      readonly meta?: KodaXActivityEventMeta;
    }
  | {
      readonly kind: "iteration_start";
      readonly iter: number;
      readonly maxIter: number;
      readonly meta?: KodaXActivityEventMeta;
    }
  | {
      readonly kind: "iteration_end";
      readonly info: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "mid_turn_user_messages";
      readonly contents: readonly string[];
      readonly meta?: KodaXActivityEventMeta;
    };

export interface RuntimeTodoUpdatedEventPayload {
  readonly items: readonly unknown[];
  readonly meta?: KodaXActivityEventMeta;
}

export interface RuntimeRunInputQueuedEventPayload {
  readonly input: RuntimeInterruptInputStatus;
}

export interface RuntimeDeliveredInterruptInput {
  readonly inputId: string;
  readonly afterRunId: string;
  readonly input: RuntimeInput | readonly RuntimeInput[];
  readonly queuedAt: string;
  readonly deliveredAt: string;
  /**
   * Canonical user-entry reference created by durable input persistence.
   * Optional only because legacy persisted events may not contain it.
   */
  readonly entryId?: string;
  readonly origin?: RuntimeRunStatus["origin"];
}

export interface RuntimeRunInputDeliveredEventPayload {
  readonly inputs: readonly RuntimeDeliveredInterruptInput[];
}

export interface RuntimeInteractionResolvedEventPayload {
  readonly requestId: string;
  readonly status?: string;
  readonly decision?: RuntimePermissionDecision;
  readonly kind?: RuntimeUserInputKind;
}

export interface RuntimePermissionGrantChangedEventPayload {
  readonly action: "created" | "revoked" | "expired";
  readonly grant: RuntimePermissionGrant;
  readonly revision: number;
}

export interface RuntimeWarningEventPayload {
  readonly message: string;
  readonly source?: string;
  readonly severity?: string;
  readonly sourceEventId?: string;
}

export type RuntimeContextCompactionFinishedEventPayload =
  KodaXContextCompactionFinishedEvent &
    KodaXContextIdentity & {
      readonly beforeRevision: number;
      readonly afterRevision: number;
      readonly reason?: string;
    };

export interface RuntimeContextCompactionMessagesEventPayload {
  readonly messageCount: number;
  readonly update?: {
    readonly hasAnchor: boolean;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly entriesRemoved?: number;
    readonly reason?: string;
    readonly artifactLedgerEntryCount: number;
    readonly postCompactAttachmentCount: number;
    readonly exactSnapshotAvailable: boolean;
  };
  readonly meta?: KodaXActivityEventMeta;
}

export interface RuntimeSessionSettingsUpdatedEventPayload {
  readonly sessionId: string;
  readonly revision: number;
  readonly settings: RuntimeSessionSettings;
  readonly patch: RuntimeSessionSettingsPatch;
}

export type RuntimeUserInputRequestedEventPayload =
  | RuntimeUserInputRequest
  | {
      readonly requestId: string;
      readonly kind: RuntimeUserInputKind;
      readonly options: unknown;
    };

type RuntimeEventPayloadDefaults = {
  readonly [K in RuntimeEventType]: unknown;
};

export type RuntimeEventPayloadMap = Omit<
  RuntimeEventPayloadDefaults,
  | "session.created"
  | "session.loaded"
  | "run.queued"
  | "run.started"
  | "run.updated"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "assistant.delta"
  | "thinking.delta"
  | "thinking.finished"
  | "tool.started"
  | "tool.progress"
  | "tool.sandbox"
  | "tool.finished"
  | "run.progress"
  | "run.input.queued"
  | "run.input.delivered"
  | "todo.updated"
  | "user_input.requested"
  | "user_input.resolved"
  | "permission.requested"
  | "permission.resolved"
  | "permission.grant.changed"
  | "session.settings.updated"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "workflow.started"
  | "workflow.updated"
  | "workflow.finished"
  | "context.budget.snapshot"
  | "provider.cache.diagnostics"
  | "tool.exposure.planned"
  | "context.compaction.messages"
  | "context.compaction.finished"
  | "runtime.warning"
> & {
  readonly "session.created": RuntimeSession;
  readonly "session.loaded": RuntimeSessionLoadedEventPayload;
  readonly "run.queued": RuntimeRunStatus;
  readonly "run.started": RuntimeRunStatus;
  readonly "run.updated": RuntimeRunStatus;
  readonly "run.completed": RuntimeRunStatus;
  readonly "run.failed": RuntimeRunStatus;
  readonly "run.cancelled": RuntimeRunStatus;
  readonly "run.interrupted": RuntimeRunStatus;
  readonly "assistant.delta": RuntimeTextDeltaEventPayload;
  readonly "thinking.delta": RuntimeTextDeltaEventPayload;
  readonly "thinking.finished": RuntimeThinkingFinishedEventPayload;
  readonly "tool.started": RuntimeToolStartedEventPayload;
  readonly "tool.progress": RuntimeToolProgressEventPayload;
  readonly "tool.sandbox": RuntimeToolSandboxEventPayload;
  readonly "tool.finished": RuntimeToolFinishedEventPayload;
  readonly "run.progress": RuntimeRunProgressEventPayload;
  readonly "run.input.queued": RuntimeRunInputQueuedEventPayload;
  readonly "run.input.delivered": RuntimeRunInputDeliveredEventPayload;
  readonly "todo.updated": RuntimeTodoUpdatedEventPayload;
  readonly "user_input.requested": RuntimeUserInputRequestedEventPayload;
  readonly "user_input.resolved": RuntimeInteractionResolvedEventPayload;
  readonly "permission.requested": RuntimePermissionRequest;
  readonly "permission.resolved": RuntimeInteractionResolvedEventPayload;
  readonly "permission.grant.changed": RuntimePermissionGrantChangedEventPayload;
  readonly "session.settings.updated": RuntimeSessionSettingsUpdatedEventPayload;
  readonly "turn.started": KodaXTurnStartedEvent;
  readonly "turn.completed": KodaXTurnCompletedEvent;
  readonly "turn.failed": KodaXTurnFailedEvent;
  readonly "workflow.started": WorkflowProcessEvent;
  readonly "workflow.updated": WorkflowProcessEvent;
  readonly "workflow.finished": WorkflowProcessEvent;
  readonly "context.budget.snapshot": RuntimeContextBudgetSnapshot;
  readonly "provider.cache.diagnostics": KodaXPromptCacheDiagnosticEvent;
  readonly "tool.exposure.planned": RuntimeToolExposurePlan;
  readonly "context.compaction.messages": RuntimeContextCompactionMessagesEventPayload;
  readonly "context.compaction.finished": RuntimeContextCompactionFinishedEventPayload;
  readonly "runtime.warning": RuntimeWarningEventPayload;
};

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

export type RuntimeTypedEvent<
  TType extends RuntimeEventType = RuntimeEventType,
> = {
  readonly [K in TType]: RuntimeEventEnvelope<RuntimeEventPayloadMap[K]> & {
    readonly type: K;
  };
}[TType];

/** Backward-compatible raw envelope; use parseRuntimeEvent for payload narrowing. */
export type RuntimeEvent = RuntimeEventEnvelope;

export type RuntimeEventParseResult =
  | { readonly ok: true; readonly event: RuntimeTypedEvent }
  | { readonly ok: false; readonly error: string };

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
export type RuntimeTypedEventListener = (event: RuntimeTypedEvent) => void;

export interface RuntimeSubscription {
  /** Resolves when a remote subscription handshake is complete; absent for synchronous local subscriptions. */
  readonly ready?: Promise<void>;
  close(): void;
}

export interface RuntimeEventService {
  subscribe(
    filter: RuntimeEventFilter,
    listener: RuntimeEventListener,
  ): RuntimeSubscription;
  replay(filter?: RuntimeEventReplayFilter): Promise<readonly RuntimeEvent[]>;
}

export type RuntimePermissionRisk = "low" | "medium" | "high";

export interface RuntimePermissionScope {
  readonly toolName?: string;
  readonly sessionId?: string;
  /** Runtime-generated concrete matcher. Absent only on legacy 0.7.x grants. */
  readonly matcher?: RuntimePermissionMatcher;
}

export interface RuntimePermissionGrantSuggestion {
  /** Opaque pending-request-local identifier; clients must return it unchanged. */
  readonly id: string;
  readonly kind: "session" | "persistent";
  readonly label: string;
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
  /** Effective directory used to resolve relative tool paths for this run. */
  readonly executionCwd?: string;
  /** Structured Auto[LLM] decision metadata; never includes prompt or response text. */
  readonly autoModeDiagnostics?: AutoModeDecisionDiagnostics;
  readonly grantSuggestions?: readonly RuntimePermissionGrantSuggestion[];
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
  readonly executionCwd?: string;
  /** Structured Auto[LLM] decision metadata; never includes prompt or response text. */
  readonly autoModeDiagnostics?: AutoModeDecisionDiagnostics;
  readonly expiresAt?: string;
  readonly timeoutMs?: number;
  /**
   * Concrete JSON tool input used by the Runtime to derive an opaque grant
   * candidate. It is neither emitted on Runtime events nor persisted.
   */
  readonly toolInput?: Readonly<Record<string, unknown>>;
}

export type RuntimePermissionDecision =
  | { readonly type: "allow_once" }
  | { readonly type: "allow_session"; readonly suggestionId: string }
  | { readonly type: "allow_always"; readonly suggestionId: string }
  /**
   * @deprecated v2 compatibility input. The Runtime maps this selection to
   * its narrower concrete candidate and never persists the supplied scope.
   */
  | { readonly type: "allow_always"; readonly scope: RuntimePermissionScope }
  | {
      readonly type: "reject";
      readonly reason?: string;
      readonly cause?: "approval_timeout";
    };

export interface RuntimePermissionFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolName?: string;
}

export interface RuntimePermissionRespondOptions {
  readonly runId?: string;
}

export interface RuntimePermissionGrant {
  readonly id: string;
  readonly scope: RuntimePermissionScope;
  readonly createdAt: string;
  readonly persistence?: "session" | "persistent";
  readonly label?: string;
  readonly sourcePermissionId?: string;
}

export interface RuntimePermissionService {
  request(
    input: RuntimePermissionRequestInput,
  ): Promise<RuntimePermissionDecision>;
  listPending(
    filter?: RuntimePermissionFilter,
  ): Promise<readonly RuntimePermissionRequest[]>;
  respond(
    requestId: string,
    decision: RuntimePermissionDecision,
    options?: RuntimePermissionRespondOptions,
  ): Promise<boolean>;
  listGrants(): Promise<
    RuntimeVersionedValue<readonly RuntimePermissionGrant[]>
  >;
  revokeGrant(grantId: string, expectedRevision: number): Promise<boolean>;
}

export type RuntimeUserInputKind = "askUser" | "askUserMulti" | "askUserInput";

export interface RuntimeUserInputRequest {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly kind: RuntimeUserInputKind;
  readonly options: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RuntimeUserInputFilter {
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface RuntimeUserInputResolution {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly status: "answered" | "dismissed" | "already_resolved";
}

export interface RuntimeUserInputService {
  listPending(
    filter?: RuntimeUserInputFilter,
  ): Promise<readonly RuntimeUserInputRequest[]>;
  respond(
    requestId: string,
    answer: unknown,
    options?: { readonly expectedRevision?: number; readonly runId?: string },
  ): Promise<RuntimeUserInputResolution>;
  dismiss(
    requestId: string,
    options?: { readonly expectedRevision?: number; readonly runId?: string },
  ): Promise<RuntimeUserInputResolution>;
}

export interface RuntimeCredentialRequest {
  readonly leaseId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly runId: string;
}

export type RuntimeCredentialBroker = (
  request: RuntimeCredentialRequest,
) => Promise<string | undefined>;

export interface RuntimeCredentialLease {
  readonly id: string;
  readonly providers: readonly string[];
  readonly expiresAt?: string;
}

export interface RuntimeCredentialService {
  register(
    input: {
      readonly providers: readonly string[];
      readonly expiresAt?: string;
    },
    broker: RuntimeCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  resume(
    leaseId: string,
    broker: RuntimeCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  revoke(leaseId: string): Promise<boolean>;
}

export interface RuntimeHostToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly sideEffect: "none" | "idempotent" | "non_idempotent";
}

export interface RuntimeHostToolInvocation {
  readonly invocationId: string;
  readonly leaseId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RuntimeHostToolResult {
  readonly content: string;
  readonly structuredContent?: unknown;
}

export type RuntimeHostToolHandler = (
  invocation: RuntimeHostToolInvocation,
) => Promise<RuntimeHostToolResult>;

export interface RuntimeHostToolLease {
  readonly id: string;
  readonly tools: readonly RuntimeHostToolDescriptor[];
}

export interface RuntimeHostToolInvocationStatus {
  readonly invocationId: string;
  readonly leaseId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly state:
    "prepared" | "dispatched" | "completed" | "unknown" | "not_dispatched";
  readonly updatedAt: string;
}

export interface RuntimeHostToolService {
  register(
    tools: readonly RuntimeHostToolDescriptor[],
    handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
  ): Promise<RuntimeHostToolLease>;
  resume(
    leaseId: string,
    handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
  ): Promise<RuntimeHostToolLease>;
  getInvocation(
    invocationId: string,
  ): Promise<RuntimeHostToolInvocationStatus | undefined>;
  revoke(leaseId: string): Promise<boolean>;
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
  list(
    filter?: RuntimeWorkflowFilter,
  ): Promise<readonly RuntimeWorkflowSummary[]>;
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

export interface RuntimeDaemonPreflight {
  readonly runtimeId: string;
  readonly clientCount: number;
  readonly activeRuns: readonly RuntimeRunStatus[];
  readonly queuedRuns: readonly RuntimeRunStatus[];
  readonly activeWorkflows: readonly RuntimeWorkflowSummary[];
  readonly activeAgentTurns: readonly RuntimeActiveAgentTurn[];
  /** @deprecated Use activeAgentTurns. Alias retained through the 0.7.x line. */
  readonly activeAgentTasks: readonly RuntimeActiveAgentTurn[];
  readonly pendingPermissions: readonly RuntimePermissionRequest[];
  readonly pendingUserInputs: readonly RuntimeUserInputRequest[];
  readonly blockers: readonly (
    | "connected_clients"
    | "active_runs"
    | "queued_runs"
    | "active_workflows"
    | "active_agent_turns"
    | "active_agent_tasks"
    | "pending_interactions"
  )[];
  readonly canStop: boolean;
}

export interface RuntimeActiveAgentTurn {
  readonly sessionId: string;
  readonly actorPath: string;
  readonly turnId: string;
  readonly kind: AgentExecutionKind;
}

export interface RuntimeIntegrationDiagnostic {
  readonly code: "invalid-config" | "activation-failed" | "watcher-degraded";
  readonly message: string;
  readonly time: string;
}

export interface RuntimeIntegrationDomainStatus {
  readonly domain: "mcp" | "a2a" | "extensions";
  readonly path: string;
  readonly revision?: string;
  readonly source?: "user" | "legacy-user" | "default";
  readonly lastReloadAt?: string;
  readonly diagnostic?: RuntimeIntegrationDiagnostic;
  readonly watching: boolean;
}

export interface RuntimeIntegrationHealth {
  readonly state: "healthy" | "degraded";
  readonly domains: readonly RuntimeIntegrationDomainStatus[];
}

export interface RuntimeDaemonManagementState {
  readonly runtimeId: string;
  /** Monotonic for logical client, mutation, Runtime event, and preflight state changes. */
  readonly revision: number;
  readonly ownerPolicy: RuntimeOwnerPolicyState;
  readonly owner: RuntimeOwnerIdentity;
  readonly preflight: RuntimeDaemonPreflight;
  /** Optional integrations never make the core daemon unavailable. */
  readonly integrations?: RuntimeIntegrationHealth;
}

export interface RuntimeDaemonRollbackInput {
  readonly expectedRuntimeId: string;
  readonly expectedRevision: number;
  readonly expectedOwnerPolicyRevision: number;
  readonly operation?: RuntimeOperationOptions;
}

export interface RuntimeDaemonRollbackResult {
  readonly accepted: true;
  readonly runtimeId: string;
  readonly revision: number;
  readonly ownerPolicy: RuntimeOwnerPolicyState & { readonly mode: "inline" };
}

export interface RuntimeDaemonManagementService {
  inspect(): Promise<RuntimeDaemonManagementState>;
  stopForInline(
    input: RuntimeDaemonRollbackInput,
  ): Promise<RuntimeDaemonRollbackResult>;
}

export interface RuntimeStatusService {
  snapshot(): Promise<RuntimeStatusSnapshot>;
  preflight(): Promise<RuntimeDaemonPreflight>;
}

/**
 * Capture one read-only, boundary-labelled diagnostic record without taking
 * ownership of, resuming, or otherwise mutating the Session.
 */
export async function captureRuntimeSessionDiagnostics(
  runtime: KodaXRuntime,
  input: RuntimeSessionDiagnosticsInput,
): Promise<RuntimeSessionDiagnostics> {
  return runtime.sessions.diagnostics(input);
}

interface RuntimeSessionDiagnosticBoundary {
  readonly runtimeId: string;
  readonly cursor: number;
  readonly transcriptRevision: string;
  readonly runs: readonly RuntimeRunStatus[];
}

function createRuntimeSessionDiagnosticsRecord(
  identity: RuntimeIdentity,
  input: RuntimeSessionDiagnosticsInput,
  boundary: RuntimeSessionDiagnosticBoundary,
  captureStartedAt: string,
): RuntimeSessionDiagnostics {
  const runs = boundary.runs.flatMap((value) => {
    const parsed = parseRuntimeRunStatus(value);
    return parsed === undefined ? [] : [parsed];
  });
  const run =
    input.runId === undefined
      ? authoritativeSessionRun(runs)
      : runs.find((candidate) => candidate.runId === input.runId);
  const activeSubtaskCount = run?.activeSubtaskCount ?? null;
  const errors: RuntimeSessionDiagnosticError[] = [];
  const addError = (
    code: RuntimeSessionDiagnosticErrorCode,
    message: string,
  ): void => {
    if (errors.some((error) => error.code === code)) return;
    errors.push({ code, message });
  };
  if (run === undefined) {
    addError(
      "run_control_unknown",
      input.runId === undefined
        ? "No Run control record is available at this Session boundary."
        : `Run control record is unavailable: ${input.runId}`,
    );
  } else if (run.phase === "unknown") {
    const code: RuntimeSessionDiagnosticErrorCode =
      run.error === "owner_liveness_unconfirmed"
        ? "owner_liveness_unconfirmed"
        : run.error === "owner_recovery_required"
          ? "owner_recovery_required"
          : run.error === "stop_outcome_unconfirmed"
            ? "stop_outcome_unconfirmed"
            : "run_status_unknown";
    addError(
      code,
      code === "owner_liveness_unconfirmed"
        ? "The prior Runtime owner could not be confirmed alive or dead."
        : code === "owner_recovery_required"
          ? "The prior Runtime owner is gone; explicit Run recovery is required."
          : code === "stop_outcome_unconfirmed"
            ? "A Stop was requested, but executor termination is not confirmed."
            : "The authoritative Run state could not be confirmed.",
    );
  }
  if (
    run?.stop?.state === "unknown"
    || run?.stop?.outcome === "unknown"
  ) {
    addError(
      "stop_outcome_unconfirmed",
      "A Stop was requested, but executor termination is not confirmed.",
    );
  }
  if (run?.lifecycleError !== undefined) {
    addError(run.lifecycleError.code, run.lifecycleError.message);
  }
  if (run?.phase === "failed") {
    addError(
      "run_failed",
      run.error ?? "The Run failed without a recorded error message.",
    );
  }
  if (
    run !== undefined
    && isTerminalRunPhase(run.phase)
    && run.endedAt === undefined
  ) {
    addError(
      "terminal_time_unknown",
      "The Run is terminal, but its terminal time was not recorded.",
    );
  }
  const activeSubtaskCountSource =
    run?.activeSubtaskCount === undefined ? "unknown" : "run_status";
  return {
    schemaVersion: 1,
    captureStartedAt,
    capturedAt: new Date().toISOString(),
    sdkVersion: replApi.KODAX_VERSION,
    runtimeVersion: identity.version,
    daemonVersion: identity.mode === "daemon" ? identity.version : null,
    runtimeId: boundary.runtimeId,
    runtimeMode: identity.mode,
    sessionId: input.sessionId,
    observation: {
      cursor: boundary.cursor,
      transcriptRevision: boundary.transcriptRevision,
    },
    run: run === undefined
      ? {
          controlRecord: "unknown",
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          state: "unknown",
          stage: "unknown",
          terminalTimeKnown: false,
          activeSubtaskCount,
          activeSubtaskCountSource,
          errors,
        }
      : {
          controlRecord: "present",
          runId: run.runId,
          ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
          state:
            run.phase === "queued"
              ? "queued"
              : run.phase === "unknown"
                ? "unknown"
                : isTerminalRunPhase(run.phase)
                  ? "terminal"
                  : "active",
          phase: run.phase,
          stage: run.stage ?? (
            isTerminalRunPhase(run.phase) ? "terminal" : "unknown"
          ),
          ...(run.stageChangedAt !== undefined
            ? { stageChangedAt: run.stageChangedAt }
            : {}),
          ...(run.endedAt !== undefined ? { terminalAt: run.endedAt } : {}),
          terminalTimeKnown:
            isTerminalRunPhase(run.phase) && run.endedAt !== undefined,
          ...(run.terminal !== undefined ? { terminal: run.terminal } : {}),
          activeSubtaskCount,
          activeSubtaskCountSource,
          ...(run.stop !== undefined ? { stop: run.stop } : {}),
          ...(run.interruptInputs !== undefined
            ? { interruptInputs: run.interruptInputs }
            : {}),
          errors,
        },
  };
}

interface RuntimeRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  turnId?: string;
  phase: RuntimeRunPhase;
  stage?: RuntimeRunStage;
  stageChangedAt?: string;
  activeSubtaskCount?: number;
  readonly startedAt: string;
  readonly sessionOrder: number;
  queuedAt?: string;
  runningAt?: string;
  endedAt?: string;
  provider: string;
  model?: string;
  permissionBroker?: RuntimePermissionBroker;
  permissionMode?: string;
  autoModeEngine?: RuntimeSessionSettings["autoModeEngine"];
  autoModeClassifierModel?: string;
  autoModeTimeoutMs?: number;
  autoModeSpeculativeWindowMs?: number;
  reasoning?: KodaXReasoningMode;
  error?: string;
  lifecycleError?: RuntimeRunLifecycleError;
  terminal?: RuntimeTerminalFact;
  readonly result: Promise<RuntimeRunResult>;
  running?: RunningSession;
  abortController?: AbortController;
  actorFinalizationAbortController?: AbortController;
  mode: RuntimeRunMode;
  readonly origin?: RuntimeRunStatus["origin"];
  readonly continuation?: Omit<RuntimeContinuationStatus, "state">;
  readonly interruptInputs: RuntimeInterruptInputRecord[];
  stop?: RuntimeRunStopStatus;
  providerCredential?: string;
  readonly hadProviderCredential: boolean;
  readonly agentContext?: AgentDispatchContext;
  readonly actorSession?: CodingActorSession;
  interruptInputOpen: boolean;
  releaseAbortSignalSubscription?: () => void;
  start?: PendingRunStart;
  executorTerminalSignal?: {
    readonly signal: "completed" | "failed";
    readonly error?: Error;
    readonly interruptedAtSignal: boolean;
  };
  actorHealthBaseState?: RuntimeActorHealthBaseRunState;
  settlementFinished?: boolean;
  terminalEmitted: boolean;
  readonly ownedByRuntime: boolean;
  readonly observedOwner?: AgentActorOwner;
}

interface RuntimeActorHealthBaseRunState {
  phase: RuntimeRunPhase;
  stage?: RuntimeRunStage;
  error?: string;
  lifecycleError?: RuntimeRunLifecycleError;
}

interface RuntimeInterruptInputRecord extends RuntimeInterruptInputStatus {
  state: RuntimeInterruptInputStatus["state"];
  deliveredAt?: string;
  entryId?: string;
  readonly input?: RuntimeInput | readonly RuntimeInput[];
  queueMessageId?: string;
}

interface PendingPermission {
  readonly request: RuntimePermissionRequest;
  readonly waiters: Array<(decision: RuntimePermissionDecision) => void>;
  readonly grantCandidates: readonly RuntimePermissionGrantCandidate[];
  readonly timer?: ReturnType<typeof setTimeout>;
}

interface RuntimePermissionGrantCandidate {
  readonly suggestion: RuntimePermissionGrantSuggestion;
  readonly scope: RuntimePermissionScope;
  readonly persistence: "session" | "persistent";
}

interface RuntimePermissionGrantContext {
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly projectRoot?: string;
  readonly signals?: readonly ToolCallSignal[];
  readonly shell?: RuntimeExactCommandPermissionMatcher["shell"];
  readonly shellContractFingerprint?: string;
}

interface PendingUserInput {
  readonly request: RuntimeUserInputRequest;
  readonly resolve: (resolution: RuntimePendingUserInputResolution) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RuntimePendingUserInputResolution {
  readonly status: "answered" | "dismissed";
  readonly answer?: unknown;
}

type RuntimeEventBus = ReturnType<typeof createRuntimeEventBus>;
type RuntimePermissionRegistry = ReturnType<
  typeof createRuntimePermissionRegistry
>;
type RuntimeUserInputRegistry = ReturnType<
  typeof createRuntimeUserInputRegistry
>;
type RuntimeArtifactStore = ReturnType<typeof createRuntimeArtifactStore>;

interface RuntimeRunServiceInternal extends RuntimeRunService {
  inspect(
    filter?: RuntimeRunFilter,
  ): Promise<readonly RuntimeRunStatus[]>;
  inspectOne(runId: string): Promise<RuntimeRunStatus | undefined>;
  closeAll(reason: string): void;
  releaseSession(sessionId: string): void;
  getAutoModeStats(sessionId: string): AutoModeStats | undefined;
}

interface PendingRunStart {
  readonly prompt: string;
  readonly inputArtifacts: readonly KodaXInputArtifact[];
  readonly options: RuntimeKodaXOptions;
  readonly resolve: (result: RuntimeRunResult) => void;
}

interface PersistedRuntimeRunStatus {
  readonly status: RuntimeRunStatus;
  readonly owner?: AgentActorOwner;
  readonly revision: number;
}

interface PersistedRuntimeRunStop {
  readonly accepted: boolean;
  readonly status: RuntimeRunStatus;
  readonly revision: number;
}

interface RuntimePathIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface RuntimePendingRunStatus {
  readonly runId: string;
  readonly identity: RuntimePathIdentity | null;
}

interface RuntimeRunStatusIndex {
  readonly version: 2;
  readonly activeRunIds: readonly string[];
  readonly recentRunIds: readonly string[];
  readonly runsDirectory: RuntimePathIdentity | null;
  readonly pendingRunStatuses: readonly RuntimePendingRunStatus[];
  readonly requiresRescan: boolean;
}

interface RuntimePersistence {
  readonly runtimeDir: string;
  commitEvents(
    count: number,
    create: (firstSeq: number) => readonly RuntimeEvent[],
  ): readonly RuntimeEvent[];
  close(): void;
  nextSessionOrder(sessionId: string): number;
  currentEventSeq(): number;
  replay(filter?: RuntimeEventReplayFilter): readonly RuntimeEvent[];
  saveRunStatus(status: RuntimeRunStatus): RuntimeRunStatus;
  requestRunStop(runId: string, reason: string): PersistedRuntimeRunStop;
  loadRunStatus(runId: string): PersistedRuntimeRunStatus | undefined;
  loadRunStatuses(): readonly PersistedRuntimeRunStatus[];
  loadSessionSettings(sessionId: string): RuntimeSessionSettings;
  saveSessionSettings(
    sessionId: string,
    settings: RuntimeSessionSettings,
  ): void;
  loadSessionSettingsVersioned(
    sessionId: string,
  ): RuntimeVersionedValue<RuntimeSessionSettings>;
  saveSessionSettingsVersioned(
    sessionId: string,
    settings: RuntimeVersionedValue<RuntimeSessionSettings>,
  ): void;
  loadPermissionGrants(): RuntimeVersionedValue<
    readonly RuntimePermissionGrant[]
  >;
  savePermissionGrants(
    grants: RuntimeVersionedValue<readonly RuntimePermissionGrant[]>,
  ): void;
}

interface RuntimeSessionAdmission {
  assertCreate(input: RuntimeCreateSessionInput): void;
  assertFilter(filter: RuntimeSessionFilter | undefined): void;
  admitsData(data: KodaXSessionData): boolean;
  admitsSummary(summary: SessionSummary): boolean;
  assertCachedIdentity(
    sessionId: string,
    identity: { readonly surface?: string; readonly profileId?: string },
  ): void;
  admitsSession(sessionId: string): Promise<boolean>;
  assertRunAccess(sessionId: string): Promise<void>;
  loadRequired(
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<KodaXSessionData>;
  captureRequired(
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<SessionReadCapture>;
  loadExecutable(sessionId: string): Promise<KodaXSessionData>;
}

interface RuntimeSessionOperationGate {
  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class RuntimeContinuationStaleError extends Error {
  constructor(readonly afterRunId: string) {
    super(`Runtime continuation target is already terminal: ${afterRunId}`);
    this.name = "RuntimeContinuationStaleError";
  }
}

class RuntimeEventCommitIndeterminateError extends Error {
  constructor(appendError: unknown, rollbackError: unknown) {
    super(
      "Runtime event batch commit is indeterminate; automatic retry is disabled",
      {
        cause: new AggregateError(
          [appendError, rollbackError],
          "Runtime event append and rollback both failed",
        ),
      },
    );
    this.name = "RuntimeEventCommitIndeterminateError";
  }

  includeLockCleanupFailure(cleanupError: unknown): void {
    Object.defineProperty(this, "cause", {
      configurable: true,
      value: new AggregateError(
        [this.cause, cleanupError],
        "Runtime event commit and status-lock cleanup both failed",
      ),
    });
  }
}

class RuntimeStatusLockCleanupError extends Error {
  constructor(readonly cleanupError: unknown) {
    super("Runtime status lock cleanup failed after the operation completed", {
      cause: cleanupError,
    });
    this.name = "RuntimeStatusLockCleanupError";
  }
}

class RuntimeStatusLockTimeoutError extends Error {
  constructor(readonly lockFile: string) {
    super(`Runtime status lock timed out: ${lockFile}`);
    this.name = "RuntimeStatusLockTimeoutError";
  }
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_RUNTIME_MEMORY_EVENTS = 10_000;
const MAX_RUNTIME_PENDING_EVENTS = 1_024;
const MAX_RUNTIME_PENDING_EVENT_BYTES = 1024 * 1024;
const MAX_RUNTIME_MEMORY_RUNS = 1_000;
const MAX_RUNTIME_RECENT_PERSISTED_RUNS = 200;
const MAX_RUNTIME_PENDING_RUN_STATUSES = 1_000;
const MAX_RUNTIME_RUN_STATUS_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_RUN_STATUS_INDEX_ID_BYTES = 512;
const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
const RUNTIME_EVENT_COALESCE_INTERVAL_MS = 50;
const MAX_RUNTIME_COALESCED_EVENT_BYTES = 8 * 1024;
const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;
const TARGET_RUNTIME_EVENT_FILE_BYTES = MAX_RUNTIME_EVENT_FILE_BYTES / 2;
const MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES = 128 * 1024;
const MAX_RUNTIME_SNAPSHOT_ATTEMPTS = 8;
const MAX_RUNTIME_OBSERVATION_HANDOFF_EVENTS = 256;
const MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES = 512 * 1024;
const MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES = 128 * 1024;
const MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_RUNTIME_TRANSCRIPT_PAGE_LIMIT = 50;
const MAX_RUNTIME_TRANSCRIPT_PAGE_LIMIT = 200;
const MAX_RUNTIME_TRANSCRIPT_SNAPSHOTS = 8;
const MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_FILES = 16;
const RUNTIME_TRANSCRIPT_SNAPSHOT_FILE_RESERVATION_BYTES = 4 * 1024;
const MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_WRITE_BATCH_ENTRIES = 256;
const MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_WRITE_BATCH_BYTES = 1024 * 1024;
const RUNTIME_TRANSCRIPT_SNAPSHOT_CLOSE_DRAIN_MS = 250;
const RUNTIME_TRANSCRIPT_SNAPSHOT_TTL_MS = 5 * 60_000;
const RUNTIME_TRANSCRIPT_SNAPSHOT_DIR_PREFIX =
  "kodax-transcript-snapshots-";
const RUNTIME_ACTOR_CANCELLATION_FINALIZATION_MS = 5_000;
const RUNTIME_ACTOR_FINALIZATION_MS = 30_000;
const RUNTIME_SESSION_CAPTURE_RETRY_DELAYS_MS = [5, 15] as const;
const RUNTIME_LEGACY_LINEAGE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function createDeterministicRuntimeLegacyLineage(
  sessionId: string,
  sourceRevision: string,
  messages: readonly KodaXMessage[],
): ReturnType<typeof createSessionLineage> {
  let parentId: string | null = null;
  const entries: ReturnType<typeof createSessionLineage>["entries"] = messages.map(
    (message, index) => {
      const identity = createHash("sha256")
        .update("kodax-runtime-legacy-lineage-v1\0")
        .update(`${sessionId}\0${sourceRevision}\0${index}:`)
        .update(JSON.stringify(message))
        .digest("hex")
        .slice(0, 12);
      const id = `entry_${identity}`;
      const entry = {
        type: "message" as const,
        id,
        parentId,
        logicalId: id,
        timestamp: message.timestamp ?? RUNTIME_LEGACY_LINEAGE_FALLBACK_TIMESTAMP,
        message: structuredClone(message),
      };
      parentId = id;
      return entry;
    },
  );
  return { version: 2, activeEntryId: parentId, entries };
}
const MAX_RUNTIME_INPUT_PREVIEW_LENGTH = 1_024;
const RUNTIME_PERMISSION_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_describe",
]);
const RUNTIME_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "image",
  "file",
  "video",
]);

function rebaseAgentConfigPath(filePath: string, configHome: string): string {
  const relative = path.relative(getAgentConfigHome(), filePath);
  return path.isAbsolute(relative) || relative.startsWith("..")
    ? filePath
    : path.join(configHome, relative);
}

export function createKodaXRuntime(
  options: CreateKodaXRuntimeOptions & { readonly mode: "daemon" },
): Promise<KodaXDaemonRuntime>;
export function createKodaXRuntime(
  options?: CreateKodaXRuntimeOptions,
): Promise<KodaXRuntime>;
export async function createKodaXRuntime(
  options: CreateKodaXRuntimeOptions = {},
): Promise<KodaXRuntime> {
  if (
    options.daemonHostRuntimeId !== undefined &&
    options.sharedDaemonHost !== true
  ) {
    throw new Error(
      "daemonHostRuntimeId is reserved for a claimed shared daemon owner.",
    );
  }
  if (
    options.daemonHostRuntimeId !== undefined &&
    !/^rt_[a-f0-9]{12}$/.test(options.daemonHostRuntimeId)
  ) {
    throw new Error("Invalid shared daemon Runtime owner identity.");
  }
  if (
    options.isolation !== undefined &&
    options.isolation !== "inline" &&
    options.isolation !== "worker"
  ) {
    throw new Error(
      `Unsupported KodaX Runtime isolation: ${String(options.isolation)}`,
    );
  }
  if (options.mode === "daemon") {
    if (options.isolation !== undefined) {
      throw new Error(
        "Daemon mode selects its isolation internally and does not accept an isolation option.",
      );
    }
    if (options.worker !== undefined) {
      throw new Error("Runtime Worker options require isolation: 'worker'.");
    }
    if (options.externalAgents !== undefined) {
      return createInProcessExternalAgentDaemon(options);
    }
    const autoStart =
      options.autoStartDaemon ??
      (options.daemonTransport === undefined &&
        options.daemonEndpoint === undefined);
    return connectKodaXRuntime({
      profile: options.profile,
      transport: options.daemonTransport,
      endpoint: options.daemonEndpoint,
      autoStart,
      homeDir: options.homeDir,
      sessionsDir: options.sessionsDir,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      permissionTimeoutMs: options.permissionTimeoutMs,
      daemonStartupTimeoutMs: options.daemonStartupTimeoutMs,
      daemonConnectTimeoutMs: options.daemonConnectTimeoutMs,
      ...(options.daemonOrphanExitMs !== undefined
        ? { daemonOrphanExitMs: options.daemonOrphanExitMs }
        : {}),
      daemonToken: options.daemonToken,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      requirements: autoStart
        ? {
            ...options.requirements,
            managedRunDurability: 1 as const,
            runtimeAutoModeGuardrail: 4 as const,
            runtimeEventCoalescing: 1 as const,
            ...(options.daemonOrphanExitMs !== undefined
              ? { daemonOrphanExit: 1 as const }
              : {}),
          }
        : options.requirements,
    });
  }
  if (options.mode !== undefined && options.mode !== "embedded") {
    throw new Error(`Unsupported KodaX runtime mode: ${String(options.mode)}`);
  }
  if (options.worker !== undefined && options.isolation !== "worker") {
    throw new Error("Runtime Worker options require isolation: 'worker'.");
  }
  if (options.isolation === "worker" && options.externalAgents !== undefined) {
    throw new Error(
      "External agent factories must be installed inside the Runtime Worker host; function injection cannot cross the Worker boundary.",
    );
  }
  if (options.isolation === "worker") {
    return createWorkerHostedKodaXRuntime(options);
  }
  // Single capability source for both the requirement gate and the public facade
  // metadata: what the embedded Runtime asserts it can satisfy is exactly what it
  // advertises on `runtime.capabilities`.
  const embeddedCapabilities: Record<string, unknown> = {
    hardDispose: false,
    externalAgents: options.externalAgents !== undefined,
    afterTurnInput: { version: 1 },
    interruptInput: { version: 1, availability: "per_run" },
    contextCompaction: {
      version: 3,
      alwaysOn: true,
      absoluteThreshold: true,
      contextIdentity: true,
      canonicalFinishedEvent: true,
      durableBeforeEvict: true,
      exactHistoryRecovery: true,
    },
    transcriptPaging: {
      version: 1,
      maxPageBytes: MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES,
    },
    transcriptSearch: {
      version: 1,
      defaultScope: "compacted",
      citedEntries: true,
    },
    conversationHistory: {
      version: 1,
      immutablePaging: true,
      revisionedBoundaries: true,
      ambiguityReporting: true,
    },
    learningCenter: { version: 1 },
    skillLearningLoop: {
      version: 1,
      activation: "project_scoped_canary",
      immutableDecisions: true,
      recordGatedDiscovery: true,
      exactUseAttribution: true,
      rollback: true,
    },
    actorControlPlane: { version: 1, methodNamespace: "agents" },
    sandboxRuntime: sandboxRuntimeCapability(),
    managedRunDurability: {
      version: 1,
      initialInputBeforeExecution: true,
      completedTurnBeforeEvent: true,
      deliveredInputBeforeEvent: true,
      persistenceFailure: "fail_closed",
    },
    runtimeEventCoalescing: { version: 1 },
    runtimeAutoModeGuardrail: {
      version: 4,
      owner: "session-runtime",
      escalationCreatesPermission: true,
      fallbackPersistsEngine: false,
      defaultClassifierTimeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
      defaultSpeculativeWindowMs: DEFAULT_SPECULATIVE_WINDOW_MS,
      boundedClassifierInput: true,
      diagnosticsVersion: 1,
      permissionGrantSuggestions: true,
      concretePermissionMatchers: true,
      clientScopeExpansion: false,
    },
    ...(options.externalAgents !== undefined
      ? { externalAgentAdmin: { version: 1 } }
      : {}),
  };
  assertRuntimeCapabilities(embeddedCapabilities, options.requirements);

  const identity: RuntimeIdentity = {
    runtimeId:
      options.daemonHostRuntimeId ??
      `rt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    mode: "embedded",
    profile: options.profile ?? "default",
    startedAt: new Date().toISOString(),
    version: process.env.KODAX_VERSION ?? "0.0.0",
    isolation: "inline",
  };
  const configHome = options.homeDir
    ? path.join(path.resolve(options.homeDir), ".kodax")
    : replApi.KODAX_DIR;
  const sessionsDir = resolveRuntimeSessionsDir(options);
  const sessionManager = createSessionManager(
    sessionsDir ? { sessionsDir, configHome } : { configHome },
  );
  const sessionAdmission = createRuntimeSessionAdmission(
    identity.profile,
    sessionManager,
    options.sharedDaemonHost === true,
  );
  const sessionOperations = createRuntimeSessionOperationGate();
  const configFile = resolveRuntimeConfigFile(options);
  registerRuntimeConfiguredCustomProviders(configFile);
  const ownerLiveness = await createRuntimeActorOwnerLiveness({
    onError(error) {
      emitKodaXDiagnostic({
        source: "runtime.owner",
        level: "error",
        message: `Runtime owner liveness endpoint failed for ${identity.runtimeId}.`,
        detail: normalizeError(error),
      });
    },
  });
  const runOwner: AgentActorOwner = {
    ownerId: `runtime_${randomUUID().replace(/-/g, "")}`,
    runtimeId: identity.runtimeId,
    pid: process.pid,
    startedAt: identity.startedAt,
    livenessId: ownerLiveness.id,
    livenessPort: ownerLiveness.port,
  };
  const persistence = createRuntimePersistence(options, runOwner);
  let agentPlane: AgentExecutorPlane | undefined;
  try {
    agentPlane = options.externalAgents
      ? await createAgentExecutorPlane({
          factories: options.externalAgents.factories,
          policy: options.externalAgents.policy,
          credentialBroker: options.externalAgents.credentialBroker,
          artifactPolicy: options.externalAgents.artifactPolicy,
          store: createRuntimeAgentExecutorPlaneStore(
            path.join(persistence.runtimeDir, "agents"),
          ),
        })
      : undefined;
  } catch (error: unknown) {
    await ownerLiveness.close();
    throw error;
  }
  const bus = createRuntimeEventBus(persistence);
  const settingsOwner = createRuntimeSessionSettingsOwner(persistence, bus);
  const permissions = createRuntimePermissionRegistry(
    bus,
    options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    persistence,
  );
  const userInputs = createRuntimeUserInputRegistry(
    bus,
    options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  const artifacts = createRuntimeArtifactStore();
  const workflows = createRuntimeWorkflowService();
  const runs = new Map<string, RuntimeRunRecord>();
  const actorHealthBySession = new Map<string, AgentControllerHealth>();
  const actorHealthWaiters = new Map<
    string,
    Set<(health: AgentControllerHealth) => void>
  >();
  const actorHealthChangeWaiters = new Map<
    string,
    Set<(health: AgentControllerHealth) => void>
  >();
  const waitForActorHealthResolution = (
    sessionId: string,
    observed: AgentControllerHealth,
  ): Promise<AgentControllerHealth> => {
    const current = actorHealthBySession.get(sessionId) ?? observed;
    if (current.state !== "recovering") return Promise.resolve(current);
    return new Promise<AgentControllerHealth>((resolve) => {
      const waiters = actorHealthWaiters.get(sessionId) ?? new Set();
      waiters.add(resolve);
      actorHealthWaiters.set(sessionId, waiters);
    });
  };
  const waitForActorHealthChange = (
    sessionId: string,
  ): {
    readonly promise: Promise<AgentControllerHealth>;
    close(): void;
  } => {
    let resolveChange: ((health: AgentControllerHealth) => void) | undefined;
    const promise = new Promise<AgentControllerHealth>((resolve) => {
      resolveChange = resolve;
    });
    const waiters = actorHealthChangeWaiters.get(sessionId) ?? new Set();
    waiters.add(resolveChange!);
    actorHealthChangeWaiters.set(sessionId, waiters);
    return {
      promise,
      close() {
        if (resolveChange === undefined) return;
        waiters.delete(resolveChange);
        if (waiters.size === 0) actorHealthChangeWaiters.delete(sessionId);
        resolveChange = undefined;
      },
    };
  };
  const onActorHealthChanged = (
    sessionId: string,
    health: AgentControllerHealth,
  ): void => {
    actorHealthBySession.set(sessionId, health);
    const changeWaiters = actorHealthChangeWaiters.get(sessionId);
    actorHealthChangeWaiters.delete(sessionId);
    for (const resolve of changeWaiters ?? []) resolve(health);
    for (const run of runs.values()) {
      if (
        run.sessionId !== sessionId
        || !run.ownedByRuntime
        || isTerminalRunPhase(run.phase)
      ) {
        continue;
      }
      if (run.stop?.state === "unknown") {
        delete run.actorHealthBaseState;
        if (health.state === "unknown") {
          run.lifecycleError = {
            code: health.code ?? "actor_settlement_not_persisted",
            message:
              health.message
              ?? "Actor executor settlement persistence is not confirmed.",
            retryable: false,
          };
          run.stageChangedAt = new Date().toISOString();
          const status = statusFromRecord(run);
          const authoritative = saveRunStatusSafely(
            bus,
            persistence,
            run,
            status,
          );
          if (authoritative === status) {
            bus.emit("run.updated", status, {
              sessionId: run.sessionId,
              runId: run.runId,
              ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
            });
          } else if (authoritative !== undefined) {
            applyAuthoritativeRunStatus(run, authoritative);
          }
        }
        continue;
      }
      if (health.state === "healthy") {
        const prior = run.actorHealthBaseState;
        if (prior === undefined) continue;
        run.phase = prior.phase;
        run.stage = prior.stage;
        run.error = prior.error;
        run.lifecycleError = prior.lifecycleError;
        delete run.actorHealthBaseState;
      } else {
        if (run.actorHealthBaseState === undefined) {
          run.actorHealthBaseState = {
            phase: run.phase,
            stage: run.stage,
            error: run.error,
            lifecycleError: run.lifecycleError,
          };
        }
        if (run.phase !== "queued" || health.state === "unknown") {
          run.phase = health.state;
        }
        run.stage = health.state;
        run.error = health.message;
        run.lifecycleError = {
          code: health.code ?? "actor_settlement_retrying",
          message:
            health.message
            ?? "Actor executor settlement persistence is not confirmed.",
          retryable: health.state === "recovering",
        };
      }
      run.stageChangedAt = new Date().toISOString();
      const status = statusFromRecord(run);
      const authoritative = saveRunStatusSafely(
        bus,
        persistence,
        run,
        status,
      );
      if (authoritative === status) {
        bus.emit("run.updated", status, {
          sessionId: run.sessionId,
          runId: run.runId,
          ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
        });
      } else if (authoritative !== undefined) {
        applyAuthoritativeRunStatus(run, authoritative);
      }
    }
    if (health.state !== "recovering") {
      const waiters = actorHealthWaiters.get(sessionId);
      actorHealthWaiters.delete(sessionId);
      for (const resolve of waiters ?? []) resolve(health);
    }
  };
  const actorRegistry = createRuntimeAgentActorRegistry(
    sessionManager,
    identity,
    ownerLiveness,
    agentPlane,
    options.externalAgents?.defaultContext,
    onActorHealthChanged,
  );
  const recoveredSessionOrders = new Map<string, number>();
  const persistedStatuses = [
    ...recentRunStatuses(persistence.loadRunStatuses()),
  ].sort((left, right) =>
    compareRunStatusRecency(left.status, right.status)
  );
  const statusesToRecover: Array<{
    readonly persisted: PersistedRuntimeRunStatus;
    readonly normalizedStatus: RuntimeRunStatus;
  }> = [];
  for (const persisted of persistedStatuses) {
    const status = persisted.status;
    const sessionOrder =
      status.sessionOrder ??
      (recoveredSessionOrders.get(status.sessionId) ?? 0) + 1;
    recoveredSessionOrders.set(
      status.sessionId,
      Math.max(recoveredSessionOrders.get(status.sessionId) ?? 0, sessionOrder),
    );
    let normalizedStatus = {
      ...status,
      acceptedAt: status.acceptedAt ?? status.startedAt,
      sessionOrder,
    };
    if (!isTerminalRunPhase(status.phase)) {
      const durableTerminal = recoverPersistedDurableTerminal(
        normalizedStatus,
        bus,
        persistence,
      );
      if (durableTerminal !== undefined) {
        runs.set(
          durableTerminal.runId,
          recordFromPersistedStatus(
            durableTerminal,
            false,
            persisted.owner,
          ),
        );
        continue;
      }
      normalizedStatus = reconcilePersistedInterruptDeliveries(
        normalizedStatus,
        persistence.replay({ runId: status.runId }),
      );
    }
    statusesToRecover.push({ persisted, normalizedStatus });
  }
  const ownersToInspect = statusesToRecover.flatMap(({ persisted }) => (
    !isTerminalRunPhase(persisted.status.phase) && persisted.owner !== undefined
      ? [persisted.owner]
      : []
  ));
  const ownerStates = await inspectRuntimeActorOwners(ownersToInspect);
  let ownerStateIndex = 0;
  for (const { persisted, normalizedStatus } of statusesToRecover) {
    const status = persisted.status;
    const ownerState = isTerminalRunPhase(status.phase)
      ? "dead"
      : persisted.owner === undefined
        ? "unknown"
        : ownerStates[ownerStateIndex++] ?? "unknown";
    if (!isTerminalRunPhase(status.phase) && ownerState !== "dead") {
      runs.set(
        status.runId,
        recordFromPersistedStatus(
          normalizedStatus,
          false,
          persisted.owner,
        ),
      );
      continue;
    }
    const recovered = interruptPersistedNonTerminalRun(
      normalizedStatus,
      bus,
      persistence,
    );
    runs.set(
      recovered.runId,
      recordFromPersistedStatus(recovered, false, persisted.owner),
    );
  }
  let closed = false;
  let closeAttempt: Promise<void> | undefined;
  let shutdownStarted = false;
  let actorRegistryClosed = false;
  let agentPlaneClosed = agentPlane === undefined;
  let ownerLivenessClosed = false;
  let busClosed = false;
  const ensureOpen = (): void => {
    if (closed) {
      throw new Error("KodaX runtime is closed");
    }
  };

  const runService = createRuntimeRunService({
    bus,
    defaultModel: options.defaultModel,
    defaultProvider: options.defaultProvider,
    defaultConfigHome: configHome,
    ensureOpen,
    isClosed: () => closed,
    artifacts,
    permissions,
    userInputs,
    enableSharedInteractions: options.sharedDaemonHost === true,
    persistence,
    runOwner,
    runs,
    sessionManager,
    sessionAdmission,
    sessionOperations,
    agentPlane,
    defaultAgentContext: options.externalAgents?.defaultContext,
    actorRegistry,
    waitForActorHealthResolution,
    waitForActorHealthChange,
    settingsOwner,
  });
  let beginCloseTranscriptSnapshots: (() => void) | undefined;
  let closeTranscriptSnapshots: (() => Promise<void>) | undefined;
  const sessionService = createRuntimeSessionService(
    identity,
    configHome,
    sessionManager,
    bus,
    persistence,
    ensureOpen,
    (sessionId) =>
      runtimeSessionActiveRunOwner(sessionId, runs, persistence),
    settingsOwner,
    (sessionId) => runService.list({ sessionId }),
    (sessionId) => runService.inspect({ sessionId }),
    (runId) => runService.inspectOne(runId),
    (sessionId) => permissions.service.listPending({ sessionId }),
    (sessionId) => runService.getAutoModeStats(sessionId),
    sessionOperations,
    (sessionId, operation, mutation) =>
      actorRegistry.mutateSessionFile(sessionId, operation, mutation),
    (sessionId) => {
      runService.releaseSession(sessionId);
      permissions.releaseSession(sessionId);
    },
    sessionAdmission,
    (beginClose, cleanup) => {
      beginCloseTranscriptSnapshots = beginClose;
      closeTranscriptSnapshots = cleanup;
    },
  );
  const managedWorkspaceRoot = path.join(
    options.homeDir ? path.resolve(options.homeDir) : os.homedir(),
    "kodax_a2a_server_workspace",
    encodeURIComponent(identity.profile),
  );
  const bindingService = createRuntimeAgentBindingService({
    configHome,
    managedWorkspaceRoot,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    runs: runService,
    sessions: sessionService,
    createSkillScriptRunner: (input) =>
      createAsrtSkillScriptRunner({
        ...input,
        snapshotRoot: path.join(managedWorkspaceRoot, "bindings"),
      }),
  });
  const learning = createRuntimeLearningOwner({
    rootDir: path.join(configHome, "learned"),
    userSkillsRoot: path.join(configHome, "skills"),
    defaultClientIdentity:
      options.clientInfo?.instanceId ?? `inline_${identity.runtimeId}`,
    proposalStores: [
      rebaseAgentConfigPath(
        resolveLearningProposalStore(process.cwd()),
        configHome,
      ),
    ],
  });

  const closeRuntime = (): Promise<void> => {
    if (closeAttempt) return closeAttempt;
    closed = true;
    const attempt = (async (): Promise<void> => {
      if (!shutdownStarted) {
        runService.closeAll("runtime closed");
        permissions.rejectAll("runtime closed");
        permissions.releaseAllSessionGrants();
        userInputs.rejectAll("runtime closed");
        shutdownStarted = true;
      }
      beginCloseTranscriptSnapshots?.();
      await sessionOperations.close();
      await closeTranscriptSnapshots?.();
      beginCloseTranscriptSnapshots = undefined;
      closeTranscriptSnapshots = undefined;
      if (!actorRegistryClosed) {
        await actorRegistry.close("runtime closed");
        actorRegistryClosed = true;
      }
      if (!agentPlaneClosed) {
        await agentPlane!.close();
        agentPlaneClosed = true;
      }
      // Keep the liveness endpoint reachable until every executor has stopped
      // and the Actor owner has been durably released. A failed close can then
      // be retried without allowing another Runtime to take over prematurely.
      if (!ownerLivenessClosed) {
        await ownerLiveness.close();
        ownerLivenessClosed = true;
      }
      if (!busClosed) {
        bus.close();
        busClosed = true;
      }
    })();
    closeAttempt = attempt;
    void attempt.then(
      () => {
        if (closeAttempt === attempt) closeAttempt = undefined;
      },
      () => {
        if (closeAttempt === attempt) closeAttempt = undefined;
      },
    );
    return attempt;
  };

  const runtime: KodaXRuntime = {
    identity,
    capabilities: embeddedCapabilities,
    sessions: sessionService,
    runs: runService,
    events: bus.service,
    permissions: permissions.service,
    userInputs: userInputs.service,
    credentials: createUnsupportedCredentialService(),
    hostTools: createUnsupportedHostToolService(),
    operations: {
      async get() {
        throw new Error(
          "Embedded Runtime does not persist daemon operation receipts.",
        );
      },
    },
    workflows,
    learning,
    config: createRuntimeConfigService(ensureOpen, configFile),
    catalog: createRuntimeCatalogService(ensureOpen, configFile),
    mcp: createRuntimeMcpService(ensureOpen, configFile),
    artifacts: artifacts.service,
    status: createRuntimeStatusService({
      identity,
      permissions,
      userInputs,
      listRuns: () => runService.list(),
      sessionManager,
      sessionAdmission,
      workflows,
      actors: actorRegistry,
    }),
    diagnostics: createRuntimeDiagnosticsService(bus.service),
    admin: createRuntimeAdminService(agentPlane),
    agents: createRuntimeAgentService(
      agentPlane,
      bindingService,
      actorRegistry,
      sessionAdmission,
      sessionOperations,
      ensureOpen,
    ),
    close: closeRuntime,
  };

  return runtime;
}

async function createInProcessExternalAgentDaemon(
  options: CreateKodaXRuntimeOptions,
): Promise<KodaXRuntime> {
  const externalAgents = options.externalAgents;
  if (!externalAgents)
    throw new Error(
      "External agent options are required for the hosted daemon.",
    );
  if (options.daemonTransport !== undefined) {
    throw new Error(
      "External agent factories cannot be installed through an existing daemon transport.",
    );
  }
  if (options.autoStartDaemon === false) {
    throw new Error(
      "External agent factories require an in-process daemon host with autoStartDaemon enabled.",
    );
  }
  const endpoint =
    options.daemonEndpoint !== undefined
      ? normalizeRuntimeDaemonEndpoint(options.daemonEndpoint)
      : undefined;
  const daemonLocation = resolveRuntimeDaemonClientLocation(options.homeDir);
  const lease = await acquireRuntimeDaemonLease({
    homeDir: daemonLocation.homeDir,
    configHome: daemonLocation.configHome,
    profile: options.profile,
    endpoint,
    connectTimeoutMs: options.daemonConnectTimeoutMs,
    startupTimeoutMs: options.daemonStartupTimeoutMs,
    createRuntime: (runtimeId) =>
      createKodaXRuntime({
        mode: "embedded",
        homeDir: options.homeDir,
        profile: options.profile,
        sessionsDir: options.sessionsDir,
        defaultProvider: options.defaultProvider,
        defaultModel: options.defaultModel,
        permissionTimeoutMs: options.permissionTimeoutMs,
        sharedDaemonHost: true,
        daemonHostRuntimeId: runtimeId,
        clientInfo: options.clientInfo,
        capabilities: options.capabilities,
        requirements: options.requirements,
        externalAgents,
      }),
  });
  if (!lease.ownsHost) {
    await lease.close();
    throw new Error(
      "External agent factories cannot be installed into an already-running daemon profile; configure its owner or use a unique profile.",
    );
  }
  try {
    const runtime = await connectKodaXRuntime({
      profile: options.profile,
      transport: lease.transport,
      daemonToken: options.daemonToken ?? readRuntimeDaemonToken(lease.paths),
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      requirements: {
        ...options.requirements,
        externalAgents: true,
        externalAgentAdmin: 1,
      },
    });
    let runtimeClosed = false;
    let leaseClosed = false;
    let closeAttempt: Promise<void> | undefined;
    const closeHostedRuntime = (): Promise<void> => {
      if (closeAttempt) return closeAttempt;
      const attempt = (async (): Promise<void> => {
        if (!leaseClosed) {
          if (lease.ownsHost) await lease.shutdown();
          else await lease.close();
          leaseClosed = true;
        }
        if (!runtimeClosed) {
          await runtime.close();
          runtimeClosed = true;
        }
      })();
      closeAttempt = attempt;
      void attempt.then(
        () => {
          if (closeAttempt === attempt) closeAttempt = undefined;
        },
        () => {
          if (closeAttempt === attempt) closeAttempt = undefined;
        },
      );
      return attempt;
    };
    return {
      ...runtime,
      identity: { ...runtime.identity, isolation: "inline" },
      close: closeHostedRuntime,
    };
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      lease.ownsHost ? lease.shutdown() : lease.close(),
    ]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Hosted daemon initialization failed and cleanup was incomplete.",
      );
    }
    throw error;
  }
}

async function createWorkerHostedKodaXRuntime(
  options: CreateKodaXRuntimeOptions,
): Promise<KodaXRuntime> {
  const shutdownTimeoutMs = options.worker?.shutdownTimeoutMs ?? 2_000;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new Error(
      "Runtime Worker shutdownTimeoutMs must be a positive finite number.",
    );
  }
  const handle = createRuntimeWorkerTransport(
    {
      homeDir: options.homeDir,
      profile: options.profile,
      sessionsDir: options.sessionsDir,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      permissionTimeoutMs: options.permissionTimeoutMs,
      configuredA2A: options.worker?.configuredA2A,
    },
    options.worker,
  );
  try {
    const initialized = requireRuntimeRecord(
      await handle.transport.request("initialize", {
        profile: options.profile ?? "default",
        ...(options.clientInfo !== undefined
          ? { clientInfo: options.clientInfo }
          : {}),
        ...(options.capabilities !== undefined
          ? { capabilities: options.capabilities }
          : {}),
      }),
    );
    const identity = parseRuntimeIdentity(initialized.identity);
    assertRuntimeCapabilities(initialized.capabilities, {
      ...options.requirements,
      hardDispose: true,
    });
    const client = createRuntimeDaemonClient({
      identity: {
        ...identity,
        mode: "embedded",
        isolation: "worker",
        workerThreadId: handle.threadId,
      },
      transport: handle.transport,
      capabilities: requireRuntimeRecord(initialized.capabilities),
    });
    let terminated = false;
    let closeAttempt: Promise<void> | undefined;
    const closeWorkerRuntime = (): Promise<void> => {
      if (terminated) return Promise.resolve();
      if (closeAttempt) return closeAttempt;
      const attempt = (async (): Promise<void> => {
        let shutdownError: unknown;
        try {
          await settleWithin(
            handle.transport.request("runtime.shutdown"),
            shutdownTimeoutMs,
          );
        } catch (error: unknown) {
          shutdownError = error;
        }
        try {
          await handle.terminate();
          terminated = true;
        } catch (terminationError: unknown) {
          if (shutdownError !== undefined) {
            throw new AggregateError(
              [shutdownError, terminationError],
              "Runtime Worker shutdown and forced termination both failed.",
            );
          }
          throw terminationError;
        }
        if (shutdownError !== undefined) throw shutdownError;
      })();
      closeAttempt = attempt;
      void attempt.finally(() => {
        if (closeAttempt === attempt) closeAttempt = undefined;
      }).catch(() => undefined);
      return attempt;
    };
    return {
      ...client,
      close: closeWorkerRuntime,
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
  if (
    !requirements?.hardDispose &&
    !requirements?.externalAgents &&
    requirements?.externalAgentAdmin === undefined &&
    requirements?.a2aConfigReconciler === undefined &&
    requirements?.operationDeduplication === undefined &&
    requirements?.sessionObservation === undefined &&
    requirements?.afterTurnInput === undefined &&
    requirements?.learningCenter === undefined &&
    requirements?.skillLearningLoop === undefined &&
    requirements?.interruptInput === undefined &&
    requirements?.askUserTransport === undefined &&
    requirements?.permissionCas === undefined &&
    requirements?.providerCredentialBroker === undefined &&
    requirements?.runBoundHostTools === undefined &&
    requirements?.coderOwnerFencing === undefined &&
    requirements?.crashOutcomeModel === undefined &&
    requirements?.coderFeatureMatrix === undefined &&
    requirements?.sessionAdmission === undefined &&
    requirements?.completeObservationSnapshot === undefined &&
    requirements?.contextCompaction === undefined &&
    requirements?.transcriptPaging === undefined &&
    requirements?.transcriptSearch === undefined &&
    requirements?.conversationHistory === undefined &&
    requirements?.connectionLifecycle === undefined &&
    requirements?.typedRuntimeEvents === undefined &&
    requirements?.daemonSafeRunInput === undefined &&
    requirements?.sharedSessionSettings === undefined &&
    requirements?.durableRecoveryQueries === undefined &&
    requirements?.managedRunDurability === undefined &&
    requirements?.daemonManagement === undefined &&
    requirements?.daemonOrphanExit === undefined &&
    requirements?.runtimeEventCoalescing === undefined &&
    requirements?.integrationConfigResilience === undefined &&
    requirements?.actorControlPlane === undefined &&
    requirements?.runtimeAutoModeGuardrail === undefined
  )
    return;
  const capabilities = requireRuntimeRecord(value);
  if (requirements.hardDispose && capabilities.hardDispose !== true) {
    throw new Error(
      "Runtime does not support the required hardDispose capability.",
    );
  }
  if (requirements.externalAgents && capabilities.externalAgents !== true) {
    throw new Error(
      "Runtime does not support the required externalAgents capability.",
    );
  }
  if (requirements.operationDeduplication !== undefined) {
    assertVersionedRuntimeCapability(
      capabilities,
      "operationDeduplication",
      requirements.operationDeduplication,
    );
  }
  const versionedRequirements = [
    ["externalAgentAdmin", requirements.externalAgentAdmin],
    ["a2aConfigReconciler", requirements.a2aConfigReconciler],
    ["sessionObservation", requirements.sessionObservation],
    ["afterTurnInput", requirements.afterTurnInput],
    ["learningCenter", requirements.learningCenter],
    ["skillLearningLoop", requirements.skillLearningLoop],
    ["interruptInput", requirements.interruptInput],
    ["askUserTransport", requirements.askUserTransport],
    ["permissionCas", requirements.permissionCas],
    ["providerCredentialBroker", requirements.providerCredentialBroker],
    ["runBoundHostTools", requirements.runBoundHostTools],
    ["coderOwnerFencing", requirements.coderOwnerFencing],
    ["crashOutcomeModel", requirements.crashOutcomeModel],
    ["coderFeatureMatrix", requirements.coderFeatureMatrix],
    ["sessionAdmission", requirements.sessionAdmission],
    ["completeObservationSnapshot", requirements.completeObservationSnapshot],
    ["contextCompaction", requirements.contextCompaction],
    ["transcriptPaging", requirements.transcriptPaging],
    ["transcriptSearch", requirements.transcriptSearch],
    ["conversationHistory", requirements.conversationHistory],
    ["connectionLifecycle", requirements.connectionLifecycle],
    ["typedRuntimeEvents", requirements.typedRuntimeEvents],
    ["daemonSafeRunInput", requirements.daemonSafeRunInput],
    ["sharedSessionSettings", requirements.sharedSessionSettings],
    ["durableRecoveryQueries", requirements.durableRecoveryQueries],
    ["managedRunDurability", requirements.managedRunDurability],
    ["daemonManagement", requirements.daemonManagement],
    ["daemonOrphanExit", requirements.daemonOrphanExit],
    ["runtimeEventCoalescing", requirements.runtimeEventCoalescing],
    ["integrationConfigResilience", requirements.integrationConfigResilience],
    ["actorControlPlane", requirements.actorControlPlane],
    ["runtimeAutoModeGuardrail", requirements.runtimeAutoModeGuardrail],
  ] as const;
  for (const [name, version] of versionedRequirements) {
    if (version !== undefined)
      assertVersionedRuntimeCapability(capabilities, name, version);
  }
}

function assertVersionedRuntimeCapability(
  capabilities: Record<string, unknown>,
  name: string,
  version: number,
): void {
  const capability = capabilities[name];
  if (
    !isRecord(capability) ||
    !Number.isSafeInteger(capability.version) ||
    Number(capability.version) < version
  ) {
    throw new Error(
      `Runtime does not support the required ${name} capability.`,
    );
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Runtime Worker shutdown timed out after ${timeoutMs}ms.`,
              ),
            ),
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
): Promise<KodaXDaemonRuntime> {
  return connectKodaXRuntimeInternal(options, true);
}

function hasVersionedRuntimeCapability(
  capabilities: Record<string, unknown>,
  name: string,
  version: number,
): boolean {
  const capability = capabilities[name];
  return (
    isRecord(capability) &&
    Number.isSafeInteger(capability.version) &&
    Number(capability.version) >= version
  );
}

async function replaceRuntimeDaemonForCapabilityUpgrade(input: {
  readonly identity: RuntimeIdentity;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly transport: RuntimeDaemonClientTransport;
  readonly lease: RuntimeDaemonProcessLease;
  readonly journalEpoch?: string;
  readonly grantedScopes?: readonly RuntimeGrantedScope[];
  readonly startupTimeoutMs: number;
  readonly requiredCapability: string;
  readonly requiredVersion: number;
}): Promise<void> {
  if (
    !hasVersionedRuntimeCapability(
      input.capabilities as Record<string, unknown>,
      "daemonManagement",
      1,
    )
  ) {
    throw new RuntimeDaemonCapabilityUpgradeError(
      "The running daemon is too old to perform a fenced in-place upgrade. Stop it manually after all runs and pending interactions finish, then retry.",
      undefined,
      undefined,
      input.requiredCapability,
    );
  }
  const runtime = createRuntimeDaemonClient({
    identity: { ...input.identity, mode: "daemon", isolation: "process" },
    transport: input.transport,
    capabilities: input.capabilities,
    ...(input.journalEpoch !== undefined
      ? { journalEpoch: input.journalEpoch }
      : {}),
    ...(input.grantedScopes !== undefined
      ? { grantedScopes: input.grantedScopes }
      : {}),
  });
  let management: RuntimeDaemonManagementState | undefined;
  try {
    management = await runtime.daemon.inspect();
    if (!management.preflight.canStop) {
      throw new RuntimeDaemonCapabilityUpgradeError(
        `The running daemon needs ${input.requiredCapability} v${input.requiredVersion} but cannot be replaced safely yet: ${management.preflight.blockers.join(", ")}. Finish or cancel that work and retry.`,
        management.preflight,
        undefined,
        input.requiredCapability,
      );
    }
    await runtime.daemon.stopForInline({
      expectedRuntimeId: management.runtimeId,
      expectedRevision: management.revision,
      expectedOwnerPolicyRevision: management.ownerPolicy.revision,
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeDaemonCapabilityUpgradeError) throw error;
    throw new RuntimeDaemonCapabilityUpgradeError(
      "The running daemon changed while preparing its safe capability upgrade. Retry after active and queued work has settled.",
      management?.preflight,
      { cause: error },
      input.requiredCapability,
    );
  } finally {
    let runtimeClosed = false;
    await runtime
      .close()
      .then(() => {
        runtimeClosed = true;
      })
      .catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: "runtime.daemon.upgrade",
          level: "warn",
          message:
            "Failed to close the legacy daemon client after upgrade attempt.",
          detail: normalizeError(error),
        });
      });
    if (!runtimeClosed) {
      await input.lease.close().catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: "runtime.daemon.upgrade",
          level: "warn",
          message:
            "Failed to close the legacy daemon process lease after client cleanup failed.",
          detail: normalizeError(error),
        });
      });
    }
  }

  const deadline = Date.now() + input.startupTimeoutMs;
  try {
    while (
      readRuntimeDaemonLockOwner(input.lease.paths.lockFile) !== undefined
    ) {
      if (Date.now() >= deadline) {
        throw new RuntimeDaemonCapabilityUpgradeError(
          "The legacy daemon accepted the upgrade stop but did not release its owner fence before timeout. Retry after the daemon exits.",
          undefined,
          undefined,
          input.requiredCapability,
        );
      }
      // This timer must stay referenced: the caller is awaiting a mandatory
      // owner-policy transition. Unref'ing it lets a short-lived SDK process
      // exit with an unsettled connectKodaXRuntime() promise, stranding the
      // profile in inline mode after the legacy daemon has already stopped.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } catch (error: unknown) {
    try {
      // rollbackToInline changes durable owner policy before shutdown. Restore
      // daemon eligibility even when fence release times out so the documented
      // retry path is actually usable and does not require manual repair.
      enableRuntimeDaemonOwner(input.lease.paths);
    } catch (restoreError: unknown) {
      throw new RuntimeDaemonCapabilityUpgradeError(
        "The legacy daemon upgrade failed and daemon ownership could not be restored automatically. Call `enableKodaXDaemonOwner(...)` from the SDK and retry.",
        undefined,
        { cause: new AggregateError([error, restoreError]) },
        input.requiredCapability,
      );
    }
    throw error;
  }
  try {
    enableRuntimeDaemonOwner(input.lease.paths);
  } catch (error: unknown) {
    throw new RuntimeDaemonCapabilityUpgradeError(
      "The legacy daemon stopped, but daemon ownership could not be re-enabled automatically. Call `enableKodaXDaemonOwner(...)` from the SDK and retry.",
      undefined,
      { cause: error },
      input.requiredCapability,
    );
  }
}

async function connectKodaXRuntimeInternal(
  options: ConnectKodaXRuntimeOptions,
  allowCapabilityUpgrade: boolean,
): Promise<KodaXDaemonRuntime> {
  assertPositiveRuntimeTimeout(
    "daemonStartupTimeoutMs",
    options.daemonStartupTimeoutMs,
  );
  assertPositiveRuntimeTimeout(
    "daemonConnectTimeoutMs",
    options.daemonConnectTimeoutMs,
  );
  assertPositiveRuntimeTimeout(
    "daemonOrphanExitMs",
    options.daemonOrphanExitMs,
  );
  const explicitEndpoint =
    options.endpoint !== undefined
      ? normalizeRuntimeDaemonEndpoint(options.endpoint)
      : undefined;
  const daemonLocation = resolveRuntimeDaemonClientLocation(options.homeDir);
  const lease =
    options.transport === undefined && options.autoStart === true
      ? await acquireRuntimeDaemonProcessLease({
          homeDir: daemonLocation.homeDir,
          configHome: daemonLocation.configHome,
          profile: options.profile,
          endpoint: explicitEndpoint,
          defaultProvider: options.defaultProvider,
          defaultModel: options.defaultModel,
          sessionsDir: options.sessionsDir,
          permissionTimeoutMs: options.permissionTimeoutMs,
          orphanExitMs: options.daemonOrphanExitMs,
          startupTimeoutMs: options.daemonStartupTimeoutMs,
          connectTimeoutMs: options.daemonConnectTimeoutMs,
        })
      : undefined;
  const endpoint =
    explicitEndpoint ??
    lease?.endpoint ??
    (options.transport === undefined
      ? defaultRuntimeDaemonEndpoint(
          options.profile ?? "default",
          resolveRuntimeDaemonEndpointScope(
            daemonLocation.homeDir,
            daemonLocation.configHome,
          ),
        )
      : undefined);
  const transport =
    options.transport ??
    lease?.transport ??
    (endpoint !== undefined
      ? await createRuntimeDaemonSocketClientTransport(endpoint, {
          connectTimeoutMs: options.daemonConnectTimeoutMs,
        })
      : undefined);
  if (!transport) {
    throw new Error(
      "connectKodaXRuntime requires a daemon transport, endpoint, or autoStart: true.",
    );
  }
  const token = resolveConnectDaemonToken(options);
  let identity: RuntimeIdentity;
  let daemonCapabilities: Readonly<Record<string, unknown>> = {};
  let journalEpoch: string | undefined;
  let grantedScopes: readonly RuntimeGrantedScope[] | undefined;
  let upgradeReleasedLease = false;
  try {
    const clientInfo: RuntimeClientInfo = {
      name: options.clientInfo?.name ?? "kodax-sdk",
      instanceId:
        options.clientInfo?.instanceId ??
        `sdk_${randomUUID().replace(/-/g, "")}`,
      ...(options.clientInfo?.instanceSecret !== undefined
        ? { instanceSecret: options.clientInfo.instanceSecret }
        : {}),
      ...(options.clientInfo?.title !== undefined
        ? { title: options.clientInfo.title }
        : {}),
      ...(options.clientInfo?.version !== undefined
        ? { version: options.clientInfo.version }
        : {}),
    };
    const initialized = requireRuntimeRecord(
      await transport.request("initialize", {
        profile: options.profile ?? "default",
        connectionPurpose: "client",
        autoStart: options.autoStart === true,
        ...(token !== undefined ? { token } : {}),
        clientInfo,
        capabilities: {
          ...options.capabilities,
          operationDeduplication: true,
        },
        ...(endpoint !== undefined ? { endpoint: endpoint.path } : {}),
      }),
    );
    identity = parseRuntimeIdentity(initialized.identity);
    daemonCapabilities =
      initialized.capabilities === undefined
        ? {}
        : requireRuntimeRecord(initialized.capabilities);
    journalEpoch =
      typeof initialized.journalEpoch === "string"
        ? initialized.journalEpoch
        : undefined;
    grantedScopes = parseRuntimeGrantedScopes(initialized.grantedScopes);
    const requirements =
      options.autoStart === true
        ? {
            ...options.requirements,
            managedRunDurability: 1 as const,
            runtimeAutoModeGuardrail: 4 as const,
            runtimeEventCoalescing: 1 as const,
            ...(options.daemonOrphanExitMs !== undefined
              ? { daemonOrphanExit: 1 as const }
              : {}),
          }
        : options.requirements;
    const requiredUpgrade = [
      {
        name: "managedRunDurability",
        version: requirements?.managedRunDurability,
      },
      {
        name: "runtimeAutoModeGuardrail",
        version: requirements?.runtimeAutoModeGuardrail,
      },
      {
        name: "runtimeEventCoalescing",
        version: requirements?.runtimeEventCoalescing,
      },
      {
        name: "daemonOrphanExit",
        version: requirements?.daemonOrphanExit,
      },
    ].find(
      (requirement): requirement is { name: string; version: number } =>
        requirement.version !== undefined &&
        !hasVersionedRuntimeCapability(
          daemonCapabilities,
          requirement.name,
          requirement.version,
        ),
    );
    if (requiredUpgrade !== undefined) {
      if (
        !allowCapabilityUpgrade ||
        options.autoStart !== true ||
        lease === undefined
      ) {
        throw new RuntimeDaemonCapabilityUpgradeError(
          `Runtime daemon does not support ${requiredUpgrade.name} v${requiredUpgrade.version}. Stop all daemon work and restart it with a compatible KodaX installation.`,
          undefined,
          undefined,
          requiredUpgrade.name,
        );
      }
      try {
        await replaceRuntimeDaemonForCapabilityUpgrade({
          identity,
          capabilities: daemonCapabilities,
          transport,
          lease,
          ...(journalEpoch !== undefined ? { journalEpoch } : {}),
          ...(grantedScopes !== undefined ? { grantedScopes } : {}),
          startupTimeoutMs: options.daemonStartupTimeoutMs ?? 60_000,
          requiredCapability: requiredUpgrade.name,
          requiredVersion: requiredUpgrade.version,
        });
      } finally {
        // The upgrade helper owns the daemon facade and therefore closes the
        // lease's transport. Do not close the same transport again below.
        upgradeReleasedLease = true;
      }
      return connectKodaXRuntimeInternal(options, false);
    }
    assertRuntimeCapabilities(daemonCapabilities, requirements);
    const expectedProfile = options.profile ?? "default";
    if (identity.profile !== expectedProfile) {
      throw new Error(
        `Runtime daemon profile mismatch: expected ${expectedProfile}, got ${identity.profile}`,
      );
    }
  } catch (error: unknown) {
    if (!upgradeReleasedLease) {
      if (lease !== undefined) await lease.close();
      else await transport.close?.();
    }
    throw error;
  }
  const runtime = createRuntimeDaemonClient({
    identity: { ...identity, mode: "daemon", isolation: "process" },
    transport,
    capabilities: daemonCapabilities,
    ...(journalEpoch !== undefined ? { journalEpoch } : {}),
    ...(grantedScopes !== undefined ? { grantedScopes } : {}),
  });
  if (!lease) return runtime;
  return {
    ...runtime,
    async close() {
      await runtime.close();
    },
  };
}

function assertPositiveRuntimeTimeout(
  name: string,
  value: number | undefined,
): void {
  if (value === undefined || (Number.isFinite(value) && value > 0)) return;
  throw new Error(`${name} must be a positive finite number.`);
}

function parseRuntimeGrantedScopes(
  value: unknown,
): readonly RuntimeGrantedScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter(
    (scope): scope is RuntimeGrantedScope =>
      typeof scope === "string" && isRuntimeGrantedScope(scope),
  );
  return scopes.length === value.length ? scopes : undefined;
}

function isRuntimeGrantedScope(value: string): value is RuntimeGrantedScope {
  return (
    value === "session:observe" ||
    value === "session:write" ||
    value === "run:control" ||
    value === "interaction:respond" ||
    value === "permission:respond" ||
    value === "permission:grant-admin" ||
    value === "integration:admin" ||
    value === "workflow:control" ||
    value === "learning:read" ||
    value === "learning:control" ||
    value === "artifact:write" ||
    value === "agent:control" ||
    value === "credential:register" ||
    value === "host-tool:register" ||
    value === "owner:admin" ||
    value === "daemon:admin"
  );
}

function resolveConnectDaemonToken(
  options: ConnectKodaXRuntimeOptions,
): string | undefined {
  if (options.daemonToken !== undefined) return options.daemonToken;
  if (options.transport !== undefined && options.autoStart !== true)
    return undefined;
  return readRuntimeDaemonToken(
    resolveRuntimeDaemonClientPaths(options.homeDir, options.profile).paths,
  );
}

function normalizeRuntimeDaemonEndpoint(
  endpoint: string | RuntimeDaemonEndpoint,
): RuntimeDaemonEndpoint {
  if (typeof endpoint !== "string") return endpoint;
  return {
    kind:
      process.platform === "win32" || endpoint.startsWith("\\\\.\\pipe\\")
        ? "pipe"
        : "unix",
    path: endpoint,
  };
}

type RuntimeSessionSettingsListener = (
  sessionId: string,
  current: RuntimeVersionedValue<RuntimeSessionSettings>,
  patch: RuntimeSessionSettingsPatch,
) => void;

interface RuntimeSessionSettingsOwner {
  read(
    sessionId: string,
  ): Promise<RuntimeVersionedValue<RuntimeSessionSettings>>;
  peek(
    sessionId: string,
  ): RuntimeVersionedValue<RuntimeSessionSettings> | undefined;
  update(
    sessionId: string,
    patch: RuntimeSessionSettingsPatch,
    expectedRevision: number | undefined,
    validate: (settings: RuntimeSessionSettings) => void,
  ): Promise<RuntimeVersionedValue<RuntimeSessionSettings>>;
  persistAutoModeEngine(
    sessionId: string,
    engine: NonNullable<RuntimeSessionSettings["autoModeEngine"]>,
  ): Promise<void>;
  subscribe(listener: RuntimeSessionSettingsListener): RuntimeSubscription;
  release(sessionId: string): void;
}

function createRuntimeSessionSettingsOwner(
  persistence: RuntimePersistence,
  bus: RuntimeEventBus,
): RuntimeSessionSettingsOwner {
  const current = new Map<
    string,
    RuntimeVersionedValue<RuntimeSessionSettings>
  >();
  const tails = new Map<string, Promise<void>>();
  const listeners = new Set<RuntimeSessionSettingsListener>();

  const enqueue = <T>(
    sessionId: string,
    effect: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(effect);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(sessionId, tail);
    void tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return result;
  };

  const publish = (
    sessionId: string,
    updated: RuntimeVersionedValue<RuntimeSessionSettings>,
    patch: RuntimeSessionSettingsPatch,
  ): void => {
    current.set(sessionId, updated);
    for (const listener of listeners) listener(sessionId, updated, patch);
    bus.emit(
      "session.settings.updated",
      {
        sessionId,
        revision: updated.revision,
        settings: updated.value,
        patch,
      },
      { sessionId, runId: sessionId },
    );
  };

  return {
    async read(sessionId) {
      await (tails.get(sessionId) ?? Promise.resolve());
      const loaded = persistence.loadSessionSettingsVersioned(sessionId);
      current.set(sessionId, loaded);
      return loaded;
    },
    peek(sessionId) {
      return current.get(sessionId);
    },
    update(sessionId, patch, expectedRevision, validate) {
      return enqueue(sessionId, () => {
        const loaded = persistence.loadSessionSettingsVersioned(sessionId);
        if (
          expectedRevision !== undefined &&
          loaded.revision !== expectedRevision
        ) {
          throw createRuntimeConflictError(
            `Session settings revision ${expectedRevision} is stale; current revision is ${loaded.revision}`,
            loaded.revision,
          );
        }
        const settings = applySessionSettingsPatch(loaded.value, patch);
        validate(settings);
        const updated = { revision: loaded.revision + 1, value: settings };
        persistence.saveSessionSettingsVersioned(sessionId, updated);
        publish(sessionId, updated, patch);
        return updated;
      });
    },
    async persistAutoModeEngine(sessionId, engine) {
      const optimistic =
        current.get(sessionId) ??
        persistence.loadSessionSettingsVersioned(sessionId);
      current.set(sessionId, {
        revision: optimistic.revision,
        value: { ...optimistic.value, autoModeEngine: engine },
      });
      await enqueue(sessionId, () => {
        const loaded = persistence.loadSessionSettingsVersioned(sessionId);
        if (loaded.value.autoModeEngine === engine) {
          current.set(sessionId, loaded);
          return;
        }
        const updated = {
          revision: loaded.revision + 1,
          value: { ...loaded.value, autoModeEngine: engine },
        };
        persistence.saveSessionSettingsVersioned(sessionId, updated);
        publish(sessionId, updated, { autoModeEngine: engine });
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        close: () => {
          listeners.delete(listener);
        },
      };
    },
    release(sessionId) {
      current.delete(sessionId);
      tails.delete(sessionId);
    },
  };
}

function createRuntimeSessionOperationGate(): RuntimeSessionOperationGate {
  const tails = new Map<string, Promise<void>>();
  let closed = false;
  return {
    run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("KodaX runtime is closed"));
      const previous = tails.get(sessionId) ?? Promise.resolve();
      const result = previous.then(operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(sessionId, tail);
      void tail.then(() => {
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return result;
    },
    async close() {
      closed = true;
      await Promise.all([...tails.values()]);
    },
  };
}

function createRuntimeSessionService(
  identity: RuntimeIdentity,
  configHome: string,
  manager: SessionManager,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  ensureOpen: () => void,
  activeRunOwner: (
    sessionId: string,
  ) => "local" | "foreign" | undefined,
  settingsOwner: RuntimeSessionSettingsOwner,
  listRuns: (sessionId: string) => Promise<readonly RuntimeRunStatus[]>,
  inspectRuns: (sessionId: string) => Promise<readonly RuntimeRunStatus[]>,
  inspectRun: (runId: string) => Promise<RuntimeRunStatus | undefined>,
  listPendingPermissions: (
    sessionId: string,
  ) => Promise<readonly RuntimePermissionRequest[]>,
  readAutoModeStats: (sessionId: string) => AutoModeStats | undefined,
  sessionOperations: RuntimeSessionOperationGate,
  withActorSessionFileMutation: <T>(
    sessionId: string,
    operation: "mutate" | "archive" | "unarchive" | "delete",
    mutation: (ownerId?: string) => Promise<T>,
  ) => Promise<T>,
  onSessionDeleted: (sessionId: string) => void,
  admission: RuntimeSessionAdmission,
  registerTranscriptSnapshotCleanup: (
    beginClose: () => void,
    cleanup: () => Promise<void>,
  ) => void,
): RuntimeSessionService {
  const creatingSessionIds = new Set<string>();
  const toRuntimeSession = (
    id: string,
    data: KodaXSessionData,
    createdAt?: string,
  ): RuntimeSession => ({
    id,
    title: data.title,
    ...(data.gitRoot ? { gitRoot: data.gitRoot } : {}),
    ...(data.runtimeInfo?.workspaceRoot
      ? { workspaceRoot: data.runtimeInfo.workspaceRoot }
      : {}),
    ...(data.runtimeInfo?.surface ? { surface: data.runtimeInfo.surface } : {}),
    ...(data.runtimeInfo?.profileId
      ? { profileId: data.runtimeInfo.profileId }
      : {}),
    ...(createdAt ? { createdAt } : {}),
  });
  type PreparedConversationPage = NonNullable<Awaited<
    ReturnType<SessionManager["storage"]["readConversationPageCache"]>
  >>;
  const toRuntimeConversationPage = (
    prepared: PreparedConversationPage,
  ): RuntimeConversationHistorySlice => ({
    revision: prepared.revision,
    sourceRevision: prepared.sourceRevision,
    status: prepared.status,
    issues: prepared.issues,
    entries: prepared.entries,
    hasMore: prepared.hasMore,
    ...(prepared.nextEnd !== undefined
      ? {
          nextCursor: encodeRuntimeTranscriptCursor({
            kind: "conversation_cache_page",
            view: "conversation",
            revision: prepared.revision,
            end: prepared.nextEnd,
          }),
        }
      : {}),
  });

  const transcriptSnapshots = new Map<
    string,
    {
      readonly sessionId: string;
      readonly view: RuntimeHistorySnapshotViewKind;
      readonly revision: string;
      readonly sourceRevision: string;
      readonly filePath: string;
      readonly entries: readonly RuntimeTranscriptSnapshotEntryDescriptor[];
      readonly conversation?: RuntimeConversationSnapshotMetadata;
      readonly expiresAt: number;
    }
  >();
  const transcriptRevisionBySource = new Map<string, string>();
  const sessionCaptureFlights = new Map<string, {
    readonly controller: AbortController;
    readonly promise: Promise<SessionReadCapture>;
    waiters: number;
    settled: boolean;
  }>();
  const transcriptMaterializationFlights = new Map<string, {
    readonly controller: AbortController;
    readonly promise: Promise<string>;
    waiters: number;
    settled: boolean;
  }>();
  const materializedSessionCaptureFlights = new Map<string, {
    readonly controller: AbortController;
    readonly sessionSeq: number;
    readonly sourceGeneration: number;
    readonly promise: Promise<{
      readonly capture: SessionReadCapture;
      readonly revision: string;
    }>;
    waiters: number;
    settled: boolean;
  }>();
  const materializedSessionSourceGenerations = new Map<string, number>();
  let transcriptSnapshotDiskBytes = 0;
  const transcriptSnapshotFileBytes = new Map<string, number>();
  const transcriptSnapshotMaterializingFiles = new Set<string>();
  const transcriptSnapshotOperations = new Set<Promise<unknown>>();
  let transcriptSnapshotIoCount = 0;
  let transcriptSnapshotDir: string | undefined;
  let transcriptSnapshotGeneration = 0;
  let transcriptSnapshotsClosing = false;
  let transcriptSnapshotsDisposed = false;
  const deferredTranscriptSnapshotCleanup = new Set<string>();
  const transcriptSnapshotReaders = new Map<string, number>();
  let transcriptSnapshotLeaseTimer: ReturnType<typeof setInterval> | undefined;
  const clearTranscriptSnapshotLease = (): void => {
    if (transcriptSnapshotLeaseTimer === undefined) return;
    clearInterval(transcriptSnapshotLeaseTimer);
    transcriptSnapshotLeaseTimer = undefined;
  };
  const refreshTranscriptSnapshotLease = (): void => {
    if (transcriptSnapshotDir === undefined) return;
    try {
      retryDeferredTranscriptSnapshotCleanup();
      pruneExpiredTranscriptSnapshots();
      const now = new Date();
      fs.utimesSync(transcriptSnapshotDir, now, now);
    } catch (error: unknown) {
      process.emitWarning(
        `Unable to refresh transcript snapshot lease: ${normalizeError(error).message}`,
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_LEASE_FAILED" },
      );
    }
  };
  const pruneStaleTranscriptSnapshotDirs = (): void => {
    const tempDir = os.tmpdir();
    const staleBefore = Date.now() - RUNTIME_TRANSCRIPT_SNAPSHOT_TTL_MS;
    try {
      for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
        if (
          !entry.isDirectory()
          || !entry.name.startsWith(RUNTIME_TRANSCRIPT_SNAPSHOT_DIR_PREFIX)
        ) {
          continue;
        }
        const candidate = path.join(tempDir, entry.name);
        if (fs.statSync(candidate).mtimeMs > staleBefore) continue;
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      process.emitWarning(
        `Unable to prune expired transcript snapshots: ${normalizeError(error).message}`,
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLEANUP_FAILED" },
      );
    }
  };
  const releaseTranscriptSnapshotBytes = (filePath: string): void => {
    const byteSize = transcriptSnapshotFileBytes.get(filePath);
    if (byteSize === undefined) return;
    transcriptSnapshotFileBytes.delete(filePath);
    transcriptSnapshotDiskBytes -= byteSize;
  };
  const trackTranscriptSnapshotOperation = <T>(
    operation: Promise<T>,
  ): Promise<T> => {
    transcriptSnapshotOperations.add(operation);
    void operation.then(
      () => transcriptSnapshotOperations.delete(operation),
      () => transcriptSnapshotOperations.delete(operation),
    );
    return operation;
  };
  const acquireTranscriptSnapshotIo = (): (() => void) => {
    if (transcriptSnapshotsClosing) {
      throw new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled because the Runtime is closing",
      );
    }
    if (
      transcriptSnapshotIoCount >= MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_FILES
    ) {
      throw createRuntimeSnapshotIoCapacityError();
    }
    transcriptSnapshotIoCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      transcriptSnapshotIoCount -= 1;
    };
  };
  const ensureTranscriptSnapshotDir = (): string => {
    if (transcriptSnapshotsClosing) {
      throw new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled because the Runtime is closing",
      );
    }
    let retainedDirAvailable = transcriptSnapshotDir === undefined;
    if (transcriptSnapshotDir !== undefined) {
      try {
        retainedDirAvailable = fs.statSync(transcriptSnapshotDir).isDirectory();
      } catch (error: unknown) {
        if (
          !isRecord(error)
          || (error.code !== "ENOENT" && error.code !== "ENOTDIR")
        ) {
          process.emitWarning(
            `Unable to inspect transcript snapshot directory: ${normalizeError(error).message}`,
            { code: "KODAX_TRANSCRIPT_SNAPSHOT_DIRECTORY_FAILED" },
          );
        }
        retainedDirAvailable = false;
      }
    }
    if (!retainedDirAvailable) {
      clearTranscriptSnapshotLease();
      transcriptSnapshots.clear();
      transcriptRevisionBySource.clear();
      for (const filePath of [...transcriptSnapshotFileBytes.keys()]) {
        if (transcriptSnapshotMaterializingFiles.has(filePath)) continue;
        if ((transcriptSnapshotReaders.get(filePath) ?? 0) > 0) {
          deferredTranscriptSnapshotCleanup.add(filePath);
          continue;
        }
        releaseTranscriptSnapshotBytes(filePath);
        deferredTranscriptSnapshotCleanup.delete(filePath);
      }
      transcriptSnapshotDir = undefined;
    }
    if (transcriptSnapshotDir === undefined) {
      pruneStaleTranscriptSnapshotDirs();
      transcriptSnapshotDir = fs.mkdtempSync(
        path.join(os.tmpdir(), RUNTIME_TRANSCRIPT_SNAPSHOT_DIR_PREFIX),
      );
      transcriptSnapshotGeneration += 1;
      transcriptSnapshotLeaseTimer = setInterval(
        refreshTranscriptSnapshotLease,
        Math.floor(RUNTIME_TRANSCRIPT_SNAPSHOT_TTL_MS / 2),
      );
      transcriptSnapshotLeaseTimer.unref?.();
    }
    return transcriptSnapshotDir;
  };
  const transcriptSnapshotKey = (
    sessionId: string,
    revision: string,
    view: RuntimeHistorySnapshotViewKind,
  ): string => `${view}\0${sessionId}\0${revision}`;
  const transcriptSourceKey = (
    sessionId: string,
    sourceRevision: string,
    view: RuntimeHistorySnapshotViewKind,
  ): string => `${view}\0${sessionId}\0${sourceRevision}`;
  const removeTranscriptSnapshotFile = (filePath: string): void => {
    if ((transcriptSnapshotReaders.get(filePath) ?? 0) > 0) {
      deferredTranscriptSnapshotCleanup.add(filePath);
      return;
    }
    try {
      fs.rmSync(filePath, { force: true });
      deferredTranscriptSnapshotCleanup.delete(filePath);
      releaseTranscriptSnapshotBytes(filePath);
    } catch (error: unknown) {
      deferredTranscriptSnapshotCleanup.add(filePath);
      process.emitWarning(
        `Unable to remove transcript snapshot: ${normalizeError(error).message}`,
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLEANUP_FAILED" },
      );
    }
  };
  const reserveTranscriptSnapshotBytes = (
    filePath: string,
    byteSize: number,
  ): void => {
    if (transcriptSnapshotsClosing) {
      throw new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled because the Runtime is closing",
      );
    }
    const currentFileBytes = transcriptSnapshotFileBytes.get(filePath) ?? 0;
    if (
      currentFileBytes + byteSize
        > MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES
    ) {
      throw createRuntimeSnapshotCapacityError();
    }
    while (
      transcriptSnapshotDiskBytes + byteSize
        > MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES
    ) {
      const oldest = transcriptSnapshots.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) {
        throw createRuntimeSnapshotCapacityError();
      }
      removeTranscriptSnapshot(oldest);
    }
    transcriptSnapshotFileBytes.set(
      filePath,
      currentFileBytes + byteSize,
    );
    transcriptSnapshotDiskBytes += byteSize;
  };
  const reserveTranscriptSnapshotFile = (filePath: string): void => {
    while (
      transcriptSnapshotFileBytes.size
        >= MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_FILES
    ) {
      const oldest = transcriptSnapshots.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) throw createRuntimeSnapshotCapacityError();
      removeTranscriptSnapshot(oldest);
    }
    transcriptSnapshotFileBytes.set(filePath, 0);
    try {
      reserveTranscriptSnapshotBytes(
        filePath,
        RUNTIME_TRANSCRIPT_SNAPSHOT_FILE_RESERVATION_BYTES,
      );
    } catch (error: unknown) {
      releaseTranscriptSnapshotBytes(filePath);
      throw error;
    }
  };
  const removeTranscriptSnapshot = (key: string): void => {
    const snapshot = transcriptSnapshots.get(key);
    if (snapshot === undefined) return;
    transcriptSnapshots.delete(key);
    const sourceKey = transcriptSourceKey(
      snapshot.sessionId,
      snapshot.sourceRevision,
      snapshot.view,
    );
    if (transcriptRevisionBySource.get(sourceKey) === snapshot.revision) {
      transcriptRevisionBySource.delete(sourceKey);
    }
    removeTranscriptSnapshotFile(snapshot.filePath);
  };
  const pruneExpiredTranscriptSnapshots = (): void => {
    const now = Date.now();
    for (const [key, snapshot] of transcriptSnapshots) {
      if (snapshot.expiresAt <= now) removeTranscriptSnapshot(key);
    }
  };
  const retryDeferredTranscriptSnapshotCleanup = (): void => {
    for (const filePath of deferredTranscriptSnapshotCleanup) {
      removeTranscriptSnapshotFile(filePath);
    }
  };
  const acquireTranscriptSnapshotReader = (
    filePath: string,
  ): (() => void) => {
    transcriptSnapshotReaders.set(
      filePath,
      (transcriptSnapshotReaders.get(filePath) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (transcriptSnapshotReaders.get(filePath) ?? 1) - 1;
      if (remaining > 0) {
        transcriptSnapshotReaders.set(filePath, remaining);
        return;
      }
      transcriptSnapshotReaders.delete(filePath);
      if (deferredTranscriptSnapshotCleanup.has(filePath)) {
        removeTranscriptSnapshotFile(filePath);
      }
    };
  };
  const readTranscriptSnapshot = async <T>(
    snapshot: RuntimeTranscriptSnapshotView,
    budget: RuntimeReadBudget,
    read: () => Promise<T>,
  ): Promise<T> => {
    const release = acquireTranscriptSnapshotReader(snapshot.filePath);
    let releaseIo: (() => void) | undefined;
    try {
      releaseIo = acquireTranscriptSnapshotIo();
    } catch (error: unknown) {
      release();
      throw error;
    }
    const operation = trackTranscriptSnapshotOperation(
      Promise.resolve().then(read),
    );
    const releaseResources = (): void => {
      release();
      releaseIo?.();
    };
    void operation.then(releaseResources, releaseResources);
    try {
      return await awaitRuntimeReadOperation(() => operation, budget);
    } catch (error: unknown) {
      if (isRuntimeTranscriptSnapshotInvalidError(error)) {
        const invalid = [...transcriptSnapshots.entries()].find(
          ([, candidate]) => candidate.filePath === snapshot.filePath,
        );
        if (invalid !== undefined) removeTranscriptSnapshot(invalid[0]);
      }
      throw error;
    }
  };
  const assertConversationSnapshotCurrent = async (
    sessionId: string,
    snapshot: RuntimeTranscriptSnapshotView,
    budget: RuntimeReadBudget,
  ): Promise<void> => {
    if (snapshot.conversation === undefined) {
      throw createRuntimeResyncError('Conversation snapshot metadata is unavailable');
    }
    let current: Awaited<ReturnType<
      SessionManager['storage']['readConversationPageBoundary']
    >>;
    try {
      current = await manager.storage.readConversationPageBoundary(
        sessionId,
        sessionReadOptionsFromBudget(budget),
      );
    } catch (error: unknown) {
      if (error instanceof replApi.SessionReadError && error.code === 'data_changed') {
        throw createRuntimeResyncError(error.message);
      }
      throw error;
    }
    if (current === null) {
      throw createRuntimeResyncError('Session moved or was removed; request a fresh boundary');
    }
    admission.assertCachedIdentity(sessionId, current.admission);
    if (current.boundaryRevision !== snapshot.conversation.boundaryRevision) {
      removeTranscriptSnapshot(transcriptSnapshotKey(
        sessionId,
        snapshot.revision,
        'conversation',
      ));
      throw createRuntimeResyncError('Conversation history changed; request a fresh boundary');
    }
  };
  const readSessionCaptureOnce = async (
    sessionId: string,
    budget: RuntimeReadBudget,
  ): Promise<SessionReadCapture> => {
    sessionReadOptionsFromBudget(budget);
    let flight = sessionCaptureFlights.get(sessionId);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = trackTranscriptSnapshotOperation(
        admission.captureRequired(sessionId, {
          signal: controller.signal,
        }),
      );
      flight = {
        controller,
        promise,
        waiters: 0,
        settled: false,
      };
      sessionCaptureFlights.set(sessionId, flight);
      const createdFlight = flight;
      const settle = (): void => {
        createdFlight.settled = true;
        if (sessionCaptureFlights.get(sessionId) === createdFlight) {
          sessionCaptureFlights.delete(sessionId);
        }
      };
      void promise.then(settle, settle);
    }
    flight.waiters += 1;
    try {
      return await awaitRuntimeReadOperation(() => flight!.promise, budget);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (sessionCaptureFlights.get(sessionId) === flight) {
          sessionCaptureFlights.delete(sessionId);
        }
        flight.controller.abort();
      }
    }
  };
  const readSessionCapture = async (
    sessionId: string,
    budget: RuntimeReadBudget,
  ): Promise<SessionReadCapture> => {
    for (
      let attempt = 0;
      attempt <= RUNTIME_SESSION_CAPTURE_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await readSessionCaptureOnce(sessionId, budget);
      } catch (error: unknown) {
        if (
          !(error instanceof replApi.SessionReadError)
          || error.code !== "data_changed"
        ) throw error;
        const delayMs = RUNTIME_SESSION_CAPTURE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) throw createRuntimeResyncError(error.message);
        await awaitRuntimeReadOperation(
          () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
          budget,
        );
      }
    }
    throw new Error("unreachable session capture retry state");
  };
  const materializeTranscriptSnapshot = async (
    sessionId: string,
    historyEntries: readonly RuntimeHistorySnapshotEntry[],
    sourceRevision: string,
    budget: RuntimeReadBudget,
    view: RuntimeHistorySnapshotViewKind,
    revisionContext = "",
    conversation?: RuntimeConversationSnapshotMetadata,
  ): Promise<string> => {
    if (transcriptSnapshotsClosing) {
      throw new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled because the Runtime is closing",
      );
    }
    pruneExpiredTranscriptSnapshots();
    const conversationMetadataBytes = conversation === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(conversation), "utf8");
    const snapshotDir = ensureTranscriptSnapshotDir();
    const snapshotGeneration = transcriptSnapshotGeneration;
    const filePath = path.join(
      snapshotDir,
      `${randomUUID()}.entries`,
    );
    const releaseIo = acquireTranscriptSnapshotIo();
    let snapshotByteSize =
      RUNTIME_TRANSCRIPT_SNAPSHOT_FILE_RESERVATION_BYTES
      + conversationMetadataBytes;
    try {
      for (
        let entryIndex = 0;
        entryIndex < historyEntries.length;
        entryIndex += 1
      ) {
        if (entryIndex > 0 && entryIndex % 256 === 0) {
          await yieldToRuntimeReadBudget(budget);
        }
        sessionReadOptionsFromBudget(budget);
        snapshotByteSize += Buffer.byteLength(
          JSON.stringify(historyEntries[entryIndex]!),
          "utf8",
        );
        if (snapshotByteSize > MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES) {
          throw createRuntimeSnapshotCapacityError();
        }
      }
    } catch (error: unknown) {
      releaseIo();
      throw error;
    }
    try {
      reserveTranscriptSnapshotFile(filePath);
      const remainingSnapshotBytes = snapshotByteSize
        - RUNTIME_TRANSCRIPT_SNAPSHOT_FILE_RESERVATION_BYTES;
      if (remainingSnapshotBytes > 0) {
        reserveTranscriptSnapshotBytes(filePath, remainingSnapshotBytes);
      }
    } catch (error: unknown) {
      releaseTranscriptSnapshotBytes(filePath);
      releaseIo();
      throw error;
    }
    transcriptSnapshotMaterializingFiles.add(filePath);
    const materialization = trackTranscriptSnapshotOperation(
      (async (): Promise<{
        readonly entries: readonly RuntimeTranscriptSnapshotEntryDescriptor[];
        readonly revision: string;
      }> => {
        const entries: RuntimeTranscriptSnapshotEntryDescriptor[] = [];
        const revisionHash = createHash("sha256");
        revisionHash.update(view === "transcript"
          ? "kodax-transcript-entries-v1\0"
          : "kodax-conversation-history-v1\0");
        if (revisionContext.length > 0) {
          revisionHash.update(`${Buffer.byteLength(revisionContext, "utf8")}:`);
          revisionHash.update(revisionContext);
        }
        const handle = await fs.promises.open(filePath, "wx");
        let offset = 0;
        let pendingWrites: Buffer[] = [];
        let pendingWriteBytes = 0;
        const flushPendingWrites = async (): Promise<void> => {
          if (pendingWriteBytes === 0) return;
          const batch = pendingWrites.length === 1
            ? pendingWrites[0]!
            : Buffer.concat(pendingWrites, pendingWriteBytes);
          pendingWrites = [];
          pendingWriteBytes = 0;
          await writeFileHandleFully(handle, batch);
          sessionReadOptionsFromBudget(budget);
        };
        try {
          for (
            let entryIndex = 0;
            entryIndex < historyEntries.length;
            entryIndex += 1
          ) {
            if (entryIndex > 0 && entryIndex % 256 === 0) {
              await yieldToRuntimeReadBudget(budget);
            }
            sessionReadOptionsFromBudget(budget);
            const entry = historyEntries[entryIndex]!;
            const encoded = Buffer.from(JSON.stringify(entry), "utf8");
            revisionHash.update(`${encoded.length}:`);
            revisionHash.update(encoded);
            const chunkDigests: string[] = [];
            for (
              let chunkOffset = 0;
              chunkOffset < encoded.length;
              chunkOffset += MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES
            ) {
              chunkDigests.push(createHash("sha256")
                .update(encoded.subarray(
                  chunkOffset,
                  Math.min(
                    encoded.length,
                    chunkOffset + MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES,
                  ),
                ))
                .digest("hex"));
            }
            entries.push({
              offset,
              byteLength: encoded.length,
              chunkDigests,
              ...runtimeHistoryEntryDescriptorIdentity(entry),
            });
            offset += encoded.length;
            pendingWrites.push(encoded);
            pendingWriteBytes += encoded.length;
            if (
              pendingWrites.length
                >= MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_WRITE_BATCH_ENTRIES
              || pendingWriteBytes
                >= MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_WRITE_BATCH_BYTES
            ) {
              await flushPendingWrites();
            }
          }
          await flushPendingWrites();
        } finally {
          await handle.close();
        }
        sessionReadOptionsFromBudget(budget);
        const revision = view === "conversation" && conversation !== undefined
          ? replApi.createSessionConversationHistoryRevision({
              sourceRevision: conversation.sourceRevision,
              status: conversation.status,
              issues: conversation.issues,
              entries: historyEntries as readonly SessionConversationHistoryEntry[],
            })
          : `sha256:${revisionHash.digest("hex")}`;
        return {
          entries,
          revision,
        };
      })(),
    );
    void materialization.then(
      () => {
        transcriptSnapshotMaterializingFiles.delete(filePath);
        releaseIo();
      },
      () => {
        transcriptSnapshotMaterializingFiles.delete(filePath);
        releaseIo();
      },
    );
    let materialized: {
      readonly entries: readonly RuntimeTranscriptSnapshotEntryDescriptor[];
      readonly revision: string;
    };
    try {
      materialized = await awaitRuntimeReadOperation(
        () => materialization,
        budget,
      );
      sessionReadOptionsFromBudget(budget);
    } catch (error: unknown) {
      void materialization.then(
        () => removeTranscriptSnapshotFile(filePath),
        (backgroundError: unknown) => {
          if (
            backgroundError !== error
            && !isExpectedRuntimeReadTermination(error)
            && !isExpectedRuntimeReadTermination(backgroundError)
          ) {
            process.emitWarning(
              `Transcript snapshot materialization failed after its caller stopped waiting: ${normalizeError(backgroundError).message}`,
              { code: "KODAX_TRANSCRIPT_SNAPSHOT_BACKGROUND_FAILED" },
            );
          }
          removeTranscriptSnapshotFile(filePath);
        },
      );
      throw normalizeRuntimeSnapshotMaterializationError(
        error,
        transcriptSnapshotsClosing,
      );
    }
    const { entries, revision } = materialized;
    if (transcriptSnapshotsClosing) {
      removeTranscriptSnapshotFile(filePath);
      throw new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled because the Runtime is closing",
      );
    }
    if (
      snapshotGeneration !== transcriptSnapshotGeneration
      || !fs.existsSync(filePath)
    ) {
      removeTranscriptSnapshotFile(filePath);
      throw createRuntimeResyncError(
        "Transcript snapshot directory changed; request a fresh boundary",
      );
    }
    const key = transcriptSnapshotKey(sessionId, revision, view);
    removeTranscriptSnapshot(key);
    transcriptSnapshots.set(key, {
      sessionId,
      view,
      revision,
      sourceRevision,
      filePath,
      entries,
      ...(conversation !== undefined ? { conversation } : {}),
      expiresAt: Date.now() + RUNTIME_TRANSCRIPT_SNAPSHOT_TTL_MS,
    });
    transcriptRevisionBySource.set(
      transcriptSourceKey(sessionId, sourceRevision, view),
      revision,
    );
    refreshTranscriptSnapshotLease();
    while (transcriptSnapshots.size > MAX_RUNTIME_TRANSCRIPT_SNAPSHOTS) {
      const oldest = transcriptSnapshots.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      removeTranscriptSnapshot(oldest);
    }
    return revision;
  };
  const getTranscriptSnapshot = (
    sessionId: string,
    revision: string,
    view: RuntimeHistorySnapshotViewKind = "transcript",
  ): RuntimeTranscriptSnapshotView | undefined => {
    const key = transcriptSnapshotKey(sessionId, revision, view);
    const snapshot = transcriptSnapshots.get(key);
    if (snapshot === undefined) return undefined;
    if (snapshot.expiresAt <= Date.now()) {
      removeTranscriptSnapshot(key);
      return undefined;
    }
    if (!fs.existsSync(snapshot.filePath)) {
      removeTranscriptSnapshot(key);
      return undefined;
    }
    transcriptSnapshots.delete(key);
    transcriptSnapshots.set(key, snapshot);
    return {
      revision: snapshot.revision,
      view: snapshot.view,
      sourceRevision: snapshot.sourceRevision,
      filePath: snapshot.filePath,
      entries: snapshot.entries,
      ...(snapshot.conversation !== undefined
        ? { conversation: snapshot.conversation }
        : {}),
    };
  };
  const rememberTranscriptSnapshot = async (
    sessionId: string,
    historyEntries: readonly RuntimeHistorySnapshotEntry[],
    sourceRevision: string,
    budget: RuntimeReadBudget,
    view: RuntimeHistorySnapshotViewKind = "transcript",
    revisionContext = "",
    conversation?: RuntimeConversationSnapshotMetadata,
  ): Promise<string> => {
    sessionReadOptionsFromBudget(budget);
    pruneExpiredTranscriptSnapshots();
    const sourceKey = transcriptSourceKey(sessionId, sourceRevision, view);
    const retainedRevision = transcriptRevisionBySource.get(sourceKey);
    if (
      retainedRevision !== undefined
      && getTranscriptSnapshot(sessionId, retainedRevision, view) !== undefined
    ) {
      return retainedRevision;
    }
    let flight = transcriptMaterializationFlights.get(sourceKey);
    if (flight === undefined) {
      const controller = new AbortController();
      const materializationBudget = createRuntimeReadBudget({
        signal: controller.signal,
      });
      const promise = materializeTranscriptSnapshot(
        sessionId,
        historyEntries,
        sourceRevision,
        materializationBudget,
        view,
        revisionContext,
        conversation,
      );
      flight = {
        controller,
        promise,
        waiters: 0,
        settled: false,
      };
      transcriptMaterializationFlights.set(sourceKey, flight);
      const createdFlight = flight;
      const settle = (): void => {
        createdFlight.settled = true;
        if (transcriptMaterializationFlights.get(sourceKey) === createdFlight) {
          transcriptMaterializationFlights.delete(sourceKey);
        }
      };
      void promise.then(settle, settle);
    }
    flight.waiters += 1;
    try {
      return await awaitRuntimeReadOperation(() => flight!.promise, budget);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (transcriptMaterializationFlights.get(sourceKey) === flight) {
          transcriptMaterializationFlights.delete(sourceKey);
        }
        flight.controller.abort();
      }
    }
  };
  const readMaterializedSessionCapture = async (
    sessionId: string,
    budget: RuntimeReadBudget,
  ): Promise<{
    readonly capture: SessionReadCapture;
    readonly revision: string;
    readonly lineage: ReturnType<typeof createSessionLineage>;
    readonly transcriptEntries: readonly SessionTranscriptEntry[];
  }> => {
    sessionReadOptionsFromBudget(budget);
    const sessionSeq = bus.currentSessionSeq(sessionId);
    const sourceGeneration =
      materializedSessionSourceGenerations.get(sessionId) ?? 0;
    let flight = materializedSessionCaptureFlights.get(sessionId);
    if (
      flight !== undefined
      && (
        flight.sessionSeq !== sessionSeq
        || flight.sourceGeneration !== sourceGeneration
      )
    ) {
      materializedSessionCaptureFlights.delete(sessionId);
      flight = undefined;
    }
    if (flight === undefined) {
      const controller = new AbortController();
      const sharedBudget = createRuntimeReadBudget({ signal: controller.signal });
      const promise = trackTranscriptSnapshotOperation((async () => {
        const capture = await readSessionCapture(sessionId, sharedBudget);
        const lineage = capture.transcript.lineage
          ?? createDeterministicRuntimeLegacyLineage(
            sessionId,
            capture.sourceRevision,
            capture.transcript.messages,
          );
        const transcriptEntries = capture.transcript.lineage === undefined
          ? lineage.entries.flatMap((entry): SessionTranscriptEntry[] => (
              entry.type === "message"
                ? [{
                    entryId: entry.id,
                    parentId: entry.parentId,
                    logicalId: entry.logicalId ?? entry.id,
                    ...(entry.sourceEntryId === undefined
                      ? {}
                      : { sourceEntryId: entry.sourceEntryId }),
                    timestamp: entry.timestamp,
                    type: "message",
                    message: entry.message,
                    active: true,
                  }]
                : []
            ))
          : capture.transcript.transcriptEntries;
        const revision = await rememberTranscriptSnapshot(
          sessionId,
          transcriptEntries,
          capture.sourceRevision,
          sharedBudget,
        );
        return { capture, revision, lineage, transcriptEntries };
      })());
      flight = {
        controller,
        sessionSeq,
        sourceGeneration,
        promise,
        waiters: 0,
        settled: false,
      };
      materializedSessionCaptureFlights.set(sessionId, flight);
      const createdFlight = flight;
      const settle = (): void => {
        createdFlight.settled = true;
        if (materializedSessionCaptureFlights.get(sessionId) === createdFlight) {
          materializedSessionCaptureFlights.delete(sessionId);
        }
      };
      void promise.then(settle, settle);
    }
    flight.waiters += 1;
    try {
      return await awaitRuntimeReadOperation(() => flight!.promise, budget);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (materializedSessionCaptureFlights.get(sessionId) === flight) {
          materializedSessionCaptureFlights.delete(sessionId);
        }
        flight.controller.abort();
      }
    }
  };
  const invalidateMaterializedSessionCapture = (sessionId: string): void => {
    materializedSessionSourceGenerations.set(
      sessionId,
      (materializedSessionSourceGenerations.get(sessionId) ?? 0) + 1,
    );
    materializedSessionCaptureFlights.delete(sessionId);
  };
  const finalizeTranscriptSnapshots = (): void => {
    if (transcriptSnapshotsDisposed) return;
    for (const key of [...transcriptSnapshots.keys()]) {
      removeTranscriptSnapshot(key);
    }
    if (transcriptSnapshotDir !== undefined) {
      fs.rmSync(transcriptSnapshotDir, { recursive: true, force: true });
      transcriptSnapshotDir = undefined;
    }
    transcriptSnapshotDiskBytes = 0;
    transcriptSnapshotFileBytes.clear();
    transcriptRevisionBySource.clear();
    transcriptSnapshotMaterializingFiles.clear();
    transcriptSnapshotIoCount = 0;
    transcriptSnapshotReaders.clear();
    deferredTranscriptSnapshotCleanup.clear();
    transcriptSnapshotsDisposed = true;
  };
  const retryDeferredTranscriptSnapshotFinalization = (
    attempt = 1,
  ): void => {
    try {
      finalizeTranscriptSnapshots();
    } catch (error: unknown) {
      process.emitWarning(
        `Deferred transcript snapshot cleanup failed: ${normalizeError(error).message}`,
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLEANUP_FAILED" },
      );
      if (attempt >= 3) return;
      const timer = setTimeout(
        () => retryDeferredTranscriptSnapshotFinalization(attempt + 1),
        attempt * 100,
      );
      timer.unref?.();
    }
  };
  const beginCloseTranscriptSnapshots = (): void => {
    transcriptSnapshotsClosing = true;
    clearTranscriptSnapshotLease();
    for (const flight of sessionCaptureFlights.values()) {
      flight.controller.abort();
    }
    sessionCaptureFlights.clear();
    for (const flight of transcriptMaterializationFlights.values()) {
      flight.controller.abort();
    }
    transcriptMaterializationFlights.clear();
    for (const flight of materializedSessionCaptureFlights.values()) {
      flight.controller.abort();
    }
    materializedSessionCaptureFlights.clear();
    materializedSessionSourceGenerations.clear();
  };
  const disposeTranscriptSnapshots = async (): Promise<void> => {
    beginCloseTranscriptSnapshots();
    const operations = Promise.allSettled([...transcriptSnapshotOperations]);
    let drained = false;
    await Promise.race([
      operations.then(() => {
        drained = true;
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          RUNTIME_TRANSCRIPT_SNAPSHOT_CLOSE_DRAIN_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (drained) {
      finalizeTranscriptSnapshots();
      return;
    }
    process.emitWarning(
      "Runtime closed while transcript snapshot I/O was still pending; temporary files will be cleaned after the I/O settles.",
      { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLOSE_DEFERRED" },
    );
    void operations.then(() => retryDeferredTranscriptSnapshotFinalization());
  };
  registerTranscriptSnapshotCleanup(
    beginCloseTranscriptSnapshots,
    disposeTranscriptSnapshots,
  );

  const captureObservationSnapshot = async (
    sessionId: string,
    options?: RuntimeReadOptions,
  ): Promise<RuntimeSessionObservationSnapshot> => {
    const budget = createRuntimeReadBudget(options);
    for (
      let attempt = 0;
      attempt < MAX_RUNTIME_SNAPSHOT_ATTEMPTS;
      attempt += 1
    ) {
      const before = bus.currentSessionSeq(sessionId);
      const [materialized, runs, pendingPermissions] = await Promise.all([
        readMaterializedSessionCapture(sessionId, budget),
        awaitRuntimeReadOperation(() => listRuns(sessionId), budget),
        awaitRuntimeReadOperation(
          () => listPendingPermissions(sessionId),
          budget,
        ),
      ]);
      const settings = await awaitRuntimeReadOperation(
        () => settingsOwner.read(sessionId),
        budget,
      );
      const { capture, revision: transcriptRevision } = materialized;
      sessionReadOptionsFromBudget(budget);
      const after = bus.currentSessionSeq(sessionId);
      if (before !== after) continue;
      const retainedTranscript = getTranscriptSnapshot(
        sessionId,
        transcriptRevision,
      );
      if (retainedTranscript === undefined) {
        throw createRuntimeResyncError(
          "Transcript snapshot is no longer retained; request a fresh boundary",
        );
      }
      const transcriptSlice = await readTranscriptSnapshot(
        retainedTranscript,
        budget,
        () => createRuntimeTranscriptSlice(retainedTranscript, budget),
      );
      return {
        runtimeId: identity.runtimeId,
        cursor: after,
        transcriptRevision,
        session: toRuntimeSession(sessionId, capture.data),
        transcript: transcriptSlice,
        settings,
        runs,
        pendingPermissions,
        live: bus.projectSession(sessionId),
      };
    }
    throw createRuntimeResyncError(
      `Session ${sessionId} changed continuously while taking a snapshot`,
    );
  };

  const captureDiagnosticBoundary = async (
    input: RuntimeSessionDiagnosticsInput,
  ): Promise<RuntimeSessionDiagnosticBoundary> => {
    const budget = createRuntimeReadBudget(input);
    for (
      let attempt = 0;
      attempt < MAX_RUNTIME_SNAPSHOT_ATTEMPTS;
      attempt += 1
    ) {
      const before = bus.currentSessionSeq(input.sessionId);
      const [capture, inspectedRuns] = await Promise.all([
        readSessionCapture(input.sessionId, budget),
        awaitRuntimeReadOperation(
          () => input.runId === undefined
            ? inspectRuns(input.sessionId)
            : inspectRun(input.runId).then((run) => run === undefined ? [] : [run]),
          budget,
        ),
      ]);
      sessionReadOptionsFromBudget(budget);
      const after = bus.currentSessionSeq(input.sessionId);
      if (before !== after) continue;
      return {
        runtimeId: identity.runtimeId,
        cursor: after,
        transcriptRevision: createRuntimeTranscriptRevision(capture.transcript),
        runs: inspectedRuns.filter((run) => run.sessionId === input.sessionId),
      };
    }
    throw createRuntimeResyncError(
      `Session ${input.sessionId} changed continuously while taking a diagnostic snapshot`,
    );
  };

  const mutateActiveSession = <T>(
    sessionId: string,
    mutation: (data: KodaXSessionData) => Promise<T>,
  ): Promise<T> =>
    sessionOperations.run(sessionId, async () => {
      ensureOpen();
      const data = await admission.loadExecutable(sessionId);
      try {
        return await withActorSessionFileMutation(
          sessionId,
          "mutate",
          () => mutation(data),
        );
      } finally {
        invalidateMaterializedSessionCapture(sessionId);
      }
    });

  return {
    async create(input = {}) {
      ensureOpen();
      admission.assertCreate(input);
      const sessionId = input.sessionId ?? (await generateSessionId());
      if (creatingSessionIds.has(sessionId)) {
        throw Object.assign(new Error(`Session already exists: ${sessionId}`), {
          code: "conflict" as const,
        });
      }
      creatingSessionIds.add(sessionId);
      try {
        if (input.sessionId !== undefined && (await manager.loadSession(sessionId)) !== null) {
          throw Object.assign(
            new Error(`Session already exists: ${sessionId}`),
            {
              code: "conflict" as const,
            },
          );
        }
        const projectPath = input.projectPath
          ? path.resolve(input.projectPath)
          : undefined;
        const gitRoot = input.gitRoot
          ? path.resolve(input.gitRoot)
          : projectPath;
        const runtimeInfo = buildSessionRuntimeInfo(
          input,
          projectPath,
          gitRoot,
        );
        const data: KodaXSessionData = {
          messages: [],
          title: input.title ?? "",
          gitRoot: gitRoot ?? "",
          ...(input.tag !== undefined ? { tag: input.tag } : {}),
          ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
          scope: "user",
        };
        if (input.sessionId === undefined) {
          await manager.storage.createGenerated(sessionId, data);
        } else {
          await manager.storage.save(sessionId, data);
        }
        const session = toRuntimeSession(
          sessionId,
          data,
          new Date().toISOString(),
        );
        bus.emit("session.created", session, { sessionId, runId: sessionId });
        return session;
      } finally {
        creatingSessionIds.delete(sessionId);
      }
    },

    async load(sessionId, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      const data = await admission.loadRequired(
        sessionId,
        sessionReadOptionsFromBudget(budget),
      );
      return toRuntimeSession(sessionId, data);
    },

    async list(filter) {
      ensureOpen();
      admission.assertFilter(filter);
      const summaries = await manager.listSessions(filter);
      return summaries
        .filter(admission.admitsSummary)
        .map(toRuntimeSessionSummary);
    },

    async status(sessionId) {
      ensureOpen();
      await admission.loadRequired(sessionId);
      const runs = await listRuns(sessionId);
      const run = authoritativeSessionRun(runs);
      return {
        sessionId,
        runtimeId: identity.runtimeId,
        observedAt: new Date().toISOString(),
        phase: run?.phase ?? "idle",
        ...(run !== undefined ? { runId: run.runId } : {}),
      };
    },

    async transcript(sessionId, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      return structuredClone(
        (await readSessionCapture(sessionId, budget)).transcript,
      );
    },

    async transcriptPage(input, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      sessionReadOptionsFromBudget(budget);
      const cursorRevision =
        input.cursor === undefined
          ? undefined
          : decodeRuntimeTranscriptCursor(input.cursor).revision;
      if (cursorRevision !== undefined) {
        const snapshot = getTranscriptSnapshot(
          input.sessionId,
          cursorRevision,
        );
        if (snapshot === undefined) {
          throw createRuntimeResyncError(
            "Transcript snapshot is no longer retained; request a fresh boundary",
          );
        }
        return readTranscriptSnapshot(
          snapshot,
          budget,
          () => createRuntimeTranscriptSlice(
            snapshot,
            budget,
            input.cursor,
            input.limit,
          ),
        );
      }
      const materialized = await readMaterializedSessionCapture(
        input.sessionId,
        budget,
      );
      const capture = materialized.capture;
      const transcript = capture.transcript;
      const revision = materialized.revision;
      const retained = getTranscriptSnapshot(input.sessionId, revision);
      if (retained === undefined) {
        throw createRuntimeResyncError(
          "Transcript snapshot is no longer retained; request a fresh boundary",
        );
      }
      return readTranscriptSnapshot(
        retained,
        budget,
        () => createRuntimeTranscriptSlice(
          retained,
          budget,
          undefined,
          input.limit,
        ),
      );
    },

    async transcriptEntryChunk(input, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      sessionReadOptionsFromBudget(budget);
      const transcript = getTranscriptSnapshot(
        input.sessionId,
        input.revision,
      );
      if (transcript === undefined) {
        throw createRuntimeResyncError(
          "Transcript snapshot is no longer retained; request a fresh boundary",
        );
      }
      return readTranscriptSnapshot(
        transcript,
        budget,
        () => createRuntimeTranscriptEntryChunkFromSnapshot(
          input,
          transcript,
          budget,
        ),
      );
    },

    async transcriptSearch(input, options) {
      ensureOpen();
      validateSessionHistorySearchQuery(input.query);
      const budget = createRuntimeReadBudget(options);
      const materialized = await readMaterializedSessionCapture(
        input.sessionId,
        budget,
      );
      const capture = materialized.capture;
      const transcript = capture.transcript;
      const revision = materialized.revision;
      await yieldToRuntimeReadBudget(budget);
      const lineage = materialized.lineage;
      const search = await searchSessionHistoryCooperatively(
        lineage,
        {
          query: input.query,
          limit: input.limit,
          role: input.role,
          scope: input.scope,
        },
        {
          revision,
          checkpoint() {
            sessionReadOptionsFromBudget(budget);
          },
          yieldControl() {
            return yieldToRuntimeReadBudget(budget);
          },
        },
      );
      sessionReadOptionsFromBudget(budget);
      const entryIndexById = new Map<string, number>();
      for (
        let entryIndex = 0;
        entryIndex < materialized.transcriptEntries.length;
        entryIndex += 1
      ) {
        if (entryIndex % 256 === 0) {
          await yieldToRuntimeReadBudget(budget);
        }
        const entryId = materialized.transcriptEntries[entryIndex]?.entryId;
        if (entryId !== undefined) entryIndexById.set(entryId, entryIndex);
      }
      sessionReadOptionsFromBudget(budget);
      const hits = search.hits.flatMap((hit): RuntimeTranscriptSearchHit[] => {
        const entryIndex = entryIndexById.get(hit.entryId);
        return entryIndex === undefined ? [] : [{ ...hit, entryIndex }];
      });
      sessionReadOptionsFromBudget(budget);
      return {
        revision,
        hits,
      };
    },

    async conversation(sessionId, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      const capture = await readSessionCapture(sessionId, budget);
      sessionReadOptionsFromBudget(budget);
      const history = replApi.conversationHistoryFromCapture(
        capture,
        () => sessionReadOptionsFromBudget(budget),
      );
      await yieldToRuntimeReadBudget(budget);
      const revision = createRuntimeConversationHistoryRevision(history);
      sessionReadOptionsFromBudget(budget);
      const result = structuredClone({ ...history, revision });
      sessionReadOptionsFromBudget(budget);
      return result;
    },

    async conversationPage(input, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      sessionReadOptionsFromBudget(budget);
      const limit = input.limit ?? DEFAULT_RUNTIME_TRANSCRIPT_PAGE_LIMIT;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("transcript page limit must be a positive safe integer");
      }
      const normalizedLimit = Math.min(limit, MAX_RUNTIME_TRANSCRIPT_PAGE_LIMIT);
      const parsedCursor = input.cursor === undefined
        ? undefined
        : decodeRuntimeTranscriptCursor(input.cursor);
      if (
        parsedCursor === undefined
        || parsedCursor.kind === "conversation_cache_page"
      ) {
        try {
          const prepared = await manager.storage.readConversationPageCache(
            input.sessionId,
            {
              ...(parsedCursor?.kind === "conversation_cache_page"
                ? {
                    expectedRevision: parsedCursor.revision,
                    end: parsedCursor.end,
                  }
                : {}),
              limit: normalizedLimit,
              maxPageBytes: MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES,
              maxInlineEntryBytes: MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES,
              reservedBytes: 0,
              authorize: (identity) => admission.assertCachedIdentity(
                input.sessionId,
                identity,
              ),
            },
            sessionReadOptionsFromBudget(budget),
          );
          if (prepared !== null) {
            return toRuntimeConversationPage(prepared);
          }
        } catch (error: unknown) {
          if (error instanceof replApi.ConversationPageCacheCapacityError) {
            throw createRuntimeHistoryPageCapacityError();
          }
          if (
            error instanceof replApi.SessionReadError
            && error.code === "data_changed"
          ) {
            throw createRuntimeResyncError(error.message);
          }
          throw error;
        }
      }
      const cursorRevision = parsedCursor === undefined
        ? undefined
        : parsedCursor.revision;
      if (cursorRevision !== undefined) {
        const snapshot = getTranscriptSnapshot(
          input.sessionId,
          cursorRevision,
          "conversation",
        );
        if (snapshot === undefined) {
          throw createRuntimeResyncError(
            "Conversation snapshot is no longer retained; request a fresh boundary",
          );
        }
        await assertConversationSnapshotCurrent(input.sessionId, snapshot, budget);
        return readTranscriptSnapshot(
          snapshot,
          budget,
          () => createRuntimeConversationHistorySlice(
            snapshot,
            budget,
            input.cursor,
            input.limit,
          ),
        );
      }
      const capture = await readSessionCapture(input.sessionId, budget);
      sessionReadOptionsFromBudget(budget);
      const history = replApi.conversationHistoryFromCapture(
        capture,
        () => sessionReadOptionsFromBudget(budget),
      );
      if (capture.transcript.lineage !== undefined) {
        try {
          await manager.storage.prepareConversationPageCache(
            input.sessionId,
            history,
            capture.transcript.lineage,
            capture.data.runtimeInfo,
            capture.boundaryRevision,
            capture.sourceRevisionState,
            sessionReadOptionsFromBudget(budget),
          );
          const prepared = await manager.storage.readConversationPageCache(
            input.sessionId,
            {
              limit: normalizedLimit,
              maxPageBytes: MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES,
              maxInlineEntryBytes: MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES,
              reservedBytes: 0,
              authorize: (identity) => admission.assertCachedIdentity(
                input.sessionId,
                identity,
              ),
            },
            sessionReadOptionsFromBudget(budget),
          );
          if (prepared !== null) return toRuntimeConversationPage(prepared);
        } catch (error: unknown) {
          if (error instanceof replApi.ConversationPageCacheCapacityError) {
            throw createRuntimeHistoryPageCapacityError();
          }
          if (
            error instanceof replApi.SessionReadError
            && error.code === "data_changed"
          ) {
            throw createRuntimeResyncError(error.message);
          }
          process.emitWarning(
            `Unable to prepare bounded Conversation pages: ${normalizeError(error).message}`,
            { code: "KODAX_CONVERSATION_PAGE_CACHE_FAILED" },
          );
        }
      }
      const metadata: RuntimeConversationSnapshotMetadata = {
        sourceRevision: history.sourceRevision,
        status: history.status,
        issues: history.issues,
        boundaryRevision: capture.boundaryRevision,
      };
      const revision = await rememberTranscriptSnapshot(
        input.sessionId,
        history.entries,
        history.sourceRevision,
        budget,
        "conversation",
        runtimeConversationRevisionContext(history),
        metadata,
      );
      const retained = getTranscriptSnapshot(
        input.sessionId,
        revision,
        "conversation",
      );
      if (retained === undefined) {
        throw createRuntimeResyncError(
          "Conversation snapshot is no longer retained; request a fresh boundary",
        );
      }
      return readTranscriptSnapshot(
        retained,
        budget,
        () => createRuntimeConversationHistorySlice(
          retained,
          budget,
          undefined,
          input.limit,
        ),
      );
    },

    async conversationEntryChunk(input, options) {
      ensureOpen();
      const budget = createRuntimeReadBudget(options);
      sessionReadOptionsFromBudget(budget);
      if (!Number.isSafeInteger(input.entryIndex) || input.entryIndex < 0) {
        throw new Error(`Transcript entry index is out of range: ${input.entryIndex}`);
      }
      const snapshot = getTranscriptSnapshot(
        input.sessionId,
        input.revision,
        "conversation",
      );
      if (snapshot !== undefined) {
        await assertConversationSnapshotCurrent(input.sessionId, snapshot, budget);
        return readTranscriptSnapshot(
          snapshot,
          budget,
          () => createRuntimeConversationEntryChunkFromSnapshot(
            input,
            snapshot,
            budget,
          ),
        );
      }
      let offset = 0;
      if (input.cursor !== undefined) {
        const parsed = decodeRuntimeTranscriptCursor(input.cursor);
        if (
          parsed.kind !== "entry"
          || parsed.view !== "conversation"
          || parsed.revision !== input.revision
          || parsed.entryIndex !== input.entryIndex
        ) {
          throw createRuntimeResyncError("Conversation entry cursor is stale");
        }
        offset = parsed.offset;
      }
      try {
        const prepared = await manager.storage.readConversationPageCacheChunk(
          input.sessionId,
          {
            revision: input.revision,
            entryIndex: input.entryIndex,
            offset,
            authorize: (identity) => admission.assertCachedIdentity(
              input.sessionId,
              identity,
            ),
          },
          sessionReadOptionsFromBudget(budget),
        );
        if (prepared !== null) {
          const hasMore = prepared.nextOffset !== undefined;
          return {
            revision: prepared.revision,
            entryIndex: prepared.entryIndex,
            ...(prepared.boundaryId !== undefined
              ? { boundaryId: prepared.boundaryId }
              : {}),
            encoding: "base64-json",
            data: prepared.data.toString("base64"),
            hasMore,
            ...(prepared.nextOffset !== undefined
              ? {
                  nextCursor: encodeRuntimeTranscriptCursor({
                    kind: "entry",
                    view: "conversation",
                    revision: prepared.revision,
                    entryIndex: prepared.entryIndex,
                    offset: prepared.nextOffset,
                  }),
                }
              : {}),
          };
        }
      } catch (error: unknown) {
        if (
          error instanceof replApi.SessionReadError
          && error.code === "data_changed"
        ) {
          throw createRuntimeResyncError(error.message);
        }
        throw error;
      }
      throw createRuntimeResyncError(
        "Conversation snapshot is no longer retained; request a fresh boundary",
      );
    },

    async observe(sessionId, listener, options) {
      ensureOpen();
      const pending: RuntimeEvent[] = [];
      let cursor: number | undefined;
      let closed = false;
      let live = false;
      let overflowed = false;
      let invalidated = false;
      let resolveInvalidated:
        | ((value: RuntimeObservationInvalidation) => void)
        | undefined;
      let runtimeCloseSubscription: RuntimeSubscription | undefined;
      const invalidation = new Promise<RuntimeObservationInvalidation>(
        (resolve) => {
          resolveInvalidated = resolve;
        },
      );
      const invalidate = (
        reason: RuntimeObservationInvalidation["reason"],
        message: string,
      ): void => {
        if (closed || invalidated) return;
        invalidated = true;
        subscription.close();
        runtimeCloseSubscription?.close();
        resolveInvalidated?.({
          code: "observation_invalidated",
          reason,
          runtimeId: identity.runtimeId,
          message,
        });
      };
      const deliver = (event: RuntimeEvent): void => {
        if (closed || invalidated) return;
        if (cursor !== undefined && event.seq < cursor) {
          if (!live) return;
          invalidate(
            "event_order",
            `Session observation event order regressed from ${cursor} to ${event.seq}.`,
          );
          return;
        }
        if (cursor !== undefined && event.seq === cursor) return;
        cursor = event.seq;
        try {
          listener(event);
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: "runtime.sessions.observe",
            level: "error",
            message: `Session observation listener failed for ${event.type}`,
            detail: normalizeError(error),
          });
          invalidate(
            "delivery_failed",
            `Session observation listener failed while delivering ${event.type}; discard local state and resync.`,
          );
        }
      };
      const subscription = bus.service.subscribe({ sessionId }, (event) => {
        if (!live) {
          if (pending.length >= MAX_RUNTIME_OBSERVATION_HANDOFF_EVENTS) {
            overflowed = true;
            invalidate(
              "event_overflow",
              "Session observation handoff overflowed; acquire a fresh snapshot.",
            );
            return;
          }
          pending.push(event);
        } else {
          deliver(event);
        }
      });
      runtimeCloseSubscription = bus.subscribeClose(() => {
        invalidate(
          "runtime_changed",
          "Runtime closed; discard the observation and resync after reconnecting.",
        );
      });
      try {
        const snapshot = await captureObservationSnapshot(sessionId, options);
        if (overflowed) {
          throw createRuntimeResyncError(
            "Session observation handoff overflowed; acquire a fresh snapshot",
          );
        }
        cursor = snapshot.cursor;
        const observation: RuntimeSessionObservation = {
          snapshot,
          invalidated: invalidation,
          close() {
            if (closed) return;
            closed = true;
            pending.length = 0;
            subscription.close();
            runtimeCloseSubscription?.close();
          },
        };
        queueMicrotask(() => queueMicrotask(() => {
          if (closed || invalidated) return;
          while (pending.length > 0) {
            const batch = pending
              .splice(0)
              .sort((left, right) => left.seq - right.seq);
            for (const event of batch) deliver(event);
          }
          live = true;
        }));
        return observation;
      } catch (error: unknown) {
        closed = true;
        subscription.close();
        runtimeCloseSubscription?.close();
        throw error;
      }
    },

    async diagnostics(input) {
      ensureOpen();
      const captureStartedAt = new Date().toISOString();
      const boundary = await captureDiagnosticBoundary(input);
      return createRuntimeSessionDiagnosticsRecord(
        identity,
        input,
        boundary,
        captureStartedAt,
      );
    },

    async fork(input) {
      ensureOpen();
      if (input.selector !== undefined && input.historyBoundary !== undefined) {
        throw new Error("fork accepts either selector or historyBoundary, not both");
      }
      const source = await admission.loadRequired(input.sessionId);
      let forked: Awaited<ReturnType<SessionManager["forkSession"]>>;
      try {
        forked = input.historyBoundary === undefined
          ? await manager.forkSession(input.sessionId, {
              ...(input.selector !== undefined ? { selector: input.selector } : {}),
              ...(input.newSessionId !== undefined
                ? { sessionId: input.newSessionId }
                : {}),
              ...(input.title !== undefined ? { title: input.title } : {}),
            })
          : await manager.storage.fork(
              input.sessionId,
              input.historyBoundary.entryId,
              {
                ...(input.newSessionId !== undefined
                  ? { sessionId: input.newSessionId }
                  : {}),
                ...(input.title !== undefined ? { title: input.title } : {}),
                historyBoundary: {
                  sourceRevision: input.historyBoundary.sourceRevision,
                },
              },
            );
      } catch (error: unknown) {
        throw normalizeConversationBoundaryMutationError(error);
      }
      if (!forked && input.historyBoundary !== undefined) return null;
      if (!forked) {
        const sessionId = input.newSessionId ?? (await generateSessionId());
        const data: KodaXSessionData = {
          ...source,
          title: input.title ?? source.title,
          messages: source.messages.map(cloneMessage),
          actorSnapshot: undefined,
        };
        await manager.storage.save(sessionId, data);
        const session = toRuntimeSession(sessionId, data);
        bus.emit("session.created", session, { sessionId, runId: sessionId });
        return session;
      }
      const session = toRuntimeSession(forked.sessionId, forked.data);
      bus.emit("session.created", session, {
        sessionId: forked.sessionId,
        runId: forked.sessionId,
      });
      return session;
    },

    async getSettingsVersioned(sessionId) {
      ensureOpen();
      await admission.loadRequired(sessionId);
      return settingsOwner.read(sessionId);
    },

    async getSettings(sessionId) {
      return (await this.getSettingsVersioned(sessionId)).value;
    },

    async getAutoModeStats(sessionId) {
      ensureOpen();
      await admission.loadRequired(sessionId);
      const settings = (await settingsOwner.read(sessionId)).value;
      if (replApi.normalizePermissionMode(settings.permissionMode) !== "auto") {
        return undefined;
      }
      const live = readAutoModeStats(sessionId);
      return {
        engine: settings.autoModeEngine ?? live?.engine ?? "llm",
        ...(settings.autoModeClassifierModel !== undefined
          ? { classifierModel: settings.autoModeClassifierModel }
          : {}),
        classifierHealth: live?.classifierHealth ?? "healthy",
        denials: live?.denials ?? createAutoModeDenialTracker(),
        breaker: live?.breaker ?? createCircuitBreaker(),
      };
    },

    async updateSettings(sessionId, patch) {
      return mutateActiveSession(sessionId, async (sessionData) => (
        await settingsOwner.update(
          sessionId,
          patch,
          undefined,
          (settings) => assertSessionSettingsAllowed(sessionData, settings),
        )
      ).value);
    },

    async updateSettingsVersioned(sessionId, patch, options) {
      return mutateActiveSession(
        sessionId,
        (sessionData) => settingsOwner.update(
          sessionId,
          patch,
          options.expectedRevision,
          (settings) => assertSessionSettingsAllowed(sessionData, settings),
        ),
      );
    },

    async appendNotice(input) {
      return mutateActiveSession(input.sessionId, async () => {
        const entry = await manager.appendClientNotice(input.sessionId, {
          content: input.content,
          ...(input.source !== undefined ? { source: input.source } : {}),
        });
        if (entry) {
          bus.emit(
            "session.notice.appended",
            {
              sessionId: input.sessionId,
              entry,
            },
            { sessionId: input.sessionId, runId: input.sessionId },
          );
        }
        return entry;
      });
    },

    async rewind(input) {
      return mutateActiveSession(input.sessionId, async () => {
        assertSessionMutationAllowed(input.sessionId, activeRunOwner);
        if (input.selector !== undefined && input.historyBoundary !== undefined) {
          throw new Error("rewind accepts either selector or historyBoundary, not both");
        }
        let data: KodaXSessionData | null;
        try {
          data = input.historyBoundary === undefined
            ? await manager.rewindSession(input.sessionId, {
                ...(input.selector !== undefined ? { selector: input.selector } : {}),
              })
            : await manager.storage.rewind(
                input.sessionId,
                input.historyBoundary.entryId,
                {
                  historyBoundary: {
                    sourceRevision: input.historyBoundary.sourceRevision,
                  },
                },
              );
        } catch (error: unknown) {
          throw normalizeConversationBoundaryMutationError(error);
        }
        if (!data) return null;
        const session = toRuntimeSession(input.sessionId, data);
        bus.emit(
          "session.rewound",
          {
            sessionId: input.sessionId,
            selector: input.selector,
            session,
          },
          { sessionId: input.sessionId, runId: input.sessionId },
        );
        return session;
      });
    },

    async setActiveEntry(input) {
      return mutateActiveSession(input.sessionId, async () => {
        assertSessionMutationAllowed(input.sessionId, activeRunOwner);
        const data = await manager.setActiveEntry(
          input.sessionId,
          input.entryId,
        );
        if (!data) return null;
        const session = toRuntimeSession(input.sessionId, data);
        bus.emit(
          "session.active_entry.updated",
          {
            sessionId: input.sessionId,
            entryId: input.entryId,
            session,
          },
          { sessionId: input.sessionId, runId: input.sessionId },
        );
        return session;
      });
    },

    async compact(input) {
      return mutateActiveSession(input.sessionId, async (admitted) => {
        assertSessionMutationAllowed(input.sessionId, activeRunOwner);
        const startedAt = Date.now();
        const beforeRevision =
          admitted.lineage?.entries.filter(
            (entry) => entry.type === "compaction",
          ).length ?? 0;
        bus.emit(
          "context.compaction.started",
          {
            meta: {
              contextId: input.sessionId,
              contextKind: "root",
              contextRevision: beforeRevision,
            },
          },
          { sessionId: input.sessionId, runId: input.sessionId },
        );
        let finalRevision = beforeRevision;
        try {
          const settings = (await settingsOwner.read(input.sessionId)).value;
          const result = await manager.compactSession(input.sessionId, {
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.customInstructions !== undefined
            ? { customInstructions: input.customInstructions }
            : {}),
          ...(input.contextWindow !== undefined
            ? { contextWindow: input.contextWindow }
            : {}),
          ...((input.triggerPercent ?? settings.compactionTriggerPercent) !==
          undefined
            ? {
                triggerPercent:
                  input.triggerPercent ?? settings.compactionTriggerPercent,
              }
            : {}),
          ...((input.triggerTokens ?? settings.compactionTriggerTokens) !==
          undefined
            ? {
                triggerTokens:
                  input.triggerTokens ?? settings.compactionTriggerTokens,
              }
            : {}),
          });
          const loaded = await manager.loadSession(input.sessionId);
          const session = loaded
            ? toRuntimeSession(input.sessionId, loaded)
            : undefined;
          finalRevision =
            loaded?.lineage?.entries.filter(
              (entry) => entry.type === "compaction",
            ).length ?? beforeRevision;
          bus.emit(
            "context.compaction.finished",
            {
              contextId: input.sessionId,
              contextKind: "root",
              contextRevision: finalRevision,
              source: "manual",
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
              committed: result.compacted,
              elapsedMs: Date.now() - startedAt,
              beforeRevision,
              afterRevision: finalRevision,
              ...(result.report ?? {}),
              ...(result.reason !== undefined ? { reason: result.reason } : {}),
            },
            { sessionId: input.sessionId, runId: input.sessionId },
          );
          if (result.compacted) {
            bus.emit(
              "session.compacted",
              {
                sessionId: input.sessionId,
                result: {
                  compacted: result.compacted,
                  tokensBefore: result.tokensBefore,
                  tokensAfter: result.tokensAfter,
                },
                ...(session !== undefined ? { session } : {}),
              },
              { sessionId: input.sessionId, runId: input.sessionId },
            );
          }
          return {
            ...result,
            ...(session !== undefined ? { session } : {}),
          };
        } finally {
          bus.emit(
            "context.compaction.ended",
            {
              meta: {
                contextId: input.sessionId,
                contextKind: "root",
                contextRevision: finalRevision,
              },
            },
            { sessionId: input.sessionId, runId: input.sessionId },
          );
        }
      });
    },

    async archive(sessionId) {
      await sessionOperations.run(sessionId, async () => {
        ensureOpen();
        await admission.loadRequired(sessionId);
        assertSessionMutationAllowed(sessionId, activeRunOwner);
        await withActorSessionFileMutation(
          sessionId,
          "archive",
          async (ownerId) => {
            if (!ownerId) {
              throw new Error(`Actor owner is unavailable for Session archive: ${sessionId}`);
            }
            const ok = await manager.storage.archiveOwned(sessionId, ownerId);
            if (!ok) {
              throw new Error(
                `Session not found or not archived: ${sessionId}`,
              );
            }
          },
        );
        invalidateMaterializedSessionCapture(sessionId);
      });
    },

    async unarchive(sessionId) {
      await sessionOperations.run(sessionId, async () => {
        ensureOpen();
        await admission.loadRequired(sessionId);
        assertSessionMutationAllowed(sessionId, activeRunOwner);
        await withActorSessionFileMutation(
          sessionId,
          "unarchive",
          async (ownerId) => {
            if (!ownerId) {
              throw new Error(`Actor owner is unavailable for Session unarchive: ${sessionId}`);
            }
            const ok = await manager.storage.unarchiveOwned(sessionId, ownerId);
            if (!ok) {
              throw new Error(
                `Session not found or not unarchived: ${sessionId}`,
              );
            }
          },
        );
        invalidateMaterializedSessionCapture(sessionId);
      });
    },

    async delete(sessionId) {
      await sessionOperations.run(sessionId, async () => {
        ensureOpen();
        await admission.loadRequired(sessionId);
        assertSessionMutationAllowed(sessionId, activeRunOwner);
        await withActorSessionFileMutation(sessionId, "delete", async (ownerId) => {
          if (!ownerId) {
            throw new Error(`Actor owner is unavailable for Session deletion: ${sessionId}`);
          }
          const running = (await manager.listRunningSessions()).find(
            (instance) => instance.sessionId === sessionId,
          );
          if (running) {
            assertDeleteSucceeded(sessionId, {
              error: {
                code: "session_running",
                runningProcess: {
                  pid: running.pid,
                  startedAt: running.startedAt,
                },
              },
            });
          }
          try {
            await manager.storage.deleteOwned(sessionId, ownerId);
          } catch (error: unknown) {
            if (
              isRecord(error)
              && (
                error.code === "actor_owner_conflict"
                || error.code === "actor_owner_unknown"
              )
            ) {
              throw error;
            }
            emitKodaXDiagnostic({
              source: "runtime.sessions",
              level: "error",
              message: "Owned Session deletion failed.",
              detail: { sessionId, error },
            });
            assertDeleteSucceeded(sessionId, {
              error: { code: "delete_failed" },
            });
          }
        });
        invalidateMaterializedSessionCapture(sessionId);
        settingsOwner.release(sessionId);
        onSessionDeleted(sessionId);
      });
    },
  };
}

function createRuntimeRunService(deps: {
  readonly actorRegistry: RuntimeAgentActorRegistry;
  readonly waitForActorHealthResolution: (
    sessionId: string,
    observed: AgentControllerHealth,
  ) => Promise<AgentControllerHealth>;
  readonly waitForActorHealthChange: (
    sessionId: string,
  ) => {
    readonly promise: Promise<AgentControllerHealth>;
    close(): void;
  };
  readonly agentPlane?: AgentExecutorPlane;
  readonly artifacts: RuntimeArtifactStore;
  readonly bus: RuntimeEventBus;
  readonly defaultModel?: string;
  readonly defaultConfigHome: string;
  readonly defaultProvider?: string;
  readonly defaultAgentContext?: AgentDispatchContext;
  readonly ensureOpen: () => void;
  readonly isClosed: () => boolean;
  readonly permissions: RuntimePermissionRegistry;
  readonly userInputs: RuntimeUserInputRegistry;
  readonly enableSharedInteractions: boolean;
  readonly persistence: RuntimePersistence;
  readonly runOwner: AgentActorOwner;
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
  readonly sessionAdmission: RuntimeSessionAdmission;
  readonly sessionOperations: RuntimeSessionOperationGate;
  readonly settingsOwner: RuntimeSessionSettingsOwner;
}): RuntimeRunServiceInternal {
  const activeRunBySession = new Map<string, string>();
  const activeQueueRouteReleaseByRun = new Map<string, () => void>();
  const autoModeGuardrails = new Map<
    string,
    Map<string, RuntimeAutoModeGuardrailCacheEntry>
  >();
  const autoModeStates = new Map<string, AutoModeSharedState>();
  const queueBySession = new Map<string, string[]>();

  const getRecord = (runId: string): RuntimeRunRecord => {
    const run = deps.runs.get(runId);
    if (!run) {
      throw new Error(`Runtime run not found: ${runId}`);
    }
    return run;
  };

  const observePersistedRun = async (
    persisted: PersistedRuntimeRunStatus,
    record?: RuntimeRunRecord,
  ): Promise<RuntimeRunStatus> => {
    if (
      isTerminalRunPhase(persisted.status.phase)
      || record?.ownedByRuntime === true
    ) {
      return persisted.status;
    }
    const owner = persisted.owner ?? record?.observedOwner;
    const observedStatus =
      record === undefined ? persisted.status : statusFromRecord(record);
    if (owner === undefined) {
      return {
        ...observedStatus,
        phase: "unknown",
        stage: "unknown",
        error: "owner_liveness_unconfirmed",
      };
    }
    const ownerState = await inspectRuntimeActorOwner(owner);
    if (ownerState === "alive") return persisted.status;
    if (ownerState === "unknown") {
      return {
        ...observedStatus,
        phase: "unknown",
        stage: "unknown",
        error: "owner_liveness_unconfirmed",
      };
    }
    const recovered = interruptPersistedNonTerminalRun(
      persisted.status,
      deps.bus,
      deps.persistence,
    );
    deps.runs.set(
      recovered.runId,
      recordFromPersistedStatus(recovered, false, owner),
    );
    return recovered;
  };

  const inspectPersistedRun = async (
    persisted: PersistedRuntimeRunStatus,
    record?: RuntimeRunRecord,
  ): Promise<RuntimeRunStatus> => {
    if (record?.ownedByRuntime === true) return statusFromRecord(record);
    if (isTerminalRunPhase(persisted.status.phase)) return persisted.status;
    const owner = persisted.owner ?? record?.observedOwner;
    const observedStatus =
      record === undefined ? persisted.status : statusFromRecord(record);
    if (owner === undefined) {
      return {
        ...observedStatus,
        phase: "unknown",
        stage: "unknown",
        error: "owner_liveness_unconfirmed",
      };
    }
    const ownerState = await inspectRuntimeActorOwner(owner);
    if (ownerState === "alive") return persisted.status;
    return {
      ...observedStatus,
      phase: "unknown",
      stage: "unknown",
      error: ownerState === "dead"
        ? "owner_recovery_required"
        : "owner_liveness_unconfirmed",
    };
  };

  const releaseActiveRun = (record: RuntimeRunRecord): void => {
    if (activeRunBySession.get(record.sessionId) === record.runId) {
      activeRunBySession.delete(record.sessionId);
    }
  };

  const releaseActiveQueueRoute = (record: RuntimeRunRecord): void => {
    activeQueueRouteReleaseByRun.get(record.runId)?.();
    activeQueueRouteReleaseByRun.delete(record.runId);
  };

  const releaseAbortSignalSubscription = (record: RuntimeRunRecord): void => {
    record.releaseAbortSignalSubscription?.();
    record.releaseAbortSignalSubscription = undefined;
  };

  const registerActiveQueueRoute = (record: RuntimeRunRecord): void => {
    if (
      record.actorSession === undefined ||
      activeQueueRouteReleaseByRun.has(record.runId)
    )
      return;
    activeQueueRouteReleaseByRun.set(
      record.runId,
      registerActiveRootQueueRoute(actorQueueId(record.sessionId, "/root")),
    );
  };

  const resolveRunStart = (
    record: RuntimeRunRecord,
    result: RuntimeRunResult,
  ): void => {
    record.start?.resolve(result);
    record.start = undefined;
    delete record.providerCredential;
  };

  const finishRun = (
    record: RuntimeRunRecord,
    result: RuntimeRunResult,
  ): RuntimeRunResult => {
    if (record.settlementFinished === true) return result;
    record.settlementFinished = true;
    releaseAbortSignalSubscription(record);
    deps.permissions.rejectForRun(record.runId, "runtime run ended");
    deps.userInputs.rejectForRun(record.runId, "runtime run ended");
    record.start?.options.guardrails
      ?.find(isRuntimeAutoModeGuardrail)
      ?.clearAllowedCalls();
    resolveRunStart(record, result);
    releaseActiveQueueRoute(record);
    releaseActiveRun(record);
    pruneTerminalRuns(deps.runs);
    drainNext(record.sessionId);
    return result;
  };

  const finishUnconfirmedRun = (
    record: RuntimeRunRecord,
    result: RuntimeRunResult,
  ): RuntimeRunResult => {
    if (record.settlementFinished === true) return result;
    record.settlementFinished = true;
    if (result.phase === "unknown" && record.phase !== "unknown") {
      record.phase = "unknown";
      record.stage = "unknown";
      record.stageChangedAt = new Date().toISOString();
      record.error = result.error?.message ?? "Actor settlement persistence is unknown.";
      publishRunUpdate(record);
    }
    releaseAbortSignalSubscription(record);
    deps.permissions.rejectForRun(record.runId, "runtime run state is unknown");
    deps.userInputs.rejectForRun(record.runId, "runtime run state is unknown");
    record.start?.options.guardrails
      ?.find(isRuntimeAutoModeGuardrail)
      ?.clearAllowedCalls();
    resolveRunStart(record, result);
    releaseActiveQueueRoute(record);
    // Keep activeRunBySession fenced. No later Run may execute until the
    // uncertain Actor settlement is explicitly repaired or exported.
    return result;
  };

  const awaitActorFinalization = async (
    record: RuntimeRunRecord,
  ): Promise<AgentControllerHealth> => {
    // A synchronous SDK launch failure can queue an Actor settlement before
    // throwing. Let already-queued settlement reactions publish their health,
    // then confirm the health again without an interleaving JS turn before a
    // terminal status is allowed to persist.
    const cancellationController =
      record.actorFinalizationAbortController ??= new AbortController();
    const finalizationTimedOut = (): AgentControllerHealth => ({
      state: "unknown",
      code: "actor_settlement_not_persisted",
      message:
        "Actor finalization could not be confirmed within the bounded grace period.",
    });
    const finalizationAbort = new AbortController();
    let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
    let finalizationDeadline = Number.POSITIVE_INFINITY;
    let resolveFinalizationTimeout:
      ((health: AgentControllerHealth) => void) | undefined;
    const finalizationTimeout = new Promise<AgentControllerHealth>((resolve) => {
      resolveFinalizationTimeout = resolve;
    });
    const scheduleFinalizationTimer = (delayMs: number): void => {
      const deadline = Date.now() + delayMs;
      if (deadline >= finalizationDeadline) return;
      if (finalizationTimer !== undefined) clearTimeout(finalizationTimer);
      finalizationDeadline = deadline;
      finalizationTimer = setTimeout(() => {
        finalizationAbort.abort(new Error("Actor finalization grace expired"));
        resolveFinalizationTimeout?.(finalizationTimedOut());
      }, delayMs);
      finalizationTimer.unref?.();
    };
    const startCancellationTimer = (): void => {
      scheduleFinalizationTimer(RUNTIME_ACTOR_CANCELLATION_FINALIZATION_MS);
    };
    scheduleFinalizationTimer(RUNTIME_ACTOR_FINALIZATION_MS);
    cancellationController.signal.addEventListener(
      "abort",
      startCancellationTimer,
      { once: true },
    );
    if (
      cancellationController.signal.aborted
      || record.stop !== undefined
      || deps.isClosed()
      || record.running?.aborted === true
      || record.abortController?.signal.aborted === true
      || record.start?.options.abortSignal?.aborted === true
    ) {
      startCancellationTimer();
    }

    const finalize = async (): Promise<AgentControllerHealth> => {
      for (;;) {
        if (finalizationAbort.signal.aborted) return finalizationTimedOut();
        const actorSession = record.actorSession;
        if (actorSession === undefined) return { state: "healthy" };
        const observed = actorSession.health();
        if (observed.state === "recovering") {
          const healthChange = deps.waitForActorHealthChange(record.sessionId);
          let resolveAbort: (() => void) | undefined;
          const abortWait = new Promise<void>((resolve) => {
            resolveAbort = resolve;
          });
          const handleFinalizationAbort = (): void => resolveAbort?.();
          finalizationAbort.signal.addEventListener(
            "abort",
            handleFinalizationAbort,
            { once: true },
          );
          try {
            await Promise.race([
              healthChange.promise,
              abortWait,
            ]);
          } finally {
            finalizationAbort.signal.removeEventListener(
              "abort",
              handleFinalizationAbort,
            );
            resolveAbort = undefined;
            healthChange.close();
          }
          continue;
        }
        if (observed.state === "unknown") return observed;
        const root = actorSession.rootControl();
        const tree = root.list();
        if (tree.activeNonRootTurns > 0) {
          if (record.stop?.state !== "unknown") {
            const phaseChanged = record.phase !== "waiting_agent";
            const countChanged =
              record.activeSubtaskCount !== tree.activeNonRootTurns;
            if (phaseChanged) {
              record.phase = "waiting_agent";
              record.stage = "waiting_agent";
              record.stageChangedAt = new Date().toISOString();
            }
            record.activeSubtaskCount = tree.activeNonRootTurns;
            if (phaseChanged || countChanged) publishRunUpdate(record);
          }
          const cursor = root.eventSnapshot().at(-1)?.sequence ?? 0;
          if (root.list().activeNonRootTurns === 0) continue;
          const healthChange = deps.waitForActorHealthChange(record.sessionId);
          try {
            await Promise.race([
              root.wait(cursor, undefined, finalizationAbort.signal),
              healthChange.promise,
            ]);
          } finally {
            healthChange.close();
          }
          continue;
        }
        await Promise.resolve();
        const confirmed = actorSession.health();
        if (confirmed.state === "recovering") continue;
        if (root.list().activeNonRootTurns > 0) continue;
        return confirmed;
      }
    };

    try {
      return await Promise.race([finalize(), finalizationTimeout]);
    } finally {
      cancellationController.signal.removeEventListener(
        "abort",
        startCancellationTimer,
      );
      if (finalizationTimer !== undefined) clearTimeout(finalizationTimer);
      finalizationAbort.abort();
    }
  };

  const unknownActorSettlementResult = (
    record: RuntimeRunRecord,
    result?: KodaXResult,
  ): RuntimeRunResult => ({
    runId: record.runId,
    sessionId: record.sessionId,
    phase: "unknown",
    ...(result !== undefined ? { result } : {}),
    error: new Error(
      record.lifecycleError?.message
      ?? record.error
      ?? "Actor settlement persistence is unknown.",
    ),
    ...(record.stop !== undefined ? { stop: record.stop } : {}),
  });

  const finishAccordingToTerminalFact = (
    record: RuntimeRunRecord,
    result: RuntimeRunResult,
  ): RuntimeRunResult =>
    record.terminalEmitted
      ? finishRun(record, result)
      : finishUnconfirmedRun(record, result);

  const settleFromExecutorSignal = (
    record: RuntimeRunRecord,
    signal: "completed" | "failed",
    error?: Error,
  ): void => {
    if (record.terminalEmitted || record.executorTerminalSignal !== undefined) {
      return;
    }
    record.interruptInputOpen = false;
    record.executorTerminalSignal = {
      signal,
      ...(error !== undefined ? { error } : {}),
      interruptedAtSignal:
        record.running?.aborted === true
        || record.start?.options.abortSignal?.aborted === true
        || record.abortController?.signal.aborted === true,
    };
    // The executor emits its terminal callback immediately before its result
    // Promise resolves. Give that Promise the rest of the current event-loop
    // turn so the authoritative result (including KodaXResult payload) wins.
    // This fallback runs on the next turn only when the Promise was lost.
    setImmediate(() => {
      void (async () => {
      if (record.settlementFinished === true) return;
      const latched = record.executorTerminalSignal;
      if (latched === undefined) return;
      const actorHealth = await awaitActorFinalization(record);
      if (actorHealth.state === "unknown") {
        finishUnconfirmedRun(
          record,
          unknownActorSettlementResult(record),
        );
        return;
      }
      if (latched.signal === "failed") {
        finishRun(
          record,
          failedRunResult(
            record,
            latched.error ?? new Error("Runtime executor reported failure"),
          ),
        );
        return;
      }
      if (!record.terminalEmitted) {
        markRunTerminal(
          deps.bus,
          deps.persistence,
          record,
          latched.interruptedAtSignal ? "interrupted" : "completed",
        );
      }
      finishRun(record, {
        runId: record.runId,
        sessionId: record.sessionId,
        phase: record.phase,
        ...(record.terminal !== undefined
          ? { terminal: record.terminal }
          : {}),
        ...(record.stop !== undefined ? { stop: record.stop } : {}),
      });
      })().catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: "runtime.run.finalization",
          level: "error",
          message: `Failed to settle Runtime run ${record.runId} after its executor terminal signal.`,
          detail: error,
        });
      });
    });
  };

  const failedRunResult = (
    record: RuntimeRunRecord,
    error: unknown,
  ): RuntimeRunResult => {
    const normalized = normalizeRuntimeRunError(error, record);
    const failure = classifyRuntimeRunFailure(error);
    const phase = record.terminalEmitted ? record.phase : failure.phase;
    if (!record.terminalEmitted) {
      record.error = normalized.message;
    }
    markRunTerminal(
      deps.bus,
      deps.persistence,
      record,
      phase,
      failure.terminal,
    );
    return {
      runId: record.runId,
      sessionId: record.sessionId,
      phase: record.phase,
      error: normalized,
      ...(record.stop !== undefined ? { stop: record.stop } : {}),
    };
  };

  const canApplyExecutorTerminalSignal = (
    record: RuntimeRunRecord,
  ): boolean => {
    const actorSession = record.actorSession;
    return (
      actorSession === undefined
      || (
        actorSession.health().state === "healthy"
        && actorSession.rootControl().list().activeNonRootTurns === 0
      )
    );
  };

  const cancelRun = (
    record: RuntimeRunRecord,
    reason: string,
    drain: boolean,
  ): RuntimeRunResult => {
    const executorSignal = record.executorTerminalSignal;
    if (
      executorSignal !== undefined
      && !record.terminalEmitted
      && canApplyExecutorTerminalSignal(record)
    ) {
      if (executorSignal.signal === "failed") {
        return failedRunResult(
          record,
          executorSignal.error
            ?? new Error("Runtime executor reported failure"),
        );
      }
      markRunTerminal(
        deps.bus,
        deps.persistence,
        record,
        executorSignal.interruptedAtSignal ? "interrupted" : "completed",
      );
      return {
        runId: record.runId,
        sessionId: record.sessionId,
        phase: record.phase,
        ...(record.terminal !== undefined
          ? { terminal: record.terminal }
          : {}),
        ...(record.stop !== undefined ? { stop: record.stop } : {}),
      };
    }
    if (executorSignal !== undefined && record.terminalEmitted) {
      return {
        runId: record.runId,
        sessionId: record.sessionId,
        phase: record.phase,
        ...(record.terminal !== undefined
          ? { terminal: record.terminal }
          : {}),
        ...(record.stop !== undefined ? { stop: record.stop } : {}),
      };
    }
    const wasQueued = record.phase === "queued";
    if (wasQueued) {
      removeQueuedRun(queueBySession, record);
    }
    delete record.actorHealthBaseState;
    const requestedAt = new Date().toISOString();
    record.stop ??= {
      requestedAt,
      state: wasQueued ? "confirmed" : "unknown",
      outcome: wasQueued ? "cancelled" : "unknown",
      reason,
      ...(wasQueued ? { resolvedAt: requestedAt } : {}),
    };
    releaseAbortSignalSubscription(record);
    record.running?.abort(new Error(reason));
    record.abortController?.abort(new Error(reason));
    record.actorFinalizationAbortController?.abort(new Error(reason));
    deps.permissions.rejectForRun(record.runId, reason);
    deps.userInputs.rejectForRun(record.runId, reason);
    record.start?.options.guardrails
      ?.find(isRuntimeAutoModeGuardrail)
      ?.clearAllowedCalls();
    if (!wasQueued) {
      record.interruptInputOpen = false;
      terminalizeQueuedInterruptInputs(record);
      record.phase = "unknown";
      record.stage = "unknown";
      record.stageChangedAt = requestedAt;
      record.error = "stop_outcome_unconfirmed";
      if (record.lifecycleError?.retryable !== false) {
        delete record.lifecycleError;
      }
      publishRunUpdate(record);
      const result: RuntimeRunResult = {
        runId: record.runId,
        sessionId: record.sessionId,
        phase: record.phase,
        ...(record.stop !== undefined ? { stop: record.stop } : {}),
      };
      if (!drain) {
        resolveRunStart(record, result);
        releaseActiveQueueRoute(record);
        releaseActiveRun(record);
      }
      return result;
    }
    markRunTerminal(deps.bus, deps.persistence, record, "cancelled", {
      code: "cancelled",
      effectOutcome: "none",
      message: reason,
    });
    const result: RuntimeRunResult = {
      runId: record.runId,
      sessionId: record.sessionId,
      phase: record.phase,
      ...(record.stop !== undefined ? { stop: record.stop } : {}),
    };
    resolveRunStart(record, result);
    releaseActiveQueueRoute(record);
    releaseActiveRun(record);
    if (drain && !deps.isClosed()) {
      drainNext(record.sessionId);
    }
    return result;
  };

  const launchRecord = (record: RuntimeRunRecord): void => {
    if (!record.start || deps.isClosed()) {
      cancelRun(record, "runtime closed", false);
      return;
    }
    record.phase = "running";
    record.stage = "executing";
    record.stageChangedAt = new Date().toISOString();
    delete record.activeSubtaskCount;
    record.interruptInputOpen = record.actorSession !== undefined;
    record.queuedAt = undefined;
    record.runningAt = new Date().toISOString();
    activeRunBySession.set(record.sessionId, record.runId);
    const startedStatus = statusFromRecord(record);
    const authoritative = saveRunStatusSafely(
      deps.bus,
      deps.persistence,
      record,
      startedStatus,
    );
    if (authoritative === undefined) {
      releaseActiveRun(record);
      throw new Error(`Failed to persist running Runtime run: ${record.runId}`);
    }
    if (authoritative !== startedStatus) {
      applyAuthoritativeRunStatus(record, authoritative);
      releaseActiveRun(record);
      throw createRuntimeConflictError(
        `Runtime run already exists: ${record.runId}`,
        record.sessionOrder,
      );
    }
    deps.bus.emit("run.started", startedStatus, {
      sessionId: record.sessionId,
      runId: record.runId,
    });

    const events = wrapKodaXEvents({
      bus: deps.bus,
      original: record.start.options.events,
      permissions: deps.permissions,
      userInputs: deps.userInputs,
      enableSharedInteractions: deps.enableSharedInteractions,
      record,
      onExecutorTerminal: (signal, error) =>
        settleFromExecutorSignal(record, signal, error),
      onPhase: (phase) => {
        if (
          record.terminalEmitted
          || record.executorTerminalSignal !== undefined
          || record.phase === "unknown"
          || record.stop?.state === "unknown"
        ) {
          return;
        }
        const stage =
          phase === "running"
            ? "executing"
            : phase === "waiting_agent"
              ? "waiting_agent"
              : phase === "recovering"
                ? "recovering"
                : undefined;
        const actorBase = record.actorHealthBaseState;
        if (actorBase !== undefined) {
          actorBase.phase = phase;
          if (stage !== undefined) actorBase.stage = stage;
          return;
        }
        if (record.phase === phase && (stage === undefined || record.stage === stage)) {
          return;
        }
        record.phase = phase;
        if (stage !== undefined && record.stage !== stage) {
          record.stage = stage;
          record.stageChangedAt = new Date().toISOString();
        }
        publishRunUpdate(record);
      },
      onStage: (stage, activeSubtaskCount) => {
        if (
          record.terminalEmitted
          || record.executorTerminalSignal !== undefined
          || record.phase === "unknown"
          || record.stop?.state === "unknown"
        ) {
          return;
        }
        const actorBase = record.actorHealthBaseState;
        if (actorBase !== undefined) {
          actorBase.stage = stage;
          if (activeSubtaskCount === undefined) {
            delete record.activeSubtaskCount;
          } else {
            record.activeSubtaskCount = activeSubtaskCount;
          }
          return;
        }
        const countChanged = record.activeSubtaskCount !== activeSubtaskCount;
        if (record.stage === stage && !countChanged) return;
        if (record.stage !== stage) {
          record.stage = stage;
          record.stageChangedAt = new Date().toISOString();
        }
        if (activeSubtaskCount === undefined) {
          delete record.activeSubtaskCount;
        } else {
          record.activeSubtaskCount = activeSubtaskCount;
        }
        publishRunUpdate(record);
      },
      onMidTurnUserMessages: (queuedMessageIds, queuedMessageEntryIds) =>
        deliverInterruptInputs(record, queuedMessageIds, queuedMessageEntryIds),
    });
    const runOptions = buildRunOptions({
      agentPlane: deps.agentPlane,
      defaultConfigHome: deps.defaultConfigHome,
      events,
      model: record.model,
      options: record.start.options,
      provider: record.provider,
      record,
      sessionManager: deps.sessionManager,
    });
    deps.bus.emit(
      "config.effective",
      {
        sessionId: record.sessionId,
        runId: record.runId,
        provider: record.provider,
        ...(record.model !== undefined ? { model: record.model } : {}),
        ...(runOptions.effort !== undefined
          ? { effort: runOptions.effort }
          : {}),
        ...(runOptions.thinking !== undefined
          ? { thinking: runOptions.thinking }
          : {}),
        ...(runOptions.reasoningMode !== undefined
          ? { reasoningMode: runOptions.reasoningMode }
          : {}),
        ...(runOptions.agentMode !== undefined
          ? { agentMode: runOptions.agentMode }
          : {}),
        ...(record.permissionMode !== undefined
          ? { permissionMode: record.permissionMode }
          : {}),
        ...(record.autoModeEngine !== undefined
          ? { autoModeEngine: record.autoModeEngine }
          : {}),
        ...(record.autoModeClassifierModel !== undefined
          ? { autoModeClassifierModel: record.autoModeClassifierModel }
          : {}),
        ...(record.autoModeTimeoutMs !== undefined
          ? { autoModeTimeoutMs: record.autoModeTimeoutMs }
          : {}),
        ...(record.autoModeSpeculativeWindowMs !== undefined
          ? {
              autoModeSpeculativeWindowMs: record.autoModeSpeculativeWindowMs,
            }
          : {}),
        ...(runOptions.compaction?.triggerPercent !== undefined
          ? { compactionTriggerPercent: runOptions.compaction.triggerPercent }
          : {}),
        ...(runOptions.compaction?.triggerTokens !== undefined
          ? { compactionTriggerTokens: runOptions.compaction.triggerTokens }
          : {}),
        ...(runOptions.context?.executionCwd !== undefined
          ? { executionCwd: runOptions.context.executionCwd }
          : {}),
        ...(runOptions.context?.shellExecution !== undefined
          ? {
              shellKind: runOptions.context.shellExecution.shell.kind,
              shellExecutionFingerprint: shellExecutionContractFingerprint(
                runOptions.context.shellExecution,
              ),
            }
          : {}),
      },
      {
        sessionId: record.sessionId,
        runId: record.runId,
        ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
      },
    );
    if (record.mode === "managed_task") {
      const abortController = new AbortController();
      record.abortController = abortController;
      const upstreamSignal = runOptions.abortSignal;
      const handleUpstreamAbort = (): void => {
        record.releaseAbortSignalSubscription = undefined;
        record.interruptInputOpen = false;
        const upstreamReason = upstreamSignal?.reason;
        cancelRun(
          record,
          upstreamReason instanceof Error
            ? upstreamReason.message
            : typeof upstreamReason === "string" && upstreamReason.trim().length > 0
              ? upstreamReason
              : "external abort requested",
          true,
        );
      };
      if (upstreamSignal?.aborted) {
        handleUpstreamAbort();
      }
      const managedOperation = () =>
        runManagedTask(
          {
            ...runOptions,
            abortSignal: abortController.signal,
          },
          record.start!.prompt,
        );
      const managedResult =
        record.providerCredential !== undefined
          ? runWithProviderCredential(
              record.provider,
              record.providerCredential,
              managedOperation,
            )
          : managedOperation();
      if (upstreamSignal !== undefined && !upstreamSignal.aborted) {
        upstreamSignal.addEventListener("abort", handleUpstreamAbort, {
          once: true,
        });
        record.releaseAbortSignalSubscription = () => {
          upstreamSignal.removeEventListener("abort", handleUpstreamAbort);
        };
      } else if (upstreamSignal?.aborted && !abortController.signal.aborted) {
        handleUpstreamAbort();
      }
      registerActiveQueueRoute(record);
      void managedResult
        .then(async (value): Promise<RuntimeRunResult> => {
          const phase = record.terminalEmitted
            ? record.phase
            : value.interrupted
              ? "interrupted"
              : value.success
                ? "completed"
                : "failed";
          const blockedTerminal =
            !value.success && !value.interrupted && value.signal === "BLOCKED"
              ? {
                  code: "blocked" as const,
                  effectOutcome: "known" as const,
                  ...(value.signalReason !== undefined
                    ? { message: value.signalReason }
                    : {}),
                }
              : undefined;
          const actorHealth = await awaitActorFinalization(record);
          if (actorHealth.state === "unknown") {
            return unknownActorSettlementResult(record, value);
          }
          markRunTerminal(
            deps.bus,
            deps.persistence,
            record,
            phase,
            blockedTerminal,
          );
          return {
            runId: record.runId,
            sessionId: record.sessionId,
            phase: record.phase,
            result: value,
            ...(record.terminal !== undefined
              ? { terminal: record.terminal }
              : {}),
            ...(record.stop !== undefined ? { stop: record.stop } : {}),
          };
        })
        .catch(async (error: unknown) => {
          const actorHealth = await awaitActorFinalization(record);
          return actorHealth.state === "unknown"
            ? unknownActorSettlementResult(record)
            : failedRunResult(record, error);
        })
        .then((result) => finishAccordingToTerminalFact(record, result));
      return;
    }

    const codingOperation = () => startKodaX(runOptions, record.start!.prompt);
    const running =
      record.providerCredential !== undefined
        ? runWithProviderCredential(
            record.provider,
            record.providerCredential,
            codingOperation,
          )
        : codingOperation();
    record.running = running;
    const upstreamSignal = runOptions.abortSignal;
    const handleUpstreamAbort = (): void => {
      record.releaseAbortSignalSubscription = undefined;
      record.interruptInputOpen = false;
      const upstreamReason = upstreamSignal?.reason;
      cancelRun(
        record,
        upstreamReason instanceof Error
          ? upstreamReason.message
          : typeof upstreamReason === "string" && upstreamReason.trim().length > 0
            ? upstreamReason
            : "external abort requested",
        true,
      );
    };
    if (upstreamSignal?.aborted) {
      handleUpstreamAbort();
    } else if (upstreamSignal !== undefined) {
      upstreamSignal.addEventListener("abort", handleUpstreamAbort, {
        once: true,
      });
      record.releaseAbortSignalSubscription = () => {
        upstreamSignal.removeEventListener("abort", handleUpstreamAbort);
      };
    }
    registerActiveQueueRoute(record);
    void running.result
      .then(async (value): Promise<RuntimeRunResult> => {
        const phase = record.terminalEmitted
          ? record.phase
          : value.interrupted
            ? "interrupted"
            : value.success
              ? "completed"
              : "failed";
        const actorHealth = await awaitActorFinalization(record);
        if (actorHealth.state === "unknown") {
          return unknownActorSettlementResult(record, value);
        }
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return {
          runId: record.runId,
          sessionId: record.sessionId,
          phase: record.phase,
          result: value,
          ...(record.stop !== undefined ? { stop: record.stop } : {}),
        };
      })
      .catch(async (error: unknown) => {
        const actorHealth = await awaitActorFinalization(record);
        return actorHealth.state === "unknown"
          ? unknownActorSettlementResult(record)
          : failedRunResult(record, error);
      })
      .then((result) => finishAccordingToTerminalFact(record, result));
  };

  const startRecord = (
    record: RuntimeRunRecord,
  ): { readonly error: unknown } | undefined => {
    try {
      launchRecord(record);
      return undefined;
    } catch (error) {
      void awaitActorFinalization(record).then((actorHealth) => {
        if (actorHealth.state === "unknown") {
          finishUnconfirmedRun(record, unknownActorSettlementResult(record));
          return;
        }
        finishRun(record, failedRunResult(record, error));
      });
      return { error };
    }
  };

  const drainNext = (sessionId: string): void => {
    const queue = queueBySession.get(sessionId);
    if (!queue || queue.length === 0 || activeRunBySession.has(sessionId))
      return;
    const nextRunId = queue.shift();
    if (queue.length === 0) queueBySession.delete(sessionId);
    if (!nextRunId) return;
    const next = deps.runs.get(nextRunId);
    if (!next || next.phase !== "queued") {
      drainNext(sessionId);
      return;
    }
    startRecord(next);
  };

  const enqueue = (record: RuntimeRunRecord): void => {
    const status = statusFromRecord(record);
    const authoritative = saveRunStatusSafely(
      deps.bus,
      deps.persistence,
      record,
      status,
    );
    if (authoritative === undefined) {
      throw new Error(`Failed to persist queued Runtime run: ${record.runId}`);
    }
    if (authoritative !== status) {
      applyAuthoritativeRunStatus(record, authoritative);
      throw createRuntimeConflictError(
        `Runtime run already exists: ${record.runId}`,
        record.sessionOrder,
      );
    }
    const queue = queueBySession.get(record.sessionId) ?? [];
    queue.push(record.runId);
    queueBySession.set(record.sessionId, queue);
    deps.bus.emit("run.queued", status, {
      sessionId: record.sessionId,
      runId: record.runId,
    });
  };

  const publishRunUpdate = (record: RuntimeRunRecord): void => {
    const status = statusFromRecord(record);
    const authoritative = saveRunStatusSafely(
      deps.bus,
      deps.persistence,
      record,
      status,
    );
    if (authoritative === undefined) return;
    if (authoritative !== status) {
      applyAuthoritativeRunStatus(record, authoritative);
      return;
    }
    deps.bus.emit("run.updated", status, {
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
    });
  };

  const deliverInterruptInputs = (
    record: RuntimeRunRecord,
    queuedMessageIds: readonly string[],
    queuedMessageEntryIds: Readonly<Record<string, string>> | undefined,
  ): void => {
    const queuedByMessageId = new Map<string, RuntimeInterruptInputRecord>();
    for (const input of record.interruptInputs) {
      if (input.state === "queued" && input.queueMessageId !== undefined) {
        queuedByMessageId.set(input.queueMessageId, input);
      }
    }
    const delivered: RuntimeInterruptInputRecord[] = [];
    const seen = new Set<string>();
    for (const messageId of queuedMessageIds) {
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      const input = queuedByMessageId.get(messageId);
      if (input !== undefined) delivered.push(input);
    }
    if (delivered.length === 0) return;
    const deliveredAt = new Date().toISOString();
    const deliveries = delivered.map((record) => {
      if (record.input === undefined) {
        throw new Error(
          `Runtime interrupt input is unavailable: ${record.inputId}`,
        );
      }
      const entryId = record.queueMessageId === undefined
        ? undefined
        : queuedMessageEntryIds?.[record.queueMessageId];
      if (typeof entryId !== "string" || entryId.length === 0) {
        throw new Error(
          `Runtime interrupt input is missing its canonical entry reference: ${record.inputId}`,
        );
      }
      const eventInput: RuntimeDeliveredInterruptInput = {
        inputId: record.inputId,
        afterRunId: record.afterRunId,
        input: record.input,
        queuedAt: record.queuedAt,
        deliveredAt,
        entryId,
        ...(record.origin !== undefined ? { origin: record.origin } : {}),
      };
      return { record, entryId, eventInput };
    });
    const scope = {
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
    };
    try {
      deps.bus.emitDurable(
        "run.input.delivered",
        { inputs: deliveries.map((delivery) => delivery.eventInput) },
        scope,
        () => {
          for (const delivery of deliveries) {
            delivery.record.state = "delivered";
            delivery.record.deliveredAt = deliveredAt;
            delivery.record.entryId = delivery.entryId;
            delete delivery.record.queueMessageId;
          }
        },
      );
    } catch (error: unknown) {
      deps.bus.emit(
        "runtime.warning",
        {
          source: "run.input.delivered",
          message: `Failed to persist interrupt input delivery: ${normalizeError(error).message}`,
          inputIds: delivered.map((input) => input.inputId),
        },
        scope,
      );
      throw error;
    }
    publishRunUpdate(record);
  };

  const settingsSubscription = deps.settingsOwner.subscribe(
    (sessionId, current) => {
      for (const record of deps.runs.values()) {
        if (
          record.sessionId !== sessionId ||
          (record.phase !== "queued" && !isActiveRunPhase(record.phase))
        )
          continue;
        record.permissionMode = current.value.permissionMode;
        record.autoModeEngine =
          replApi.normalizePermissionMode(current.value.permissionMode) ===
          "auto"
            ? (current.value.autoModeEngine ?? "llm")
            : current.value.autoModeEngine;
        record.autoModeClassifierModel = current.value.autoModeClassifierModel;
        record.autoModeTimeoutMs = current.value.autoModeTimeoutMs;
        record.autoModeSpeculativeWindowMs =
          current.value.autoModeSpeculativeWindowMs;
        publishRunUpdate(record);
      }
    },
  );

  const startRun = async (
    input: RuntimeStartRunInput,
    operation: RuntimeRunInputOperation,
  ): Promise<RuntimeRunHandle> => {
    deps.ensureOpen();
    const normalizedInput = normalizeRuntimeRunInput(
      input,
      deps.artifacts,
      operation,
    );
    const session = await deps.sessionAdmission.loadExecutable(input.sessionId);
    const settings = (await deps.settingsOwner.read(input.sessionId)).value;
    assertSessionSettingsAllowed(session, settings);
    const options = buildEffectiveRuntimeOptions(
      input.options ?? {},
      settings,
      normalizedInput.inputArtifacts,
      session,
    );
    const ownedActorSession = await deps.actorRegistry.forSession(
      input.sessionId,
      options.maxConcurrentThreadsPerSession,
    );
    const actorSession =
      options.agentMode === "sa" ? undefined : ownedActorSession;
    if (actorSession !== undefined) {
      const observedHealth = actorSession.health();
      const health = observedHealth.state === "recovering"
        ? await deps.waitForActorHealthResolution(
            input.sessionId,
            observedHealth,
          )
        : observedHealth;
      if (health.state === "unknown") {
        throw Object.assign(
          new Error(
            health.message
            ?? "Actor settlement persistence is unknown; the Session cannot start another Run.",
          ),
          {
            code: health.code ?? "actor_settlement_not_persisted",
            retryable: false as const,
          },
        );
      }
    }
    const provider = options.provider ?? deps.defaultProvider;
    if (!provider) {
      throw new Error(
        "runtime.runs.start requires input.options.provider or runtime defaultProvider",
      );
    }
    const trustedInput = input as RuntimeTrustedStartRunInput;
    if (
      trustedInput.providerCredential !== undefined &&
      trustedInput.providerCredentialProvider !== undefined &&
      trustedInput.providerCredentialProvider !== provider
    ) {
      throw createRuntimeCredentialUnavailableError(
        `Credential lease is bound to ${trustedInput.providerCredentialProvider}, not ${provider}.`,
      );
    }
    const model =
      options.modelOverride ??
      options.model ??
      deps.defaultModel ??
      resolveProviderModelDescriptors(provider)[0]?.id;
    const runId =
      (input as RuntimeTrustedStartRunInput).trustedRunId ?? createRunId();
    if (deps.runs.has(runId))
      throw createRuntimeConflictError(
        `Runtime run already exists: ${runId}`,
        0,
      );
    const runtimeOwnsPermissionGuardrail =
      deps.enableSharedInteractions ||
      replApi.normalizePermissionMode(settings.permissionMode) === "auto";
    assertRuntimeAutoModeClassifierModelConfigured(settings, model);
    if (
      runtimeOwnsPermissionGuardrail &&
      options.guardrails?.some(
        (guardrail) =>
          guardrail.kind === "tool" && guardrail.name === "auto-mode",
      )
    ) {
      throw new Error(
        "Runtime owns the auto-mode guardrail for shared Session permission state.",
      );
    }
    const autoModeGuardrail = runtimeOwnsPermissionGuardrail
      ? createRuntimeSessionAutoModeGuardrail({
          sessionId: input.sessionId,
          provider,
          model,
          options,
          permissions: deps.permissions,
          cache: autoModeGuardrails,
          states: autoModeStates,
          settingsOwner: deps.settingsOwner,
          getRecord: () => {
            const activeRunId = activeRunBySession.get(input.sessionId);
            return activeRunId === undefined
              ? undefined
              : deps.runs.get(activeRunId);
          },
          onPhase: (record, phase) => {
            if (
              record.terminalEmitted
              || record.executorTerminalSignal !== undefined
              || record.phase === "unknown"
              || record.stop?.state === "unknown"
              || record.phase === phase
            ) {
              return;
            }
            record.phase = phase;
            publishRunUpdate(record);
          },
          onEngineChange: (engine) => {
            for (const record of deps.runs.values()) {
              if (
                record.sessionId === input.sessionId &&
                (record.phase === "queued" || isActiveRunPhase(record.phase)) &&
                record.autoModeEngine !== engine
              ) {
                record.autoModeEngine = engine;
                publishRunUpdate(record);
              }
            }
            void deps.settingsOwner
              .persistAutoModeEngine(input.sessionId, engine)
              .catch((error: unknown) => {
                deps.bus.emit(
                  "runtime.warning",
                  {
                    source: "runtime.auto-mode",
                    severity: "error",
                    message: `Failed to persist Session auto-mode engine: ${normalizeError(error).message}`,
                  },
                  { sessionId: input.sessionId, runId: input.sessionId },
                );
              });
          },
        })
      : undefined;
    await autoModeGuardrail?.prepare?.();
    const effectiveOptions: RuntimeKodaXOptions =
      autoModeGuardrail === undefined
        ? options
        : {
            ...options,
            guardrails: [...(options.guardrails ?? []), autoModeGuardrail],
          };
    const startedAt = new Date().toISOString();
    let resolveResult: (result: RuntimeRunResult) => void = () => undefined;
    const result = new Promise<RuntimeRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const requiredAfterRunId = (input as RuntimeTrustedStartRunInput)
      .requiredAfterRunId;
    const requiredAfterRun =
      requiredAfterRunId === undefined
        ? undefined
        : getRecord(requiredAfterRunId);
    if (requiredAfterRun !== undefined) {
      if (requiredAfterRun.sessionId !== input.sessionId) {
        throw new Error(
          `Runtime continuation target ${requiredAfterRunId} does not belong to session ${input.sessionId}`,
        );
      }
      if (
        !isActiveRunPhase(requiredAfterRun.phase) &&
        requiredAfterRun.phase !== "queued"
      ) {
        throw new RuntimeContinuationStaleError(requiredAfterRun.runId);
      }
    }
    const sessionOrder = deps.persistence.nextSessionOrder(input.sessionId);
    const isQueued =
      requiredAfterRun !== undefined || activeRunBySession.has(input.sessionId);
    const record: RuntimeRunRecord = {
      runId,
      sessionId: input.sessionId,
      phase: isQueued ? "queued" : "running",
      stage: isQueued ? "queued" : "executing",
      stageChangedAt: startedAt,
      startedAt,
      sessionOrder,
      ...(isQueued ? { queuedAt: startedAt } : {}),
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(input.permissionBroker !== undefined
        ? { permissionBroker: input.permissionBroker }
        : {}),
      ...(settings.permissionMode !== undefined
        ? { permissionMode: settings.permissionMode }
        : {}),
      ...(settings.autoModeClassifierModel !== undefined
        ? { autoModeClassifierModel: settings.autoModeClassifierModel }
        : {}),
      ...(settings.autoModeTimeoutMs !== undefined
        ? { autoModeTimeoutMs: settings.autoModeTimeoutMs }
        : {}),
      ...(settings.autoModeSpeculativeWindowMs !== undefined
        ? {
            autoModeSpeculativeWindowMs: settings.autoModeSpeculativeWindowMs,
          }
        : {}),
      ...(replApi.normalizePermissionMode(settings.permissionMode) === "auto"
        ? { autoModeEngine: settings.autoModeEngine ?? "llm" }
        : settings.autoModeEngine !== undefined
          ? { autoModeEngine: settings.autoModeEngine }
          : {}),
      ...(options.reasoningMode !== undefined
        ? { reasoning: options.reasoningMode }
        : {}),
      mode: input.mode ?? "coding",
      ...((input as RuntimeTrustedStartRunInput).providerCredential !==
      undefined
        ? {
            providerCredential: (input as RuntimeTrustedStartRunInput)
              .providerCredential,
          }
        : {}),
      hadProviderCredential:
        (input as RuntimeTrustedStartRunInput).providerCredential !== undefined,
      ...((input as RuntimeTrustedStartRunInput).origin !== undefined
        ? { origin: (input as RuntimeTrustedStartRunInput).origin }
        : {}),
      ...(requiredAfterRunId !== undefined
        ? {
            continuation: {
              inputId: runId,
              afterRunId: requiredAfterRunId,
              delivery: "after_turn" as const,
              contentPreview: previewQueuedInput(normalizedInput.prompt),
            },
          }
        : {}),
      interruptInputs: [],
      ...((input.agentContext ?? deps.defaultAgentContext)
        ? { agentContext: input.agentContext ?? deps.defaultAgentContext }
        : {}),
      ...(actorSession ? { actorSession } : {}),
      interruptInputOpen: false,
      result,
      start: {
        prompt: normalizedInput.prompt,
        inputArtifacts: normalizedInput.inputArtifacts,
        options: effectiveOptions,
        resolve: resolveResult,
      },
      terminalEmitted: false,
      ownedByRuntime: true,
    };
    deps.runs.set(runId, record);
    if (isQueued) {
      enqueue(record);
    } else {
      const launchFailure = startRecord(record);
      if (launchFailure !== undefined) throw launchFailure.error;
    }

    return {
      runId,
      sessionId: input.sessionId,
      get turnId() {
        return record.turnId;
      },
      result,
    };
  };

  const start = (
    input: RuntimeStartRunInput,
    operation: RuntimeRunInputOperation = "runtime.runs.start",
  ): Promise<RuntimeRunHandle> => {
    return deps.sessionOperations.run(
      input.sessionId,
      () => startRun(input, operation),
    );
  };

  return {
    start,

    async submitInput(input) {
      deps.ensureOpen();
      await deps.sessionAdmission.loadRequired(input.sessionId);
      const afterRun = getRecord(input.afterRunId);
      if (afterRun.sessionId !== input.sessionId) {
        throw new Error(
          `Runtime continuation target ${input.afterRunId} does not belong to session ${input.sessionId}`,
        );
      }
      if (input.delivery === "interrupt") {
        if (
          afterRun.actorSession === undefined
          && isActiveRunPhase(afterRun.phase)
          && activeRunBySession.get(input.sessionId) === afterRun.runId
        ) {
          return {
            accepted: false,
            delivery: input.delivery,
            sessionId: input.sessionId,
            afterRunId: input.afterRunId,
            reason: "unsupported_capability",
          };
        }
        if (!afterRun.interruptInputOpen) {
          return {
            accepted: false,
            delivery: input.delivery,
            sessionId: input.sessionId,
            afterRunId: input.afterRunId,
            reason: "interrupt_window_closed",
          };
        }
        if (
          !isActiveRunPhase(afterRun.phase) ||
          activeRunBySession.get(input.sessionId) !== afterRun.runId
        ) {
          return {
            accepted: false,
            delivery: input.delivery,
            sessionId: input.sessionId,
            afterRunId: input.afterRunId,
            reason: "stale_run",
          };
        }
        if (input.credential !== undefined || input.hostTools !== undefined) {
          throw new Error(
            "runtime.runs.submitInput interrupt delivery cannot replace active-run credential or host-tool bindings",
          );
        }
        const normalized = normalizeRuntimeRunInput(
          { sessionId: input.sessionId, input: input.input },
          deps.artifacts,
          "runtime.runs.submitInput",
        );
        const persistedInput = structuredClone(input.input);
        const trusted = input as RuntimeTrustedSubmitInput;
        const inputId = trusted.trustedInputId ?? createInputId();
        if (
          afterRun.interruptInputs.some(
            (candidate) => candidate.inputId === inputId,
          )
        ) {
          throw createRuntimeConflictError(
            `Runtime interrupt input already exists: ${inputId}`,
            0,
          );
        }
        const queueMessageId = enqueueWithArtifacts({
          sessionId: input.sessionId,
          content: normalized.prompt,
          inputArtifacts: normalized.inputArtifacts,
          provider: afterRun.provider,
          ...(afterRun.model !== undefined ? { model: afterRun.model } : {}),
        });
        const queuedAt = new Date().toISOString();
        const interrupt: RuntimeInterruptInputRecord = {
          inputId,
          afterRunId: input.afterRunId,
          delivery: "interrupt",
          state: "queued",
          contentPreview: previewQueuedInput(normalized.prompt),
          queuedAt,
          ...(trusted.origin !== undefined ? { origin: trusted.origin } : {}),
          input: persistedInput,
          queueMessageId,
        };
        afterRun.interruptInputs.push(interrupt);
        publishRunUpdate(afterRun);
        deps.bus.emit(
          "run.input.queued",
          {
            input: runtimeInterruptInputStatus(interrupt),
          },
          {
            sessionId: afterRun.sessionId,
            runId: afterRun.runId,
            ...(afterRun.turnId !== undefined
              ? { turnId: afterRun.turnId }
              : {}),
          },
        );
        return {
          accepted: true,
          delivery: "interrupt",
          inputId,
          runId: afterRun.runId,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          sessionOrder: afterRun.sessionOrder,
        };
      }

      if (!isActiveRunPhase(afterRun.phase) && afterRun.phase !== "queued") {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: "stale_run",
        };
      }

      const trusted = input as RuntimeTrustedSubmitInput;
      let handle: RuntimeRunHandle;
      try {
        handle = await start(
          {
            sessionId: input.sessionId,
            input: input.input,
            ...(trusted.options !== undefined
              ? { options: trusted.options }
              : {}),
            ...(trusted.providerCredential !== undefined
              ? { providerCredential: trusted.providerCredential }
              : {}),
            ...(trusted.providerCredentialProvider !== undefined
              ? {
                  providerCredentialProvider:
                    trusted.providerCredentialProvider,
                }
              : {}),
            ...(trusted.origin !== undefined ? { origin: trusted.origin } : {}),
            ...(trusted.trustedRunId !== undefined
              ? { trustedRunId: trusted.trustedRunId }
              : {}),
            requiredAfterRunId: input.afterRunId,
          } as RuntimeTrustedStartRunInput,
          "runtime.runs.submitInput",
        );
      } catch (error: unknown) {
        if (!(error instanceof RuntimeContinuationStaleError)) throw error;
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: "stale_run",
        };
      }
      const sessionOrder = getRecord(handle.runId).sessionOrder;
      return {
        accepted: true,
        delivery: input.delivery,
        runId: handle.runId,
        sessionId: input.sessionId,
        afterRunId: input.afterRunId,
        sessionOrder,
      };
    },

    async await(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      if (run?.ownedByRuntime === true) {
        await deps.sessionAdmission.assertRunAccess(run.sessionId);
        return run.result;
      }
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) {
        await deps.sessionAdmission.assertRunAccess(persisted.status.sessionId);
        return resultFromStatus(
          await observePersistedRun(persisted, deps.runs.get(runId)),
        );
      }
      if (run) {
        await deps.sessionAdmission.assertRunAccess(run.sessionId);
        return run.result;
      }
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async get(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) {
        await deps.sessionAdmission.assertRunAccess(persisted.status.sessionId);
        if (
          run === undefined
          || !run.ownedByRuntime
          || isTerminalRunPhase(persisted.status.phase)
        ) {
          return observePersistedRun(persisted, run);
        }
      }
      if (run) {
        await deps.sessionAdmission.assertRunAccess(run.sessionId);
        return statusFromRecord(run);
      }
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async list(filter) {
      deps.ensureOpen();
      if (filter?.sessionId !== undefined) {
        await deps.sessionAdmission.assertRunAccess(filter.sessionId);
      }
      const persistedEntries = deps.persistence.loadRunStatuses();
      const persistedStatuses = await Promise.all(
        persistedEntries.map((entry) =>
          observePersistedRun(entry, deps.runs.get(entry.status.runId))
        ),
      );
      const merged = new Map(
        persistedStatuses.map((status) => [status.runId, status]),
      );
      for (const run of deps.runs.values()) {
        const persisted = merged.get(run.runId);
        if (
          !run.ownedByRuntime
          || (persisted !== undefined && isTerminalRunPhase(persisted.phase))
        ) {
          continue;
        }
        merged.set(run.runId, statusFromRecord(run));
      }
      const matching = [...merged.values()].filter((status) =>
        runStatusMatchesFilter(status, filter)
      );
      return filterAdmittedRunStatuses(
        canonicalRuntimeRunStatuses(boundedRuntimeRunStatuses(matching)),
        deps.sessionAdmission,
      );
    },

    async inspect(filter) {
      deps.ensureOpen();
      if (filter?.sessionId !== undefined) {
        await deps.sessionAdmission.assertRunAccess(filter.sessionId);
      }
      const persistedEntries = deps.persistence.loadRunStatuses();
      const persistedStatuses = await Promise.all(
        persistedEntries.map((entry) =>
          inspectPersistedRun(entry, deps.runs.get(entry.status.runId))
        ),
      );
      const merged = new Map(
        persistedStatuses.map((status) => [status.runId, status]),
      );
      for (const run of deps.runs.values()) {
        if (!run.ownedByRuntime || isTerminalRunPhase(run.phase)) continue;
        merged.set(run.runId, statusFromRecord(run));
      }
      const matching = [...merged.values()].filter((status) =>
        runStatusMatchesFilter(status, filter)
      );
      return filterAdmittedRunStatuses(
        canonicalRuntimeRunStatuses(boundedRuntimeRunStatuses(matching)),
        deps.sessionAdmission,
      );
    },

    async inspectOne(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted !== undefined) {
        await deps.sessionAdmission.assertRunAccess(persisted.status.sessionId);
        return inspectPersistedRun(persisted, run);
      }
      if (run === undefined) return undefined;
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      return statusFromRecord(run);
    },

    async abort(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      const persisted = deps.persistence.loadRunStatus(runId);
      const sessionId = run?.sessionId ?? persisted?.status.sessionId;
      if (sessionId === undefined) {
        throw new Error(`Runtime run not found: ${runId}`);
      }
      await deps.sessionAdmission.assertRunAccess(sessionId);
      if (run !== undefined) assertRuntimeOwnsRun(run, deps.runOwner);
      if (
        run?.executorTerminalSignal !== undefined
        && !run.terminalEmitted
        && canApplyExecutorTerminalSignal(run)
      ) {
        cancelRun(run, "runtime run aborted", false);
        const terminal = deps.persistence.loadRunStatus(runId);
        return runtimeRunStopReceipt({
          accepted: false,
          status: terminal?.status ?? statusFromRecord(run),
          revision: terminal?.revision ?? 0,
        });
      }
      const stop = deps.persistence.requestRunStop(
        runId,
        "runtime run aborted",
      );
      if (run === undefined) return runtimeRunStopReceipt(stop);
      applyAuthoritativeRunStatus(run, stop.status);
      if (stop.status.stop !== undefined) {
        run.actorFinalizationAbortController?.abort(
          new Error("runtime run aborted"),
        );
      }
      if (stop.status.stop?.state === "unknown") {
        delete run.actorHealthBaseState;
      }
      if (stop.accepted) {
        const wasQueued = stop.status.phase === "cancelled";
        if (wasQueued) {
          removeQueuedRun(queueBySession, run);
        }
        releaseAbortSignalSubscription(run);
        run.running?.abort(new Error("runtime run aborted"));
        run.abortController?.abort(new Error("runtime run aborted"));
        deps.permissions.rejectForRun(run.runId, "runtime run aborted");
        deps.userInputs.rejectForRun(run.runId, "runtime run aborted");
        run.start?.options.guardrails
          ?.find(isRuntimeAutoModeGuardrail)
          ?.clearAllowedCalls();
        run.interruptInputOpen = false;
        terminalizeQueuedInterruptInputs(run);
        if (wasQueued) {
          deps.bus.emit("run.cancelled", stop.status, {
            sessionId: run.sessionId,
            runId: run.runId,
            ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
          });
          const result: RuntimeRunResult = {
            runId: run.runId,
            sessionId: run.sessionId,
            phase: run.phase,
            ...(run.terminal !== undefined ? { terminal: run.terminal } : {}),
            ...(run.stop !== undefined ? { stop: run.stop } : {}),
          };
          resolveRunStart(run, result);
          releaseActiveQueueRoute(run);
          releaseActiveRun(run);
          if (!deps.isClosed()) drainNext(run.sessionId);
        } else {
          deps.bus.emit("run.updated", stop.status, {
            sessionId: run.sessionId,
            runId: run.runId,
            ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
          });
        }
      }
      return runtimeRunStopReceipt(stop);
    },

    async setModel(runId, model) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      assertRuntimeOwnsRun(run, deps.runOwner);
      run.model = model;
      run.running?.setModel(model);
      publishRunUpdate(run);
    },

    async setProvider(runId, provider) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      assertRuntimeOwnsRun(run, deps.runOwner);
      run.provider = provider;
      run.running?.setProvider(provider);
      publishRunUpdate(run);
    },

    async setReasoning(runId, reasoning) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      assertRuntimeOwnsRun(run, deps.runOwner);
      run.reasoning = reasoning;
      run.running?.setReasoning(reasoning);
      publishRunUpdate(run);
    },

    closeAll(reason) {
      settingsSubscription.close();
      for (const run of deps.runs.values()) {
        if (
          run.ownedByRuntime
          && (
            run.phase === "queued"
            || isActiveRunPhase(run.phase)
            || run.phase === "unknown"
          )
        ) {
          cancelRun(run, reason, false);
        }
      }
      activeRunBySession.clear();
      autoModeGuardrails.clear();
      autoModeStates.clear();
      queueBySession.clear();
    },
    releaseSession(sessionId) {
      for (const entry of autoModeGuardrails.get(sessionId)?.values() ?? []) {
        entry.guardrail.clearAllowedCalls();
      }
      autoModeGuardrails.delete(sessionId);
      autoModeStates.delete(sessionId);
    },
    getAutoModeStats(sessionId) {
      const state = autoModeStates.get(sessionId);
      return state === undefined
        ? undefined
        : {
            engine: state.engine,
            classifierHealth: breakerShouldFallback(state.breaker, Date.now())
              ? "degraded"
              : "healthy",
            denials: state.denials,
            breaker: state.breaker,
          };
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
      return filter?.limit === undefined
        ? filtered
        : filtered.slice(0, filter.limit);
    },

    async get(runId) {
      return manager.getWorkflowProcessSnapshot(runId);
    },

    subscribe(filter, listener) {
      const unsubscribe = manager.subscribeWorkflowProcess((event) => {
        if (filter.runId && event.snapshot.runId !== filter.runId) return;
        if (
          filter.activeOnly === true &&
          isFinalWorkflowStatus(event.snapshot.status)
        )
          return;
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
      assertPlainObject(patch, "runtime.config.patch");
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
      return (
        listRuntimeCommands(input.projectRoot).find(
          (command) =>
            command.name.trim().toLowerCase() === normalized ||
            (command.aliases ?? []).some(
              (alias) => alias.trim().toLowerCase() === normalized,
            ),
        ) ?? null
      );
    },

    async skills(filter) {
      ensureOpen();
      const registry = await initializeSkillRegistry(filter?.projectRoot);
      const skills =
        filter?.userInvocableOnly === true
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
      const names =
        filter?.server !== undefined ? [filter.server] : Object.keys(servers);
      const manager = createMcpManager(servers);
      try {
        const result: McpServerToolList[] = [];
        for (const name of names) {
          result.push(
            await manager.listTools(name, {
              forceRefresh: filter?.forceRefresh === true,
            }),
          );
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
        throw new Error(
          `Unsupported runtime artifact kind: ${String(input.kind)}`,
        );
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
        throw new Error(
          `Runtime artifact path must be a regular file: ${resolvedPath}`,
        );
      }
      if (stats.size > MAX_RUNTIME_ARTIFACT_BYTES) {
        throw new Error(
          `Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte limit: ${resolvedPath}`,
        );
      }
      const id = `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const artifact: RuntimeArtifact = {
        id,
        kind: input.kind,
        path: resolvedPath,
        sizeBytes: stats.size,
        ...(input.mediaType !== undefined
          ? { mediaType: input.mediaType }
          : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
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
  readonly defaultConfigHome: string;
  readonly events: KodaXEvents;
  readonly model?: string;
  readonly options: RuntimeKodaXOptions;
  readonly provider: string;
  readonly record: RuntimeRunRecord;
  readonly sessionManager: SessionManager;
}): KodaXOptions {
  const {
    agentPlane,
    events,
    model,
    options,
    provider,
    record,
    sessionManager,
  } = input;
  const hideUnwiredExitPlanMode = options.events?.exitPlanMode === undefined;
  const {
    configHome: _callerConfigHome,
    memoryIdentity: _callerMemoryIdentity,
    shellSandbox: callerShellSandbox,
    ...ownerSafeContext
  } = options.context ?? {};
  const runtimeAutoGuardrail = options.guardrails?.find(isRuntimeAutoModeGuardrail);
  const workspaceRoot =
    options.context?.gitRoot ?? options.context?.executionCwd;
  const runtimeWorkspaceShellSandbox =
    runtimeAutoGuardrail !== undefined && workspaceRoot !== undefined
      ? createAsrtShellSandbox({
          workspaceRoot,
          shouldSandbox: (call) =>
            runtimeAutoGuardrail.consumeWorkspaceSandboxCall(call),
        })
      : undefined;
  const shellSandbox =
    runtimeWorkspaceShellSandbox !== undefined && callerShellSandbox !== undefined
      ? {
          async prepare(request: Parameters<KodaXShellSandbox["prepare"]>[0]) {
            let runtimeObservation:
              | Parameters<NonNullable<typeof request.reportObservation>>[0]
              | undefined;
            const runtimeInvocation = await runtimeWorkspaceShellSandbox.prepare({
              ...request,
              reportObservation: (observation) => {
                runtimeObservation = observation;
              },
            });
            if (runtimeInvocation !== undefined) return runtimeInvocation;

            let callerObservation:
              | Parameters<NonNullable<typeof request.reportObservation>>[0]
              | undefined;
            const callerInvocation = await callerShellSandbox.prepare({
              ...request,
              reportObservation: (observation) => {
                callerObservation = observation;
              },
            });
            if (callerInvocation !== undefined) return callerInvocation;

            const finalObservation = [callerObservation, runtimeObservation]
              .find((observation) => observation?.state === "fallback")
              ?? callerObservation
              ?? runtimeObservation;
            if (finalObservation !== undefined) {
              request.reportObservation?.(finalObservation);
            }
            return undefined;
          },
        }
      : runtimeWorkspaceShellSandbox ?? callerShellSandbox;
  const executeSkillDynamicContext = options.skillDynamicContext?.execute;
  const skillDynamicContext: NonNullable<
    KodaXOptions["skillDynamicContext"]
  > =
    options.skillDynamicContext?.disable === true ||
    executeSkillDynamicContext === undefined
      ? { disable: true }
      : {
          async execute(command, cwd) {
            if (
              replApi.normalizePermissionMode(record.permissionMode) === "plan"
            ) {
              throw new Error(
                "Dynamic context disabled by host. Skill `!`cmd`` blocks are not allowed in Plan mode.",
              );
            }
            return executeSkillDynamicContext(command, cwd);
          },
        };
  return {
    ...options,
    provider,
    // Runtime-hosted Skill expansion must never fall through to the resolver's
    // inline execSync path, which bypasses tool permission hooks. The wrapper
    // rechecks live mode so Plan always refuses dynamic commands; other modes
    // require and preserve an explicit host-mediated executor.
    skillDynamicContext,
    ...(model !== undefined ? { modelOverride: model } : {}),
    session: {
      ...(options.session ?? {}),
      id: record.sessionId,
      storage: sessionManager.storage,
      // The Runtime is the canonical Session owner even when a REPL client
      // supplied host-owned options before crossing the Runtime boundary.
      persistedByHost: false,
    },
    events,
    context: {
      ...ownerSafeContext,
      configHome: input.defaultConfigHome,
      ...(shellSandbox !== undefined ? { shellSandbox } : {}),
      ...(hideUnwiredExitPlanMode
        ? {
            // Runtime daemon options cannot transport callback functions. Do
            // not expose a plan-exit tool that can only raise a generic
            // permission request and then fail for lack of an approval UI.
            excludeTools: [
              ...new Set([
                ...(options.context?.excludeTools ?? []),
                "exit_plan_mode",
              ]),
            ],
          }
        : {}),
      ...(record.actorSession
        ? {
            actorSession: record.actorSession,
            interruptInput: {
              closeInputWindow() {
                record.interruptInputOpen = false;
              },
              reopenInputWindow() {
                if (
                  !record.terminalEmitted &&
                  isActiveRunPhase(record.phase) &&
                  options.abortSignal?.aborted !== true
                ) {
                  record.interruptInputOpen = true;
                }
              },
            },
          }
        : {}),
      ...(agentPlane && record.agentContext
        ? {
            agentExecutorPlane: {
              plane: agentPlane,
              context: record.agentContext,
            },
          }
        : {}),
    },
  };
}

function assertRuntimeAgentContext(context: AgentDispatchContext): void {
  if (context.actorId.trim().length === 0) {
    throw new Error("Runtime agent context actorId must not be empty.");
  }
}

function localAgentReasons(
  listing: ReturnType<typeof listCodingDispatchableAgents>[number],
  query: DispatchableAgentQuery,
): string[] {
  const reasons: string[] = [];
  const skills = new Set(listing.skills);
  for (const skill of query.requiredSkills ?? []) {
    if (!skills.has(skill))
      reasons.push(`required skill is unavailable: ${skill}`);
  }
  const required = query.requiredCapabilities;
  if (required) {
    for (const key of [
      "streaming",
      "durableTasks",
      "inputRequired",
      "cancellation",
      "artifacts",
    ] as const) {
      if (required[key] === true && listing.capabilities[key] !== "supported") {
        reasons.push(
          `required capability ${key} is ${listing.capabilities[key]}`,
        );
      }
    }
  }
  return reasons;
}

function runtimeLocalListings(
  query: DispatchableAgentQuery,
): readonly DispatchableAgentListing[] {
  assertRuntimeAgentContext(query);
  return listCodingDispatchableAgents(query)
    .map((descriptor): DispatchableAgentListing => {
      const reasons = localAgentReasons(descriptor, query);
      return {
        descriptor,
        dispatchability: {
          status: reasons.length === 0 ? "dispatchable" : "unavailable",
          checkedAt: new Date().toISOString(),
          reasons,
        },
      };
    })
    .filter((listing) => listing.dispatchability.status === "dispatchable");
}

interface RuntimeAgentActorRegistry {
  forSession(
    sessionId: string,
    maxConcurrentThreads?: number,
  ): Promise<CodingActorSession>;
  root(sessionId: string): Promise<AgentActorClient>;
  activeTurns(
    sessionIds: readonly string[],
  ): Promise<readonly RuntimeActiveAgentTurn[]>;
  mutateSessionFile<T>(
    sessionId: string,
    operation: "mutate" | "archive" | "unarchive" | "delete",
    mutation: (ownerId?: string) => Promise<T>,
  ): Promise<T>;
  close(reason: string): Promise<void>;
}

function createRuntimeAgentActorRegistry(
  sessionManager: SessionManager,
  identity: RuntimeIdentity,
  ownerLiveness: RuntimeActorOwnerLiveness,
  plane?: AgentExecutorPlane,
  defaultContext?: AgentDispatchContext,
  onHealthChanged?: (
    sessionId: string,
    health: AgentControllerHealth,
  ) => void,
): RuntimeAgentActorRegistry {
  const sessions = new Map<string, Promise<CodingActorSession>>();
  let closed = false;

  const claimSession = (
    sessionId: string,
    maxConcurrentThreads?: number,
  ): Promise<CodingActorSession> => {
    if (closed) return Promise.reject(new Error("KodaX runtime is closed"));
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing.then((session) => {
        const actual = session.rootControl().list().maxConcurrentThreads;
        if (
          maxConcurrentThreads !== undefined &&
          maxConcurrentThreads !== actual
        ) {
          throw new Error(
            `Actor concurrency for ${sessionId} is already ${actual}; cannot change it to ${maxConcurrentThreads}.`,
          );
        }
        return session;
      });
    }
    const created = (async () => {
      const data = await sessionManager.storage.peek(sessionId);
      if (!data) throw new Error(`Session not found: ${sessionId}`);
      const persistedMax = data.actorSnapshot?.maxConcurrentThreads;
      if (
        persistedMax !== undefined &&
        maxConcurrentThreads !== undefined &&
        persistedMax !== maxConcurrentThreads
      ) {
        throw new Error(
          `Persisted Actor concurrency for ${sessionId} is ${persistedMax}; requested ${maxConcurrentThreads}.`,
        );
      }
      const store: AgentActorStore = {
        async load(): Promise<AgentActorSnapshot | undefined> {
          return (await sessionManager.storage.peek(sessionId))?.actorSnapshot;
        },
        save(snapshot, expectedRevision) {
          return sessionManager.storage.saveActorSnapshot(
            sessionId,
            snapshot,
            expectedRevision,
          );
        },
      };
      const session = new CodingActorSession({
        sessionId,
        store,
        maxConcurrentThreadsPerSession: maxConcurrentThreads ?? persistedMax,
        owner: {
          ownerId: `actor_${randomUUID().replace(/-/g, "")}`,
          runtimeId: identity.runtimeId,
          pid: process.pid,
          startedAt: identity.startedAt,
          livenessId: ownerLiveness.id,
          livenessPort: ownerLiveness.port,
        },
        isOwnerAlive: isRuntimeActorOwnerAlive,
        onHealthChanged: (health) => onHealthChanged?.(sessionId, health),
        ...(plane
          ? {
              executor: createExternalActorTurnExecutor({
                plane,
                context: defaultContext ?? { actorId: `runtime:${sessionId}` },
              }),
            }
          : {}),
      });
      try {
        await session.initialize();
        onHealthChanged?.(sessionId, session.health());
        return session;
      } catch (error: unknown) {
        if (!session.ownsDurableFence()) throw error;
        try {
          await session.close("Actor initialization cleanup");
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `Actor session ${sessionId} initialization and owner cleanup both failed.`,
          );
        }
        throw error;
      }
    })();
    sessions.set(sessionId, created);
    void created.catch(() => sessions.delete(sessionId));
    return created;
  };

  const forSession = async (
    sessionId: string,
    maxConcurrentThreads?: number,
  ): Promise<CodingActorSession> => {
    const pending = claimSession(sessionId, maxConcurrentThreads);
    const registered = sessions.get(sessionId);
    const session = await pending;
    if (!(await sessionManager.storage.isArchived(sessionId))) return session;
    await session.close("archived Session execution rejected");
    if (sessions.get(sessionId) === registered) sessions.delete(sessionId);
    throw createSessionArchivedError(sessionId);
  };

  return {
    forSession,
    async root(sessionId) {
      return (await forSession(sessionId)).rootControl();
    },
    async activeTurns(sessionIds) {
      const snapshots = await Promise.all(
        sessionIds.map(async (sessionId) => {
          if (await sessionManager.storage.isArchived(sessionId)) {
            return undefined;
          }
          const existing = sessions.get(sessionId);
          if (existing) {
            return {
              sessionId,
              snapshot: (await existing).rootControl().list(),
            };
          }
          const data = await sessionManager.storage.peek(sessionId);
          if (!data?.actorSnapshot) return undefined;
          if (
            data.actorSnapshot.schemaVersion === 2
            && data.actorSnapshot.owner !== undefined
            && !await isRuntimeActorOwnerAlive(data.actorSnapshot.owner)
          ) {
            return undefined;
          }
          return {
            sessionId,
            snapshot: data.actorSnapshot,
          };
        }),
      );
      return snapshots.flatMap((entry) => {
        if (!entry) return [];
        const { sessionId, snapshot } = entry;
        return snapshot.actors.flatMap((actor) =>
          actor.currentTurnId && actor.path !== "/root"
            ? [
                {
                  sessionId,
                  actorPath: actor.path,
                  turnId: actor.currentTurnId,
                  kind: actor.kind,
                },
              ]
            : [],
        );
      });
    },
    async mutateSessionFile(sessionId, operation, mutation) {
      if (closed) throw new Error("KodaX runtime is closed");
      const pending = sessions.get(sessionId) ?? claimSession(sessionId);
      const session = await pending;
      const root = session.rootControl();
      const snapshot = root.list();
      if (
        operation === "mutate"
        && await sessionManager.storage.isArchived(sessionId)
      ) {
        await session.close("archived Session mutation rejected");
        if (sessions.get(sessionId) === pending) sessions.delete(sessionId);
        throw createSessionArchivedError(sessionId);
      }
      const hasActiveActor = snapshot.actors.some(
        (actor) => actor.currentTurnId !== undefined,
      );
      if (
        (operation === "archive" || operation === "unarchive")
        && hasActiveActor
      ) {
        throw createRuntimeConflictError(
          `Session has active Agent turns and cannot be moved: ${sessionId}`,
          snapshot.revision,
        );
      }
      if (operation === "delete" && hasActiveActor) {
        await session.quiesce("session deleted");
      }
      const result = await mutation(session.ownerId());
      if (operation === "delete") {
        session.disposeAfterStoreRemoval("session deleted");
      } else if (operation !== "mutate") {
        await session.close(`session ${operation}d`);
      }
      if (
        operation !== "mutate"
        && sessions.get(sessionId) === pending
      ) {
        sessions.delete(sessionId);
      }
      return result;
    },
    async close(reason) {
      closed = true;
      const settled = await Promise.allSettled([...sessions.values()]);
      const closeResults = await Promise.allSettled(
        settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.close(reason)] : [],
        ),
      );
      const errors = closeResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Actor registry cleanup failed.");
      }
      sessions.clear();
    },
  };
}

function createRuntimeAgentService(
  plane: AgentExecutorPlane | undefined,
  bindings: RuntimeAgentBindingService,
  actors: RuntimeAgentActorRegistry,
  admission: RuntimeSessionAdmission,
  sessionOperations: RuntimeSessionOperationGate,
  ensureOpen: () => void,
): RuntimeAgentService {
  const withRoot = <T>(
    sessionId: string,
    operation: (root: AgentActorClient) => Promise<T> | T,
  ): Promise<T> =>
    sessionOperations.run(sessionId, async () => {
      ensureOpen();
      await admission.loadExecutable(sessionId);
      return operation(await actors.root(sessionId));
    });

  return {
    execution: bindings,
    enabled: plane !== undefined,
    async listDispatchable(query) {
      ensureOpen();
      assertRuntimeAgentContext(query);
      const local = listCodingDispatchableAgents(query);
      return plane
        ? plane.listDispatchable(query, local)
        : runtimeLocalListings(query);
    },
    async describe(agentId, query) {
      assertRuntimeAgentContext(query);
      const local = listCodingDispatchableAgents(query);
      if (plane) return plane.describe(agentId, query, local);
      return runtimeLocalListings(query).find(
        (listing) => listing.descriptor.agentId === agentId,
      );
    },
    async preflight(input) {
      assertRuntimeAgentContext(input.query);
      const local = listCodingDispatchableAgents(input.query);
      if (plane) return plane.preflight(input, local);
      const listing = runtimeLocalListings(input.query).find(
        (candidate) => candidate.descriptor.agentId === input.agentId,
      );
      const reasons = listing ? [] : ["agent is not dispatchable"];
      if (
        listing &&
        input.expectedConfigurationRevision !== undefined &&
        listing.descriptor.configurationRevision !==
          input.expectedConfigurationRevision
      )
        reasons.push("configuration revision changed");
      return {
        ok: listing !== undefined && reasons.length === 0,
        ...(listing ? { descriptor: listing.descriptor } : {}),
        dispatchability: listing?.dispatchability ?? {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasons,
        },
        reasons,
      };
    },
    async tree(sessionId) {
      return withRoot(sessionId, (root) => root.list());
    },
    async detail(sessionId, actorPath) {
      return withRoot(sessionId, (root) => root.get(actorPath));
    },
    async spawn(sessionId, input) {
      return withRoot(sessionId, (root) => root.spawn(input));
    },
    async send(sessionId, actorPath, content, classification) {
      await withRoot(sessionId, (root) =>
        root.send(actorPath, content, classification),
      );
    },
    async followup(sessionId, actorPath, objective, options) {
      return withRoot(sessionId, (root) =>
        root.followup(
          actorPath,
          objective,
          undefined,
          options,
        ),
      );
    },
    async interrupt(sessionId, actorPath, reason) {
      await withRoot(sessionId, (root) => root.interrupt(actorPath, reason));
    },
    async output(sessionId, actorPath, turnId) {
      return withRoot(sessionId, (root) => root.output(actorPath, turnId));
    },
    async events(sessionId, afterSequence) {
      return withRoot(
        sessionId,
        (root) => root.eventSnapshot(afterSequence),
      );
    },
    async wait(sessionId, afterSequence, timeoutMs, options) {
      const root = await withRoot(sessionId, (actorRoot) => actorRoot);
      return root.wait(afterSequence, timeoutMs, options?.signal);
    },
  };
}

function externalAgentsDisabled(): Error {
  return new Error("Runtime external agent executor plane is not enabled.");
}

function createRuntimeAdminService(
  plane: AgentExecutorPlane | undefined,
): RuntimeAdminService {
  return {
    agentRegistrations: plane?.registrations ?? {
      async list() {
        return [];
      },
      async upsert() {
        throw externalAgentsDisabled();
      },
      async setEnabled() {
        throw externalAgentsDisabled();
      },
      async remove() {
        throw externalAgentsDisabled();
      },
    },
  };
}

function createRuntimeStatusService(deps: {
  readonly identity: RuntimeIdentity;
  readonly permissions: RuntimePermissionRegistry;
  readonly userInputs: RuntimeUserInputRegistry;
  readonly listRuns: () => Promise<readonly RuntimeRunStatus[]>;
  readonly sessionManager: SessionManager;
  readonly sessionAdmission: RuntimeSessionAdmission;
  readonly workflows: RuntimeWorkflowService;
  readonly actors: RuntimeAgentActorRegistry;
}): RuntimeStatusService {
  return {
    async snapshot() {
      const runs = await deps.listRuns();
      return {
        runtimeId: deps.identity.runtimeId,
        mode: deps.identity.mode,
        profile: deps.identity.profile,
        startedAt: deps.identity.startedAt,
        sessions: (
          await deps.sessionManager.listSessions({ includeArchived: true })
        )
          .filter(deps.sessionAdmission.admitsSummary)
          .map(toRuntimeSessionSummary),
        runs,
        pendingPermissions: await deps.permissions.service.listPending(),
        workflows: await deps.workflows.list({}),
      };
    },
    async preflight() {
      const runs = await deps.listRuns();
      const activeRuns = runs.filter(
        (run) =>
          isActiveRunPhase(run.phase) || run.phase === "unknown",
      );
      const queuedRuns = runs.filter((run) => run.phase === "queued");
      const activeWorkflows = (await deps.workflows.list({})).filter(
        (workflow) =>
          workflow.status !== "completed" &&
          workflow.status !== "failed" &&
          workflow.status !== "denied" &&
          workflow.status !== "stopped",
      );
      const admittedSessionIds = (
        await deps.sessionManager.listSessions({ includeArchived: true })
      )
        .filter(deps.sessionAdmission.admitsSummary)
        .map((session) => session.id);
      const activeAgentTurns =
        await deps.actors.activeTurns(admittedSessionIds);
      const pendingPermissions = await deps.permissions.service.listPending();
      const pendingUserInputs = await deps.userInputs.service.listPending();
      const blockers: RuntimeDaemonPreflight["blockers"][number][] = [];
      if (activeRuns.length > 0) blockers.push("active_runs");
      if (queuedRuns.length > 0) blockers.push("queued_runs");
      if (activeWorkflows.length > 0) blockers.push("active_workflows");
      if (activeAgentTurns.length > 0) blockers.push("active_agent_turns");
      if (activeAgentTurns.length > 0) blockers.push("active_agent_tasks");
      if (pendingPermissions.length > 0 || pendingUserInputs.length > 0) {
        blockers.push("pending_interactions");
      }
      return {
        runtimeId: deps.identity.runtimeId,
        clientCount: 0,
        activeRuns,
        queuedRuns,
        activeWorkflows,
        activeAgentTurns,
        activeAgentTasks: activeAgentTurns,
        pendingPermissions,
        pendingUserInputs,
        blockers,
        canStop: blockers.length === 0,
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
        "context.budget.snapshot",
        filter,
      );
    },
    latestToolExposure(filter) {
      return latestRuntimeDiagnosticPayload<RuntimeToolExposurePlan>(
        events,
        "tool.exposure.planned",
        filter,
      );
    },
    latestProviderCacheDiagnostic(filter) {
      return latestRuntimeDiagnosticPayload<KodaXPromptCacheDiagnosticEvent>(
        events,
        "provider.cache.diagnostics",
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
  const requestedContextKind =
    filter?.contextKind ?? (filter?.agentId === undefined ? "root" : undefined);
  const requestsChildContext =
    requestedContextKind === "child" || filter?.agentId !== undefined;
  const replayFilter: RuntimeEventReplayFilter = {
    type,
    ...(!requestsChildContext && filter?.sessionId !== undefined
      ? { sessionId: filter.sessionId }
      : {}),
    ...(filter?.runId !== undefined ? { runId: filter.runId } : {}),
  };
  const replay = await events.replay(replayFilter);
  const matching = [...replay].reverse().find((event) => {
    const payload = event.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return filter?.contextKind === undefined && filter?.agentId === undefined;
    }
    const diagnostic = payload as {
      readonly contextId?: unknown;
      readonly contextKind?: unknown;
      readonly agentId?: unknown;
    };
    const actualContextKind =
      diagnostic.contextKind === "child" ? "child" : "root";
    if (
      requestedContextKind !== undefined &&
      actualContextKind !== requestedContextKind
    ) {
      return false;
    }
    if (
      filter?.agentId !== undefined &&
      diagnostic.agentId !== filter.agentId
    ) {
      return false;
    }
    if (!requestsChildContext || filter?.sessionId === undefined) {
      return true;
    }
    const expectedPrefix = `${filter.sessionId}/agent/`;
    if (typeof diagnostic.contextId !== "string") return false;
    return filter.agentId === undefined
      ? diagnostic.contextId.startsWith(expectedPrefix)
      : diagnostic.contextId ===
          `${expectedPrefix}${encodeURIComponent(filter.agentId)}`;
  });
  return (matching?.payload as T | undefined) ?? null;
}

function isActiveRunPhase(phase: RuntimeRunPhase): boolean {
  return (
    phase === "running" ||
    phase === "waiting_agent" ||
    phase === "recovering" ||
    phase === "waiting_permission" ||
    phase === "waiting_user_input"
  );
}

function removeQueuedRun(
  queueBySession: Map<string, string[]>,
  run: RuntimeRunRecord,
): void {
  const queue = queueBySession.get(run.sessionId);
  if (!queue) return;
  const next = queue.filter((runId) => runId !== run.runId);
  if (next.length === 0) {
    queueBySession.delete(run.sessionId);
  } else {
    queueBySession.set(run.sessionId, next);
  }
}

interface RuntimeEventEmissionScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
}

interface RuntimeEventMergePlan {
  readonly key: string;
  readonly mode: "append_text" | "append_tool_input" | "latest";
  readonly bytes: number;
  readonly preserveFirst?: boolean;
}

interface PendingRuntimeEventEmission {
  readonly type: RuntimeEventType;
  readonly payload: unknown;
  readonly scope: RuntimeEventEmissionScope;
  readonly time: string;
  readonly merge?: RuntimeEventMergePlan;
}

function runtimeEventMergePlan(
  type: RuntimeEventType,
  payload: unknown,
  scope: RuntimeEventEmissionScope,
): RuntimeEventMergePlan | undefined {
  const value = isRecord(payload) ? payload : undefined;
  if (
    (type === "assistant.delta" || type === "thinking.delta")
    && typeof value?.text === "string"
  ) {
    return {
      key: runtimeEventMergeKey(type, payload, scope),
      mode: "append_text",
      bytes: Buffer.byteLength(value.text, "utf-8"),
    };
  }
  if (type === "tool.progress" && typeof value?.partialJson === "string") {
    const meta = isRecord(value.meta) ? value.meta : undefined;
    const toolId = typeof meta?.toolId === "string" ? meta.toolId : "";
    if (toolId.length === 0) return undefined;
    return {
      key: runtimeEventMergeKey(type, payload, scope, `tool:${toolId}`),
      mode: "append_tool_input",
      bytes: Buffer.byteLength(value.partialJson, "utf-8"),
    };
  }
  if (type === "tool.progress" && isRecord(value?.update)) {
    const updateId =
      typeof value.update.id === "string" ? value.update.id : "";
    if (updateId.length === 0) return undefined;
    return {
      key: runtimeEventMergeKey(type, payload, scope, `progress:${updateId}`),
      mode: "latest",
      bytes: runtimeEventPayloadBytes(payload),
      preserveFirst: true,
    };
  }
  if (type === "run.progress" && value?.kind === "managed_task_status") {
    return {
      key: runtimeEventMergeKey(type, payload, scope),
      mode: "latest",
      bytes: runtimeEventPayloadBytes(payload),
    };
  }
  if (type === "workflow.updated") {
    const snapshot = isRecord(value?.snapshot) ? value.snapshot : undefined;
    const workflowRunId =
      typeof snapshot?.runId === "string" ? snapshot.runId : "";
    if (workflowRunId.length === 0) return undefined;
    return {
      key: runtimeEventMergeKey(
        type,
        payload,
        scope,
        `workflow:${workflowRunId}`,
      ),
      mode: "latest",
      bytes: runtimeEventPayloadBytes(payload),
    };
  }
  return undefined;
}

function runtimeEventPayloadBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf-8");
  } catch {
    return MAX_RUNTIME_COALESCED_EVENT_BYTES;
  }
}

function runtimePendingEmissionBytes(
  emission: PendingRuntimeEventEmission,
): number {
  const serialized = JSON.stringify(emission);
  if (serialized === undefined) {
    throw new Error("Runtime event emission is not serializable");
  }
  return Buffer.byteLength(serialized, "utf-8");
}

function snapshotRuntimeEventPayload(payload: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch (error: unknown) {
    throw new Error("Runtime event payload is not serializable", {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new Error("Runtime event payload is not serializable");
  }
  return JSON.parse(serialized) as unknown;
}

function runtimeEventMergeKey(
  type: RuntimeEventType,
  payload: unknown,
  scope: RuntimeEventEmissionScope,
  qualifier = "",
): string {
  const value = isRecord(payload) ? payload : undefined;
  const meta = isRecord(value?.meta) ? value.meta : undefined;
  const correlation = isRecord(meta?.workflowCorrelation)
    ? meta.workflowCorrelation
    : undefined;
  const side = [
    meta?.contextKind,
    meta?.contextId,
    meta?.parentContextId,
    meta?.agentId,
    meta?.childAgentId,
    meta?.parentToolId,
    correlation?.workflowRunId,
    correlation?.childAgentId,
    meta?.liveOnly === true ? "live" : "",
  ].map((part) => typeof part === "string" ? part : "").join("\u0001");
  return [
    scope.sessionId,
    scope.runId,
    scope.turnId ?? "",
    type,
    side,
    qualifier,
  ].join("\u0000");
}

function mergeRuntimeEventEmissions(
  previous: PendingRuntimeEventEmission,
  next: PendingRuntimeEventEmission,
): PendingRuntimeEventEmission {
  const previousMerge = previous.merge;
  if (previousMerge === undefined) return next;
  const mode = previousMerge.mode;
  const previousPayload = isRecord(previous.payload) ? previous.payload : {};
  const nextPayload = isRecord(next.payload) ? next.payload : {};
  if (mode === "append_text") {
    return {
      ...previous,
      payload: {
        ...previousPayload,
        ...nextPayload,
        text: `${previousPayload.text ?? ""}${nextPayload.text ?? ""}`,
      },
      merge: {
        ...previousMerge,
        bytes: previousMerge.bytes + (next.merge?.bytes ?? 0),
      },
    };
  }
  if (mode === "append_tool_input") {
    return {
      ...previous,
      payload: {
        ...previousPayload,
        ...nextPayload,
        partialJson:
          `${previousPayload.partialJson ?? ""}${nextPayload.partialJson ?? ""}`,
      },
      merge: {
        ...previousMerge,
        bytes: previousMerge.bytes + (next.merge?.bytes ?? 0),
      },
    };
  }
  return next;
}

function createRuntimeEventBus(persistence: RuntimePersistence) {
  let closed = false;
  const events: RuntimeEvent[] = [];
  const liveBySession = new Map<string, RuntimeSessionLiveProjectionState>();
  const latestSeqBySession = new Map<string, number>();
  const pendingEmissions: PendingRuntimeEventEmission[] = [];
  const notificationQueue: RuntimeEvent[] = [];
  const preservedLatestKeysByRun = new Map<string, Set<string>>();
  const closeListeners = new Set<() => void>();
  const subscribers = new Set<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }>();
  let pendingBytes = 0;
  let scheduledFlush: ReturnType<typeof setTimeout> | undefined;
  let disconnectFlushScheduled = false;
  let terminalPersistenceError: RuntimeEventCommitIndeterminateError | undefined;
  let persistenceBackpressureError: Error | undefined;
  let closeError: Error | undefined;
  let persistenceFailureReported = false;
  let deliveringNotifications = false;
  let notificationIndex = 0;
  let pendingSerializedBytes = 0;

  const matches = (
    event: RuntimeEvent,
    filter: RuntimeEventFilter | undefined,
  ): boolean => {
    if (!filter) return true;
    if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId)
      return false;
    if (filter.runId !== undefined && event.runId !== filter.runId)
      return false;
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

  const notifyOne = (event: RuntimeEvent): void => {
    for (const subscriber of [...subscribers]) {
      if (!matches(event, subscriber.filter)) continue;
      try {
        subscriber.listener(event);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: "runtime.events",
          level: "error",
          message: `Runtime event listener failed for ${event.type}`,
          detail: {
            eventId: event.id,
            error: normalizeError(error),
          },
        });
      }
    }
  };

  const notify = (batch: readonly RuntimeEvent[]): void => {
    notificationQueue.push(...batch);
    if (deliveringNotifications) return;
    deliveringNotifications = true;
    try {
      while (notificationIndex < notificationQueue.length) {
        const event = notificationQueue[notificationIndex];
        notificationIndex += 1;
        if (event !== undefined) notifyOne(event);
      }
    } finally {
      notificationQueue.splice(0, notificationIndex);
      notificationIndex = 0;
      deliveringNotifications = false;
    }
  };

  const createEvents = (
    emissions: readonly PendingRuntimeEventEmission[],
    firstSeq: number,
  ): RuntimeEvent[] => {
    if (emissions.length === 0) return [];
    return emissions.map((emission, index) => {
      const seq = firstSeq + index;
      return {
        id: `evt_${seq}_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        seq,
        time: emission.time,
        sessionId: emission.scope.sessionId,
        runId: emission.scope.runId,
        ...(emission.scope.turnId !== undefined
          ? { turnId: emission.scope.turnId }
          : {}),
        type: emission.type,
        payload: emission.payload,
      };
    });
  };

  const commitEvents = (
    count: number,
    create: (firstSeq: number) => readonly RuntimeEvent[],
  ): readonly RuntimeEvent[] => {
    if (terminalPersistenceError !== undefined) {
      throw terminalPersistenceError;
    }
    try {
      return persistence.commitEvents(count, create);
    } catch (error: unknown) {
      if (error instanceof RuntimeEventCommitIndeterminateError) {
        terminalPersistenceError = error;
        persistenceBackpressureError = undefined;
        clearScheduledFlush();
        pendingEmissions.splice(0, pendingEmissions.length);
        pendingBytes = 0;
        pendingSerializedBytes = 0;
        preservedLatestKeysByRun.clear();
      }
      throw error;
    }
  };

  const applyAndRemember = (batch: readonly RuntimeEvent[]): void => {
    for (const event of batch) {
      latestSeqBySession.set(event.sessionId, event.seq);
      const live =
        liveBySession.get(event.sessionId) ??
        createRuntimeSessionLiveProjectionState();
      liveBySession.set(event.sessionId, live);
      applyRuntimeSessionEvent(live, event);
      remember(event);
      if (isTerminalRuntimeEvent(event.type)) {
        preservedLatestKeysByRun.delete(event.runId);
      }
    }
  };

  const clearScheduledFlush = (): void => {
    if (scheduledFlush !== undefined) {
      clearTimeout(scheduledFlush);
      scheduledFlush = undefined;
    }
  };

  const nextRunEmissionCount = (): number => {
    const runId = pendingEmissions[0]?.scope.runId;
    if (runId === undefined) return 0;
    let count = 0;
    while (pendingEmissions[count]?.scope.runId === runId) count += 1;
    return count;
  };

  const flushPending = (): void => {
    clearScheduledFlush();
    if (terminalPersistenceError !== undefined) {
      throw terminalPersistenceError;
    }
    while (pendingEmissions.length > 0) {
      const count = nextRunEmissionCount();
      const emissions = pendingEmissions.slice(0, count);
      let committed: readonly RuntimeEvent[];
      try {
        committed = commitEvents(
          count,
          (firstSeq) => createEvents(emissions, firstSeq),
        );
      } catch (error: unknown) {
        if (terminalPersistenceError === undefined) {
          persistenceBackpressureError = normalizeError(error);
          clearScheduledFlush();
        }
        throw error;
      }
      persistenceBackpressureError = undefined;
      pendingEmissions.splice(0, count);
      pendingBytes = Math.max(
        0,
        pendingBytes - emissions.reduce(
          (total, emission) => total + (emission.merge?.bytes ?? 0),
          0,
        ),
      );
      pendingSerializedBytes = Math.max(
        0,
        pendingSerializedBytes - emissions.reduce(
          (total, emission) => total + runtimePendingEmissionBytes(emission),
          0,
        ),
      );
      persistenceFailureReported = false;
      applyAndRemember(committed);
      notify(committed);
    }
  };

  const scheduleFlush = (): void => {
    if (
      closed
      || terminalPersistenceError !== undefined
      || persistenceBackpressureError !== undefined
    ) return;
    if (scheduledFlush !== undefined) return;
    scheduledFlush = setTimeout(() => {
      scheduledFlush = undefined;
      if (closed) return;
      try {
        flushPending();
      } catch (error: unknown) {
        if (!persistenceFailureReported) {
          persistenceFailureReported = true;
          emitKodaXDiagnostic({
            source: "runtime.persistence",
            level: "error",
            message: "Failed to persist coalesced runtime events",
            detail: error,
          });
        }
        // A determinate failure retains the current batch for an explicit
        // replay/close retry. Do not spin in the background or accept more
        // provider output while persistence is unavailable.
      }
    }, RUNTIME_EVENT_COALESCE_INTERVAL_MS);
    scheduledFlush.unref?.();
  };

  const flushPendingSafely = (): void => {
    try {
      flushPending();
    } catch (error: unknown) {
      if (!persistenceFailureReported) {
        persistenceFailureReported = true;
        emitKodaXDiagnostic({
          source: "runtime.persistence",
          level: "error",
          message: "Failed to persist coalesced runtime events",
          detail: error,
        });
      }
      // The failure latch is cleared only by a later explicit successful
      // flush, keeping background retries and queue growth bounded.
    }
  };

  const commitEmissionDirectly = (
    emission: PendingRuntimeEventEmission,
  ): void => {
    const committed = commitEvents(
      1,
      (firstSeq) => createEvents([emission], firstSeq),
    );
    applyAndRemember(committed);
    notify(committed);
  };

  const replacePendingLatest = (
    emission: PendingRuntimeEventEmission,
  ): void => {
    const merge = emission.merge;
    if (merge?.mode !== "latest") return;
    for (let index = pendingEmissions.length - 1; index >= 0; index -= 1) {
      const candidate = pendingEmissions[index];
      if (candidate?.merge === undefined) break;
      if (
        candidate.merge.mode === "latest"
        && candidate.merge.key === merge.key
      ) {
        pendingEmissions.splice(index, 1);
        pendingBytes = Math.max(0, pendingBytes - candidate.merge.bytes);
        pendingSerializedBytes = Math.max(
          0,
          pendingSerializedBytes - runtimePendingEmissionBytes(candidate),
        );
        break;
      }
    }
    pendingEmissions.push(emission);
    pendingBytes += merge.bytes;
    pendingSerializedBytes += runtimePendingEmissionBytes(emission);
  };

  const shouldPreserveFirstLatest = (
    emission: PendingRuntimeEventEmission,
  ): boolean => {
    const merge = emission.merge;
    if (merge?.mode !== "latest" || merge.preserveFirst !== true) return false;
    const runKeys =
      preservedLatestKeysByRun.get(emission.scope.runId) ?? new Set<string>();
    if (runKeys.has(merge.key)) return false;
    runKeys.add(merge.key);
    preservedLatestKeysByRun.set(emission.scope.runId, runKeys);
    return true;
  };

  const enqueue = (
    type: RuntimeEventType,
    payload: unknown,
    scope: RuntimeEventEmissionScope,
  ): void => {
    if (closed) throw new Error("KodaX runtime event bus is closed");
    if (terminalPersistenceError !== undefined) {
      throw terminalPersistenceError;
    }
    if (persistenceBackpressureError !== undefined) {
      throw persistenceBackpressureError;
    }
    const payloadSnapshot = snapshotRuntimeEventPayload(payload);
    const merge = runtimeEventMergePlan(type, payloadSnapshot, scope);
    const emission: PendingRuntimeEventEmission = {
      type,
      payload: payloadSnapshot,
      scope,
      time: new Date().toISOString(),
      ...(merge !== undefined ? { merge } : {}),
    };
    const serializedBytes = runtimePendingEmissionBytes(emission);
    if (serializedBytes > MAX_RUNTIME_PENDING_EVENT_BYTES) {
      flushPending();
      commitEmissionDirectly(emission);
      return;
    }
    if (
      pendingEmissions.length >= MAX_RUNTIME_PENDING_EVENTS
      || pendingSerializedBytes + serializedBytes > MAX_RUNTIME_PENDING_EVENT_BYTES
    ) {
      flushPending();
    }
    if (merge === undefined) {
      pendingEmissions.push(emission);
      pendingSerializedBytes += serializedBytes;
      flushPendingSafely();
      return;
    }
    if (merge.mode === "latest") {
      if (shouldPreserveFirstLatest(emission)) {
        pendingEmissions.push(emission);
        pendingBytes += merge.bytes;
        pendingSerializedBytes += serializedBytes;
        flushPendingSafely();
        return;
      }
      replacePendingLatest(emission);
    } else {
      const previous = pendingEmissions.at(-1);
      const canMerge =
        previous?.merge?.key === merge.key
        && previous.merge.mode === merge.mode;
      if (
        canMerge
        && previous.merge.bytes + merge.bytes
          > MAX_RUNTIME_COALESCED_EVENT_BYTES
      ) {
        flushPendingSafely();
        if (terminalPersistenceError !== undefined) {
          throw terminalPersistenceError;
        }
        if (persistenceBackpressureError !== undefined) {
          throw persistenceBackpressureError;
        }
        pendingEmissions.push(emission);
        pendingBytes += merge.bytes;
        pendingSerializedBytes += serializedBytes;
      } else if (canMerge) {
        const merged = mergeRuntimeEventEmissions(previous, emission);
        pendingBytes += (merged.merge?.bytes ?? 0) - previous.merge.bytes;
        pendingSerializedBytes += runtimePendingEmissionBytes(merged)
          - runtimePendingEmissionBytes(previous);
        pendingEmissions[pendingEmissions.length - 1] = merged;
      } else {
        pendingEmissions.push(emission);
        pendingBytes += merge.bytes;
        pendingSerializedBytes += serializedBytes;
      }
    }
    if (pendingBytes >= MAX_RUNTIME_COALESCED_EVENT_BYTES) {
      flushPendingSafely();
    } else {
      scheduleFlush();
    }
  };

  const service: RuntimeEventService = {
    subscribe(filter, listener) {
      if (closed) {
        throw new Error("KodaX runtime event bus is closed");
      }
      flushPending();
      const subscriber = { filter, listener };
      subscribers.add(subscriber);
      return {
        close() {
          subscribers.delete(subscriber);
          if (disconnectFlushScheduled) return;
          disconnectFlushScheduled = true;
          queueMicrotask(() => {
            disconnectFlushScheduled = false;
            if (!closed) flushPendingSafely();
          });
        },
      };
    },

    async replay(filter) {
      flushPending();
      const source = persistence.replay(filter);
      const replayEvents = new Map<string, RuntimeEvent>();
      for (const event of source) replayEvents.set(event.id, event);
      for (const event of events) replayEvents.set(event.id, event);
      const matched = [...replayEvents.values()]
        .filter(
          (event) =>
            matches(event, filter) &&
            (filter?.sinceSeq === undefined || event.seq > filter.sinceSeq),
        )
        .sort((a, b) => a.seq - b.seq || a.time.localeCompare(b.time));
      return filter?.limit === undefined
        ? matched
        : matched.slice(-filter.limit);
    },
  };

  return {
    service,
    subscribeClose(listener: () => void): RuntimeSubscription {
      if (closed) {
        listener();
        return { close() {} };
      }
      closeListeners.add(listener);
      return {
        close() {
          closeListeners.delete(listener);
        },
      };
    },
    emit(
      type: RuntimeEventType,
      payload: unknown,
      scope: RuntimeEventEmissionScope,
    ): void {
      enqueue(type, payload, scope);
    },
    emitDurable(
      type: RuntimeEventType,
      payload: unknown,
      scope: RuntimeEventEmissionScope,
      afterPersist?: () => void,
    ): RuntimeEvent {
      flushPending();
      const emission: PendingRuntimeEventEmission = {
        type,
        payload,
        scope,
        time: new Date().toISOString(),
      };
      const event = commitEvents(
        1,
        (firstSeq) => createEvents([emission], firstSeq),
      )[0]!;
      afterPersist?.();
      applyAndRemember([event]);
      notify([event]);
      return event;
    },
    projectSession(sessionId: string): RuntimeSessionLiveProjection {
      flushPending();
      const live = liveBySession.get(sessionId);
      return live === undefined
        ? snapshotRuntimeSessionLiveProjection(
            createRuntimeSessionLiveProjectionState(),
          )
        : snapshotRuntimeSessionLiveProjection(live);
    },
    currentSessionSeq(sessionId: string): number {
      flushPending();
      const current = latestSeqBySession.get(sessionId);
      if (current !== undefined) return current;
      const recovered = latestRuntimeEventSeq(
        persistence.replay({ sessionId }),
      );
      latestSeqBySession.set(sessionId, recovered);
      return recovered;
    },
    close() {
      if (closed) {
        if (closeError !== undefined) throw closeError;
        return;
      }
      let failure: Error | undefined;
      try {
        flushPending();
      } catch (error: unknown) {
        failure = normalizeError(error);
      } finally {
        closed = true;
        clearScheduledFlush();
        pendingEmissions.splice(0, pendingEmissions.length);
        pendingBytes = 0;
        pendingSerializedBytes = 0;
        for (const listener of [...closeListeners]) {
          try {
            listener();
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: "runtime.events",
              level: "error",
              message: "Runtime event close listener failed.",
              detail: normalizeError(error),
            });
          }
        }
        closeListeners.clear();
        try {
          persistence.close();
        } catch (error: unknown) {
          const persistenceError = normalizeError(error);
          failure ??= persistenceError;
          emitKodaXDiagnostic({
            source: "runtime.persistence",
            level: "error",
            message: "Failed to flush runtime events while closing",
            detail: persistenceError,
          });
        }
        subscribers.clear();
        liveBySession.clear();
        latestSeqBySession.clear();
      }
      closeError = failure;
      if (failure !== undefined) throw failure;
    },
  };
}

interface RuntimeSessionLiveProjectionState {
  readonly assistantTextByRun: Record<string, string>;
  readonly thinkingTextByRun: Record<string, string>;
  readonly activeTools: Map<string, RuntimeActiveToolProjection>;
  readonly pendingUserInputs: Map<string, RuntimePendingUserInputProjection>;
  readonly managedTasks: Map<string, RuntimeManagedTaskProjection>;
  todo: unknown;
}

function createRuntimeSessionLiveProjectionState(): RuntimeSessionLiveProjectionState {
  return {
    assistantTextByRun: {},
    thinkingTextByRun: {},
    activeTools: new Map(),
    pendingUserInputs: new Map(),
    managedTasks: new Map(),
    todo: undefined,
  };
}

function applyRuntimeSessionEvent(
  live: RuntimeSessionLiveProjectionState,
  event: RuntimeEvent,
): void {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (isChildOwnedPrimaryLiveEvent(event.type, payload)) return;
  if (event.type === "assistant.delta" && typeof payload?.text === "string") {
    live.assistantTextByRun[event.runId] =
      `${live.assistantTextByRun[event.runId] ?? ""}${payload.text}`;
  } else if (
    event.type === "thinking.delta" &&
    typeof payload?.text === "string"
  ) {
    live.thinkingTextByRun[event.runId] =
      `${live.thinkingTextByRun[event.runId] ?? ""}${payload.text}`;
  } else if (event.type === "tool.started") {
    const key = runtimeToolProjectionKey(event);
    live.activeTools.set(key, {
      key,
      runId: event.runId,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      started: event.payload,
    });
  } else if (event.type === "tool.progress") {
    const key = runtimeToolProjectionKey(event);
    const current =
      live.activeTools.get(key) ??
      latestActiveToolForRun(live.activeTools, event.runId);
    if (current)
      live.activeTools.set(current.key, {
        ...current,
        progress: event.payload,
      });
  } else if (event.type === "tool.sandbox") {
    const key = runtimeToolProjectionKey(event);
    const current =
      live.activeTools.get(key) ??
      latestActiveToolForRun(live.activeTools, event.runId);
    if (current)
      live.activeTools.set(current.key, {
        ...current,
        sandbox: event.payload as RuntimeToolSandboxEventPayload,
      });
  } else if (event.type === "tool.finished") {
    const key = runtimeToolProjectionKey(event);
    if (!live.activeTools.delete(key)) {
      for (const [candidate, tool] of live.activeTools) {
        if (tool.runId === event.runId) live.activeTools.delete(candidate);
      }
    }
  } else if (event.type === "todo.updated") {
    live.todo = event.payload;
  } else if (
    event.type === "run.progress" &&
    payload?.kind === "managed_task_status"
  ) {
    const status = parseRuntimeManagedTaskStatus(payload.status);
    if (status !== undefined) {
      live.managedTasks.set(event.runId, {
        runId: event.runId,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        status,
      });
    }
  } else if (
    event.type === "user_input.requested" &&
    (typeof payload?.id === "string" || typeof payload?.requestId === "string")
  ) {
    const requestId =
      typeof payload?.id === "string"
        ? payload.id
        : (payload!.requestId as string);
    live.pendingUserInputs.set(requestId, {
      requestId,
      runId: event.runId,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      detail: event.payload,
    });
  } else if (
    event.type === "user_input.resolved" &&
    typeof payload?.requestId === "string"
  ) {
    live.pendingUserInputs.delete(payload.requestId);
  } else if (isTerminalRuntimeEvent(event.type)) {
    delete live.assistantTextByRun[event.runId];
    delete live.thinkingTextByRun[event.runId];
    for (const [key, tool] of live.activeTools) {
      if (tool.runId === event.runId) live.activeTools.delete(key);
    }
    for (const [key, input] of live.pendingUserInputs) {
      if (input.runId === event.runId) live.pendingUserInputs.delete(key);
    }
    live.managedTasks.delete(event.runId);
  }
}

const PRIMARY_LIVE_ACTIVITY_EVENT_TYPES = new Set<RuntimeEventType>([
  "assistant.delta",
  "thinking.delta",
  "thinking.finished",
  "tool.started",
  "tool.progress",
  "tool.sandbox",
  "tool.finished",
  "todo.updated",
]);

function isChildOwnedPrimaryLiveEvent(
  type: RuntimeEventType,
  payload: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (!PRIMARY_LIVE_ACTIVITY_EVENT_TYPES.has(type)) return false;
  const meta = isRecord(payload?.meta) ? payload.meta : undefined;
  if (!meta) return false;
  if (meta.contextKind === "child") return true;
  if (typeof meta.childAgentId === "string" && meta.childAgentId.length > 0)
    return true;
  const correlation = isRecord(meta.workflowCorrelation)
    ? meta.workflowCorrelation
    : undefined;
  return (
    (typeof correlation?.workflowRunId === "string" &&
      correlation.workflowRunId.length > 0) ||
    (typeof correlation?.childAgentId === "string" &&
      correlation.childAgentId.length > 0)
  );
}

function snapshotRuntimeSessionLiveProjection(
  live: RuntimeSessionLiveProjectionState,
): RuntimeSessionLiveProjection {
  return {
    assistantTextByRun: { ...live.assistantTextByRun },
    thinkingTextByRun: { ...live.thinkingTextByRun },
    activeTools: [...live.activeTools.values()],
    ...(live.todo !== undefined ? { todo: live.todo } : {}),
    pendingUserInputs: [...live.pendingUserInputs.values()],
    managedTasks: [...live.managedTasks.values()],
  };
}

function parseRuntimeManagedTaskStatus(
  value: unknown,
): KodaXManagedTaskStatusEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.agentMode !== "string" ||
    typeof value.harnessProfile !== "string"
  )
    return undefined;
  return value as unknown as KodaXManagedTaskStatusEvent;
}

function latestRuntimeEventSeq(events: readonly RuntimeEvent[]): number {
  return events.at(-1)?.seq ?? 0;
}

function runtimeToolProjectionKey(event: RuntimeEvent): string {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const meta = isRecord(payload?.meta) ? payload.meta : undefined;
  const tool = isRecord(payload?.tool) ? payload.tool : undefined;
  const update = isRecord(payload?.update) ? payload.update : undefined;
  const result = isRecord(payload?.result) ? payload.result : undefined;
  const candidate =
    meta?.toolId ??
    meta?.toolCallId ??
    meta?.toolUseId ??
    tool?.id ??
    update?.id ??
    result?.id ??
    result?.toolCallId;
  return typeof candidate === "string" && candidate.length > 0
    ? `${event.runId}:${candidate}`
    : `${event.runId}:${event.turnId ?? "turn"}:${event.id}`;
}

function latestActiveToolForRun(
  activeTools: ReadonlyMap<string, RuntimeActiveToolProjection>,
  runId: string,
): RuntimeActiveToolProjection | undefined {
  return [...activeTools.values()]
    .reverse()
    .find((tool) => tool.runId === runId);
}

function isTerminalRuntimeEvent(type: RuntimeEventType): boolean {
  return (
    type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "run.interrupted"
  );
}

function createRuntimePersistence(
  options: CreateKodaXRuntimeOptions,
  runOwner: AgentActorOwner,
): RuntimePersistence {
  const baseDir = options.homeDir
    ? path.resolve(options.homeDir)
    : options.sessionsDir
      ? path.resolve(options.sessionsDir, "..")
      : process.cwd();
  const runtimeDir =
    options.sharedDaemonHost === true
      ? path.join(
          baseDir,
          ".kodax",
          "runtime",
          "profiles",
          encodeURIComponent(options.profile ?? "default"),
        )
      : path.join(baseDir, ".kodax", "runtime");
  const runsDir = path.join(runtimeDir, "runs");
  const sessionSettingsDir = path.join(runtimeDir, "session-settings");
  const sessionOrdersDir = path.join(runtimeDir, "session-orders");
  const permissionGrantsFile = path.join(runtimeDir, "permission-grants.json");
  const eventSequenceFile = path.join(runtimeDir, "event-sequence");
  const runStatusIndexFile = path.join(runtimeDir, "run-status-index.json");
  let nextSequence: number | undefined;
  let validatedSequenceFloor: number | undefined;

  const runDir = (runId: string): string =>
    path.join(runsDir, encodeURIComponent(runId));
  const eventFile = (runId: string): string =>
    path.join(runDir(runId), "events.jsonl");
  const eventWatermarkFile = (runId: string): string =>
    path.join(runDir(runId), "events.watermark");
  const statusFile = (runId: string): string =>
    path.join(runDir(runId), "status.json");
  const sessionSettingsFile = (sessionId: string): string =>
    path.join(sessionSettingsDir, `${encodeURIComponent(sessionId)}.json`);
  const sessionOrderFile = (sessionId: string): string =>
    path.join(sessionOrdersDir, `${encodeURIComponent(sessionId)}.json`);
  const persistenceWarnings: RuntimeEvent[] = [];
  const persistenceWarningKeys = new Set<string>();

  const readEventSequenceCursor = (): number | undefined => {
    if (fs.existsSync(eventSequenceFile)) {
      try {
        const persisted = Number.parseInt(
          fs.readFileSync(eventSequenceFile, "utf-8").trim(),
          10,
        );
        if (Number.isSafeInteger(persisted) && persisted >= 0) {
          return persisted;
        }
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: "runtime.persistence",
          level: "warn",
          message:
            "Failed to read runtime event sequence cursor; recovering from event logs",
          detail: error,
        });
      }
    }
    return undefined;
  };

  const findMaxPersistedEventSeq = (): number => {
    let maxSeq = 0;
    if (!fs.existsSync(runsDir)) return maxSeq;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(runsDir, entry.name, "events.jsonl");
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      let readBytes = Math.min(size, MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES);
      while (readBytes > 0) {
        const buffer = Buffer.allocUnsafe(readBytes);
        const descriptor = fs.openSync(file, "r");
        try {
          fs.readSync(descriptor, buffer, 0, readBytes, size - readBytes);
        } finally {
          fs.closeSync(descriptor);
        }
        const lines = buffer.toString("utf-8").split(/\r?\n/);
        if (readBytes < size) lines.shift();
        let foundCompleteEvent = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (isRuntimeEvent(parsed) && Number.isSafeInteger(parsed.seq)) {
              maxSeq = Math.max(maxSeq, parsed.seq);
              foundCompleteEvent = true;
            }
          } catch {
            // Keep expanding the tail until a complete event is found.
          }
        }
        if (foundCompleteEvent || readBytes === size) break;
        readBytes = Math.min(size, readBytes * 2);
      }
    }
    return maxSeq;
  };

  const reserveEventSeqsLocked = (count: number): number => {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("Runtime event sequence batch size must be positive");
    }
    const cursor = readEventSequenceCursor();
    const recoveredMax =
      validatedSequenceFloor === undefined || cursor === undefined
        ? findMaxPersistedEventSeq()
        : validatedSequenceFloor;
    validatedSequenceFloor = Math.max(
      cursor ?? 0,
      recoveredMax,
      validatedSequenceFloor ?? 0,
    );
    const first = validatedSequenceFloor + 1;
    const last = validatedSequenceFloor + count;
    writeRuntimeJsonAtomic(eventSequenceFile, last);
    validatedSequenceFloor = last;
    nextSequence = last + 1;
    return first;
  };

  const reserveEventSeqs = (count: number): number => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    return withRuntimeStatusFileLock(
      eventSequenceFile,
      () => reserveEventSeqsLocked(count),
    );
  };

  const findMaxPersistedSessionOrder = (sessionId: string): number => {
    if (!fs.existsSync(runsDir)) return 0;
    let maxOrder = 0;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const persisted = readPersistedRuntimeRunStatus(
          path.join(runsDir, entry.name, "status.json"),
        );
        if (persisted?.status.sessionId !== sessionId) continue;
        maxOrder = Math.max(
          maxOrder,
          persisted.status.sessionOrder ?? 0,
        );
      } catch {
        // Malformed status records are reported by the normal status reader.
      }
    }
    return maxOrder;
  };

  const pushPersistenceWarning = (
    key: string,
    message: string,
    scope: {
      readonly runId?: string;
      readonly sessionId?: string;
      readonly file?: string;
    },
  ): void => {
    if (persistenceWarningKeys.has(key)) return;
    persistenceWarningKeys.add(key);
    const seq = reserveEventSeqs(1);
    const event: RuntimeEvent = {
      id: `evt_persist_warn_${seq}_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      seq,
      time: new Date().toISOString(),
      sessionId: scope.sessionId ?? "runtime",
      runId: scope.runId ?? scope.sessionId ?? "runtime",
      type: "runtime.warning",
      payload: {
        source: "runtime.persistence",
        message,
        ...(scope.file !== undefined ? { file: scope.file } : {}),
      },
    };
    persistenceWarnings.push(event);
    if (persistenceWarnings.length > MAX_RUNTIME_MEMORY_EVENTS) {
      persistenceWarnings.splice(
        0,
        persistenceWarnings.length - MAX_RUNTIME_MEMORY_EVENTS,
      );
    }
  };

  const withPersistenceWarnings = (
    events: readonly RuntimeEvent[],
    filter: RuntimeEventReplayFilter | undefined,
  ): readonly RuntimeEvent[] =>
    [...events, ...persistenceWarnings]
      .filter((event) => eventMatchesReplayFilter(event, filter))
      .sort((a, b) => a.seq - b.seq || a.time.localeCompare(b.time));

  const readEventsFromFile = (file: string, runId?: string): RuntimeEvent[] => {
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, "utf-8");
    const events: RuntimeEvent[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
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

  const trimEventFile = (file: string, runId: string): void => {
    if (fs.statSync(file).size <= MAX_RUNTIME_EVENT_FILE_BYTES) return;
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split(/\r?\n/);
    const kept: string[] = [];
    let keptBytes = 0;
    let firstKeptIndex = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? "";
      if (!line) continue;
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (
        kept.length > 0 &&
        keptBytes + lineBytes > TARGET_RUNTIME_EVENT_FILE_BYTES
      )
        break;
      kept.push(line);
      keptBytes += lineBytes;
      firstKeptIndex = i;
    }
    kept.reverse();
    const priorWatermark = readRuntimeEventWatermark(
      eventWatermarkFile(runId),
    );
    let droppedThrough = priorWatermark.droppedThrough;
    let watermarkSessionId = priorWatermark.sessionId;
    for (const line of lines.slice(0, firstKeptIndex)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRuntimeEvent(parsed)) {
          droppedThrough = Math.max(droppedThrough, parsed.seq);
          watermarkSessionId ??= parsed.sessionId;
        }
      } catch {
        // Replay reports malformed retained records. A malformed dropped
        // record cannot provide a trustworthy sequence watermark.
      }
    }
    if (watermarkSessionId === undefined) {
      for (const line of kept) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRuntimeEvent(parsed)) {
            watermarkSessionId = parsed.sessionId;
            break;
          }
        } catch {
          // Retained malformed records are reported by replay.
        }
      }
    }
    writeRuntimeJsonAtomic(eventWatermarkFile(runId), {
      droppedThrough,
      ...(watermarkSessionId !== undefined
        ? { sessionId: watermarkSessionId }
        : {}),
    });
    writeRuntimeTextAtomic(
      file,
      kept.length > 0 ? `${kept.join("\n")}\n` : "",
    );
  };

  const repairIncompleteEventTail = (file: string): number => {
    if (!fs.existsSync(file)) return 0;
    const descriptor = fs.openSync(file, "r");
    let size = 0;
    let tail: Buffer;
    try {
      size = fs.fstatSync(descriptor).size;
      if (size === 0) return 0;
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return size;
      let readBytes = Math.min(
        size,
        MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES,
      );
      while (true) {
        tail = Buffer.allocUnsafe(readBytes);
        fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
        if (tail.lastIndexOf(0x0a) >= 0 || readBytes === size) break;
        readBytes = Math.min(size, readBytes * 2);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    const tailStart = size - tail.length + tail.lastIndexOf(0x0a) + 1;
    try {
      const parsed: unknown = JSON.parse(
        tail.subarray(tail.lastIndexOf(0x0a) + 1).toString("utf-8"),
      );
      if (isRuntimeEvent(parsed)) {
        fs.appendFileSync(file, "\n", "utf-8");
        return size + 1;
      }
    } catch {
      // A partial final record is rolled back to the last complete line.
    }
    fs.truncateSync(file, tailStart);
    return tailStart;
  };

  const appendEventBatch = (
    events: readonly RuntimeEvent[],
  ): unknown => {
    const first = events[0];
    if (first === undefined) return undefined;
    if (events.some((event) => event.runId !== first.runId)) {
      throw new Error("Runtime event persistence batches must contain one Run");
    }
    const dir = runDir(first.runId);
    const file = eventFile(first.runId);
    fs.mkdirSync(dir, { recursive: true });
    let trimError: unknown;
    try {
      withRuntimeStatusFileLock(file, () => {
        const originalSize = repairIncompleteEventTail(file);
        const record = events
          .map((event) => `${JSON.stringify(event)}\n`)
          .join("");
        try {
          fs.appendFileSync(file, record, "utf-8");
        } catch (appendError: unknown) {
          if (runtimeErrorCode(appendError) === "EISDIR") {
            throw appendError;
          }
          try {
            fs.truncateSync(file, originalSize);
          } catch (rollbackError: unknown) {
            throw new RuntimeEventCommitIndeterminateError(
              appendError,
              rollbackError,
            );
          }
          throw appendError;
        }
        try {
          trimEventFile(file, first.runId);
        } catch (error: unknown) {
          trimError = error;
        }
      });
    } catch (error: unknown) {
      if (!(error instanceof RuntimeStatusLockCleanupError)) throw error;
      trimError = trimError === undefined
        ? error.cleanupError
        : new AggregateError(
            [trimError, error.cleanupError],
            "Runtime event trim and status-lock cleanup both failed",
          );
    }
    return trimError;
  };

  const commitEventBatch = (
    count: number,
    create: (firstSeq: number) => readonly RuntimeEvent[],
  ): readonly RuntimeEvent[] => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    let trimError: unknown;
    let completed: readonly RuntimeEvent[] | undefined;
    let committed: readonly RuntimeEvent[];
    try {
      committed = withRuntimeStatusFileLock(eventSequenceFile, () => {
        const firstSeq = reserveEventSeqsLocked(count);
        const events = create(firstSeq);
        if (
          events.length !== count
          || events.some((event, index) => event.seq !== firstSeq + index)
        ) {
          throw new Error(
            "Runtime event batch must match its reserved sequence range",
          );
        }
        trimError = appendEventBatch(events);
        completed = events;
        return events;
      });
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeStatusLockCleanupError)
        || completed === undefined
      ) {
        throw error;
      }
      committed = completed;
      trimError = trimError === undefined
        ? error.cleanupError
        : new AggregateError(
            [trimError, error.cleanupError],
            "Runtime event file and sequence-lock cleanup both failed",
        );
    }
    const first = committed[0];
    if (trimError !== undefined && first !== undefined) {
      const file = eventFile(first.runId);
      try {
        pushPersistenceWarning(
          `${file}:trim`,
          `Failed to trim runtime event file: ${normalizeError(trimError).message}`,
          { runId: first.runId, sessionId: first.sessionId, file },
        );
      } catch (warningError: unknown) {
        emitKodaXDiagnostic({
          source: "runtime.persistence",
          level: "warn",
          message:
            "Runtime events committed, but their trim warning could not be recorded",
          detail: warningError,
        });
      }
    }
    return committed;
  };

  const assertReplayCursorRetained = (
    filter: RuntimeEventReplayFilter | undefined,
  ): void => {
    if (filter?.sinceSeq === undefined) return;
    const assertWatermark = (
      watermark: RuntimeEventWatermark,
    ): void => {
      if (filter.sinceSeq! < watermark.droppedThrough) {
        throw createRuntimeResyncError(
          `Runtime event history before sequence ${watermark.droppedThrough} is no longer retained`,
        );
      }
    };
    if (filter.runId !== undefined) {
      assertWatermark(readRuntimeEventWatermark(
        eventWatermarkFile(filter.runId),
      ));
      return;
    }
    if (!fs.existsSync(runsDir)) return;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const watermark = readRuntimeEventWatermark(
        path.join(runsDir, entry.name, "events.watermark"),
      );
      if (filter.sessionId !== undefined) {
        try {
          const persisted = readPersistedRuntimeRunStatus(
            path.join(runsDir, entry.name, "status.json"),
          );
          if (
            persisted !== undefined
            && persisted.status.sessionId !== filter.sessionId
          ) {
            continue;
          }
          if (
            persisted === undefined
            && watermark.sessionId !== undefined
            && watermark.sessionId !== filter.sessionId
          ) {
            continue;
          }
        } catch {
          if (
            watermark.sessionId !== undefined
            && watermark.sessionId !== filter.sessionId
          ) {
            continue;
          }
        }
      }
      assertWatermark(watermark);
    }
  };

  const readIndexedRunStatus = (
    runId: string,
  ): PersistedRuntimeRunStatus | undefined => {
    const file = statusFile(runId);
    if (!fs.existsSync(file)) return undefined;
    try {
      const persisted = parsePersistedRuntimeRunStatus(
        JSON.parse(fs.readFileSync(file, "utf-8")),
      );
      if (persisted) return persisted;
      pushPersistenceWarning(
        `${file}:shape`,
        `Skipped malformed runtime status record at ${path.basename(file)}`,
        { runId, file },
      );
    } catch (error: unknown) {
      pushPersistenceWarning(
        `${file}:parse`,
        `Skipped malformed runtime status record at ${path.basename(file)}: ${normalizeError(error).message}`,
        { runId, file },
      );
    }
    return undefined;
  };

  const readRuntimePathIdentity = (file: string): RuntimePathIdentity | null => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      };
    } catch (error: unknown) {
      if (runtimeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  };

  const sameRuntimePathIdentity = (
    left: RuntimePathIdentity | null,
    right: RuntimePathIdentity | null,
  ): boolean => left === null || right === null
    ? left === right
    : left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeNs === right.mtimeNs
      && left.ctimeNs === right.ctimeNs;

  interface RuntimeRunStatusScan {
    readonly statuses: readonly PersistedRuntimeRunStatus[];
    readonly pendingRunStatuses: readonly RuntimePendingRunStatus[];
    readonly pendingOverflow: boolean;
  }

  const scanAllRunStatuses = (): RuntimeRunStatusScan => {
    if (!fs.existsSync(runsDir)) {
      return { statuses: [], pendingRunStatuses: [], pendingOverflow: false };
    }
    const statuses: PersistedRuntimeRunStatus[] = [];
    const pendingRunStatuses: RuntimePendingRunStatus[] = [];
    let pendingOverflow = false;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let runId: string;
      try {
        runId = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      const persisted = readIndexedRunStatus(runId);
      if (persisted !== undefined) {
        statuses.push(persisted);
        continue;
      }
      if (pendingRunStatuses.length >= MAX_RUNTIME_PENDING_RUN_STATUSES) {
        pendingOverflow = true;
        continue;
      }
      pendingRunStatuses.push({
        runId,
        identity: readRuntimePathIdentity(statusFile(runId)),
      });
    }
    return { statuses, pendingRunStatuses, pendingOverflow };
  };

  const boundedRunIds = (
    runIds: readonly string[],
    limit: number,
  ): readonly string[] =>
    [...new Set(runIds)]
      .filter((runId) =>
        Buffer.byteLength(runId, "utf-8") <= MAX_RUNTIME_RUN_STATUS_INDEX_ID_BYTES)
      .slice(-limit);

  const createRunStatusIndex = (
    scan: RuntimeRunStatusScan,
    runsDirectory: RuntimePathIdentity | null,
    requiresRescan = scan.pendingOverflow,
  ): RuntimeRunStatusIndex => {
    const sorted = [...scan.statuses].sort((left, right) =>
      compareRunStatusRecency(left.status, right.status));
    return {
      version: 2,
      activeRunIds: boundedRunIds(sorted
        .filter((persisted) => !isTerminalRunPhase(persisted.status.phase))
        .map((persisted) => persisted.status.runId), MAX_RUNTIME_MEMORY_RUNS),
      recentRunIds: boundedRunIds(
        sorted.map((persisted) => persisted.status.runId),
        MAX_RUNTIME_RECENT_PERSISTED_RUNS,
      ),
      runsDirectory,
      pendingRunStatuses: scan.pendingRunStatuses,
      requiresRescan,
    };
  };

  const parseRunStatusIndex = (value: unknown): RuntimeRunStatusIndex | undefined => {
    if (
      !isRecord(value)
      || value.version !== 2
      || !Array.isArray(value.activeRunIds)
      || !Array.isArray(value.recentRunIds)
      || !Array.isArray(value.pendingRunStatuses)
      || typeof value.requiresRescan !== "boolean"
    ) return undefined;
    const parseIds = (
      candidate: readonly unknown[],
      limit: number,
    ): readonly string[] | undefined => {
      if (
        candidate.length > limit
        || !candidate.every((runId) =>
          typeof runId === "string"
          && Buffer.byteLength(runId, "utf-8") <= MAX_RUNTIME_RUN_STATUS_INDEX_ID_BYTES)
      ) return undefined;
      const runIds = candidate as readonly string[];
      return new Set(runIds).size === runIds.length ? runIds : undefined;
    };
    const activeRunIds = parseIds(value.activeRunIds, MAX_RUNTIME_MEMORY_RUNS);
    const recentRunIds = parseIds(
      value.recentRunIds,
      MAX_RUNTIME_RECENT_PERSISTED_RUNS,
    );
    const parseIdentity = (candidate: unknown): RuntimePathIdentity | null | undefined => {
      if (candidate === null) return null;
      if (!isRecord(candidate)) return undefined;
      const fields = [
        candidate.dev,
        candidate.ino,
        candidate.size,
        candidate.mtimeNs,
        candidate.ctimeNs,
      ];
      if (!fields.every((field) =>
        typeof field === "string" && /^\d{1,32}$/.test(field)
      )) return undefined;
      return {
        dev: candidate.dev as string,
        ino: candidate.ino as string,
        size: candidate.size as string,
        mtimeNs: candidate.mtimeNs as string,
        ctimeNs: candidate.ctimeNs as string,
      };
    };
    const runsDirectory = parseIdentity(value.runsDirectory);
    if (runsDirectory === undefined) return undefined;
    if (value.pendingRunStatuses.length > MAX_RUNTIME_PENDING_RUN_STATUSES) {
      return undefined;
    }
    const pendingRunStatuses: RuntimePendingRunStatus[] = [];
    for (const candidate of value.pendingRunStatuses) {
      if (
        !isRecord(candidate)
        || typeof candidate.runId !== "string"
        || Buffer.byteLength(candidate.runId, "utf-8")
          > MAX_RUNTIME_RUN_STATUS_INDEX_ID_BYTES
      ) return undefined;
      const identity = parseIdentity(candidate.identity);
      if (identity === undefined) return undefined;
      pendingRunStatuses.push({ runId: candidate.runId, identity });
    }
    if (
      new Set(pendingRunStatuses.map((pending) => pending.runId)).size
        !== pendingRunStatuses.length
    ) return undefined;
    return activeRunIds === undefined || recentRunIds === undefined
      ? undefined
      : {
          version: 2,
          activeRunIds,
          recentRunIds,
          runsDirectory,
          pendingRunStatuses,
          requiresRescan: value.requiresRescan,
        };
  };

  const readRunStatusIndex = (): RuntimeRunStatusIndex | undefined => {
    if (!fs.existsSync(runStatusIndexFile)) return undefined;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(runStatusIndexFile, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size > MAX_RUNTIME_RUN_STATUS_INDEX_BYTES) return undefined;
      const encoded = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const read = fs.readSync(descriptor, encoded, offset, size - offset, offset);
        if (read === 0) return undefined;
        offset += read;
      }
      return parseRunStatusIndex(JSON.parse(encoded.toString("utf-8")));
    } catch (error: unknown) {
      if (runtimeErrorCode(error) !== "ENOENT") {
        emitKodaXDiagnostic({
          source: "runtime.persistence",
          level: "warn",
          message: "Runtime run-status index is invalid; rebuilding it once",
          detail: error,
        });
      }
      return undefined;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };

  const pendingRunStatusesUnchanged = (
    pending: readonly RuntimePendingRunStatus[],
  ): boolean => pending.every((candidate) => sameRuntimePathIdentity(
    candidate.identity,
    readRuntimePathIdentity(statusFile(candidate.runId)),
  ));

  const runStatusIndexIsCurrent = (index: RuntimeRunStatusIndex): boolean =>
    !index.requiresRescan
    && sameRuntimePathIdentity(
      index.runsDirectory,
      readRuntimePathIdentity(runsDir),
    )
    && pendingRunStatusesUnchanged(index.pendingRunStatuses);

  const rebuildRunStatusIndexLocked = (): RuntimeRunStatusIndex => {
    let latest: RuntimeRunStatusIndex | undefined;
    let pendingOverflowObserved = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = readRuntimePathIdentity(runsDir);
      const scan = scanAllRunStatuses();
      pendingOverflowObserved ||= scan.pendingOverflow;
      const after = readRuntimePathIdentity(runsDir);
      const stable = sameRuntimePathIdentity(before, after)
        && pendingRunStatusesUnchanged(scan.pendingRunStatuses);
      latest = createRunStatusIndex(scan, after, !stable || scan.pendingOverflow);
      if (stable) break;
    }
    if (latest === undefined) {
      latest = createRunStatusIndex(
        { statuses: [], pendingRunStatuses: [], pendingOverflow: true },
        readRuntimePathIdentity(runsDir),
        true,
      );
    }
    if (pendingOverflowObserved) {
      emitKodaXDiagnostic({
        source: "runtime.persistence",
        level: "warn",
        message: "Runtime run-status recovery found more than 1000 missing or malformed status files; startup performed one fail-closed compatibility scan",
        detail: { runsDir, trackedPendingLimit: MAX_RUNTIME_PENDING_RUN_STATUSES },
      });
    }
    writeRuntimeJsonAtomic(runStatusIndexFile, latest);
    return latest;
  };

  const ensureRunStatusIndexLocked = (): RuntimeRunStatusIndex => {
    const existing = readRunStatusIndex();
    return existing !== undefined && runStatusIndexIsCurrent(existing)
      ? existing
      : rebuildRunStatusIndexLocked();
  };

  const pendingTerminalRunStatuses = new Map<string, RuntimeRunStatus>();
  let durableDirtyRunStatusIndexIdentity: RuntimePathIdentity | undefined;

  const rememberRunStatusIndexState = (
    index: RuntimeRunStatusIndex,
  ): void => {
    durableDirtyRunStatusIndexIdentity = index.requiresRescan
      ? readRuntimePathIdentity(runStatusIndexFile) ?? undefined
      : undefined;
  };

  const updateRunStatusIndex = (
    status: RuntimeRunStatus,
    terminalCommitted: boolean,
  ): void => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    withRuntimeStatusFileLock(runStatusIndexFile, () => {
      // A managed Run directory changes the runs/ identity before this call.
      // Merge it into the bounded index without rescanning 1..N status files,
      // but keep the durable index dirty. Another Runtime or a crash restart
      // therefore performs one authoritative reconciliation; normal close
      // clears the dirty bit after one stable scan.
      const current = readRunStatusIndex() ?? rebuildRunStatusIndexLocked();
      rememberRunStatusIndexState(current);
      const terminalStatuses = [...pendingTerminalRunStatuses.values()]
        .filter((pending) => pending.runId !== status.runId)
        .sort(compareRunStatusRecency);
      const terminalRunIds = new Set(
        terminalStatuses.map((pending) => pending.runId),
      );
      const recentRunIds = boundedRunIds([
        ...current.recentRunIds.filter((runId) => (
          runId !== status.runId && !terminalRunIds.has(runId)
        )),
        ...terminalStatuses.map((pending) => pending.runId),
        status.runId,
      ], MAX_RUNTIME_RECENT_PERSISTED_RUNS);
      const activeRunIds = terminalCommitted
        ? current.activeRunIds.filter((runId) => (
            runId !== status.runId && !terminalRunIds.has(runId)
          ))
        : boundedRunIds([
            ...current.activeRunIds.filter((runId) => (
              runId !== status.runId && !terminalRunIds.has(runId)
            )),
            status.runId,
          ], MAX_RUNTIME_MEMORY_RUNS);
      const pendingRunStatuses = current.pendingRunStatuses.filter(
        (pending) => (
          pending.runId !== status.runId && !terminalRunIds.has(pending.runId)
        ),
      );
      const runsDirectory = readRuntimePathIdentity(runsDir);
      const requiresRescan = current.requiresRescan
        || !sameRuntimePathIdentity(runsDirectory, current.runsDirectory);
      const unchanged =
        activeRunIds.length === current.activeRunIds.length
        && recentRunIds.length === current.recentRunIds.length
        && pendingRunStatuses.length === current.pendingRunStatuses.length
        && sameRuntimePathIdentity(runsDirectory, current.runsDirectory)
        && activeRunIds.every((runId, index) => runId === current.activeRunIds[index])
        && recentRunIds.every((runId, index) => runId === current.recentRunIds[index]);
      if (unchanged) {
        for (const terminalStatus of terminalStatuses) {
          pendingTerminalRunStatuses.delete(terminalStatus.runId);
        }
        return;
      }
      const next = {
        version: 2,
        activeRunIds,
        recentRunIds,
        runsDirectory,
        pendingRunStatuses,
        requiresRescan,
      } satisfies RuntimeRunStatusIndex;
      writeRuntimeJsonAtomic(runStatusIndexFile, next);
      rememberRunStatusIndexState(next);
      for (const terminalStatus of terminalStatuses) {
        pendingTerminalRunStatuses.delete(terminalStatus.runId);
      }
    });
  };

  const finalizeRunStatusIndex = (status: RuntimeRunStatus): void => {
    if (!isTerminalRunPhase(status.phase)) return;
    pendingTerminalRunStatuses.delete(status.runId);
    pendingTerminalRunStatuses.set(status.runId, status);
    fs.mkdirSync(runtimeDir, { recursive: true });
    try {
      withRuntimeStatusFileLock(runStatusIndexFile, () => {
        if (
          durableDirtyRunStatusIndexIdentity !== undefined
          && sameRuntimePathIdentity(
            durableDirtyRunStatusIndexIdentity,
            readRuntimePathIdentity(runStatusIndexFile),
          )
        ) return;
        const current = readRunStatusIndex() ?? rebuildRunStatusIndexLocked();
        if (!current.requiresRescan) {
          const next = {
            ...current,
            requiresRescan: true,
          } satisfies RuntimeRunStatusIndex;
          writeRuntimeJsonAtomic(runStatusIndexFile, next);
          rememberRunStatusIndexState(next);
        } else {
          rememberRunStatusIndexState(current);
        }
      });
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: "runtime.persistence",
        level: "warn",
        message: "Runtime terminal status committed, but its derived run-status index could not be marked dirty",
        detail: { runId: status.runId, error },
      });
    }
  };

  return {
    runtimeDir,
    commitEvents(count, create) {
      return commitEventBatch(count, create);
    },
    close() {
      fs.mkdirSync(runtimeDir, { recursive: true });
      withRuntimeStatusFileLock(runStatusIndexFile, () => {
        rememberRunStatusIndexState(rebuildRunStatusIndexLocked());
      });
      pendingTerminalRunStatuses.clear();
    },
    nextSessionOrder(sessionId) {
      fs.mkdirSync(sessionOrdersDir, { recursive: true });
      const file = sessionOrderFile(sessionId);
      return withRuntimeStatusFileLock(file, () => {
        let current: number | undefined;
        if (fs.existsSync(file)) {
          try {
            const parsed: unknown = JSON.parse(
              fs.readFileSync(file, "utf-8"),
            );
            if (
              typeof parsed === "number"
              && Number.isSafeInteger(parsed)
              && parsed >= 0
            ) {
              current = parsed;
            }
          } catch {
            current = undefined;
          }
        }
        const next =
          (current ?? findMaxPersistedSessionOrder(sessionId)) + 1;
        writeRuntimeJsonAtomic(file, next);
        return next;
      });
    },
    currentEventSeq() {
      validatedSequenceFloor ??= findMaxPersistedEventSeq();
      return Math.max(
        nextSequence === undefined ? 0 : nextSequence - 1,
        readEventSequenceCursor() ?? 0,
        validatedSequenceFloor,
      );
    },
    replay(filter) {
      assertReplayCursorRetained(filter);
      if (filter?.runId) {
        return withPersistenceWarnings(
          readEventsFromFile(eventFile(filter.runId), filter.runId),
          filter,
        );
      }
      if (!fs.existsSync(runsDir)) return withPersistenceWarnings([], filter);
      const result: RuntimeEvent[] = [];
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        result.push(
          ...readEventsFromFile(
            path.join(runsDir, entry.name, "events.jsonl"),
            entry.name,
          ),
        );
      }
      return withPersistenceWarnings(result, filter);
    },
    saveRunStatus(status) {
      const dir = runDir(status.runId);
      fs.mkdirSync(dir, { recursive: true });
      const file = statusFile(status.runId);
      return withRuntimeStatusFileLock(file, () => {
        const existing = readPersistedRuntimeRunStatus(file);
        if (existing && isTerminalRunPhase(existing.status.phase)) {
          return existing.status;
        }
        if (
          existing?.owner !== undefined
          && existing.owner.ownerId !== runOwner.ownerId
          && !isTerminalRunPhase(status.phase)
        ) {
          return existing.status;
        }
        writeRuntimeJsonAtomic(file, {
          ...status,
          _runtime: {
            revision: (existing?.revision ?? 0) + 1,
            owner: runOwner,
          },
        });
        // Commit the canonical status first. Publish a new active Run once;
        // nonterminal progress keeps the same index membership, and the first
        // terminal transition removes it with one index update.
        if (isTerminalRunPhase(status.phase)) {
          finalizeRunStatusIndex(status);
        } else if (existing === undefined) {
          updateRunStatusIndex(status, false);
        }
        return status;
      });
    },
    requestRunStop(runId, reason) {
      const file = statusFile(runId);
      return withRuntimeStatusFileLock(file, () => {
        const existing = readPersistedRuntimeRunStatus(file);
        if (existing === undefined) {
          throw new Error(`Runtime run not found: ${runId}`);
        }
        if (
          existing.owner !== undefined
          && existing.owner.ownerId !== runOwner.ownerId
          && !isTerminalRunPhase(existing.status.phase)
        ) {
          throw createRuntimeConflictError(
            `Runtime ${runOwner.runtimeId} does not own run ${runId}`,
            existing.revision,
          );
        }
        const current = existing.status;
        if (
          current.stop !== undefined
          || current.phase === "unknown"
          || isTerminalRunPhase(current.phase)
          || (current.phase !== "queued" && !isActiveRunPhase(current.phase))
        ) {
          return {
            accepted: false,
            status: current,
            revision: existing.revision,
          };
        }
        const requestedAt = new Date().toISOString();
        const {
          lifecycleError: _discardedLifecycleError,
          ...currentWithoutLifecycleError
        } = current;
        const next: RuntimeRunStatus = current.phase === "queued"
          ? {
              ...currentWithoutLifecycleError,
              phase: "cancelled",
              stage: "terminal",
              stageChangedAt: requestedAt,
              activeSubtaskCount: 0,
              endedAt: requestedAt,
              stop: {
                requestedAt,
                state: "confirmed",
                outcome: "cancelled",
                reason,
                resolvedAt: requestedAt,
              },
              terminal: {
                revision: 1,
                kind: "cancelled",
                code: "cancelled",
                effectOutcome: "none",
                message: reason,
              },
            }
          : {
              ...currentWithoutLifecycleError,
              phase: "unknown",
              stage: "unknown",
              stageChangedAt: requestedAt,
              error: "stop_outcome_unconfirmed",
              stop: {
                requestedAt,
                state: "unknown",
                outcome: "unknown",
                reason,
              },
            };
        const revision = existing.revision + 1;
        writeRuntimeJsonAtomic(file, {
          ...next,
          _runtime: {
            revision,
            owner: runOwner,
          },
        });
        finalizeRunStatusIndex(next);
        return {
          accepted: true,
          status: next,
          revision,
        };
      });
    },
    loadRunStatus(runId) {
      return readIndexedRunStatus(runId);
    },
    loadRunStatuses() {
      fs.mkdirSync(runtimeDir, { recursive: true });
      return withRuntimeStatusFileLock(runStatusIndexFile, () => {
        const index = ensureRunStatusIndexLocked();
        const runIds = [...new Set([
          ...index.activeRunIds,
          ...index.recentRunIds,
        ])];
        const statuses = runIds.flatMap((runId) => {
          const persisted = readIndexedRunStatus(runId);
          return persisted === undefined ? [] : [persisted];
        });
        const byRunId = new Map(statuses.map((persisted) => [
          persisted.status.runId,
          persisted,
        ]));
        const activeRunIds = index.activeRunIds.filter((runId) => {
          const persisted = byRunId.get(runId);
          return persisted !== undefined
            && !isTerminalRunPhase(persisted.status.phase);
        });
        const terminalizedActive = index.activeRunIds.flatMap((runId) => {
          const persisted = byRunId.get(runId);
          return persisted !== undefined
            && isTerminalRunPhase(persisted.status.phase)
            ? [persisted]
            : [];
        }).sort((left, right) => compareRunStatusRecency(
          left.status,
          right.status,
        ));
        const terminalizedIds = new Set(
          terminalizedActive.map((persisted) => persisted.status.runId),
        );
        const recentRunIds = boundedRunIds([
          ...index.recentRunIds.filter((runId) => (
            byRunId.has(runId) && !terminalizedIds.has(runId)
          )),
          ...terminalizedActive.map((persisted) => persisted.status.runId),
        ], MAX_RUNTIME_RECENT_PERSISTED_RUNS);
        if (
          activeRunIds.length !== index.activeRunIds.length
          || recentRunIds.length !== index.recentRunIds.length
          || activeRunIds.some((runId, position) => (
            runId !== index.activeRunIds[position]
          ))
          || recentRunIds.some((runId, position) => (
            runId !== index.recentRunIds[position]
          ))
        ) {
          const next = {
            ...index,
            activeRunIds,
            recentRunIds,
          } satisfies RuntimeRunStatusIndex;
          writeRuntimeJsonAtomic(runStatusIndexFile, next);
          rememberRunStatusIndexState(next);
        } else {
          rememberRunStatusIndexState(index);
        }
        return statuses;
      });
    },
    loadSessionSettingsVersioned(sessionId) {
      const file = sessionSettingsFile(sessionId);
      if (!fs.existsSync(file)) return { revision: 0, value: {} };
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (
          isRecord(parsed) &&
          Number.isSafeInteger(parsed.revision) &&
          typeof parsed.revision === "number" &&
          parsed.revision >= 0 &&
          isRecord(parsed.value)
        ) {
          return {
            revision: parsed.revision,
            value: parseRuntimeSessionSettings(parsed.value),
          };
        }
        // v0.7.68 and earlier stored a plain settings object.
        return { revision: 0, value: parseRuntimeSessionSettings(parsed) };
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${file}:parse`,
          `Skipped malformed runtime session settings at ${path.basename(file)}: ${normalizeError(error).message}`,
          { sessionId, file },
        );
        return { revision: 0, value: {} };
      }
    },
    loadSessionSettings(sessionId) {
      return this.loadSessionSettingsVersioned(sessionId).value;
    },
    saveSessionSettingsVersioned(sessionId, settings) {
      fs.mkdirSync(sessionSettingsDir, { recursive: true });
      const file = sessionSettingsFile(sessionId);
      writeRuntimeJsonAtomic(file, {
        revision: settings.revision,
        value: serializeSessionSettings(settings.value),
      });
    },
    saveSessionSettings(sessionId, settings) {
      const current = this.loadSessionSettingsVersioned(sessionId);
      this.saveSessionSettingsVersioned(sessionId, {
        revision: current.revision + 1,
        value: settings,
      });
    },
    loadPermissionGrants() {
      if (!fs.existsSync(permissionGrantsFile))
        return { revision: 0, value: [] };
      try {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(permissionGrantsFile, "utf-8"),
        );
        if (
          !isRecord(parsed) ||
          !Number.isSafeInteger(parsed.revision) ||
          !Array.isArray(parsed.value)
        ) {
          throw new Error("invalid permission grant store shape");
        }
        return {
          revision: parsed.revision as number,
          value: parsed.value.map(parseRuntimePermissionGrant),
        };
      } catch (error: unknown) {
        throw new Error(
          `Permission grant store is untrusted: ${normalizeError(error).message}`,
        );
      }
    },
    savePermissionGrants(grants) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      writeRuntimeJsonAtomic(permissionGrantsFile, grants);
    },
  };
}

function writeRuntimeJsonAtomic(file: string, value: unknown): void {
  writeRuntimeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRuntimeTextAtomic(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let operationCompleted = false;
  let operationError: unknown;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    operationCompleted = true;
  } catch (error: unknown) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  try {
    fs.rmSync(temporary, { force: true });
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  if (!operationCompleted) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `Runtime atomic write and cleanup both failed: ${file}`,
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      `Runtime atomic-write cleanup failed: ${file}`,
    );
  }
}

function withRuntimeStatusFileLock<T>(
  statusFile: string,
  operation: () => T,
): T {
  const lockFile = `${statusFile}.lock`;
  const deadline = performance.now() + 2_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const token = randomUUID();
  retryAbandonedRuntimeLockCleanup(lockFile);
  reconcileRuntimeStatusLockCandidates(lockFile, deadline);
  const reclaimFile = `${lockFile}.reclaim`;
  let acquired = !fs.existsSync(reclaimFile)
    && !fs.existsSync(`${reclaimFile}.cleanup`)
    && !hasRuntimeStatusAcquisitionGateFiles(lockFile)
    && createRuntimeStatusLockFile(lockFile, token);
  while (!acquired) {
    try {
      acquired = withRuntimeStatusAcquisitionGate(lockFile, deadline, () => {
        if (!clearLegacyRuntimeReclaimGates(lockFile, deadline)) return false;
        if (fs.existsSync(lockFile)) {
          if (
            runtimeStatusLockOwnerState(lockFile, runtimeLockProbeBudget(deadline))
              !== "gone"
          ) return false;
          const stale = readRuntimeStatusLockRecord(lockFile);
          if (stale === undefined) return false;
          tryRemoveRuntimeStatusLockOwnedBy(lockFile, stale.token);
          if (fs.existsSync(lockFile)) return false;
        }
        return createRuntimeStatusLockFile(lockFile, token);
      });
    } catch (error: unknown) {
      if (readRuntimeStatusLockRecord(lockFile)?.token === token) {
        try {
          removeRuntimeStatusLockOwnedBy(lockFile, token);
        } catch (cleanupError: unknown) {
          rememberAbandonedRuntimeLockFile(
            lockFile,
            lockFile,
            token,
            "blocking",
          );
          throw new AggregateError(
            [error, cleanupError],
            "Runtime status lock acquisition and cleanup both failed",
          );
        }
      }
      throw error;
    }
    if (acquired) break;
    if (performance.now() >= deadline) {
      throw new RuntimeStatusLockTimeoutError(lockFile);
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
  let operationCompleted = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    operationResult = operation();
    operationCompleted = true;
  } catch (error: unknown) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    removeRuntimeStatusLockOwnedBy(lockFile, token);
  } catch (error: unknown) {
    rememberAbandonedRuntimeLockFile(
      lockFile,
      lockFile,
      token,
      "blocking",
    );
    cleanupError = error;
  }
  if (!operationCompleted) {
    if (cleanupError !== undefined) {
      if (operationError instanceof RuntimeEventCommitIndeterminateError) {
        operationError.includeLockCleanupFailure(cleanupError);
      } else {
        operationError = new AggregateError(
          [operationError, cleanupError],
          "Runtime status operation and lock cleanup both failed",
        );
      }
    }
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw new RuntimeStatusLockCleanupError(cleanupError);
  }
  return operationResult;
}

type RuntimeStatusLockOwnerState = "alive" | "gone" | "unknown";

interface RuntimeStatusLockRecord {
  readonly pid: number;
  readonly createdAt: number;
  readonly token: string;
  readonly processStartIdentity?: string;
  readonly ticket?: number;
}

const RUNTIME_PROCESS_START_IDENTITY = readRuntimeProcessStartIdentity(process.pid);
interface AbandonedRuntimeLockFile {
  readonly family: string;
  readonly token: string;
  readonly kind: "blocking" | "candidate" | "unpublished";
  readonly fileIdentity?: RuntimeStatusLockFileIdentity;
}

interface RuntimeStatusLockFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

const abandonedRuntimeLockFiles = new Map<string, AbandonedRuntimeLockFile>();
const runtimeStatusHardLinkDisabledFamilies = new Set<string>();
const runtimeStatusCandidateWarningFamilies = new Set<string>();

function rememberAbandonedRuntimeLockFile(
  file: string,
  family: string,
  token: string,
  kind: AbandonedRuntimeLockFile["kind"],
  fileIdentity?: RuntimeStatusLockFileIdentity,
): void {
  abandonedRuntimeLockFiles.set(file, {
    family,
    token,
    kind,
    ...(fileIdentity === undefined ? {} : { fileIdentity }),
  });
  if (kind === "candidate") runtimeStatusHardLinkDisabledFamilies.add(family);
}

function runtimeStatusLockRecord(
  token: string,
  ticket?: number,
): RuntimeStatusLockRecord {
  return {
    pid: process.pid,
    createdAt: Date.now(),
    token,
    ...(RUNTIME_PROCESS_START_IDENTITY === undefined
      ? {}
      : { processStartIdentity: RUNTIME_PROCESS_START_IDENTITY }),
    ...(ticket === undefined ? {} : { ticket }),
  };
}

function readRuntimeStatusLockRecord(
  file: string,
): RuntimeStatusLockRecord | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (
      !isRecord(value)
      || !Number.isSafeInteger(value.pid)
      || typeof value.pid !== "number"
      || value.pid <= 0
      || !Number.isFinite(value.createdAt)
      || typeof value.createdAt !== "number"
      || typeof value.token !== "string"
      || (
        value.processStartIdentity !== undefined
        && typeof value.processStartIdentity !== "string"
      )
      || (
        value.ticket !== undefined
        && (
          typeof value.ticket !== "number"
          || !Number.isSafeInteger(value.ticket)
          || value.ticket <= 0
        )
      )
    ) return undefined;
    return {
      pid: value.pid,
      createdAt: value.createdAt,
      token: value.token,
      ...(value.processStartIdentity === undefined
        ? {}
        : { processStartIdentity: value.processStartIdentity }),
      ...(value.ticket === undefined ? {} : { ticket: value.ticket }),
    };
  } catch {
    return undefined;
  }
}

function runtimeStatusLockOwnerState(
  lockFile: string,
  processProbeTimeoutMs = 1_000,
): RuntimeStatusLockOwnerState {
  const parsed = readRuntimeStatusLockRecord(lockFile);
  if (parsed === undefined) return "unknown";
  try {
    try {
      process.kill(parsed.pid, 0);
    } catch (error: unknown) {
      return runtimeErrorCode(error) === "ESRCH" ? "gone" : "unknown";
    }
    if (typeof parsed.processStartIdentity !== "string") return "alive";
    const currentIdentity = parsed.pid === process.pid
      ? RUNTIME_PROCESS_START_IDENTITY
      : readRuntimeProcessStartIdentity(parsed.pid, processProbeTimeoutMs);
    if (currentIdentity === undefined) return "unknown";
    return currentIdentity === parsed.processStartIdentity ? "alive" : "gone";
  } catch {
    return "unknown";
  }
}

function createRuntimeStatusLockFile(
  lockFile: string,
  token: string,
  ticket?: number,
): boolean {
  if (runtimeStatusHardLinkDisabledFamilies.has(lockFile)) {
    return createRuntimeStatusLockFileByExclusiveWrite(lockFile, token, ticket);
  }
  const candidate = `${lockFile}.candidate.${process.pid}.${randomUUID()}`;
  let descriptor: number | undefined;
  let operationCompleted = false;
  let operationError: unknown;
  let acquired = false;
  let fallbackToExclusiveWrite = false;
  try {
    descriptor = fs.openSync(candidate, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      JSON.stringify(runtimeStatusLockRecord(token, ticket)),
      "utf-8",
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(candidate, lockFile);
      acquired = true;
      operationCompleted = true;
    } catch (error: unknown) {
      const code = runtimeErrorCode(error);
      if (code === "EEXIST") {
        operationCompleted = true;
      } else if (runtimeStatusHardLinkUnavailable(code)) {
        operationCompleted = true;
        fallbackToExclusiveWrite = true;
      } else {
        throw error;
      }
    }
  } catch (error: unknown) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  try {
    fs.rmSync(candidate, { force: true });
  } catch (error: unknown) {
    rememberAbandonedRuntimeLockFile(
      candidate,
      lockFile,
      token,
      "candidate",
    );
    cleanupErrors.push(error);
  }
  if (!operationCompleted) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `Runtime status lock publication and cleanup both failed: ${lockFile}`,
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    if (!runtimeStatusCandidateWarningFamilies.has(lockFile)) {
      runtimeStatusCandidateWarningFamilies.add(lockFile);
      emitKodaXDiagnostic({
        source: "runtime.status.lock",
        level: "warn",
        message: "Runtime status lock candidate cleanup was deferred; using exclusive creation for this lock family.",
        detail: { lockFile, cleanupErrors },
      });
    }
  }
  if (fallbackToExclusiveWrite) {
    return createRuntimeStatusLockFileByExclusiveWrite(lockFile, token, ticket);
  }
  return acquired;
}

function runtimeStatusHardLinkUnavailable(code: string | undefined): boolean {
  return code === "EACCES"
    || code === "EPERM"
    || code === "ENOTSUP"
    || code === "EOPNOTSUPP"
    || code === "ENOSYS"
    || code === "EXDEV";
}

function createRuntimeStatusLockFileByExclusiveWrite(
  lockFile: string,
  token: string,
  ticket?: number,
): boolean {
  let descriptor: number | undefined;
  let created = false;
  let createdIdentity: RuntimeStatusLockFileIdentity | undefined;
  let operationError: unknown;
  try {
    descriptor = fs.openSync(lockFile, "wx", 0o600);
    created = true;
    createdIdentity = runtimeStatusLockDescriptorIdentity(descriptor);
    fs.writeFileSync(
      descriptor,
      JSON.stringify(runtimeStatusLockRecord(token, ticket)),
      "utf-8",
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return true;
  } catch (error: unknown) {
    if (!created && runtimeErrorCode(error) === "EEXIST") return false;
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (created) {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch (error: unknown) {
      rememberAbandonedRuntimeLockFile(
        lockFile,
        lockFile,
        token,
        "unpublished",
        createdIdentity,
      );
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `Runtime fallback status lock creation and cleanup both failed: ${lockFile}`,
    );
  }
  throw operationError;
}

function withRuntimeStatusAcquisitionGate<T>(
  lockFile: string,
  deadline: number,
  operation: () => T,
): T {
  const token = randomUUID();
  const choosingFile = `${lockFile}.choosing.${token}`;
  const claimFile = `${lockFile}.claim.${token}`;
  let operationCompleted = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    writeRuntimeTextAtomic(
      choosingFile,
      JSON.stringify(runtimeStatusLockRecord(token)),
    );
    const existingClaims = runtimeStatusGateFiles(lockFile, "claim")
      .map((file) => readRuntimeStatusLockRecord(file)?.ticket)
      .filter((ticket): ticket is number => ticket !== undefined);
    const ticket = Math.max(0, ...existingClaims) + 1;
    if (!Number.isSafeInteger(ticket)) {
      throw new Error(`Runtime status lock ticket overflow: ${lockFile}`);
    }
    writeRuntimeTextAtomic(
      claimFile,
      JSON.stringify(runtimeStatusLockRecord(token, ticket)),
    );
    removeRuntimeStatusLockOwnedBy(choosingFile, token);
    waitForRuntimeStatusGateTurn(lockFile, claimFile, ticket, token, deadline);
    operationResult = operation();
    operationCompleted = true;
  } catch (error: unknown) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const ownedFile of [
    claimFile,
    choosingFile,
  ]) {
    if (!fs.existsSync(ownedFile)) continue;
    try {
      removeRuntimeStatusLockOwnedBy(ownedFile, token);
    } catch (error: unknown) {
      rememberAbandonedRuntimeLockFile(
        ownedFile,
        lockFile,
        token,
        "blocking",
      );
      cleanupErrors.push(error);
    }
  }
  if (!operationCompleted) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Runtime status acquisition and gate cleanup both failed",
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "Runtime status acquisition gate cleanup failed",
    );
  }
  return operationResult;
}

function waitForRuntimeStatusGateTurn(
  lockFile: string,
  claimFile: string,
  ticket: number,
  token: string,
  deadline: number,
): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let blocked = false;
    for (const choosing of runtimeStatusGateFiles(lockFile, "choosing")) {
      if (choosing === `${lockFile}.choosing.${token}`) continue;
      if (!removeGoneRuntimeStatusGateFile(choosing, deadline)) blocked = true;
    }
    for (const claim of runtimeStatusGateFiles(lockFile, "claim")) {
      if (claim === claimFile) continue;
      const record = readRuntimeStatusLockRecord(claim);
      if (record?.ticket === undefined) {
        blocked = true;
        continue;
      }
      if (
        record.ticket > ticket
        || (record.ticket === ticket && record.token.localeCompare(token) > 0)
      ) continue;
      if (!removeGoneRuntimeStatusGateFile(claim, deadline)) blocked = true;
    }
    if (!blocked) return;
    if (performance.now() >= deadline) {
      throw new RuntimeStatusLockTimeoutError(lockFile);
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

function runtimeStatusGateFiles(
  lockFile: string,
  kind: "choosing" | "claim",
): string[] {
  const directory = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.${kind}.`;
  try {
    return fs.readdirSync(directory)
      .filter((name) => (
        name.startsWith(prefix)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(name.slice(prefix.length))
      ))
      .map((name) => path.join(directory, name));
  } catch (error: unknown) {
    if (runtimeErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function hasRuntimeStatusAcquisitionGateFiles(lockFile: string): boolean {
  const directory = path.dirname(lockFile);
  const basename = path.basename(lockFile);
  const prefixes = [`${basename}.choosing.`, `${basename}.claim.`];
  try {
    return fs.readdirSync(directory).some((name) => prefixes.some((prefix) => (
      name.startsWith(prefix)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(name.slice(prefix.length))
    )));
  } catch (error: unknown) {
    if (runtimeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function removeGoneRuntimeStatusGateFile(
  file: string,
  deadline: number,
): boolean {
  if (!fs.existsSync(file)) return true;
  if (
    runtimeStatusLockOwnerState(file, runtimeLockProbeBudget(deadline)) !== "gone"
  ) return false;
  const record = readRuntimeStatusLockRecord(file);
  if (record === undefined) return false;
  tryRemoveRuntimeStatusLockOwnedBy(file, record.token);
  return !fs.existsSync(file);
}

function clearLegacyRuntimeReclaimGates(
  lockFile: string,
  deadline: number,
): boolean {
  const reclaimFile = `${lockFile}.reclaim`;
  for (const file of [`${reclaimFile}.cleanup`, reclaimFile]) {
    if (!fs.existsSync(file)) continue;
    if (!removeGoneRuntimeStatusGateFile(file, deadline)) return false;
  }
  return true;
}

function retryAbandonedRuntimeLockCleanup(lockFile: string): void {
  for (const [file, abandoned] of [...abandonedRuntimeLockFiles]) {
    if (abandoned.family !== lockFile) continue;
    if (!fs.existsSync(file)) {
      abandonedRuntimeLockFiles.delete(file);
      continue;
    }
    if (abandoned.kind === "unpublished") {
      if (abandoned.fileIdentity === undefined) {
        throw new RuntimeStatusLockCleanupError(
          new Error(`Runtime unpublished lock identity is unavailable: ${file}`),
        );
      }
      const currentIdentity = runtimeStatusLockPathIdentity(file);
      if (!runtimeStatusLockFileIdentityEquals(
        currentIdentity,
        abandoned.fileIdentity,
      )) {
        abandonedRuntimeLockFiles.delete(file);
        continue;
      }
      try {
        fs.rmSync(file, { force: true });
        abandonedRuntimeLockFiles.delete(file);
      } catch (error: unknown) {
        throw new RuntimeStatusLockCleanupError(error);
      }
      continue;
    }
    const record = readRuntimeStatusLockRecord(file);
    if (record?.token !== abandoned.token) {
      abandonedRuntimeLockFiles.delete(file);
      continue;
    }
    try {
      removeRuntimeStatusLockOwnedBy(file, abandoned.token);
      abandonedRuntimeLockFiles.delete(file);
    } catch (error: unknown) {
      if (abandoned.kind === "blocking") throw error;
    }
  }
  const hasCandidate = [...abandonedRuntimeLockFiles.values()].some(
    (abandoned) => (
      abandoned.family === lockFile && abandoned.kind === "candidate"
    ),
  );
  if (!hasCandidate) {
    runtimeStatusHardLinkDisabledFamilies.delete(lockFile);
    runtimeStatusCandidateWarningFamilies.delete(lockFile);
  }
}

function reconcileRuntimeStatusLockCandidates(
  lockFile: string,
  deadline: number,
): void {
  const candidates = runtimeStatusLockCandidateFiles(lockFile);
  for (const candidate of candidates) {
    const record = readRuntimeStatusLockRecord(candidate);
    if (
      record === undefined
      || runtimeStatusLockOwnerState(
        candidate,
        runtimeLockProbeBudget(deadline),
      ) !== "gone"
    ) continue;
    try {
      tryRemoveRuntimeStatusLockOwnedBy(candidate, record.token);
    } catch (error: unknown) {
      rememberAbandonedRuntimeLockFile(
        candidate,
        lockFile,
        record.token,
        "candidate",
      );
      if (!runtimeStatusCandidateWarningFamilies.has(lockFile)) {
        runtimeStatusCandidateWarningFamilies.add(lockFile);
        emitKodaXDiagnostic({
          source: "runtime.status.lock",
          level: "warn",
          message: "A prior Runtime lock candidate could not be removed; using exclusive creation for this lock family.",
          detail: { lockFile, candidate, error },
        });
      }
    }
  }
  const candidateRemains = runtimeStatusLockCandidateFiles(lockFile).length > 0;
  if (candidateRemains) {
    runtimeStatusHardLinkDisabledFamilies.add(lockFile);
  } else if (![...abandonedRuntimeLockFiles.values()].some(
    (abandoned) => (
      abandoned.family === lockFile && abandoned.kind === "candidate"
    ),
  )) {
    runtimeStatusHardLinkDisabledFamilies.delete(lockFile);
    runtimeStatusCandidateWarningFamilies.delete(lockFile);
  }
}

function runtimeStatusLockCandidateFiles(lockFile: string): string[] {
  const directory = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.candidate.`;
  try {
    return fs.readdirSync(directory)
      .filter((name) => (
        name.startsWith(prefix)
        && /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(name.slice(prefix.length))
      ))
      .map((name) => path.join(directory, name));
  } catch (error: unknown) {
    if (runtimeErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function runtimeStatusLockDescriptorIdentity(
  descriptor: number,
): RuntimeStatusLockFileIdentity {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  return { device: stat.dev, inode: stat.ino };
}

function runtimeStatusLockPathIdentity(
  file: string,
): RuntimeStatusLockFileIdentity | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return { device: stat.dev, inode: stat.ino };
  } catch (error: unknown) {
    if (runtimeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function runtimeStatusLockFileIdentityEquals(
  left: RuntimeStatusLockFileIdentity | undefined,
  right: RuntimeStatusLockFileIdentity,
): boolean {
  return left !== undefined
    && left.device === right.device
    && left.inode === right.inode;
}

function runtimeLockProbeBudget(deadline: number): number {
  return Math.max(0, Math.min(1_000, Math.floor(deadline - performance.now())));
}

function tryRemoveRuntimeStatusLockOwnedBy(
  lockFile: string,
  token: string,
): boolean {
  if (!fs.existsSync(lockFile)) return false;
  const parsed = readRuntimeStatusLockRecord(lockFile);
  if (parsed?.token !== token) return false;
  fs.rmSync(lockFile, { force: true });
  return true;
}

function removeRuntimeStatusLockOwnedBy(lockFile: string, token: string): void {
  if (!fs.existsSync(lockFile)) {
    throw new Error(`Runtime status lock ownership disappeared: ${lockFile}`);
  }
  const parsed = readRuntimeStatusLockRecord(lockFile);
  if (parsed?.token !== token) {
    throw new Error(`Runtime status lock ownership changed: ${lockFile}`);
  }
  fs.rmSync(lockFile, { force: true });
}

function readRuntimeProcessStartIdentity(
  pid: number,
  timeoutMs = 1_000,
): string | undefined {
  if (timeoutMs <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] === undefined ? undefined : `linux:${fields[19]}`;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
    ], { encoding: "utf-8", timeout: timeoutMs, windowsHide: true });
    const value = result.status === 0 ? result.stdout.trim() : "";
    return /^\d+$/.test(value) ? `windows:${value}` : undefined;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value === "" ? undefined : `${process.platform}:${value}`;
}

function runtimeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function readPersistedRuntimeRunStatus(
  file: string,
): PersistedRuntimeRunStatus | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  const status = parsePersistedRuntimeRunStatus(parsed);
  if (!status) {
    throw new Error(`Runtime status record is malformed: ${file}`);
  }
  return status;
}

interface RuntimeEventWatermark {
  readonly droppedThrough: number;
  readonly sessionId?: string;
}

function readRuntimeEventWatermark(file: string): RuntimeEventWatermark {
  if (!fs.existsSync(file)) return { droppedThrough: 0 };
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed)
      && Number.isSafeInteger(parsed.droppedThrough)
      && typeof parsed.droppedThrough === "number"
      && parsed.droppedThrough >= 0
      && (
        parsed.sessionId === undefined
        || typeof parsed.sessionId === "string"
      )
    ) {
      return {
        droppedThrough: parsed.droppedThrough,
        ...(parsed.sessionId !== undefined
          ? { sessionId: parsed.sessionId }
          : {}),
      };
    }
    if (
      typeof parsed === "number"
      && Number.isSafeInteger(parsed)
      && parsed >= 0
    ) {
      return { droppedThrough: parsed };
    }
    return { droppedThrough: 0 };
  } catch {
    return { droppedThrough: 0 };
  }
}

function resolveRuntimeSessionsDir(
  options: Pick<CreateKodaXRuntimeOptions, "homeDir" | "sessionsDir">,
): string | undefined {
  if (options.sessionsDir !== undefined) {
    return path.resolve(options.sessionsDir);
  }
  if (options.homeDir !== undefined) {
    return path.join(path.resolve(options.homeDir), ".kodax", "sessions");
  }
  return undefined;
}

function eventMatchesReplayFilter(
  event: RuntimeEvent,
  filter: RuntimeEventReplayFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId)
    return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq)
    return false;
  return true;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    typeof value.time === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    typeof value.type === "string" &&
    "payload" in value
  );
}

function parseRuntimeRunStatus(value: unknown): RuntimeRunStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.runId !== "string" ||
    typeof value.sessionId !== "string" ||
    !isRuntimeRunPhase(value.phase) ||
    typeof value.startedAt !== "string" ||
    typeof value.provider !== "string"
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    sessionId: value.sessionId,
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    phase: value.phase,
    ...(isRuntimeRunStage(value.stage) ? { stage: value.stage } : {}),
    ...(typeof value.stageChangedAt === "string"
      ? { stageChangedAt: value.stageChangedAt }
      : {}),
    ...(Number.isSafeInteger(value.activeSubtaskCount) &&
    typeof value.activeSubtaskCount === "number" &&
    value.activeSubtaskCount >= 0
      ? { activeSubtaskCount: value.activeSubtaskCount }
      : {}),
    startedAt: value.startedAt,
    ...(typeof value.acceptedAt === "string"
      ? { acceptedAt: value.acceptedAt }
      : {}),
    ...(Number.isSafeInteger(value.sessionOrder) &&
    typeof value.sessionOrder === "number"
      ? { sessionOrder: value.sessionOrder }
      : {}),
    ...(typeof value.queuedAt === "string" ? { queuedAt: value.queuedAt } : {}),
    ...(typeof value.runningAt === "string"
      ? { runningAt: value.runningAt }
      : {}),
    ...(typeof value.executionStartedAt === "string"
      ? { executionStartedAt: value.executionStartedAt }
      : {}),
    ...(typeof value.endedAt === "string" ? { endedAt: value.endedAt } : {}),
    provider: value.provider,
    ...(value.mode === "coding" || value.mode === "managed_task"
      ? { mode: value.mode }
      : {}),
    ...(isRecord(value.origin) && typeof value.origin.principalId === "string"
      ? {
          origin: {
            principalId: value.origin.principalId,
            ...(typeof value.origin.clientName === "string"
              ? { clientName: value.origin.clientName }
              : {}),
            ...(typeof value.origin.clientVersion === "string"
              ? { clientVersion: value.origin.clientVersion }
              : {}),
            ...(typeof value.origin.operationId === "string"
              ? { operationId: value.origin.operationId }
              : {}),
          },
        }
      : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.reasoning === "string"
      ? { reasoning: value.reasoning as KodaXReasoningMode }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(parseRuntimeRunLifecycleError(value.lifecycleError) !== undefined
      ? {
          lifecycleError: parseRuntimeRunLifecycleError(
            value.lifecycleError,
          )!,
        }
      : {}),
    ...(parseRuntimeTerminalFact(value.terminal) !== undefined
      ? { terminal: parseRuntimeTerminalFact(value.terminal)! }
      : {}),
    ...(parseRuntimeContinuationStatus(value.continuation) !== undefined
      ? { continuation: parseRuntimeContinuationStatus(value.continuation)! }
      : {}),
    ...(parseRuntimeInterruptInputStatuses(value.interruptInputs) !== undefined
      ? {
          interruptInputs: parseRuntimeInterruptInputStatuses(
            value.interruptInputs,
          )!,
        }
      : {}),
    ...(parseRuntimeRunStopStatus(value.stop) !== undefined
      ? { stop: parseRuntimeRunStopStatus(value.stop)! }
      : {}),
  };
}

function parsePersistedRuntimeRunStatus(
  value: unknown,
): PersistedRuntimeRunStatus | undefined {
  const status = parseRuntimeRunStatus(value);
  if (!status) return undefined;
  const metadata = isRecord(value) && isRecord(value._runtime)
    ? value._runtime
    : undefined;
  const owner = parseRuntimeRunOwner(metadata?.owner);
  const revision =
    metadata !== undefined
    && Number.isSafeInteger(metadata.revision)
    && typeof metadata.revision === "number"
    && metadata.revision >= 0
      ? metadata.revision
      : 0;
  return {
    status,
    revision,
    ...(owner !== undefined ? { owner } : {}),
  };
}

function parseRuntimeRunOwner(value: unknown): AgentActorOwner | undefined {
  if (
    !isRecord(value)
    || typeof value.ownerId !== "string"
    || typeof value.runtimeId !== "string"
    || !Number.isSafeInteger(value.pid)
    || typeof value.pid !== "number"
    || value.pid <= 0
    || typeof value.startedAt !== "string"
    || (value.livenessId !== undefined && typeof value.livenessId !== "string")
    || (
      value.livenessPort !== undefined
      && (
        !Number.isSafeInteger(value.livenessPort)
        || typeof value.livenessPort !== "number"
      )
    )
  ) {
    return undefined;
  }
  return {
    ownerId: value.ownerId,
    runtimeId: value.runtimeId,
    pid: value.pid,
    startedAt: value.startedAt,
    ...(typeof value.livenessId === "string"
      ? { livenessId: value.livenessId }
      : {}),
    ...(typeof value.livenessPort === "number"
      ? { livenessPort: value.livenessPort }
      : {}),
  };
}

function parseRuntimeContinuationStatus(
  value: unknown,
): RuntimeContinuationStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.inputId !== "string" ||
    typeof value.afterRunId !== "string" ||
    value.delivery !== "after_turn" ||
    (value.state !== "queued" &&
      value.state !== "delivered" &&
      value.state !== "terminal") ||
    typeof value.contentPreview !== "string"
  )
    return undefined;
  return {
    inputId: value.inputId,
    afterRunId: value.afterRunId,
    delivery: value.delivery,
    state: value.state,
    contentPreview: value.contentPreview,
  };
}

function parseRuntimeInterruptInputStatuses(
  value: unknown,
): readonly RuntimeInterruptInputStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parseRuntimeInterruptInputStatus);
  return parsed.every(
    (item): item is RuntimeInterruptInputStatus => item !== undefined,
  )
    ? parsed
    : undefined;
}

function parseRuntimeRunStopStatus(
  value: unknown,
): RuntimeRunStopStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.requestedAt !== "string" ||
    (value.state !== "unknown" && value.state !== "confirmed") ||
    (value.outcome !== "unknown" &&
      value.outcome !== "cancelled" &&
      value.outcome !== "interrupted" &&
      value.outcome !== "completed" &&
      value.outcome !== "failed") ||
    typeof value.reason !== "string"
  ) {
    return undefined;
  }
  return {
    requestedAt: value.requestedAt,
    state: value.state,
    outcome: value.outcome,
    reason: value.reason,
    ...(typeof value.resolvedAt === "string"
      ? { resolvedAt: value.resolvedAt }
      : {}),
  };
}

function parseRuntimeRunLifecycleError(
  value: unknown,
): RuntimeRunLifecycleError | undefined {
  if (
    !isRecord(value)
    || (
      value.code !== "actor_settlement_retrying"
      && value.code !== "actor_settlement_not_persisted"
    )
    || typeof value.message !== "string"
    || typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  };
}

function parseRuntimeInterruptInputStatus(
  value: unknown,
): RuntimeInterruptInputStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.inputId !== "string" ||
    typeof value.afterRunId !== "string" ||
    value.delivery !== "interrupt" ||
    (value.state !== "queued" &&
      value.state !== "delivered" &&
      value.state !== "terminal") ||
    typeof value.contentPreview !== "string" ||
    typeof value.queuedAt !== "string" ||
    (value.deliveredAt !== undefined && typeof value.deliveredAt !== "string") ||
    (value.entryId !== undefined &&
      (typeof value.entryId !== "string" || value.entryId.length === 0))
  ) {
    return undefined;
  }
  const origin =
    isRecord(value.origin) && typeof value.origin.principalId === "string"
      ? {
          principalId: value.origin.principalId,
          ...(typeof value.origin.clientName === "string"
            ? { clientName: value.origin.clientName }
            : {}),
          ...(typeof value.origin.clientVersion === "string"
            ? { clientVersion: value.origin.clientVersion }
            : {}),
          ...(typeof value.origin.operationId === "string"
            ? { operationId: value.origin.operationId }
            : {}),
        }
      : undefined;
  return {
    inputId: value.inputId,
    afterRunId: value.afterRunId,
    delivery: "interrupt",
    state: value.state,
    contentPreview: value.contentPreview,
    queuedAt: value.queuedAt,
    ...(typeof value.deliveredAt === "string"
      ? { deliveredAt: value.deliveredAt }
      : {}),
    ...(typeof value.entryId === "string" && value.entryId.length > 0
      ? { entryId: value.entryId }
      : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

function isRuntimeRunPhase(value: unknown): value is RuntimeRunPhase {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting_agent" ||
    value === "recovering" ||
    value === "waiting_permission" ||
    value === "waiting_user_input" ||
    value === "unknown" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isRuntimeRunStage(value: unknown): value is RuntimeRunStage {
  return (
    value === "queued" ||
    value === "executing" ||
    value === "waiting_agent" ||
    value === "recovering" ||
    value === "finalizing" ||
    value === "terminal" ||
    value === "unknown" ||
    value === "starting" ||
    value === "routing" ||
    value === "preflight" ||
    value === "round" ||
    value === "worker" ||
    value === "upgrade" ||
    value === "verifying"
  );
}

function parseRuntimeTerminalFact(
  value: unknown,
): RuntimeTerminalFact | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    !isRuntimeTerminalKind(value.kind) ||
    !isRuntimeTerminalCode(value.code) ||
    (value.effectOutcome !== "none" &&
      value.effectOutcome !== "known" &&
      value.effectOutcome !== "unknown")
  )
    return undefined;
  return {
    revision: value.revision,
    kind: value.kind,
    code: value.code,
    effectOutcome: value.effectOutcome,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function isRuntimeTerminalKind(
  value: unknown,
): value is RuntimeTerminalFact["kind"] {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isRuntimeTerminalCode(value: unknown): value is RuntimeTerminalCode {
  return (
    value === "completed" ||
    value === "run_failed" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "runtime_restarted" ||
    value === "daemon_crashed" ||
    value === "credential_unavailable" ||
    value === "host_not_dispatched" ||
    value === "host_outcome_unknown" ||
    value === "control_history_untrusted"
  );
}

function recordFromPersistedStatus(
  status: RuntimeRunStatus,
  ownedByRuntime: boolean,
  observedOwner?: AgentActorOwner,
): RuntimeRunRecord {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    ...(status.turnId !== undefined ? { turnId: status.turnId } : {}),
    phase: status.phase,
    ...(status.stage !== undefined ? { stage: status.stage } : {}),
    ...(status.stageChangedAt !== undefined
      ? { stageChangedAt: status.stageChangedAt }
      : {}),
    ...(status.activeSubtaskCount !== undefined
      ? { activeSubtaskCount: status.activeSubtaskCount }
      : {}),
    startedAt: status.startedAt,
    sessionOrder: status.sessionOrder ?? 0,
    ...(status.queuedAt !== undefined ? { queuedAt: status.queuedAt } : {}),
    ...(status.runningAt !== undefined ? { runningAt: status.runningAt } : {}),
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    provider: status.provider,
    ...(status.origin !== undefined ? { origin: status.origin } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.reasoning !== undefined ? { reasoning: status.reasoning } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...(status.lifecycleError !== undefined
      ? { lifecycleError: status.lifecycleError }
      : {}),
    ...(status.terminal !== undefined ? { terminal: status.terminal } : {}),
    ...(status.stop !== undefined ? { stop: status.stop } : {}),
    ...(status.continuation !== undefined
      ? {
          continuation: {
            inputId: status.continuation.inputId,
            afterRunId: status.continuation.afterRunId,
            delivery: status.continuation.delivery,
            contentPreview: status.continuation.contentPreview,
          },
        }
      : {}),
    interruptInputs: (status.interruptInputs ?? []).map((input) => ({
      ...input,
    })),
    interruptInputOpen: false,
    mode: status.mode ?? "coding",
    hadProviderCredential: false,
    result: Promise.resolve(resultFromStatus(status)),
    terminalEmitted: isTerminalRunPhase(status.phase),
    ownedByRuntime,
    ...(observedOwner !== undefined ? { observedOwner } : {}),
  };
}

function interruptPersistedNonTerminalRun(
  status: RuntimeRunStatus,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
): RuntimeRunStatus {
  const durableTerminal = recoverPersistedDurableTerminal(
    status,
    bus,
    persistence,
  );
  if (durableTerminal !== undefined) return durableTerminal;
  const durableEvents = [...persistence.replay({ runId: status.runId })];
  const reconciledStatus = reconcilePersistedInterruptDeliveries(
    status,
    durableEvents,
  );
  if (isTerminalRunPhase(reconciledStatus.phase)) {
    if (reconciledStatus !== status) {
      saveRunStatusSafely(bus, persistence, undefined, reconciledStatus);
    }
    return reconciledStatus;
  }
  const reason: RuntimeTerminalCode =
    reconciledStatus.phase === "queued"
      ? "runtime_restarted"
      : "daemon_crashed";
  const endedAt = new Date().toISOString();
  const recovered: RuntimeRunStatus = {
    ...reconciledStatus,
    phase: "interrupted",
    stage: "terminal",
    stageChangedAt: endedAt,
    activeSubtaskCount: 0,
    endedAt,
    error: reason,
    ...(reconciledStatus.stop !== undefined
      ? {
          stop: {
            ...reconciledStatus.stop,
            state: "confirmed",
            outcome: "interrupted",
            resolvedAt: endedAt,
          },
        }
      : {}),
    ...(reconciledStatus.interruptInputs !== undefined
      ? {
          interruptInputs: reconciledStatus.interruptInputs.map((input) =>
            input.state === "queued"
              ? { ...input, state: "terminal" as const }
              : input,
          ),
        }
      : {}),
    terminal: {
      revision: 1,
      kind: "interrupted",
      code: reason,
      effectOutcome: reconciledStatus.phase === "queued" ? "none" : "unknown",
      message:
        "Runtime process restarted before this run reached a durable terminal state.",
    },
  };
  const authoritative = saveRunStatusSafely(
    bus,
    persistence,
    undefined,
    recovered,
  );
  if (authoritative === undefined) {
    return {
      ...reconciledStatus,
      phase: "unknown",
      stage: "unknown",
      error: "terminal_recovery_not_persisted",
    };
  }
  if (authoritative !== recovered) {
    return authoritative;
  }
  bus.emit("run.interrupted", authoritative, {
    sessionId: authoritative.sessionId,
    runId: authoritative.runId,
    ...(authoritative.turnId !== undefined
      ? { turnId: authoritative.turnId }
      : {}),
  });
  return authoritative;
}

function recoverPersistedDurableTerminal(
  status: RuntimeRunStatus,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
): RuntimeRunStatus | undefined {
  const durableEvents = [...persistence.replay({ runId: status.runId })];
  const durableTerminal = [...durableEvents].reverse().find((event) => {
    if (!isTerminalRuntimeEvent(event.type)) return false;
    const eventStatus = parseRuntimeRunStatus(event.payload);
    return (
      eventStatus?.runId === status.runId &&
      eventStatus.sessionId === status.sessionId &&
      eventStatus.phase === terminalPhaseFromEvent(event.type)
    );
  });
  if (durableTerminal === undefined) return undefined;
  const recovered = parseRuntimeRunStatus(durableTerminal.payload);
  if (recovered === undefined) return undefined;
  const reconciled = reconcilePersistedInterruptDeliveries(
    recovered,
    durableEvents,
  );
  saveRunStatusSafely(bus, persistence, undefined, reconciled);
  return reconciled;
}

function reconcilePersistedInterruptDeliveries(
  status: RuntimeRunStatus,
  events: readonly RuntimeEvent[],
): RuntimeRunStatus {
  if (status.interruptInputs === undefined) return status;
  const deliveryByInputId = new Map<
    string,
    { readonly deliveredAt: string; readonly entryId?: string }
  >();
  for (const event of events) {
    if (
      event.type !== "run.input.delivered" ||
      event.runId !== status.runId ||
      event.sessionId !== status.sessionId ||
      !isRecord(event.payload)
    )
      continue;
    const inputs = event.payload.inputs;
    if (!Array.isArray(inputs)) continue;
    for (const input of inputs) {
      if (!isRecord(input)) continue;
      if (
        typeof input.inputId !== "string" ||
        input.afterRunId !== status.runId ||
        typeof input.deliveredAt !== "string" ||
        (input.entryId !== undefined &&
          (typeof input.entryId !== "string" || input.entryId.length === 0))
      )
        continue;
      deliveryByInputId.set(input.inputId, {
        deliveredAt: input.deliveredAt,
        ...(typeof input.entryId === "string" ? { entryId: input.entryId } : {}),
      });
    }
  }
  let changed = false;
  const interruptInputs = status.interruptInputs.map((input) => {
    const delivery = deliveryByInputId.get(input.inputId);
    if (delivery === undefined) return input;
    if (input.state === "queued") {
      changed = true;
      return {
        ...input,
        state: "delivered" as const,
        deliveredAt: delivery.deliveredAt,
        ...(delivery.entryId !== undefined ? { entryId: delivery.entryId } : {}),
      };
    }
    if (
      input.state === "delivered" &&
      delivery.entryId !== undefined &&
      input.entryId !== delivery.entryId
    ) {
      changed = true;
      return { ...input, entryId: delivery.entryId };
    }
    return input;
  });
  return changed ? { ...status, interruptInputs } : status;
}

function terminalPhaseFromEvent(
  type: RuntimeEventType,
): RuntimeRunPhase | undefined {
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.interrupted") return "interrupted";
  return undefined;
}

function resolvePermissionTimeoutMs(
  expiresAt: string | undefined,
  fallbackMs: number,
): number {
  if (expiresAt === undefined) return fallbackMs;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 1;
  return Math.max(1, expiresAtMs - Date.now());
}

function createRuntimeUserInputRegistry(
  bus: RuntimeEventBus,
  defaultTimeoutMs: number,
) {
  const pending = new Map<string, PendingUserInput>();

  const resolvePending = (
    requestId: string,
    resolution: RuntimePendingUserInputResolution,
    options?: { readonly expectedRevision?: number; readonly runId?: string },
    reason?: string,
  ): RuntimeUserInputResolution => {
    const item = pending.get(requestId);
    if (
      !item ||
      (options?.runId !== undefined && item.request.runId !== options.runId) ||
      (options?.expectedRevision !== undefined &&
        item.request.revision !== options.expectedRevision)
    ) {
      return { requestId, accepted: false, status: "already_resolved" };
    }
    if (resolution.status === "answered") {
      assertRuntimeUserInputAnswer(item.request.kind, resolution.answer);
    }
    pending.delete(requestId);
    clearTimeout(item.timer);
    item.resolve(resolution);
    bus.emit(
      "user_input.resolved",
      {
        requestId,
        kind: item.request.kind,
        status: resolution.status,
        ...(reason !== undefined ? { reason } : {}),
      },
      {
        sessionId: item.request.sessionId,
        runId: item.request.runId,
        ...(item.request.turnId !== undefined
          ? { turnId: item.request.turnId }
          : {}),
      },
    );
    return { requestId, accepted: true, status: resolution.status };
  };

  const trackAndWait = (
    input: {
      readonly sessionId: string;
      readonly runId: string;
      readonly turnId?: string;
      readonly kind: RuntimeUserInputKind;
      readonly options: unknown;
    },
    timeoutMs = defaultTimeoutMs,
  ): {
    readonly request: RuntimeUserInputRequest;
    readonly response: Promise<RuntimePendingUserInputResolution>;
  } => {
    const id = `input_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const createdAt = new Date();
    const request: RuntimeUserInputRequest = {
      id,
      revision: 0,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      kind: input.kind,
      options: input.options,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
    };
    let resolveResponse: (
      resolution: RuntimePendingUserInputResolution,
    ) => void = () => undefined;
    const response = new Promise<RuntimePendingUserInputResolution>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );
    const timer = setTimeout(
      () => {
        resolvePending(id, { status: "dismissed" }, undefined, "timeout");
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    pending.set(id, { request, resolve: resolveResponse, timer });
    bus.emit("user_input.requested", request, {
      sessionId: request.sessionId,
      runId: request.runId,
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    });
    return { request, response };
  };

  const dismissMatching = (
    predicate: (request: RuntimeUserInputRequest) => boolean,
    reason: string,
  ): void => {
    for (const item of [...pending.values()]) {
      if (predicate(item.request)) {
        resolvePending(
          item.request.id,
          { status: "dismissed" },
          undefined,
          reason,
        );
      }
    }
  };

  const service: RuntimeUserInputService = {
    async listPending(filter) {
      return [...pending.values()]
        .map((item) => item.request)
        .filter(
          (request) =>
            (filter?.sessionId === undefined ||
              request.sessionId === filter.sessionId) &&
            (filter?.runId === undefined || request.runId === filter.runId),
        );
    },
    async respond(requestId, answer, options) {
      return resolvePending(requestId, { status: "answered", answer }, options);
    },
    async dismiss(requestId, options) {
      return resolvePending(
        requestId,
        { status: "dismissed" },
        options,
        "client_dismissed",
      );
    },
  };

  return {
    service,
    trackAndWait,
    resolve: resolvePending,
    rejectForRun(runId: string, reason: string) {
      dismissMatching((request) => request.runId === runId, reason);
    },
    rejectAll(reason: string) {
      dismissMatching(() => true, reason);
    },
  };
}

function assertRuntimeUserInputAnswer(
  kind: RuntimeUserInputKind,
  answer: unknown,
): void {
  const valid =
    kind === "askUser"
      ? isAskUserAnswer(answer)
      : kind === "askUserMulti"
        ? isAskUserMultiAnswer(answer)
        : typeof answer === "string";
  if (!valid) {
    throw createRuntimeInvalidInputError(`Invalid answer for ${kind}`);
  }
}

function isAskUserAnswer(value: unknown): value is AskUserAnswer {
  return Array.isArray(value)
    ? value.every(isAskUserSelectionAnswer)
    : isAskUserSelectionAnswer(value);
}

function isAskUserSelectionAnswer(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (isRecord(value) &&
      value.kind === "customInput" &&
      typeof value.value === "string")
  );
}

function isAskUserMultiAnswer(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isAskUserAnswer);
}

function createRuntimePermissionRegistry(
  bus: RuntimeEventBus,
  defaultTimeoutMs: number,
  persistence: RuntimePersistence,
) {
  const pending = new Map<string, PendingPermission>();
  const sessionGrants = new Map<string, RuntimePermissionGrant>();
  let grantRevision = 0;

  const trackAndWait = (
    request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
    timeoutMs = defaultTimeoutMs,
    grantContext?: RuntimePermissionGrantContext,
  ): {
    readonly request: RuntimePermissionRequest;
    readonly response: Promise<RuntimePermissionDecision>;
  } => {
    let resolveResponse: (
      decision: RuntimePermissionDecision,
    ) => void = () => {};
    const response = new Promise<RuntimePermissionDecision>((resolve) => {
      resolveResponse = resolve;
    });
    const created = createPendingPermission(
      request,
      [resolveResponse],
      resolvePermissionTimeoutMs(request.expiresAt, timeoutMs),
      grantContext,
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
    if (expectedRunId !== undefined && item.request.runId !== expectedRunId)
      return false;
    if (decision.type === "allow_session" || decision.type === "allow_always") {
      const candidate = resolveRuntimePermissionGrantCandidate(item, decision);
      saveRuntimePermissionCandidate(candidate, item.request);
    }
    pending.delete(requestId);
    if (item.timer) clearTimeout(item.timer);
    for (const resolve of item.waiters) resolve(decision);
    bus.emit(
      "permission.resolved",
      { requestId, decision },
      {
        sessionId: item.request.sessionId,
        runId: item.request.runId,
        ...(item.request.turnId !== undefined
          ? { turnId: item.request.turnId }
          : {}),
      },
    );
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
      return requestPermission(input);
    },

    async listPending(filter) {
      return [...pending.values()]
        .map((item) => item.request)
        .filter((request) => permissionMatchesFilter(request, filter));
    },

    async respond(requestId, decision, options) {
      return resolvePending(requestId, decision, options?.runId);
    },
    async listGrants() {
      const persistent = loadPersistentPermissionGrants();
      return {
        revision: grantRevision,
        value: [...persistent.value, ...sessionGrants.values()],
      };
    },
    async revokeGrant(grantId, expectedRevision) {
      const persistent = loadPersistentPermissionGrants();
      if (grantRevision !== expectedRevision) {
        throw createRuntimeConflictError(
          `Permission grant revision ${expectedRevision} is stale; current revision is ${grantRevision}`,
          grantRevision,
        );
      }
      const sessionGrant = sessionGrants.get(grantId);
      if (sessionGrant !== undefined) {
        sessionGrants.delete(grantId);
        grantRevision += 1;
        persistence.savePermissionGrants({
          revision: grantRevision,
          value: persistent.value,
        });
        emitPermissionGrantChanged("revoked", sessionGrant, grantRevision);
        return true;
      }
      const revoked = persistent.value.find((grant) => grant.id === grantId);
      const next = persistent.value.filter((grant) => grant.id !== grantId);
      if (next.length === persistent.value.length) return false;
      grantRevision += 1;
      persistence.savePermissionGrants({
        revision: grantRevision,
        value: next,
      });
      if (revoked !== undefined) {
        emitPermissionGrantChanged("revoked", revoked, grantRevision);
      }
      return true;
    },
  };

  function requestPermission(
    input: RuntimePermissionRequestInput,
    ownerContext?: RuntimePermissionGrantContext,
  ): Promise<RuntimePermissionDecision> {
    const grantContext =
      ownerContext ??
      (input.toolInput !== undefined
        ? { toolInput: input.toolInput }
        : undefined);
    const grant = findPermissionGrant(
      input.sessionId,
      input.toolName,
      grantContext?.toolInput,
      input.executionCwd,
      grantContext?.shell,
      grantContext?.shellContractFingerprint,
    );
    if (grant !== undefined) {
      return grant.persistence === "session"
        ? Promise.resolve({ type: "allow_session", suggestionId: grant.id })
        : Promise.resolve({ type: "allow_always", suggestionId: grant.id });
    }
    const { toolInput: _toolInput, ...requestInput } = input;
    const trustedInputPreview =
      grantContext === undefined
        ? requestInput.inputPreview
        : previewInput(grantContext.toolInput);
    const request: Omit<RuntimePermissionRequest, "id" | "createdAt"> = {
      sessionId: requestInput.sessionId,
      runId: requestInput.runId,
      ...(requestInput.turnId !== undefined
        ? { turnId: requestInput.turnId }
        : {}),
      ...(requestInput.toolCallId !== undefined
        ? { toolCallId: requestInput.toolCallId }
        : {}),
      toolName: requestInput.toolName,
      ...(requestInput.reason !== undefined
        ? { reason: requestInput.reason }
        : {}),
      ...(requestInput.risk !== undefined ? { risk: requestInput.risk } : {}),
      ...(trustedInputPreview !== undefined
        ? { inputPreview: trustedInputPreview }
        : {}),
      ...(requestInput.executionCwd !== undefined
        ? { executionCwd: requestInput.executionCwd }
        : {}),
      ...(requestInput.autoModeDiagnostics !== undefined
        ? { autoModeDiagnostics: requestInput.autoModeDiagnostics }
        : {}),
      ...(requestInput.expiresAt !== undefined
        ? { expiresAt: requestInput.expiresAt }
        : {}),
    };
    const coalesced =
      grantContext === undefined
        ? undefined
        : joinMatchingPendingPermission(request, grantContext);
    if (coalesced !== undefined) return coalesced;
    const pendingPermission = trackAndWait(
      request,
      requestInput.timeoutMs ?? defaultTimeoutMs,
      grantContext,
    );
    return pendingPermission.response;
  }

  function loadPersistentPermissionGrants(): RuntimeVersionedValue<
    readonly RuntimePermissionGrant[]
  > {
    const current = persistence.loadPermissionGrants();
    grantRevision = Math.max(grantRevision, current.revision);
    return current;
  }

  function findPermissionGrant(
    sessionId: string,
    toolName: string,
    toolInput?: Readonly<Record<string, unknown>>,
    executionCwd?: string,
    shell?: RuntimeExactCommandPermissionMatcher["shell"],
    shellContractFingerprint?: string,
  ): RuntimePermissionGrant | undefined {
    const persistent = loadPersistentPermissionGrants().value;
    return [...sessionGrants.values(), ...persistent].find((grant) => {
      if (
        grant.scope.sessionId !== undefined &&
        grant.scope.sessionId !== sessionId
      )
        return false;
      if (
        grant.scope.toolName !== undefined &&
        grant.scope.toolName !== toolName
      )
        return false;
      // Legacy coarse grants remain visible and revocable, but cannot authorize
      // a concrete call without a Runtime-issued matcher.
      if (grant.scope.matcher === undefined) return false;
      if (toolInput === undefined) return false;
      if (
        grant.persistence !== "session" &&
        grant.scope.matcher.kind === "exact-command" &&
        typeof toolInput.command === "string" &&
        hasDynamicExpansionForPermissionShell(
          toolInput.command,
          shell ??
            (runtimePermissionHostPlatform() === "win32" ? "cmd" : "posix"),
        )
      )
        return false;
      return runtimePermissionMatcherMatches(grant.scope.matcher, {
        toolName,
        toolInput,
        executionCwd: executionCwd ?? process.cwd(),
        ...(shell !== undefined ? { shell } : {}),
        ...(shellContractFingerprint !== undefined
          ? { shellContractFingerprint }
          : {}),
      });
    });
  }

  function joinMatchingPendingPermission(
    request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
    context: RuntimePermissionGrantContext,
  ): Promise<RuntimePermissionDecision> | undefined {
    const candidates = createRuntimePermissionGrantCandidates(request, context);
    if (candidates.length === 0) return undefined;
    const match = [...pending.values()].find(
      (item) =>
        item.request.sessionId === request.sessionId &&
        item.request.runId === request.runId &&
        item.grantCandidates.length === candidates.length &&
        candidates.every((candidate) =>
          item.grantCandidates.some(
            (existing) =>
              existing.persistence === candidate.persistence &&
              permissionScopesEqual(existing.scope, candidate.scope),
          ),
        ),
    );
    if (!match) return undefined;
    return new Promise<RuntimePermissionDecision>((resolve) => {
      match.waiters.push(resolve);
    });
  }

  function resolveRuntimePermissionGrantCandidate(
    item: PendingPermission,
    decision: Extract<
      RuntimePermissionDecision,
      { readonly type: "allow_session" | "allow_always" }
    >,
  ): RuntimePermissionGrantCandidate {
    const expectedKind =
      decision.type === "allow_session" ? "session" : "persistent";
    const candidate =
      "suggestionId" in decision
        ? item.grantCandidates.find(
            (entry) =>
              entry.suggestion.id === decision.suggestionId &&
              entry.persistence === expectedKind,
          )
        : resolveLegacyRuntimePermissionGrantCandidate(
            item,
            decision.scope,
            expectedKind,
          );
    if (!candidate) {
      throw createRuntimeInvalidInputError(
        "Permission decision does not select a Runtime-issued grant suggestion.",
      );
    }
    return candidate;
  }

  function saveRuntimePermissionCandidate(
    candidate: RuntimePermissionGrantCandidate,
    request: RuntimePermissionRequest,
  ): void {
    const grant: RuntimePermissionGrant = {
      id: `grant_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      scope: candidate.scope,
      createdAt: new Date().toISOString(),
      persistence: candidate.persistence,
      label: candidate.suggestion.label,
      sourcePermissionId: request.id,
    };
    if (candidate.persistence === "session") {
      if (
        [...sessionGrants.values()].some((item) =>
          permissionScopesEqual(item.scope, grant.scope),
        )
      )
        return;
      const persistent = loadPersistentPermissionGrants();
      grantRevision += 1;
      sessionGrants.set(grant.id, grant);
      persistence.savePermissionGrants({
        revision: grantRevision,
        value: persistent.value,
      });
      emitPermissionGrantChanged("created", grant, grantRevision, request);
      return;
    }
    const current = loadPersistentPermissionGrants();
    if (
      current.value.some((item) =>
        permissionScopesEqual(item.scope, grant.scope),
      )
    )
      return;
    grantRevision += 1;
    persistence.savePermissionGrants({
      revision: grantRevision,
      value: [...current.value, grant],
    });
    emitPermissionGrantChanged("created", grant, grantRevision, request);
  }

  function emitPermissionGrantChanged(
    action: RuntimePermissionGrantChangedEventPayload["action"],
    grant: RuntimePermissionGrant,
    revision: number,
    request?: RuntimePermissionRequest,
  ): void {
    bus.emit(
      "permission.grant.changed",
      { action, grant, revision },
      {
        sessionId: request?.sessionId ?? grant.scope.sessionId ?? "runtime",
        runId: request?.runId ?? "permission-grants",
        ...(request?.turnId !== undefined ? { turnId: request.turnId } : {}),
      },
    );
  }

  return {
    service,
    requestOwned(
      input: RuntimePermissionRequestInput,
      context: RuntimePermissionGrantContext,
    ): Promise<RuntimePermissionDecision> {
      return requestPermission(input, context);
    },
    track(
      request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
    ): RuntimePermissionRequest {
      const created = createPendingPermission(
        request,
        [],
        resolvePermissionTimeoutMs(request.expiresAt, defaultTimeoutMs),
      );
      return created;
    },
    trackAndWait(
      request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
      timeoutMs = defaultTimeoutMs,
      grantContext?: RuntimePermissionGrantContext,
    ) {
      return trackAndWait(request, timeoutMs, grantContext);
    },
    resolve(requestId: string, decision: RuntimePermissionDecision): void {
      resolvePending(requestId, decision);
    },
    isGranted(
      sessionId: string,
      toolName: string,
      toolInput?: Readonly<Record<string, unknown>>,
      executionCwd?: string,
      shell?: RuntimeExactCommandPermissionMatcher["shell"],
      shellContractFingerprint?: string,
    ): boolean {
      return (
        findPermissionGrant(
          sessionId,
          toolName,
          toolInput,
          executionCwd,
          shell,
          shellContractFingerprint,
        ) !== undefined
      );
    },
    rejectForRun(runId: string, reason: string): void {
      resolveMatching((request) => request.runId === runId, {
        type: "reject",
        reason,
      });
    },
    rejectAll(reason: string): void {
      resolveMatching(() => true, { type: "reject", reason });
    },
    releaseSession(sessionId: string): void {
      const persistent = loadPersistentPermissionGrants();
      const removed = [...sessionGrants.values()].filter(
        (grant) => grant.scope.sessionId === sessionId,
      );
      if (removed.length === 0) return;
      for (const grant of removed) sessionGrants.delete(grant.id);
      grantRevision += 1;
      persistence.savePermissionGrants({
        revision: grantRevision,
        value: persistent.value,
      });
      for (const grant of removed) {
        emitPermissionGrantChanged("expired", grant, grantRevision);
      }
    },
    releaseAllSessionGrants(): void {
      if (sessionGrants.size === 0) return;
      const persistent = loadPersistentPermissionGrants();
      const removed = [...sessionGrants.values()];
      sessionGrants.clear();
      grantRevision += 1;
      persistence.savePermissionGrants({
        revision: grantRevision,
        value: persistent.value,
      });
      for (const grant of removed) {
        emitPermissionGrantChanged("expired", grant, grantRevision);
      }
    },
  };

  function createPendingPermission(
    request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
    waiters: Array<(decision: RuntimePermissionDecision) => void>,
    timeoutMs = defaultTimeoutMs,
    grantContext?: RuntimePermissionGrantContext,
  ): RuntimePermissionRequest {
    const inputPreview =
      request.inputPreview === undefined
        ? undefined
        : normalizePermissionInputPreview(request.inputPreview);
    const grantCandidates =
      grantContext === undefined
        ? []
        : createRuntimePermissionGrantCandidates(request, grantContext);
    const createdAt = new Date();
    const created: RuntimePermissionRequest = {
      ...request,
      ...(inputPreview !== undefined ? { inputPreview } : {}),
      executionCwd: path.resolve(request.executionCwd ?? process.cwd()),
      id: `perm_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      createdAt: createdAt.toISOString(),
      ...(request.expiresAt === undefined && timeoutMs > 0
        ? { expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString() }
        : {}),
      ...(grantCandidates.length > 0
        ? {
            grantSuggestions: grantCandidates.map(
              (candidate) => candidate.suggestion,
            ),
          }
        : {}),
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            const item = pending.get(created.id);
            if (!item) return;
            pending.delete(created.id);
            const decision: RuntimePermissionDecision = {
              type: "reject",
              reason: "permission request timed out",
              cause: "approval_timeout",
            };
            for (const resolve of item.waiters) resolve(decision);
            bus.emit(
              "permission.resolved",
              { requestId: created.id, decision },
              {
                sessionId: created.sessionId,
                runId: created.runId,
                ...(created.turnId !== undefined
                  ? { turnId: created.turnId }
                  : {}),
              },
            );
          }, timeoutMs)
        : undefined;
    timer?.unref?.();
    pending.set(created.id, {
      request: created,
      waiters,
      grantCandidates,
      ...(timer !== undefined ? { timer } : {}),
    });
    bus.emit("permission.requested", created, {
      sessionId: created.sessionId,
      runId: created.runId,
      ...(created.turnId !== undefined ? { turnId: created.turnId } : {}),
    });
    return created;
  }
}

function resolveLegacyRuntimePermissionGrantCandidate(
  item: PendingPermission,
  requestedScope: RuntimePermissionScope,
  persistence: "session" | "persistent",
): RuntimePermissionGrantCandidate | undefined {
  if (
    requestedScope.toolName !== undefined &&
    requestedScope.toolName !== item.request.toolName
  )
    return undefined;
  if (
    requestedScope.sessionId !== undefined &&
    requestedScope.sessionId !== item.request.sessionId
  )
    return undefined;
  const candidate = item.grantCandidates.find((candidate) => {
    if (candidate.persistence !== persistence) return false;
    if (requestedScope.matcher !== undefined) {
      return (
        candidate.scope.matcher?.kind === requestedScope.matcher.kind &&
        candidate.scope.matcher.fingerprint ===
          requestedScope.matcher.fingerprint
      );
    }
    // Compatibility callers can identify only the legacy tool/session
    // projection. The Runtime persists the already-issued concrete candidate,
    // never the broader caller-supplied projection.
    return true;
  });
  if (!candidate || requestedScope.sessionId === undefined) return candidate;
  return {
    ...candidate,
    scope: { ...candidate.scope, sessionId: requestedScope.sessionId },
  };
}

function createRuntimePermissionGrantCandidates(
  request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
  context: RuntimePermissionGrantContext,
): readonly RuntimePermissionGrantCandidate[] {
  const executionCwd = path.resolve(request.executionCwd ?? process.cwd());
  const matcher = createRuntimePermissionMatcher({
    toolName: request.toolName,
    toolInput: context.toolInput,
    executionCwd,
    ...(context.shell !== undefined ? { shell: context.shell } : {}),
    ...(context.shellContractFingerprint !== undefined
      ? { shellContractFingerprint: context.shellContractFingerprint }
      : {}),
  });
  if (
    matcher.kind === "exact-command" &&
    (typeof context.toolInput.command !== "string" ||
      context.toolInput.command.trim().length === 0)
  )
    return [];
  const label = runtimePermissionGrantLabel(matcher, context.toolInput);
  const candidates: RuntimePermissionGrantCandidate[] = [
    {
      suggestion: {
        id: `scope_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        kind: "session",
        label: runtimePermissionGrantSuggestionLabel(
          matcher,
          label,
          request.toolName,
          "session",
        ),
      },
      scope: {
        toolName: request.toolName,
        sessionId: request.sessionId,
        matcher,
      },
      persistence: "session",
    },
  ];
  if (
    matcher.kind !== "exact-call" &&
    isPersistentRuntimePermissionSafe(request, context, executionCwd)
  ) {
    candidates.push({
      suggestion: {
        id: `scope_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        kind: "persistent",
        label: runtimePermissionGrantSuggestionLabel(
          matcher,
          label,
          request.toolName,
          "persistent",
        ),
      },
      scope: { toolName: request.toolName, matcher },
      persistence: "persistent",
    });
  }
  return candidates;
}

function isPersistentRuntimePermissionSafe(
  request: Omit<RuntimePermissionRequest, "id" | "createdAt">,
  context: RuntimePermissionGrantContext,
  executionCwd: string,
): boolean {
  if (request.risk === "high") return false;
  const call = {
    id: request.toolCallId ?? "permission-scope",
    name: request.toolName,
    input: context.toolInput,
  };
  const projectRoot = path.resolve(context.projectRoot ?? executionCwd);
  if (checkAbsoluteDeny(call, projectRoot, executionCwd).denied) return false;
  const signals = [
    ...(context.signals ?? []),
    ...bashSignalCollector.collect(call, projectRoot, executionCwd),
  ];
  if (signals.some((signal) => signal.kind === "dangerous_pattern"))
    return false;
  if (request.toolName === "bash") {
    const command =
      typeof context.toolInput.command === "string"
        ? context.toolInput.command
        : "";
    if (
      hasDynamicExpansionForPermissionShell(
        command,
        context.shell ??
          (runtimePermissionHostPlatform() === "win32" ? "cmd" : "posix"),
      )
    )
      return false;
  }
  return true;
}

function runtimePermissionGrantLabel(
  matcher: RuntimePermissionMatcher,
  toolInput: Readonly<Record<string, unknown>>,
): string {
  const raw =
    matcher.kind === "exact-command"
      ? typeof toolInput.command === "string"
        ? toolInput.command
        : matcher.toolName
      : matcher.kind === "exact-path"
        ? matcher.path
        : matcher.toolName;
  const normalized = redactPermissionPreviewString(
    raw.slice(0, PERMISSION_PREVIEW_SCAN_MAX_LENGTH),
  )
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

function runtimePermissionGrantSuggestionLabel(
  matcher: RuntimePermissionMatcher,
  label: string,
  toolName: string,
  persistence: "session" | "persistent",
): string {
  if (matcher.kind === "exact-command") {
    return persistence === "session"
      ? `Allow this exact command for this Runtime session: ${label}`
      : `Always allow this exact command: ${label}`;
  }
  if (matcher.kind === "exact-path") {
    return persistence === "session"
      ? `Allow ${toolName} on this path for this Runtime session: ${label}`
      : `Always allow ${toolName} on this path: ${label}`;
  }
  return `Allow this exact ${toolName} call for this Runtime session`;
}

interface RuntimeDiagnosticIdentityPayload {
  readonly contextId?: string;
  readonly contextKind?: "root" | "child";
  readonly parentContextId?: string;
  readonly agentId?: string;
}

function childParentContextId(rootSessionId: string, agentId: string): string {
  const separator = agentId.lastIndexOf("/");
  if (separator <= 0) return rootSessionId;
  const parentAgentId = agentId.slice(0, separator);
  return parentAgentId === "/root"
    ? rootSessionId
    : `${rootSessionId}/agent/${encodeURIComponent(parentAgentId)}`;
}

function withRuntimeDiagnosticIdentity<
  T extends RuntimeDiagnosticIdentityPayload,
>(event: T, rootSessionId: string): T & RuntimeDiagnosticIdentityPayload {
  const contextKind =
    event.contextKind ?? (event.agentId === undefined ? "root" : "child");
  const contextId =
    event.contextId ??
    (contextKind === "child" && event.agentId !== undefined
      ? `${rootSessionId}/agent/${encodeURIComponent(event.agentId)}`
      : rootSessionId);
  const parentContextId =
    event.parentContextId ??
    (contextKind === "child" && event.agentId !== undefined
      ? childParentContextId(rootSessionId, event.agentId)
      : undefined);
  return {
    ...event,
    contextId,
    contextKind,
    ...(parentContextId !== undefined ? { parentContextId } : {}),
  };
}

function permissionScopesEqual(
  left: RuntimePermissionScope,
  right: RuntimePermissionScope,
): boolean {
  return (
    left.toolName === right.toolName &&
    left.sessionId === right.sessionId &&
    left.matcher?.kind === right.matcher?.kind &&
    left.matcher?.fingerprint === right.matcher?.fingerprint
  );
}

function wrapKodaXEvents(input: {
  readonly bus: RuntimeEventBus;
  readonly original?: KodaXEvents;
  readonly permissions: RuntimePermissionRegistry;
  readonly userInputs: RuntimeUserInputRegistry;
  readonly enableSharedInteractions: boolean;
  readonly record: RuntimeRunRecord;
  readonly onExecutorTerminal: (
    signal: "completed" | "failed",
    error?: Error,
  ) => void;
  readonly onPhase: (phase: RuntimeRunPhase) => void;
  readonly onStage: (
    stage: RuntimeRunStage,
    activeSubtaskCount?: number,
  ) => void;
  readonly onMidTurnUserMessages: (
    queuedMessageIds: readonly string[],
    queuedMessageEntryIds: Readonly<Record<string, string>> | undefined,
  ) => void;
}): KodaXEvents {
  const {
    bus,
    original,
    permissions,
    userInputs,
    enableSharedInteractions,
    record,
    onExecutorTerminal,
    onPhase,
    onStage,
    onMidTurnUserMessages,
  } = input;
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
    bus.emit(
      type,
      redactScopedProviderCredential(payload),
      scopeFromMeta(meta),
    );
  };
  const resumeFromTransientPhase = (): void => {
    if (record.phase === "waiting_agent" || record.phase === "recovering") {
      onPhase("running");
    }
  };
  const runWithUserInputPhase = async <T>(
    kind: RuntimeUserInputKind,
    options: unknown,
    meta: KodaXToolEventMeta | undefined,
    execute: (() => Promise<T>) | undefined,
    dismissed: T,
  ): Promise<T> => {
    const previousPhase = record.phase;
    if (record.phase === "running") {
      onPhase("waiting_user_input");
    }
    if (enableSharedInteractions) {
      const pendingInput = userInputs.trackAndWait({
        sessionId: meta?.sessionId ?? record.sessionId,
        runId: record.runId,
        ...((meta?.turnId ?? record.turnId)
          ? { turnId: meta?.turnId ?? record.turnId }
          : {}),
        kind,
        options,
      });
      try {
        const resolution =
          execute === undefined
            ? await pendingInput.response
            : await Promise.race([
                pendingInput.response,
                execute()
                  .then((answer): RuntimePendingUserInputResolution => ({
                    status: answer === undefined ? "dismissed" : "answered",
                    ...(answer !== undefined ? { answer } : {}),
                  }))
                  .then((hookResolution) => {
                    userInputs.resolve(pendingInput.request.id, hookResolution);
                    return hookResolution;
                  }),
              ]);
        return resolution.status === "answered"
          ? (resolution.answer as T)
          : dismissed;
      } finally {
        if (record.phase === "waiting_user_input") onPhase(previousPhase);
      }
    }

    const requestId = `input_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    emit("user_input.requested", { requestId, kind, options }, meta);
    try {
      if (execute === undefined) return dismissed;
      const answer = await execute();
      emit(
        "user_input.resolved",
        {
          requestId,
          kind,
          status: answer === undefined ? "dismissed" : "answered",
        },
        meta,
      );
      return answer;
    } catch (error: unknown) {
      emit(
        "user_input.resolved",
        {
          requestId,
          kind,
          status: "failed",
          error: normalizeError(error).message,
        },
        meta,
      );
      throw error;
    } finally {
      if (record.phase === "waiting_user_input") {
        onPhase(previousPhase);
      }
    }
  };

  return {
    ...original,
    onTextDelta(text, meta) {
      resumeFromTransientPhase();
      emit("assistant.delta", { text, meta }, meta);
      original?.onTextDelta?.(text, meta);
    },
    onThinkingDelta(text, meta) {
      resumeFromTransientPhase();
      emit("thinking.delta", { text, meta }, meta);
      original?.onThinkingDelta?.(text, meta);
    },
    onThinkingEnd(thinking, meta) {
      emit("thinking.finished", { thinking, meta }, meta);
      original?.onThinkingEnd?.(thinking, meta);
    },
    onToolUseStart(tool, meta) {
      onPhase(tool.name === "wait_agent" ? "waiting_agent" : "running");
      emit("tool.started", { tool, meta }, meta);
      original?.onToolUseStart?.(tool, meta);
    },
    onToolProgress(update, meta) {
      emit("tool.progress", { update, meta }, meta);
      original?.onToolProgress?.(update, meta);
    },
    onToolSandboxObservation(update, meta) {
      emit("tool.sandbox", { update, meta }, meta);
      original?.onToolSandboxObservation?.(update, meta);
    },
    onToolInputDelta(toolName, partialJson, meta) {
      emit("tool.progress", { toolName, partialJson, meta }, meta);
      original?.onToolInputDelta?.(toolName, partialJson, meta);
    },
    onToolResult(result, meta) {
      if (result.name === "wait_agent") onPhase("running");
      emit("tool.finished", { result, meta }, meta);
      original?.onToolResult?.(result, meta);
    },
    onStreamEnd(meta) {
      emit("run.progress", { kind: "stream_end", meta }, meta);
      original?.onStreamEnd?.(meta);
    },
    onChildActivityEnd(meta) {
      emit("child_activity.finished", { meta }, meta);
      original?.onChildActivityEnd?.(meta);
    },
    onSessionStart(info) {
      record.provider = info.provider;
      bus.emit("session.loaded", redactScopedProviderCredential(info), {
        sessionId: info.sessionId,
        runId: record.runId,
        turnId: info.turnId ?? record.turnId,
      });
      original?.onSessionStart?.(info);
    },
    onTurnStarted(event) {
      record.turnId = event.turnId;
      bus.emit("turn.started", redactScopedProviderCredential(event), {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnStarted?.(event);
    },
    onTurnCompleted(event) {
      bus.emit("turn.completed", redactScopedProviderCredential(event), {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnCompleted?.(event);
    },
    onTurnFailed(event) {
      bus.emit("turn.failed", redactScopedProviderCredential(event), {
        sessionId: event.sessionId,
        runId: record.runId,
        turnId: event.turnId,
      });
      original?.onTurnFailed?.(event);
    },
    onIterationStart(iter, maxIter, meta) {
      emit(
        "run.progress",
        { kind: "iteration_start", iter, maxIter, meta },
        meta,
      );
      original?.onIterationStart?.(iter, maxIter, meta);
    },
    onIterationEnd(info) {
      emit("run.progress", { kind: "iteration_end", info }, info);
      original?.onIterationEnd?.(info);
    },
    onCompactStart(meta) {
      emit("context.compaction.started", { meta }, meta);
      original?.onCompactStart?.(meta);
    },
    onCompact(estimatedTokens, meta) {
      original?.onCompact?.(estimatedTokens, meta);
    },
    onCompactStats(info) {
      emit("context.compaction.stats", info, info);
      original?.onCompactStats?.(info);
    },
    async onCompactedMessages(messages, update, meta) {
      const boundedUpdate =
        update === undefined
          ? undefined
          : {
              hasAnchor: update.anchor !== undefined,
              ...(update.anchor?.tokensBefore !== undefined
                ? { tokensBefore: update.anchor.tokensBefore }
                : {}),
              ...(update.anchor?.tokensAfter !== undefined
                ? { tokensAfter: update.anchor.tokensAfter }
                : {}),
              ...(update.anchor?.entriesRemoved !== undefined
                ? { entriesRemoved: update.anchor.entriesRemoved }
                : {}),
              ...(update.anchor?.reason !== undefined
                ? { reason: update.anchor.reason }
                : {}),
              artifactLedgerEntryCount: update.artifactLedger?.length ?? 0,
              postCompactAttachmentCount:
                update.postCompactAttachments?.length ?? 0,
              exactSnapshotAvailable:
                update.preCompactionMessages !== undefined,
            };
      emit(
        "context.compaction.messages",
        {
          messageCount: messages.length,
          update: boundedUpdate,
          meta,
        },
        meta,
      );
      await original?.onCompactedMessages?.(messages, update, meta);
    },
    onContextCompactionFinished(event) {
      const afterRevision = event.contextRevision ?? 0;
      emit(
        "context.compaction.finished",
        {
          ...event,
          contextId: event.contextId ?? record.sessionId,
          contextKind: event.contextKind ?? "root",
          contextRevision: afterRevision,
          beforeRevision: Math.max(0, afterRevision - 1),
          afterRevision,
        },
        event,
      );
      original?.onContextCompactionFinished?.(event);
    },
    onCompactEnd(meta) {
      emit("context.compaction.ended", { meta }, meta);
      original?.onCompactEnd?.(meta);
    },
    onMidTurnUserMessages(contents, meta) {
      onMidTurnUserMessages(
        meta?.queuedMessageIds ?? [],
        meta?.queuedMessageEntryIds,
      );
      emit(
        "run.progress",
        { kind: "mid_turn_user_messages", contents, meta },
        meta,
      );
      original?.onMidTurnUserMessages?.(contents, meta);
    },
    onRetry(reason, attempt, maxAttempts, meta) {
      emit("provider.retry", { reason, attempt, maxAttempts, meta }, meta);
      original?.onRetry?.(reason, attempt, maxAttempts, meta);
    },
    onProviderRateLimit(attempt, maxRetries, delayMs, meta) {
      emit(
        "provider.retry",
        {
          reason: "rate_limit",
          attempt,
          maxAttempts: maxRetries,
          delayMs,
          meta,
        },
        meta,
      );
      original?.onProviderRateLimit?.(attempt, maxRetries, delayMs, meta);
    },
    onRetryAfter(payload, meta) {
      emit("provider.retry", { retryAfter: payload, meta }, meta);
      original?.onRetryAfter?.(payload, meta);
    },
    onReasoningEffortRejected(event) {
      emit(
        "provider.recovery",
        { kind: "reasoning_effort_rejected", event },
        event,
      );
      original?.onReasoningEffortRejected?.(event);
    },
    onRepoIntelligenceTrace(event) {
      emit("repo_intelligence.trace", event, event);
      original?.onRepoIntelligenceTrace?.(event);
    },
    onContextBudgetSnapshot(event) {
      const attributed = withRuntimeDiagnosticIdentity(event, record.sessionId);
      emit("context.budget.snapshot", attributed, attributed);
      original?.onContextBudgetSnapshot?.(attributed);
    },
    onPromptCacheDiagnostics(event) {
      const attributed = withRuntimeDiagnosticIdentity(event, record.sessionId);
      emit("provider.cache.diagnostics", attributed, attributed);
      original?.onPromptCacheDiagnostics?.(attributed);
    },
    onToolExposurePlanned(event) {
      const attributed = withRuntimeDiagnosticIdentity(event, record.sessionId);
      emit("tool.exposure.planned", attributed, attributed);
      original?.onToolExposurePlanned?.(attributed);
    },
    onContextCompactionSkipped(event) {
      const attributed = withRuntimeDiagnosticIdentity(event, record.sessionId);
      emit("context.compaction.skipped", attributed, attributed);
      original?.onContextCompactionSkipped?.(attributed);
    },
    onSidecarMessage(event) {
      emit("sidecar.message", event, event);
      original?.onSidecarMessage?.(event);
    },
    onTodoUpdate(items, meta) {
      emit("todo.updated", { items, meta }, meta);
      original?.onTodoUpdate?.(items, meta);
    },
    onTodoDriftWarning(event) {
      emit("todo.warning", event, event);
      original?.onTodoDriftWarning?.(event);
    },
    onProviderRecovery(event, meta) {
      onPhase("recovering");
      emit("provider.recovery", { event, meta }, meta);
      original?.onProviderRecovery?.(event, meta);
    },
    onEffectiveConfig(config) {
      emit("config.effective", config, config);
      original?.onEffectiveConfig?.(config);
    },
    onWorkflowProcessEvent(event) {
      const mapped = workflowEventType(event);
      bus.emit(mapped, redactScopedProviderCredential(event), {
        sessionId: event.snapshot.hostMetadata?.sessionId ?? record.sessionId,
        runId: record.runId,
        turnId: record.turnId,
      });
      original?.onWorkflowProcessEvent?.(event);
    },
    onComplete(meta) {
      record.interruptInputOpen = false;
      onExecutorTerminal("completed");
      emit("run.progress", { kind: "complete", meta }, meta);
      original?.onComplete?.(meta);
    },
    onError(error, meta) {
      record.interruptInputOpen = false;
      onExecutorTerminal("failed", error);
      emit(
        "runtime.warning",
        {
          source: "coding",
          severity: "error",
          message: error.message,
        },
        meta,
      );
      original?.onError?.(error, meta);
    },
    onManagedTaskStatus(status) {
      if (record.mode === "managed_task" && status.phase === "completed") {
        record.interruptInputOpen = false;
        onPhase("running");
        onStage("finalizing", 0);
      } else if (record.mode === "managed_task") {
        onPhase(status.idleWaiting === true ? "waiting_agent" : "running");
        const activeSubtaskCount =
          status.idleWaitingPendingCount
          ?? (status.phase === "verifying" ? 0 : undefined);
        onStage(
          status.phase
            ?? (status.idleWaiting === true ? "waiting_agent" : "executing"),
          activeSubtaskCount,
        );
      }
      emit("run.progress", { kind: "managed_task_status", status }, status);
      original?.onManagedTaskStatus?.(status);
    },
    beforeToolExecute: async (
      tool: string,
      toolInput: Record<string, unknown>,
      meta?: KodaXToolEventMeta,
    ): Promise<RuntimePermissionToolDecision> => {
      const autoGuardrail = getRuntimeAutoModeGuardrail(record);
      const autoModeEngine = record.autoModeEngine;
      const runtimeOwnsAutoDecision =
        autoGuardrail !== undefined &&
        replApi.normalizePermissionMode(record.permissionMode) === "auto" &&
        (autoModeEngine === "llm" || autoModeEngine === "rules");
      if (runtimeOwnsAutoDecision) {
        if (RUNTIME_PERMISSION_BRIDGE_TOOLS.has(tool)) return true;
        const hostDecision = await original?.beforeToolExecute?.(
          tool,
          toolInput,
          meta,
        );
        if (hostDecision !== undefined && hostDecision !== true) {
          return hostDecision;
        }
        const allowed =
          meta?.toolId !== undefined &&
          autoGuardrail.consumeAllowedCall({
            id: meta.toolId,
            name: tool,
            input: toolInput,
          });
        if (!allowed) {
          return "[Blocked] Runtime auto mode did not classify this concrete tool call.";
        }
        return true;
      }
      if (replApi.normalizePermissionMode(record.permissionMode) === "plan") {
        const planDecision = resolveRuntimePermissionPolicy(
          record,
          tool,
          toolInput,
        );
        if (planDecision !== true && planDecision !== undefined)
          return planDecision;
      }
      const shellPermission = runtimeShellPermissionIdentity(record);
      if (
        permissions.isGranted(
          meta?.sessionId ?? record.sessionId,
          tool,
          toolInput,
          resolveRuntimeExecutionCwd(record),
          shellPermission?.shell,
          shellPermission?.shellContractFingerprint,
        )
      ) {
        return true;
      }
      // An in-process host hook is authoritative. The runtime policy is the
      // fallback for headless/daemon execution where no executable callback can
      // cross the wire.
      const policyDecision =
        original?.beforeToolExecute === undefined
          ? resolveRuntimePermissionPolicy(record, tool, toolInput)
          : undefined;
      if (policyDecision !== undefined) return policyDecision;
      const previousPhase = record.phase;
      if (record.phase === "running") {
        onPhase("waiting_permission");
      }
      const pendingPermission = permissions.trackAndWait(
        {
          sessionId: meta?.sessionId ?? record.sessionId,
          runId: record.runId,
          ...((meta?.turnId ?? record.turnId)
            ? { turnId: meta?.turnId ?? record.turnId }
            : {}),
          ...(meta?.toolId ? { toolCallId: meta.toolId } : {}),
          toolName: tool,
          inputPreview: previewInput(toolInput),
          executionCwd: resolveRuntimeExecutionCwd(record),
        },
        undefined,
        {
          toolInput,
          ...(shellPermission ?? {}),
          ...(typeof record.start?.options.context?.gitRoot === "string"
            ? { projectRoot: record.start.options.context.gitRoot }
            : {}),
        },
      );
      try {
        if (!original?.beforeToolExecute) {
          const decision = await pendingPermission.response;
          return decisionToToolDecision(decision);
        }
        const hookDecision = Promise.resolve(
          original.beforeToolExecute(tool, toolInput, meta),
        ).then((decision): RuntimePermissionRaceResult => ({
          source: "hook",
          decision,
        }));
        const runtimeDecision = pendingPermission.response.then(
          (decision): RuntimePermissionRaceResult => ({
            source: "runtime",
            decision: decisionToToolDecision(decision),
          }),
        );
        const result = await Promise.race([hookDecision, runtimeDecision]);
        if (result.source === "hook") {
          permissions.resolve(
            pendingPermission.request.id,
            decisionToPermissionDecision(result.decision),
          );
        }
        return result.decision;
      } catch (error: unknown) {
        permissions.resolve(pendingPermission.request.id, {
          type: "reject",
          reason: normalizeError(error).message,
        });
        throw error;
      } finally {
        if (record.phase === "waiting_permission") {
          onPhase(previousPhase === "queued" ? "running" : previousPhase);
        }
      }
    },
    ...(original?.askUser || enableSharedInteractions
      ? {
          askUser: (
            options: AskUserQuestionOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<AskUserAnswer> =>
            runWithUserInputPhase(
              "askUser",
              options,
              meta,
              original?.askUser
                ? () => original.askUser!(options, meta)
                : undefined,
              "",
            ),
        }
      : {}),
    ...(original?.askUserMulti || enableSharedInteractions
      ? {
          askUserMulti: (
            options: AskUserMultiOptions,
            meta?: KodaXToolEventMeta,
          ): Promise<Record<string, AskUserAnswer> | undefined> =>
            runWithUserInputPhase(
              "askUserMulti",
              options,
              meta,
              original?.askUserMulti
                ? () => original.askUserMulti!(options, meta)
                : undefined,
              undefined,
            ),
        }
      : {}),
    ...(original?.askUserInput || enableSharedInteractions
      ? {
          askUserInput: (
            options: { question: string; default?: string },
            meta?: KodaXToolEventMeta,
          ): Promise<string | undefined> =>
            runWithUserInputPhase(
              "askUserInput",
              options,
              meta,
              original?.askUserInput
                ? () => original.askUserInput!(options, meta)
                : undefined,
              undefined,
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
    ...(projectPath !== undefined
      ? { workspaceRoot: projectPath, executionCwd: projectPath }
      : {}),
    ...(projectPath !== undefined ? { workspaceKind: "managed" } : {}),
    ...(input.surface !== undefined ? { surface: input.surface } : {}),
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

function toRuntimeSessionSummary(
  summary: SessionSummary,
): RuntimeSessionSummary {
  return {
    id: summary.id,
    ...(summary.cursor !== undefined ? { cursor: summary.cursor } : {}),
    title: summary.title,
    msgCount: summary.msgCount,
    ...(summary.runtimeInfo?.gitRoot
      ? { gitRoot: summary.runtimeInfo.gitRoot }
      : {}),
    ...(summary.runtimeInfo?.workspaceRoot
      ? { workspaceRoot: summary.runtimeInfo.workspaceRoot }
      : {}),
    ...(summary.runtimeInfo?.surface
      ? { surface: summary.runtimeInfo.surface }
      : {}),
    ...(summary.runtimeInfo?.profileId
      ? { profileId: summary.runtimeInfo.profileId }
      : {}),
    ...(summary.createdAt !== undefined
      ? { createdAt: summary.createdAt }
      : {}),
    ...(summary.tag !== undefined ? { tag: summary.tag } : {}),
    ...(summary.projectKey !== undefined
      ? { projectKey: summary.projectKey }
      : {}),
    ...(summary.archived === true ? { archived: true } : {}),
  };
}

interface NormalizedRuntimeRunInput {
  readonly prompt: string;
  readonly inputArtifacts: readonly KodaXInputArtifact[];
}

type RuntimeRunInputOperation =
  "runtime.runs.start" | "runtime.runs.submitInput";

function normalizeRuntimeRunInput(
  input: RuntimeStartRunInput,
  artifacts: RuntimeArtifactStore,
  operation: RuntimeRunInputOperation,
): NormalizedRuntimeRunInput {
  const items =
    input.input === undefined
      ? []
      : Array.isArray(input.input)
        ? [...input.input]
        : [input.input];
  const textItems = items.filter(
    (item): item is RuntimeTextInput => item.type === "text",
  );
  if (input.prompt !== undefined && textItems.length > 0) {
    throw new Error(
      `${operation} accepts either prompt or text input, not both`,
    );
  }
  if (textItems.length > 1) {
    throw new Error(`${operation} accepts at most one text input item`);
  }
  const prompt = input.prompt ?? textItems[0]?.text;
  if (prompt === undefined) {
    throw new Error(`${operation} requires prompt or text input`);
  }
  return {
    prompt,
    inputArtifacts: items.flatMap((item) =>
      runtimeInputToArtifacts(item, artifacts),
    ),
  };
}

function runtimeInputToArtifacts(
  input: RuntimeInput,
  artifacts: RuntimeArtifactStore,
): KodaXInputArtifact[] {
  if (input.type === "text") return [];
  if (input.type === "artifact_ref") {
    return runtimeArtifactToInputArtifacts(
      artifacts.resolve(input.artifactId),
      input.description,
    );
  }
  if (input.type === "image") {
    const artifact: KodaXImageInputArtifact = {
      kind: "image",
      path: input.path,
      ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    };
    return [artifact];
  }
  if (input.type === "file") {
    const artifact: KodaXFileInputArtifact = {
      kind: "file",
      path: input.path,
      ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    };
    return [artifact];
  }
  if (input.type === "video") {
    const artifact: KodaXVideoInputArtifact = {
      kind: "video",
      path: input.path,
      mediaType: input.mediaType,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    };
    return [artifact];
  }
  const unsupported = input as { readonly type?: unknown };
  throw new Error(
    `Unsupported runtime input type: ${String(unsupported.type)}`,
  );
}

function runtimeArtifactToInputArtifacts(
  artifact: RuntimeArtifact,
  description: string | undefined,
): KodaXInputArtifact[] {
  const resolvedDescription = description ?? artifact.description;
  if (artifact.kind === "image") {
    const inputArtifact: KodaXImageInputArtifact = {
      kind: "image",
      path: artifact.path,
      ...(artifact.mediaType !== undefined
        ? {
            mediaType:
              artifact.mediaType as KodaXImageInputArtifact["mediaType"],
          }
        : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined
        ? { description: resolvedDescription }
        : {}),
    };
    return [inputArtifact];
  }
  if (artifact.kind === "file") {
    const inputArtifact: KodaXFileInputArtifact = {
      kind: "file",
      path: artifact.path,
      ...(artifact.mediaType !== undefined
        ? { mediaType: artifact.mediaType }
        : {}),
      ...(artifact.mimeType !== undefined
        ? { mimeType: artifact.mimeType }
        : {}),
      ...(artifact.name !== undefined ? { name: artifact.name } : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined
        ? { description: resolvedDescription }
        : {}),
    };
    return [inputArtifact];
  }
  if (artifact.kind === "video") {
    const inputArtifact: KodaXVideoInputArtifact = {
      kind: "video",
      path: artifact.path,
      mediaType: (artifact.mediaType ??
        "video/mp4") as KodaXVideoInputArtifact["mediaType"],
      ...(artifact.name !== undefined ? { name: artifact.name } : {}),
      ...(artifact.source !== undefined ? { source: artifact.source } : {}),
      ...(resolvedDescription !== undefined
        ? { description: resolvedDescription }
        : {}),
    };
    return [inputArtifact];
  }
  throw new Error(
    `Unsupported runtime artifact kind: ${String(artifact.kind)}`,
  );
}

function isRuntimeArtifactKind(kind: unknown): kind is RuntimeArtifactKind {
  return typeof kind === "string" && RUNTIME_ARTIFACT_KINDS.has(kind);
}

function buildEffectiveRuntimeOptions(
  options: RuntimeKodaXOptions,
  settings: RuntimeSessionSettings,
  inputArtifacts: readonly KodaXInputArtifact[],
  session: KodaXSessionData,
): RuntimeKodaXOptions {
  const storedGitRoot =
    session.runtimeInfo?.canonicalRepoRoot ??
    (session.gitRoot ? session.gitRoot : undefined);
  const sessionGitRoot =
    storedGitRoot === undefined ? undefined : path.resolve(storedGitRoot);
  const storedExecutionCwd =
    session.runtimeInfo?.executionCwd ??
    session.runtimeInfo?.workspaceRoot ??
    sessionGitRoot;
  const inheritedContext: KodaXOptions["context"] = {
    ...(sessionGitRoot !== undefined ? { gitRoot: sessionGitRoot } : {}),
    ...(settings.executionCwd !== undefined
      ? { executionCwd: path.resolve(settings.executionCwd) }
      : storedExecutionCwd !== undefined
        ? { executionCwd: path.resolve(storedExecutionCwd) }
        : {}),
    ...(settings.shellExecution !== undefined
      ? { shellExecution: settings.shellExecution }
      : {}),
  };
  const optionContext = options.context;
  const optionContextWithoutShellExecution = { ...(optionContext ?? {}) };
  delete optionContextWithoutShellExecution.shellExecution;
  const requestedShellExecution =
    optionContext?.shellExecution === undefined
      ? undefined
      : normalizeShellExecutionContract(optionContext.shellExecution);
  const requestedGitRoot =
    typeof optionContext?.gitRoot === "string"
      ? path.resolve(optionContext.gitRoot)
      : undefined;
  if (
    sessionGitRoot !== undefined &&
    requestedGitRoot !== undefined &&
    !(
      isPathInsideDirectory(sessionGitRoot, requestedGitRoot) &&
      isPathInsideDirectory(requestedGitRoot, sessionGitRoot)
    )
  ) {
    throw new Error(
      "gitRoot must match the session repository safety boundary",
    );
  }
  const requestedExecutionCwd =
    optionContext?.executionCwd === undefined
      ? undefined
      : path.resolve(optionContext.executionCwd);
  const effectiveExecutionCwd =
    requestedExecutionCwd ?? inheritedContext.executionCwd;
  const sessionWorkspaceRoot =
    session.runtimeInfo?.workspaceRoot ?? sessionGitRoot;
  if (
    requestedExecutionCwd !== undefined &&
    sessionWorkspaceRoot !== undefined
  ) {
    assertPathWithinRoot(
      requestedExecutionCwd,
      sessionWorkspaceRoot,
      "executionCwd",
    );
  }
  const combinedArtifacts = [
    ...(optionContext?.inputArtifacts ?? []),
    ...inputArtifacts,
  ];
  const context: KodaXOptions["context"] = {
    ...inheritedContext,
    ...optionContextWithoutShellExecution,
    ...(sessionGitRoot !== undefined
      ? { gitRoot: sessionGitRoot }
      : requestedGitRoot !== undefined
        ? { gitRoot: requestedGitRoot }
        : {}),
    ...(effectiveExecutionCwd !== undefined
      ? { executionCwd: effectiveExecutionCwd }
      : {}),
    ...(requestedShellExecution !== undefined
      ? { shellExecution: requestedShellExecution }
      : {}),
    ...(combinedArtifacts.length > 0
      ? { inputArtifacts: combinedArtifacts }
      : {}),
  };
  const provider = options.provider ?? settings.provider;
  const model = options.model ?? settings.model;
  const effort = options.effort ?? settings.effort;
  const thinking = options.thinking ?? settings.thinking;
  const reasoningMode = options.reasoningMode ?? settings.reasoningMode;
  const requestedAgentMode = options.agentMode ?? settings.agentMode;
  const agentMode = requestedAgentMode === "amaw" ? "ama" : requestedAgentMode;
  const compaction =
    options.compaction !== undefined ||
    settings.compactionTriggerPercent !== undefined ||
    settings.compactionTriggerTokens !== undefined
      ? {
          ...(settings.compactionTriggerPercent !== undefined
            ? { triggerPercent: settings.compactionTriggerPercent }
            : {}),
          ...(settings.compactionTriggerTokens !== undefined
            ? { triggerTokens: settings.compactionTriggerTokens }
            : {}),
          ...(options.compaction ?? {}),
        }
      : undefined;
  return {
    ...options,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoningMode !== undefined ? { reasoningMode } : {}),
    ...(agentMode !== undefined ? { agentMode } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

async function loadRequiredSession(
  manager: SessionManager,
  sessionId: string,
  options?: SessionReadOptions,
): Promise<KodaXSessionData> {
  const data = await manager.storage.read(sessionId, options);
  if (!data) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return data;
}

function createRuntimeReadBudget(
  options: RuntimeReadOptions | undefined,
): RuntimeReadBudget {
  if (
    options?.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("Runtime read timeoutMs must be a positive finite number");
  }
  return {
    ...(options?.timeoutMs !== undefined
      ? { deadline: Date.now() + options.timeoutMs }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  };
}

function sessionReadOptionsFromBudget(
  budget: RuntimeReadBudget,
): SessionReadOptions {
  if (budget.signal?.aborted) {
    throw new replApi.SessionReadError(
      "read_cancelled",
      "Runtime history read cancelled",
    );
  }
  if (budget.deadline === undefined) {
    return budget.signal === undefined ? {} : { signal: budget.signal };
  }
  const timeoutMs = budget.deadline - Date.now();
  if (timeoutMs <= 0) {
    throw new replApi.SessionReadError(
      "read_timeout",
      "Runtime history read timed out",
    );
  }
  return {
    timeoutMs,
    ...(budget.signal !== undefined ? { signal: budget.signal } : {}),
  };
}

function awaitRuntimeReadOperation<T>(
  operation: () => Promise<T>,
  budget: RuntimeReadBudget,
): Promise<T> {
  const options = sessionReadOptionsFromBudget(budget);
  const pending = Promise.resolve().then(operation);
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return pending;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limits: Promise<T>[] = [];
  if (options.timeoutMs !== undefined) {
    limits.push(new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new replApi.SessionReadError(
        "read_timeout",
        "Runtime history read timed out",
      )), options.timeoutMs);
      timer.unref?.();
    }));
  }
  if (options.signal !== undefined) {
    limits.push(new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(new replApi.SessionReadError(
        "read_cancelled",
        "Runtime history read cancelled",
      ));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    }));
  }
  return Promise.race([pending, ...limits]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) {
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

async function yieldToRuntimeReadBudget(
  budget: RuntimeReadBudget,
): Promise<void> {
  await awaitRuntimeReadOperation(
    () => new Promise<void>((resolve) => setImmediate(resolve)),
    budget,
  );
  sessionReadOptionsFromBudget(budget);
}

function createRuntimeSessionAdmission(
  profile: string,
  manager: SessionManager,
  enforced: boolean,
): RuntimeSessionAdmission {
  const admitted = (
    surface: string | undefined,
    profileId: string | undefined,
  ): boolean => {
    if (!enforced) return true;
    if (isPartnerSessionIdentity(surface, profileId)) return false;
    return (
      surface === undefined ||
      CODER_DAEMON_SESSION_SURFACES.has(surface.toLowerCase())
    );
  };
  const reject = (sessionId: string): never => {
    throw Object.assign(
      new Error(
        `Session is not admitted by shared Runtime profile ${profile}: ${sessionId}`,
      ),
      { code: "session_not_admitted" as const },
    );
  };
  const loadAdmitted = async (
    sessionId: string,
    options?: RuntimeReadOptions,
    executable = false,
  ): Promise<KodaXSessionData> => {
    const data = executable
      ? await manager.loadSession(sessionId)
      : await loadRequiredSession(manager, sessionId, options);
    if (data === null) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!admitted(data.runtimeInfo?.surface, data.runtimeInfo?.profileId)) {
      reject(sessionId);
    }
    return data;
  };
  return {
    assertCreate(input) {
      if (!admitted(input.surface, input.profileId))
        reject(input.sessionId ?? "<new>");
    },
    assertFilter(filter) {
      if (
        filter?.surface !== undefined &&
        !admitted(filter.surface, undefined)
      ) {
        reject("<list>");
      }
    },
    admitsData(data) {
      return admitted(data.runtimeInfo?.surface, data.runtimeInfo?.profileId);
    },
    admitsSummary(summary) {
      return admitted(
        summary.runtimeInfo?.surface,
        summary.runtimeInfo?.profileId,
      );
    },
    assertCachedIdentity(sessionId, identity) {
      if (!admitted(identity.surface, identity.profileId)) reject(sessionId);
    },
    async admitsSession(sessionId) {
      if (!enforced) return true;
      const data = await manager.storage.peek(sessionId);
      return (
        data !== null &&
        admitted(data.runtimeInfo?.surface, data.runtimeInfo?.profileId)
      );
    },
    async assertRunAccess(sessionId) {
      if (!enforced) return;
      await loadAdmitted(sessionId);
    },
    async loadRequired(sessionId, options) {
      return loadAdmitted(sessionId, options);
    },
    async captureRequired(sessionId, options) {
      const capture = await manager.readSessionCapture(sessionId, options);
      if (capture === null) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (!admitted(
        capture.data.runtimeInfo?.surface,
        capture.data.runtimeInfo?.profileId,
      )) {
        reject(sessionId);
      }
      return capture;
    },
    async loadExecutable(sessionId) {
      const data = await loadAdmitted(sessionId, undefined, true);
      if (await manager.storage.isArchived(sessionId)) {
        throw createSessionArchivedError(sessionId);
      }
      return data;
    },
  };
}

async function filterAdmittedRunStatuses(
  statuses: readonly RuntimeRunStatus[],
  admission: RuntimeSessionAdmission,
): Promise<readonly RuntimeRunStatus[]> {
  const admittedBySession = new Map<string, boolean>();
  const result: RuntimeRunStatus[] = [];
  for (const status of statuses) {
    let admitted = admittedBySession.get(status.sessionId);
    if (admitted === undefined) {
      admitted = await admission.admitsSession(status.sessionId);
      admittedBySession.set(status.sessionId, admitted);
    }
    if (admitted) result.push(status);
  }
  return result;
}

function isPartnerSessionIdentity(
  surface: string | undefined,
  profileId: string | undefined,
): boolean {
  const hasPartnerToken = (value: string | undefined): boolean =>
    value
      ?.toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes("partner") === true;
  return hasPartnerToken(surface) || hasPartnerToken(profileId);
}

function createRuntimeTranscriptRevision(
  transcript: RuntimeTranscript | null,
): string {
  return transcript === null
    ? createRuntimeTranscriptRevisionFromSerialized("null")
    : createRuntimeTranscriptEntriesRevision(transcript.transcriptEntries);
}

function createRuntimeTranscriptEntriesRevision(
  entries: readonly SessionTranscriptEntry[],
  visit?: (entry: SessionTranscriptEntry, encoded: Buffer) => void,
): string {
  return createRuntimeHistoryEntriesRevision(
    entries,
    "kodax-transcript-entries-v1\0",
    "",
    visit,
  );
}

function createRuntimeHistoryEntriesRevision<TEntry>(
  entries: readonly TEntry[],
  domain: string,
  context: string,
  visit?: (entry: TEntry, encoded: Buffer) => void,
): string {
  const hash = createHash("sha256");
  hash.update(domain);
  if (context.length > 0) {
    hash.update(`${Buffer.byteLength(context, "utf8")}:`);
    hash.update(context);
  }
  for (const entry of entries) {
    const encoded = Buffer.from(JSON.stringify(entry), "utf8");
    hash.update(`${encoded.length}:`);
    hash.update(encoded);
    visit?.(entry, encoded);
  }
  return `sha256:${hash.digest("hex")}`;
}

function runtimeConversationRevisionContext(
  history: SessionConversationHistoryData,
): string {
  return JSON.stringify({
    sourceRevision: history.sourceRevision,
    status: history.status,
    issues: history.issues,
  });
}

function createRuntimeConversationHistoryRevision(
  history: SessionConversationHistoryData,
): string {
  return replApi.createSessionConversationHistoryRevision(history);
}

function createRuntimeTranscriptRevisionFromSerialized(
  serialized: string,
): string {
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

type RuntimeHistorySnapshotViewKind = "transcript" | "conversation";
type RuntimeHistorySnapshotEntry =
  | SessionTranscriptEntry
  | SessionConversationHistoryEntry;

interface RuntimeConversationSnapshotMetadata {
  readonly sourceRevision: string;
  readonly status: SessionConversationHistoryStatus;
  readonly issues: readonly SessionConversationHistoryIssue[];
  readonly boundaryRevision: string;
}

function runtimeHistoryEntryDescriptorIdentity(
  entry: RuntimeHistorySnapshotEntry,
): { readonly entryId?: string; readonly boundaryId?: string } {
  if ("entryId" in entry && typeof entry.entryId === "string") {
    return { entryId: entry.entryId };
  }
  return "boundaryId" in entry && typeof entry.boundaryId === "string"
    ? { boundaryId: entry.boundaryId }
    : {};
}

interface RuntimeTranscriptPageCursor {
  readonly kind: "page";
  readonly view: RuntimeHistorySnapshotViewKind;
  readonly revision: string;
  readonly end: number;
}

interface RuntimeConversationCachePageCursor {
  readonly kind: "conversation_cache_page";
  readonly view: "conversation";
  readonly revision: string;
  readonly end: number;
}

interface RuntimeTranscriptChunkCursor {
  readonly kind: "entry";
  readonly view: RuntimeHistorySnapshotViewKind;
  readonly revision: string;
  readonly entryIndex: number;
  readonly offset: number;
}

interface RuntimeTranscriptSnapshotEntryDescriptor {
  readonly offset: number;
  readonly byteLength: number;
  readonly chunkDigests: readonly string[];
  readonly entryId?: string;
  readonly boundaryId?: string;
}

interface RuntimeTranscriptSnapshotView {
  readonly view: RuntimeHistorySnapshotViewKind;
  readonly revision: string;
  readonly sourceRevision: string;
  readonly filePath: string;
  readonly entries: readonly RuntimeTranscriptSnapshotEntryDescriptor[];
  readonly conversation?: RuntimeConversationSnapshotMetadata;
}

function encodeRuntimeTranscriptCursor(
  cursor:
    | RuntimeTranscriptPageCursor
    | RuntimeConversationCachePageCursor
    | RuntimeTranscriptChunkCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRuntimeTranscriptCursor(
  cursor: string,
):
  | RuntimeTranscriptPageCursor
  | RuntimeConversationCachePageCursor
  | RuntimeTranscriptChunkCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error: unknown) {
    throw createRuntimeResyncError(
      `Invalid transcript cursor: ${normalizeError(error).message}`,
    );
  }
  if (!isRecord(value) || typeof value.revision !== "string") {
    throw createRuntimeResyncError("Invalid transcript cursor payload");
  }
  const view = value.view === undefined || value.view === "transcript"
    ? "transcript"
    : value.view === "conversation"
      ? "conversation"
      : undefined;
  if (view === undefined) {
    throw createRuntimeResyncError("Invalid transcript cursor view");
  }
  if (
    value.kind === "conversation_cache_page"
    && view === "conversation"
    && Number.isSafeInteger(value.end)
    && Number(value.end) >= 0
  ) {
    return {
      kind: "conversation_cache_page",
      view,
      revision: value.revision,
      end: Number(value.end),
    };
  }
  if (
    value.kind === "page" &&
    Number.isSafeInteger(value.end) &&
    Number(value.end) >= 0
  ) {
    return {
      kind: "page",
      view,
      revision: value.revision,
      end: Number(value.end),
    };
  }
  if (
    value.kind === "entry" &&
    Number.isSafeInteger(value.entryIndex) &&
    Number(value.entryIndex) >= 0 &&
    Number.isSafeInteger(value.offset) &&
    Number(value.offset) >= 0
  ) {
    return {
      kind: "entry",
      view,
      revision: value.revision,
      entryIndex: Number(value.entryIndex),
      offset: Number(value.offset),
    };
  }
  throw createRuntimeResyncError("Invalid transcript cursor payload");
}

async function createRuntimeTranscriptSlice(
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
  cursor?: string,
  requestedLimit?: number,
): Promise<RuntimeTranscriptSlice> {
  if (snapshot.view !== "transcript") {
    throw createRuntimeResyncError("Transcript snapshot view does not match the request");
  }
  const slice = await createRuntimeHistorySlice(
    snapshot,
    budget,
    cursor,
    requestedLimit,
  );
  return {
    revision: snapshot.revision,
    entries: slice.entries.map((item): RuntimeTranscriptSliceEntry => ({
      index: item.index,
      ...(item.entryId !== undefined ? { entryId: item.entryId } : {}),
      byteLength: item.byteLength,
      oversized: item.oversized,
      ...(item.entry !== undefined
        ? { entry: item.entry as SessionTranscriptEntry }
        : {}),
    })),
    hasMore: slice.hasMore,
    ...(slice.nextCursor !== undefined ? { nextCursor: slice.nextCursor } : {}),
  };
}

interface RuntimeHistorySliceItem {
  readonly index: number;
  readonly entryId?: string;
  readonly boundaryId?: string;
  readonly byteLength: number;
  readonly oversized: boolean;
  readonly entry?: RuntimeHistorySnapshotEntry;
}

interface RuntimeHistorySlice {
  readonly entries: readonly RuntimeHistorySliceItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

async function createRuntimeHistorySlice(
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
  cursor?: string,
  requestedLimit?: number,
  reservedBytes = 0,
): Promise<RuntimeHistorySlice> {
  const limit = requestedLimit ?? DEFAULT_RUNTIME_TRANSCRIPT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("transcript page limit must be a positive safe integer");
  }
  const normalizedLimit = Math.min(limit, MAX_RUNTIME_TRANSCRIPT_PAGE_LIMIT);
  if (reservedBytes > MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES) {
    throw createRuntimeHistoryPageCapacityError();
  }
  let end = snapshot.entries.length;
  if (cursor !== undefined) {
    const parsed = decodeRuntimeTranscriptCursor(cursor);
    if (
      parsed.kind !== "page"
      || parsed.revision !== snapshot.revision
      || parsed.view !== snapshot.view
    ) {
      throw createRuntimeResyncError(
        "Transcript cursor is stale; request a fresh observation snapshot",
      );
    }
    end = Math.min(parsed.end, snapshot.entries.length);
  }

  const entries: RuntimeHistorySliceItem[] = [];
  let encodedBytes = reservedBytes;
  let start = end;
  for (let index = end - 1; index >= 0; index -= 1) {
    sessionReadOptionsFromBudget(budget);
    if (entries.length >= normalizedLimit) break;
    const descriptor = snapshot.entries[index]!;
    const byteLength = descriptor.byteLength;
    const entry = byteLength <= MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES
      ? await parseRuntimeTranscriptSnapshotEntry(
          snapshot,
          descriptor,
          budget,
        )
      : undefined;
    const item: RuntimeHistorySliceItem = {
      index,
      ...(descriptor.entryId !== undefined
        ? { entryId: descriptor.entryId }
        : {}),
      ...(descriptor.boundaryId !== undefined
        ? { boundaryId: descriptor.boundaryId }
        : {}),
      byteLength,
      oversized: byteLength > MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES,
      ...(entry !== undefined ? { entry } : {}),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (encodedBytes + itemBytes > MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES) {
      if (entries.length === 0) throw createRuntimeHistoryPageCapacityError();
      break;
    }
    entries.unshift(item);
    encodedBytes += itemBytes;
    start = index;
  }
  sessionReadOptionsFromBudget(budget);
  const hasMore = start > 0;
  return {
    entries,
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeRuntimeTranscriptCursor({
            kind: "page",
            view: snapshot.view,
            revision: snapshot.revision,
            end: start,
          }),
        }
      : {}),
  };
}

async function createRuntimeConversationHistorySlice(
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
  cursor?: string,
  requestedLimit?: number,
): Promise<RuntimeConversationHistorySlice> {
  if (snapshot.view !== "conversation" || snapshot.conversation === undefined) {
    throw createRuntimeResyncError("Conversation snapshot view does not match the request");
  }
  const slice = await createRuntimeHistorySlice(
    snapshot,
    budget,
    cursor,
    requestedLimit,
    Buffer.byteLength(JSON.stringify({
      revision: snapshot.revision,
      sourceRevision: snapshot.conversation.sourceRevision,
      status: snapshot.conversation.status,
      issues: snapshot.conversation.issues,
    }), "utf8"),
  );
  return {
    revision: snapshot.revision,
    sourceRevision: snapshot.conversation.sourceRevision,
    status: snapshot.conversation.status,
    issues: structuredClone(snapshot.conversation.issues),
    entries: slice.entries.map((item): RuntimeConversationHistorySliceEntry => ({
      index: item.index,
      ...(item.boundaryId !== undefined ? { boundaryId: item.boundaryId } : {}),
      byteLength: item.byteLength,
      oversized: item.oversized,
      ...(item.entry !== undefined
        ? { entry: item.entry as SessionConversationHistoryEntry }
        : {}),
    })),
    hasMore: slice.hasMore,
    ...(slice.nextCursor !== undefined ? { nextCursor: slice.nextCursor } : {}),
  };
}

async function createRuntimeTranscriptEntryChunkFromSnapshot(
  input: RuntimeTranscriptEntryChunkInput,
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
): Promise<RuntimeTranscriptEntryChunk> {
  if (snapshot.view !== "transcript") {
    throw createRuntimeResyncError("Transcript snapshot view does not match the request");
  }
  const chunk = await createRuntimeHistoryEntryChunkFromSnapshot(
    input,
    snapshot,
    budget,
  );
  return {
    revision: chunk.revision,
    entryIndex: chunk.entryIndex,
    ...(chunk.entryId !== undefined ? { entryId: chunk.entryId } : {}),
    encoding: "base64-json",
    data: chunk.data,
    hasMore: chunk.hasMore,
    ...(chunk.nextCursor !== undefined ? { nextCursor: chunk.nextCursor } : {}),
  };
}

interface RuntimeHistoryEntryChunkInput {
  readonly revision: string;
  readonly entryIndex: number;
  readonly cursor?: string;
}

interface RuntimeHistoryEntryChunk {
  readonly revision: string;
  readonly entryIndex: number;
  readonly entryId?: string;
  readonly boundaryId?: string;
  readonly data: string;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

async function createRuntimeHistoryEntryChunkFromSnapshot(
  input: RuntimeHistoryEntryChunkInput,
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
): Promise<RuntimeHistoryEntryChunk> {
  if (input.revision !== snapshot.revision) {
    throw createRuntimeResyncError(
      "Transcript revision changed; request a fresh observation snapshot",
    );
  }
  const descriptor = snapshot.entries[input.entryIndex];
  if (descriptor === undefined) {
    throw new Error(
      `Transcript entry index is out of range: ${input.entryIndex}`,
    );
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    const parsed = decodeRuntimeTranscriptCursor(input.cursor);
    if (
      parsed.kind !== "entry" ||
      parsed.revision !== snapshot.revision ||
      parsed.view !== snapshot.view ||
      parsed.entryIndex !== input.entryIndex
    ) {
      throw createRuntimeResyncError(
        "Transcript entry cursor is stale; restart entry retrieval",
      );
    }
    offset = parsed.offset;
  }
  if (offset > descriptor.byteLength) {
    throw createRuntimeResyncError("Transcript entry cursor offset is invalid");
  }
  if (offset % MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES !== 0) {
    throw createRuntimeResyncError("Transcript entry cursor offset is invalid");
  }
  const nextOffset = Math.min(
    descriptor.byteLength,
    offset + MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES,
  );
  const encoded = await readRuntimeTranscriptSnapshotBytes(
    snapshot.filePath,
    descriptor.offset + offset,
    nextOffset - offset,
    budget,
  );
  assertRuntimeTranscriptSnapshotDigest(
    encoded,
    descriptor.chunkDigests[offset / MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES],
  );
  sessionReadOptionsFromBudget(budget);
  const hasMore = nextOffset < descriptor.byteLength;
  return {
    revision: snapshot.revision,
    entryIndex: input.entryIndex,
    ...(descriptor.entryId !== undefined
      ? { entryId: descriptor.entryId }
      : {}),
    ...(descriptor.boundaryId !== undefined
      ? { boundaryId: descriptor.boundaryId }
      : {}),
    data: encoded.toString("base64"),
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeRuntimeTranscriptCursor({
            kind: "entry",
            view: snapshot.view,
            revision: snapshot.revision,
            entryIndex: input.entryIndex,
            offset: nextOffset,
          }),
        }
      : {}),
  };
}

async function createRuntimeConversationEntryChunkFromSnapshot(
  input: RuntimeConversationHistoryEntryChunkInput,
  snapshot: RuntimeTranscriptSnapshotView,
  budget: RuntimeReadBudget,
): Promise<RuntimeConversationHistoryEntryChunk> {
  if (snapshot.view !== "conversation") {
    throw createRuntimeResyncError("Conversation snapshot view does not match the request");
  }
  const chunk = await createRuntimeHistoryEntryChunkFromSnapshot(
    input,
    snapshot,
    budget,
  );
  return {
    revision: chunk.revision,
    entryIndex: chunk.entryIndex,
    ...(chunk.boundaryId !== undefined ? { boundaryId: chunk.boundaryId } : {}),
    encoding: "base64-json",
    data: chunk.data,
    hasMore: chunk.hasMore,
    ...(chunk.nextCursor !== undefined ? { nextCursor: chunk.nextCursor } : {}),
  };
}

async function parseRuntimeTranscriptSnapshotEntry(
  snapshot: RuntimeTranscriptSnapshotView,
  descriptor: RuntimeTranscriptSnapshotEntryDescriptor,
  budget: RuntimeReadBudget,
): Promise<RuntimeHistorySnapshotEntry> {
  const encoded = await readRuntimeTranscriptSnapshotBytes(
    snapshot.filePath,
    descriptor.offset,
    descriptor.byteLength,
    budget,
  );
  assertRuntimeTranscriptSnapshotDigest(encoded, descriptor.chunkDigests[0]);
  try {
    return JSON.parse(encoded.toString("utf8")) as RuntimeHistorySnapshotEntry;
  } catch (error: unknown) {
    throw createRuntimeTranscriptSnapshotInvalidError(
      `Transcript snapshot entry is corrupt: ${normalizeError(error).message}`,
    );
  }
}

async function readRuntimeTranscriptSnapshotBytes(
  filePath: string,
  offset: number,
  length: number,
  budget: RuntimeReadBudget,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    let read = 0;
    while (read < length) {
      const result = await handle.read(
        buffer,
        read,
        length - read,
        offset + read,
      );
      if (result.bytesRead === 0) {
        throw new Error("Transcript snapshot ended unexpectedly.");
      }
      read += result.bytesRead;
      sessionReadOptionsFromBudget(budget);
    }
    return buffer;
  } catch (error: unknown) {
    if (isExpectedRuntimeReadTermination(error)) throw error;
    throw createRuntimeTranscriptSnapshotInvalidError(
      `Transcript snapshot is unavailable: ${normalizeError(error).message}`,
    );
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function writeFileHandleFully(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(
      buffer,
      written,
      buffer.length - written,
      null,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Transcript snapshot write made no progress.");
    }
    written += result.bytesWritten;
  }
}

function isExpectedRuntimeReadTermination(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "read_timeout" || error.code === "read_cancelled";
}

function assertRuntimeTranscriptSnapshotDigest(
  encoded: Buffer,
  expected: string | undefined,
): void {
  const actual = createHash("sha256").update(encoded).digest("hex");
  if (expected === undefined || actual !== expected) {
    throw createRuntimeTranscriptSnapshotInvalidError(
      "Transcript snapshot integrity check failed; request a fresh boundary",
    );
  }
}

function previewQueuedInput(prompt: string): string {
  return prompt.length <= MAX_RUNTIME_INPUT_PREVIEW_LENGTH
    ? prompt
    : `${prompt.slice(0, MAX_RUNTIME_INPUT_PREVIEW_LENGTH - 1)}…`;
}

function assertSessionSettingsAllowed(
  session: KodaXSessionData,
  settings: RuntimeSessionSettings,
): void {
  if (settings.executionCwd === undefined) return;
  const root = session.runtimeInfo?.workspaceRoot ?? session.gitRoot;
  if (!root) return;
  assertPathWithinRoot(settings.executionCwd, root, "executionCwd");
}

function assertPathWithinRoot(
  candidate: string,
  root: string,
  label: string,
): void {
  if (isPathInsideDirectory(candidate, root)) return;
  throw new Error(`${label} must stay within the session workspace root`);
}

function applySessionSettingsPatch(
  current: RuntimeSessionSettings,
  patch: RuntimeSessionSettingsPatch,
): RuntimeSessionSettings {
  const next: RuntimeSessionSettings = { ...current };
  applyNullableStringPatch(next, "provider", patch.provider);
  applyNullableStringPatch(next, "model", patch.model);
  applyNullableStringPatch(next, "permissionMode", patch.permissionMode);
  applyNullableStringPatch(next, "executionCwd", patch.executionCwd, true);
  applyNullableShellExecutionPatch(next, patch.shellExecution);
  applyNullableStringPatch(
    next,
    "autoModeClassifierModel",
    patch.autoModeClassifierModel,
  );
  applyNullablePatch(next, "effort", patch.effort);
  applyNullablePatch(next, "thinking", patch.thinking);
  applyNullablePatch(next, "reasoningMode", patch.reasoningMode);
  applyNullablePatch(next, "agentMode", patch.agentMode);
  applyNullablePatch(next, "autoModeEngine", patch.autoModeEngine);
  applyNullablePositiveIntegerPatch(
    next,
    "autoModeTimeoutMs",
    patch.autoModeTimeoutMs,
  );
  applyNullableNonNegativeIntegerPatch(
    next,
    "autoModeSpeculativeWindowMs",
    patch.autoModeSpeculativeWindowMs,
  );
  applyNullableCompactionPercentPatch(next, patch.compactionTriggerPercent);
  applyNullableCompactionTokensPatch(next, patch.compactionTriggerTokens);
  return next;
}

function applyNullableCompactionPercentPatch(
  target: RuntimeSessionSettings,
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, "compactionTriggerPercent");
    return;
  }
  if (!Number.isFinite(value)) {
    throw new Error("compactionTriggerPercent must be a finite number");
  }
  setMutableSetting(
    target,
    "compactionTriggerPercent",
    normalizeCompactionConfig({ triggerPercent: value }).triggerPercent,
  );
}

function applyNullableShellExecutionPatch(
  target: RuntimeSessionSettings,
  value: KodaXShellExecutionContract | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, "shellExecution");
    return;
  }
  setMutableSetting(
    target,
    "shellExecution",
    normalizeShellExecutionContract(value),
  );
}

function applyNullableCompactionTokensPatch(
  target: RuntimeSessionSettings,
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value === 0) {
    deleteMutableSetting(target, "compactionTriggerTokens");
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "compactionTriggerTokens must be a positive safe integer or zero",
    );
  }
  setMutableSetting(target, "compactionTriggerTokens", value);
}

type RuntimeStringSettingKey =
  | "provider"
  | "model"
  | "permissionMode"
  | "executionCwd"
  | "autoModeClassifierModel";

function applyNullablePositiveIntegerPatch(
  target: RuntimeSessionSettings,
  key: "autoModeTimeoutMs",
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, key);
    return;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  setMutableSetting(target, key, value);
}

function applyNullableNonNegativeIntegerPatch(
  target: RuntimeSessionSettings,
  key: "autoModeSpeculativeWindowMs",
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    deleteMutableSetting(target, key);
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative safe integer`);
  }
  setMutableSetting(target, key, value);
}

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
  const normalized =
    key === "autoModeClassifierModel"
      ? validateRuntimeAutoModeClassifierModel(value)
      : value;
  setMutableSetting(
    target,
    key,
    normalized as RuntimeSessionSettings[typeof key],
  );
}

function validateRuntimeAutoModeClassifierModel(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RuntimeAutoModeConfigurationError(
      "autoModeClassifierModel must be a non-empty classifier model spec.",
    );
  }
  try {
    parseModelSpec(normalized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeAutoModeConfigurationError(
      `autoModeClassifierModel must be a valid classifier model spec: ${detail}`,
    );
  }
  return normalized;
}

function runtimeAutoModeClassifierModelError(
  settings: RuntimeSessionSettings,
  model: string | undefined,
): RuntimeAutoModeConfigurationError | undefined {
  if (
    replApi.normalizePermissionMode(settings.permissionMode) !== "auto" ||
    (settings.autoModeEngine ?? "llm") !== "llm"
  ) {
    return undefined;
  }
  if (settings.autoModeClassifierModel !== undefined) {
    try {
      validateRuntimeAutoModeClassifierModel(settings.autoModeClassifierModel);
    } catch (error) {
      return error instanceof RuntimeAutoModeConfigurationError
        ? error
        : new RuntimeAutoModeConfigurationError(
            "Auto LLM classifier model configuration is invalid.",
          );
    }
    return undefined;
  }
  if (model?.trim().length) return undefined;
  return new RuntimeAutoModeConfigurationError(
    "Auto LLM requires a classifier model. Set autoModeClassifierModel, the Session/run model, or runtime defaultModel.",
  );
}

function assertRuntimeAutoModeClassifierModelConfigured(
  settings: RuntimeSessionSettings,
  model: string | undefined,
): void {
  const error = runtimeAutoModeClassifierModelError(settings, model);
  if (error) throw error;
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
  (
    target as {
      -readonly [P in keyof RuntimeSessionSettings]: RuntimeSessionSettings[P];
    }
  )[key] = value;
}

function deleteMutableSetting<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
): void {
  delete (
    target as {
      -readonly [P in keyof RuntimeSessionSettings]?: RuntimeSessionSettings[P];
    }
  )[key];
}

function parseRuntimeSessionSettings(value: unknown): RuntimeSessionSettings {
  if (!isRecord(value)) return {};
  const settings: RuntimeSessionSettings = {};
  setStringIfPresent(settings, "provider", value.provider);
  setStringIfPresent(settings, "model", value.model);
  setStringIfPresent(settings, "permissionMode", value.permissionMode);
  setStringIfPresent(settings, "executionCwd", value.executionCwd);
  if (value.shellExecution !== undefined) {
    setMutableSetting(
      settings,
      "shellExecution",
      normalizeShellExecutionContract(value.shellExecution),
    );
  }
  setStringIfPresent(
    settings,
    "autoModeClassifierModel",
    value.autoModeClassifierModel,
  );
  setStringIfPresent(settings, "effort", value.effort);
  if (typeof value.thinking === "boolean") {
    setMutableSetting(settings, "thinking", value.thinking);
  }
  setStringIfPresent(settings, "reasoningMode", value.reasoningMode);
  setStringIfPresent(settings, "agentMode", value.agentMode);
  if (value.autoModeEngine === "llm" || value.autoModeEngine === "rules") {
    setMutableSetting(settings, "autoModeEngine", value.autoModeEngine);
  }
  if (
    Number.isSafeInteger(value.autoModeTimeoutMs) &&
    Number(value.autoModeTimeoutMs) > 0
  ) {
    setMutableSetting(
      settings,
      "autoModeTimeoutMs",
      Number(value.autoModeTimeoutMs),
    );
  }
  if (
    Number.isSafeInteger(value.autoModeSpeculativeWindowMs) &&
    Number(value.autoModeSpeculativeWindowMs) >= 0
  ) {
    setMutableSetting(
      settings,
      "autoModeSpeculativeWindowMs",
      Number(value.autoModeSpeculativeWindowMs),
    );
  }
  if (typeof value.compactionTriggerPercent === "number") {
    applyNullableCompactionPercentPatch(
      settings,
      value.compactionTriggerPercent,
    );
  }
  if (
    Number.isSafeInteger(value.compactionTriggerTokens) &&
    Number(value.compactionTriggerTokens) > 0
  ) {
    setMutableSetting(
      settings,
      "compactionTriggerTokens",
      Number(value.compactionTriggerTokens),
    );
  }
  return settings;
}

function parseRuntimePermissionGrant(value: unknown): RuntimePermissionGrant {
  if (!isRecord(value) || !isRecord(value.scope)) {
    throw new Error("invalid permission grant");
  }
  const toolName = value.scope.toolName;
  const sessionId = value.scope.sessionId;
  const matcher = value.scope.matcher;
  const persistence = value.persistence;
  const label = value.label;
  const sourcePermissionId = value.sourcePermissionId;
  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    (toolName !== undefined && typeof toolName !== "string") ||
    (sessionId !== undefined && typeof sessionId !== "string") ||
    (persistence !== undefined &&
      persistence !== "session" &&
      persistence !== "persistent") ||
    (label !== undefined && typeof label !== "string") ||
    (sourcePermissionId !== undefined && typeof sourcePermissionId !== "string")
  ) {
    throw new Error("invalid permission grant");
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    persistence: persistence ?? "persistent",
    ...(label !== undefined ? { label } : {}),
    ...(sourcePermissionId !== undefined ? { sourcePermissionId } : {}),
    scope: {
      ...(toolName !== undefined ? { toolName } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(matcher !== undefined
        ? { matcher: parseRuntimePermissionMatcher(matcher) }
        : {}),
    },
  };
}

function setStringIfPresent<K extends keyof RuntimeSessionSettings>(
  target: RuntimeSessionSettings,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    setMutableSetting(target, key, value as RuntimeSessionSettings[K]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
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
      throw new Error(
        `runtime.config.patch does not support config key: ${key}`,
      );
    }
  }
  return patch as RuntimeConfigPatch;
}

function resolveRuntimeConfigFile(
  options: CreateKodaXRuntimeOptions,
): string | undefined {
  if (options.homeDir === undefined) return undefined;
  return path.join(path.resolve(options.homeDir), ".kodax", "config.json");
}

function readRuntimeConfig(
  configFile: string | undefined,
): Record<string, unknown> {
  if (configFile === undefined) {
    return loadConfig() as unknown as Record<string, unknown>;
  }
  if (!fs.existsSync(configFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function patchRuntimeConfig(
  configFile: string | undefined,
  patch: RuntimeConfigPatch,
): void {
  if (configFile === undefined) {
    saveConfig(patch);
    return;
  }
  mutateRuntimeConfig(configFile, (current) => {
    const merged: Record<string, unknown> = { ...current, ...patch };
    for (const key of Object.keys(patch) as Array<keyof RuntimeConfigPatch>) {
      if (patch[key] === undefined) delete merged[key];
    }
    return { config: merged, result: undefined };
  });
}

function writeRuntimeConfigUnlocked(
  configFile: string,
  config: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function mutateRuntimeConfig<T>(
  configFile: string,
  mutation: (current: Record<string, unknown>) => {
    readonly config?: Record<string, unknown>;
    readonly result: T;
  },
): T {
  return withCoreConfigWriteLock(configFile, () => {
    const next = mutation(readRuntimeConfig(configFile));
    if (next.config) writeRuntimeConfigUnlocked(configFile, next.config);
    return next.result;
  });
}

function listRuntimeCustomProviders(
  configFile: string | undefined,
): readonly KodaXCustomProviderConfig[] {
  if (configFile === undefined) return listCustomProviders();
  return cloneCustomProviders(
    extractRuntimeCustomProviders(readRuntimeConfig(configFile)),
  );
}

function upsertRuntimeCustomProvider(
  configFile: string | undefined,
  config: KodaXCustomProviderConfig,
): KodaXCustomProviderConfig {
  if (configFile === undefined) return upsertCustomProvider(config);
  validateCustomProviderConfig(config);
  const next = mutateRuntimeConfig(configFile, (whole) => {
    const providers = upsertConfigEntry(
      extractRuntimeCustomProviders(whole),
      config,
      (item) => item.name === config.name,
    );
    return {
      config: { ...whole, customProviders: providers },
      result: providers,
    };
  });
  registerCustomProviders(next);
  return structuredClone(config);
}

function removeRuntimeCustomProvider(
  configFile: string | undefined,
  name: string,
): boolean {
  if (configFile === undefined) return removeCustomProvider(name);
  if (typeof name !== "string" || name.length === 0) return false;
  const next = mutateRuntimeConfig(configFile, (whole) => {
    const existing = extractRuntimeCustomProviders(whole);
    const providers = existing.filter((provider) => provider.name !== name);
    return providers.length === existing.length
      ? { result: undefined }
      : {
          config: { ...whole, customProviders: providers },
          result: providers,
        };
  });
  if (!next) return false;
  registerCustomProviders(next);
  return true;
}

function registerRuntimeConfiguredCustomProviders(
  configFile: string | undefined,
): void {
  if (configFile === undefined) return;
  registerCustomProviders(
    extractRuntimeCustomProviders(readRuntimeConfig(configFile)),
  );
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

function listRuntimeMcpServers(
  configFile: string | undefined,
): Record<string, McpServerConfig> {
  if (configFile === undefined) return listMcpServers();
  return cloneMcpServers(
    extractRuntimeMcpServers(readRuntimeConfig(configFile)),
  );
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
  mutateRuntimeConfig(configFile, (whole) => {
    const servers = {
      ...extractRuntimeMcpServers(whole),
      [name]: structuredClone(config),
    };
    return { config: { ...whole, mcpServers: servers }, result: undefined };
  });
  return structuredClone(config);
}

function removeRuntimeMcpServer(
  configFile: string | undefined,
  name: string,
): boolean {
  if (configFile === undefined) return removeMcpServer(name);
  return mutateRuntimeConfig(configFile, (whole) => {
    const servers = extractRuntimeMcpServers(whole);
    if (!(name in servers)) return { result: false };
    const next = { ...servers };
    delete next[name];
    return { config: { ...whole, mcpServers: next }, result: true };
  });
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
  return entries.map((entry, index) =>
    index === existingIndex ? structuredClone(next) : structuredClone(entry),
  );
}

function listRuntimeModels(
  providerList: unknown,
  filter: RuntimeModelListFilter | undefined,
): unknown {
  const providers = Array.isArray(providerList) ? providerList : [];
  if (filter?.provider !== undefined) {
    const provider = providers.find(
      (item) => isRecord(item) && item.name === filter.provider,
    );
    if (!isRecord(provider)) {
      return { provider: filter.provider, models: [] };
    }
    return {
      provider: filter.provider,
      models: Array.isArray(provider.models) ? provider.models : [],
    };
  }
  return providers.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    return [
      {
        provider: item.name,
        models: Array.isArray(item.models) ? item.models : [],
      },
    ];
  });
}

function listRuntimeCommands(
  projectRoot?: string,
): readonly RuntimeCommandInfo[] {
  const registeredCommands = listReplCommands(projectRoot).map(
    replCommandToRuntimeCommandInfo,
  );
  const extensionCommands =
    getActiveExtensionRuntime()
      ?.listCommands()
      .filter(
        (command: ExtensionCommandDefinition) =>
          command.metadata?.userInvocable !== false,
      )
      .map(extensionCommandToRuntimeCommandInfo) ?? [];
  return [...registeredCommands, ...extensionCommands].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function listReplCommands(projectRoot?: string): readonly ReplCommandInfo[] {
  const commandCatalogApi = replApi as typeof replApi & {
    readonly listRegisteredCommands?: (
      projectRoot?: string,
    ) => readonly ReplCommandInfo[];
  };
  if (typeof commandCatalogApi.listRegisteredCommands === "function") {
    return commandCatalogApi.listRegisteredCommands(projectRoot);
  }
  return replApi.getCommandRegistry().getAll();
}

function replCommandToRuntimeCommandInfo(
  command: ReplCommandInfo,
): RuntimeCommandInfo {
  return {
    name: command.name,
    ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
    description: command.description,
    source: command.source,
    ...(command.usage !== undefined ? { usage: command.usage } : {}),
    ...(command.argumentHint !== undefined
      ? { argumentHint: command.argumentHint }
      : {}),
    ...(command.location !== undefined ? { location: command.location } : {}),
    ...(command.path !== undefined ? { path: command.path } : {}),
    ...(command.userInvocable !== undefined
      ? { userInvocable: command.userInvocable }
      : {}),
    ...(command.disableModelInvocation !== undefined
      ? { disableModelInvocation: command.disableModelInvocation }
      : {}),
    ...(command.allowedTools !== undefined
      ? { allowedTools: command.allowedTools }
      : {}),
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
    source: "extension",
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
      isSensitiveConfigKey(key) ? "[redacted]" : redactRuntimeConfig(item),
    ]),
  );
}

function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower === "key" ||
    lower.endsWith("key") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password")
  );
}

function toRuntimeSkillSummary(skill: SkillMetadata): RuntimeSkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable,
    ...(skill.argumentHint !== undefined
      ? { argumentHint: skill.argumentHint }
      : {}),
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
    ...(skill.argumentHint !== undefined
      ? { argumentHint: skill.argumentHint }
      : {}),
    path: skill.path,
    source: skill.source,
    disableModelInvocation: skill.disableModelInvocation ?? false,
    content: skill.content,
    skillFilePath: skill.skillFilePath,
    ...(skill.scripts !== undefined
      ? { scripts: skill.scripts.map(toRuntimeSkillFileSummary) }
      : {}),
    ...(skill.references !== undefined
      ? { references: skill.references.map(toRuntimeSkillFileSummary) }
      : {}),
    ...(skill.assets !== undefined
      ? { assets: skill.assets.map(toRuntimeSkillFileSummary) }
      : {}),
    ...(skill.templates !== undefined
      ? { templates: skill.templates.map(toRuntimeSkillFileSummary) }
      : {}),
    ...(skill.resources !== undefined
      ? { resources: skill.resources.map(toRuntimeSkillFileSummary) }
      : {}),
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
    throw new Error("Invalid runtime daemon response: expected object");
  }
  return value;
}

function parseRuntimeIdentity(value: unknown): RuntimeIdentity {
  const record = requireRuntimeRecord(value);
  if (
    typeof record.runtimeId !== "string" ||
    typeof record.mode !== "string" ||
    typeof record.profile !== "string" ||
    typeof record.startedAt !== "string" ||
    typeof record.version !== "string"
  ) {
    throw new Error("Invalid runtime daemon response: missing identity fields");
  }
  return {
    runtimeId: record.runtimeId,
    mode: record.mode === "daemon" ? "daemon" : "embedded",
    profile: record.profile,
    startedAt: record.startedAt,
    version: record.version,
    ...(record.isolation === "inline" ||
    record.isolation === "worker" ||
    record.isolation === "process"
      ? { isolation: record.isolation }
      : {}),
    ...(typeof record.workerThreadId === "number"
      ? { workerThreadId: record.workerThreadId }
      : {}),
  };
}

function serializeSessionSettings(
  settings: RuntimeSessionSettings,
): RuntimeSessionSettings {
  const result: RuntimeSessionSettings = {};
  if (settings.provider !== undefined)
    setMutableSetting(result, "provider", settings.provider);
  if (settings.model !== undefined)
    setMutableSetting(result, "model", settings.model);
  if (settings.effort !== undefined)
    setMutableSetting(result, "effort", settings.effort);
  if (settings.thinking !== undefined)
    setMutableSetting(result, "thinking", settings.thinking);
  if (settings.reasoningMode !== undefined)
    setMutableSetting(result, "reasoningMode", settings.reasoningMode);
  if (settings.permissionMode !== undefined)
    setMutableSetting(result, "permissionMode", settings.permissionMode);
  if (settings.executionCwd !== undefined)
    setMutableSetting(result, "executionCwd", settings.executionCwd);
  if (settings.shellExecution !== undefined) {
    setMutableSetting(
      result,
      "shellExecution",
      normalizeShellExecutionContract(settings.shellExecution),
    );
  }
  if (settings.agentMode !== undefined)
    setMutableSetting(result, "agentMode", settings.agentMode);
  if (settings.autoModeEngine !== undefined)
    setMutableSetting(result, "autoModeEngine", settings.autoModeEngine);
  if (settings.autoModeClassifierModel !== undefined) {
    setMutableSetting(
      result,
      "autoModeClassifierModel",
      settings.autoModeClassifierModel,
    );
  }
  if (settings.autoModeTimeoutMs !== undefined) {
    setMutableSetting(result, "autoModeTimeoutMs", settings.autoModeTimeoutMs);
  }
  if (settings.autoModeSpeculativeWindowMs !== undefined) {
    setMutableSetting(
      result,
      "autoModeSpeculativeWindowMs",
      settings.autoModeSpeculativeWindowMs,
    );
  }
  if (settings.compactionTriggerPercent !== undefined) {
    setMutableSetting(
      result,
      "compactionTriggerPercent",
      settings.compactionTriggerPercent,
    );
  }
  if (settings.compactionTriggerTokens !== undefined) {
    setMutableSetting(
      result,
      "compactionTriggerTokens",
      settings.compactionTriggerTokens,
    );
  }
  return result;
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function createInputId(): string {
  return `input_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function runtimeInterruptInputStatus(
  input: RuntimeInterruptInputRecord,
): RuntimeInterruptInputStatus {
  return {
    inputId: input.inputId,
    afterRunId: input.afterRunId,
    delivery: input.delivery,
    state: input.state,
    contentPreview: input.contentPreview,
    queuedAt: input.queuedAt,
    ...(input.deliveredAt !== undefined
      ? { deliveredAt: input.deliveredAt }
      : {}),
    ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
  };
}

function statusFromRecord(run: RuntimeRunRecord): RuntimeRunStatus {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    phase: run.phase,
    ...(run.stage !== undefined ? { stage: run.stage } : {}),
    ...(run.stageChangedAt !== undefined
      ? { stageChangedAt: run.stageChangedAt }
      : {}),
    ...(run.activeSubtaskCount !== undefined
      ? { activeSubtaskCount: run.activeSubtaskCount }
      : {}),
    startedAt: run.startedAt,
    acceptedAt: run.startedAt,
    sessionOrder: run.sessionOrder,
    ...(run.queuedAt !== undefined ? { queuedAt: run.queuedAt } : {}),
    ...(run.runningAt !== undefined ? { runningAt: run.runningAt } : {}),
    ...(run.runningAt !== undefined
      ? { executionStartedAt: run.runningAt }
      : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    provider: run.provider,
    mode: run.mode,
    ...(run.origin !== undefined ? { origin: run.origin } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.lifecycleError !== undefined
      ? { lifecycleError: run.lifecycleError }
      : {}),
    ...(run.terminal !== undefined ? { terminal: run.terminal } : {}),
    ...(run.stop !== undefined ? { stop: run.stop } : {}),
    ...(run.continuation !== undefined
      ? {
          continuation: {
            ...run.continuation,
            state: runtimeContinuationState(run.phase),
          },
        }
      : {}),
    ...(run.interruptInputs.length > 0
      ? {
          interruptInputs: run.interruptInputs.map(runtimeInterruptInputStatus),
        }
      : {}),
  };
}

function runtimeContinuationState(
  phase: RuntimeRunPhase,
): RuntimeContinuationStatus["state"] {
  if (phase === "queued") return "queued";
  return isTerminalRunPhase(phase) ? "terminal" : "delivered";
}

function resultFromStatus(status: RuntimeRunStatus): RuntimeRunResult {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    phase: status.phase,
    ...(status.error !== undefined ? { error: new Error(status.error) } : {}),
    ...(status.terminal !== undefined ? { terminal: status.terminal } : {}),
    ...(status.stop !== undefined ? { stop: status.stop } : {}),
  };
}

function runtimeRunStopReceipt(
  stop: PersistedRuntimeRunStop,
): RuntimeRunStopReceipt {
  const recorded = stop.status.stop;
  const outcome: RuntimeRunStopStatus["outcome"] = recorded?.outcome ?? (
    stop.status.phase === "completed"
      ? "completed"
      : stop.status.phase === "failed"
        ? "failed"
        : stop.status.phase === "cancelled"
          ? "cancelled"
          : stop.status.phase === "interrupted"
            ? "interrupted"
            : "unknown"
  );
  return {
    runId: stop.status.runId,
    sessionId: stop.status.sessionId,
    accepted: stop.accepted,
    state: recorded?.state ?? (
      isTerminalRunPhase(stop.status.phase) ? "confirmed" : "unknown"
    ),
    outcome,
    phase: stop.status.phase,
    revision: stop.revision,
  };
}

function recentRunStatuses(
  statuses: readonly PersistedRuntimeRunStatus[],
): readonly PersistedRuntimeRunStatus[] {
  if (statuses.length <= MAX_RUNTIME_MEMORY_RUNS) return statuses;
  const active = statuses
    .filter((persisted) => !isTerminalRunPhase(persisted.status.phase))
    .sort((left, right) =>
      compareRunStatusRecency(left.status, right.status)
    )
    .slice(-MAX_RUNTIME_MEMORY_RUNS);
  const terminalBudget = MAX_RUNTIME_MEMORY_RUNS - active.length;
  const terminal = terminalBudget === 0
    ? []
    : statuses
        .filter((persisted) => isTerminalRunPhase(persisted.status.phase))
        .sort((left, right) =>
          compareRunStatusRecency(left.status, right.status)
        )
        .slice(-terminalBudget);
  return [...active, ...terminal];
}

function boundedRuntimeRunStatuses(
  statuses: readonly RuntimeRunStatus[],
): readonly RuntimeRunStatus[] {
  if (statuses.length <= MAX_RUNTIME_MEMORY_RUNS) return statuses;
  const nonTerminal = statuses.filter(
    (status) => !isTerminalRunPhase(status.phase),
  );
  const terminalBudget = Math.max(
    0,
    MAX_RUNTIME_MEMORY_RUNS - nonTerminal.length,
  );
  const recentTerminal = terminalBudget === 0
    ? []
    : statuses
        .filter((status) => isTerminalRunPhase(status.phase))
        .sort(compareRunStatusRecency)
        .slice(-terminalBudget);
  return [...nonTerminal, ...recentTerminal];
}

function canonicalRuntimeRunStatuses(
  statuses: readonly RuntimeRunStatus[],
): readonly RuntimeRunStatus[] {
  return [...statuses].sort((left, right) => {
    const byStart = (left.acceptedAt ?? left.startedAt).localeCompare(
      right.acceptedAt ?? right.startedAt,
    );
    if (byStart !== 0) return byStart;
    const bySession = left.sessionId.localeCompare(right.sessionId);
    if (bySession !== 0) return bySession;
    const bySessionOrder = (left.sessionOrder ?? 0) - (right.sessionOrder ?? 0);
    return bySessionOrder !== 0
      ? bySessionOrder
      : left.runId.localeCompare(right.runId);
  });
}

function pruneTerminalRuns(runs: Map<string, RuntimeRunRecord>): void {
  if (runs.size <= MAX_RUNTIME_MEMORY_RUNS) return;
  const terminal = [...runs.values()]
    .filter((run) => isTerminalRunPhase(run.phase))
    .sort((left, right) =>
      compareRunStatusRecency(statusFromRecord(left), statusFromRecord(right)),
    );
  for (const run of terminal) {
    if (runs.size <= MAX_RUNTIME_MEMORY_RUNS) return;
    runs.delete(run.runId);
  }
}

function compareRunStatusRecency(
  left: RuntimeRunStatus,
  right: RuntimeRunStatus,
): number {
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
  if (filter.sessionId !== undefined && run.sessionId !== filter.sessionId)
    return false;
  if (filter.phase !== undefined) {
    const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
    if (!phases.includes(run.phase)) return false;
  }
  return true;
}

function runStatusMatchesFilter(
  status: RuntimeRunStatus,
  filter: RuntimeRunFilter | undefined,
): boolean {
  if (!filter) return true;
  if (
    filter.sessionId !== undefined
    && status.sessionId !== filter.sessionId
  ) {
    return false;
  }
  if (filter.phase === undefined) return true;
  const phases = Array.isArray(filter.phase)
    ? filter.phase
    : [filter.phase];
  return phases.includes(status.phase);
}

function authoritativeSessionRun(
  runs: readonly RuntimeRunStatus[],
): RuntimeRunStatus | undefined {
  return [...runs].sort((left, right) => {
    const leftPriority = runtimeSessionRunPriority(left.phase);
    const rightPriority = runtimeSessionRunPriority(right.phase);
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    const leftOrder = left.sessionOrder ?? 0;
    const rightOrder = right.sessionOrder ?? 0;
    if (leftOrder !== rightOrder) return rightOrder - leftOrder;
    return compareRunStatusRecency(right, left);
  })[0];
}

function runtimeSessionRunPriority(phase: RuntimeRunPhase): number {
  if (phase === "unknown") return 4;
  if (isActiveRunPhase(phase)) return 3;
  if (phase === "queued") return 2;
  return 1;
}

function assertRuntimeOwnsRun(
  run: RuntimeRunRecord,
  owner: AgentActorOwner,
): void {
  if (run.ownedByRuntime || isTerminalRunPhase(run.phase)) return;
  throw createRuntimeConflictError(
    `Run ${run.runId} is owned by another live Runtime; ${owner.runtimeId} may observe but not mutate it.`,
    run.sessionOrder,
  );
}

function runtimeSessionActiveRunOwner(
  sessionId: string,
  runs: ReadonlyMap<string, RuntimeRunRecord>,
  persistence: RuntimePersistence,
): "local" | "foreign" | undefined {
  const localActive = [...runs.values()].some(
    (run) =>
      run.sessionId === sessionId
      && run.ownedByRuntime
      && (
        run.phase === "queued"
        || isActiveRunPhase(run.phase)
        || run.phase === "unknown"
        || (
          run.start !== undefined
          && run.settlementFinished !== true
        )
      ),
  );
  if (localActive) return "local";
  const foreignActive = persistence.loadRunStatuses().some(
    ({ status }) =>
      status.sessionId === sessionId
      && (
        status.phase === "queued"
        || isActiveRunPhase(status.phase)
        || status.phase === "unknown"
      ),
  );
  return foreignActive ? "foreign" : undefined;
}

function markRunTerminal(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord,
  phase: RuntimeRunPhase,
  terminal?: Omit<RuntimeTerminalFact, "revision" | "kind">,
): void {
  if (run.terminalEmitted) return;
  delete run.actorHealthBaseState;
  run.interruptInputOpen = false;
  terminalizeQueuedInterruptInputs(run);
  run.phase = phase;
  const endedAt = new Date().toISOString();
  run.stage = "terminal";
  run.stageChangedAt = endedAt;
  run.activeSubtaskCount = 0;
  run.endedAt = endedAt;
  if (run.stop !== undefined) {
    run.stop = {
      ...run.stop,
      state: "confirmed",
      outcome:
        phase === "completed"
          ? "completed"
          : phase === "failed"
            ? "failed"
            : phase === "interrupted"
              ? "interrupted"
              : "cancelled",
      resolvedAt: endedAt,
    };
  }
  run.terminalEmitted = true;
  const kind: RuntimeTerminalFact["kind"] =
    phase === "completed"
      ? "completed"
      : phase === "cancelled"
        ? "cancelled"
        : phase === "interrupted"
          ? "interrupted"
          : "failed";
  run.terminal = {
    revision: 1,
    kind,
    code: terminal?.code ?? defaultRuntimeTerminalCode(kind),
    effectOutcome:
      terminal?.effectOutcome ?? (kind === "interrupted" ? "unknown" : "known"),
    ...(terminal?.message !== undefined ? { message: terminal.message } : {}),
  };
  const type: RuntimeEventType =
    phase === "completed"
      ? "run.completed"
      : phase === "cancelled"
        ? "run.cancelled"
        : phase === "interrupted"
          ? "run.interrupted"
          : "run.failed";
  const proposed = statusFromRecord(run);
  const authoritative = saveRunStatusSafely(
    bus,
    persistence,
    run,
    proposed,
  );
  if (authoritative !== undefined && authoritative !== proposed) {
    applyAuthoritativeRunStatus(run, authoritative);
    return;
  }
  bus.emit(type, statusFromRecord(run), {
    sessionId: run.sessionId,
    runId: run.runId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
  });
}

function terminalizeQueuedInterruptInputs(run: RuntimeRunRecord): void {
  for (const input of run.interruptInputs) {
    if (input.state !== "queued") continue;
    if (input.queueMessageId !== undefined) {
      getMessageQueue().dequeue({
        agentId: actorQueueId(run.sessionId, "/root"),
        maxPriority: "user",
        mode: "prompt",
        id: input.queueMessageId,
      });
      delete input.queueMessageId;
    }
    input.state = "terminal";
  }
}

function saveRunStatusSafely(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord | undefined,
  status: RuntimeRunStatus,
): RuntimeRunStatus | undefined {
  try {
    return persistence.saveRunStatus(status);
  } catch (error: unknown) {
    const turnId = run?.turnId ?? status.turnId;
    bus.emit(
      "runtime.warning",
      {
        message: `Failed to save runtime run status for ${status.runId}: ${normalizeError(error).message}`,
        runId: status.runId,
        phase: status.phase,
      },
      {
        sessionId: status.sessionId,
        runId: status.runId,
        ...(turnId !== undefined ? { turnId } : {}),
      },
    );
    return undefined;
  }
}

function applyAuthoritativeRunStatus(
  run: RuntimeRunRecord,
  status: RuntimeRunStatus,
): void {
  run.phase = status.phase;
  run.stage = status.stage;
  run.stageChangedAt = status.stageChangedAt;
  run.activeSubtaskCount = status.activeSubtaskCount;
  run.provider = status.provider;
  run.queuedAt = status.queuedAt;
  run.runningAt = status.runningAt;
  run.endedAt = status.endedAt;
  run.model = status.model;
  run.reasoning = status.reasoning;
  run.error = status.error;
  run.lifecycleError = status.lifecycleError;
  run.terminal = status.terminal;
  run.stop = status.stop;
  run.terminalEmitted = isTerminalRunPhase(status.phase);
  run.interruptInputOpen = false;
}

function isTerminalRunPhase(phase: RuntimeRunPhase): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "cancelled" ||
    phase === "interrupted"
  );
}

function workflowEventType(event: WorkflowProcessEvent): RuntimeEventType {
  if (event.type === "workflow_started") return "workflow.started";
  if (event.type === "workflow_finished") return "workflow.finished";
  return "workflow.updated";
}

function isFinalWorkflowStatus(
  status: WorkflowProcessSnapshot["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function defaultRuntimeTerminalCode(
  kind: RuntimeTerminalFact["kind"],
): RuntimeTerminalCode {
  if (kind === "completed") return "completed";
  if (kind === "failed") return "run_failed";
  if (kind === "cancelled") return "cancelled";
  return "interrupted";
}

function classifyRuntimeRunFailure(error: unknown): {
  readonly phase: "failed" | "interrupted";
  readonly terminal: Omit<RuntimeTerminalFact, "revision" | "kind">;
} {
  const code =
    error instanceof Error
      ? (error as Error & { readonly code?: unknown }).code
      : undefined;
  if (code === "host_tool_unknown") {
    return {
      phase: "interrupted",
      terminal: {
        code: "host_outcome_unknown",
        effectOutcome: "unknown",
        message:
          "A run-bound host tool may have produced a side effect; it was not replayed.",
      },
    };
  }
  if (code === "host_tool_unavailable") {
    return {
      phase: "failed",
      terminal: {
        code: "host_not_dispatched",
        effectOutcome: "none",
        message: "The run-bound host tool was unavailable before dispatch.",
      },
    };
  }
  if (code === "credential_unavailable") {
    return {
      phase: "failed",
      terminal: {
        code: "credential_unavailable",
        effectOutcome: "none",
        message:
          "The provider credential was unavailable before the request could continue.",
      },
    };
  }
  return {
    phase: "failed",
    terminal: { code: "run_failed", effectOutcome: "known" },
  };
}

function normalizeRuntimeRunError(
  error: unknown,
  run: RuntimeRunRecord,
): Error {
  if (!run.hadProviderCredential) return normalizeError(error);
  const safe = new Error(
    "Provider run failed while using a run-scoped credential.",
  );
  safe.name = "KodaXProviderRunError";
  return safe;
}

function permissionMatchesFilter(
  request: RuntimePermissionRequest,
  filter: RuntimePermissionFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && request.sessionId !== filter.sessionId)
    return false;
  if (filter.runId !== undefined && request.runId !== filter.runId)
    return false;
  if (filter.toolName !== undefined && request.toolName !== filter.toolName)
    return false;
  return true;
}

function decisionToPermissionDecision(
  decision: boolean | string,
): RuntimePermissionDecision {
  if (decision === true) return { type: "allow_once" };
  return {
    type: "reject",
    reason: decision === false ? "tool execution rejected" : decision,
  };
}

type RuntimePermissionRaceResult =
  | {
      readonly source: "hook";
      readonly decision: RuntimePermissionToolDecision;
    }
  | {
      readonly source: "runtime";
      readonly decision: RuntimePermissionToolDecision;
    };

function autoModeEscalationRisk(
  signals: readonly ToolCallSignal[] | undefined,
): RuntimePermissionRisk {
  if (
    signals?.some(
      (signal) =>
        (signal.kind === "dangerous_pattern" && signal.severity === "high") ||
        signal.kind === "protected_path" ||
        signal.kind === "shell_redirect_outside",
    )
  ) {
    return "high";
  }
  return signals && signals.length > 0 ? "medium" : "low";
}

interface RuntimeAutoModeGuardrailCacheEntry {
  readonly projectRoot: string;
  readonly executionCwd: string;
  engine: NonNullable<RuntimeSessionSettings["autoModeEngine"]>;
  readonly classifierModel?: string;
  readonly timeoutMs?: number;
  readonly speculativeWindowMs?: number;
  readonly guardrail: RuntimeOwnedAutoModeGuardrail;
}

const MAX_RUNTIME_AUTO_MODE_GUARDRAILS_PER_SESSION = 8;

interface RuntimeOwnedAutoModeGuardrail extends ToolGuardrail {
  getEngine(): NonNullable<RuntimeSessionSettings["autoModeEngine"]>;
  prepare?(): Promise<void>;
  consumeAllowedCall(call: RunnerToolCall): boolean;
  consumeWorkspaceSandboxCall(call: RunnerToolCall): boolean;
  clearAllowedCalls(): void;
}

function resolveRuntimeExecutionCwd(record: RuntimeRunRecord): string {
  return path.resolve(
    record.start?.options.context?.executionCwd ??
      record.start?.options.context?.gitRoot ??
      process.cwd(),
  );
}

function runtimeShellPermissionIdentity(
  record: RuntimeRunRecord,
):
  | Pick<RuntimePermissionGrantContext, "shell" | "shellContractFingerprint">
  | undefined {
  const contract = record.start?.options.context?.shellExecution;
  if (contract === undefined) return undefined;
  const kind = contract.shell.kind;
  return {
    shell:
      kind === "bash" || kind === "zsh"
        ? "posix"
        : kind === "cmd"
          ? "cmd"
          : "powershell",
    shellContractFingerprint: shellExecutionContractFingerprint(contract),
  };
}

function isRuntimeAutoModeGuardrail(
  guardrail: NonNullable<RuntimeKodaXOptions["guardrails"]>[number],
): guardrail is RuntimeOwnedAutoModeGuardrail {
  return (
    guardrail.kind === "tool" &&
    guardrail.name === "auto-mode" &&
    "getEngine" in guardrail &&
    typeof guardrail.getEngine === "function" &&
    "consumeAllowedCall" in guardrail &&
    typeof guardrail.consumeAllowedCall === "function" &&
    "consumeWorkspaceSandboxCall" in guardrail &&
    typeof guardrail.consumeWorkspaceSandboxCall === "function"
  );
}

function getRuntimeAutoModeGuardrail(
  record: RuntimeRunRecord,
): RuntimeOwnedAutoModeGuardrail | undefined {
  if (replApi.normalizePermissionMode(record.permissionMode) !== "auto") {
    return undefined;
  }
  return record.start?.options.guardrails?.find(isRuntimeAutoModeGuardrail);
}

function serializeRuntimeToolInput(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (typeof value === "boolean")
    return value ? "boolean:true" : "boolean:false";
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `bigint:${value.toString()};`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${String(value)};`;
  }
  if (typeof value !== "object")
    throw new Error("Tool input must contain data values only.");
  if (ancestors.has(value)) throw new Error("Tool input must not be circular.");
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error("Tool input must be a plain object.");
  }
  ancestors.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error("Tool input must not contain symbol properties.");
    }
    if (Array.isArray(value)) {
      const indexes = ownKeys
        .filter(
          (key): key is string => key !== "length" && typeof key === "string",
        )
        .map((key) => {
          const index = Number(key);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          ) {
            throw new Error(
              "Tool input arrays must not contain named properties.",
            );
          }
          return { index, key };
        })
        .sort((left, right) => left.index - right.index);
      return `array:${value.length}:[${indexes
        .map(
          ({ key }) =>
            `${key}:${serializeRuntimeDataProperty(value, key, ancestors)}`,
        )
        .join("")}]`;
    }
    const keys = ownKeys
      .filter((key): key is string => typeof key === "string")
      .sort();
    return `object:{${keys
      .map(
        (key) =>
          `${serializeRuntimeToolInput(key, ancestors)}${serializeRuntimeDataProperty(
            value,
            key,
            ancestors,
          )}`,
      )
      .join("")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeRuntimeDataProperty(
  owner: object,
  key: string,
  ancestors: Set<object>,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Tool input must contain enumerable data properties only.");
  }
  return serializeRuntimeToolInput(descriptor.value, ancestors);
}

function runtimeAutoModeDecisionKey(call: RunnerToolCall): string | undefined {
  try {
    const input = serializeRuntimeToolInput(call.input);
    return createHash("sha256")
      .update(`${call.id}\0${call.name}\0${input}`)
      .digest("hex");
  } catch {
    return undefined;
  }
}

function reviewTouchesProtectedWindowsSystemTemp(
  review: AutoModePermissionReview,
): boolean {
  if (process.platform !== "win32") return false;
  const systemTemp = path.resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "Temp",
  );
  const isSystemTemp = (candidate: string): boolean => {
    if (!path.isAbsolute(candidate)) return false;
    const relative = path.relative(systemTemp, path.resolve(candidate));
    return relative === ""
      || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return review.operations.some((operation) => {
    if ("target" in operation) return isSystemTemp(operation.target.path);
    if ("source" in operation) {
      return isSystemTemp(operation.source.path)
        || isSystemTemp(operation.destination.path);
    }
    return false;
  });
}

function createRuntimeOwnedAutoModeGuardrail(
  guardrail: AutoModeToolGuardrail,
  workspaceSandboxCalls: Set<string>,
): RuntimeOwnedAutoModeGuardrail {
  const allowedCalls = new Set<string>();
  return {
    ...guardrail,
    beforeTool: async (
      call: RunnerToolCall,
      ctx: GuardrailContext,
    ): Promise<GuardrailVerdict> => {
      if (!guardrail.beforeTool) {
        return {
          action: "block",
          reason: "Runtime auto-mode guardrail has no beforeTool hook.",
        };
      }
      const verdict = await guardrail.beforeTool(call, ctx);
      if (verdict.action === "allow") {
        const bridgeTarget = resolveToolBridgeTarget(call);
        const authorizedCall = bridgeTarget?.ok ? bridgeTarget.call : call;
        const key = runtimeAutoModeDecisionKey(authorizedCall);
        if (key !== undefined) allowedCalls.add(key);
      }
      return verdict;
    },
    consumeAllowedCall(call) {
      const key = runtimeAutoModeDecisionKey(call);
      if (key === undefined || !allowedCalls.has(key)) return false;
      allowedCalls.delete(key);
      return true;
    },
    consumeWorkspaceSandboxCall(call) {
      const key = runtimeAutoModeDecisionKey(call);
      if (key === undefined || !workspaceSandboxCalls.has(key)) return false;
      workspaceSandboxCalls.delete(key);
      return true;
    },
    clearAllowedCalls() {
      allowedCalls.clear();
      workspaceSandboxCalls.clear();
    },
  };
}

function createRuntimeSessionAutoModeGuardrail(input: {
  readonly sessionId: string;
  readonly provider: string;
  readonly model?: string;
  readonly options: RuntimeKodaXOptions;
  readonly permissions: RuntimePermissionRegistry;
  readonly cache: Map<string, Map<string, RuntimeAutoModeGuardrailCacheEntry>>;
  readonly states: Map<string, AutoModeSharedState>;
  readonly settingsOwner: RuntimeSessionSettingsOwner;
  readonly getRecord: () => RuntimeRunRecord | undefined;
  readonly onPhase: (
    record: RuntimeRunRecord,
    phase: RuntimeRunPhase,
  ) => void;
  readonly onEngineChange: (
    engine: NonNullable<RuntimeSessionSettings["autoModeEngine"]>,
  ) => void;
}): RuntimeOwnedAutoModeGuardrail {
  const allowedCalls = new Set<string>();
  let currentGuardrail: RuntimeOwnedAutoModeGuardrail | undefined;
  let configurationError: RuntimeAutoModeConfigurationError | undefined;
  const resolveGuardrail = async (): Promise<
    RuntimeOwnedAutoModeGuardrail | undefined
  > => {
    const settings = (await input.settingsOwner.read(input.sessionId)).value;
    const record = input.getRecord();
    if (record) {
      record.permissionMode = settings.permissionMode;
      record.autoModeEngine =
        replApi.normalizePermissionMode(settings.permissionMode) === "auto"
          ? (settings.autoModeEngine ?? "llm")
          : settings.autoModeEngine;
      record.autoModeClassifierModel = settings.autoModeClassifierModel;
      record.autoModeTimeoutMs = settings.autoModeTimeoutMs;
      record.autoModeSpeculativeWindowMs = settings.autoModeSpeculativeWindowMs;
    }
    configurationError = runtimeAutoModeClassifierModelError(
      settings,
      record?.model ?? input.model,
    );
    if (configurationError) {
      currentGuardrail = undefined;
      return undefined;
    }
    const guardrail = await createRuntimeAutoModeGuardrail({
      ...input,
      settings,
    });
    currentGuardrail = guardrail;
    return guardrail;
  };
  return {
    kind: "tool",
    name: "auto-mode",
    async prepare() {
      await resolveGuardrail();
      if (configurationError) throw configurationError;
    },
    async beforeTool(call, ctx) {
      const guardrail = await resolveGuardrail();
      if (!guardrail?.beforeTool) {
        if (configurationError) {
          return { action: "block", reason: configurationError.message };
        }
        return { action: "allow" };
      }
      currentGuardrail = guardrail;
      const verdict = await guardrail.beforeTool(call, ctx);
      if (verdict.action === "allow") {
        const bridgeTarget = resolveToolBridgeTarget(call);
        const authorizedCall = bridgeTarget?.ok ? bridgeTarget.call : call;
        guardrail.consumeAllowedCall(authorizedCall);
        const key = runtimeAutoModeDecisionKey(authorizedCall);
        if (key !== undefined) allowedCalls.add(key);
      }
      return verdict;
    },
    getEngine() {
      if (currentGuardrail) return currentGuardrail.getEngine();
      const settings = input.settingsOwner.peek(input.sessionId)?.value;
      return replApi.normalizePermissionMode(settings?.permissionMode) ===
        "auto"
        ? (settings?.autoModeEngine ?? "llm")
        : "rules";
    },
    consumeAllowedCall(call) {
      const key = runtimeAutoModeDecisionKey(call);
      if (key === undefined || !allowedCalls.has(key)) return false;
      allowedCalls.delete(key);
      return true;
    },
    consumeWorkspaceSandboxCall(call) {
      return currentGuardrail?.consumeWorkspaceSandboxCall(call) ?? false;
    },
    clearAllowedCalls() {
      allowedCalls.clear();
      currentGuardrail?.clearAllowedCalls();
    },
  };
}

function runtimeShellUsesProcessEnvironmentPathAliases(
  contract: KodaXShellExecutionContract | undefined,
): boolean {
  if (contract === undefined) return true;
  if ((contract.shell.profile ?? 'default') !== 'none') return false;
  const environment = contract.environment;
  if (environment?.setup !== undefined || (environment?.denyPatterns?.length ?? 0) > 0) {
    return false;
  }
  return !Object.keys(environment?.set ?? {}).some((name) => (
    ['TEMP', 'TMP', 'TMPDIR'].includes(name.toUpperCase())
  ));
}

async function createRuntimeAutoModeGuardrail(input: {
  readonly sessionId: string;
  readonly provider: string;
  readonly model?: string;
  readonly settings: RuntimeSessionSettings;
  readonly options: RuntimeKodaXOptions;
  readonly permissions: RuntimePermissionRegistry;
  readonly cache: Map<string, Map<string, RuntimeAutoModeGuardrailCacheEntry>>;
  readonly states: Map<string, AutoModeSharedState>;
  readonly getRecord: () => RuntimeRunRecord | undefined;
  readonly onPhase: (
    record: RuntimeRunRecord,
    phase: RuntimeRunPhase,
  ) => void;
  readonly onEngineChange: (
    engine: NonNullable<RuntimeSessionSettings["autoModeEngine"]>,
  ) => void;
}): Promise<RuntimeOwnedAutoModeGuardrail | undefined> {
  if (
    replApi.normalizePermissionMode(input.settings.permissionMode) !== "auto"
  ) {
    return undefined;
  }
  const engine = input.settings.autoModeEngine ?? "llm";
  let sharedState = input.states.get(input.sessionId);
  if (sharedState === undefined) {
    sharedState = {
      engine,
      denials: createAutoModeDenialTracker(),
      breaker: createCircuitBreaker(),
    };
    input.states.set(input.sessionId, sharedState);
  } else {
    // Persisted Session settings are authoritative for explicit engine
    // changes; denial and breaker history survive cwd/config-specific
    // guardrail replacement.
    sharedState.engine = engine;
  }
  const executionCwd = path.resolve(
    input.options.context?.executionCwd ??
      input.settings.executionCwd ??
      input.options.context?.gitRoot ??
      process.cwd(),
  );
  const projectRoot = path.resolve(
    input.options.context?.gitRoot ?? executionCwd,
  );
  const trustProcessEnvironmentPathExpansion =
    runtimeShellUsesProcessEnvironmentPathAliases(
      input.options.context?.shellExecution,
    );
  const cacheKey = JSON.stringify([
    process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot,
    process.platform === "win32" ? executionCwd.toLowerCase() : executionCwd,
    engine,
    input.settings.autoModeClassifierModel ?? null,
    input.settings.autoModeTimeoutMs ?? null,
    input.settings.autoModeSpeculativeWindowMs ?? null,
    trustProcessEnvironmentPathExpansion,
  ]);
  const sessionCache = input.cache.get(input.sessionId) ?? new Map();
  input.cache.set(input.sessionId, sessionCache);
  const cached = sessionCache.get(cacheKey);
  if (cached?.engine === engine) return cached.guardrail;
  if (cached) sessionCache.delete(cacheKey);
  let cacheEntry: RuntimeAutoModeGuardrailCacheEntry | undefined;
  const workspaceSandboxCalls = new Set<string>();
  const bootstrap = await replApi.bootstrapAutoMode({
    askUser: async (call, reason, signals, diagnostics) => {
      const record = input.getRecord();
      if (!record) return "block";
      const previousPhase = record.phase;
      if (record.phase === "running") {
        input.onPhase(record, "waiting_permission");
      }
      try {
        const decision = await input.permissions.requestOwned(
          {
            sessionId: input.sessionId,
            runId: record.runId,
            ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
            toolCallId: call.id,
            toolName: call.name,
            reason: reason.slice(0, 512),
            risk: autoModeEscalationRisk(signals),
            inputPreview: previewInput(call.input),
            executionCwd,
            ...(diagnostics !== undefined
              ? { autoModeDiagnostics: diagnostics }
              : {}),
          },
          {
            toolInput: call.input,
            projectRoot,
            ...(signals !== undefined ? { signals } : {}),
          },
        );
        if (
          decision.type === "reject"
          && decision.cause === "approval_timeout"
        ) return "timeout";
        return decision.type === "allow_once" ||
          decision.type === "allow_session" ||
          decision.type === "allow_always"
          ? "allow"
          : "block";
      } finally {
        if (record.phase === "waiting_permission") {
          input.onPhase(
            record,
            previousPhase === "queued" ? "running" : previousPhase,
          );
        }
      }
    },
    projectRoot,
    executionCwd,
    trustProcessEnvironmentPathExpansion,
    admitWorkspaceSandboxCall: (call, review) => {
      if (reviewTouchesProtectedWindowsSystemTemp(review)) return;
      const key = runtimeAutoModeDecisionKey(call);
      if (key !== undefined) workspaceSandboxCalls.add(key);
    },
    getCurrentProviderName: () => input.getRecord()?.provider ?? input.provider,
    getCurrentModel: () => input.getRecord()?.model ?? input.model,
    getCurrentPermissionMode: () => "auto",
    autoModeSettings: {
      engine,
      ...(input.settings.autoModeClassifierModel !== undefined
        ? { classifierModel: input.settings.autoModeClassifierModel }
        : {}),
      ...(input.settings.autoModeTimeoutMs !== undefined
        ? { timeoutMs: input.settings.autoModeTimeoutMs }
        : {}),
      ...(input.settings.autoModeSpeculativeWindowMs !== undefined
        ? {
            speculativeWindowMs: input.settings.autoModeSpeculativeWindowMs,
          }
        : {}),
    },
    sharedState,
    extraCollectors: [replApi.replBashPathSignalCollector],
    onEngineChange: (nextEngine) => {
      if (cacheEntry) cacheEntry.engine = nextEngine;
      input.onEngineChange(nextEngine);
    },
  });
  const guardrail = createRuntimeOwnedAutoModeGuardrail(
    bootstrap.getGuardrail(),
    workspaceSandboxCalls,
  );
  cacheEntry = {
    projectRoot,
    executionCwd,
    engine: guardrail.getEngine(),
    ...(input.settings.autoModeClassifierModel !== undefined
      ? { classifierModel: input.settings.autoModeClassifierModel }
      : {}),
    ...(input.settings.autoModeTimeoutMs !== undefined
      ? { timeoutMs: input.settings.autoModeTimeoutMs }
      : {}),
    ...(input.settings.autoModeSpeculativeWindowMs !== undefined
      ? {
          speculativeWindowMs: input.settings.autoModeSpeculativeWindowMs,
        }
      : {}),
    guardrail,
  };
  sessionCache.set(cacheKey, cacheEntry);
  while (sessionCache.size > MAX_RUNTIME_AUTO_MODE_GUARDRAILS_PER_SESSION) {
    const oldestKey = sessionCache.keys().next().value as string | undefined;
    if (oldestKey === undefined || oldestKey === cacheKey) break;
    sessionCache.get(oldestKey)?.guardrail.clearAllowedCalls();
    sessionCache.delete(oldestKey);
  }
  return guardrail;
}

function resolveRuntimePermissionPolicy(
  record: RuntimeRunRecord,
  tool: string,
  input: Record<string, unknown>,
): RuntimePermissionToolDecision | undefined {
  if (RUNTIME_PERMISSION_BRIDGE_TOOLS.has(tool)) return true;
  const mode = replApi.normalizePermissionMode(record.permissionMode);
  if (mode === undefined) return undefined;
  const rawProjectRoot =
    record.start?.options.context?.gitRoot ??
    record.start?.options.context?.executionCwd;
  const projectRoot =
    rawProjectRoot === undefined ? undefined : path.resolve(rawProjectRoot);
  const executionCwd = resolveRuntimeExecutionCwd(record);
  if (mode === "plan") {
    const blockReason = replApi.getPlanModeBlockReason(
      tool,
      input,
      projectRoot,
      executionCwd,
    );
    return blockReason === null
      ? true
      : `${blockReason} Finish the plan before switching to a writable permission mode.`;
  }
  // `permissionBroker=client` selects who answers an escalation. The policy
  // below still owns the initial decision so already-allowed calls never
  // become permission work merely because a client prompt is available.
  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (replApi.isBashReadCommand(command)) return true;
    if (
      projectRoot &&
      replApi.isCommandOnProtectedPath(command, projectRoot, executionCwd)
    )
      return undefined;
  }
  if (projectRoot && replApi.FILE_MODIFICATION_TOOLS.has(tool)) {
    const targetPath = typeof input.path === "string" ? input.path : undefined;
    if (
      targetPath &&
      replApi.isAlwaysConfirmPath(
        resolveExecutionPath(targetPath, executionCwd),
        projectRoot,
      )
    ) {
      return undefined;
    }
  }
  return replApi.computeConfirmTools(mode).has(tool) ? undefined : true;
}

function decisionToToolDecision(
  decision: RuntimePermissionDecision | undefined,
): RuntimePermissionToolDecision {
  if (!decision) return false;
  if (
    decision.type === "allow_once" ||
    decision.type === "allow_session" ||
    decision.type === "allow_always"
  )
    return true;
  return decision.reason ?? false;
}

const PERMISSION_PREVIEW_MAX_LENGTH = 8_192;
const PERMISSION_PREVIEW_SCAN_MAX_LENGTH = 16_384;
const PERMISSION_PREVIEW_ARRAY_MAX_ITEMS = 16;
const PERMISSION_PREVIEW_FIELD_LIMITS = {
  command: 2_048,
  description: 1_024,
  file_path: 1_024,
  path: 1_024,
  paths: 1_024,
  cwd: 1_024,
  url: 1_024,
  preview: 2_048,
} as const;
const PERMISSION_SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;

function redactPermissionPreviewString(value: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9][A-Z0-9 _-]{0,63})-----[\s\S]*?(?:-----END \1-----|$)/gi,
      "[REDACTED_PEM]",
    )
    .replace(
      /^([ \t]*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)\s*:\s*[>|][-+0-9]*[ \t]*\r?\n)(?:(?:[ \t]+[^\r\n]*(?:\r?\n|$)))+/gim,
      "$1  [REDACTED]\n",
    )
    .replace(
      /\b((?=[a-z0-9_]*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret|token))[a-z_][a-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)["']?)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(--(?:(?:api|access|auth|id|refresh)[_-]?(?:key|token)|authorization|client[_-]?secret|password|private[_-]?key|secret|token))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b((?:proxy-)?authorization|cookie|x-api-key)(\s*:\s*)(?:bearer\s+|basic\s+)?[^\s"';&|]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function previewInput(input: Readonly<Record<string, unknown>>): string {
  try {
    return buildPermissionInputPreview(input);
  } catch {
    // Tool inputs may originate in extensions or remote hosts. Proxy traps and
    // exotic descriptors must not crash the permission owner or leak their
    // exception text into a shared request.
    return '{"__truncated":true}';
  }
}

function buildPermissionInputPreview(
  input: Readonly<Record<string, unknown>>,
): string {
  const summary: Record<string, unknown> = {};
  // A preview is intentionally a partial, fixed-field projection. Starting
  // truncated avoids enumerating an attacker-controlled input graph merely to
  // discover omitted keys; work stays bounded to the whitelist below.
  let truncated = true;
  for (const [key, maxLength] of Object.entries(
    PERMISSION_PREVIEW_FIELD_LIMITS,
  )) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      continue;
    if (PERMISSION_SENSITIVE_KEY.test(key)) {
      summary[key] = "[REDACTED]";
      continue;
    }
    const value = descriptor.value;
    if (typeof value === "string") {
      const scanned = value.slice(0, PERMISSION_PREVIEW_SCAN_MAX_LENGTH);
      const redacted = redactPermissionPreviewString(scanned);
      summary[key] =
        redacted.length <= maxLength
          ? redacted
          : `${redacted.slice(0, Math.max(0, maxLength - 1))}…`;
      truncated ||=
        value.length > scanned.length || redacted.length > maxLength;
      continue;
    }
    if (key === "paths" && Array.isArray(value)) {
      const paths: string[] = [];
      for (const item of value.slice(0, PERMISSION_PREVIEW_ARRAY_MAX_ITEMS)) {
        if (typeof item !== "string") {
          truncated = true;
          continue;
        }
        const scanned = item.slice(0, PERMISSION_PREVIEW_SCAN_MAX_LENGTH);
        const redacted = redactPermissionPreviewString(scanned);
        paths.push(redacted.slice(0, maxLength));
        truncated ||=
          item.length > scanned.length || redacted.length > maxLength;
      }
      truncated ||= value.length > PERMISSION_PREVIEW_ARRAY_MAX_ITEMS;
      summary[key] = paths;
      continue;
    }
    if (
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "bigint"
    ) {
      summary[key] = typeof value === "bigint" ? value.toString() : value;
      continue;
    }
    truncated = true;
  }
  if (truncated) summary.__truncated = true;
  const summarized = JSON.stringify(summary);
  if (summarized.length <= PERMISSION_PREVIEW_MAX_LENGTH) return summarized;
  return '{"__truncated":true}';
}

function normalizePermissionInputPreview(inputPreview: string): string {
  if (inputPreview.length > PERMISSION_PREVIEW_SCAN_MAX_LENGTH) {
    return previewInput({
      preview: inputPreview.slice(0, PERMISSION_PREVIEW_SCAN_MAX_LENGTH),
    });
  }
  try {
    const parsed = JSON.parse(inputPreview) as unknown;
    return previewInput(isRecord(parsed) ? parsed : { value: parsed });
  } catch {
    return previewInput({ preview: inputPreview });
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createRuntimeConflictError(
  message: string,
  currentRevision: number,
): Error & { readonly code: "conflict"; readonly currentRevision: number } {
  return Object.assign(new Error(message), {
    code: "conflict" as const,
    currentRevision,
  });
}

function createSessionArchivedError(
  sessionId: string,
): Error & { readonly code: "session_archived" } {
  return Object.assign(
    new Error(
      `Session is archived and cannot execute until it is unarchived: ${sessionId}`,
    ),
    { code: "session_archived" as const },
  );
}

function createRuntimeResyncError(
  message: string,
): Error & { readonly code: "resync_required" } {
  return Object.assign(new Error(message), {
    code: "resync_required" as const,
  });
}

function normalizeConversationBoundaryMutationError(error: unknown): Error {
  if (error instanceof replApi.SessionReadError && error.code === "data_changed") {
    return createRuntimeResyncError(
      "Conversation history changed; acquire a fresh history boundary",
    );
  }
  return normalizeError(error);
}

function createRuntimeTranscriptSnapshotInvalidError(
  message: string,
): Error & {
  readonly code: "resync_required";
  readonly snapshotInvalid: true;
} {
  return Object.assign(createRuntimeResyncError(message), {
    snapshotInvalid: true as const,
  });
}

function isRuntimeTranscriptSnapshotInvalidError(error: unknown): boolean {
  return isRecord(error) && error.snapshotInvalid === true;
}

function createRuntimeSnapshotCapacityError(): Error & {
  readonly code: "overloaded";
  readonly data: { readonly limitBytes: number };
} {
  return Object.assign(
    new Error(
      `Transcript snapshot storage limit exceeded (${MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES} bytes)`,
    ),
    {
      code: "overloaded" as const,
      data: { limitBytes: MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_BYTES },
    },
  );
}

function createRuntimeHistoryPageCapacityError(): Error & {
  readonly code: "overloaded";
  readonly data: { readonly limitBytes: number };
} {
  return Object.assign(
    new Error(
      `Runtime history page limit exceeded (${MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES} bytes)`,
    ),
    {
      code: "overloaded" as const,
      data: { limitBytes: MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES },
    },
  );
}

function createRuntimeSnapshotIoCapacityError(): Error & {
  readonly code: "overloaded";
  readonly data: {
    readonly resource: "transcript_snapshot_io";
    readonly limit: number;
  };
} {
  return Object.assign(
    new Error(
      `Transcript snapshot I/O limit exceeded (${MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_FILES} operations)`,
    ),
    {
      code: "overloaded" as const,
      data: {
        resource: "transcript_snapshot_io" as const,
        limit: MAX_RUNTIME_TRANSCRIPT_SNAPSHOT_FILES,
      },
    },
  );
}

function normalizeRuntimeSnapshotMaterializationError(
  error: unknown,
  closing: boolean,
): Error {
  if (isExpectedRuntimeReadTermination(error)) return error;
  if (
    isRecord(error)
    && (error.code === "overloaded" || error.code === "resync_required")
  ) {
    return error instanceof Error
      ? error
      : Object.assign(new Error("Transcript snapshot operation failed"), error);
  }
  if (closing) {
    return new replApi.SessionReadError(
      "read_cancelled",
      "Runtime history read cancelled because the Runtime is closing",
    );
  }
  if (
    isRecord(error)
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  ) {
    return createRuntimeResyncError(
      "Transcript snapshot storage changed; request a fresh boundary",
    );
  }
  return Object.assign(
    new Error("Unable to materialize the transcript snapshot", {
      cause: error,
    }),
    { code: "internal_error" as const },
  );
}

function createRuntimeInvalidInputError(
  message: string,
): Error & { readonly code: "invalid_input" } {
  return Object.assign(new Error(message), { code: "invalid_input" as const });
}

function createRuntimeCredentialUnavailableError(
  message: string,
): Error & { readonly code: "credential_unavailable" } {
  return Object.assign(new Error(message), {
    code: "credential_unavailable" as const,
  });
}

function createUnsupportedCredentialService(): RuntimeCredentialService {
  return {
    async register() {
      throw new Error(
        "Credential broker registration requires a shared daemon client.",
      );
    },
    async resume() {
      throw new Error(
        "Credential broker resume requires a shared daemon client.",
      );
    },
    async revoke() {
      return false;
    },
  };
}

function createUnsupportedHostToolService(): RuntimeHostToolService {
  return {
    async register() {
      throw new Error(
        "Host tool registration requires a shared daemon client.",
      );
    },
    async resume() {
      throw new Error("Host tool resume requires a shared daemon client.");
    },
    async getInvocation() {
      return undefined;
    },
    async revoke() {
      return false;
    },
  };
}

function assertSessionMutationAllowed(
  sessionId: string,
  activeRunOwner: (
    candidateSessionId: string,
  ) => "local" | "foreign" | undefined,
): void {
  const owner = activeRunOwner(sessionId);
  if (owner === undefined) return;
  const error = new Error(
    `Session has an active run and cannot be mutated: ${sessionId}`,
  );
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: owner === "foreign" ? "actor_owner_conflict" : "conflict",
  });
  throw error;
}

function assertDeleteSucceeded(
  sessionId: string,
  result: DeleteSessionResult,
): void {
  if ("ok" in result) return;
  if (result.error.code === "session_running") {
    throw new Error(`Session is running and cannot be deleted: ${sessionId}`);
  }
  throw Object.assign(
    new Error(`Session could not be deleted: ${sessionId}`),
    { code: "session_delete_failed" as const },
  );
}

function cloneMessage(message: KodaXMessage): KodaXMessage {
  return structuredClone(message);
}

export type { KodaXMessage, KodaXResult, KodaXEvents, SessionTranscriptEntry };
