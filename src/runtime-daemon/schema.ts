import {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_METHODS,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotificationMethod,
} from './protocol.js';

export type RuntimeDaemonJsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

export interface RuntimeDaemonJsonSchema {
  readonly type?: RuntimeDaemonJsonSchemaType | readonly RuntimeDaemonJsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Record<string, RuntimeDaemonJsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | RuntimeDaemonJsonSchema;
  readonly items?: RuntimeDaemonJsonSchema;
  readonly oneOf?: readonly RuntimeDaemonJsonSchema[];
}

export interface RuntimeDaemonMethodSchema {
  readonly params: RuntimeDaemonJsonSchema;
  readonly result: RuntimeDaemonJsonSchema;
}

export interface RuntimeDaemonProtocolSchema {
  readonly protocol: typeof KODAX_DAEMON_PROTOCOL;
  readonly version: typeof KODAX_DAEMON_PROTOCOL_VERSION;
  readonly methods: Record<RuntimeDaemonMethod, RuntimeDaemonMethodSchema>;
  readonly notifications: Record<RuntimeDaemonNotificationMethod, RuntimeDaemonJsonSchema>;
}

const stringSchema: RuntimeDaemonJsonSchema = { type: 'string' };
const booleanSchema: RuntimeDaemonJsonSchema = { type: 'boolean' };
const objectAnySchema: RuntimeDaemonJsonSchema = { type: 'object', additionalProperties: true };
const arrayAnySchema: RuntimeDaemonJsonSchema = { type: 'array', items: objectAnySchema };
const nullOrObjectSchema: RuntimeDaemonJsonSchema = {
  oneOf: [{ type: 'null' }, objectAnySchema],
};
const okSchema = objectSchema({ ok: booleanSchema }, ['ok']);
const noParamsSchema = objectSchema({});

