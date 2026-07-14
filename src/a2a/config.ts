import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  resolveIntegrationConfigPath,
  writeIntegrationDocument,
  type IntegrationConfigSnapshot,
} from '@kodax-ai/repl';

export type A2AOutboundEffect = 'none' | 'read' | 'write' | 'unknown';

export interface A2AOutboundAgentConfig {
  readonly cardUrl: string;
  readonly credentialEnv?: string;
  readonly effect: A2AOutboundEffect;
}

export type A2AWorkspaceConfig =
  | { readonly mode: 'managed' }
  | { readonly mode: 'fixed'; readonly root: string };

export interface A2AToolPolicyConfig {
  readonly workspace: 'none' | 'read' | 'write';
  readonly process: 'deny' | 'isolated';
  readonly network:
    | { readonly mode: 'deny' }
    | { readonly mode: 'allowlist'; readonly origins: readonly string[] };
  readonly tools: readonly string[];
  readonly mcp: Readonly<Record<string, readonly string[]>>;
  readonly skillScripts: Readonly<Record<string, readonly string[]>>;
  readonly subagents: 'deny' | 'inherit';
}

export interface A2AUserMarkdownAgentConfigRef {
  readonly source: 'markdown:user';
  readonly name: string;
}

interface A2AExecutionBase {
  readonly profileId?: string;
  readonly workspace: A2AWorkspaceConfig;
  readonly toolPolicy: A2AToolPolicyConfig;
}

export type A2AServerExecutionConfig =
  | (A2AExecutionBase & { readonly kind: 'runtime-default' })
  | (A2AExecutionBase & {
      readonly kind: 'local-agent';
      readonly agentRef: A2AUserMarkdownAgentConfigRef;
    });

