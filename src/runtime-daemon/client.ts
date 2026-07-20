import { randomUUID } from 'node:crypto';

import type {
  KodaXDaemonRuntime,
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeCredentialBroker,
  RuntimeCredentialLease,
  RuntimeConfigReloadResult,
  RuntimeConfigPatch,
  RuntimeConnectionState,
  RuntimeContextBudgetSnapshot,
  RuntimeCommandResolveInput,
  RuntimeCommandInfo,
  RuntimeCreateArtifactInput,
  RuntimeArtifact,
  RuntimeDiagnosticFilter,
  RuntimeDaemonPreflight,
  RuntimeDaemonManagementState,
  RuntimeDaemonRollbackInput,
  RuntimeDaemonRollbackResult,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeExtensionListResult,
  RuntimeIdentity,
  RuntimeGrantedScope,
  RuntimeHostToolDescriptor,
  RuntimeHostToolHandler,
  RuntimeHostToolInvocationStatus,
  RuntimeHostToolLease,
  RuntimeHostToolResult,
  RuntimeMcpReloadResult,
  RuntimeMcpToolListFilter,
  RuntimeMcpValidateResult,
  RuntimeModelListFilter,
  RuntimeOperationOptions,
  RuntimePermissionDecision,
  RuntimePermissionFilter,
  RuntimePermissionRequest,
  RuntimePermissionRequestInput,
  RuntimePermissionRespondOptions,
  RuntimeRunFilter,
  RuntimeRunHandle,
  RuntimeRunResult,
  RuntimeRunStatus,
  RuntimeSession,
  RuntimeSessionObservation,
  RuntimeSessionObservationSnapshot,
  RuntimeSessionSettings,
  RuntimeSessionSummary,
  RuntimeSkillDescribeInput,
  RuntimeSkillDescription,
  RuntimeSkillListFilter,
  RuntimeSkillSummary,
  RuntimeDaemonStartRunInput,
  RuntimeStatusSnapshot,
  RuntimeSubscription,
  RuntimeToolExposurePlan,
  RuntimeTranscript,
  RuntimeUserInputRequest,
  RuntimeUserInputResolution,
  RuntimeWorkflowFilter,
  RuntimeWorkflowListener,
  RuntimeWorkflowSnapshot,
  RuntimeWorkflowSummary,
} from '../sdk-runtime.js';
import { parseRuntimeEvent } from '../runtime-event.js';
import type {
  LearningEvent,
  McpServerConfig,
  McpServerToolList,
} from '@kodax-ai/agent';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type {
  RuntimeDaemonMethod,
  RuntimeDaemonNotification,
  RuntimeDaemonOperationEnvelope,
} from './protocol.js';
import { isRuntimeDaemonMutationMethod } from './protocol.js';

const MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS = 256;
const MAX_RETAINED_HOST_TOOL_RESULTS = 1_000;

interface HostToolInvocationResult {
  readonly promise: Promise<RuntimeHostToolResult>;
  settled: boolean;
}

export interface RuntimeDaemonClientTransport {
  request(
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeDaemonOperationEnvelope,
  ): Promise<unknown>;
  subscribe(listener: (notification: RuntimeDaemonNotification) => void): RuntimeSubscription;
  subscribeLifecycle?(
    listener: (state: RuntimeDaemonTransportLifecycleState) => void,
  ): RuntimeSubscription;
  close?(): Promise<void> | void;
}

export interface RuntimeDaemonTransportLifecycleState {
  readonly state: 'connected' | 'disconnected';
  readonly connectionId: string;
  readonly reason?: string;
  readonly reconnectable: boolean;
}

export class RuntimeTransportBoundaryError extends Error {
  readonly code = 'invalid_transport_value' as const;

  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'RuntimeTransportBoundaryError';
  }
}

export class RuntimeDaemonUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'actorControlPlane' as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise actorControlPlane v1. Upgrade KodaX and restart the daemon before using Runtime Actor control.',
    );
    this.name = 'RuntimeDaemonUpgradeRequiredError';
  }
}

export class RuntimePermissionScopeUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'runtimeAutoModeGuardrail' as const;
  readonly requiredVersion = 3 as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise concrete permission scopes. Upgrade KodaX and restart the daemon before requesting grants for a concrete tool call.',
    );
    this.name = 'RuntimePermissionScopeUpgradeRequiredError';
  }
}

export interface RuntimeDaemonClientOptions {
  readonly identity: RuntimeIdentity;
  readonly transport: RuntimeDaemonClientTransport;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly journalEpoch?: string;
  readonly grantedScopes?: readonly RuntimeGrantedScope[];
}

type RuntimeDaemonPreflightWire = Omit<
  RuntimeDaemonPreflight,
  'activeAgentTurns' | 'activeAgentTasks'
> & Partial<Pick<RuntimeDaemonPreflight, 'activeAgentTurns' | 'activeAgentTasks'>>;

type RuntimeDaemonManagementStateWire = Omit<RuntimeDaemonManagementState, 'preflight'> & {
  readonly preflight: RuntimeDaemonPreflightWire;
};

