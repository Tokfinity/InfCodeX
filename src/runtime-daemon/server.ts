import { randomUUID } from 'node:crypto';

import type {
  KodaXRuntime,
  RuntimeAppendNoticeInput,
  RuntimeClientCapabilities,
  RuntimeCompactSessionInput,
  RuntimeCreateSessionInput,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventReplayFilter,
  RuntimeEventType,
  RuntimeForkSessionInput,
  RuntimePermissionDecision,
  RuntimePermissionFilter,
  RuntimePermissionRequestInput,
  RuntimeRewindSessionInput,
  RuntimeRunFilter,
  RuntimeRunResult,
  RuntimeSetActiveEntryInput,
  RuntimeSessionFilter,
  RuntimeSessionSettingsPatch,
  RuntimeStartRunInput,
  RuntimeSubscription,
  RuntimeWorkflowFilter,
} from '../sdk-runtime.js';
import {
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonNotification,
  createRuntimeDaemonSuccessResponse,
  type RuntimeDaemonErrorCode,
  type RuntimeDaemonErrorResponse,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotification,
  type RuntimeDaemonRequest,
  type RuntimeDaemonSuccessResponse,
} from './protocol.js';

export type RuntimeDaemonNotificationSink = (
  notification: RuntimeDaemonNotification,
) => void;

export interface RuntimeDaemonDispatcherOptions {
  readonly runtime: KodaXRuntime;
  readonly notify?: RuntimeDaemonNotificationSink;
  readonly runResults?: RuntimeDaemonRunResultStore;
  readonly authToken?: string;
  readonly status?: () => Promise<unknown> | unknown;
  readonly stop?: () => Promise<unknown> | unknown;
  readonly logs?: () => Promise<unknown> | unknown;
  readonly config?: () => Promise<unknown> | unknown;
  readonly providerList?: () => Promise<unknown> | unknown;
}

export interface RuntimeDaemonDispatcher {
  handle(
    request: RuntimeDaemonRequest,
  ): Promise<RuntimeDaemonSuccessResponse | RuntimeDaemonErrorResponse>;
  close(): void;
}

const MAX_DAEMON_RUN_RESULT_RECORDS = 1_000;

interface RuntimeDaemonRunResultEntry {
  readonly promise: Promise<RuntimeRunResult>;
  settled: boolean;
}

export interface RuntimeDaemonRunResultStore {
  remember(runId: string, result: Promise<RuntimeRunResult>): void;
  get(runId: string): Promise<RuntimeRunResult> | undefined;
  clear(): void;
}

export function createRuntimeDaemonRunResultStore(): RuntimeDaemonRunResultStore {
  const records = new Map<string, RuntimeDaemonRunResultEntry>();

  const pruneSettled = (): void => {
    if (records.size <= MAX_DAEMON_RUN_RESULT_RECORDS) return;
    for (const [runId, entry] of records) {
      if (records.size <= MAX_DAEMON_RUN_RESULT_RECORDS) break;
      if (entry.settled) records.delete(runId);
    }
  };

  const markSettled = (runId: string, entry: RuntimeDaemonRunResultEntry): void => {
    if (records.get(runId) !== entry) return;
    entry.settled = true;
    pruneSettled();
  };

  return {
    remember(runId, result) {
      let entry: RuntimeDaemonRunResultEntry | undefined;
      const promise = result.finally(() => {
        if (entry) markSettled(runId, entry);
      });
      promise.catch(() => undefined);
      entry = { promise, settled: false };
      records.set(runId, entry);
      pruneSettled();
    },
    get(runId) {
      return records.get(runId)?.promise;
    },
    clear() {
      records.clear();
    },
  };
}

function isInitializeMethod(method: RuntimeDaemonMethod): boolean {
  return method === 'initialize' || method === 'runtime.initialize';
}

