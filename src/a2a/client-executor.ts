import { createHash, randomUUID } from 'node:crypto';

import {
  emitKodaXDiagnostic,
  type AgentArtifactReference,
  type AgentContinuationInput,
  type AgentExecutor,
  type AgentExecutorEvent,
  type AgentExecutorFactory,
  type AgentExecutorFactoryContext,
  type AgentExecutorTaskReference,
  type AgentExecutorTaskSnapshot,
  type AgentJsonValue,
  type AgentTaskStartInput,
  type ExternalAgentRegistration,
} from '@kodax-ai/agent';

import { A2AError } from './errors.js';
import {
  createOAuth2ClientCredentialsTokenManager,
  type OAuth2ClientCredentialsTokenManager,
} from './client-auth.js';
import { decodeUtf8, openSafeA2AResponse, safeA2AFetch } from './safe-fetch.js';
import {
  isEventStreamMediaType,
  isJsonMediaType,
  isRecord,
  parseA2AAgentCard,
  parseA2AMessage,
  parseA2ATask,
} from './schemas.js';
import {
  parseA2ASecurity,
  parseOAuthEndpointUrl,
  parseOAuthIssuerIdentifier,
  parseOAuthResourceIdentifier,
  parseOAuthScopeList,
  requireNonEmptyString,
  satisfiableA2ASecurityRequirements,
  type A2AClientSecurityCapability,
  type A2AOAuth2ClientCredentialsSecurityScheme,
  type A2ASecurityScheme,
} from './security.js';
import {
  A2A_EXECUTOR_ID,
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AArtifact,
  type A2AClientAuthenticationInput,
  type A2AClientOptions,
  type A2ADiscoveredRegistration,
  type A2AMessage,
  type A2ANetworkPolicy,
  type A2APart,
  type A2ARegistrationInput,
  type A2ATask,
} from './types.js';

interface A2AExecutorConfig {
  readonly agentCardUrl: string;
  readonly interfaceUrl: string;
  readonly tenant?: string;
  readonly authentication?: A2AExecutorAuthentication;
}

type A2AExecutorAuthentication =
  | { readonly type: 'http-bearer'; readonly scheme: string }
  | {
      readonly type: 'oauth2-client-credentials';
      readonly scheme: string;
      readonly issuer: string;
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly resource?: string;
      readonly clientAuthentication: 'client-secret-basic' | 'client-secret-post';
    };

const MAX_RECENT_AUTHORIZATIONS = 4;
const AUTHORIZATION_TOKEN_CHARACTER = /^[A-Za-z0-9\-._~+/=]$/u;

function isBearerAuthorization(value: string | undefined): value is string {
  return value !== undefined && /^Bearer\s+\S+$/iu.test(value);
}

function replaceBoundedToken(value: string, token: string): string {
  let result = '';
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) return result + value.slice(offset);
    const before = index === 0 ? undefined : value[index - 1];
    const afterIndex = index + token.length;
    const after = afterIndex === value.length ? undefined : value[afterIndex];
    const boundedBefore = before === undefined || !AUTHORIZATION_TOKEN_CHARACTER.test(before);
    const boundedAfter = after === undefined || !AUTHORIZATION_TOKEN_CHARACTER.test(after);
    result += value.slice(offset, index);
    if (boundedBefore && boundedAfter) {
      result += '[REDACTED]';
      offset = afterIndex;
    } else {
      result += token;
      offset = afterIndex;
    }
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

class AuthorizationRedactor {
  readonly #recent: string[] = [];
  readonly #active = new Map<string, number>();

  remember(authorization: string | undefined): void {
    if (!authorization) return;
    const existing = this.#recent.indexOf(authorization);
    if (existing >= 0) this.#recent.splice(existing, 1);
    this.#recent.unshift(authorization);
    if (this.#recent.length > MAX_RECENT_AUTHORIZATIONS) this.#recent.length = MAX_RECENT_AUTHORIZATIONS;
  }

  retain(authorization: string | undefined): () => void {
    if (!authorization) return () => {};
    this.remember(authorization);
    this.#active.set(authorization, (this.#active.get(authorization) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#active.get(authorization) ?? 1) - 1;
      if (remaining === 0) this.#active.delete(authorization);
      else this.#active.set(authorization, remaining);
    };
  }

  redactText(value: string): string {
    const authorizations = [...new Set([...this.#active.keys(), ...this.#recent])];
    const withHeadersRedacted = authorizations
      .sort((left, right) => right.length - left.length)
      .reduce(
        (current, authorization) => current.split(authorization).join('[REDACTED]'),
        value,
      );
    const bearerTokens = authorizations.flatMap((authorization) => {
      const bearer = /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1];
      return bearer ? [bearer] : [];
    }).sort((left, right) => right.length - left.length);
    return [...new Set(bearerTokens)].reduce(
      (current, token) => replaceBoundedToken(current, token),
      withHeadersRedacted,
    );
  }

  redactContent(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactContent(item));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, this.redactContent(item)]
    )));
  }

  redactPart(part: A2APart): A2APart {
    return {
      ...part,
      ...(part.text === undefined ? {} : { text: this.redactText(part.text) }),
      ...(part.raw === undefined ? {} : { raw: this.redactText(part.raw) }),
      ...(part.url === undefined ? {} : { url: this.redactText(part.url) }),
      ...(part.data === undefined ? {} : { data: this.redactContent(part.data) }),
      ...(part.metadata === undefined ? {} : {
        metadata: this.redactContent(part.metadata) as Readonly<Record<string, unknown>>,
      }),
      ...(part.filename === undefined ? {} : { filename: this.redactText(part.filename) }),
    };
  }

  redactMessage(message: A2AMessage): A2AMessage {
    return {
      ...message,
      parts: message.parts.map((part) => this.redactPart(part)),
      ...(message.metadata === undefined ? {} : {
        metadata: this.redactContent(message.metadata) as Readonly<Record<string, unknown>>,
      }),
    };
  }

  redactArtifact(artifact: A2AArtifact): A2AArtifact {
    return {
      ...artifact,
      ...(artifact.name === undefined ? {} : { name: this.redactText(artifact.name) }),
      ...(artifact.description === undefined ? {} : { description: this.redactText(artifact.description) }),
      parts: artifact.parts.map((part) => this.redactPart(part)),
      ...(artifact.metadata === undefined ? {} : {
        metadata: this.redactContent(artifact.metadata) as Readonly<Record<string, unknown>>,
      }),
    };
  }

  redactTask(task: A2ATask): A2ATask {
    return {
      ...task,
      status: {
        ...task.status,
        ...(task.status.message === undefined ? {} : { message: this.redactMessage(task.status.message) }),
      },
      ...(task.artifacts === undefined ? {} : {
        artifacts: task.artifacts.map((artifact) => this.redactArtifact(artifact)),
      }),
      ...(task.history === undefined ? {} : {
        history: task.history.map((message) => this.redactMessage(message)),
      }),
      ...(task.metadata === undefined ? {} : {
        metadata: this.redactContent(task.metadata) as Readonly<Record<string, unknown>>,
      }),
    };
  }

  redactError(error: unknown): Error {
    const message = this.redactText(error instanceof Error ? error.message : String(error));
    return error instanceof A2AError
      ? new A2AError(error.code, message, error.httpStatus, this.redactContent(error.data), error.headers)
      : new Error(message);
  }
}