function normalizeRuntimeDaemonPreflight(
  value: RuntimeDaemonPreflightWire,
): RuntimeDaemonPreflight {
  const activeAgentTurns = value.activeAgentTurns ?? value.activeAgentTasks ?? [];
  return {
    ...value,
    activeAgentTurns,
    activeAgentTasks: activeAgentTurns,
  };
}

export function createRuntimeDaemonClient(
  options: RuntimeDaemonClientOptions,
): KodaXDaemonRuntime {
  const request = (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
  ): Promise<unknown> => options.transport.request(
    method,
    params,
    isRuntimeDaemonMutationMethod(method)
      ? createOperationEnvelope(options.journalEpoch, operation)
      : undefined,
  );
  const actorControlPlaneError = (): RuntimeDaemonUpgradeRequiredError | undefined => {
    const capability = options.capabilities?.actorControlPlane;
    if (
      typeof capability !== 'object'
      || capability === null
      || !('version' in capability)
      || capability.version !== 1
      || !('methodNamespace' in capability)
      || capability.methodNamespace !== 'agents'
    ) {
      return new RuntimeDaemonUpgradeRequiredError();
    }
    return undefined;
  };
  const concretePermissionScopeError = (): RuntimePermissionScopeUpgradeRequiredError | undefined => {
    const capability = options.capabilities?.runtimeAutoModeGuardrail;
    if (
      typeof capability !== 'object'
      || capability === null
      || !('version' in capability)
      || typeof capability.version !== 'number'
      || capability.version < 3
      || !('concretePermissionMatchers' in capability)
      || capability.concretePermissionMatchers !== true
      || !('permissionGrantSuggestions' in capability)
      || capability.permissionGrantSuggestions !== true
    ) {
      return new RuntimePermissionScopeUpgradeRequiredError();
    }
    return undefined;
  };
  const credentialBrokers = new Map<string, RuntimeCredentialBroker>();
  const hostToolHandlers = new Map<string, Readonly<Record<string, RuntimeHostToolHandler>>>();
  const hostToolResults = new Map<string, HostToolInvocationResult>();
  const connectionListeners = new Set<(state: RuntimeConnectionState) => void>();
  let connectionState: RuntimeConnectionState = {
    state: 'connected',
    connectionId: `connection_${randomUUID().replace(/-/g, '')}`,
    runtimeEpoch: options.identity.runtimeId,
    ...(options.journalEpoch !== undefined ? { journalEpoch: options.journalEpoch } : {}),
    reconnectable: false,
  };
  const transportLifecycleSubscription = options.transport.subscribeLifecycle?.((state) => {
    connectionState = {
      ...state,
      runtimeEpoch: options.identity.runtimeId,
      ...(options.journalEpoch !== undefined ? { journalEpoch: options.journalEpoch } : {}),
    };
    for (const listener of connectionListeners) {
      try {
        listener(connectionState);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.client',
          level: 'warn',
          message: 'Runtime connection lifecycle listener failed.',
          detail: { errorType: error instanceof Error ? error.name : typeof error },
        });
      }
    }
  });
  const reverseSubscription = options.transport.subscribe((notification) => {
    if (notification.method === 'credential.request') {
      void answerCredentialRequest(notification.params, credentialBrokers, request)
        .catch(() => reportReverseBridgeFailure('credential request'));
    } else if (notification.method === 'host_tool.invoke') {
      void answerHostToolInvocation(
        notification.params,
        hostToolHandlers,
        hostToolResults,
        request,
      ).catch(() => reportReverseBridgeFailure('host tool invocation'));
    }
  });

  return {
    identity: options.identity,
    capabilities: options.capabilities,
    ...(options.grantedScopes !== undefined ? { grantedScopes: options.grantedScopes } : {}),
    sessions: {
      create(input = {}) {
        const { operation, ...transportInput } = input;
        return request('session.create', transportInput, operation) as Promise<RuntimeSession>;
      },
      load(sessionId) {
        return request('session.load', { sessionId }) as Promise<RuntimeSession>;
      },
      list(filter) {
        return request('session.list', filter) as Promise<readonly RuntimeSessionSummary[]>;
      },
      transcript(sessionId) {
        return request('session.transcript', { sessionId }) as Promise<RuntimeTranscript | null>;
      },
      observe(sessionId, listener) {
        return observeDaemonSession(options.transport, request, sessionId, listener);
      },
      fork(input) {
        return request('session.fork', input) as Promise<RuntimeSession | null>;
      },
      getSettings(sessionId) {
        return request('session.settings.get', { sessionId }) as Promise<RuntimeSessionSettings>;
      },
      getSettingsVersioned(sessionId) {
        return request('session.settings.getVersioned', { sessionId }) as ReturnType<KodaXRuntime['sessions']['getSettingsVersioned']>;
      },
      getAutoModeStats(sessionId) {
        return request('session.autoMode.getStats', { sessionId }) as ReturnType<KodaXRuntime['sessions']['getAutoModeStats']>;
      },
      async updateSettings(sessionId, patch) {
        const current = await this.getSettingsVersioned(sessionId);
        return (await this.updateSettingsVersioned(
          sessionId,
          patch,
          { expectedRevision: current.revision },
        )).value;
      },
      updateSettingsVersioned(sessionId, patch, operation) {
        return request(
          'session.settings.updateVersioned',
          { sessionId, patch, expectedRevision: operation.expectedRevision },
          operation,
        ) as ReturnType<KodaXRuntime['sessions']['updateSettingsVersioned']>;
      },
      appendNotice(input) {
        return request('session.notice.append', input) as ReturnType<KodaXRuntime['sessions']['appendNotice']>;
      },
      rewind(input) {
        return request('session.rewind', input) as Promise<RuntimeSession | null>;
      },
      setActiveEntry(input) {
        return request('session.active_entry.set', input) as Promise<RuntimeSession | null>;
      },
      compact(input) {
        return request('session.compact', input) as Promise<RuntimeCompactSessionResult>;
      },
      async archive(sessionId) {
        await request('session.archive', { sessionId });
      },
      async unarchive(sessionId) {
        await request('session.unarchive', { sessionId });
      },
      async delete(sessionId) {
        await request('session.delete', { sessionId });
      },
    },
    runs: {
      async start(input: RuntimeDaemonStartRunInput): Promise<RuntimeRunHandle> {
        const { operation, ...transportInput } = input;
        assertRuntimeTransportSafe(transportInput, 'run.start');
        const started = requireRecord(await request('run.start', transportInput, operation));
        const runId = requireStringField(started, 'runId');
        const sessionId = requireStringField(started, 'sessionId');
        const turnId = optionalStringField(started, 'turnId');
        return {
          runId,
          sessionId,
          ...(turnId !== undefined ? { turnId } : {}),
          result: requestRuntimeRunResult(request, runId),
        };
      },
      async submitInput(input) {
        const { operation, ...transportInput } = input;
        assertRuntimeTransportSafe(transportInput, 'run.input.submit');
        return request('run.input.submit', transportInput, operation) as ReturnType<
          KodaXRuntime['runs']['submitInput']
        >;
      },
      await(runId) {
        return requestRuntimeRunResult(request, runId);
      },
      get(runId) {
        return request('run.get', { runId }) as Promise<RuntimeRunStatus>;
      },
      list(filter?: RuntimeRunFilter) {
        return request('run.list', filter) as Promise<readonly RuntimeRunStatus[]>;
      },
      async abort(runId) {
        await request('run.abort', { runId });
      },
      async setModel(runId, model) {
        await request('run.model.set', { runId, model });
      },
      async setProvider(runId, provider) {
        await request('run.provider.set', { runId, provider });
      },
      async setReasoning(runId, reasoning) {
        await request('run.reasoning.set', { runId, reasoning });
      },
    },
    events: {
      subscribe(filter, listener) {
        return subscribeToDaemonEvents(options.transport, request, filter, listener);
      },
      replay(filter) {
        return request('event.replay', filter).then((value) => {
          if (!Array.isArray(value)) throw new Error('Expected daemon event replay array.');
          return value.flatMap((item) => {
            const event = parseRuntimeEventForClient(item);
            return event === undefined ? [] : [event];
          });
        });
      },
    },
    permissions: {
      request(input: RuntimePermissionRequestInput) {
        if (input.toolInput !== undefined) {
          const unavailable = concretePermissionScopeError();
          if (unavailable) return Promise.reject(unavailable);
        }
        return request('permission.request', input) as Promise<RuntimePermissionDecision>;
      },
      listPending(filter?: RuntimePermissionFilter) {
        return request('permission.list', filter) as Promise<readonly RuntimePermissionRequest[]>;
      },
      respond(requestId: string, decision: RuntimePermissionDecision, options?: RuntimePermissionRespondOptions) {
        return request('permission.respond', {
          requestId,
          decision,
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<boolean>;
      },
      listGrants() {
        return request('permission.grants.list') as ReturnType<KodaXRuntime['permissions']['listGrants']>;
      },
      revokeGrant(grantId, expectedRevision) {
        return request('permission.grants.revoke', { grantId, expectedRevision }) as Promise<boolean>;
      },
    },
    userInputs: {
      listPending(filter) {
        return request('user_input.listPending', filter) as Promise<readonly RuntimeUserInputRequest[]>;
      },
      respond(requestId, answer, options) {
        return request('user_input.respond', {
          requestId,
          answer,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<RuntimeUserInputResolution>;
      },
      dismiss(requestId, options) {
        return request('user_input.dismiss', {
          requestId,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<RuntimeUserInputResolution>;
      },
    },
    credentials: {
      async register(input, broker) {
        const leaseId = `credlease_${randomUUID().replace(/-/g, '')}`;
        credentialBrokers.set(leaseId, broker);
        try {
          return await request('credential.register', {
            leaseId,
            providers: input.providers,
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          }) as RuntimeCredentialLease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async resume(leaseId, broker) {
        credentialBrokers.set(leaseId, broker);
        try {
          const value = await request('credential.get', { leaseId });
          if (value === null || value === undefined) {
            throw Object.assign(
              new Error(`Credential lease is unavailable after Runtime reconnect: ${leaseId}`),
              { code: 'credential_unavailable' as const },
            );
          }
          return requireRecord(value) as unknown as RuntimeCredentialLease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async revoke(leaseId) {
        const revoked = await request('credential.revoke', { leaseId }) as boolean;
        if (revoked) credentialBrokers.delete(leaseId);
        return revoked;
      },
    },
    hostTools: {
      async register(tools, handlers) {
        validateHostToolHandlers(tools, handlers);
        const leaseId = `hostlease_${randomUUID().replace(/-/g, '')}`;
        hostToolHandlers.set(leaseId, handlers);
        try {
          return await request('host_tool.register', { leaseId, tools }) as RuntimeHostToolLease;
        } catch (error: unknown) {
          hostToolHandlers.delete(leaseId);
          throw error;
        }
      },
      async resume(leaseId, handlers) {
        hostToolHandlers.set(leaseId, handlers);
        try {
          const value = await request('host_tool.get', { leaseId });
          if (value === null || value === undefined) {
            throw Object.assign(
              new Error(`Host tool lease is unavailable after Runtime reconnect: ${leaseId}`),
              { code: 'host_tool_unavailable' as const },
            );
          }
          const lease = requireRecord(value) as unknown as RuntimeHostToolLease;
          validateHostToolHandlers(lease.tools, handlers);
          return lease;
        } catch (error: unknown) {
          hostToolHandlers.delete(leaseId);
          throw error;
        }
      },
      async getInvocation(invocationId) {
        return nullToUndefined<RuntimeHostToolInvocationStatus>(
          await request('host_tool.invocation.get', { invocationId }),
        );
      },
      async revoke(leaseId) {
        const revoked = await request('host_tool.revoke', { leaseId }) as boolean;
        if (revoked) hostToolHandlers.delete(leaseId);
        return revoked;
      },
    },
    operations: {
      get(input) {
        return request('operation.get', input) as ReturnType<KodaXRuntime['operations']['get']>;
      },
    },
    workflows: {
      list(filter?: RuntimeWorkflowFilter) {
        return request('workflow.list', filter) as Promise<readonly RuntimeWorkflowSummary[]>;
      },
      get(runId: string) {
        return request('workflow.get', { runId }).then(nullToUndefined<RuntimeWorkflowSnapshot>);
      },
      subscribe(filter: RuntimeWorkflowFilter, listener: RuntimeWorkflowListener) {
        return subscribeToDaemonWorkflowEvents(options.transport, request, filter, listener);
      },
      pause(runId: string) {
        return request('workflow.pause', { runId }) as Promise<boolean>;
      },
      resume(runId: string) {
        return request('workflow.resume', { runId }) as Promise<boolean>;
      },
      stop(runId: string) {
        return request('workflow.stop', { runId }) as Promise<boolean>;
      },
    },
    learning: {
      list(query) {
        return request('learning.list', query ?? {}) as ReturnType<KodaXRuntime['learning']['list']>;
      },
      get(nameOrSlug) {
        return request('learning.get', { nameOrSlug }) as ReturnType<KodaXRuntime['learning']['get']>;
      },
      getSnapshot() {
        return request('learning.snapshot') as ReturnType<KodaXRuntime['learning']['getSnapshot']>;
      },
      events(afterRevision) {
        return request('learning.events', {
          ...(afterRevision !== undefined ? { afterRevision } : {}),
        }) as ReturnType<KodaXRuntime['learning']['events']>;
      },
      subscribe(subscribeOptions) {
        return pollRuntimeLearningEvents(request, subscribeOptions?.afterRevision ?? 0);
      },
      async acknowledge(nameOrSlug) {
        await request('learning.acknowledge', { nameOrSlug });
      },
      async snooze(nameOrSlug, until) {
        await request('learning.snooze', { nameOrSlug, until });
      },
      async reject(nameOrSlug) {
        await request('learning.reject', { nameOrSlug });
      },
      async disable(nameOrSlug) {
        await request('learning.disable', { nameOrSlug });
      },
      async rollback(nameOrSlug) {
        await request('learning.rollback', { nameOrSlug });
      },
      async promote(nameOrSlug, scope) {
        await request('learning.promote', { nameOrSlug, scope });
      },
      async review(nameOrSlug) {
        await request('learning.review', { nameOrSlug });
      },
      async trust(nameOrSlug) {
        await request('learning.trust', { nameOrSlug });
      },
    },
    config: {
      read() {
        return request('config.read');
      },
      patch(patch: RuntimeConfigPatch) {
        return request('config.patch', { patch });
      },
      reload() {
        return request('config.reload') as Promise<RuntimeConfigReloadResult>;
      },
    },
    catalog: {
      providers() {
        return request('provider.list');
      },
      models(filter?: RuntimeModelListFilter) {
        return request('model.list', filter);
      },
      commands(projectRoot?: string) {
        return request(
          'command.list',
          projectRoot !== undefined ? { projectRoot } : undefined,
        ) as Promise<readonly RuntimeCommandInfo[]>;
      },
      resolveCommand(input: RuntimeCommandResolveInput) {
        return request('command.resolve', input) as Promise<RuntimeCommandInfo | null>;
      },
      skills(filter?: RuntimeSkillListFilter) {
        return request('skill.list', filter) as Promise<readonly RuntimeSkillSummary[]>;
      },
      describeSkill(input: RuntimeSkillDescribeInput) {
        return request('skill.describe', input) as Promise<RuntimeSkillDescription | null>;
      },
      customProviders() {
        return request('provider.custom.list') as ReturnType<KodaXRuntime['catalog']['customProviders']>;
      },
      upsertCustomProvider(config) {
        return request('provider.custom.upsert', { config }) as ReturnType<KodaXRuntime['catalog']['upsertCustomProvider']>;
      },
      deleteCustomProvider(name: string) {
        return request('provider.custom.remove', { name }) as Promise<boolean>;
      },
      extensions() {
        return request('extension.list') as Promise<RuntimeExtensionListResult>;
      },
      reloadExtensions() {
        return request('extension.reload') as ReturnType<KodaXRuntime['catalog']['reloadExtensions']>;
      },
    },
    mcp: {
      listServers() {
        return request('mcp.server.list') as Promise<Record<string, McpServerConfig>>;
      },
      getServer(name: string) {
        return request('mcp.server.get', { name }).then(nullToUndefined<McpServerConfig>);
      },
      validateServer(name: string, config: unknown) {
        return request('mcp.server.validate', { name, config }) as Promise<RuntimeMcpValidateResult>;
      },
      upsertServer(name: string, config: McpServerConfig) {
        return request('mcp.server.upsert', { name, config }) as Promise<McpServerConfig>;
      },
      deleteServer(name: string) {
        return request('mcp.server.delete', { name }) as Promise<boolean>;
      },
      reloadServers() {
        return request('mcp.server.reload') as Promise<RuntimeMcpReloadResult>;
      },
      listTools(filter?: RuntimeMcpToolListFilter) {
        return request('mcp.tool.list', filter) as Promise<readonly McpServerToolList[]>;
      },
    },
    artifacts: {
      create(input: RuntimeCreateArtifactInput) {
        return request('artifact.create', input) as Promise<RuntimeArtifact>;
      },
      get(artifactId: string) {
        return request('artifact.get', { artifactId }).then(nullToUndefined<RuntimeArtifact>);
      },
      delete(artifactId: string) {
        return request('artifact.delete', { artifactId }) as Promise<boolean>;
      },
    },
    admin: {
      agentRegistrations: {
        list() {
          return request('agentRegistrations.list') as ReturnType<KodaXRuntime['admin']['agentRegistrations']['list']>;
        },
        upsert(registration, options) {
          assertRuntimeTransportSafe(registration, 'agentRegistrations.upsert.registration');
          return request('agentRegistrations.upsert', {
            registration,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
          }) as ReturnType<KodaXRuntime['admin']['agentRegistrations']['upsert']>;
        },
        setEnabled(agentId, enabled, options) {
          return request('agentRegistrations.setEnabled', {
            agentId,
            enabled,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
            ...(options?.claimOwner !== undefined ? { claimOwner: options.claimOwner } : {}),
          })
            .then(nullToUndefined<Awaited<ReturnType<KodaXRuntime['admin']['agentRegistrations']['setEnabled']>>>);
        },
        remove(agentId, options) {
          return request('agentRegistrations.remove', {
            agentId,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
          }) as Promise<boolean>;
        },
      },
    },
    agents: {
      enabled: options.capabilities?.externalAgents === true,
      listDispatchable(query) {
        return request('agents.listDispatchable', query) as ReturnType<KodaXRuntime['agents']['listDispatchable']>;
      },
      describe(agentId, query) {
        return request('agents.describe', { agentId, query })
          .then(nullToUndefined<Awaited<ReturnType<KodaXRuntime['agents']['describe']>>>);
      },
      preflight(input) {
        return request('agents.preflight', input) as ReturnType<KodaXRuntime['agents']['preflight']>;
      },
      tree(sessionId) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.tree', { sessionId }) as ReturnType<KodaXRuntime['agents']['tree']>;
      },
      detail(sessionId, actorPath) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.detail', { sessionId, actorPath }) as ReturnType<
          KodaXRuntime['agents']['detail']
        >;
      },
      spawn(sessionId, input) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        assertRuntimeTransportSafe(input, 'agents.spawn');
        return request('agents.spawn', { sessionId, input }) as ReturnType<
          KodaXRuntime['agents']['spawn']
        >;
      },
      async send(sessionId, actorPath, content, classification) {
        const unavailable = actorControlPlaneError();
        if (unavailable) throw unavailable;
        await request('agents.send', {
          sessionId,
          actorPath,
          content,
          ...(classification !== undefined ? { classification } : {}),
        });
      },
      followup(sessionId, actorPath, objective, options) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.followup', {
          sessionId,
          actorPath,
          objective,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
        }) as ReturnType<
          KodaXRuntime['agents']['followup']
        >;
      },
      async interrupt(sessionId, actorPath, reason) {
        const unavailable = actorControlPlaneError();
        if (unavailable) throw unavailable;
        await request('agents.interrupt', {
          sessionId,
          actorPath,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
      output(sessionId, actorPath, turnId) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.output', {
          sessionId,
          actorPath,
          ...(turnId !== undefined ? { turnId } : {}),
        }) as ReturnType<KodaXRuntime['agents']['output']>;
      },
      events(sessionId, afterSequence) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.events', {
          sessionId,
          ...(afterSequence !== undefined ? { afterSequence } : {}),
        }) as ReturnType<KodaXRuntime['agents']['events']>;
      },
      wait(sessionId, afterSequence, timeoutMs) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.wait', {
          sessionId,
          ...(afterSequence !== undefined ? { afterSequence } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }).then(nullToUndefined<Awaited<ReturnType<KodaXRuntime['agents']['wait']>>>);
      },
    },
    status: {
      snapshot() {
        return request('daemon.status') as Promise<RuntimeStatusSnapshot>;
      },
      preflight() {
        return request('daemon.preflight').then((value) => (
          normalizeRuntimeDaemonPreflight(value as RuntimeDaemonPreflightWire)
        ));
      },
    },
    daemon: {
      inspect() {
        return request('daemon.management.get').then((value) => {
          const state = value as RuntimeDaemonManagementStateWire;
          return {
            ...state,
            preflight: normalizeRuntimeDaemonPreflight(state.preflight),
          };
        });
      },
      stopForInline(input: RuntimeDaemonRollbackInput) {
        const { operation, ...params } = input;
        return request(
          'daemon.rollbackToInline',
          params,
          operation,
        ) as Promise<RuntimeDaemonRollbackResult>;
      },
    },
    diagnostics: {
      latestContextBudget(filter?: RuntimeDiagnosticFilter) {
        return request('context.budget.get', filter) as Promise<RuntimeContextBudgetSnapshot | null>;
      },
      latestToolExposure(filter?: RuntimeDiagnosticFilter) {
        return request('tool.exposure.preview', filter) as Promise<RuntimeToolExposurePlan | null>;
      },
    },
    connection: {
      current() {
        return connectionState;
      },
      subscribe(listener) {
        connectionListeners.add(listener);
        listener(connectionState);
        return {
          close() {
            connectionListeners.delete(listener);
          },
        };
      },
    },
    async close() {
      transportLifecycleSubscription?.close();
      reverseSubscription.close();
      connectionListeners.clear();
      credentialBrokers.clear();
      hostToolHandlers.clear();
      hostToolResults.clear();
      await options.transport.close?.();
    },
  };
}

