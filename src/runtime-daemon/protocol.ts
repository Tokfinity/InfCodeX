export const KODAX_DAEMON_PROTOCOL = 'kodax-runtime-daemon';
export const KODAX_DAEMON_PROTOCOL_VERSION = 1;

export type RuntimeDaemonMethod =
  | 'initialize'
  | 'runtime.initialize'
  | 'ping'
  | 'runtime.identity'
  | 'runtime.status'
  | 'runtime.shutdown'
  | 'runtime.capabilities'
  | 'daemon.status'
  | 'daemon.stop'
  | 'daemon.logs'
  | 'session.create'
  | 'session.load'
  | 'session.list'
  | 'session.transcript'
  | 'session.fork'
  | 'session.notice.append'
  | 'session.rewind'
  | 'session.active_entry.set'
  | 'session.activeEntry.set'
  | 'session.compact'
  | 'session.archive'
  | 'session.unarchive'
  | 'session.delete'
  | 'session.settings.get'
  | 'session.settings.update'
  | 'run.start'
  | 'run.get'
  | 'run.list'
  | 'run.await'
  | 'run.abort'
  | 'run.model.set'
  | 'run.provider.set'
  | 'run.reasoning.set'
  | 'run.setModel'
  | 'run.setProvider'
  | 'run.setReasoning'
  | 'event.subscribe'
  | 'event.unsubscribe'
  | 'event.replay'
  | 'permission.list'
  | 'permission.listPending'
  | 'permission.request'
  | 'permission.respond'
  | 'workflow.list'
  | 'workflow.get'
  | 'workflow.subscribe'
  | 'workflow.unsubscribe'
  | 'workflow.pause'
  | 'workflow.resume'
  | 'workflow.stop'
  | 'config.read'
  | 'config.patch'
  | 'config.reload'
  | 'model.list'
  | 'provider.list'
  | 'provider.custom.list'
  | 'provider.custom.upsert'
  | 'provider.custom.remove'
  | 'mcp.server.list'
  | 'mcp.server.get'
  | 'mcp.server.validate'
  | 'mcp.server.upsert'
  | 'mcp.server.delete'
  | 'mcp.server.remove'
  | 'mcp.server.reload'
  | 'mcp.tool.list'
  | 'extension.list'
  | 'extension.reload'
  | 'command.list'
  | 'command.resolve'
  | 'skill.list'
  | 'skill.describe'
  | 'skill.read'
  | 'artifact.create'
  | 'artifact.get'
  | 'artifact.delete'
  | 'context.budget.get'
  | 'tool.exposure.preview';

export type RuntimeDaemonNotificationMethod =
  | 'event'
  | 'runtime.warning';

