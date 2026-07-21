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
  readonly maxLength?: number;
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
const integerSchema: RuntimeDaemonJsonSchema = { type: 'integer' };
const objectAnySchema: RuntimeDaemonJsonSchema = { type: 'object', additionalProperties: true };
const anyValueSchema: RuntimeDaemonJsonSchema = {};
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
      connectionPurpose: { type: 'string', enum: ['client', 'probe'] },
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
      connectionPurpose: { type: 'string', enum: ['client', 'probe'] },
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
  'daemon.preflight': { params: noParamsSchema, result: objectAnySchema },
  'daemon.management.get': {
    params: noParamsSchema,
    result: objectSchema({
      runtimeId: stringSchema,
      revision: integerSchema,
      ownerPolicy: ownerPolicySchema(),
      owner: ownerIdentitySchema(),
      preflight: objectAnySchema,
    }, ['runtimeId', 'revision', 'ownerPolicy', 'owner', 'preflight']),
  },
  'daemon.rollbackToInline': {
    params: objectSchema({
      expectedRuntimeId: stringSchema,
      expectedRevision: integerSchema,
      expectedOwnerPolicyRevision: integerSchema,
    }, ['expectedRuntimeId', 'expectedRevision', 'expectedOwnerPolicyRevision']),
    result: objectSchema({
      accepted: { type: 'boolean', enum: [true] },
      runtimeId: stringSchema,
      revision: integerSchema,
      ownerPolicy: ownerPolicySchema('inline'),
    }, ['accepted', 'runtimeId', 'revision', 'ownerPolicy']),
  },
  'operation.get': {
    params: objectSchema({
      operationId: stringSchema,
      journalEpoch: stringSchema,
    }, ['operationId', 'journalEpoch']),
    result: objectAnySchema,
  },

  'session.create': { params: createSessionParamsSchema(), result: sessionSchema() },
  'session.load': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: sessionSchema(),
  },
  'session.list': { params: sessionFilterSchema(), result: arraySchema(sessionSchema()) },
  'session.transcript': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: nullOrObjectSchema },
  'session.transcript.page': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.transcript.entryChunk': { params: objectAnySchema, result: nullOrObjectSchema },
  'session.observe': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'session.fork': { params: forkSessionParamsSchema(), result: nullableSchema(sessionSchema()) },
  'session.notice.append': {
    params: objectSchema({
      sessionId: stringSchema,
      content: stringSchema,
      source: stringSchema,
    }, ['sessionId', 'content']),
    result: nullOrObjectSchema,
  },
  'session.rewind': {
    params: objectSchema({ sessionId: stringSchema, selector: stringSchema }, ['sessionId']),
    result: nullableSchema(sessionSchema()),
  },
  'session.active_entry.set': {
    params: activeEntryParamsSchema(),
    result: nullableSchema(sessionSchema()),
  },
  'session.activeEntry.set': {
    params: activeEntryParamsSchema(),
    result: nullableSchema(sessionSchema()),
  },
  'session.compact': { params: compactSessionParamsSchema(), result: objectAnySchema },
  'session.archive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.unarchive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.delete': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.settings.get': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: objectAnySchema },
  'session.settings.getVersioned': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'session.autoMode.getStats': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: nullableSchema(objectAnySchema),
  },
  'session.settings.update': {
    params: objectSchema({
      sessionId: stringSchema,
      patch: objectAnySchema,
    }, ['sessionId', 'patch']),
    result: objectAnySchema,
  },
  'session.settings.updateVersioned': {
    params: objectSchema({
      sessionId: stringSchema,
      patch: objectAnySchema,
      expectedRevision: integerSchema,
    }, ['sessionId', 'patch', 'expectedRevision']),
    result: objectAnySchema,
  },

  'run.start': { params: startRunParamsSchema(), result: runStartedSchema() },
  'run.input.submit': {
    params: objectSchema({
      sessionId: stringSchema,
      afterRunId: stringSchema,
      delivery: { type: 'string', enum: ['after_turn', 'interrupt'] },
      input: anyValueSchema,
      credential: objectAnySchema,
      hostTools: objectAnySchema,
    }, ['sessionId', 'afterRunId', 'delivery', 'input']),
    result: objectAnySchema,
  },
  'run.get': { params: runIdParamsSchema(), result: runStatusSchema() },
  'run.list': { params: runFilterSchema(), result: arraySchema(runStatusSchema()) },
  'run.await': { params: runIdParamsSchema(), result: runResultSchema() },
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

  'event.subscribe': { params: filterParamsSchema(eventFilterSchema()), result: subscriptionSchema() },
  'event.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'event.replay': { params: eventReplayFilterSchema(), result: arraySchema(runtimeEventSchema()) },

  'permission.list': { params: permissionFilterSchema(), result: arraySchema(permissionRequestSchema()) },
  'permission.listPending': { params: permissionFilterSchema(), result: arraySchema(permissionRequestSchema()) },
  'permission.request': { params: permissionRequestInputSchema(), result: permissionDecisionSchema() },
  'permission.respond': {
    params: objectSchema({
      requestId: stringSchema,
      runId: stringSchema,
      decision: permissionDecisionSchema(),
    }, ['requestId', 'decision']),
    result: booleanSchema,
  },
  'permission.grants.list': { params: noParamsSchema, result: objectAnySchema },
  'permission.grants.revoke': {
    params: objectSchema({ grantId: stringSchema, expectedRevision: integerSchema }, ['grantId', 'expectedRevision']),
    result: booleanSchema,
  },
  'user_input.listPending': { params: permissionFilterSchema(), result: arraySchema(objectAnySchema) },
  'user_input.respond': {
    params: objectSchema({
      requestId: stringSchema,
      answer: anyValueSchema,
      runId: stringSchema,
      expectedRevision: integerSchema,
    }, ['requestId', 'answer'], true),
    result: objectAnySchema,
  },
  'user_input.dismiss': {
    params: objectSchema({
      requestId: stringSchema,
      runId: stringSchema,
      expectedRevision: integerSchema,
    }, ['requestId'], true),
    result: objectAnySchema,
  },
  'credential.register': {
    params: objectSchema({
      leaseId: stringSchema,
      providers: { type: 'array', items: stringSchema },
      expiresAt: stringSchema,
    }, ['leaseId', 'providers'], true),
    result: objectAnySchema,
  },
  'credential.get': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'credential.revoke': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: booleanSchema,
  },
  'credential.supply': {
    params: objectSchema({ requestId: stringSchema, credential: stringSchema, error: stringSchema }, ['requestId'], true),
    result: okSchema,
  },
  'host_tool.register': {
    params: objectSchema({
      leaseId: stringSchema,
      tools: { type: 'array', items: objectAnySchema },
    }, ['leaseId', 'tools']),
    result: objectAnySchema,
  },
  'host_tool.get': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'host_tool.invocation.get': {
    params: objectSchema({ invocationId: stringSchema }, ['invocationId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'host_tool.revoke': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: booleanSchema,
  },
  'host_tool.complete': {
    params: objectSchema({
      invocationId: stringSchema,
      result: objectAnySchema,
      error: stringSchema,
    }, ['invocationId'], true),
    result: okSchema,
  },

  'workflow.list': { params: workflowFilterSchema(), result: arrayAnySchema },
  'workflow.get': { params: runIdParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'workflow.subscribe': { params: filterParamsSchema(workflowFilterSchema()), result: subscriptionSchema() },
  'workflow.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'workflow.pause': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.resume': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.stop': { params: runIdParamsSchema(), result: booleanSchema },

  'learning.list': { params: learningQuerySchema(), result: learningPageSchema() },
  'learning.get': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: learnedCapabilitySchema(),
  },
  'learning.snapshot': { params: noParamsSchema, result: learningSnapshotSchema() },
  'learning.events': {
    params: objectSchema({ afterRevision: integerSchema }, [], true),
    result: arraySchema(learningEventSchema()),
  },
  'learning.acknowledge': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.snooze': {
    params: objectSchema({ nameOrSlug: stringSchema, until: stringSchema }, ['nameOrSlug', 'until']),
    result: okSchema,
  },
  'learning.reject': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.disable': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.rollback': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.promote': {
    params: objectSchema({ nameOrSlug: stringSchema, scope: stringSchema }, ['nameOrSlug', 'scope']),
    result: okSchema,
  },
  'learning.review': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.trust': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },

  'config.read': { params: noParamsSchema, result: objectAnySchema },
  'config.patch': { params: objectSchema({ patch: objectAnySchema }, ['patch']), result: objectAnySchema },
  'config.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, config: objectAnySchema }, ['ok', 'config']) },
  'model.list': {
    params: objectSchema({ provider: stringSchema }, [], true),
    result: { oneOf: [objectAnySchema, arrayAnySchema] },
  },
  'provider.list': { params: noParamsSchema, result: arrayAnySchema },
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

  'artifact.create': {
    params: objectSchema({
      kind: { enum: ['image', 'file', 'video'] },
      path: stringSchema,
      mediaType: stringSchema,
      mimeType: stringSchema,
      name: stringSchema,
      source: { enum: ['user-inline', 'clipboard', 'drag-drop', 'file-picker'] },
      description: stringSchema,
    }, ['kind', 'path']),
    result: artifactSchema(),
  },
  'artifact.get': {
    params: objectSchema({ artifactId: stringSchema }, ['artifactId']),
    result: nullableSchema(artifactSchema()),
  },
  'artifact.delete': { params: objectSchema({ artifactId: stringSchema }, ['artifactId']), result: booleanSchema },

  'agentRegistrations.list': { params: noParamsSchema, result: arrayAnySchema },
  'agentRegistrations.upsert': {
    params: objectSchema({
      registration: objectAnySchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
    }, ['registration']),
    result: objectAnySchema,
  },
  'agentRegistrations.setEnabled': {
    params: objectSchema({
      agentId: stringSchema,
      enabled: booleanSchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
      claimOwner: stringSchema,
    }, ['agentId', 'enabled']),
    result: nullableSchema(objectAnySchema),
  },
  'agentRegistrations.remove': {
    params: objectSchema({
      agentId: stringSchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
    }, ['agentId']),
    result: booleanSchema,
  },
  'agents.listDispatchable': { params: objectAnySchema, result: arrayAnySchema },
  'agents.describe': {
    params: objectSchema({ agentId: stringSchema, query: objectAnySchema }, ['agentId', 'query']),
    result: nullableSchema(objectAnySchema),
  },
  'agents.preflight': { params: objectAnySchema, result: objectAnySchema },
  'agents.tree': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'agents.detail': {
    params: objectSchema({ sessionId: stringSchema, actorPath: stringSchema }, ['sessionId', 'actorPath']),
    result: objectAnySchema,
  },
  'agents.spawn': {
    params: objectSchema({ sessionId: stringSchema, input: objectAnySchema }, ['sessionId', 'input']),
    result: objectAnySchema,
  },
  'agents.send': {
    params: objectSchema({
      sessionId: stringSchema,
      actorPath: stringSchema,
      content: stringSchema,
      classification: { enum: ['public', 'internal', 'sensitive'] },
    }, ['sessionId', 'actorPath', 'content'], true),
    result: okSchema,
  },
  'agents.followup': {
    params: objectSchema({
      sessionId: stringSchema,
      actorPath: stringSchema,
      objective: stringSchema,
      expectedRevision: integerSchema,
    }, ['sessionId', 'actorPath', 'objective'], true),
    result: objectAnySchema,
  },
  'agents.interrupt': {
    params: objectSchema({
      sessionId: stringSchema, actorPath: stringSchema, reason: stringSchema,
    }, ['sessionId', 'actorPath'], true),
    result: okSchema,
  },
  'agents.output': {
    params: objectSchema({
      sessionId: stringSchema, actorPath: stringSchema, turnId: stringSchema,
    }, ['sessionId', 'actorPath'], true),
    result: objectAnySchema,
  },
  'agents.events': {
    params: objectSchema({
      sessionId: stringSchema, afterSequence: integerSchema,
    }, ['sessionId'], true),
    result: arrayAnySchema,
  },
  'agents.wait': {
    params: objectSchema({
      sessionId: stringSchema, afterSequence: integerSchema, timeoutMs: integerSchema,
    }, ['sessionId'], true),
    result: nullableSchema(objectAnySchema),
  },
  'context.budget.get': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'tool.exposure.preview': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
} satisfies Record<RuntimeDaemonMethod, RuntimeDaemonMethodSchema>;

