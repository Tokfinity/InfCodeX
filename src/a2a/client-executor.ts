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
  type AgentTaskStartInput,
  type ExternalAgentRegistration,
} from '@kodax-ai/agent';

import { A2AError } from './errors.js';
import { decodeUtf8, openSafeA2AResponse, safeA2AFetch } from './safe-fetch.js';
import { isRecord, parseA2AAgentCard, parseA2AMessage, parseA2ATask } from './schemas.js';
import {
  A2A_EXECUTOR_ID,
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AArtifact,
  type A2AClientOptions,
  type A2ADiscoveredRegistration,
  type A2AMessage,
  type A2APart,
  type A2ARegistrationInput,
  type A2ATask,
} from './types.js';

interface A2AExecutorConfig {
  readonly agentCardUrl: string;
  readonly interfaceUrl: string;
  readonly tenant?: string;
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

function executorConfig(registration: ExternalAgentRegistration): A2AExecutorConfig {
  const config = registration.executorConfig;
  if (!isRecord(config)) throw new Error('A2A registration executorConfig is missing.');
  if (typeof config.agentCardUrl !== 'string' || typeof config.interfaceUrl !== 'string') {
    throw new Error('A2A registration endpoints are invalid.');
  }
  return {
    agentCardUrl: config.agentCardUrl,
    interfaceUrl: config.interfaceUrl,
    ...(typeof config.tenant === 'string' ? { tenant: config.tenant } : {}),
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
  if (interfaceUrl.username || interfaceUrl.password) {
    throw new Error('A2A interface URL must not contain credentials.');
  }
  if (interfaceUrl.origin !== cardUrl.origin) {
    throw new Error('A2A interface must use the same origin as the trusted Agent Card.');
  }
  return selected;
}

function advertisesBearerAuthentication(card: A2AAgentCard): boolean {
  const bearerSchemes = new Set(
    Object.entries(card.securitySchemes ?? {}).flatMap(([name, value]) => {
      if (!isRecord(value) || !isRecord(value.httpAuthSecurityScheme)) return [];
      return typeof value.httpAuthSecurityScheme.scheme === 'string'
        && value.httpAuthSecurityScheme.scheme.toLowerCase() === 'bearer'
        ? [name]
        : [];
    }),
  );
  return (card.securityRequirements ?? []).some((requirement) => (
    isRecord(requirement.schemes)
    && Object.keys(requirement.schemes).some((name) => bearerSchemes.has(name))
  ));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function discoverA2ARegistration(
  input: A2ARegistrationInput,
  options: A2AClientOptions,
): Promise<A2ADiscoveredRegistration> {
  const result = await safeA2AFetch(
    new URL(input.agentCardUrl),
    { headers: { accept: 'application/json' } },
    options.networkPolicy,
    options.fetch,
  );
  if (!result.response.ok) throw new Error(`Agent Card request failed with HTTP ${result.response.status}.`);
  if (!result.response.headers.get('content-type')?.toLowerCase().includes('json')) {
    throw new Error('Agent Card response is not JSON.');
  }
  const card = parseA2AAgentCard(parseJson(decodeUtf8(result.body), 'Agent Card'));
  const selected = chooseInterface(card, result.url);
  if (input.credentialRef && !advertisesBearerAuthentication(card)) {
    throw new Error('Configured A2A credential requires an advertised Bearer security scheme.');
  }
  const identity = stableJson({
    agentCardUrl: result.url.href,
    interfaceUrl: selected.url,
    protocolBinding: selected.protocolBinding,
    protocolVersion: selected.protocolVersion,
    tenant: selected.tenant ?? '',
  });
  const revision = sha256(stableJson(card));
  return {
    agentCard: card,
    registration: {
      agentId: input.agentId,
      displayName: card.name,
      description: card.description,
      enabled: true,
      executorId: A2A_EXECUTOR_ID,
      protocol: 'a2a',
      configurationRevision: revision,
      endpointIdentityHash: sha256(identity),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      executorConfig: {
        agentCardUrl: result.url.href,
        interfaceUrl: selected.url,
        ...(selected.tenant ? { tenant: selected.tenant } : {}),
      },
      skills: card.skills.map((skill) => skill.id),
      inputModalities: card.defaultInputModes,
      outputModalities: card.defaultOutputModes,
      capabilities: {
        streaming: card.capabilities.streaming ? 'supported' : 'unsupported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: input.effects.remote, workspace: 'proposal' },
      health: { status: 'healthy', checkedAt: new Date().toISOString() },
    },
  };
}

function metadata(reference: AgentExecutorTaskReference): Readonly<Record<string, unknown>> {
  return reference.metadata ?? {};
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

  constructor(
    private readonly registration: ExternalAgentRegistration,
    private readonly context: AgentExecutorFactoryContext,
    private readonly options: A2AClientOptions,
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
      return { idempotencyKey, metadata: { directMessage: parseA2AMessage(result.message) } };
    }
    throw new Error('A2A SendMessage returned neither task nor message.');
  }

  async *events(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    const direct = directMessage(reference);
    if (direct) {
      yield await this.authorizeArtifacts(snapshotFromMessage(direct));
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
    if (direct) return this.authorizeArtifacts(snapshotFromMessage(direct));
    if (!reference.remoteTaskId) throw new Error('A2A task reference has no remote task ID.');
    const task = parseA2ATask(await this.rpc('GetTask', this.taskParams(reference)));
    this.assertTaskReference(task, reference);
    return this.authorizeArtifacts(snapshotFromTask(task));
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
    return this.authorizeArtifacts(snapshotFromTask(task));
  }

  async reconcile(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    return this.get(reference);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#streamControllers) {
      controller.abort(new Error('A2A executor disposed.'));
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
      const response = await this.openStreamResponse(url, headers, controller.signal, {
        jsonrpc: '2.0',
        id: requestId,
        method: 'SubscribeToTask',
        params: this.taskParams(reference),
      });
      disarmTimeout();
      if (!response.ok || !response.body) throw new Error(`A2A stream failed with HTTP ${response.status}.`);
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
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
        if (receivedBytes > this.options.networkPolicy.maxResponseBytes) {
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
    } finally {
      disarmTimeout();
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
      throw new A2AError(typeof error.code === 'number' ? error.code : -32603, typeof error.message === 'string' ? error.message : 'A2A stream error.');
    }
    if (!isRecord(payload.result)) return undefined;
    if (payload.result.task !== undefined) {
      const task = parseA2ATask(payload.result.task);
      this.assertTaskReference(task, reference);
      artifacts.clear();
      for (const artifact of task.artifacts ?? []) artifacts.set(artifact.artifactId, artifact);
      return this.authorizeArtifacts(snapshotFromTask(task));
    }
    if (payload.result.message !== undefined) {
      const message = parseA2AMessage(payload.result.message);
      if (message.taskId !== undefined && message.taskId !== reference.remoteTaskId) {
        throw new Error('A2A stream message belongs to a different task.');
      }
      return this.authorizeArtifacts(snapshotFromMessage(message));
    }
    if (isRecord(payload.result.statusUpdate) && isRecord(payload.result.statusUpdate.status)) {
      this.assertStreamTaskScope(payload.result.statusUpdate, reference);
      const task = parseA2ATask({
        id: reference.remoteTaskId,
        contextId: payload.result.statusUpdate.contextId,
        status: payload.result.statusUpdate.status,
        ...(artifacts.size > 0 ? { artifacts: [...artifacts.values()] } : {}),
      });
      return this.authorizeArtifacts(snapshotFromTask(task));
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
      return this.authorizeArtifacts(snapshotFromTask({ ...task, artifacts: [...artifacts.values()] }));
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
  ): Promise<Response> {
    const open = (authorization?: string): Promise<Response> => {
      const headers = new Headers(baseHeaders);
      if (authorization) headers.set('authorization', authorization);
      return openSafeA2AResponse(url, {
        method: 'POST', headers, redirect: 'manual', signal, body: JSON.stringify(body),
      }, this.options.networkPolicy, this.options.fetch);
    };
    if (this.registration.credentialRef) {
      return this.context.withCredential(
        this.registration.credentialRef,
        (credential) => open(`Bearer ${credential}`),
      );
    }
    return open(this.options.authorization);
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
    const run = (authorization?: string) => this.rpcWithAuthorization(method, params, authorization);
    if (this.registration.credentialRef) {
      return this.context.withCredential(this.registration.credentialRef, (credential) => run(`Bearer ${credential}`));
    }
    return run(this.options.authorization);
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
    }, this.options.networkPolicy, this.options.fetch);
    if (!result.response.headers.get('content-type')?.toLowerCase().includes('json')) {
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
      throw new A2AError(payload.error.code, payload.error.message, result.response.status);
    }
    if (!result.response.ok) throw new Error(`A2A request failed with HTTP ${result.response.status}.`);
    return payload.result;
  }
}

export type A2AClientOptionsResolver = (
  registration: ExternalAgentRegistration,
) => A2AClientOptions;

export function createA2AAgentExecutorFactory(
  options: A2AClientOptions | A2AClientOptionsResolver,
): AgentExecutorFactory {
  return {
    executorId: A2A_EXECUTOR_ID,
    protocol: 'a2a',
    async create(registration, context) {
      const resolved = typeof options === 'function' ? options(registration) : options;
      return new A2AClientExecutor(registration, context, resolved);
    },
  };
}