export const RUNTIME_DAEMON_METHOD_SCHEMAS = {
  initialize: {
    params: objectSchema({
      profile: stringSchema,
      token: stringSchema,
      autoStart: booleanSchema,
      endpoint: stringSchema,
      clientInfo: objectAnySchema,
      capabilities: objectAnySchema,
    }, [], true),
    result: objectSchema({
      identity: objectAnySchema,
      capabilities: objectAnySchema,
    }, ['identity', 'capabilities'], true),
  },
  'runtime.initialize': {
    params: objectSchema({
      profile: stringSchema,
      token: stringSchema,
      autoStart: booleanSchema,
      endpoint: stringSchema,
      clientInfo: objectAnySchema,
      capabilities: objectAnySchema,
    }, [], true),
    result: objectSchema({
      identity: objectAnySchema,
      capabilities: objectAnySchema,
    }, ['identity', 'capabilities'], true),
  },
  ping: {
    params: noParamsSchema,
    result: objectSchema({ ok: booleanSchema, runtimeId: stringSchema }, ['ok', 'runtimeId']),
  },
  'runtime.identity': { params: noParamsSchema, result: objectAnySchema },
  'runtime.status': { params: noParamsSchema, result: objectAnySchema },
  'runtime.shutdown': { params: noParamsSchema, result: okSchema },
  'runtime.capabilities': { params: noParamsSchema, result: objectAnySchema },
  'daemon.status': { params: noParamsSchema, result: objectAnySchema },
  'daemon.stop': { params: noParamsSchema, result: okSchema },
  'daemon.logs': { params: noParamsSchema, result: objectAnySchema },

  'session.create': { params: objectAnySchema, result: objectAnySchema },
  'session.load': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: objectAnySchema },
  'session.list': { params: objectAnySchema, result: arrayAnySchema },
  'session.transcript': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: nullOrObjectSchema },
  'session.fork': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.notice.append': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.rewind': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.active_entry.set': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.activeEntry.set': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.compact': { params: objectAnySchema, result: objectAnySchema },
  'session.archive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.unarchive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.delete': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.settings.get': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: objectAnySchema },
  'session.settings.update': {
    params: objectSchema({
      sessionId: stringSchema,
      patch: objectAnySchema,
    }, ['sessionId', 'patch']),
    result: objectAnySchema,
  },

  'run.start': { params: objectAnySchema, result: runStartedSchema() },
  'run.get': { params: runIdParamsSchema(), result: objectAnySchema },
  'run.list': { params: objectAnySchema, result: arrayAnySchema },
  'run.await': { params: runIdParamsSchema(), result: objectAnySchema },
  'run.abort': { params: runIdParamsSchema(), result: okSchema },
  'run.model.set': {
    params: objectSchema({ runId: stringSchema, model: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.provider.set': {
    params: objectSchema({ runId: stringSchema, provider: stringSchema }, ['runId', 'provider']),
    result: okSchema,
  },
  'run.reasoning.set': {
    params: objectSchema({ runId: stringSchema, reasoning: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.setModel': {
    params: objectSchema({ runId: stringSchema, model: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.setProvider': {
    params: objectSchema({ runId: stringSchema, provider: stringSchema }, ['runId', 'provider']),
    result: okSchema,
  },
  'run.setReasoning': {
    params: objectSchema({ runId: stringSchema, reasoning: stringSchema }, ['runId'], true),
    result: okSchema,
  },

  'event.subscribe': { params: filterParamsSchema(), result: subscriptionSchema() },
  'event.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'event.replay': { params: objectAnySchema, result: arrayAnySchema },

  'permission.list': { params: objectAnySchema, result: arrayAnySchema },
  'permission.listPending': { params: objectAnySchema, result: arrayAnySchema },
  'permission.request': { params: objectAnySchema, result: objectAnySchema },
  'permission.respond': {
    params: objectSchema({
      requestId: stringSchema,
      runId: stringSchema,
      decision: objectAnySchema,
    }, ['requestId', 'decision']),
    result: booleanSchema,
  },

  'workflow.list': { params: objectAnySchema, result: arrayAnySchema },
  'workflow.get': { params: runIdParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'workflow.subscribe': { params: filterParamsSchema(), result: subscriptionSchema() },
  'workflow.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'workflow.pause': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.resume': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.stop': { params: runIdParamsSchema(), result: booleanSchema },

  'config.read': { params: noParamsSchema, result: objectAnySchema },
  'config.patch': { params: objectSchema({ patch: objectAnySchema }, ['patch']), result: objectAnySchema },
  'config.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, config: objectAnySchema }, ['ok', 'config']) },
  'model.list': { params: objectSchema({ provider: stringSchema }, [], true), result: objectAnySchema },
  'provider.list': { params: noParamsSchema, result: objectAnySchema },
  'provider.custom.list': { params: noParamsSchema, result: arrayAnySchema },
  'provider.custom.upsert': {
    params: objectSchema({ config: objectAnySchema }, ['config']),
    result: objectAnySchema,
  },
  'provider.custom.remove': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },

  'mcp.server.list': { params: noParamsSchema, result: objectAnySchema },
  'mcp.server.get': { params: objectSchema({ name: stringSchema }, ['name']), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'mcp.server.validate': {
    params: objectSchema({
      name: stringSchema,
      config: objectAnySchema,
    }, ['name', 'config']),
    result: {
      oneOf: [
        objectSchema({ ok: booleanSchema, config: objectAnySchema }, ['ok', 'config'], true),
        objectSchema({ ok: booleanSchema, error: stringSchema }, ['ok', 'error'], true),
      ],
    },
  },
  'mcp.server.upsert': {
    params: objectSchema({
      name: stringSchema,
      config: objectAnySchema,
    }, ['name', 'config']),
    result: objectAnySchema,
  },
  'mcp.server.delete': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },
  'mcp.server.remove': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },
  'mcp.server.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, servers: arrayAnySchema }, ['ok', 'servers']) },
  'mcp.tool.list': { params: objectSchema({ server: stringSchema, forceRefresh: booleanSchema }, [], true), result: arrayAnySchema },

  'extension.list': {
    params: noParamsSchema,
    result: objectSchema({
      active: booleanSchema,
      extensions: arrayAnySchema,
      diagnostics: objectAnySchema,
    }, ['active', 'extensions'], true),
  },
  'extension.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, active: booleanSchema }, ['ok', 'active'], true) },
  'command.list': { params: objectSchema({ projectRoot: stringSchema }, [], true), result: arrayAnySchema },
  'command.resolve': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },
  'skill.list': {
    params: objectSchema({
      projectRoot: stringSchema,
      userInvocableOnly: booleanSchema,
    }, [], true),
    result: arrayAnySchema,
  },
  'skill.describe': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },
  'skill.read': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },

  'artifact.create': { params: objectSchema({ kind: stringSchema, path: stringSchema }, ['kind', 'path'], true), result: objectAnySchema },
  'artifact.get': { params: objectSchema({ artifactId: stringSchema }, ['artifactId']), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'artifact.delete': { params: objectSchema({ artifactId: stringSchema }, ['artifactId']), result: booleanSchema },

  'context.budget.get': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'tool.exposure.preview': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
} satisfies Record<RuntimeDaemonMethod, RuntimeDaemonMethodSchema>;

export const RUNTIME_DAEMON_NOTIFICATION_SCHEMAS = {
  event: objectSchema({ subscriptionId: stringSchema, event: objectAnySchema }, ['subscriptionId', 'event']),
  'runtime.warning': objectAnySchema,
} satisfies Record<RuntimeDaemonNotificationMethod, RuntimeDaemonJsonSchema>;

export const RUNTIME_DAEMON_PROTOCOL_SCHEMA: RuntimeDaemonProtocolSchema = {
  protocol: KODAX_DAEMON_PROTOCOL,
  version: KODAX_DAEMON_PROTOCOL_VERSION,
  methods: RUNTIME_DAEMON_METHOD_SCHEMAS,
  notifications: RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
};

export const RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON = JSON.stringify(
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  null,
  2,
);

export function listRuntimeDaemonSchemaMethods(): readonly RuntimeDaemonMethod[] {
  return RUNTIME_DAEMON_METHODS;
}

function objectSchema(
  properties: Record<string, RuntimeDaemonJsonSchema>,
  required: readonly string[] = [],
  additionalProperties: boolean | RuntimeDaemonJsonSchema = false,
): RuntimeDaemonJsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  };
}

function runIdParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({ runId: stringSchema }, ['runId']);
}

function filterParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({ filter: objectAnySchema }, [], true);
}

function diagnosticParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
  }, [], true);
}

function subscriptionSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']);
}

function runStartedSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    turnId: stringSchema,
  }, ['runId', 'sessionId'], true);
}
