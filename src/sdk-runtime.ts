/**
 * SDK subpath entry - `@kodax-ai/kodax/runtime`.
 *
 * FEATURE_253 (v0.7.64): embedded runtime contract. This module composes the
 * existing coding run loop, REPL-backed session storage, and agent workflow
 * process manager without introducing a daemon or a fifth workspace package.
 */

import { createHash, randomUUID } from "node:crypto";
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
  searchSessionHistory,
} from "@kodax-ai/agent";
import type {
  AgentArtifactPolicy,
  AgentActorClient,
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
  readonly connectionLifecycle?: 1;
  readonly typedRuntimeEvents?: 1;
  readonly daemonSafeRunInput?: 1;
  readonly sharedSessionSettings?: 1;
  readonly durableRecoveryQueries?: 1;
  readonly daemonManagement?: 1;
  /** Require an auto-started daemon whose current host has orphan idle-exit enabled. */
  readonly daemonOrphanExit?: 1;
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

/** `session.loaded` is emitted both for an explicit SDK load and a run provider session bind. */
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
}

export interface RuntimeSessionService {
  create(input?: RuntimeCreateSessionInput): Promise<RuntimeSession>;
  load(sessionId: string): Promise<RuntimeSession>;
  list(
    filter?: RuntimeSessionFilter,
  ): Promise<readonly RuntimeSessionSummary[]>;
  transcript(sessionId: string): Promise<RuntimeTranscript | null>;
  transcriptPage(
    input: RuntimeTranscriptPageInput,
  ): Promise<RuntimeTranscriptSlice | null>;
  transcriptEntryChunk(
    input: RuntimeTranscriptEntryChunkInput,
  ): Promise<RuntimeTranscriptEntryChunk | null>;
  transcriptSearch(
    input: RuntimeTranscriptSearchInput,
  ): Promise<RuntimeTranscriptSearchResult | null>;
  observe(
    sessionId: string,
    listener: RuntimeEventListener,
  ): Promise<RuntimeSessionObservation>;
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
  | "waiting_permission"
  | "waiting_user_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  readonly terminal?: RuntimeTerminalFact;
  readonly continuation?: RuntimeContinuationStatus;
  readonly interruptInputs?: readonly RuntimeInterruptInputStatus[];
  readonly requirements?: RuntimeRunRequirements;
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
  readonly origin?: RuntimeRunStatus["origin"];
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
  abort(runId: string): Promise<void>;
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

interface RuntimeRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  turnId?: string;
  phase: RuntimeRunPhase;
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
  terminal?: RuntimeTerminalFact;
  readonly result: Promise<RuntimeRunResult>;
  running?: RunningSession;
  abortController?: AbortController;
  mode: RuntimeRunMode;
  readonly origin?: RuntimeRunStatus["origin"];
  readonly continuation?: Omit<RuntimeContinuationStatus, "state">;
  readonly interruptInputs: RuntimeInterruptInputRecord[];
  providerCredential?: string;
  readonly hadProviderCredential: boolean;
  readonly agentContext?: AgentDispatchContext;
  readonly actorSession?: CodingActorSession;
  interruptInputOpen: boolean;
  releaseAbortSignalSubscription?: () => void;
  start?: PendingRunStart;
  terminalEmitted: boolean;
}

