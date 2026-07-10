import type {
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeConfigReloadResult,
  RuntimeConfigPatch,
  RuntimeContextBudgetSnapshot,
  RuntimeCommandResolveInput,
  RuntimeCommandInfo,
  RuntimeCreateArtifactInput,
  RuntimeArtifact,
  RuntimeDiagnosticFilter,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeExtensionListResult,
  RuntimeIdentity,
  RuntimeMcpReloadResult,
  RuntimeMcpToolListFilter,
  RuntimeMcpValidateResult,
  RuntimeModelListFilter,
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
  RuntimeSessionSettings,
  RuntimeSessionSummary,
  RuntimeSkillDescribeInput,
  RuntimeSkillDescription,
  RuntimeSkillListFilter,
  RuntimeSkillSummary,
  RuntimeStartRunInput,
  RuntimeStatusSnapshot,
  RuntimeSubscription,
  RuntimeToolExposurePlan,
  RuntimeTranscript,
  RuntimeWorkflowFilter,
  RuntimeWorkflowListener,
  RuntimeWorkflowSnapshot,
  RuntimeWorkflowSummary,
} from '../sdk-runtime.js';
import type {
  McpServerConfig,
  McpServerToolList,
} from '@kodax-ai/agent';
import type {
  RuntimeDaemonMethod,
  RuntimeDaemonNotification,
} from './protocol.js';

const MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS = 256;

export interface RuntimeDaemonClientTransport {
  request(method: RuntimeDaemonMethod, params?: unknown): Promise<unknown>;
  subscribe(listener: (notification: RuntimeDaemonNotification) => void): RuntimeSubscription;
  close?(): Promise<void> | void;
}

export interface RuntimeDaemonClientOptions {
  readonly identity: RuntimeIdentity;
  readonly transport: RuntimeDaemonClientTransport;
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

export function createRuntimeDaemonClient(
  options: RuntimeDaemonClientOptions,
): KodaXRuntime {
  const request = options.transport.request.bind(options.transport);

  return {
    identity: options.identity,
    sessions: {
      create(input) {
        return request('session.create', input) as Promise<RuntimeSession>;
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
      fork(input) {
        return request('session.fork', input) as Promise<RuntimeSession | null>;
      },
      getSettings(sessionId) {
        return request('session.settings.get', { sessionId }) as Promise<RuntimeSessionSettings>;
      },
      updateSettings(sessionId, patch) {
        return request('session.settings.update', { sessionId, patch }) as Promise<RuntimeSessionSettings>;
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
      async start(input: RuntimeStartRunInput): Promise<RuntimeRunHandle> {
        assertRuntimeTransportSafe(input.options, 'run.start.options');
        const started = requireRecord(await request('run.start', input));
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
        return request('event.replay', filter) as Promise<readonly RuntimeEvent[]>;
      },
    },
    permissions: {
      request(input: RuntimePermissionRequestInput) {
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
        upsert(registration) {
          assertRuntimeTransportSafe(registration, 'agentRegistrations.upsert.registration');
          return request('agentRegistrations.upsert', { registration }) as ReturnType<KodaXRuntime['admin']['agentRegistrations']['upsert']>;
        },
        remove(agentId) {
          return request('agentRegistrations.remove', { agentId }) as Promise<boolean>;
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
    },
    agentTasks: {
      start(input) {
        assertRuntimeTransportSafe(input, 'agentTasks.start');
        return request('agentTasks.start', input) as ReturnType<KodaXRuntime['agentTasks']['start']>;
      },
      list(filter) {
        return request('agentTasks.list', filter) as ReturnType<KodaXRuntime['agentTasks']['list']>;
      },
      get(taskId) {
        return request('agentTasks.get', { taskId }) as ReturnType<KodaXRuntime['agentTasks']['get']>;
      },
      events(taskId, cursor) {
        return request('agentTasks.events', {
          taskId,
          ...(cursor !== undefined ? { cursor } : {}),
        }) as ReturnType<KodaXRuntime['agentTasks']['events']>;
      },
      wait(taskId, timeoutMs) {
        return request('agentTasks.wait', {
          taskId,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }) as ReturnType<KodaXRuntime['agentTasks']['wait']>;
      },
      sendInput(taskId, input) {
        return request('agentTasks.sendInput', { taskId, input }) as ReturnType<KodaXRuntime['agentTasks']['sendInput']>;
      },
      cancel(taskId, reason) {
        return request('agentTasks.cancel', {
          taskId,
          ...(reason !== undefined ? { reason } : {}),
        }) as ReturnType<KodaXRuntime['agentTasks']['cancel']>;
      },
      reconcile(taskId) {
        return request('agentTasks.reconcile', { taskId }) as ReturnType<KodaXRuntime['agentTasks']['reconcile']>;
      },
    },
    status: {
      snapshot() {
        return request('daemon.status') as Promise<RuntimeStatusSnapshot>;
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
    async close() {
      await options.transport.close?.();
    },
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
    listener(event as RuntimeEvent);
  });
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
  void request(method, params).then((result) => {
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
  }).catch(() => {
    pendingNotifications.length = 0;
    local.close();
  });
  return {
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
    throw new Error(`${path} is not transport-safe: numbers must be finite.`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`${path} is not transport-safe: ${typeof value} values cannot cross a Runtime boundary.`);
  }
  if (typeof value !== 'object') return;
  if (ancestors.has(value)) {
    throw new Error(`${path} is not transport-safe: cyclic values cannot cross a Runtime boundary.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = prototype?.constructor?.name ?? 'object';
    throw new Error(`${path} is not transport-safe: ${name} instances cannot cross a Runtime boundary.`);
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