async function* pollRuntimeLearningEvents(
  request: (method: RuntimeDaemonMethod, params?: unknown) => Promise<unknown>,
  initialRevision: number,
): AsyncIterable<LearningEvent> {
  let revision = initialRevision;
  while (true) {
    const events = await request('learning.events', { afterRevision: revision }) as readonly LearningEvent[];
    if (events.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      continue;
    }
    for (const event of events) {
      revision = event.sequence;
      yield event;
    }
  }
}

function reportReverseBridgeFailure(kind: string): void {
  emitKodaXDiagnostic({
    source: 'runtime.daemon.client',
    level: 'warn',
    message: `Failed to deliver ${kind} result to the Runtime daemon.`,
  });
}

async function answerCredentialRequest(
  params: unknown,
  brokers: ReadonlyMap<string, RuntimeCredentialBroker>,
  request: (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
  ) => Promise<unknown>,
): Promise<void> {
  const payload = requireRecord(params);
  const requestId = requireStringField(payload, 'requestId');
  const leaseId = requireStringField(payload, 'leaseId');
  const broker = brokers.get(leaseId);
  if (!broker) {
    await request('credential.supply', { requestId, error: 'credential_lease_unavailable' });
    return;
  }
  try {
    const credential = await broker({
      leaseId,
      provider: requireStringField(payload, 'provider'),
      sessionId: requireStringField(payload, 'sessionId'),
      runId: requireStringField(payload, 'runId'),
    });
    await request('credential.supply', {
      requestId,
      ...(credential !== undefined ? { credential } : { error: 'credential_unavailable' }),
    });
  } catch {
    await request('credential.supply', { requestId, error: 'credential_broker_failed' });
  }
}