export function createRuntimeDaemonDispatcher(
  options: RuntimeDaemonDispatcherOptions,
): RuntimeDaemonDispatcher {
  const subscriptions = new Map<string, RuntimeSubscription>();
  const runResults = options.runResults ?? createRuntimeDaemonRunResultStore();
  let initialized = false;
  let clientCapabilities: RuntimeClientCapabilities = {};

  const closeSubscription = (subscriptionId: string): boolean => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return false;
    subscriptions.delete(subscriptionId);
    subscription.close();
    return true;
  };

  const rememberSubscription = (subscription: RuntimeSubscription): string => {
    const subscriptionId = `sub_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    subscriptions.set(subscriptionId, subscription);
    return subscriptionId;
  };

  const notify = (subscriptionId: string, event: unknown): void => {
    if (
      isContextDiagnosticRuntimeEvent(event)
      && clientCapabilities.contextDiagnostics !== true
    ) {
      return;
    }
    options.notify?.(createRuntimeDaemonNotification('event', {
      subscriptionId,
      event,
    }));
  };

  const handle = async (
    request: RuntimeDaemonRequest,
  ): Promise<RuntimeDaemonSuccessResponse | RuntimeDaemonErrorResponse> => {
    try {
      let initializeParams: Record<string, unknown> | undefined;
      if (!initialized && !isInitializeMethod(request.method)) {
        throw daemonError(
          'not_initialized',
          'Runtime daemon connection must initialize before runtime methods are accepted.',
        );
      }
      if (initialized && isInitializeMethod(request.method)) {
        throw daemonError('conflict', 'Runtime daemon connection is already initialized.');
      }
      if (isInitializeMethod(request.method)) {
        initializeParams = optionalRecord(request.params);
        const token = typeof initializeParams?.token === 'string'
          ? initializeParams.token
          : undefined;
        if (options.authToken !== undefined && token !== options.authToken) {
          throw daemonError('unauthorized', 'Runtime daemon initialize token is invalid.');
        }
        const requestedProfile = typeof initializeParams?.profile === 'string'
          ? initializeParams.profile
          : undefined;
        if (
          requestedProfile !== undefined
          && requestedProfile !== options.runtime.identity.profile
        ) {
          throw daemonError(
            'conflict',
            `Runtime daemon profile mismatch: expected ${options.runtime.identity.profile}, got ${requestedProfile}.`,
          );
        }
      }
      const result = await dispatchRuntimeDaemonRequest(
        request,
        options,
        runResults,
        rememberSubscription,
        closeSubscription,
        notify,
        () => clientCapabilities,
      );
      if (isInitializeMethod(request.method)) {
        initialized = true;
        clientCapabilities = parseRuntimeClientCapabilities(initializeParams?.capabilities);
      }
      return createRuntimeDaemonSuccessResponse(request.id, result);
    } catch (error: unknown) {
      return createRuntimeDaemonErrorResponse(normalizeRuntimeDaemonError(error), request.id);
    }
  };

  return {
    handle,
    close() {
      for (const id of [...subscriptions.keys()]) {
        closeSubscription(id);
      }
    },
  };
}

async function dispatchRuntimeDaemonRequest(
  request: RuntimeDaemonRequest,
  options: RuntimeDaemonDispatcherOptions,
  runResults: RuntimeDaemonRunResultStore,
  rememberSubscription: (subscription: RuntimeSubscription) => string,
  closeSubscription: (subscriptionId: string) => boolean,
  notify: (subscriptionId: string, event: unknown) => void,
  getClientCapabilities: () => RuntimeClientCapabilities,
): Promise<unknown> {
  const runtime = options.runtime;

  switch (request.method) {
    case 'initialize':
    case 'runtime.initialize':
      return {
        identity: runtime.identity,
        capabilities: runtimeDaemonCapabilities(),
      };
    case 'ping':
      return { ok: true, runtimeId: runtime.identity.runtimeId };
    case 'runtime.identity':
      return runtime.identity;
    case 'daemon.status':
    case 'runtime.status':
      return options.status ? options.status() : runtime.status.snapshot();
    case 'daemon.stop':
    case 'runtime.shutdown':
      return options.stop ? options.stop() : runtime.close().then(() => ({ ok: true }));
    case 'daemon.logs':
      return options.logs ? options.logs() : { entries: [] };
    case 'runtime.capabilities':
      return runtimeDaemonCapabilities();
    case 'config.read':
      return options.config ? redactRuntimeConfig(await options.config()) : runtime.config.read();
    case 'config.patch': {
      const patch = requireRecordField(requireRecord(request.params), 'patch');
      return runtime.config.patch(patch);
    }
    case 'config.reload':
      return runtime.config.reload();
    case 'provider.list':
      return options.providerList ? options.providerList() : runtime.catalog.providers();
    case 'model.list':
      return options.providerList
        ? listRuntimeModels(await options.providerList(), optionalRecord(request.params))
        : runtime.catalog.models(parseModelListFilter(request.params));
    case 'provider.custom.list':
      return runtime.catalog.customProviders();
    case 'provider.custom.upsert': {
      const params = requireRecord(request.params);
      return runtime.catalog.upsertCustomProvider(
        requireRecord(params.config) as unknown as Parameters<KodaXRuntime['catalog']['upsertCustomProvider']>[0],
      );
    }
    case 'provider.custom.remove':
      return runtime.catalog.deleteCustomProvider(requireStringParam(request.params, 'name'));
    case 'mcp.server.list':
      return runtime.mcp.listServers();
    case 'mcp.server.get':
      return runtime.mcp.getServer(requireStringParam(request.params, 'name'));
    case 'mcp.server.validate': {
      const params = requireRecord(request.params);
      return runtime.mcp.validateServer(
        requireStringField(params, 'name'),
        params.config,
      );
    }
    case 'mcp.server.upsert': {
      const params = requireRecord(request.params);
      return runtime.mcp.upsertServer(
        requireStringField(params, 'name'),
        requireRecord(params.config) as Parameters<KodaXRuntime['mcp']['upsertServer']>[1],
      );
    }
    case 'mcp.server.delete':
    case 'mcp.server.remove':
      return runtime.mcp.deleteServer(requireStringParam(request.params, 'name'));
    case 'mcp.server.reload':
      return runtime.mcp.reloadServers();
    case 'mcp.tool.list':
      return runtime.mcp.listTools(parseMcpToolListFilter(request.params));
    case 'extension.list':
      return runtime.catalog.extensions();
    case 'extension.reload':
      return runtime.catalog.reloadExtensions();
    case 'command.list': {
      const params = optionalRecord(request.params);
      const projectRoot = typeof params?.projectRoot === 'string' ? params.projectRoot : undefined;
      return runtime.catalog.commands(projectRoot);
    }
    case 'command.resolve':
    {
      const params = requireRecord(request.params);
      return runtime.catalog.resolveCommand({
        name: requireStringField(params, 'name'),
        ...(typeof params.projectRoot === 'string'
          ? { projectRoot: params.projectRoot }
          : {}),
      });
    }
    case 'skill.list':
      return runtime.catalog.skills(parseSkillListFilter(request.params));
    case 'skill.describe':
    case 'skill.read': {
      const params = requireRecord(request.params);
      return runtime.catalog.describeSkill({
        name: requireStringField(params, 'name'),
        ...(typeof params.projectRoot === 'string' ? { projectRoot: params.projectRoot } : {}),
      });
    }
    case 'artifact.create':
      return runtime.artifacts.create(parseArtifactCreateInput(request.params));
    case 'artifact.get':
      return runtime.artifacts.get(requireStringParam(request.params, 'artifactId'));
    case 'artifact.delete':
      return runtime.artifacts.delete(requireStringParam(request.params, 'artifactId'));

    case 'session.create':
      return runtime.sessions.create(optionalRecord(request.params) as RuntimeCreateSessionInput | undefined);
    case 'session.load':
      return runtime.sessions.load(requireStringParam(request.params, 'sessionId'));
    case 'session.list':
      return runtime.sessions.list(optionalRecord(request.params) as RuntimeSessionFilter | undefined);
    case 'session.transcript':
      return runtime.sessions.transcript(requireStringParam(request.params, 'sessionId'));
    case 'session.fork':
      return runtime.sessions.fork(requireRecord(request.params) as unknown as RuntimeForkSessionInput);
    case 'session.notice.append':
      return runtime.sessions.appendNotice(requireRecord(request.params) as unknown as RuntimeAppendNoticeInput);
    case 'session.rewind':
      return runtime.sessions.rewind(requireRecord(request.params) as unknown as RuntimeRewindSessionInput);
    case 'session.active_entry.set':
    case 'session.activeEntry.set':
      return runtime.sessions.setActiveEntry(requireRecord(request.params) as unknown as RuntimeSetActiveEntryInput);
    case 'session.compact':
      return runtime.sessions.compact(requireRecord(request.params) as unknown as RuntimeCompactSessionInput);
    case 'session.archive':
      await runtime.sessions.archive(requireStringParam(request.params, 'sessionId'));
      return { ok: true };
    case 'session.unarchive':
      await runtime.sessions.unarchive(requireStringParam(request.params, 'sessionId'));
      return { ok: true };
    case 'session.delete':
      await runtime.sessions.delete(requireStringParam(request.params, 'sessionId'));
      return { ok: true };
    case 'session.settings.get':
      return runtime.sessions.getSettings(requireStringParam(request.params, 'sessionId'));
    case 'session.settings.update': {
      const params = requireRecord(request.params);
      return runtime.sessions.updateSettings(
        requireStringField(params, 'sessionId'),
        requireRecord(params.patch) as unknown as RuntimeSessionSettingsPatch,
      );
    }

    case 'run.start': {
      const handle = await runtime.runs.start(requireRecord(request.params) as unknown as RuntimeStartRunInput);
      runResults.remember(handle.runId, handle.result);
      return {
        runId: handle.runId,
        sessionId: handle.sessionId,
        ...(handle.turnId !== undefined ? { turnId: handle.turnId } : {}),
      };
    }
    case 'run.get':
      return runtime.runs.get(requireStringParam(request.params, 'runId'));
    case 'run.list':
      return runtime.runs.list(optionalRecord(request.params) as RuntimeRunFilter | undefined);
    case 'run.await': {
      const runId = requireStringParam(request.params, 'runId');
      const result = runResults.get(runId);
      if (result) return result;
      return runtime.runs.await(runId);
    }
    case 'run.abort':
      await runtime.runs.abort(requireStringParam(request.params, 'runId'));
      return { ok: true };
    case 'run.model.set': {
      return setRunModel(runtime, request.params);
    }
    case 'run.setModel': {
      return setRunModel(runtime, request.params);
    }
    case 'run.provider.set': {
      const params = requireRecord(request.params);
      await runtime.runs.setProvider(requireStringField(params, 'runId'), requireStringField(params, 'provider'));
      return { ok: true };
    }
    case 'run.setProvider': {
      const params = requireRecord(request.params);
      await runtime.runs.setProvider(requireStringField(params, 'runId'), requireStringField(params, 'provider'));
      return { ok: true };
    }
    case 'run.reasoning.set': {
      return setRunReasoning(runtime, request.params);
    }
    case 'run.setReasoning': {
      return setRunReasoning(runtime, request.params);
    }

    case 'event.subscribe': {
      const params = optionalRecord(request.params) ?? {};
      const filter = optionalRecord(params.filter) as RuntimeEventFilter | undefined;
      let subscriptionId = '';
      const subscription = runtime.events.subscribe(filter ?? {}, (event: RuntimeEvent) => {
        notify(subscriptionId, event);
      });
      subscriptionId = rememberSubscription(subscription);
      return { subscriptionId };
    }
    case 'event.unsubscribe':
      return { ok: closeSubscription(requireStringParam(request.params, 'subscriptionId')) };
    case 'event.replay':
      return filterReplayForClientCapabilities(
        await runtime.events.replay(optionalRecord(request.params) as RuntimeEventReplayFilter | undefined),
        getClientCapabilities(),
      );

    case 'permission.list':
    case 'permission.listPending':
      return runtime.permissions.listPending(optionalRecord(request.params) as RuntimePermissionFilter | undefined);
    case 'permission.request':
      return runtime.permissions.request(requireRecord(request.params) as unknown as RuntimePermissionRequestInput);
    case 'permission.respond': {
      const params = requireRecord(request.params);
      const runId = optionalStringField(params, 'runId');
      return runtime.permissions.respond(
        requireStringField(params, 'requestId'),
        requireRecord(params.decision) as unknown as RuntimePermissionDecision,
        runId !== undefined ? { runId } : undefined,
      );
    }

    case 'workflow.list':
      return runtime.workflows.list(optionalRecord(request.params) as RuntimeWorkflowFilter | undefined);
    case 'workflow.get':
      return runtime.workflows.get(requireStringParam(request.params, 'runId'));
    case 'workflow.subscribe': {
      const params = optionalRecord(request.params) ?? {};
      const filter = optionalRecord(params.filter) as RuntimeWorkflowFilter | undefined;
      let subscriptionId = '';
      const subscription = runtime.workflows.subscribe(filter ?? {}, (event) => {
        notify(subscriptionId, event);
      });
      subscriptionId = rememberSubscription(subscription);
      return { subscriptionId };
    }
    case 'workflow.unsubscribe':
      return { ok: closeSubscription(requireStringParam(request.params, 'subscriptionId')) };
    case 'workflow.pause':
      return runtime.workflows.pause(requireStringParam(request.params, 'runId'));
    case 'workflow.resume':
      return runtime.workflows.resume(requireStringParam(request.params, 'runId'));
    case 'workflow.stop':
      return runtime.workflows.stop(requireStringParam(request.params, 'runId'));

    case 'context.budget.get':
      requireContextDiagnosticsCapability(getClientCapabilities());
      return latestRuntimeDiagnosticPayload(
        runtime,
        'context.budget.snapshot',
        optionalRecord(request.params),
      );
    case 'tool.exposure.preview':
      requireContextDiagnosticsCapability(getClientCapabilities());
      return latestRuntimeDiagnosticPayload(
        runtime,
        'tool.exposure.planned',
        optionalRecord(request.params),
      );

    default:
      throw daemonError('method_not_found', `Runtime daemon method is not implemented: ${request.method}`);
  }
}

function parseRuntimeClientCapabilities(value: unknown): RuntimeClientCapabilities {
  if (!isRecord(value)) return {};
  return {
    ...(value.richEvents === true ? { richEvents: true } : {}),
    ...(value.permissionPrompts === true ? { permissionPrompts: true } : {}),
    ...(value.configAdmin === true ? { configAdmin: true } : {}),
    ...(value.commandCatalog === true ? { commandCatalog: true } : {}),
    ...(value.skillCatalog === true ? { skillCatalog: true } : {}),
    ...(value.artifactUpload === true ? { artifactUpload: true } : {}),
    ...(value.contextDiagnostics === true ? { contextDiagnostics: true } : {}),
  };
}

function runtimeDaemonCapabilities(): Record<string, boolean> {
  return {
    events: true,
    permissions: true,
    workflows: true,
    configAdmin: true,
    commandCatalog: true,
    skillCatalog: true,
    artifactUpload: true,
    contextDiagnostics: true,
  };
}

function filterReplayForClientCapabilities(
  events: readonly RuntimeEvent[],
  capabilities: RuntimeClientCapabilities,
): readonly RuntimeEvent[] {
  if (capabilities.contextDiagnostics === true) return events;
  return events.filter((event) => !isContextDiagnosticRuntimeEvent(event));
}

function requireContextDiagnosticsCapability(capabilities: RuntimeClientCapabilities): void {
  if (capabilities.contextDiagnostics === true) return;
  throw daemonError(
    'unauthorized',
    'Runtime daemon client did not negotiate contextDiagnostics capability.',
  );
}

function isContextDiagnosticRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!isRecord(value)) return false;
  return value.type === 'context.budget.snapshot'
    || value.type === 'tool.exposure.planned';
}

async function latestRuntimeDiagnosticPayload(
  runtime: KodaXRuntime,
  type: RuntimeEventType,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const filter = params ?? {};
  const replayFilter: RuntimeEventReplayFilter = {
    type,
    limit: 100,
    ...(typeof filter.sessionId === 'string' ? { sessionId: filter.sessionId } : {}),
    ...(typeof filter.runId === 'string' ? { runId: filter.runId } : {}),
  };
  const events = await runtime.events.replay(replayFilter);
  return events.at(-1)?.payload ?? null;
}

async function setRunModel(runtime: KodaXRuntime, paramsValue: unknown): Promise<{ readonly ok: true }> {
  const params = requireRecord(paramsValue);
  await runtime.runs.setModel(requireStringField(params, 'runId'), optionalStringField(params, 'model'));
  return { ok: true };
}

async function setRunReasoning(runtime: KodaXRuntime, paramsValue: unknown): Promise<{ readonly ok: true }> {
  const params = requireRecord(paramsValue);
  await runtime.runs.setReasoning(
    requireStringField(params, 'runId'),
    optionalStringField(params, 'reasoning') as Parameters<typeof runtime.runs.setReasoning>[1],
  );
  return { ok: true };
}

function listRuntimeModels(providerList: unknown, params: Record<string, unknown> | undefined): unknown {
  const providers = Array.isArray(providerList) ? providerList : [];
  const providerName = typeof params?.provider === 'string' ? params.provider : undefined;
  if (providerName !== undefined) {
    const provider = providers.find((item) => (
      isRecord(item) && item.name === providerName
    ));
    if (!isRecord(provider)) {
      return { provider: providerName, models: [] };
    }
    return {
      provider: providerName,
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

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value);
}

function requireRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return requireRecord(record[key]);
}

function parseModelListFilter(params: unknown): Parameters<KodaXRuntime['catalog']['models']>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return typeof record.provider === 'string' ? { provider: record.provider } : undefined;
}

function parseMcpToolListFilter(params: unknown): Parameters<KodaXRuntime['mcp']['listTools']>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return {
    ...(typeof record.server === 'string' ? { server: record.server } : {}),
    ...(typeof record.forceRefresh === 'boolean' ? { forceRefresh: record.forceRefresh } : {}),
  };
}

function parseSkillListFilter(params: unknown): Parameters<KodaXRuntime['catalog']['skills']>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return {
    ...(typeof record.projectRoot === 'string' ? { projectRoot: record.projectRoot } : {}),
    ...(typeof record.userInvocableOnly === 'boolean' ? { userInvocableOnly: record.userInvocableOnly } : {}),
  };
}

function parseArtifactCreateInput(
  params: unknown,
): Parameters<KodaXRuntime['artifacts']['create']>[0] {
  const record = requireRecord(params);
  const kind = record.kind;
  if (kind !== 'image' && kind !== 'file' && kind !== 'video') {
    throw daemonError('invalid_request', 'Expected artifact kind: image | file | video');
  }
  const artifactPath = requireStringField(record, 'path');
  return {
    kind,
    path: artifactPath,
    ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(isRuntimeArtifactSource(record.source) ? { source: record.source } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

function isRuntimeArtifactSource(value: unknown): value is Parameters<KodaXRuntime['artifacts']['create']>[0]['source'] {
  return value === 'user-inline'
    || value === 'clipboard'
    || value === 'drag-drop'
    || value === 'file-picker';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw daemonError('invalid_request', 'Expected params to be an object.');
  }
  return value as Record<string, unknown>;
}

function requireStringParam(params: unknown, key: string): string {
  return requireStringField(requireRecord(params), key);
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw daemonError('invalid_request', `Expected string param: ${key}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw daemonError('invalid_request', `Expected optional string param: ${key}`);
  }
  return value;
}