interface RuntimeInterruptInputRecord extends RuntimeInterruptInputStatus {
  state: RuntimeInterruptInputStatus["state"];
  deliveredAt?: string;
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

interface RuntimePersistence {
  readonly runtimeDir: string;
  appendEvent(event: RuntimeEvent): void;
  appendDurableEvent(event: RuntimeEvent): void;
  close(): void;
  nextEventSeq(): number;
  currentEventSeq(): number;
  replay(filter?: RuntimeEventReplayFilter): readonly RuntimeEvent[];
  saveRunStatus(status: RuntimeRunStatus): void;
  loadRunStatus(runId: string): RuntimeRunStatus | undefined;
  loadRunStatuses(): readonly RuntimeRunStatus[];
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
  admitsSession(sessionId: string): Promise<boolean>;
  assertRunAccess(sessionId: string): Promise<void>;
  loadRequired(sessionId: string): Promise<KodaXSessionData>;
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

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_RUNTIME_MEMORY_EVENTS = 10_000;
const MAX_RUNTIME_MEMORY_RUNS = 1_000;
const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_BUFFERED_EVENT_BYTES = 64 * 1024;
const RUNTIME_EVENT_FLUSH_INTERVAL_MS = 10;
const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;
const TARGET_RUNTIME_EVENT_FILE_BYTES = MAX_RUNTIME_EVENT_FILE_BYTES / 2;
const MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES = 128 * 1024;
const MAX_RUNTIME_SNAPSHOT_ATTEMPTS = 8;
const MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES = 512 * 1024;
const MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES = 128 * 1024;
const MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_RUNTIME_TRANSCRIPT_PAGE_LIMIT = 50;
const MAX_RUNTIME_TRANSCRIPT_PAGE_LIMIT = 200;
const MAX_RUNTIME_INPUT_PREVIEW_LENGTH = 1_024;
const BUFFERED_RUNTIME_EVENT_TYPES: ReadonlySet<RuntimeEventType> = new Set([
  "assistant.delta",
  "thinking.delta",
  "tool.progress",
  "run.progress",
]);
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
            runtimeAutoModeGuardrail: 3 as const,
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
    runtimeAutoModeGuardrail: {
      version: 4,
      owner: "session-runtime",
      escalationCreatesPermission: true,
      fallbackPersistsEngine: true,
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
  const persistence = createRuntimePersistence(options);
  const agentPlane = options.externalAgents
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
  const actorRegistry = createRuntimeAgentActorRegistry(
    sessionManager,
    identity,
    agentPlane,
    options.externalAgents?.defaultContext,
  );
  const runs = new Map<string, RuntimeRunRecord>();
  const recoveredSessionOrders = new Map<string, number>();
  const persistedStatuses = [
    ...recentRunStatuses(persistence.loadRunStatuses()),
  ].sort(compareRunStatusRecency);
  for (const status of persistedStatuses) {
    const sessionOrder =
      status.sessionOrder ??
      (recoveredSessionOrders.get(status.sessionId) ?? 0) + 1;
    recoveredSessionOrders.set(
      status.sessionId,
      Math.max(recoveredSessionOrders.get(status.sessionId) ?? 0, sessionOrder),
    );
    const recovered = interruptPersistedNonTerminalRun(
      {
        ...status,
        acceptedAt: status.acceptedAt ?? status.startedAt,
        sessionOrder,
      },
      bus,
      persistence,
    );
    runs.set(recovered.runId, recordFromPersistedStatus(recovered));
  }
  let closed = false;
  let closeAttempt: Promise<void> | undefined;
  let shutdownStarted = false;
  let actorRegistryClosed = false;
  let agentPlaneClosed = agentPlane === undefined;
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
    runs,
    sessionManager,
    sessionAdmission,
    sessionOperations,
    agentPlane,
    defaultAgentContext: options.externalAgents?.defaultContext,
    actorRegistry,
    settingsOwner,
  });
  const sessionService = createRuntimeSessionService(
    identity,
    configHome,
    sessionManager,
    bus,
    persistence,
    ensureOpen,
    (sessionId) =>
      [...runs.values()].some(
        (run) =>
          run.sessionId === sessionId
          && (run.phase === "queued" || isActiveRunPhase(run.phase)),
      ),
    settingsOwner,
    (sessionId) => runService.list({ sessionId }),
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
      await sessionOperations.close();
      const cleanupResults = await Promise.allSettled([
        actorRegistryClosed
          ? Promise.resolve()
          : actorRegistry.close("runtime closed").then(() => {
              actorRegistryClosed = true;
            }),
        agentPlaneClosed
          ? Promise.resolve()
          : agentPlane!.close().then(() => {
              agentPlaneClosed = true;
            }),
      ]);
      if (!busClosed) {
        busClosed = true;
        bus.close();
      }
      const errors = cleanupResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "KodaX runtime cleanup failed.");
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
      runs,
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
    requirements?.connectionLifecycle === undefined &&
    requirements?.typedRuntimeEvents === undefined &&
    requirements?.daemonSafeRunInput === undefined &&
    requirements?.sharedSessionSettings === undefined &&
    requirements?.durableRecoveryQueries === undefined &&
    requirements?.daemonManagement === undefined &&
    requirements?.daemonOrphanExit === undefined &&
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
    ["connectionLifecycle", requirements.connectionLifecycle],
    ["typedRuntimeEvents", requirements.typedRuntimeEvents],
    ["daemonSafeRunInput", requirements.daemonSafeRunInput],
    ["sharedSessionSettings", requirements.sharedSessionSettings],
    ["durableRecoveryQueries", requirements.durableRecoveryQueries],
    ["daemonManagement", requirements.daemonManagement],
    ["daemonOrphanExit", requirements.daemonOrphanExit],
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
            runtimeAutoModeGuardrail: 3 as const,
            ...(options.daemonOrphanExitMs !== undefined
              ? { daemonOrphanExit: 1 as const }
              : {}),
          }
        : options.requirements;
    const requiredUpgrade = [
      {
        name: "runtimeAutoModeGuardrail",
        version: requirements?.runtimeAutoModeGuardrail,
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
  hasActiveRun: (sessionId: string) => boolean,
  settingsOwner: RuntimeSessionSettingsOwner,
  listRuns: (sessionId: string) => Promise<readonly RuntimeRunStatus[]>,
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

  let transcriptChunkCache:
    | {
        readonly sessionId: string;
        readonly sessionSeq: number;
        readonly revision: string;
        readonly entryIndex: number;
        readonly entryId?: string;
        readonly encoded: Buffer;
      }
    | undefined;

  const captureObservationSnapshot = async (
    sessionId: string,
  ): Promise<RuntimeSessionObservationSnapshot> => {
    for (
      let attempt = 0;
      attempt < MAX_RUNTIME_SNAPSHOT_ATTEMPTS;
      attempt += 1
    ) {
      const before = bus.currentSessionSeq(sessionId);
      const data = await admission.loadRequired(sessionId);
      const [transcript, runs, pendingPermissions] = await Promise.all([
        manager.loadFullTranscript(sessionId),
        listRuns(sessionId),
        listPendingPermissions(sessionId),
      ]);
      const settings = await settingsOwner.read(sessionId);
      const after = bus.currentSessionSeq(sessionId);
      if (before !== after) continue;
      return {
        runtimeId: identity.runtimeId,
        cursor: after,
        transcriptRevision: createRuntimeTranscriptRevision(transcript),
        session: toRuntimeSession(sessionId, data),
        transcript:
          transcript === null ? null : createRuntimeTranscriptSlice(transcript),
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

  const mutateActiveSession = <T>(
    sessionId: string,
    mutation: (data: KodaXSessionData) => Promise<T>,
  ): Promise<T> =>
    sessionOperations.run(sessionId, async () => {
      ensureOpen();
      const data = await admission.loadExecutable(sessionId);
      return withActorSessionFileMutation(
        sessionId,
        "mutate",
        () => mutation(data),
      );
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
        if ((await manager.loadSession(sessionId)) !== null) {
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
        await manager.storage.save(sessionId, data);
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

    async load(sessionId) {
      ensureOpen();
      const data = await admission.loadRequired(sessionId);
      const session = toRuntimeSession(sessionId, data);
      bus.emit("session.loaded", session, { sessionId, runId: sessionId });
      return session;
    },

    async list(filter) {
      ensureOpen();
      admission.assertFilter(filter);
      const summaries = await manager.listSessions(filter);
      return summaries
        .filter(admission.admitsSummary)
        .map(toRuntimeSessionSummary);
    },

    async transcript(sessionId) {
      ensureOpen();
      await admission.loadRequired(sessionId);
      return manager.loadFullTranscript(sessionId);
    },

    async transcriptPage(input) {
      ensureOpen();
      await admission.loadRequired(input.sessionId);
      const transcript = await manager.loadFullTranscript(input.sessionId);
      return transcript === null
        ? null
        : createRuntimeTranscriptSlice(transcript, input.cursor, input.limit);
    },

    async transcriptEntryChunk(input) {
      ensureOpen();
      await admission.loadRequired(input.sessionId);
      const sessionSeq = bus.currentSessionSeq(input.sessionId);
      if (
        transcriptChunkCache?.sessionId === input.sessionId &&
        transcriptChunkCache.sessionSeq === sessionSeq &&
        transcriptChunkCache.revision === input.revision &&
        transcriptChunkCache.entryIndex === input.entryIndex
      ) {
        return createRuntimeTranscriptEntryChunkFromEncoded(
          input,
          transcriptChunkCache.revision,
          transcriptChunkCache.entryId,
          transcriptChunkCache.encoded,
        );
      }
      const transcript = await manager.loadFullTranscript(input.sessionId);
      if (transcript === null) return null;
      const revision = createRuntimeTranscriptRevision(transcript);
      if (input.revision !== revision) {
        throw createRuntimeResyncError(
          "Transcript revision changed; request a fresh observation snapshot",
        );
      }
      const entry = transcript.transcriptEntries[input.entryIndex];
      if (entry === undefined) {
        throw new Error(
          `Transcript entry index is out of range: ${input.entryIndex}`,
        );
      }
      const encoded = Buffer.from(JSON.stringify(entry), "utf8");
      transcriptChunkCache = {
        sessionId: input.sessionId,
        sessionSeq,
        revision,
        entryIndex: input.entryIndex,
        ...(typeof entry.entryId === "string"
          ? { entryId: entry.entryId }
          : {}),
        encoded,
      };
      return createRuntimeTranscriptEntryChunkFromEncoded(
        input,
        revision,
        transcriptChunkCache.entryId,
        encoded,
      );
    },

    async transcriptSearch(input) {
      ensureOpen();
      await admission.loadRequired(input.sessionId);
      const transcript = await manager.loadFullTranscript(input.sessionId);
      if (transcript === null) return null;
      const lineage =
        transcript.lineage ?? createSessionLineage(transcript.messages);
      const search = searchSessionHistory(lineage, {
        query: input.query,
        limit: input.limit,
        role: input.role,
        scope: input.scope,
      });
      const entryIndexById = new Map(
        transcript.transcriptEntries.map((entry, entryIndex) => [
          entry.entryId,
          entryIndex,
        ]),
      );
      const hits = search.hits.flatMap((hit): RuntimeTranscriptSearchHit[] => {
        const entryIndex = entryIndexById.get(hit.entryId);
        return entryIndex === undefined ? [] : [{ ...hit, entryIndex }];
      });
      return {
        revision: createRuntimeTranscriptRevision(transcript),
        hits,
      };
    },

    async observe(sessionId, listener) {
      ensureOpen();
      const pending: RuntimeEvent[] = [];
      let cursor: number | undefined;
      let closed = false;
      const deliver = (event: RuntimeEvent): void => {
        if (closed || (cursor !== undefined && event.seq <= cursor)) return;
        try {
          listener(event);
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: "runtime.sessions.observe",
            level: "error",
            message: `Session observation listener failed for ${event.type}`,
            detail: normalizeError(error),
          });
        }
      };
      const subscription = bus.service.subscribe({ sessionId }, (event) => {
        if (cursor === undefined) {
          pending.push(event);
        } else {
          deliver(event);
        }
      });
      try {
        const snapshot = await captureObservationSnapshot(sessionId);
        cursor = snapshot.cursor;
        for (const event of pending
          .splice(0)
          .sort((left, right) => left.seq - right.seq)) {
          deliver(event);
        }
        return {
          snapshot,
          close() {
            if (closed) return;
            closed = true;
            pending.length = 0;
            subscription.close();
          },
        };
      } catch (error: unknown) {
        closed = true;
        subscription.close();
        throw error;
      }
    },

    async fork(input) {
      ensureOpen();
      const source = await admission.loadRequired(input.sessionId);
      const forked = await manager.forkSession(input.sessionId, {
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
        ...(input.newSessionId !== undefined
          ? { sessionId: input.newSessionId }
          : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
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
        assertSessionMutationAllowed(input.sessionId, hasActiveRun);
        const data = await manager.rewindSession(input.sessionId, {
          ...(input.selector !== undefined ? { selector: input.selector } : {}),
        });
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
        assertSessionMutationAllowed(input.sessionId, hasActiveRun);
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
        assertSessionMutationAllowed(input.sessionId, hasActiveRun);
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
        assertSessionMutationAllowed(sessionId, hasActiveRun);
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
      });
    },

    async unarchive(sessionId) {
      await sessionOperations.run(sessionId, async () => {
        ensureOpen();
        await admission.loadRequired(sessionId);
        assertSessionMutationAllowed(sessionId, hasActiveRun);
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
      });
    },

    async delete(sessionId) {
      await sessionOperations.run(sessionId, async () => {
        ensureOpen();
        await admission.loadRequired(sessionId);
        assertSessionMutationAllowed(sessionId, hasActiveRun);
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
        settingsOwner.release(sessionId);
        onSessionDeleted(sessionId);
      });
    },
  };
}

function createRuntimeRunService(deps: {
  readonly actorRegistry: RuntimeAgentActorRegistry;
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
  const latestSessionOrder = new Map<string, number>();
  for (const run of deps.runs.values()) {
    latestSessionOrder.set(
      run.sessionId,
      Math.max(latestSessionOrder.get(run.sessionId) ?? 0, run.sessionOrder),
    );
  }

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
    };
  };

  const cancelRun = (
    record: RuntimeRunRecord,
    reason: string,
    drain: boolean,
  ): RuntimeRunResult => {
    const wasQueued = record.phase === "queued";
    if (record.phase === "queued") {
      removeQueuedRun(queueBySession, record);
    }
    releaseAbortSignalSubscription(record);
    record.running?.abort(new Error(reason));
    record.abortController?.abort(new Error(reason));
    deps.permissions.rejectForRun(record.runId, reason);
    deps.userInputs.rejectForRun(record.runId, reason);
    record.start?.options.guardrails
      ?.find(isRuntimeAutoModeGuardrail)
      ?.clearAllowedCalls();
    markRunTerminal(deps.bus, deps.persistence, record, "cancelled", {
      code: "cancelled",
      effectOutcome: wasQueued ? "none" : "unknown",
      message: reason,
    });
    const result: RuntimeRunResult = {
      runId: record.runId,
      sessionId: record.sessionId,
      phase: record.phase,
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
    record.interruptInputOpen = record.actorSession !== undefined;
    record.queuedAt = undefined;
    record.runningAt = new Date().toISOString();
    activeRunBySession.set(record.sessionId, record.runId);
    saveRunStatusSafely(
      deps.bus,
      deps.persistence,
      record,
      statusFromRecord(record),
    );
    deps.bus.emit("run.started", statusFromRecord(record), {
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
      onMidTurnUserMessages: (queuedMessageIds) =>
        deliverInterruptInputs(record, queuedMessageIds),
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
        abortController.abort(upstreamSignal?.reason);
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
        .then((value): RuntimeRunResult => {
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
          };
        })
        .catch((error: unknown) => failedRunResult(record, error))
        .then((result) => finishRun(record, result));
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
      .then((value): RuntimeRunResult => {
        const phase = record.terminalEmitted
          ? record.phase
          : value.interrupted
            ? "interrupted"
            : value.success
              ? "completed"
              : "failed";
        markRunTerminal(deps.bus, deps.persistence, record, phase);
        return {
          runId: record.runId,
          sessionId: record.sessionId,
          phase: record.phase,
          result: value,
        };
      })
      .catch((error: unknown) => failedRunResult(record, error))
      .then((result) => finishRun(record, result));
  };

  const startRecord = (
    record: RuntimeRunRecord,
  ): { readonly error: unknown } | undefined => {
    try {
      launchRecord(record);
      return undefined;
    } catch (error) {
      finishRun(record, failedRunResult(record, error));
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
    const queue = queueBySession.get(record.sessionId) ?? [];
    queue.push(record.runId);
    queueBySession.set(record.sessionId, queue);
    saveRunStatusSafely(
      deps.bus,
      deps.persistence,
      record,
      statusFromRecord(record),
    );
    deps.bus.emit("run.queued", statusFromRecord(record), {
      sessionId: record.sessionId,
      runId: record.runId,
    });
  };

  const publishRunUpdate = (record: RuntimeRunRecord): void => {
    const status = statusFromRecord(record);
    saveRunStatusSafely(deps.bus, deps.persistence, record, status);
    deps.bus.emit("run.updated", status, {
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
    });
  };

  const deliverInterruptInputs = (
    record: RuntimeRunRecord,
    queuedMessageIds: readonly string[],
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
    const batch = delivered.map((input): RuntimeDeliveredInterruptInput => {
      if (input.input === undefined) {
        throw new Error(
          `Runtime interrupt input is unavailable: ${input.inputId}`,
        );
      }
      return {
        inputId: input.inputId,
        afterRunId: input.afterRunId,
        input: input.input,
        queuedAt: input.queuedAt,
        deliveredAt,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      };
    });
    const scope = {
      sessionId: record.sessionId,
      runId: record.runId,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
    };
    try {
      deps.bus.emitDurable(
        "run.input.delivered",
        { inputs: batch },
        scope,
        () => {
          for (const input of delivered) {
            input.state = "delivered";
            input.deliveredAt = deliveredAt;
            delete input.queueMessageId;
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
    const sessionOrder = (latestSessionOrder.get(input.sessionId) ?? 0) + 1;
    latestSessionOrder.set(input.sessionId, sessionOrder);
    const isQueued =
      requiredAfterRun !== undefined || activeRunBySession.has(input.sessionId);
    const record: RuntimeRunRecord = {
      runId,
      sessionId: input.sessionId,
      phase: isQueued ? "queued" : "running",
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
      if (!isActiveRunPhase(afterRun.phase) && afterRun.phase !== "queued") {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: "stale_run",
        };
      }
      if (input.delivery === "interrupt") {
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
        if (afterRun.actorSession === undefined) {
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
      if (run) {
        await deps.sessionAdmission.assertRunAccess(run.sessionId);
        return run.result;
      }
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) {
        await deps.sessionAdmission.assertRunAccess(persisted.sessionId);
        return resultFromStatus(persisted);
      }
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async get(runId) {
      deps.ensureOpen();
      const run = deps.runs.get(runId);
      if (run) {
        await deps.sessionAdmission.assertRunAccess(run.sessionId);
        return statusFromRecord(run);
      }
      const persisted = deps.persistence.loadRunStatus(runId);
      if (persisted) {
        await deps.sessionAdmission.assertRunAccess(persisted.sessionId);
        return persisted;
      }
      throw new Error(`Runtime run not found: ${runId}`);
    },

    async list(filter) {
      deps.ensureOpen();
      if (filter?.sessionId !== undefined) {
        await deps.sessionAdmission.assertRunAccess(filter.sessionId);
      }
      const matching = [...deps.runs.values()]
        .filter((run) => runMatchesFilter(run, filter))
        .map(statusFromRecord);
      return filterAdmittedRunStatuses(matching, deps.sessionAdmission);
    },

    async abort(runId) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      if (run.phase === "queued" || isActiveRunPhase(run.phase)) {
        cancelRun(run, "runtime run aborted", true);
      }
    },

    async setModel(runId, model) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      run.model = model;
      run.running?.setModel(model);
      publishRunUpdate(run);
    },

    async setProvider(runId, provider) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      run.provider = provider;
      run.running?.setProvider(provider);
      publishRunUpdate(run);
    },

    async setReasoning(runId, reasoning) {
      deps.ensureOpen();
      const run = getRecord(runId);
      await deps.sessionAdmission.assertRunAccess(run.sessionId);
      run.reasoning = reasoning;
      run.running?.setReasoning(reasoning);
      publishRunUpdate(run);
    },

    closeAll(reason) {
      settingsSubscription.close();
      for (const run of deps.runs.values()) {
        if (run.phase === "queued" || isActiveRunPhase(run.phase)) {
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
  plane?: AgentExecutorPlane,
  defaultContext?: AgentDispatchContext,
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
        },
        isOwnerAlive: isRuntimeActorOwnerAlive,
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

function isRuntimeActorOwnerAlive(owner: AgentActorOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ESRCH"
    );
  }
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
    async wait(sessionId, afterSequence, timeoutMs) {
      const root = await withRoot(sessionId, (actorRoot) => actorRoot);
      return root.wait(afterSequence, timeoutMs);
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
  readonly runs: Map<string, RuntimeRunRecord>;
  readonly sessionManager: SessionManager;
  readonly sessionAdmission: RuntimeSessionAdmission;
  readonly workflows: RuntimeWorkflowService;
  readonly actors: RuntimeAgentActorRegistry;
}): RuntimeStatusService {
  return {
    async snapshot() {
      const runs = await filterAdmittedRunStatuses(
        [...deps.runs.values()].map(statusFromRecord),
        deps.sessionAdmission,
      );
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
      const runs = await filterAdmittedRunStatuses(
        [...deps.runs.values()].map(statusFromRecord),
        deps.sessionAdmission,
      );
      const activeRuns = runs.filter(
        (run) =>
          run.phase === "running" ||
          run.phase === "waiting_permission" ||
          run.phase === "waiting_user_input",
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

function createRuntimeEventBus(persistence: RuntimePersistence) {
  let closed = false;
  const events: RuntimeEvent[] = [];
  const liveBySession = new Map<string, RuntimeSessionLiveProjectionState>();
  const latestSeqBySession = new Map<string, number>();
  const subscribers = new Set<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }>();

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

  const createEvent = (
    type: RuntimeEventType,
    payload: unknown,
    scope: {
      readonly sessionId: string;
      readonly runId: string;
      readonly turnId?: string;
    },
  ): RuntimeEvent => {
    const seq = persistence.nextEventSeq();
    return {
      id: `evt_${seq}_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
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

  const service: RuntimeEventService = {
    subscribe(filter, listener) {
      if (closed) {
        throw new Error("KodaX runtime event bus is closed");
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
    emit(
      type: RuntimeEventType,
      payload: unknown,
      scope: {
        readonly sessionId: string;
        readonly runId: string;
        readonly turnId?: string;
      },
    ): RuntimeEvent {
      const event = createEvent(type, payload, scope);
      latestSeqBySession.set(event.sessionId, event.seq);
      const live =
        liveBySession.get(event.sessionId) ??
        createRuntimeSessionLiveProjectionState();
      liveBySession.set(event.sessionId, live);
      applyRuntimeSessionEvent(live, event);
      remember(event);
      const notifyEvents: RuntimeEvent[] = [event];
      try {
        persistence.appendEvent(event);
      } catch (error: unknown) {
        const warning = createEvent(
          "runtime.warning",
          {
            message: normalizeError(error).message,
            sourceEventId: event.id,
          },
          scope,
        );
        remember(warning);
        notifyEvents.push(warning);
      }
      for (const emitted of notifyEvents) notify(emitted);
      return event;
    },
    emitDurable(
      type: RuntimeEventType,
      payload: unknown,
      scope: {
        readonly sessionId: string;
        readonly runId: string;
        readonly turnId?: string;
      },
      afterPersist?: () => void,
    ): RuntimeEvent {
      const event = createEvent(type, payload, scope);
      persistence.appendDurableEvent(event);
      afterPersist?.();
      latestSeqBySession.set(event.sessionId, event.seq);
      const live =
        liveBySession.get(event.sessionId) ??
        createRuntimeSessionLiveProjectionState();
      liveBySession.set(event.sessionId, live);
      applyRuntimeSessionEvent(live, event);
      remember(event);
      notify(event);
      return event;
    },
    projectSession(sessionId: string): RuntimeSessionLiveProjection {
      const live = liveBySession.get(sessionId);
      return live === undefined
        ? snapshotRuntimeSessionLiveProjection(
            createRuntimeSessionLiveProjectionState(),
          )
        : snapshotRuntimeSessionLiveProjection(live);
    },
    currentSessionSeq(sessionId: string): number {
      const current = latestSeqBySession.get(sessionId);
      if (current !== undefined) return current;
      const recovered = latestRuntimeEventSeq(
        persistence.replay({ sessionId }),
      );
      latestSeqBySession.set(sessionId, recovered);
      return recovered;
    },
    close() {
      closed = true;
      try {
        persistence.close();
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: "runtime.persistence",
          level: "error",
          message: "Failed to flush runtime events while closing",
          detail: error,
        });
      }
      subscribers.clear();
      liveBySession.clear();
      latestSeqBySession.clear();
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
  const permissionGrantsFile = path.join(runtimeDir, "permission-grants.json");
  const eventSequenceFile = path.join(runtimeDir, "event-sequence");
  const bufferedEventLines = new Map<string, string[]>();
  let bufferedEventBytes = 0;
  let scheduledEventFlush: ReturnType<typeof setTimeout> | undefined;
  let deferredAppendError: Error | undefined;
  let nextSequence: number | undefined;
  let sequenceDirty = false;

  const runDir = (runId: string): string =>
    path.join(runsDir, encodeURIComponent(runId));
  const eventFile = (runId: string): string =>
    path.join(runDir(runId), "events.jsonl");
  const statusFile = (runId: string): string =>
    path.join(runDir(runId), "status.json");
  const sessionSettingsFile = (sessionId: string): string =>
    path.join(sessionSettingsDir, `${encodeURIComponent(sessionId)}.json`);
  const persistenceWarnings: RuntimeEvent[] = [];
  const persistenceWarningKeys = new Set<string>();

  const findMaxPersistedEventSeq = (): number => {
    let maxSeq = 0;
    if (fs.existsSync(eventSequenceFile)) {
      try {
        const persisted = Number.parseInt(
          fs.readFileSync(eventSequenceFile, "utf-8").trim(),
          10,
        );
        if (Number.isSafeInteger(persisted) && persisted > 0)
          maxSeq = persisted;
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
    if (!fs.existsSync(runsDir)) return maxSeq;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(runsDir, entry.name, "events.jsonl");
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      const readBytes = Math.min(size, MAX_RUNTIME_EVENT_SEQUENCE_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(readBytes);
      const descriptor = fs.openSync(file, "r");
      try {
        fs.readSync(descriptor, buffer, 0, readBytes, size - readBytes);
      } finally {
        fs.closeSync(descriptor);
      }
      const lines = buffer.toString("utf-8").split(/\r?\n/);
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
    scope: {
      readonly runId?: string;
      readonly sessionId?: string;
      readonly file?: string;
    },
  ): void => {
    if (persistenceWarningKeys.has(key)) return;
    persistenceWarningKeys.add(key);
    const seq = allocateEventSeq();
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

  const trimEventFile = (file: string): void => {
    if (fs.statSync(file).size <= MAX_RUNTIME_EVENT_FILE_BYTES) return;
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split(/\r?\n/);
    const kept: string[] = [];
    let keptBytes = 0;
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
    }
    kept.reverse();
    fs.writeFileSync(
      file,
      kept.length > 0 ? `${kept.join("\n")}\n` : "",
      "utf-8",
    );
  };

  const flushBufferedEvents = (): void => {
    if (scheduledEventFlush !== undefined) {
      clearTimeout(scheduledEventFlush);
      scheduledEventFlush = undefined;
    }
    for (const [runId, lines] of bufferedEventLines) {
      const content = lines.join("");
      const contentBytes = Buffer.byteLength(content, "utf-8");
      const dir = runDir(runId);
      const file = eventFile(runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, content, "utf-8");
      bufferedEventLines.delete(runId);
      bufferedEventBytes = Math.max(0, bufferedEventBytes - contentBytes);
      trimEventFile(file);
    }
    if (sequenceDirty && nextSequence !== undefined) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(eventSequenceFile, String(nextSequence - 1), "utf-8");
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
          source: "runtime.persistence",
          level: "error",
          message: "Failed to flush buffered runtime events",
          detail: error,
        });
      }
    }, RUNTIME_EVENT_FLUSH_INTERVAL_MS);
    scheduledEventFlush.unref?.();
  };

  return {
    runtimeDir,
    appendDurableEvent(event) {
      flushBufferedEvents();
      const dir = runDir(event.runId);
      const file = eventFile(event.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
      try {
        trimEventFile(file);
      } catch (error: unknown) {
        pushPersistenceWarning(
          `${file}:trim`,
          `Failed to trim runtime event file: ${normalizeError(error).message}`,
          { runId: event.runId, file },
        );
      }
    },
    appendEvent(event) {
      const line = `${JSON.stringify(event)}\n`;
      const lines = bufferedEventLines.get(event.runId) ?? [];
      lines.push(line);
      bufferedEventLines.set(event.runId, lines);
      bufferedEventBytes += Buffer.byteLength(line, "utf-8");

      const previousError = deferredAppendError;
      deferredAppendError = undefined;
      try {
        if (
          previousError !== undefined ||
          !BUFFERED_RUNTIME_EVENT_TYPES.has(event.type) ||
          bufferedEventBytes >= MAX_RUNTIME_BUFFERED_EVENT_BYTES
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
    currentEventSeq() {
      if (nextSequence === undefined) {
        nextSequence = findMaxPersistedEventSeq() + 1;
      }
      return nextSequence - 1;
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
      writeRuntimeJsonAtomic(statusFile(status.runId), status);
    },
    loadRunStatus(runId) {
      const file = statusFile(runId);
      if (!fs.existsSync(file)) return undefined;
      try {
        const status = parseRuntimeRunStatus(
          JSON.parse(fs.readFileSync(file, "utf-8")),
        );
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
        const file = path.join(runsDir, entry.name, "status.json");
        if (!fs.existsSync(file)) continue;
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
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
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf-8",
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
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
    (value.deliveredAt !== undefined && typeof value.deliveredAt !== "string")
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
    ...(origin !== undefined ? { origin } : {}),
  };
}

function isRuntimeRunPhase(value: unknown): value is RuntimeRunPhase {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting_permission" ||
    value === "waiting_user_input" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
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

function recordFromPersistedStatus(status: RuntimeRunStatus): RuntimeRunRecord {
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    ...(status.turnId !== undefined ? { turnId: status.turnId } : {}),
    phase: status.phase,
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
    ...(status.terminal !== undefined ? { terminal: status.terminal } : {}),
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
  };
}

function interruptPersistedNonTerminalRun(
  status: RuntimeRunStatus,
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
): RuntimeRunStatus {
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
  const durableTerminal = [...durableEvents].reverse().find((event) => {
    if (!isTerminalRuntimeEvent(event.type)) return false;
    const eventStatus = parseRuntimeRunStatus(event.payload);
    return (
      eventStatus?.runId === reconciledStatus.runId &&
      eventStatus.sessionId === reconciledStatus.sessionId &&
      eventStatus.phase === terminalPhaseFromEvent(event.type)
    );
  });
  if (durableTerminal !== undefined) {
    const recovered = parseRuntimeRunStatus(durableTerminal.payload);
    if (recovered !== undefined) {
      const reconciled = reconcilePersistedInterruptDeliveries(
        recovered,
        durableEvents,
      );
      saveRunStatusSafely(bus, persistence, undefined, reconciled);
      return reconciled;
    }
  }
  const reason: RuntimeTerminalCode =
    reconciledStatus.phase === "queued"
      ? "runtime_restarted"
      : "daemon_crashed";
  const recovered: RuntimeRunStatus = {
    ...reconciledStatus,
    phase: "interrupted",
    endedAt: new Date().toISOString(),
    error: reason,
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
  bus.emit("run.interrupted", recovered, {
    sessionId: recovered.sessionId,
    runId: recovered.runId,
    ...(recovered.turnId !== undefined ? { turnId: recovered.turnId } : {}),
  });
  saveRunStatusSafely(bus, persistence, undefined, recovered);
  return recovered;
}

function reconcilePersistedInterruptDeliveries(
  status: RuntimeRunStatus,
  events: readonly RuntimeEvent[],
): RuntimeRunStatus {
  if (status.interruptInputs === undefined) return status;
  const deliveredAtByInputId = new Map<string, string>();
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
        typeof input.deliveredAt !== "string"
      )
        continue;
      deliveredAtByInputId.set(input.inputId, input.deliveredAt);
    }
  }
  let changed = false;
  const interruptInputs = status.interruptInputs.map((input) => {
    const deliveredAt = deliveredAtByInputId.get(input.inputId);
    if (input.state !== "queued" || deliveredAt === undefined) return input;
    changed = true;
    return { ...input, state: "delivered" as const, deliveredAt };
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
  readonly onMidTurnUserMessages: (queuedMessageIds: readonly string[]) => void;
}): KodaXEvents {
  const {
    bus,
    original,
    permissions,
    userInputs,
    enableSharedInteractions,
    record,
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
  const runWithUserInputPhase = async <T>(
    kind: RuntimeUserInputKind,
    options: unknown,
    meta: KodaXToolEventMeta | undefined,
    execute: (() => Promise<T>) | undefined,
    dismissed: T,
  ): Promise<T> => {
    const previousPhase = record.phase;
    if (record.phase === "running") {
      record.phase = "waiting_user_input";
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
        if (record.phase === "waiting_user_input") record.phase = previousPhase;
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
        record.phase = previousPhase;
      }
    }
  };

  return {
    ...original,
    onTextDelta(text, meta) {
      emit("assistant.delta", { text, meta }, meta);
      original?.onTextDelta?.(text, meta);
    },
    onThinkingDelta(text, meta) {
      emit("thinking.delta", { text, meta }, meta);
      original?.onThinkingDelta?.(text, meta);
    },
    onThinkingEnd(thinking, meta) {
      emit("thinking.finished", { thinking, meta }, meta);
      original?.onThinkingEnd?.(thinking, meta);
    },
    onToolUseStart(tool, meta) {
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
      onMidTurnUserMessages(meta?.queuedMessageIds ?? []);
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
      if (record.mode !== "managed_task") {
        record.interruptInputOpen = false;
      }
      emit("run.progress", { kind: "complete", meta }, meta);
      original?.onComplete?.(meta);
    },
    onError(error, meta) {
      record.interruptInputOpen = false;
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
        record.phase = "waiting_permission";
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
          record.phase = previousPhase === "queued" ? "running" : previousPhase;
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
): Promise<KodaXSessionData> {
  const data = await manager.loadSession(sessionId);
  if (!data) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return data;
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
  ): Promise<KodaXSessionData> => {
    const data = await loadRequiredSession(manager, sessionId);
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
    async admitsSession(sessionId) {
      if (!enforced) return true;
      const data = await manager.loadSession(sessionId);
      return (
        data !== null &&
        admitted(data.runtimeInfo?.surface, data.runtimeInfo?.profileId)
      );
    },
    async assertRunAccess(sessionId) {
      if (!enforced) return;
      await loadAdmitted(sessionId);
    },
    async loadRequired(sessionId) {
      return loadAdmitted(sessionId);
    },
    async loadExecutable(sessionId) {
      const data = await loadAdmitted(sessionId);
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
  return `sha256:${createHash("sha256").update(JSON.stringify(transcript)).digest("hex")}`;
}

interface RuntimeTranscriptPageCursor {
  readonly kind: "page";
  readonly revision: string;
  readonly end: number;
}

interface RuntimeTranscriptChunkCursor {
  readonly kind: "entry";
  readonly revision: string;
  readonly entryIndex: number;
  readonly offset: number;
}

function encodeRuntimeTranscriptCursor(
  cursor: RuntimeTranscriptPageCursor | RuntimeTranscriptChunkCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRuntimeTranscriptCursor(
  cursor: string,
): RuntimeTranscriptPageCursor | RuntimeTranscriptChunkCursor {
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
  if (
    value.kind === "page" &&
    Number.isSafeInteger(value.end) &&
    Number(value.end) >= 0
  ) {
    return {
      kind: "page",
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
      revision: value.revision,
      entryIndex: Number(value.entryIndex),
      offset: Number(value.offset),
    };
  }
  throw createRuntimeResyncError("Invalid transcript cursor payload");
}

function createRuntimeTranscriptSlice(
  transcript: RuntimeTranscript,
  cursor?: string,
  requestedLimit?: number,
): RuntimeTranscriptSlice {
  const revision = createRuntimeTranscriptRevision(transcript);
  const limit = requestedLimit ?? DEFAULT_RUNTIME_TRANSCRIPT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("transcript page limit must be a positive safe integer");
  }
  const normalizedLimit = Math.min(limit, MAX_RUNTIME_TRANSCRIPT_PAGE_LIMIT);
  let end = transcript.transcriptEntries.length;
  if (cursor !== undefined) {
    const parsed = decodeRuntimeTranscriptCursor(cursor);
    if (parsed.kind !== "page" || parsed.revision !== revision) {
      throw createRuntimeResyncError(
        "Transcript cursor is stale; request a fresh observation snapshot",
      );
    }
    end = Math.min(parsed.end, transcript.transcriptEntries.length);
  }

  const entries: RuntimeTranscriptSliceEntry[] = [];
  let encodedBytes = 0;
  let start = end;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (entries.length >= normalizedLimit) break;
    const entry = transcript.transcriptEntries[index]!;
    const serialized = JSON.stringify(entry);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    const item: RuntimeTranscriptSliceEntry = {
      index,
      ...(typeof entry.entryId === "string" ? { entryId: entry.entryId } : {}),
      byteLength,
      oversized: byteLength > MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES,
      ...(byteLength <= MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES
        ? { entry }
        : {}),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (
      entries.length > 0 &&
      encodedBytes + itemBytes > MAX_RUNTIME_TRANSCRIPT_PAGE_BYTES
    ) {
      break;
    }
    entries.unshift(item);
    encodedBytes += itemBytes;
    start = index;
  }
  const hasMore = start > 0;
  return {
    revision,
    entries,
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeRuntimeTranscriptCursor({
            kind: "page",
            revision,
            end: start,
          }),
        }
      : {}),
  };
}

function createRuntimeTranscriptEntryChunkFromEncoded(
  input: RuntimeTranscriptEntryChunkInput,
  revision: string,
  entryId: string | undefined,
  encoded: Buffer,
): RuntimeTranscriptEntryChunk {
  if (input.revision !== revision) {
    throw createRuntimeResyncError(
      "Transcript revision changed; request a fresh observation snapshot",
    );
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    const parsed = decodeRuntimeTranscriptCursor(input.cursor);
    if (
      parsed.kind !== "entry" ||
      parsed.revision !== revision ||
      parsed.entryIndex !== input.entryIndex
    ) {
      throw createRuntimeResyncError(
        "Transcript entry cursor is stale; restart entry retrieval",
      );
    }
    offset = parsed.offset;
  }
  if (offset > encoded.length) {
    throw createRuntimeResyncError("Transcript entry cursor offset is invalid");
  }
  const nextOffset = Math.min(
    encoded.length,
    offset + MAX_RUNTIME_TRANSCRIPT_CHUNK_BYTES,
  );
  const hasMore = nextOffset < encoded.length;
  return {
    revision,
    entryIndex: input.entryIndex,
    ...(entryId !== undefined ? { entryId } : {}),
    encoding: "base64-json",
    data: encoded.subarray(offset, nextOffset).toString("base64"),
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeRuntimeTranscriptCursor({
            kind: "entry",
            revision,
            entryIndex: input.entryIndex,
            offset: nextOffset,
          }),
        }
      : {}),
  };
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
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
  };
}

function statusFromRecord(run: RuntimeRunRecord): RuntimeRunStatus {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    phase: run.phase,
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
    ...(run.terminal !== undefined ? { terminal: run.terminal } : {}),
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
  };
}

function recentRunStatuses(
  statuses: readonly RuntimeRunStatus[],
): readonly RuntimeRunStatus[] {
  if (statuses.length <= MAX_RUNTIME_MEMORY_RUNS) return statuses;
  return [...statuses]
    .sort(compareRunStatusRecency)
    .slice(-MAX_RUNTIME_MEMORY_RUNS);
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

function markRunTerminal(
  bus: RuntimeEventBus,
  persistence: RuntimePersistence,
  run: RuntimeRunRecord,
  phase: RuntimeRunPhase,
  terminal?: Omit<RuntimeTerminalFact, "revision" | "kind">,
): void {
  if (run.terminalEmitted) return;
  run.interruptInputOpen = false;
  terminalizeQueuedInterruptInputs(run);
  run.phase = phase;
  run.endedAt = new Date().toISOString();
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
  saveRunStatusSafely(bus, persistence, run, statusFromRecord(run));
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
): void {
  try {
    persistence.saveRunStatus(status);
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
  }
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
  const cacheKey = JSON.stringify([
    process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot,
    process.platform === "win32" ? executionCwd.toLowerCase() : executionCwd,
    engine,
    input.settings.autoModeClassifierModel ?? null,
    input.settings.autoModeTimeoutMs ?? null,
    input.settings.autoModeSpeculativeWindowMs ?? null,
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
      if (record.phase === "running") record.phase = "waiting_permission";
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
          record.phase = previousPhase === "queued" ? "running" : previousPhase;
        }
      }
    },
    projectRoot,
    executionCwd,
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
  hasActiveRun: (candidateSessionId: string) => boolean,
): void {
  if (!hasActiveRun(sessionId)) return;
  const error = new Error(
    `Session has an active run and cannot be mutated: ${sessionId}`,
  );
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: "conflict",
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