async function answerHostToolInvocation(
  params: unknown,
  handlersByLease: ReadonlyMap<string, Readonly<Record<string, RuntimeHostToolHandler>>>,
  results: Map<string, HostToolInvocationResult>,
  request: (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
  ) => Promise<unknown>,
): Promise<void> {
  const payload = requireRecord(params);
  const invocationId = requireStringField(payload, 'invocationId');
  const leaseId = requireStringField(payload, 'leaseId');
  const toolName = requireStringField(payload, 'toolName');
  const handler = handlersByLease.get(leaseId)?.[toolName];
  if (!handler) {
    await request('host_tool.complete', { invocationId, error: 'host_tool_unavailable' });
    return;
  }
  let result = results.get(invocationId);
  if (!result) {
    const promise = Promise.resolve().then(() => handler({
        invocationId,
        leaseId,
        toolName,
        sessionId: requireStringField(payload, 'sessionId'),
        runId: requireStringField(payload, 'runId'),
        input: requireRecord(payload.input),
      }));
    result = { promise, settled: false };
    results.set(invocationId, result);
    const tracked = result;
    void promise.finally(() => {
      tracked.settled = true;
      pruneHostToolResults(results);
    }).catch(() => undefined);
    pruneHostToolResults(results);
  }
  try {
    await request('host_tool.complete', { invocationId, result: await result.promise });
  } catch {
    try {
      await request('host_tool.complete', { invocationId, error: 'host_tool_failed' });
    } catch (error: unknown) {
      throw new Error('Failed to report the Host Tool outcome to the Runtime daemon.', {
        cause: error,
      });
    }
  }
}