export interface A2APublishedSkillConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface A2APublishedAgentConfig {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly A2APublishedSkillConfig[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
}

export interface A2ABearerAuthenticationConfig {
  readonly type: 'bearer-env';
  readonly tokenEnv: string;
  readonly principalId: string;
}

export interface A2AServerLimitsConfig {
  readonly maxRequestBytes: number;
  readonly maxPartBytes: number;
  readonly maxConcurrentTasks: number;
  readonly maxTaskWaitMs: number;
  readonly maxActiveTasksPerPrincipal: number;
  readonly maxRetainedTasksPerPrincipal: number;
  readonly maxEventsPerTask: number;
  readonly maxEventBytesPerTask: number;
  readonly maxWorkspaceBytesPerContext: number;
}

export interface A2AServerConfig {
  readonly execution: A2AServerExecutionConfig;
  readonly published: A2APublishedAgentConfig;
  readonly publicBaseUrl?: string;
  readonly authentication: A2ABearerAuthenticationConfig;
  readonly limits: A2AServerLimitsConfig;
  readonly dataDir: string;
}

export interface A2AIntegrationDocument {
  readonly version: 1;
  readonly agents: Readonly<Record<string, A2AOutboundAgentConfig>>;
  readonly server?: A2AServerConfig;
}

export interface A2AServerConfigChange {
  readonly kind: 'none' | 'hot' | 'restart-required';
  readonly fields: readonly string[];
}

const LIMIT_DEFAULTS: A2AServerLimitsConfig = {
  maxRequestBytes: 33_554_432,
  maxPartBytes: 16_777_216,
  maxConcurrentTasks: 4,
  maxTaskWaitMs: 30_000,
  maxActiveTasksPerPrincipal: 4,
  maxRetainedTasksPerPrincipal: 100,
  maxEventsPerTask: 1_000,
  maxEventBytesPerTask: 16_777_216,
  maxWorkspaceBytesPerContext: 1_073_741_824,
};

const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS) as readonly (keyof A2AServerLimitsConfig)[];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function noUnknown(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field "${unknown}".`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings.`);
  }
  const items = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates.`);
  return items;
}

function exactNames(value: unknown, label: string, allowEmpty = true): string[] {
  const items = stringList(value, label, allowEmpty);
  if (items.some((item) => item.includes('*'))) {
    throw new Error(`${label} does not accept wildcard authority.`);
  }
  return items;
}

function namedExactLists(value: unknown, label: string): Record<string, readonly string[]> {
  const source = record(value, label);
  const result: Record<string, readonly string[]> = {};
  for (const [name, rawItems] of Object.entries(source)) {
    if (!NAME_PATTERN.test(name) || name.includes('*')) {
      throw new Error(`${label} keys must be exact names without wildcards.`);
    }
    result[name] = exactNames(rawItems, `${label}.${name}`, false);
  }
  return result;
}

function parseOutboundAgent(value: unknown, label: string): A2AOutboundAgentConfig {
  const source = record(value, label);
  noUnknown(source, ['cardUrl', 'credentialEnv', 'effect'], label);
  const cardUrl = parseHttpUrl(source.cardUrl, `${label}.cardUrl`, true);
  const effect = source.effect;
  if (!['none', 'read', 'write', 'unknown'].includes(String(effect))) {
    throw new Error(`${label}.effect is invalid.`);
  }
  const credentialEnv = source.credentialEnv === undefined
    ? undefined
    : parseEnvironmentName(source.credentialEnv, `${label}.credentialEnv`);
  return { cardUrl, ...(credentialEnv ? { credentialEnv } : {}), effect: effect as A2AOutboundEffect };
}

function parseHttpUrl(value: unknown, label: string, requireHttps: boolean): string {
  const raw = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error: unknown) {
    throw new Error(`${label} must be an absolute HTTP URL.`, { cause: error });
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback && requireHttps)) {
    throw new Error(`${label} must use HTTPS or explicit loopback HTTP.`);
  }
  return parsed.toString();
}

function parseEnvironmentName(value: unknown, label: string): string {
  const name = text(value, label);
  if (!ENV_PATTERN.test(name)) throw new Error(`${label} must be an environment variable name.`);
  return name;
}

function parseWorkspace(value: unknown): A2AWorkspaceConfig {
  if (value === undefined) return { mode: 'managed' };
  const source = record(value, 'A2A server execution.workspace');
  if (source.mode === 'managed') {
    noUnknown(source, ['mode'], 'A2A server execution.workspace');
    return { mode: 'managed' };
  }
  if (source.mode !== 'fixed') throw new Error('A2A server execution.workspace.mode is invalid.');
  noUnknown(source, ['mode', 'root'], 'A2A server execution.workspace');
  const root = text(source.root, 'A2A server execution.workspace.root');
  if (!path.isAbsolute(root)) throw new Error('Fixed A2A workspace root must be absolute.');
  return { mode: 'fixed', root: path.resolve(root) };
}

function defaultToolPolicy(workspace: A2AWorkspaceConfig): A2AToolPolicyConfig {
  return {
    workspace: workspace.mode === 'managed' ? 'write' : 'read',
    process: 'deny',
    network: { mode: 'deny' },
    tools: [],
    mcp: {},
    skillScripts: {},
    subagents: 'deny',
  };
}

function parseNetworkPolicy(value: unknown): A2AToolPolicyConfig['network'] {
  const source = record(value, 'A2A toolPolicy.network');
  if (source.mode === 'deny') {
    noUnknown(source, ['mode'], 'A2A toolPolicy.network');
    return { mode: 'deny' };
  }
  if (source.mode !== 'allowlist') throw new Error('A2A toolPolicy.network.mode is invalid.');
  noUnknown(source, ['mode', 'origins'], 'A2A toolPolicy.network');
  const origins = stringList(source.origins, 'A2A toolPolicy.network.origins').map((origin) => {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch (error: unknown) { throw new Error('A2A toolPolicy network origins must be absolute HTTP origins.', { cause: error }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
      throw new Error('A2A toolPolicy network origins must be absolute HTTP origins.');
    }
    return parsed.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error('A2A toolPolicy.network.origins contains duplicates after normalization.');
  }
  return { mode: 'allowlist', origins };
}

function parseSkillScripts(value: unknown): Record<string, readonly string[]> {
  const scripts = namedExactLists(value, 'A2A toolPolicy.skillScripts');
  for (const [skill, entries] of Object.entries(scripts)) {
    scripts[skill] = entries.map((entry) => {
      if (entry.includes('\\') || path.posix.isAbsolute(entry)) {
        throw new Error('A2A skillScripts paths must use relative POSIX scripts/... paths.');
      }
      const normalized = path.posix.normalize(entry);
      if (!normalized.startsWith('scripts/') || normalized.includes('../')) {
        throw new Error('A2A skillScripts paths must remain below the Skill scripts directory.');
      }
      return normalized;
    });
  }
  return scripts;
}

function parseToolPolicy(value: unknown, workspace: A2AWorkspaceConfig): A2AToolPolicyConfig {
  if (value === undefined) return defaultToolPolicy(workspace);
  const source = record(value, 'A2A server execution.toolPolicy');
  const keys = ['workspace', 'process', 'network', 'tools', 'mcp', 'skillScripts', 'subagents'];
  noUnknown(source, keys, 'A2A server execution.toolPolicy');
  if (keys.some((key) => source[key] === undefined)) {
    throw new Error('A2A server execution.toolPolicy must be a complete object when present.');
  }
  if (!['none', 'read', 'write'].includes(String(source.workspace))) {
    throw new Error('A2A toolPolicy.workspace is invalid.');
  }
  if (!['deny', 'isolated'].includes(String(source.process))) {
    throw new Error('A2A toolPolicy.process is invalid.');
  }
  if (!['deny', 'inherit'].includes(String(source.subagents))) {
    throw new Error('A2A toolPolicy.subagents is invalid.');
  }
  const skillScripts = parseSkillScripts(source.skillScripts);
  const scriptCount = Object.values(skillScripts).reduce((sum, entries) => sum + entries.length, 0);
  if (source.process === 'deny' && scriptCount > 0) {
    throw new Error('A2A toolPolicy process deny requires empty skillScripts.');
  }
  if (source.process === 'isolated' && scriptCount === 0) {
    throw new Error('A2A toolPolicy process isolated requires non-empty skillScripts.');
  }
  return {
    workspace: source.workspace as A2AToolPolicyConfig['workspace'],
    process: source.process as A2AToolPolicyConfig['process'],
    network: parseNetworkPolicy(source.network),
    tools: exactNames(source.tools, 'A2A toolPolicy.tools'),
    mcp: namedExactLists(source.mcp, 'A2A toolPolicy.mcp'),
    skillScripts,
    subagents: source.subagents as A2AToolPolicyConfig['subagents'],
  };
}

function parseExecution(value: unknown): A2AServerExecutionConfig {
  const source = record(value, 'A2A server execution');
  const workspace = parseWorkspace(source.workspace);
  const toolPolicy = parseToolPolicy(source.toolPolicy, workspace);
  const profileId = source.profileId === undefined
    ? undefined
    : text(source.profileId, 'A2A server execution.profileId');
  if (source.kind === 'runtime-default') {
    noUnknown(source, ['kind', 'workspace', 'toolPolicy', 'profileId'], 'A2A server execution');
    return { kind: 'runtime-default', workspace, toolPolicy, ...(profileId ? { profileId } : {}) };
  }
  if (source.kind !== 'local-agent') throw new Error('A2A server execution.kind is invalid.');
  noUnknown(source, ['kind', 'agentRef', 'workspace', 'toolPolicy', 'profileId'], 'A2A server execution');
  const rawRef = record(source.agentRef, 'A2A server execution.agentRef');
  noUnknown(rawRef, ['source', 'name'], 'A2A server execution.agentRef');
  if (rawRef.source !== 'markdown:user') {
    throw new Error('A2A local Agent source must be markdown:user.');
  }
  const name = text(rawRef.name, 'A2A server execution.agentRef.name');
  if (!NAME_PATTERN.test(name)) throw new Error('A2A local Agent name is invalid.');
  return {
    kind: 'local-agent',
    agentRef: { source: 'markdown:user', name },
    workspace,
    toolPolicy,
    ...(profileId ? { profileId } : {}),
  };
}

function parsePublishedSkill(value: unknown, index: number): A2APublishedSkillConfig {
  const label = `A2A server published.skills[${index}]`;
  const source = record(value, label);
  noUnknown(source, ['id', 'name', 'description', 'tags'], label);
  return {
    id: text(source.id, `${label}.id`),
    name: text(source.name, `${label}.name`),
    description: text(source.description, `${label}.description`),
    tags: stringList(source.tags, `${label}.tags`, true),
  };
}

function parsePublished(value: unknown): A2APublishedAgentConfig {
  const source = record(value, 'A2A server published');
  noUnknown(source, ['name', 'description', 'version', 'skills', 'inputModes', 'outputModes'], 'A2A server published');
  if (!Array.isArray(source.skills)) throw new Error('A2A server published.skills must be an array.');
  const skills = source.skills.map(parsePublishedSkill);
  const skillIds = skills.map((skill) => skill.id);
  if (new Set(skillIds).size !== skillIds.length) throw new Error('A2A published Skill ids must be unique.');
  return {
    name: text(source.name, 'A2A server published.name'),
    description: text(source.description, 'A2A server published.description'),
    version: text(source.version, 'A2A server published.version'),
    skills,
    inputModes: stringList(source.inputModes, 'A2A server published.inputModes'),
    outputModes: stringList(source.outputModes, 'A2A server published.outputModes'),
  };
}

function parseAuthentication(value: unknown): A2ABearerAuthenticationConfig {
  const source = record(value, 'A2A server authentication');
  noUnknown(source, ['type', 'tokenEnv', 'principalId'], 'A2A server authentication');
  if (source.type !== 'bearer-env') throw new Error('A2A authentication type must be bearer-env.');
  return {
    type: 'bearer-env',
    tokenEnv: parseEnvironmentName(source.tokenEnv, 'A2A server authentication.tokenEnv'),
    principalId: text(source.principalId, 'A2A server authentication.principalId'),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function parseLimits(value: unknown, execution: A2AServerExecutionConfig): A2AServerLimitsConfig {
  const source = value === undefined ? {} : record(value, 'A2A server limits');
  noUnknown(source, LIMIT_KEYS, 'A2A server limits');
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [
    key,
    source[key] === undefined ? LIMIT_DEFAULTS[key] : positiveInteger(source[key], `A2A server limits.${key}`),
  ])) as unknown as A2AServerLimitsConfig;
  if (limits.maxPartBytes > limits.maxRequestBytes) {
    throw new Error('A2A server limits.maxPartBytes must not exceed maxRequestBytes.');
  }
  const fixedWrite = execution.workspace.mode === 'fixed' && execution.toolPolicy.workspace === 'write';
  if (fixedWrite && source.maxConcurrentTasks === undefined) {
    return { ...limits, maxConcurrentTasks: 1 };
  }
  if (fixedWrite && limits.maxConcurrentTasks !== 1) {
    throw new Error('A2A fixed writable workspace requires maxConcurrentTasks 1.');
  }
  return limits;
}

function parseServer(value: unknown): A2AServerConfig {
  const source = record(value, 'A2A server');
  noUnknown(source, ['execution', 'published', 'publicBaseUrl', 'authentication', 'limits', 'dataDir'], 'A2A server');
  const execution = parseExecution(source.execution);
  const publicBaseUrl = source.publicBaseUrl === undefined
    ? undefined
    : parseHttpUrl(source.publicBaseUrl, 'A2A server.publicBaseUrl', true);
  return {
    execution,
    published: parsePublished(source.published),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    authentication: parseAuthentication(source.authentication),
    limits: parseLimits(source.limits, execution),
    dataDir: text(source.dataDir, 'A2A server.dataDir'),
  };
}

export function parseA2AIntegrationDocument(value: unknown): A2AIntegrationDocument {
  const source = record(value, 'A2A integration config');
  noUnknown(source, ['version', 'agents', 'server'], 'A2A integration config');
  if (source.version !== 1) throw new Error('A2A integration config version must be 1.');
  const rawAgents = record(source.agents, 'A2A integration config agents');
  const agents: Record<string, A2AOutboundAgentConfig> = {};
  for (const [name, agent] of Object.entries(rawAgents)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`A2A outbound Agent name "${name}" is invalid.`);
    agents[name] = parseOutboundAgent(agent, `A2A outbound Agent "${name}"`);
  }
  return {
    version: 1,
    agents,
    ...(source.server === undefined ? {} : { server: parseServer(source.server) }),
  };
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function readA2AIntegration(
  configHome: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  const file = resolveIntegrationConfigPath('a2a', configHome);
  const present = existsSync(file);
  const raw = present ? readFileSync(file, 'utf8') : JSON.stringify({ version: 1, agents: {} });
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error('Invalid A2A integration JSON.', { cause: error });
  }
  return {
    domain: 'a2a',
    source: present ? 'user' : 'default',
    path: file,
    revision: hash(raw),
    document: parseA2AIntegrationDocument(value),
    loadedAt: new Date().toISOString(),
  };
}

function writeA2AIntegration(
  configHome: string,
  document: A2AIntegrationDocument,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  return writeIntegrationDocument({
    domain: 'a2a',
    configHome,
    document,
    validate: parseA2AIntegrationDocument,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
}

export function upsertA2AOutboundAgent(
  configHome: string,
  name: string,
  agent: A2AOutboundAgentConfig,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  if (!NAME_PATTERN.test(name)) throw new Error('A2A outbound Agent name is invalid.');
  const current = readA2AIntegration(configHome);
  return writeA2AIntegration(configHome, {
    ...current.document,
    agents: { ...current.document.agents, [name]: agent },
  }, expectedRevision ?? (current.source === 'user' ? current.revision : undefined));
}

export function removeA2AOutboundAgent(
  configHome: string,
  name: string,
  expectedRevision?: string,
): boolean {
  const current = readA2AIntegration(configHome);
  if (current.document.agents[name] === undefined) return false;
  const agents = { ...current.document.agents };
  delete agents[name];
  writeA2AIntegration(
    configHome,
    { ...current.document, agents },
    expectedRevision ?? (current.source === 'user' ? current.revision : undefined),
  );
  return true;
}

export function setA2AServerConfig(
  configHome: string,
  server: A2AServerConfig | undefined,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  const current = readA2AIntegration(configHome);
  const document: A2AIntegrationDocument = server === undefined
    ? { version: 1, agents: current.document.agents }
    : { ...current.document, server };
  return writeA2AIntegration(
    configHome,
    document,
    expectedRevision ?? (current.source === 'user' ? current.revision : undefined),
  );
}

export function classifyA2AServerChange(
  current: A2AServerConfig | undefined,
  next: A2AServerConfig | undefined,
): A2AServerConfigChange {
  if (isDeepStrictEqual(current, next)) return { kind: 'none', fields: [] };
  if (current === undefined || next === undefined) {
    return { kind: 'restart-required', fields: ['server'] };
  }
  const restartFields = ['execution', 'dataDir'].filter((field) => (
    !isDeepStrictEqual(current[field as 'execution' | 'dataDir'], next[field as 'execution' | 'dataDir'])
  ));
  const hotFields = ['published', 'publicBaseUrl', 'authentication', 'limits'].filter((field) => (
    !isDeepStrictEqual(
      current[field as 'published' | 'publicBaseUrl' | 'authentication' | 'limits'],
      next[field as 'published' | 'publicBaseUrl' | 'authentication' | 'limits'],
    )
  ));
  return restartFields.length > 0
    ? { kind: 'restart-required', fields: [...restartFields, ...hotFields] }
    : { kind: 'hot', fields: hotFields };
}