function endpointNetworkPolicy(
  policy: A2AClientOptions['networkPolicy'],
  endpoint: string,
): A2AClientOptions['networkPolicy'] {
  const origin = new URL(endpoint).origin;
  const allowed = policy.allowedOrigins.some((candidate) => new URL(candidate).origin === origin);
  if (!allowed) throw new Error(`A2A endpoint origin is not allowed by network policy: ${origin}`);
  return { ...policy, allowedOrigins: [origin] };
}

function executorAuthentication(value: unknown): A2AExecutorAuthentication | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.scheme !== 'string') {
    throw new Error('A2A registration authentication is invalid.');
  }
  if (value.type === 'http-bearer') {
    return { type: 'http-bearer', scheme: value.scheme };
  }
  if (value.type !== 'oauth2-client-credentials'
    || typeof value.issuer !== 'string'
    || typeof value.tokenUrl !== 'string'
    || typeof value.clientId !== 'string'
    || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => typeof scope === 'string')
    || !['client-secret-basic', 'client-secret-post'].includes(String(value.clientAuthentication))) {
    throw new Error('A2A registration OAuth2 authentication is invalid.');
  }
  return {
    type: 'oauth2-client-credentials',
    scheme: value.scheme,
    issuer: value.issuer,
    tokenUrl: value.tokenUrl,
    clientId: value.clientId,
    scopes: value.scopes,
    ...(typeof value.resource === 'string' ? { resource: value.resource } : {}),
    clientAuthentication: value.clientAuthentication as 'client-secret-basic' | 'client-secret-post',
  };
}