function validateHostToolHandlers(
  tools: readonly RuntimeHostToolDescriptor[],
  handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
): void {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length || tools.length === 0) {
    throw new Error('Host tool descriptors must have unique, non-empty names.');
  }
  for (const name of names) {
    if (typeof handlers[name] !== 'function') {
      throw new Error(`Missing host tool handler: ${name}`);
    }
  }
}

function pruneHostToolResults(results: Map<string, HostToolInvocationResult>): void {
  if (results.size <= MAX_RETAINED_HOST_TOOL_RESULTS) return;
  for (const [invocationId, result] of results) {
    if (results.size <= MAX_RETAINED_HOST_TOOL_RESULTS) return;
    if (result.settled) results.delete(invocationId);
  }
}

function createOperationEnvelope(
  journalEpoch: string | undefined,
  operation: RuntimeOperationOptions | undefined,
): RuntimeDaemonOperationEnvelope | undefined {
  const epoch = operation?.journalEpoch ?? journalEpoch;
  if (epoch === undefined) return undefined;
  return {
    operationId: operation?.operationId ?? `op_${randomUUID().replace(/-/g, '')}`,
    journalEpoch: epoch,
  };
}

function subscribeToDaemonEvents(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  filter: RuntimeEventFilter,
  listener: RuntimeEventListener,
): RuntimeSubscription {
  return subscribeToDaemonNotification(transport, request, 'event.subscribe', {
    filter,
  }, (event) => {
    deliverRuntimeEvent(event, listener);
  });
}