export interface RuntimeDaemonError {
  readonly code: RuntimeDaemonErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export type RuntimeDaemonErrorCode =
  | 'invalid_frame'
  | 'invalid_request'
  | 'not_initialized'
  | 'method_not_found'
  | 'unauthorized'
  | 'conflict'
  | 'not_found'
  | 'cancelled'
  | 'internal_error';

interface RuntimeDaemonFrameBase {
  readonly protocol: typeof KODAX_DAEMON_PROTOCOL;
  readonly version: typeof KODAX_DAEMON_PROTOCOL_VERSION;
}

export interface RuntimeDaemonRequest extends RuntimeDaemonFrameBase {
  readonly kind: 'request';
  readonly id: string;
  readonly method: RuntimeDaemonMethod;
  readonly params?: unknown;
}

export interface RuntimeDaemonSuccessResponse extends RuntimeDaemonFrameBase {
  readonly kind: 'response';
  readonly id: string;
  readonly result: unknown;
}

export interface RuntimeDaemonErrorResponse extends RuntimeDaemonFrameBase {
  readonly kind: 'error';
  readonly id?: string;
  readonly error: RuntimeDaemonError;
}

export interface RuntimeDaemonNotification extends RuntimeDaemonFrameBase {
  readonly kind: 'notification';
  readonly method: RuntimeDaemonNotificationMethod;
  readonly params?: unknown;
}

export type RuntimeDaemonFrame =
  | RuntimeDaemonRequest
  | RuntimeDaemonSuccessResponse
  | RuntimeDaemonErrorResponse
  | RuntimeDaemonNotification;

export const RUNTIME_DAEMON_METHODS: readonly RuntimeDaemonMethod[] = [
  'initialize',
  'runtime.initialize',
  'ping',
  'runtime.identity',
  'runtime.status',
  'runtime.shutdown',
  'runtime.capabilities',
  'daemon.status',
  'daemon.stop',
  'daemon.logs',
  'session.create',
  'session.load',
  'session.list',
  'session.transcript',
  'session.fork',
  'session.notice.append',
  'session.rewind',
  'session.active_entry.set',
  'session.activeEntry.set',
  'session.compact',
  'session.archive',
  'session.unarchive',
  'session.delete',
  'session.settings.get',
  'session.settings.update',
  'run.start',
  'run.get',
  'run.list',
  'run.await',
  'run.abort',
  'run.model.set',
  'run.provider.set',
  'run.reasoning.set',
  'run.setModel',
  'run.setProvider',
  'run.setReasoning',
  'event.subscribe',
  'event.unsubscribe',
  'event.replay',
  'permission.list',
  'permission.listPending',
  'permission.request',
  'permission.respond',
  'workflow.list',
  'workflow.get',
  'workflow.subscribe',
  'workflow.unsubscribe',
  'workflow.pause',
  'workflow.resume',
  'workflow.stop',
  'config.read',
  'config.patch',
  'config.reload',
  'model.list',
  'provider.list',
  'provider.custom.list',
  'provider.custom.upsert',
  'provider.custom.remove',
  'mcp.server.list',
  'mcp.server.get',
  'mcp.server.validate',
  'mcp.server.upsert',
  'mcp.server.delete',
  'mcp.server.remove',
  'mcp.server.reload',
  'mcp.tool.list',
  'extension.list',
  'extension.reload',
  'command.list',
  'command.resolve',
  'skill.list',
  'skill.describe',
  'skill.read',
  'artifact.create',
  'artifact.get',
  'artifact.delete',
  'context.budget.get',
  'tool.exposure.preview',
];

const REQUEST_METHODS: ReadonlySet<string> = new Set<RuntimeDaemonMethod>(RUNTIME_DAEMON_METHODS);

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set<RuntimeDaemonNotificationMethod>([
  'event',
  'runtime.warning',
]);

const ERROR_CODES: ReadonlySet<string> = new Set<RuntimeDaemonErrorCode>([
  'invalid_frame',
  'invalid_request',
  'not_initialized',
  'method_not_found',
  'unauthorized',
  'conflict',
  'not_found',
  'cancelled',
  'internal_error',
]);

export function createRuntimeDaemonRequest(
  id: string,
  method: RuntimeDaemonMethod,
  params?: unknown,
): RuntimeDaemonRequest {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'request',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function createRuntimeDaemonSuccessResponse(
  id: string,
  result: unknown,
): RuntimeDaemonSuccessResponse {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'response',
    id,
    result: result === undefined ? null : result,
  };
}

export function createRuntimeDaemonErrorResponse(
  error: RuntimeDaemonError,
  id?: string,
): RuntimeDaemonErrorResponse {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'error',
    ...(id !== undefined ? { id } : {}),
    error,
  };
}

export function createRuntimeDaemonNotification(
  method: RuntimeDaemonNotificationMethod,
  params?: unknown,
): RuntimeDaemonNotification {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'notification',
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function isRuntimeDaemonRequest(value: unknown): value is RuntimeDaemonRequest {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'request'
    && typeof frame.id === 'string'
    && frame.id.length > 0
    && typeof frame.method === 'string'
    && REQUEST_METHODS.has(frame.method);
}

export function isRuntimeDaemonSuccessResponse(
  value: unknown,
): value is RuntimeDaemonSuccessResponse {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'response'
    && typeof frame.id === 'string'
    && frame.id.length > 0
    && Object.prototype.hasOwnProperty.call(frame, 'result');
}

export function isRuntimeDaemonErrorResponse(value: unknown): value is RuntimeDaemonErrorResponse {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'error'
    && (frame.id === undefined || typeof frame.id === 'string')
    && isRuntimeDaemonError(frame.error);
}

export function isRuntimeDaemonNotification(value: unknown): value is RuntimeDaemonNotification {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'notification'
    && typeof frame.method === 'string'
    && NOTIFICATION_METHODS.has(frame.method);
}

export function isRuntimeDaemonFrame(value: unknown): value is RuntimeDaemonFrame {
  return isRuntimeDaemonRequest(value)
    || isRuntimeDaemonSuccessResponse(value)
    || isRuntimeDaemonErrorResponse(value)
    || isRuntimeDaemonNotification(value);
}

export function parseRuntimeDaemonFrame(json: string): RuntimeDaemonFrame | RuntimeDaemonErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalidFrame('Frame is not valid JSON.');
  }

  if (!isRuntimeDaemonFrame(parsed)) {
    return invalidFrame('Frame does not match the runtime daemon protocol.');
  }
  return parsed;
}

function invalidFrame(message: string): RuntimeDaemonErrorResponse {
  return createRuntimeDaemonErrorResponse({
    code: 'invalid_frame',
    message,
  });
}

function isFrameBase(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  return frame.protocol === KODAX_DAEMON_PROTOCOL
    && frame.version === KODAX_DAEMON_PROTOCOL_VERSION;
}

function isRuntimeDaemonError(value: unknown): value is RuntimeDaemonError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const error = value as Record<string, unknown>;
  return typeof error.code === 'string'
    && ERROR_CODES.has(error.code)
    && typeof error.message === 'string';
}