export const RUNTIME_DAEMON_NOTIFICATION_SCHEMAS = {
  event: objectSchema({ subscriptionId: stringSchema, event: objectAnySchema }, ['subscriptionId', 'event']),
  'credential.request': objectAnySchema,
  'host_tool.invoke': objectAnySchema,
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

export function validateRuntimeDaemonJsonSchema(
  schema: RuntimeDaemonJsonSchema,
  value: unknown,
  path = '$',
): readonly string[] {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => (
      validateRuntimeDaemonJsonSchema(candidate, value, path).length === 0
    ));
    return matches.length === 1
      ? []
      : [`${path} must match exactly one allowed schema.`];
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${path} must be one of: ${schema.enum.map(String).join(', ')}.`];
  }

  const types = schema.type === undefined
    ? []
    : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesJsonSchemaType(type, value))) {
    return [`${path} must be ${types.join(' or ')}.`];
  }

  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    return [`${path} must have at most ${schema.maxLength} characters.`];
  }

  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema === undefined) return [];
    return value.flatMap((item, index) => (
      validateRuntimeDaemonJsonSchema(itemSchema, item, `${path}[${index}]`)
    ));
  }

  if (!isJsonObject(value)) return [];
  const issues: string[] = [];
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      issues.push(`${path}.${key} is required.`);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const propertySchema = schema.properties?.[key];
    if (propertySchema !== undefined) {
      issues.push(...validateRuntimeDaemonJsonSchema(propertySchema, item, `${path}.${key}`));
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push(`${path}.${key} is not allowed.`);
    } else if (typeof schema.additionalProperties === 'object') {
      issues.push(...validateRuntimeDaemonJsonSchema(
        schema.additionalProperties,
        item,
        `${path}.${key}`,
      ));
    }
  }
  return issues;
}

function matchesJsonSchemaType(type: RuntimeDaemonJsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isJsonObject(value);
    case 'string':
      return typeof value === 'string';
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function filterParamsSchema(filter: RuntimeDaemonJsonSchema): RuntimeDaemonJsonSchema {
  return objectSchema({ filter });
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

function arraySchema(items: RuntimeDaemonJsonSchema): RuntimeDaemonJsonSchema {
  return { type: 'array', items };
}

function nullableSchema(schema: RuntimeDaemonJsonSchema): RuntimeDaemonJsonSchema {
  return { oneOf: [{ type: 'null' }, schema] };
}

function createSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    title: stringSchema,
    projectPath: stringSchema,
    gitRoot: stringSchema,
    surface: stringSchema,
    profileId: stringSchema,
    tag: stringSchema,
  });
}

function sessionSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    cursor: stringSchema,
    title: stringSchema,
    gitRoot: stringSchema,
    workspaceRoot: stringSchema,
    surface: stringSchema,
    profileId: stringSchema,
    createdAt: stringSchema,
    msgCount: integerSchema,
    tag: stringSchema,
    projectKey: stringSchema,
    archived: booleanSchema,
  }, ['id', 'title'], true);
}

function sessionFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    projectRoot: stringSchema,
    scope: { enum: ['user', 'managed-task-worker', 'all'] },
    includeArchived: booleanSchema,
    limit: integerSchema,
    before: stringSchema,
    tag: stringSchema,
    surface: stringSchema,
    cursor: stringSchema,
  });
}

function learningQuerySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    search: stringSchema,
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
    lifecycle: {
      enum: [
        'opportunity', 'drafting', 'ready', 'testing', 'active_learned',
        'promoted_user', 'quarantined', 'archived', 'rejected',
      ],
    },
    limit: integerSchema,
    cursor: stringSchema,
  });
}

function learnedCapabilitySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    schemaVersion: { type: 'integer', enum: [1] },
    capabilityId: stringSchema,
    displayName: stringSchema,
    slug: stringSchema,
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
    lifecycle: learningLifecycleSchema(),
    revision: integerSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    source: objectSchema({
      kind: { enum: ['learning_controller', 'f224_proposal'] },
      proposalId: stringSchema,
    }, ['kind']),
    lastAction: {
      enum: ['review', 'trust', 'reject', 'disable', 'rollback', 'archive', 'restore', 'promote'],
    },
    artifactPath: stringSchema,
    previousGoodRevision: integerSchema,
    previousLifecycle: learningLifecycleSchema(),
    diagnostics: arraySchema(stringSchema),
  }, [
    'schemaVersion', 'capabilityId', 'displayName', 'slug', 'carrier', 'lifecycle',
    'revision', 'createdAt', 'updatedAt', 'source',
  ]);
}

function learningLifecycleSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'opportunity', 'drafting', 'ready', 'testing', 'active_learned',
      'promoted_user', 'quarantined', 'archived', 'rejected',
    ],
  };
}

function learningEventSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    schemaVersion: { type: 'integer', enum: [1] },
    sequence: integerSchema,
    eventId: stringSchema,
    capabilityId: stringSchema,
    capabilityRevision: integerSchema,
    kind: {
      enum: ['opportunity', 'drafting', 'ready', 'testing', 'activated', 'promoted', 'attention', 'archived', 'rejected'],
    },
    lifecycle: learningLifecycleSchema(),
    displayName: stringSchema,
    slug: stringSchema,
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
    createdAt: stringSchema,
  }, [
    'schemaVersion', 'sequence', 'eventId', 'capabilityId', 'capabilityRevision',
    'kind', 'lifecycle', 'displayName', 'slug', 'carrier', 'createdAt',
  ]);
}

function learningSnapshotSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    ready: integerSchema,
    newlyActive: integerSchema,
    attention: integerSchema,
    active: integerSchema,
    revision: integerSchema,
  }, ['ready', 'newlyActive', 'attention', 'active', 'revision']);
}

function learningPageSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    items: arraySchema(learnedCapabilitySchema()),
    nextCursor: stringSchema,
    revision: integerSchema,
  }, ['items', 'revision']);
}

function ownerPolicySchema(mode?: 'daemon' | 'inline'): RuntimeDaemonJsonSchema {
  return objectSchema({
    mode: { type: 'string', enum: mode === undefined ? ['daemon', 'inline'] : [mode] },
    revision: integerSchema,
    updatedAt: stringSchema,
  }, ['mode', 'revision', 'updatedAt']);
}

function ownerIdentitySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runtimeId: stringSchema,
    pid: integerSchema,
    createdAt: stringSchema,
    kind: { type: 'string', enum: ['daemon', 'inline'] },
  }, ['runtimeId', 'pid', 'createdAt']);
}

function forkSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    selector: stringSchema,
    newSessionId: stringSchema,
    title: stringSchema,
  }, ['sessionId']);
}

function activeEntryParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    entryId: stringSchema,
  }, ['sessionId', 'entryId']);
}

function compactSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    provider: stringSchema,
    model: stringSchema,
    customInstructions: stringSchema,
    contextWindow: integerSchema,
  }, ['sessionId']);
}

function startRunParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    prompt: stringSchema,
    input: {
      oneOf: [objectAnySchema, arraySchema(objectAnySchema)],
    },
    mode: { enum: ['coding', 'managed_task'] },
    permissionBroker: { enum: ['runtime', 'client'] },
    options: objectAnySchema,
  }, ['sessionId'], true);
}

function runFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    phase: {
      oneOf: [runPhaseSchema(), arraySchema(runPhaseSchema())],
    },
  });
}

function runStatusSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    turnId: stringSchema,
    phase: runPhaseSchema(),
    startedAt: stringSchema,
    endedAt: stringSchema,
    provider: stringSchema,
    model: stringSchema,
    reasoning: stringSchema,
    error: stringSchema,
  }, ['runId', 'sessionId', 'phase', 'startedAt', 'provider'], true);
}

function runResultSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    phase: runPhaseSchema(),
    result: objectAnySchema,
    error: {
      oneOf: [stringSchema, objectAnySchema],
    },
  }, ['runId', 'sessionId', 'phase'], true);
}

function runPhaseSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'queued',
      'running',
      'waiting_permission',
      'waiting_user_input',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ],
  };
}

function eventFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    type: {
      oneOf: [stringSchema, arraySchema(stringSchema)],
    },
  });
}

function eventReplayFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    ...(eventFilterSchema().properties ?? {}),
    sinceSeq: integerSchema,
    limit: integerSchema,
  });
}

function runtimeEventSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    seq: integerSchema,
    time: stringSchema,
    sessionId: stringSchema,
    runId: stringSchema,
    turnId: stringSchema,
    type: stringSchema,
    payload: {},
  }, ['id', 'seq', 'time', 'sessionId', 'runId', 'type', 'payload'], true);
}

function permissionFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    toolName: stringSchema,
  });
}

function permissionRequestInputSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    turnId: stringSchema,
    toolCallId: stringSchema,
    toolName: stringSchema,
    reason: stringSchema,
    risk: { enum: ['low', 'medium', 'high'] },
    // The Runtime replaces caller input with its own bounded/redacted JSON
    // summary before the request becomes observable or is returned.
    inputPreview: stringSchema,
    // Public concrete-call input. The Runtime canonicalizes this value and
    // issues opaque grant candidates; raw input is never copied to events or
    // persisted grants.
    toolInput: objectAnySchema,
    executionCwd: { type: 'string', maxLength: 4_096 },
    expiresAt: stringSchema,
    timeoutMs: integerSchema,
  }, ['sessionId', 'runId', 'toolName']);
}

function permissionRequestSchema(): RuntimeDaemonJsonSchema {
  const {
    toolInput: _toolInput,
    ...observableRequestProperties
  } = permissionRequestInputSchema().properties ?? {};
  return objectSchema({
    ...observableRequestProperties,
    inputPreview: { type: 'string', maxLength: 8_192 },
    grantSuggestions: arraySchema(objectSchema({
      id: stringSchema,
      kind: { enum: ['session', 'persistent'] },
      label: { type: 'string', maxLength: 512 },
    }, ['id', 'kind', 'label'])),
    id: stringSchema,
    createdAt: stringSchema,
  }, ['id', 'sessionId', 'runId', 'toolName', 'createdAt'], true);
}

function permissionDecisionSchema(): RuntimeDaemonJsonSchema {
  return {
    oneOf: [
      objectSchema({ type: { enum: ['allow_once'] } }, ['type']),
      objectSchema({
        type: { enum: ['allow_session'] },
        suggestionId: stringSchema,
      }, ['type', 'suggestionId']),
      objectSchema({
        type: { enum: ['allow_always'] },
        suggestionId: stringSchema,
      }, ['type', 'suggestionId']),
      objectSchema({
        type: { enum: ['allow_always'] },
        scope: objectSchema({
          toolName: stringSchema,
          sessionId: stringSchema,
          matcher: runtimePermissionMatcherSchema(),
        }),
      }, ['type', 'scope']),
      objectSchema({
        type: { enum: ['reject'] },
        reason: stringSchema,
      }, ['type']),
    ],
  };
}

function runtimePermissionMatcherSchema(): RuntimeDaemonJsonSchema {
  const base = {
    version: { type: 'integer' as const, enum: [1] },
    toolName: stringSchema,
    fingerprint: stringSchema,
  };
  return {
    oneOf: [
      objectSchema({
        ...base,
        kind: { enum: ['exact-command'] },
        shell: { enum: ['cmd', 'posix'] },
        commandFingerprint: stringSchema,
        cwd: stringSchema,
        executable: stringSchema,
        argvFingerprint: stringSchema,
        background: booleanSchema,
      }, [
        'version', 'kind', 'toolName', 'fingerprint', 'shell',
        'commandFingerprint', 'cwd', 'background',
      ]),
      objectSchema({
        ...base,
        kind: { enum: ['exact-path'] },
        path: stringSchema,
      }, ['version', 'kind', 'toolName', 'fingerprint', 'path']),
      objectSchema({
        ...base,
        kind: { enum: ['exact-call'] },
        cwd: stringSchema,
        inputFingerprint: stringSchema,
      }, [
        'version', 'kind', 'toolName', 'fingerprint', 'cwd', 'inputFingerprint',
      ]),
    ],
  };
}

function workflowFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    activeOnly: booleanSchema,
    limit: integerSchema,
  });
}

function artifactSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    kind: { enum: ['image', 'file', 'video'] },
    path: stringSchema,
    sizeBytes: integerSchema,
    mediaType: stringSchema,
    mimeType: stringSchema,
    name: stringSchema,
    source: { enum: ['user-inline', 'clipboard', 'drag-drop', 'file-picker'] },
    description: stringSchema,
    createdAt: stringSchema,
  }, ['id', 'kind', 'path', 'sizeBytes', 'createdAt'], true);
}