async function observeDaemonSession(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  sessionId: string,
  listener: RuntimeEventListener,
): Promise<RuntimeSessionObservation> {
  let closed = false;
  let remoteSubscriptionId: string | undefined;
  let bufferOverflowed = false;
  const pending: Array<Record<string, unknown>> = [];
  const local = transport.subscribe((notification) => {
    if (closed || notification.method !== 'event') return;
    const payload = requireRecord(notification.params);
    if (remoteSubscriptionId === undefined) {
      if (!isRuntimeEventForSession(payload.event, sessionId)) return;
      if (pending.length >= MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS) {
        bufferOverflowed = true;
      } else {
        pending.push(payload);
      }
      return;
    }
    if (payload.subscriptionId === remoteSubscriptionId) {
      deliverRuntimeEvent(payload.event, listener);
    }
  });
  try {
    const result = requireRecord(await request('session.observe', { sessionId }));
    remoteSubscriptionId = requireStringField(result, 'subscriptionId');
    if (bufferOverflowed) {
      throw Object.assign(
        new Error('Runtime session observation handshake exceeded its event buffer; full resync is required.'),
        { code: 'resync_required' as const },
      );
    }
    const snapshot = requireRecord(result.snapshot) as unknown as RuntimeSessionObservationSnapshot;
    for (const payload of pending.splice(0)) {
      if (payload.subscriptionId === remoteSubscriptionId) {
        deliverRuntimeEvent(payload.event, listener);
      }
    }
    return {
      snapshot,
      close() {
        if (closed) return;
        closed = true;
        pending.length = 0;
        local.close();
        if (remoteSubscriptionId !== undefined) {
          void request('event.unsubscribe', {
            subscriptionId: remoteSubscriptionId,
          }).catch(() => undefined);
        }
      },
    };
  } catch (error: unknown) {
    closed = true;
    pending.length = 0;
    local.close();
    if (remoteSubscriptionId !== undefined) {
      void request('event.unsubscribe', { subscriptionId: remoteSubscriptionId }).catch(() => undefined);
    }
    throw error;
  }
}

