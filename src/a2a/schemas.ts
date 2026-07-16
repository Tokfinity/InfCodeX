import { A2AError } from './errors.js';
import { parseA2ASecurity } from './security.js';
import type {
  A2AAgentCard,
  A2AAgentExtension,
  A2AAgentInterface,
  A2AAgentSkill,
  A2AArtifact,
  A2AJsonRpcRequest,
  A2AMessage,
  A2APart,
  A2ATask,
  A2ATaskState,
} from './types.js';

const TASK_STATES = new Set<A2ATaskState>([
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mediaTypeEssence(value: string | null): string | undefined {
  if (value === null) return undefined;
  const essence = value.split(';', 1)[0]?.trim().toLowerCase();
  return essence && !/\s/u.test(essence) ? essence : undefined;
}

export function isJsonMediaType(value: string | null): boolean {
  const essence = mediaTypeEssence(value);
  return essence === 'application/json'
    || /^application\/[!#$%&'*+\-.^_`|~0-9a-z]+\+json$/u.test(essence ?? '');
}

export function isEventStreamMediaType(value: string | null): boolean {
  return mediaTypeEssence(value) === 'text/event-stream';
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new A2AError(-32602, `${label}.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new A2AError(-32602, `${label} must be a string array.`);
  }
  return value;
}

function parseInterface(value: unknown): A2AAgentInterface {
  if (!isRecord(value)) throw new A2AError(-32602, 'Agent Card interface is invalid.');
  return {
    url: requiredString(value, 'url', 'interface'),
    protocolBinding: requiredString(value, 'protocolBinding', 'interface'),
    protocolVersion: requiredString(value, 'protocolVersion', 'interface'),
    ...(optionalString(value, 'tenant') ? { tenant: optionalString(value, 'tenant') } : {}),
  };
}

function validateSecurity(
  schemes: unknown,
  requirements: unknown,
  label: string,
): void {
  try {
    parseA2ASecurity(schemes, requirements);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new A2AError(-32602, `${label} is invalid: ${detail}`);
  }
}

function parseSkill(value: unknown, securitySchemes: unknown): A2AAgentSkill {
  if (!isRecord(value)) throw new A2AError(-32602, 'Agent Card skill is invalid.');
  if (value.securityRequirements !== undefined) {
    validateSecurity(securitySchemes, value.securityRequirements, 'skill.securityRequirements');
  }
  return {
    id: requiredString(value, 'id', 'skill'),
    name: requiredString(value, 'name', 'skill'),
    description: requiredString(value, 'description', 'skill'),
    tags: stringArray(value.tags, 'skill.tags'),
    ...(Array.isArray(value.examples) ? { examples: stringArray(value.examples, 'skill.examples') } : {}),
    ...(Array.isArray(value.inputModes) ? { inputModes: stringArray(value.inputModes, 'skill.inputModes') } : {}),
    ...(Array.isArray(value.outputModes) ? { outputModes: stringArray(value.outputModes, 'skill.outputModes') } : {}),
    ...(Array.isArray(value.securityRequirements)
      ? { securityRequirements: value.securityRequirements.filter(isRecord) } : {}),
  };
}

function parseExtension(value: unknown): A2AAgentExtension {
  if (!isRecord(value)) throw new A2AError(-32602, 'Agent Card extension is invalid.');
  const uri = requiredString(value, 'uri', 'extension');
  try {
    new URL(uri);
  } catch {
    throw new A2AError(-32602, 'Agent Card extension.uri must be an absolute URI.');
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new A2AError(-32602, 'Agent Card extension.description must be a string.');
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new A2AError(-32602, 'Agent Card extension.required must be a boolean.');
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new A2AError(-32602, 'Agent Card extension.params must be an object.');
  }
  return {
    uri,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
    ...(isRecord(value.params) ? { params: value.params } : {}),
  };
}

export function parseA2AAgentCard(value: unknown): A2AAgentCard {
  if (!isRecord(value)) throw new A2AError(-32602, 'Agent Card must be an object.');
  const interfaces = value.supportedInterfaces;
  const skills = value.skills;
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new A2AError(-32602, 'Agent Card must declare supportedInterfaces.');
  }
  if (!Array.isArray(skills)) throw new A2AError(-32602, 'Agent Card must declare skills.');
  if (!isRecord(value.capabilities)) throw new A2AError(-32602, 'Agent Card capabilities are invalid.');
  if (value.capabilities.extensions !== undefined
    && !Array.isArray(value.capabilities.extensions)) {
    throw new A2AError(-32602, 'Agent Card capabilities.extensions must be an array.');
  }
  validateSecurity(value.securitySchemes, value.securityRequirements, 'Agent Card security declaration');
  return {
    name: requiredString(value, 'name', 'Agent Card'),
    description: requiredString(value, 'description', 'Agent Card'),
    supportedInterfaces: interfaces.map(parseInterface),
    version: requiredString(value, 'version', 'Agent Card'),
    capabilities: {
      ...(typeof value.capabilities.streaming === 'boolean'
        ? { streaming: value.capabilities.streaming } : {}),
      ...(typeof value.capabilities.pushNotifications === 'boolean'
        ? { pushNotifications: value.capabilities.pushNotifications } : {}),
      ...(typeof value.capabilities.extendedAgentCard === 'boolean'
        ? { extendedAgentCard: value.capabilities.extendedAgentCard } : {}),
      ...(Array.isArray(value.capabilities.extensions)
        ? { extensions: value.capabilities.extensions.map(parseExtension) } : {}),
    },
    ...(isRecord(value.securitySchemes) ? { securitySchemes: value.securitySchemes } : {}),
    ...(Array.isArray(value.securityRequirements)
      ? { securityRequirements: value.securityRequirements.filter(isRecord) } : {}),
    defaultInputModes: stringArray(value.defaultInputModes, 'Agent Card defaultInputModes'),
    defaultOutputModes: stringArray(value.defaultOutputModes, 'Agent Card defaultOutputModes'),
    skills: skills.map((skill) => parseSkill(skill, value.securitySchemes)),
  };
}

export function parseA2APart(value: unknown): A2APart {
  if (!isRecord(value)) throw new A2AError(-32602, 'Message Part must be an object.');
  const keys = ['text', 'raw', 'url', 'data'].filter((key) => value[key] !== undefined);
  if (keys.length !== 1) throw new A2AError(-32602, 'Message Part must contain exactly one content field.');
  const contentKey = keys[0]!;
  if (contentKey !== 'data' && typeof value[contentKey] !== 'string') {
    throw new A2AError(-32602, `Message Part ${contentKey} content must be a string.`);
  }
  return {
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.raw === 'string' ? { raw: value.raw } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(optionalString(value, 'filename') ? { filename: optionalString(value, 'filename') } : {}),
    ...(optionalString(value, 'mediaType') ? { mediaType: optionalString(value, 'mediaType') } : {}),
  };
}

export function parseA2AMessage(value: unknown): A2AMessage {
  if (!isRecord(value)) throw new A2AError(-32602, 'Message must be an object.');
  if (value.role !== 'ROLE_USER' && value.role !== 'ROLE_AGENT') {
    throw new A2AError(-32602, 'Message role is invalid.');
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw new A2AError(-32602, 'Message parts must not be empty.');
  }
  return {
    messageId: requiredString(value, 'messageId', 'Message'),
    role: value.role,
    parts: value.parts.map(parseA2APart),
    ...(optionalString(value, 'contextId') ? { contextId: optionalString(value, 'contextId') } : {}),
    ...(optionalString(value, 'taskId') ? { taskId: optionalString(value, 'taskId') } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function parseArtifact(value: unknown): A2AArtifact {
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw new A2AError(-32603, 'A2A artifact is invalid.');
  }
  return {
    artifactId: requiredString(value, 'artifactId', 'Artifact'),
    parts: value.parts.map(parseA2APart),
    ...(optionalString(value, 'name') ? { name: optionalString(value, 'name') } : {}),
    ...(optionalString(value, 'description') ? { description: optionalString(value, 'description') } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

export function parseA2ATask(value: unknown): A2ATask {
  if (!isRecord(value) || !isRecord(value.status)) throw new A2AError(-32603, 'A2A task is invalid.');
  const state = value.status.state;
  if (typeof state !== 'string') {
    throw new A2AError(-32603, 'A2A task state is invalid.');
  }
  const normalizedState = TASK_STATES.has(state as A2ATaskState)
    ? state as A2ATaskState
    : 'TASK_STATE_UNSPECIFIED';
  return {
    id: requiredString(value, 'id', 'Task'),
    contextId: optionalString(value, 'contextId') ?? '',
    status: {
      state: normalizedState,
      ...(value.status.message !== undefined ? { message: parseA2AMessage(value.status.message) } : {}),
      ...(optionalString(value.status, 'timestamp') ? { timestamp: optionalString(value.status, 'timestamp') } : {}),
    },
    ...(Array.isArray(value.artifacts) ? { artifacts: value.artifacts.map(parseArtifact) } : {}),
    ...(Array.isArray(value.history) ? { history: value.history.map(parseA2AMessage) } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

export function parseJsonRpcRequest(value: unknown): A2AJsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0') throw new A2AError(-32600, 'Invalid JSON-RPC request.');
  if (typeof value.id !== 'string' && typeof value.id !== 'number') {
    throw new A2AError(-32600, 'JSON-RPC request id is required.');
  }
  return {
    jsonrpc: '2.0',
    id: value.id,
    method: requiredString(value, 'method', 'JSON-RPC request'),
    ...(isRecord(value.params) ? { params: value.params } : {}),
  };
}