function executorConfig(registration: ExternalAgentRegistration): A2AExecutorConfig {
  const config = registration.executorConfig;
  if (!isRecord(config)) throw new Error('A2A registration executorConfig is missing.');
  if (typeof config.agentCardUrl !== 'string' || typeof config.interfaceUrl !== 'string') {
    throw new Error('A2A registration endpoints are invalid.');
  }
  const authentication = executorAuthentication(config.authentication);
  return {
    agentCardUrl: config.agentCardUrl,
    interfaceUrl: config.interfaceUrl,
    ...(typeof config.tenant === 'string' ? { tenant: config.tenant } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

function chooseInterface(
  card: A2AAgentCard,
  cardUrl: URL,
): A2AAgentCard['supportedInterfaces'][number] {
  const selected = card.supportedInterfaces.find((entry) => (
    entry.protocolBinding.toUpperCase() === 'JSONRPC'
    && entry.protocolVersion === A2A_PROTOCOL_VERSION
  ));
  if (!selected) throw new Error('Agent Card has no supported A2A 1.0 JSONRPC interface.');
  const interfaceUrl = new URL(selected.url);
  if (interfaceUrl.username || interfaceUrl.password || interfaceUrl.hash) {
    throw new Error('A2A interface URL must not contain credentials or a fragment.');
  }
  if (interfaceUrl.origin !== cardUrl.origin) {
    throw new Error('A2A interface must use the same origin as the trusted Agent Card.');
  }
  return selected;
}

interface A2APlannedClientAuthentication {
  readonly credentialRef?: string;
  readonly authentication?: A2AExecutorAuthentication;
  readonly skillIds: readonly string[];
}

function validatedClientAuthentication(value: unknown): A2AClientAuthenticationInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('A2A authentication must be an object.');
  const scheme = requireNonEmptyString(value.scheme, 'A2A authentication.scheme');
  if (value.type === 'http-bearer') {
    return {
      type: 'http-bearer',
      scheme,
      credentialRef: requireNonEmptyString(
        value.credentialRef,
        'A2A authentication.credentialRef',
      ),
    };
  }
  if (value.type !== 'oauth2-client-credentials') {
    throw new Error('A2A authentication.type must be http-bearer or oauth2-client-credentials.');
  }
  if (value.clientAuthentication !== 'client-secret-basic'
    && value.clientAuthentication !== 'client-secret-post') {
    throw new Error('A2A authentication.clientAuthentication is invalid.');
  }
  return {
    type: 'oauth2-client-credentials',
    scheme,
    issuer: parseOAuthIssuerIdentifier(value.issuer, 'Configured OAuth2 issuer'),
    tokenUrl: parseOAuthEndpointUrl(value.tokenUrl, 'Configured OAuth2 token endpoint').href,
    clientId: requireNonEmptyString(value.clientId, 'Configured OAuth2 clientId'),
    clientSecretRef: requireNonEmptyString(
      value.clientSecretRef,
      'Configured OAuth2 clientSecretRef',
    ),
    scopes: parseOAuthScopeList(value.scopes, 'Configured OAuth2 scopes'),
    ...(value.resource === undefined
      ? {}
      : { resource: parseOAuthResourceIdentifier(value.resource, 'Configured OAuth2 resource') }),
    clientAuthentication: value.clientAuthentication,
  };
}

function validatedRegistrationInput(input: A2ARegistrationInput): A2ARegistrationInput {
  const credentialRef = input.credentialRef === undefined
    ? undefined
    : requireNonEmptyString(input.credentialRef, 'A2A credentialRef');
  const authentication = validatedClientAuthentication(input.authentication);
  if (input.credentialRef !== undefined && input.authentication !== undefined) {
    throw new Error('A2A registration cannot combine credentialRef with structured authentication.');
  }
  return {
    agentId: input.agentId,
    agentCardUrl: input.agentCardUrl,
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    ...(authentication !== undefined ? { authentication } : {}),
    effects: input.effects,
  };
}

function configuredCapabilityCandidates(
  input: A2ARegistrationInput,
  card: A2AAgentCard,
  staticAuthorization?: string,
): readonly (readonly A2AClientSecurityCapability[])[] {
  if (input.authentication) {
    return [[{
      schemeName: input.authentication.scheme,
      kind: input.authentication.type,
      ...(input.authentication.type === 'oauth2-client-credentials'
        ? { scopes: input.authentication.scopes } : {}),
    }]];
  }
  const staticBearer = isBearerAuthorization(staticAuthorization);
  if (!input.credentialRef && !staticBearer) return [[]];
  const security = parseA2ASecurity(card.securitySchemes, card.securityRequirements);
  return Object.values(security.schemes).flatMap((scheme) => (
    scheme.kind === 'http-bearer'
      ? [[{ schemeName: scheme.name, kind: 'http-bearer' as const }]]
      : []
  ));
}

interface A2ASecurityCapabilityEvaluation {
  readonly skillIds: readonly string[];
  readonly declaredScheme?: A2ASecurityScheme;
}

function matchingDeclaredScheme(
  requirements: ReturnType<typeof satisfiableA2ASecurityRequirements>,
  capabilities: readonly A2AClientSecurityCapability[],
): A2ASecurityScheme | undefined {
  for (const requirement of requirements) {
    if (requirement.schemes.length !== 1) continue;
    const scheme = requirement.schemes[0]!.scheme;
    if (capabilities.some((capability) => (
      capability.schemeName === scheme.name && capability.kind === scheme.kind
    ))) return scheme;
  }
  return undefined;
}

function evaluateSecurityCapabilities(
  card: A2AAgentCard,
  capabilities: readonly A2AClientSecurityCapability[],
): A2ASecurityCapabilityEvaluation | null {
  const top = parseA2ASecurity(card.securitySchemes, card.securityRequirements);
  const topRequirements = satisfiableA2ASecurityRequirements(top, capabilities)
    .filter((requirement) => requirement.schemes.length <= 1);
  if (topRequirements.length === 0) return null;

  let declaredScheme = matchingDeclaredScheme(topRequirements, capabilities);
  const skillIds: string[] = [];
  for (const skill of card.skills) {
    const security = parseA2ASecurity(card.securitySchemes, skill.securityRequirements);
    const requirements = satisfiableA2ASecurityRequirements(security, capabilities)
      .filter((requirement) => requirement.schemes.length <= 1);
    if (requirements.length === 0) continue;
    skillIds.push(skill.id);
    declaredScheme ??= matchingDeclaredScheme(requirements, capabilities);
  }
  if (card.skills.length > 0 && skillIds.length === 0) return null;
  return { skillIds, ...(declaredScheme ? { declaredScheme } : {}) };
}

function planClientAuthentication(
  input: A2ARegistrationInput,
  card: A2AAgentCard,
  staticAuthorization?: string,
): A2APlannedClientAuthentication {
  if (input.credentialRef !== undefined && input.authentication !== undefined) {
    throw new Error('A2A registration cannot combine credentialRef with structured authentication.');
  }
  if (staticAuthorization !== undefined && !isBearerAuthorization(staticAuthorization)) {
    throw new Error('A2A options.authorization must be a valid Bearer authorization.');
  }
  const hasStaticBearer = isBearerAuthorization(staticAuthorization);
  const hasConfiguredAuthentication = input.credentialRef !== undefined
    || input.authentication !== undefined
    || hasStaticBearer;
  let evaluation: A2ASecurityCapabilityEvaluation | undefined;
  for (const capabilities of configuredCapabilityCandidates(input, card, staticAuthorization)) {
    const candidate = evaluateSecurityCapabilities(card, capabilities);
    if (candidate && (!hasConfiguredAuthentication || candidate.declaredScheme)) {
      evaluation = candidate;
      break;
    }
  }
  if (!evaluation) {
    throw new Error(hasConfiguredAuthentication
      ? 'Configured A2A authentication cannot fully satisfy the Agent Card and any advertised Skill security requirements.'
      : 'Agent Card or at least one advertised Skill requires authentication, but no compatible A2A authentication is configured.');
  }
  if (!hasConfiguredAuthentication) return { skillIds: evaluation.skillIds };
  const selectedScheme = evaluation.declaredScheme!;
  const configured = input.authentication;
  if (!configured && !input.credentialRef && hasStaticBearer) {
    return { skillIds: evaluation.skillIds };
  }
  if (!configured) {
    return {
      credentialRef: input.credentialRef,
      authentication: { type: 'http-bearer', scheme: selectedScheme.name },
      skillIds: evaluation.skillIds,
    };
  }
  if (configured.type === 'http-bearer') {
    return {
      credentialRef: configured.credentialRef,
      authentication: { type: 'http-bearer', scheme: configured.scheme },
      skillIds: evaluation.skillIds,
    };
  }
  if (selectedScheme.kind !== 'oauth2-client-credentials') {
    throw new Error('Configured OAuth2 authentication does not match the selected Agent Card scheme.');
  }
  const oauthScheme = selectedScheme as A2AOAuth2ClientCredentialsSecurityScheme;
  const issuer = parseOAuthIssuerIdentifier(configured.issuer, 'Configured OAuth2 issuer');
  const tokenUrl = parseOAuthEndpointUrl(configured.tokenUrl, 'Configured OAuth2 token endpoint').href;
  const resource = configured.resource === undefined
    ? undefined
    : parseOAuthResourceIdentifier(configured.resource, 'Configured OAuth2 resource');
  if (new URL(oauthScheme.tokenUrl).href !== tokenUrl) {
    throw new Error('Configured OAuth2 tokenUrl does not match the selected Agent Card security scheme.');
  }
  const undeclaredScope = configured.scopes.find((scope) => !oauthScheme.scopes.includes(scope));
  if (undeclaredScope) {
    throw new Error(`Configured OAuth2 scope is not declared by the Agent Card: ${undeclaredScope}`);
  }
  return {
    credentialRef: configured.clientSecretRef,
    authentication: {
      type: 'oauth2-client-credentials',
      scheme: configured.scheme,
      issuer,
      tokenUrl,
      clientId: configured.clientId,
      scopes: configured.scopes,
      ...(resource ? { resource } : {}),
      clientAuthentication: configured.clientAuthentication,
    },
    skillIds: evaluation.skillIds,
  };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function taskResponseBytes(options: A2AClientOptions): number {
  const value = options.maxTaskResponseBytes ?? options.networkPolicy.maxResponseBytes;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('A2A maxTaskResponseBytes must be a positive safe integer.');
  }
  return value;
}

function taskNetworkPolicy(options: A2AClientOptions): A2ANetworkPolicy {
  return { ...options.networkPolicy, maxResponseBytes: taskResponseBytes(options) };
}

export async function discoverA2ARegistration(
  input: A2ARegistrationInput,
  options: A2AClientOptions,
): Promise<A2ADiscoveredRegistration> {
  const validatedInput = validatedRegistrationInput(input);
  const result = await safeA2AFetch(
    new URL(validatedInput.agentCardUrl),
    { headers: { accept: 'application/json' } },
    options.networkPolicy,
    options.fetch,
  );
  if (!result.response.ok) throw new Error(`Agent Card request failed with HTTP ${result.response.status}.`);
  if (!isJsonMediaType(result.response.headers.get('content-type'))) {
    throw new Error('Agent Card response is not JSON.');
  }
  const card = parseA2AAgentCard(parseJson(decodeUtf8(result.body), 'Agent Card'));
  const requiredExtensions = card.capabilities.extensions?.filter((extension) => extension.required) ?? [];
  if (requiredExtensions.length > 0) {
    throw new Error(
      `Agent Card required A2A extension(s) are unsupported: ${requiredExtensions.map((extension) => extension.uri).join(', ')}`,
    );
  }
  const selected = chooseInterface(card, result.url);
  const plannedAuthentication = planClientAuthentication(validatedInput, card, options.authorization);
  const identity = stableJson({
    agentCardUrl: result.url.href,
    interfaceUrl: selected.url,
    protocolBinding: selected.protocolBinding,
    protocolVersion: selected.protocolVersion,
    tenant: selected.tenant ?? '',
    authentication: plannedAuthentication.authentication ?? null,
  });
  const revision = sha256(stableJson({
    card,
    endpointIdentity: identity,
    credentialRef: plannedAuthentication.credentialRef ?? null,
    effects: validatedInput.effects,
  }));
  return {
    agentCard: card,
    registration: {
      agentId: validatedInput.agentId,
      displayName: card.name,
      description: card.description,
      enabled: true,
      executorId: A2A_EXECUTOR_ID,
      protocol: 'a2a',
      configurationRevision: revision,
      endpointIdentityHash: sha256(identity),
      ...(plannedAuthentication.credentialRef
        ? { credentialRef: plannedAuthentication.credentialRef } : {}),
      executorConfig: {
        agentCardUrl: result.url.href,
        interfaceUrl: selected.url,
        ...(selected.tenant ? { tenant: selected.tenant } : {}),
        ...(plannedAuthentication.authentication
          ? { authentication: plannedAuthentication.authentication } : {}),
      },
      skills: plannedAuthentication.skillIds,
      inputModalities: card.defaultInputModes,
      outputModalities: card.defaultOutputModes,
      capabilities: {
        streaming: card.capabilities.streaming ? 'supported' : 'unsupported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: validatedInput.effects.remote, workspace: 'proposal' },
      health: { status: 'healthy', checkedAt: new Date().toISOString() },
    },
  };
}

function metadata(reference: AgentExecutorTaskReference): Readonly<Record<string, unknown>> {
  return reference.metadata ?? {};
}

function toAgentJsonValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toAgentJsonValue);
  if (isRecord(value)) {
    const normalized: Record<string, AgentJsonValue> = {};
    for (const [key, item] of Object.entries(value)) normalized[key] = toAgentJsonValue(item);
    return normalized;
  }
  throw new Error('A2A response metadata must be JSON-safe.');
}

function directMessage(reference: AgentExecutorTaskReference): A2AMessage | undefined {
  const value = metadata(reference).directMessage;
  return value === undefined ? undefined : parseA2AMessage(value);
}

function taskState(state: string): AgentExecutorTaskSnapshot['state'] {
  const mapping: Readonly<Record<string, AgentExecutorTaskSnapshot['state']>> = {
    TASK_STATE_UNSPECIFIED: 'unknown',
    TASK_STATE_SUBMITTED: 'submitted',
    TASK_STATE_WORKING: 'working',
    TASK_STATE_COMPLETED: 'completed',
    TASK_STATE_FAILED: 'failed',
    TASK_STATE_CANCELED: 'canceled',
    TASK_STATE_INPUT_REQUIRED: 'input-required',
    TASK_STATE_REJECTED: 'rejected',
    TASK_STATE_AUTH_REQUIRED: 'auth-required',
  };
  return mapping[state] ?? 'unknown';
}

function textFromParts(parts: readonly { readonly text?: string }[]): string {
  return parts.flatMap((part) => part.text === undefined ? [] : [part.text]).join('\n');
}

function partArtifactReference(part: A2APart, name: string): AgentArtifactReference | undefined {
  const mimeType = part.mediaType ?? (part.data !== undefined ? 'application/json' : 'application/octet-stream');
  const inline = part.raw !== undefined
    ? `data:${mimeType};base64,${part.raw}`
    : part.data !== undefined
      ? `data:${mimeType};base64,${Buffer.from(JSON.stringify(part.data), 'utf8').toString('base64')}`
      : undefined;
  const uri = part.url ?? inline;
  if (!uri) return undefined;
  return {
    name,
    ...(part.mediaType ? { mimeType: part.mediaType } : {}),
    ...(part.raw !== undefined ? { size: Buffer.from(part.raw, 'base64').byteLength } : {}),
    uri,
    provenance: 'a2a',
  };
}

function artifactReference(artifact: A2AArtifact): AgentArtifactReference | undefined {
  const part = artifact.parts.find((candidate) => (
    candidate.url !== undefined || candidate.raw !== undefined || candidate.data !== undefined
  ));
  return part ? partArtifactReference(part, artifact.name ?? artifact.artifactId) : undefined;
}

function snapshotFromTask(task: A2ATask): AgentExecutorTaskSnapshot {
  const artifactText = (task.artifacts ?? []).flatMap((artifact) => textFromParts(artifact.parts));
  const statusText = task.status.message ? textFromParts(task.status.message.parts) : '';
  const output = [...artifactText, statusText].filter(Boolean).join('\n');
  return {
    state: taskState(task.status.state),
    ...(output ? { output } : {}),
    ...(task.status.state === 'TASK_STATE_FAILED' ? { error: statusText || 'Remote A2A task failed.' } : {}),
    ...(task.artifacts?.length
      ? { artifacts: task.artifacts.flatMap((artifact) => artifactReference(artifact) ?? []) }
      : {}),
  };
}

function snapshotFromMessage(message: A2AMessage): AgentExecutorTaskSnapshot {
  const output = textFromParts(message.parts);
  const artifacts = message.parts.flatMap((part, index) => {
    if (part.text !== undefined) return [];
    const reference = partArtifactReference(part, part.filename ?? `message-part-${index + 1}`);
    return reference ? [reference] : [];
  });
  return {
    state: 'completed',
    ...(output ? { output } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function isTerminal(state: AgentExecutorTaskSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

function mergeStreamArtifact(
  artifacts: Map<string, A2AArtifact>,
  artifact: A2AArtifact,
  append: boolean,
): void {
  const current = artifacts.get(artifact.artifactId);
  artifacts.set(artifact.artifactId, append && current
    ? { ...current, ...artifact, parts: [...current.parts, ...artifact.parts] }
    : artifact);
}

class A2AClientExecutor implements AgentExecutor {
  #disposed = false;
  readonly #streamControllers = new Set<AbortController>();
  readonly #authorizationRedactor = new AuthorizationRedactor();

  constructor(
    private readonly registration: ExternalAgentRegistration,
    private readonly context: AgentExecutorFactoryContext,
    private readonly options: A2AClientOptions,
    private readonly oauthTokenManager?: OAuth2ClientCredentialsTokenManager,
    private readonly releaseOAuthTokenManager?: () => void,
  ) {}

  async preflight(): Promise<{ readonly ok: boolean; readonly reasons?: readonly string[] }> {
    try {
      executorConfig(this.registration);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
    }
  }

  async start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference> {
    const idempotencyKey = input.idempotencyKey;
    if (!idempotencyKey) throw new Error('A2A executor requires an idempotency key.');
    const result = await this.sendMessage({
      message: {
        messageId: idempotencyKey,
        role: 'ROLE_USER',
        parts: [{ text: input.input ?? input.objective, mediaType: 'text/plain' }],
      },
      configuration: { returnImmediately: true },
    });
    if (isRecord(result.task)) {
      const task = parseA2ATask(result.task);
      return {
        idempotencyKey,
        remoteTaskId: task.id,
        ...(task.contextId ? { metadata: { contextId: task.contextId } } : {}),
      };
    }
    if (result.message !== undefined) {
      const message = this.#authorizationRedactor.redactMessage(parseA2AMessage(result.message));
      return { idempotencyKey, metadata: { directMessage: toAgentJsonValue(message) } };
    }
    throw new Error('A2A SendMessage returned neither task nor message.');
  }

  async *events(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    const direct = directMessage(reference);
    if (direct) {
      yield await this.authorizeArtifacts(snapshotFromMessage(this.#authorizationRedactor.redactMessage(direct)));
      return;
    }
    if (this.registration.capabilities.streaming === 'supported') {
      try {
        yield* this.streamEvents(reference);
        return;
      } catch (error: unknown) {
        if (this.#disposed) return;
        emitKodaXDiagnostic({
          source: 'a2a.client',
          level: 'warn',
          message: 'A2A event stream failed; polling fallback started.',
          detail: error,
        });
        yield { progress: { message: 'A2A stream unavailable; polling.' } };
      }
    }
    while (!this.#disposed) {
      const snapshot = await this.get(reference);
      yield snapshot;
      if (isTerminal(snapshot.state) || snapshot.state === 'input-required' || snapshot.state === 'auth-required') return;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
  }

  async get(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    const direct = directMessage(reference);
    if (direct) {
      return this.authorizeArtifacts(snapshotFromMessage(this.#authorizationRedactor.redactMessage(direct)));
    }
    if (!reference.remoteTaskId) throw new Error('A2A task reference has no remote task ID.');
    const task = parseA2ATask(await this.rpc('GetTask', this.taskParams(reference)));
    this.assertTaskReference(task, reference);
    return this.authorizeArtifacts(snapshotFromTask(this.#authorizationRedactor.redactTask(task)));
  }

  async sendInput(reference: AgentExecutorTaskReference, input: AgentContinuationInput): Promise<void> {
    if (!reference.remoteTaskId) throw new Error('Direct A2A responses cannot accept input.');
    await this.sendMessage({
      message: {
        messageId: randomUUID(),
        taskId: reference.remoteTaskId,
        ...(typeof metadata(reference).contextId === 'string'
          ? { contextId: metadata(reference).contextId as string } : {}),
        role: 'ROLE_USER',
        parts: [{ text: input.content, mediaType: 'text/plain' }],
      },
      configuration: { returnImmediately: true },
    });
  }

  async cancel(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    if (!reference.remoteTaskId) return this.get(reference);
    const task = parseA2ATask(await this.rpc('CancelTask', this.taskParams(reference)));
    this.assertTaskReference(task, reference);
    return this.authorizeArtifacts(snapshotFromTask(this.#authorizationRedactor.redactTask(task)));
  }

  async reconcile(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    return this.get(reference);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      for (const controller of this.#streamControllers) {
        controller.abort(new Error('A2A executor disposed.'));
      }
    } finally {
      this.releaseOAuthTokenManager?.();
    }
  }

  private async *streamEvents(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    if (!reference.remoteTaskId) throw new Error('A2A stream requires a remote task ID.');
    const config = executorConfig(this.registration);
    const url = new URL(config.interfaceUrl);
    const headers = new Headers({
      accept: 'text/event-stream',
      'a2a-version': A2A_PROTOCOL_VERSION,
      'content-type': 'application/json',
    });
    const controller = new AbortController();
    const requestId = randomUUID();
    this.#streamControllers.add(controller);
    let releaseAuthorization: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const disarmTimeout = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    };
    const armTimeout = (message: string): void => {
      disarmTimeout();
      timeout = setTimeout(() => controller.abort(new Error(message)), this.options.networkPolicy.requestTimeoutMs);
      timeout.unref?.();
    };
    try {
      armTimeout('A2A stream connection timed out.');
      const opened = await this.openStreamResponse(url, headers, controller.signal, {
        jsonrpc: '2.0',
        id: requestId,
        method: 'SubscribeToTask',
        params: this.taskParams(reference),
      });
      const response = opened.response;
      releaseAuthorization = opened.releaseAuthorization;
      disarmTimeout();
      if (!response.ok || !response.body) throw new Error(`A2A stream failed with HTTP ${response.status}.`);
      if (!isEventStreamMediaType(response.headers.get('content-type'))) {
        throw new Error('A2A stream returned an invalid content type.');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const artifacts = new Map<string, A2AArtifact>();
      let buffered = '';
      let receivedBytes = 0;
      while (!this.#disposed) {
        armTimeout('A2A stream was idle for too long.');
        const chunk = await reader.read();
        disarmTimeout();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > taskResponseBytes(this.options)) {
          throw new Error('A2A stream exceeded the response size limit.');
        }
        buffered += decoder.decode(chunk.value, { stream: true });
        const frames = buffered.split(/\r?\n\r?\n/);
        buffered = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const event = await this.snapshotFromStreamPayload(
            parseJson(data, 'A2A stream'),
            requestId,
            reference,
            artifacts,
          );
          if (!event) continue;
          yield event;
          if (event.state && (isTerminal(event.state) || event.state === 'input-required' || event.state === 'auth-required')) return;
        }
      }
      if (!this.#disposed) throw new Error('A2A event stream ended before the task reached a stable state.');
    } catch (error: unknown) {
      throw this.#authorizationRedactor.redactError(error);
    } finally {
      disarmTimeout();
      releaseAuthorization?.();
      this.#streamControllers.delete(controller);
    }
  }

  private async snapshotFromStreamPayload(
    payload: unknown,
    requestId: string,
    reference: AgentExecutorTaskReference,
    artifacts: Map<string, A2AArtifact>,
  ): Promise<AgentExecutorTaskSnapshot | undefined> {
    if (!isRecord(payload)) throw new Error('A2A stream frame is invalid.');
    if (payload.jsonrpc !== '2.0' || payload.id !== requestId) {
      throw new Error('A2A stream frame has an invalid JSON-RPC version or response id.');
    }
    if (payload.error !== undefined) {
      const error = isRecord(payload.error) ? payload.error : {};
      const message = typeof error.message === 'string' ? error.message : 'A2A stream error.';
      throw new A2AError(
        typeof error.code === 'number' ? error.code : -32603,
        this.#authorizationRedactor.redactText(message),
      );
    }
    if (!isRecord(payload.result)) return undefined;
    if (payload.result.task !== undefined) {
      const task = parseA2ATask(payload.result.task);
      this.assertTaskReference(task, reference);
      artifacts.clear();
      for (const artifact of task.artifacts ?? []) artifacts.set(artifact.artifactId, artifact);
      return this.authorizeArtifacts(snapshotFromTask(this.#authorizationRedactor.redactTask(task)));
    }
    if (payload.result.message !== undefined) {
      const message = parseA2AMessage(payload.result.message);
      if (message.taskId !== undefined && message.taskId !== reference.remoteTaskId) {
        throw new Error('A2A stream message belongs to a different task.');
      }
      return this.authorizeArtifacts(snapshotFromMessage(this.#authorizationRedactor.redactMessage(message)));
    }
    if (isRecord(payload.result.statusUpdate) && isRecord(payload.result.statusUpdate.status)) {
      this.assertStreamTaskScope(payload.result.statusUpdate, reference);
      const task = parseA2ATask({
        id: reference.remoteTaskId,
        contextId: payload.result.statusUpdate.contextId,
        status: payload.result.statusUpdate.status,
        ...(artifacts.size > 0 ? { artifacts: [...artifacts.values()] } : {}),
      });
      return this.authorizeArtifacts(snapshotFromTask(this.#authorizationRedactor.redactTask(task)));
    }
    if (isRecord(payload.result.artifactUpdate) && payload.result.artifactUpdate.artifact !== undefined) {
      this.assertStreamTaskScope(payload.result.artifactUpdate, reference);
      const task = parseA2ATask({
        id: reference.remoteTaskId,
        contextId: payload.result.artifactUpdate.contextId,
        status: { state: 'TASK_STATE_WORKING' },
        artifacts: [payload.result.artifactUpdate.artifact],
      });
      const artifact = task.artifacts?.[0];
      if (!artifact) throw new Error('A2A artifact update has no artifact.');
      mergeStreamArtifact(artifacts, artifact, payload.result.artifactUpdate.append === true);
      const merged = { ...task, artifacts: [...artifacts.values()] };
      return this.authorizeArtifacts(snapshotFromTask(this.#authorizationRedactor.redactTask(merged)));
    }
    return undefined;
  }

  private async authorizeArtifacts(snapshot: AgentExecutorTaskSnapshot): Promise<AgentExecutorTaskSnapshot> {
    for (const artifact of snapshot.artifacts ?? []) await this.context.authorizeArtifact(artifact);
    return snapshot;
  }

  private assertTaskReference(
    task: A2ATask,
    reference: AgentExecutorTaskReference,
  ): void {
    if (task.id !== reference.remoteTaskId) {
      throw new Error('A2A response belongs to a different task id.');
    }
    const expectedContext = metadata(reference).contextId;
    if (typeof expectedContext === 'string' && task.contextId && task.contextId !== expectedContext) {
      throw new Error('A2A response belongs to a different task context.');
    }
  }

  private assertStreamTaskScope(
    event: Readonly<Record<string, unknown>>,
    reference: AgentExecutorTaskReference,
  ): void {
    if (typeof event.taskId !== 'string' || event.taskId !== reference.remoteTaskId) {
      throw new Error('A2A stream event belongs to a different task.');
    }
    const expectedContext = metadata(reference).contextId;
    if (typeof event.contextId !== 'string'
      || (typeof expectedContext === 'string' && event.contextId !== expectedContext)) {
      throw new Error('A2A stream event belongs to a different task context.');
    }
  }

  private async openStreamResponse(
    url: URL,
    baseHeaders: Headers,
    signal: AbortSignal,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly response: Response; readonly releaseAuthorization: () => void }> {
    const open = (authorization?: string): Promise<Response> => {
      const headers = new Headers(baseHeaders);
      if (authorization) headers.set('authorization', authorization);
      return openSafeA2AResponse(url, {
        method: 'POST', headers, redirect: 'manual', signal, body: JSON.stringify(body),
      }, this.options.networkPolicy, this.options.fetch);
    };
    return this.withAuthorization(async (authorization) => {
      const releaseAuthorization = this.#authorizationRedactor.retain(authorization);
      try {
        const response = await open(authorization);
        if (response.status === 401) {
          await response.body?.cancel();
          throw new A2AError(-32600, 'A2A authentication was rejected.', 401);
        }
        return { response, releaseAuthorization };
      } catch (error: unknown) {
        releaseAuthorization();
        throw error;
      }
    });
  }

  private taskParams(reference: AgentExecutorTaskReference): Readonly<Record<string, unknown>> {
    const config = executorConfig(this.registration);
    return { id: reference.remoteTaskId, ...(config.tenant ? { tenant: config.tenant } : {}) };
  }

  private async sendMessage(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const result = await this.rpc('SendMessage', {
      ...params,
      ...(executorConfig(this.registration).tenant
        ? { tenant: executorConfig(this.registration).tenant } : {}),
    });
    if (!isRecord(result)) throw new Error('A2A SendMessage result is invalid.');
    return result;
  }

  private async rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#disposed) throw new Error('A2A executor is disposed.');
    return this.withAuthorization((authorization) => (
      this.rpcWithAuthorization(method, params, authorization)
    ));
  }

  private redactRpcResult(method: string, result: unknown): unknown {
    if (method === 'GetTask' || method === 'CancelTask') {
      return this.#authorizationRedactor.redactTask(parseA2ATask(result));
    }
    if (method !== 'SendMessage' || !isRecord(result)) return result;
    return {
      ...result,
      ...(result.task === undefined ? {} : {
        task: this.#authorizationRedactor.redactTask(parseA2ATask(result.task)),
      }),
      ...(result.message === undefined ? {} : {
        message: this.#authorizationRedactor.redactMessage(parseA2AMessage(result.message)),
      }),
    };
  }

  private async withAuthorization<T>(
    run: (authorization: string | undefined) => Promise<T>,
  ): Promise<T> {
    const authentication = executorConfig(this.registration).authentication;
    if (!authentication) {
      if (this.options.authorization !== undefined
        && !isBearerAuthorization(this.options.authorization)) {
        throw new Error('A2A options.authorization must be a valid Bearer authorization.');
      }
      const releaseAuthorization = this.#authorizationRedactor.retain(this.options.authorization);
      try {
        return await run(this.options.authorization);
      } catch (error: unknown) {
        throw this.#authorizationRedactor.redactError(error);
      } finally {
        releaseAuthorization();
      }
    }
    const credentialRef = this.registration.credentialRef;
    if (!credentialRef) throw new Error('Authenticated A2A registration has no credential reference.');
    type Attempt = { readonly ok: true; readonly value: T } | {
      readonly ok: false;
      readonly rejectedAuthorization: string;
    };
    const execute = (captureUnauthorized: boolean): Promise<Attempt> => (
      this.context.withCredential(credentialRef, async (credential) => {
        let authorization: string | undefined;
        let releaseAuthorization: (() => void) | undefined;
        try {
          authorization = authentication.type === 'http-bearer'
            ? `Bearer ${credential}`
            : await this.requireOAuthTokenManager().getAuthorization(credential);
          releaseAuthorization = this.#authorizationRedactor.retain(authorization);
          return { ok: true, value: await run(authorization) };
        } catch (error: unknown) {
          if (captureUnauthorized
            && authentication.type === 'oauth2-client-credentials'
            && error instanceof A2AError
            && error.httpStatus === 401
            && authorization !== undefined) {
            return { ok: false, rejectedAuthorization: authorization };
          }
          throw this.#authorizationRedactor.redactError(error);
        } finally {
          releaseAuthorization?.();
        }
      })
    );
    const first = await execute(authentication.type === 'oauth2-client-credentials');
    if (first.ok) return first.value;
    this.requireOAuthTokenManager().invalidate(first.rejectedAuthorization);
    const second = await execute(false);
    if (!second.ok) throw new Error('A2A OAuth2 retry did not produce a result.');
    return second.value;
  }

  private requireOAuthTokenManager(): OAuth2ClientCredentialsTokenManager {
    if (!this.oauthTokenManager) throw new Error('A2A OAuth2 token manager is unavailable.');
    return this.oauthTokenManager;
  }

  private async rpcWithAuthorization(
    method: string,
    params: Readonly<Record<string, unknown>>,
    authorization: string | undefined,
  ): Promise<unknown> {
    const config = executorConfig(this.registration);
    const headers = new Headers({
      accept: 'application/json',
      'a2a-version': A2A_PROTOCOL_VERSION,
      'content-type': 'application/json',
    });
    if (authorization) headers.set('authorization', authorization);
    const requestId = randomUUID();
    const result = await safeA2AFetch(new URL(config.interfaceUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    }, taskNetworkPolicy(this.options), this.options.fetch);
    if (result.response.status === 401) {
      throw new A2AError(-32600, 'A2A authentication was rejected.', 401);
    }
    if (!isJsonMediaType(result.response.headers.get('content-type'))) {
      throw new Error('A2A JSON-RPC response has an invalid content type.');
    }
    const payload = parseJson(decodeUtf8(result.body), 'A2A endpoint');
    if (!isRecord(payload)) throw new Error('A2A JSON-RPC response is invalid.');
    if (payload.jsonrpc !== '2.0' || payload.id !== requestId) {
      throw new Error('A2A JSON-RPC response has an invalid version or response id.');
    }
    const hasResult = Object.hasOwn(payload, 'result');
    const hasError = Object.hasOwn(payload, 'error');
    if (hasResult === hasError) throw new Error('A2A JSON-RPC response must contain exactly one result or error.');
    if (hasError) {
      if (!isRecord(payload.error)
        || typeof payload.error.code !== 'number'
        || typeof payload.error.message !== 'string') {
        throw new Error('A2A JSON-RPC error response is invalid.');
      }
      throw new A2AError(
        payload.error.code,
        this.#authorizationRedactor.redactText(payload.error.message),
        result.response.status,
        this.#authorizationRedactor.redactContent(payload.error.data),
      );
    }
    if (!result.response.ok) throw new Error(`A2A request failed with HTTP ${result.response.status}.`);
    return this.redactRpcResult(method, payload.result);
  }
}

export type A2AClientOptionsResolver = (
  registration: ExternalAgentRegistration,
) => A2AClientOptions;

export function createA2AAgentExecutorFactory(
  options: A2AClientOptions | A2AClientOptionsResolver,
): AgentExecutorFactory {
  const oauthManagers = new Map<string, {
    readonly key: string;
    readonly fetch: A2AClientOptions['fetch'];
    readonly manager: OAuth2ClientCredentialsTokenManager;
    references: number;
  }>();
  return {
    executorId: A2A_EXECUTOR_ID,
    protocol: 'a2a',
    async create(registration, context) {
      const resolved = typeof options === 'function' ? options(registration) : options;
      const config = executorConfig(registration);
      const authentication = config.authentication;
      const rpcOptions: A2AClientOptions = {
        ...resolved,
        networkPolicy: endpointNetworkPolicy(resolved.networkPolicy, config.interfaceUrl),
      };
      let oauthManagerEntry: ReturnType<typeof oauthManagers.get>;
      if (authentication?.type === 'oauth2-client-credentials') {
        const tokenNetworkPolicy = endpointNetworkPolicy(resolved.networkPolicy, authentication.tokenUrl);
        const key = stableJson({
          authentication,
          credentialRef: registration.credentialRef ?? '',
          networkPolicy: tokenNetworkPolicy,
        });
        const cached = oauthManagers.get(registration.agentId);
        oauthManagerEntry = cached?.key === key && cached.fetch === resolved.fetch
          ? cached : undefined;
        if (!oauthManagerEntry) {
          const manager = createOAuth2ClientCredentialsTokenManager({
            issuer: authentication.issuer,
            tokenUrl: authentication.tokenUrl,
            clientId: authentication.clientId,
            scopes: authentication.scopes,
            ...(authentication.resource ? { resource: authentication.resource } : {}),
            clientAuthenticationMethod: authentication.clientAuthentication === 'client-secret-post'
              ? 'post' : 'basic',
            networkPolicy: tokenNetworkPolicy,
            ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
          });
          oauthManagerEntry = { key, fetch: resolved.fetch, manager, references: 0 };
          oauthManagers.set(registration.agentId, oauthManagerEntry);
        }
      }
      if (!oauthManagerEntry) return new A2AClientExecutor(registration, context, rpcOptions);
      const retainedManager = oauthManagerEntry;
      retainedManager.references += 1;
      let released = false;
      const releaseOAuthTokenManager = (): void => {
        if (released) return;
        released = true;
        retainedManager.references -= 1;
        if (retainedManager.references !== 0) return;
        retainedManager.manager.invalidate();
        if (oauthManagers.get(registration.agentId) === retainedManager) {
          oauthManagers.delete(registration.agentId);
        }
      };
      return new A2AClientExecutor(
        registration,
        context,
        rpcOptions,
        retainedManager.manager,
        releaseOAuthTokenManager,
      );
    },
  };
}