function isRuntimeEventForSession(value: unknown, sessionId: string): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).sessionId === sessionId;
}

function deliverRuntimeEvent(value: unknown, listener: RuntimeEventListener): void {
  const event = parseRuntimeEventForClient(value);
  if (event !== undefined) listener(event);
}

function parseRuntimeEventForClient(value: unknown): RuntimeEvent | undefined {
  const parsed = parseRuntimeEvent(value);
  if (!parsed.ok) {
    emitKodaXDiagnostic({
      source: 'runtime.daemon.client',
      level: 'warn',
      message: `Ignored malformed Runtime event: ${parsed.error}`,
    });
    return;
  }
  return parsed.event;
}

function subscribeToDaemonWorkflowEvents(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  filter: RuntimeWorkflowFilter,
  listener: RuntimeWorkflowListener,
): RuntimeSubscription {
  return subscribeToDaemonNotification(transport, request, 'workflow.subscribe', {
    filter,
  }, (event) => {
    listener(event as Parameters<RuntimeWorkflowListener>[0]);
  });
}

function subscribeToDaemonNotification(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  method: 'event.subscribe' | 'workflow.subscribe',
  params: unknown,
  listener: (event: unknown) => void,
): RuntimeSubscription {
  let closed = false;
  let remoteSubscriptionId: string | undefined;
  const pendingNotifications: Array<Record<string, unknown>> = [];
  const local = transport.subscribe((notification) => {
    if (closed || notification.method !== 'event') return;
    const payload = requireRecord(notification.params);
    if (remoteSubscriptionId === undefined) {
      if (pendingNotifications.length >= MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS) {
        pendingNotifications.shift();
      }
      pendingNotifications.push(payload);
      return;
    }
    if (payload.subscriptionId !== remoteSubscriptionId) return;
    listener(payload.event);
  });
  const ready = request(method, params).then((result) => {
    remoteSubscriptionId = requireStringField(requireRecord(result), 'subscriptionId');
    if (closed) {
      unsubscribeRemote(request, method, remoteSubscriptionId);
      pendingNotifications.length = 0;
      return;
    }
    for (const payload of pendingNotifications.splice(0)) {
      if (payload.subscriptionId === remoteSubscriptionId) {
        listener(payload.event);
      }
    }
  }).catch((error: unknown) => {
    pendingNotifications.length = 0;
    local.close();
    throw error;
  });
  // Callers that need a cross-connection happens-before can await `ready`.
  // Attach a handler here as well so legacy callers that ignore it do not
  // create an unhandled rejection when the remote handshake fails.
  void ready.catch(() => undefined);
  return {
    ready,
    close() {
      closed = true;
      local.close();
      if (remoteSubscriptionId !== undefined) {
        unsubscribeRemote(request, method, remoteSubscriptionId);
      }
    },
  };
}