function daemonError(
  code: RuntimeDaemonErrorCode,
  message: string,
  data?: unknown,
): Error & { readonly code: RuntimeDaemonErrorCode; readonly data?: unknown } {
  const error = new Error(message) as Error & {
    code: RuntimeDaemonErrorCode;
    data?: unknown;
  };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function normalizeRuntimeDaemonError(error: unknown): {
  readonly code: RuntimeDaemonErrorCode;
  readonly message: string;
  readonly data?: unknown;
} {
  if (error instanceof Error) {
    const maybe = error as Error & {
      readonly code?: unknown;
      readonly data?: unknown;
    };
    const code = typeof maybe.code === 'string' && isRuntimeDaemonErrorCode(maybe.code)
      ? maybe.code
      : 'internal_error';
    return {
      code,
      message: error.message,
      ...(maybe.data !== undefined ? { data: maybe.data } : {}),
    };
  }
  return {
    code: 'internal_error',
    message: String(error),
  };
}

function isRuntimeDaemonErrorCode(value: string): value is RuntimeDaemonErrorCode {
  return value === 'invalid_frame'
    || value === 'invalid_request'
    || value === 'not_initialized'
    || value === 'method_not_found'
    || value === 'unauthorized'
    || value === 'conflict'
    || value === 'not_found'
    || value === 'cancelled'
    || value === 'internal_error';
}