function requestRuntimeRunResult(
  request: RuntimeDaemonClientTransport['request'],
  runId: string,
): Promise<RuntimeRunResult> {
  return request('run.await', { runId }).then(deserializeRuntimeRunResult);
}

function deserializeRuntimeRunResult(value: unknown): RuntimeRunResult {
  const record = requireRecord(value);
  const error = Object.prototype.hasOwnProperty.call(record, 'error')
    ? deserializeRuntimeError(record.error)
    : undefined;
  const normalized = { ...record };
  delete normalized.error;
  return {
    ...normalized,
    ...(error !== undefined ? { error } : {}),
  } as unknown as RuntimeRunResult;
}

function deserializeRuntimeError(value: unknown): Error | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  const record = requireRecord(value);
  const error = new Error(
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'Runtime run failed.',
  );
  if (typeof record.name === 'string' && record.name.length > 0) {
    error.name = record.name;
  }
  if (typeof record.stack === 'string' && record.stack.length > 0) {
    error.stack = record.stack;
  }
  return error;
}

function unsubscribeRemote(
  request: RuntimeDaemonClientTransport['request'],
  subscribeMethod: 'event.subscribe' | 'workflow.subscribe',
  subscriptionId: string,
): void {
  const unsubscribeMethod = subscribeMethod === 'event.subscribe'
    ? 'event.unsubscribe'
    : 'workflow.unsubscribe';
  void request(unsubscribeMethod, { subscriptionId }).catch(() => undefined);
}

function nullToUndefined<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : value as T;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected daemon response object.');
  }
  return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected daemon response string field: ${key}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Expected daemon response optional string field: ${key}`);
  }
  return value;
}

function assertRuntimeTransportSafe(
  value: unknown,
  path: string,
  ancestors: WeakSet<object> = new WeakSet(),
): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: numbers must be finite.`,
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: ${typeof value} values cannot cross a Runtime boundary.`,
    );
  }
  if (typeof value !== 'object') return;
  if (ancestors.has(value)) {
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: cyclic values cannot cross a Runtime boundary.`,
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = prototype?.constructor?.name ?? 'object';
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: ${name} instances cannot cross a Runtime boundary.`,
    );
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRuntimeTransportSafe(entry, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertRuntimeTransportSafe(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
